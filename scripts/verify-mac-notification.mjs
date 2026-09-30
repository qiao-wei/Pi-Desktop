#!/usr/bin/env node
/**
 * macOS 系统通知的投递验收 —— 签名档位动完之后，唯一能证明「通知真的送得到」的那一步。
 *
 * 为什么要单独有一个脚本：macOS 从 Electron 42 起通知走 UNNotification，包的签名不自洽时
 * `show()` **既不报错也不显示**，只有 `failed` 事件说话（`UNErrorDomain error 1`）。光看"包能启动、
 * 窗口能弹出"完全看不出来。这件事已经踩过两次：2026-09-20（产物只剩 Electron 自带 linker 签名：
 * `Identifier=Electron`、`Sealed Resources=none`）和 2026-09-30（签名档位从"钥匙串里有什么证书"
 * 改成显式档位）。两次的症状都是「任务完成后系统提醒」静默失效。
 *
 * 两条路，一次跑一条：
 *
 *   node scripts/verify-mac-notification.mjs              # 正面：构建好的 .app 必须投递成功
 *   node scripts/verify-mac-notification.mjs --control     # 阴性对照：linker 签名的 Electron 必须失败
 *
 * 阴性对照不是装饰：没有它，"探针永远报 delivered:false" 和 "探针永远报 delivered:true" 都会让这套
 * 检查假绿 —— 对照组证明这个探针**真的能分辨**两种签名。
 *
 * 正面这条路走的是真实 app 自己的 IPC，不是另写一段 main：起一个独立 userData 的实例，用 CDP 在它的
 * renderer 里调 `notify_turn_complete`，读回宿主对 renderer 的契约 `{ delivered, reason }`（宿主本来
 * 就不允许只报"调用过了"）。6474 被正在使用的 app 占着也没关系：桥会自己落到空闲端口（实测），所以
 * 探针实例可以和它并存，不会打断用户手上那个 app。
 *
 * 其它参数：`--app <path>`（默认找 dist-electron 下的产物）、`--port <debugPort>`（默认 9224）。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const control = argv.includes("--control");
const debugPort = Number(flag("--port") ?? 9224);
const builtApps = ["dist-electron/mac-arm64/Pi Desktop.app", "dist-electron/mac/Pi Desktop.app"];

function fail(message, hints = []) {
  console.error(`verify-mac-notification: ${message}`);
  for (const hint of hints) {
    console.error(`  → ${hint}`);
  }
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `codesign -dv` 的几行关键事实：判一个包是"自洽签名"还是"只剩 linker 签名"。 */
function signatureFacts(appPath) {
  const { stdout, stderr } = spawnSync("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" });
  const text = `${stdout ?? ""}${stderr ?? ""}`;
  const field = (name) => text.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
  const flags = field("flags") ?? "";
  return {
    identifier: field("Identifier"),
    // 两种写法都要接住：有密封资源时是 `Sealed Resources version=2 rules=13 files=N`，没有时是
    // `Sealed Resources=none` —— 后者正是 linker 签名那种失败态。
    sealed: text.match(/^Sealed Resources[= ]\s*(.*)$/m)?.[1]?.trim() || "none",
    signature: field("Signature"),
    teamIdentifier: field("TeamIdentifier"),
    linkerSigned: flags.includes("linker-signed"),
    timestamp: /^Timestamp=/m.test(text),
  };
}

/** 阴性对照用的小 main：只发一条通知，把结局打出来。 */
const PROBE_MAIN = `
const { app, Notification } = require("electron");
const report = (payload) => {
  process.stdout.write("RESULT " + JSON.stringify(payload) + "\\n");
  setTimeout(() => app.exit(0), 150);
};
app.whenReady().then(() => {
  if (typeof Notification?.isSupported === "function" && !Notification.isSupported()) {
    report({ delivered: false, reason: "unsupported" });
    return;
  }
  const notification = new Notification({ title: "Pi Desktop 通知探针", body: "签名档位投递测试" });
  let settled = false;
  const settle = (delivered, reason) => {
    if (settled) return;
    settled = true;
    report({ delivered, reason: reason ?? null });
  };
  notification.on("show", () => settle(true));
  notification.on("failed", (_event, error) => settle(false, String(error ?? "failed")));
  setTimeout(() => settle(false, "timeout"), 4000);
  notification.show();
});
`;

