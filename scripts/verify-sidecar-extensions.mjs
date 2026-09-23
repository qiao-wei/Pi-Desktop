#!/usr/bin/env node
/**
 * Boot the freshly compiled bridge and assert that every capability the user has selected
 * actually reached the session. See scripts/lib/sidecarGate.mjs for why this exists.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyCapabilityLoad, formatGateReport, waitForCapabilities } from "./lib/sidecarGate.mjs";

const rootDir = resolve(dirname(fileURLToPath(new URL("../package.json", import.meta.url))));
const sidecarBin = process.env.PI_DESKTOP_SIDECAR_BIN?.trim() || join(rootDir, "src-tauri", "binaries", "pi-desktop-server");
const nodeRuntime = process.env.PI_DESKTOP_GATE_NODE_RUNTIME?.trim() || join(rootDir, "src-tauri", "binaries", "node-runtime");
const pythonRuntime = process.env.PI_DESKTOP_GATE_PYTHON_RUNTIME?.trim() || join(rootDir, "src-tauri", "binaries", "python-runtime");
// The slim packaging mode ships neither runtime, so the gate has to spawn the same launcher with
// the machine's own node/python. Same switch as the shells (`PI_DESKTOP_RUNTIME_MODE`).
const runtimeMode = (process.env.PI_DESKTOP_RUNTIME_MODE ?? "").trim().toLowerCase() === "system" ? "system" : "bundled";
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi/agent");
const timeoutMs = Number(process.env.PI_DESKTOP_GATE_TIMEOUT_MS ?? 90_000);
// The packaged shell runs the bridge with cwd = bundled skills dir; override to A/B that.
const workDir = process.env.PI_DESKTOP_GATE_CWD?.trim() || join(rootDir, "skills");

if (!existsSync(sidecarBin)) {
  console.error(`sidecar 自检：找不到产物 ${sidecarBin}（先跑 npm run bridge:build）`);
  process.exit(1);
}
if (!existsSync(join(agentDir, "settings.json"))) {
  console.log(`sidecar 自检：跳过（${agentDir}/settings.json 不存在，没有用户配置可校验）`);
  process.exit(0);
}

const child = await startSidecar().catch((error) => {
  console.error(`sidecar 自检：启动失败 ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const port = child.port;
let result;
try {
  const { payload, attempts, elapsedMs } = await waitForCapabilities({
    url: `http://127.0.0.1:${port}/api/capabilities`,
    attempts: Math.ceil(timeoutMs / 2000),
  });
  result = classifyCapabilityLoad(payload);
  console.log(`sidecar 自检（${sidecarBin.replace(rootDir + "/", "")}，${elapsedMs}ms / ${attempts} 次轮询）：`);
  console.log(formatGateReport(result));
} catch (error) {
  console.error(`sidecar 自检：读取 /api/capabilities 失败 ${error instanceof Error ? error.message : String(error)}`);
  result = { ok: false };
} finally {
  child.kill();
}

if (!result.ok) {
  console.error("构建产物不可发布：有选中的能力包没有进入会话（或桥没答上来）。重打一次或改用不内嵌 pi 依赖的构建方式。");
  process.exit(1);
}

async function startSidecar() {
  const port = await freePort();
  const bundledEnv = runtimeMode === "bundled"
    ? {
        PI_DESKTOP_BUNDLED_NODE_BIN: join(nodeRuntime, "bin", process.platform === "win32" ? "node.exe" : "node"),
        PI_DESKTOP_BUNDLED_NODE_HOME: nodeRuntime,
        PI_DESKTOP_BUNDLED_NPM_CLI: join(nodeRuntime, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        PI_DESKTOP_BUNDLED_PYTHON_BIN: join(pythonRuntime, "bin", process.platform === "win32" ? "python.exe" : "python3"),
        PI_DESKTOP_BUNDLED_PYTHON_HOME: pythonRuntime,
      }
    : {};
  const env = {
    HOME: homedir(),
    USER: process.env.USER ?? "unknown",
    TMPDIR: tmpdir(),
    // In `system` mode the launcher has to find the host's node, so the host PATH is what it gets
    // (plus the shim directory, exactly like a packaged slim app passes it).
    PATH: [
      join(agentDir, "bin"),
      ...(runtimeMode === "bundled" ? [join(nodeRuntime, "bin")] : String(process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].filter(Boolean).join(":"),
    PI_DESKTOP_APP_SKILLS_DIR: join(rootDir, "skills"),
    PI_DESKTOP_CAPABILITIES_DEFAULTS_FILE: join(rootDir, "capabilities.defaults.json"),
    PI_DESKTOP_RUNTIME_MODE: runtimeMode,
    ...bundledEnv,
    PI_DESKTOP_HOST: "127.0.0.1",
    PI_DESKTOP_PORT: String(port),
  };
  // Same cwd the packaged shell uses, so the bridge resolves relative paths the same way.
  let exited = false;
  const child = spawn(sidecarBin, [], { env, cwd: workDir, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.once("exit", (code) => {
    if (!exited) {
      exited = true;
      if (code !== 0 && code !== null) {
        console.error(`sidecar 自检：桥提前退出 code=${code}`);
      }
    }
  });
  return {
    port,
    kill: () => {
      exited = true;
      child.kill("SIGKILL");
    },
  };
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.unref();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}
