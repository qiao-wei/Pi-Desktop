/**
 * 「在系统终端里跑一条项目命令」（`server/runProjectCommand.mjs`）。
 *
 * 纯计划（引用、脚本正文、每个平台的终端候选）直接单测；真正的执行用假 `spawn`，断言
 * 拉起的是哪个终端、临时脚本写了什么 —— 测试绝不能真的弹出终端窗口。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BACKGROUND_LAUNCHER,
  backgroundCommandPlan,
  commandProcessEnv,
  detectTerminalApps,
  isRunLogPath,
  normalizeTerminalApp,
  revealRunLog,
  RUN_LOG_ROOT,
  RUN_SCRIPT_ROOT,
  runProjectCommand,
  runProjectCommandInBackground,
  runScriptText,
  shellQuote,
  sweepRunScripts,
  terminalLauncherPlans,
  windowsCommandEnvPrefix,
} from "../server/runProjectCommand.mjs";

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 记录启动参数的假 spawn：默认立刻 `spawn`，`failOn` 里的命令改为 `error`（模拟没装）。 */
function fakeSpawn({ failOn = [] as string[] } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const options: Record<string, unknown>[] = [];
  const spawnImpl = ((command: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ command, args });
    options.push(opts ?? {});
    const child = new EventEmitter() as EventEmitter & { unref?: () => void; pid?: number };
    child.unref = () => {};
    child.pid = 4321;
    setImmediate(() => {
      if (failOn.includes(command)) {
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      } else {
        child.emit("spawn");
      }
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, options, spawnImpl };
}

test("shellQuote 把单引号转义成 POSIX 安全形式", () => {
  assert.equal(shellQuote("npm run dev"), "'npm run dev'");
  assert.equal(shellQuote("/tmp/a b"), "'/tmp/a b'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("脚本正文进目录、跑命令、留一个交互 shell", () => {
  const text = runScriptText("npm run dev", "/tmp/my project");
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.ok(text.includes("cd '/tmp/my project' || exit 1"));
  assert.ok(text.includes("\nnpm run dev\n"));
  assert.ok(text.includes('exec "${SHELL:-/bin/sh}" -l'));
});

test("脚本正文在命令前注入环境变量（值用单引号包裹）", () => {
  const text = runScriptText("npm run dev", "/tmp/p", {
    env: [
      { key: "PORT", value: "3000" },
      { key: "GREETING", value: "he said 'hi'" },
      { key: "1bad", value: "1" },
    ],
  });
  assert.ok(text.includes("export PORT='3000'"), text);
  assert.ok(text.includes("export GREETING='he said '\\''hi'\\'''"), text);
  assert.ok(!text.includes("1bad"), "非法键名不该进脚本");
  // export 必须在命令之前
  assert.ok(text.indexOf("export PORT") < text.indexOf("npm run dev"));
});

test("commandProcessEnv：没环境变量时原样返回 baseEnv，有则叠加", () => {
  const base = { PATH: "/usr/bin" };
  assert.equal(commandProcessEnv([], base), base);
  assert.deepEqual(commandProcessEnv([{ key: "PORT", value: "3000" }], base), { PATH: "/usr/bin", PORT: "3000" });
  // 非法键 / 覆盖已有值
  assert.deepEqual(commandProcessEnv([{ key: "1bad", value: "x" }, { key: "PATH", value: "/x" }], base), { PATH: "/x" });
});

test("windowsCommandEnvPrefix 拼 set 前缀", () => {
  assert.equal(windowsCommandEnvPrefix([]), "");
  assert.equal(windowsCommandEnvPrefix([{ key: "PORT", value: "3000" }]), 'set "PORT=3000" && ');
  // 值里的双引号会撑破引号，直接去掉
  assert.equal(windowsCommandEnvPrefix([{ key: "A", value: 'x"y' }]), 'set "A=xy" && ');
});

test("macOS 用 open 把脚本交给 Terminal，并补一次 activate", () => {
  const plans = terminalLauncherPlans({ platform: "darwin", scriptPath: "/tmp/run.command", command: "npm run dev", cwd: "/tmp/p", env: {} });
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0][0], { command: "open", args: ["-a", "Terminal", "/tmp/run.command"] });
  assert.equal(plans[0][1]?.command, "osascript");
  assert.equal(plans[0][1]?.optional, true);

  const custom = terminalLauncherPlans({ platform: "darwin", scriptPath: "/tmp/run.command", command: "x", cwd: "/tmp/p", env: { PI_DESKTOP_TERMINAL: "iTerm" } });
  assert.deepEqual(custom[0][0]?.args, ["-a", "iTerm", "/tmp/run.command"]);
});

test("Windows 用 cmd start 新开一个窗口", () => {
  const plans = terminalLauncherPlans({ platform: "win32", scriptPath: "C:\\tmp\\run.command", command: "npm run dev", cwd: "C:\\proj", env: {} });
  assert.equal(plans.length, 1);
  assert.equal(plans[0][0]?.command, "cmd");
  assert.ok(plans[0][0]?.args.join(" ").includes('cd /d "C:\\proj" && npm run dev'));
});