/** 等子进程吐出 RESULT（或超时），顺手把输出留给排障。 */
function waitForResult(child, timeoutMs) {
  return new Promise((resolveResult) => {
    let buffer = "";
    const done = (outcome) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolveResult(outcome);
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      const line = buffer.split("\n").find((entry) => entry.startsWith("RESULT "));
      if (line) {
        done({ outcome: JSON.parse(line.slice("RESULT ".length)), output: buffer });
      }
    };
    const timer = setTimeout(() => done({ outcome: { delivered: false, reason: "timeout" }, output: buffer }), timeoutMs);
    child.stdout?.on("data", onData);
  });
}

/** 子进程 + 它拉起来的桥：detached 起在独立进程组里，收尾时整组带走（桥可能自己 setsid，再兜一次 pkill）。 */
function launch(command, args) {
  // 收尾时靠这个唯一的 userData 路径认领自己起的那几个进程（它在命令行里，`ps` 看得见）。
  const marker = args[args.length - 1];
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return {
    child,
    get stderr() {
      return stderr;
    },
    /**
     * 必须等它真的退完再返回：否则下一次运行会连到上一次残留实例的调试端口，拿到一个假绿的
     * `delivered:true`（这个坑第一次写就踩到了，第二次运行超时失败）。
     */
    async stop() {
      for (const signal of ["TERM", "KILL"]) {
        try {
          process.kill(-child.pid, `SIG${signal}`);
        } catch {
          // 进程组已经不在了
        }
        spawnSync("pkill", [`-${signal}`, "-f", marker]);
        if (await waitUntilGone(marker, 8_000)) {
          return;
        }
      }
    },
  };
}

/** 命令行里还挂着 marker（= 探针起的进程还没退干净）时就继续等。 */
async function waitUntilGone(marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
    if (!(stdout ?? "").includes(marker)) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

/** 调试端口被上一次残留实例占着时必须说出来，而不是连到别人身上去。 */
function portInUse(port) {
  return spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).status === 0;
}

/**
 * 通过 CDP 在真实 app 的 renderer 里调一次通知命令。等端口、等目标、读数，全都要有上限。
 */
async function invokeThroughCdp(port, { title, body }) {
  const base = `http://127.0.0.1:${port}`;
  let page;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`${base}/json/list`)).json();
      page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) {
        break;
      }
    } catch {
      // 调试端口还没起来
    }
    await sleep(500);
  }
  if (!page) {
    throw new Error("60s 内没有拿到可调试的 renderer（窗口没起来？）");
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.onopen = resolveOpen;
    socket.onerror = () => rejectOpen(new Error("CDP 连接失败"));
  });

  const expression = `window.__TAURI_INTERNALS__.invoke("notify_turn_complete", ${JSON.stringify({ title, body })})`;
  const reply = await new Promise((resolveReply, rejectReply) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) {
        resolveReply(message);
      }
    };
    socket.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      }),
    );
    setTimeout(() => rejectReply(new Error("CDP 求值超时")), 20_000);
  });
  socket.close();

  if (reply.result?.exceptionDetails) {
    throw new Error(`renderer 里抛了异常：${JSON.stringify(reply.result.exceptionDetails)}`);
  }
  return reply.result?.result?.value;
}

if (process.platform !== "darwin") {
  fail(`只有 macOS 有这套通知机制（当前是 ${process.platform}）`);
}

