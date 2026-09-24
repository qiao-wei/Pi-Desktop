import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// One port rule for dev and the packaged shells alike: the bridge chooses it and announces it on
// stdout. The old dev flow probed ports itself (canBind + a 20-port scan) while production pinned
// 6474 - two policies, and only one of them survived a busy port.
const rules = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "..", "server", "bridgeListen.mjs")).href);

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const viteBin = join(rootDir, "node_modules", "vite", "bin", "vite.js");
const serverEntry = join(rootDir, "server", "index.mjs");
// 桥的启动环境同样要交出宿主 SDK 的路径。dev 是直接 spawn 桥、不经过 shell，所以这条必须自己
// 带上；复用 src-electron/sidecar.js 里的同一份逻辑，否则会表现成「dev 里 pi-subagents 用不了、
// 打包版却能用」这种最费解的不一致。
const { hostPiPackageRootEnv } = createRequire(import.meta.url)(join(rootDir, "src-electron", "sidecar.js"));
const host = process.env.PI_DESKTOP_HOST ?? process.env.ENGBUDDY_HOST ?? "127.0.0.1";
const requestedPort = rules.preferredPort(process.env);
const portIsExplicit = rules.isPortExplicit(process.env);
const reuseExistingBridge = process.env.PI_DESKTOP_REUSE_API === "1" || process.env.ENGBUDDY_REUSE_API === "1";

const children = [];
const bridge = await ensureBridge();
const apiBase = bridge.url;
if (!bridge.child) {
  console.log(`[dev] reusing the bridge already listening on ${apiBase}`);
}
// 降级不是错，但它是“窗口打到别人桥上”的唯一温床（渲染进程把基地址当常量），所以必须喟出来。
if (bridge.child && new URL(apiBase).port !== String(requestedPort)) {
  console.warn(
    `\n[dev] 端口 ${requestedPort} 已被占用，桥改听 ${apiBase}。\n` +
      `      渲染进程已烘入这个地址（VITE_PI_DESKTOP_API_BASE），不会再去猜 6474。\n` +
      `      但如果占着 ${requestedPort} 的进程也是一个 Pi Desktop（比如同时开着正式版），\n` +
      `      两边会抢同一份会话状态、看起来就像“切会话很慢”—— 关掉其中一个。\n`,
  );
}

if (bridge.child) {
  children.push(bridge.child);
}

const vite = spawn(
  process.execPath,
  [viteBin, "--host", "127.0.0.1", "--port", "5176"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_PI_DESKTOP_API_BASE: apiBase,
      VITE_ENGBUDDY_API_BASE: apiBase,
    },
  },
);
children.push(vite);

let exiting = false;

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (exiting) {
      return;
    }

    exiting = true;
    for (const sibling of children) {
      if (sibling !== child && !sibling.killed) {
        sibling.kill("SIGTERM");
      }
    }

    process.exitCode = code ?? (signal ? 1 : 0);
    setTimeout(() => process.exit(process.exitCode ?? 0), 50);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  if (exiting) {
    return;
  }

  exiting = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}

async function ensureBridge() {
  if (reuseExistingBridge && (await isBridgeResponsive(requestedPort))) {
    return { url: rules.bridgeUrlFor(host, requestedPort) };
  }

  const { child, url } = spawnBridge();
  try {
    await waitForBridge(await url, child);
    return { url: await url, child };
  } catch (error) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
    throw error;
  }
}

function spawnBridge() {
  // One runtime, no knob: the bridge runs on the same Node the packaged app's `pi-desktop-server`
  // launcher uses. A "which runtime" switch only ever produced a second policy that could
  // disagree with what actually ships (and, when the other runtime was not installed, a dev stack
  // that died on ENOENT instead of starting).
  const env = {
    ...process.env,
    PI_DESKTOP_HOST: host,
    ENGBUDDY_HOST: host,
    PI_DESKTOP_PI_CLI_RUNTIME: process.execPath,
    PI_DESKTOP_PI_CLI_ENTRY: serverEntry,
    ...hostPiPackageRootEnv({ root: rootDir }),
  };
  // Only an operator-named port is a contract; otherwise the bridge falls back to a free one.
  if (portIsExplicit) {
    env.PI_DESKTOP_PORT = String(requestedPort);
    env.ENGBUDDY_PORT = String(requestedPort);
  }

  const child = spawn(process.execPath, [serverEntry], { stdio: ["ignore", "pipe", "pipe"], env });
  const watcher = rules.createBridgeUrlWatcher({ timeoutMs: 20000 });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    watcher.feed(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code, signal) => {
    if (code !== 0 || signal) {
      watcher.closed(`exit code ${code ?? "none"}${signal ? ` (${signal})` : ""}`);
    }
  });
  watcher.promise.catch(() => {});

  return { child, url: watcher.promise };
}

async function isBridgeResponsive(port) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    const response = await fetch(`http://${host}:${port}/api/bootstrap`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForBridge(apiBaseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Bridge exited before becoming ready on ${apiBaseUrl}`);
    }

    if (await isBridgeResponsive(new URL(apiBaseUrl).port)) {
      return;
    }

    await sleep(200);
  }

  throw new Error(`Timed out waiting for bridge at ${apiBaseUrl}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