test("Windows 终端方案把环境变量拼成 set 前缀（在 cd 之前）", () => {
  const plans = terminalLauncherPlans({
    platform: "win32",
    scriptPath: "C:\\tmp\\run.command",
    command: "npm run dev",
    cwd: "C:\\proj",
    env: {},
    commandEnv: [{ key: "PORT", value: "3000" }],
  });
  assert.equal(plans[0][0]?.args.at(-1), 'set "PORT=3000" && cd /d "C:\\proj" && npm run dev');
});

test("Linux 按候选顺序列终端，第一个是 x-terminal-emulator", () => {
  const plans = terminalLauncherPlans({ platform: "linux", scriptPath: "/tmp/run.command", command: "npm run dev", cwd: "/tmp/p", env: {} });
  assert.deepEqual(
    plans.map((steps) => steps[0]?.command),
    ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"],
  );
});

test("运行会写出 755 的临时脚本并拉起终端", async () => {
  const baseDir = tempDir("pi-run-base-");
  const project = tempDir("pi-run-project-");
  const { calls, spawnImpl } = fakeSpawn();

  const result = await runProjectCommand("npm run dev", project, { spawnImpl, platform: "darwin", baseDir, now: 1_700_000_000_000, env: {} });
  assert.equal(result.launcher, "open");
  assert.equal(calls[0]?.command, "open");

  const scriptDir = join(baseDir, RUN_SCRIPT_ROOT);
  const scripts = readdirSync(scriptDir);
  assert.equal(scripts.length, 1);
  const scriptPath = join(scriptDir, scripts[0]);
  assert.equal(statSync(scriptPath).mode & 0o111, 0o111);
  assert.ok(readFileSync(scriptPath, "utf8").includes(`cd '${project}' || exit 1`));
});

test("第一个终端没装就换下一个候选", async () => {
  const baseDir = tempDir("pi-run-base-");
  const project = tempDir("pi-run-project-");
  const { calls, spawnImpl } = fakeSpawn({ failOn: ["x-terminal-emulator"] });

  const result = await runProjectCommand("npm run dev", project, { spawnImpl, platform: "linux", baseDir, env: {} });
  assert.equal(result.launcher, "gnome-terminal");
  assert.deepEqual(calls.map((call) => call.command), ["x-terminal-emulator", "gnome-terminal"]);
});

test("空命令 / 不存在的目录都直接报错，不启动任何东西", async () => {
  const baseDir = tempDir("pi-run-base-");
  const { calls, spawnImpl } = fakeSpawn();
  await assert.rejects(runProjectCommand("   ", baseDir, { spawnImpl, platform: "darwin", baseDir, env: {} }), /没有可运行的命令/);
  await assert.rejects(
    runProjectCommand("npm run dev", join(baseDir, "nope"), { spawnImpl, platform: "darwin", baseDir, env: {} }),
    /项目目录不存在/,
  );
  assert.deepEqual(calls, []);
});

test("sweepRunScripts 清旧留新", () => {
  const baseDir = tempDir("pi-run-sweep-");
  const scriptDir = join(baseDir, RUN_SCRIPT_ROOT);
  mkdirSync(scriptDir, { recursive: true });
  const old = join(scriptDir, "old.command");
  const fresh = join(scriptDir, "fresh.command");
  writeFileSync(old, "x");
  writeFileSync(fresh, "x");
  utimesSync(old, new Date(0), new Date(0));

  sweepRunScripts({ baseDir, now: Date.now() });
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
});

test("normalizeTerminalApp 挡住非法 app 名", () => {
  assert.equal(normalizeTerminalApp("iTerm"), "iTerm");
  assert.equal(normalizeTerminalApp(" WezTerm "), "WezTerm");
  assert.equal(normalizeTerminalApp("bad; rm -rf /"), "");
  assert.equal(normalizeTerminalApp(""), "");
});

test("terminalApp 指定 macOS 终端；非法值回落 Terminal", () => {
  const custom = terminalLauncherPlans({ platform: "darwin", scriptPath: "/tmp/run.command", command: "x", cwd: "/tmp/p", env: {}, terminalApp: "Warp" });
  assert.deepEqual(custom[0][0]?.args, ["-a", "Warp", "/tmp/run.command"]);

  const fallback = terminalLauncherPlans({ platform: "darwin", scriptPath: "/tmp/run.command", command: "x", cwd: "/tmp/p", env: {}, terminalApp: "bad; rm -rf /" });
  assert.deepEqual(fallback[0][0]?.args, ["-a", "Terminal", "/tmp/run.command"]);
});

test("backgroundCommandPlan 用登录 shell 跑命令，不弹窗", () => {
  assert.deepEqual(backgroundCommandPlan({ platform: "darwin", command: " npm run dev ", cwd: "/tmp/p" }), {
    command: "/bin/sh",
    args: ["-lc", "npm run dev"],
    cwd: "/tmp/p",
  });
  assert.deepEqual(backgroundCommandPlan({ platform: "win32", command: "npm run dev", cwd: "C:\\p" }), {
    command: "cmd",
    args: ["/c", "npm run dev"],
    cwd: "C:\\p",
  });
});