if (control) {
  // 阴性对照：Electron 自带的 dist 是 linker 签名（Identifier=Electron、Sealed Resources=none），
  // 它必须投递失败 —— 证明探针不是"永远报成功"。
  const facts = signatureFacts(electronPath);
  const workDir = mkdtempSync(join(tmpdir(), "notify-control-"));
  const mainFile = join(workDir, "main.js");
  writeFileSync(mainFile, PROBE_MAIN);
  const app = launch(electronPath, [mainFile, `--user-data-dir=${join(workDir, "userdata")}`]);
  const { outcome, output } = await waitForResult(app.child, 30_000);
  await app.stop();
  rmSync(workDir, { recursive: true, force: true });

  const rejected = outcome.delivered === false && /UNErrorDomain|failed|timeout/.test(String(outcome.reason));
  console.log(`对照（linker-signed，identifier=${facts.identifier ?? "?"}）→ ${JSON.stringify(outcome)}`);
  if (!rejected) {
    fail("linker 签名的 Electron 竟然投递成功了？这套探针就失去了分辨能力", [output.trim()]);
  }
  console.log("阴性对照通过：探针能识别出「签名不够」的那种失败。");
  process.exit(0);
}

const appPath = flag("--app") ? resolve(flag("--app")) : builtApps.map((relative) => resolve(rootDir, relative)).find(existsSync);
if (!appPath || !existsSync(appPath)) {
  fail("没找到构建好的 .app", [
    `先出包：npm run pack:electron:mac:arm64（默认找 ${builtApps.join(" / ")}）`,
    "或显式指定：--app <Pi Desktop.app 的路径>",
  ]);
}

const facts = signatureFacts(appPath);
console.log(
  `签名：identifier=${facts.identifier ?? "?"} signature=${facts.signature ?? "?"} sealed=${facts.sealed ?? "none"}` +
    `${facts.timestamp ? " timestamp=有" : " timestamp=无"}${facts.linkerSigned ? "（linker-signed）" : ""}`,
);
if (facts.linkerSigned) {
  fail("这个包只有 Electron 自带的 linker 签名，通知必然送不到（UNErrorDomain error 1）", [
    "local 档应当由 electron-builder 以 identity \"-\" 做一次自洽的 ad-hoc 签名；先确认 PI_DESKTOP_SIGN=local 且配置里没有第二个签名入口",
  ]);
}

if (portInUse(debugPort)) {
  fail(`调试端口 ${debugPort} 已被占用（上次的探针实例没退干净？）`, [
    `换一个端口：node scripts/verify-mac-notification.mjs --port ${debugPort + 1}`,
    "或找出来停掉：ps -ax -o pid=,command= | grep notify-app-",
  ]);
}

const workDir = mkdtempSync(join(tmpdir(), "notify-app-"));
const app = launch(join(appPath, "Contents/MacOS/Pi Desktop"), [
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${join(workDir, "userdata")}`,
]);

let outcome;
try {
  outcome = await invokeThroughCdp(debugPort, { title: "Pi Desktop 通知探针", body: "签名档位投递测试" });
} catch (error) {
  await app.stop();
  rmSync(workDir, { recursive: true, force: true });
  fail(`探针没能从 app 里拿到结局：${error.message}`, [app.stderr.trim().split("\n").slice(-5).join("\n") || "(宿主没有输出)"]);
}
await app.stop();
rmSync(workDir, { recursive: true, force: true });

console.log(`投递结果：${JSON.stringify(outcome)}`);
if (outcome?.delivered === true) {
  console.log("通过：这个签名档位下，系统通知真的送得到。");
  process.exit(0);
}
fail("通知没有送达", [
  `reason=${outcome?.reason ?? "(空)"}`,
  app.stderr.trim().split("\n").slice(-5).join("\n") || "(宿主没有输出)",
  "首次授权被拒过的话，去「系统设置 → 通知 → Pi Desktop」打开",
]);