test("后台静默运行：不拉起终端，stdout/stderr 写进日志文件", async () => {
  const baseDir = tempDir("pi-run-bg-");
  const project = tempDir("pi-run-project-");
  const { calls, spawnImpl } = fakeSpawn();

  const result = await runProjectCommandInBackground("npm run dev", project, { spawnImpl, platform: "darwin", baseDir, now: 1_700_000_000_000 });
  assert.equal(result.launcher, BACKGROUND_LAUNCHER);
  assert.equal(result.pid, 4321);
  assert.deepEqual(calls, [{ command: "/bin/sh", args: ["-lc", "npm run dev"] }]);
  assert.ok(result.logPath.startsWith(join(baseDir, RUN_LOG_ROOT)));
  const text = readFileSync(result.logPath, "utf8");
  assert.ok(text.includes("npm run dev"));
  assert.ok(text.includes(project));
});

test("后台运行支持参数与环境变量：参数拼进命令行、env 交给 spawn、日志只记键名", async () => {
  const baseDir = tempDir("pi-run-bg-env-");
  const project = tempDir("pi-run-project-");
  const { calls, options, spawnImpl } = fakeSpawn();

  const result = await runProjectCommandInBackground("npm run dev", project, {
    spawnImpl,
    platform: "darwin",
    baseDir,
    now: 1_700_000_000_000,
    args: "-- --port 3000",
    env: [{ key: "NODE_ENV", value: "development" }],
  });

  assert.deepEqual(calls, [{ command: "/bin/sh", args: ["-lc", "npm run dev -- --port 3000"] }]);
  assert.equal((options[0]?.env as Record<string, string>).NODE_ENV, "development");
  const text = readFileSync(result.logPath, "utf8");
  assert.ok(text.includes("# command: npm run dev -- --port 3000"));
  assert.ok(text.includes("# env: NODE_ENV=***"), text);
  assert.ok(!text.includes("development"), "日志头部不该写出环境变量的值");
});

test("runProjectCommand 把 args / commandEnv 透传到后台路径", async () => {
  const baseDir = tempDir("pi-run-bg3-");
  const project = tempDir("pi-run-project-");
  const { calls, options, spawnImpl } = fakeSpawn();

  await runProjectCommand("npm run dev", project, {
    spawnImpl,
    platform: "darwin",
    baseDir,
    background: true,
    args: "--host 0.0.0.0",
    commandEnv: [{ key: "PORT", value: "8080" }],
  });
  assert.deepEqual(calls[0]?.args, ["-lc", "npm run dev --host 0.0.0.0"]);
  assert.equal((options[0]?.env as Record<string, string>).PORT, "8080");
});

test("runProjectCommand background: true 走静默路径", async () => {
  const baseDir = tempDir("pi-run-bg2-");
  const project = tempDir("pi-run-project-");
  const { calls, spawnImpl } = fakeSpawn();

  const result = await runProjectCommand("npm run dev", project, { spawnImpl, platform: "darwin", baseDir, background: true });
  assert.equal(result.launcher, BACKGROUND_LAUNCHER);
  assert.equal(calls[0]?.command, "/bin/sh");
});

test("detectTerminalApps 扫描 /Applications，Terminal 永远第一", () => {
  const list = detectTerminalApps({
    platform: "darwin",
    readdir: ((dir: string) => (dir === "/Applications" ? ["Terminal.app", "iTerm.app", "Safari.app", "Warp.app"] : [])) as never,
    exists: (() => true) as never,
    home: "/Users/example",
  });
  assert.deepEqual(list, ["Terminal", "iTerm", "Warp"]);
  assert.deepEqual(detectTerminalApps({ platform: "linux" }), []);
});

test("isRunLogPath 只认运行日志目录里的路径", () => {
  const baseDir = tempDir("pi-run-logpath-");
  assert.equal(isRunLogPath(join(baseDir, RUN_LOG_ROOT, "run-1.log"), baseDir), true);
  assert.equal(isRunLogPath(join(baseDir, "elsewhere", "run-1.log"), baseDir), false);
  assert.equal(isRunLogPath("/etc/passwd", baseDir), false);
});

test("revealRunLog 拒绝目录外路径，合法路径才拉起打开程序", async () => {
  const baseDir = tempDir("pi-run-reveal-");
  const logPath = join(baseDir, RUN_LOG_ROOT, "run-1.log");
  const { calls, spawnImpl } = fakeSpawn();

  await assert.rejects(revealRunLog("/etc/passwd", { baseDir, spawnImpl }), /日志路径/);
  assert.deepEqual(calls, []);

  await revealRunLog(logPath, { baseDir, spawnImpl, platform: "darwin" });
  assert.equal(calls[0]?.command, "open");
  assert.deepEqual(calls[0]?.args, [logPath]);
});