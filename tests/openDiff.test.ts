/**
 * 「双击改动的文件 → 用宿主机 IDE 打开它的 diff（HEAD ↔ 工作区）」。
 *
 * 纯逻辑（找 IDE / diff 参数 / 临时文件命名与清扫）直接单测；准备左右两侧那一步用**真**临时
 * 仓库 + 真文件系统，只把 `spawn` 换成记录参数的假实现 —— 测试绝不能真的把 IDE 拉起来。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DIFF_TEMP_ROOT,
  diffArgs,
  diffTempDirectory,
  findOnPath,
  ideDiffLaunchers,
  launchDetached,
  openGitFileDiff,
  resolveDiffIde,
  sideFileName,
  staleDiffDirectories,
  sweepDiffTemps,
} from "../server/openDiff.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/* ------------------------------------------------------------------ 假实现 */

/** 记录启动参数的假 spawn：默认立刻 `spawn`，`failOn` 里的命令改为 `error`（模拟没装）。 */
function fakeSpawn({ failOn = [] as string[] } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const spawnImpl = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & { unref?: () => void };
    child.unref = () => {};
    setImmediate(() => {
      if (failOn.includes(command)) {
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      } else {
        child.emit("spawn");
      }
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, spawnImpl };
}

/** 一个真的存在于磁盘上的假 IDE 启动器（PATH 里叫 `code`）。 */
function fakeIde() {
  const directory = tempDir("tender-opendiff-bin-");
  const command = join(directory, "code");
  writeFileSync(command, "#!/bin/sh\n", { mode: 0o755 });
  return { directory, command, env: { PATH: directory } };
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** 真仓库：一个已提交的 a.ts，外加调用方自己造的改动。 */
function makeRepo() {
  const repo = tempDir("tender-opendiff-repo-");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "Tester"]);
  writeFileSync(join(repo, "a.ts"), "one\ntwo\n");
  git(repo, ["add", "a.ts"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "one"]);
  return repo;
}

/* ------------------------------------------------------------------ diff 参数 */

test("diff 参数：VS Code 家族 / Zed / Sublime 用 --diff，JetBrains 是 diff 子命令", () => {
  assert.deepEqual(diffArgs("vscode", "/l/a.ts", "/r/a.ts"), ["--diff", "/l/a.ts", "/r/a.ts"]);
  assert.deepEqual(diffArgs("zed", "L", "R"), ["--diff", "L", "R"]);
  assert.deepEqual(diffArgs("sublime", "L", "R"), ["--diff", "L", "R"]);
  assert.deepEqual(diffArgs("jetbrains", "L", "R"), ["diff", "L", "R"]);
});

test("两侧文件名：扩展名留在最后（IDE 才按类型高亮），标签说明这一侧是什么", () => {
  assert.equal(sideFileName("src/a.ts", "HEAD"), "a (HEAD).ts");
  assert.equal(sideFileName("a.tar.gz", "empty"), "a.tar (empty).gz");
  assert.equal(sideFileName(".env", "HEAD"), ".env (HEAD)");
  assert.equal(sideFileName("Makefile", "deleted"), "Makefile (deleted)");
});

/* ------------------------------------------------------------------ 找 IDE */

test("IDE 表：VS Code 家族在前、JetBrains 在后，每条都有候选启动器与应用名", () => {
  const launchers = ideDiffLaunchers({ platform: "darwin", homeDir: "/Users/u", env: {} });
  const ids = launchers.map((launcher) => launcher.id);

  assert.equal(ids[0], "vscode", "最常见的放最前");
  for (const id of ["codebuddy", "cursor", "windsurf", "vscodium", "zed", "sublime", "idea", "webstorm", "pycharm"]) {
    assert.ok(ids.includes(id), `表里少了 ${id}`);
  }
  assert.ok(ids.indexOf("zed") < ids.indexOf("idea"), "JetBrains 排在任何 VS Code 家族/独立编辑器之后");

  for (const launcher of launchers) {
    assert.ok(launcher.commands.length > 0, `${launcher.id} 要有候选启动器`);
    assert.ok(launcher.appName, `${launcher.id} 要有 macOS 应用名（打开后要 activate）`);
    assert.ok(["vscode", "zed", "sublime", "jetbrains"].includes(launcher.kind), `${launcher.id} 的 kind 要能算出参数`);
    assert.deepEqual(diffArgs(launcher.kind, "L", "R").slice(-2), ["L", "R"], `${launcher.id} 的参数末尾必须是左右两侧`);
  }

  // 这台机器上真实存在的形态：应用包里的 CLI 也是一个候选（VS Code 家族的 CLI 都叫 code/cursor/…）。
  assert.ok(launchers.find((launcher) => launcher.id === "codebuddy").commands.includes("/Applications/CodeBuddy.app/Contents/Resources/app/bin/code"));
  assert.ok(launchers.find((launcher) => launcher.id === "idea").commands.includes("/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"));
});

test("IDE 表：Windows 用 .cmd 与反斜杠，Linux 不掺应用包路径", () => {
  const win = ideDiffLaunchers({ platform: "win32", homeDir: "C:\\Users\\u", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } });
  assert.ok(win.find((launcher) => launcher.id === "vscode").commands.includes("C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd"));

  const linux = ideDiffLaunchers({ platform: "linux", homeDir: "/home/u", env: {} });
  assert.ok(linux.every((launcher) => launcher.commands.every((command) => !command.includes(".app/"))), "Linux 上不该探测 macOS 应用包");
});

test("PATH 查找：裸名字走 PATH，绝对路径直接看存在与否，win32 认 PATHEXT", () => {
  assert.equal(
    findOnPath("code", { platform: "linux", env: { PATH: "/bin:/usr/local/bin" }, exists: (candidate) => candidate === "/usr/local/bin/code" }),
    "/usr/local/bin/code",
  );
  assert.equal(findOnPath("code", { platform: "linux", env: { PATH: "/bin" }, exists: () => false }), null);
  assert.equal(findOnPath("/opt/ide/bin/zed", { platform: "linux", env: {}, exists: (candidate) => candidate === "/opt/ide/bin/zed" }), "/opt/ide/bin/zed");
  assert.equal(findOnPath("", { platform: "linux", env: { PATH: "/bin" } }), null);

  assert.equal(
    findOnPath("code", { platform: "win32", env: { PATH: "C:\\bin;C:\\tools", PATHEXT: ".EXE;.CMD" }, exists: (candidate) => candidate === "C:\\tools\\code.CMD" }),
    "C:\\tools\\code.CMD",
  );
});

test("找 IDE：按表顺序取第一个存在的（PATH 上的启动器先于应用包）", () => {
  const existsOnly = (...paths: string[]) => (candidate: string) => paths.includes(candidate);

  assert.equal(
    resolveDiffIde({ platform: "linux", homeDir: "/home/u", env: { PATH: "/usr/local/bin" }, exists: existsOnly("/usr/local/bin/cursor") }).id,
    "cursor",
  );
  assert.equal(
    resolveDiffIde({ platform: "darwin", homeDir: "/Users/u", env: { PATH: "" }, exists: existsOnly("/Applications/Zed.app/Contents/MacOS/cli") }).id,
    "zed",
  );
  assert.equal(
    resolveDiffIde({ platform: "linux", homeDir: "/home/u", env: { PATH: "/usr/local/bin" }, exists: existsOnly("/usr/local/bin/code", "/usr/local/bin/cursor") }).id,
    "vscode",
    "两个都在时按表顺序取 VS Code",
  );
  assert.equal(resolveDiffIde({ platform: "linux", homeDir: "/home/u", env: { PATH: "" }, exists: () => false }), null);
});

test("找 IDE：PI_DESKTOP_DIFF_IDE 指定了就只认它，找不到不偷偷退回探测", () => {
  const existsOnly = (...paths: string[]) => (candidate: string) => paths.includes(candidate);

  const custom = resolveDiffIde({ platform: "linux", env: { PATH: "/x", PI_DESKTOP_DIFF_IDE: "zed" }, exists: existsOnly("/x/zed") });
  assert.deepEqual([custom.id, custom.kind, custom.command], ["custom", "vscode", "/x/zed"], "不写 KIND 时按 VS Code 形态");

  const jetbrains = resolveDiffIde({
    platform: "linux",
    env: { PATH: "/x", PI_DESKTOP_DIFF_IDE: "/opt/idea/bin/idea", PI_DESKTOP_DIFF_IDE_KIND: "jetbrains" },
    exists: existsOnly("/opt/idea/bin/idea"),
  });
  assert.deepEqual([jetbrains.kind, jetbrains.command], ["jetbrains", "/opt/idea/bin/idea"]);

  const bogusKind = resolveDiffIde({
    platform: "linux",
    env: { PATH: "/x", PI_DESKTOP_DIFF_IDE: "zed", PI_DESKTOP_DIFF_IDE_KIND: "nonsense" },
    exists: existsOnly("/x/zed"),
  });
  assert.equal(bogusKind.kind, "vscode", "不认识的 KIND 退回 VS Code 形态，而不是把参数拼成垃圾");

  assert.equal(
    resolveDiffIde({ platform: "linux", env: { PATH: "/x", PI_DESKTOP_DIFF_IDE: "nope" }, exists: existsOnly("/x/code") }),
    null,
    "指定了却找不到 → 直接报错，不退回探测别的 IDE",
  );
});

/* ------------------------------------------------------------------ 临时文件 */

test("临时目录：同一 (项目, 文件) 稳定，不同文件分开，都在 tmpdir 下", () => {
  const first = diffTempDirectory("/repo", "a.ts", "/tmp");
  assert.equal(first, diffTempDirectory("/repo", "a.ts", "/tmp"), "同一文件重复双击要复用同一个 diff 标签");
  assert.notEqual(first, diffTempDirectory("/repo", "b.ts", "/tmp"));
  assert.notEqual(first, diffTempDirectory("/other", "a.ts", "/tmp"));
  assert.ok(first.startsWith(join("/tmp", DIFF_TEMP_ROOT)));
});

test("清扫：只删过旧的目录，读不到 mtime 的一律不动", () => {
  const now = Date.now();
  assert.deepEqual(
    staleDiffDirectories(
      [
        { name: "old", mtimeMs: now - 10 * DAY_MS },
        { name: "fresh", mtimeMs: now - 1 * DAY_MS },
        { name: "unknown", mtimeMs: null },
      ],
      { now },
    ),
    ["old"],
  );
});

test("清扫：真删过旧的目录，留下新的；目录不存在时安静返回", () => {
  const baseDir = tempDir("tender-opendiff-sweep-");
  const root = join(baseDir, DIFF_TEMP_ROOT);
  assert.deepEqual(sweepDiffTemps({ baseDir }), [], "没有目录时返回空数组");

  mkdirSync(join(root, "old"), { recursive: true });
  mkdirSync(join(root, "fresh"), { recursive: true });
  const past = new Date(Date.now() - 10 * DAY_MS);
  utimesSync(join(root, "old"), past, past);

  assert.deepEqual(sweepDiffTemps({ baseDir }), ["old"]);
  assert.equal(existsSync(join(root, "old")), false);
  assert.equal(existsSync(join(root, "fresh")), true);
});

test("启动：spawn 事件算成功，error 事件算失败（不等进程退出）", async () => {
  const ok = fakeSpawn();
  await launchDetached("/bin/ide", ["--diff", "L", "R"], { spawnImpl: ok.spawnImpl });
  assert.deepEqual(ok.calls, [{ command: "/bin/ide", args: ["--diff", "L", "R"] }]);

  const failed = fakeSpawn({ failOn: ["/bin/nope"] });
  await assert.rejects(() => launchDetached("/bin/nope", [], { spawnImpl: failed.spawnImpl }), /ENOENT/);
});

/* ------------------------------------------------------------------ 左右两侧（真仓库） */

test("已修改：左侧是 HEAD 里的旧内容，右侧是工作区文件，命令是 `--diff 左 右`", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n");

  const baseDir = tempDir("tender-opendiff-tmp-");
  const ide = fakeIde();
  const { calls, spawnImpl } = fakeSpawn();
  const result = await openGitFileDiff(repo, "a.ts", { platform: "linux", env: ide.env, baseDir, spawnImpl });

  assert.equal(result.ide, "vscode");
  assert.equal(result.right, join(repo, "a.ts"));
  assert.match(result.left, /a \(HEAD\)\.ts$/);
  assert.equal(readFileSync(result.left, "utf8"), "one\ntwo\n");
  assert.deepEqual(calls, [{ command: ide.command, args: ["--diff", result.left, result.right] }]);
});

test("未跟踪：HEAD 里没有它，左侧是空文件（IDE 里显示为整篇新增）", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "new.md"), "# new\n");

  const baseDir = tempDir("tender-opendiff-tmp-");
  const ide = fakeIde();
  const { spawnImpl } = fakeSpawn();
  const result = await openGitFileDiff(repo, "new.md", { platform: "linux", env: ide.env, baseDir, spawnImpl });

  assert.match(result.left, /new \(empty\)\.md$/);
  assert.equal(readFileSync(result.left, "utf8"), "");
  assert.equal(result.right, join(repo, "new.md"));
});

test("已删除：左侧是 HEAD 内容，右侧是空文件（IDE 里显示为整篇删除）", async () => {
  const repo = makeRepo();
  git(repo, ["rm", "-q", "a.ts"]);

  const baseDir = tempDir("tender-opendiff-tmp-");
  const ide = fakeIde();
  const { spawnImpl } = fakeSpawn();
  const result = await openGitFileDiff(repo, "a.ts", { platform: "linux", env: ide.env, baseDir, spawnImpl });

  assert.match(result.left, /a \(HEAD\)\.ts$/);
  assert.equal(readFileSync(result.left, "utf8"), "one\ntwo\n");
  assert.match(result.right, /a \(deleted\)\.ts$/);
  assert.equal(readFileSync(result.right, "utf8"), "");
});

test("重命名：左侧取的是**旧路径**在 HEAD 里的内容，右侧是新路径的工作区文件", async () => {
  const repo = makeRepo();
  git(repo, ["mv", "a.ts", "b.ts"]);

  const baseDir = tempDir("tender-opendiff-tmp-");
  const ide = fakeIde();
  const { spawnImpl } = fakeSpawn();
  const result = await openGitFileDiff(repo, "b.ts", { platform: "linux", env: ide.env, baseDir, spawnImpl });

  assert.equal(readFileSync(result.left, "utf8"), "one\ntwo\n", "旧内容来自 a.ts");
  assert.match(result.left, /b \(HEAD\)\.ts$/, "标签按当前路径命名");
  assert.equal(result.right, join(repo, "b.ts"));
});

test("刚 add 的新文件：HEAD 里没有（只有 index 里有），左侧同样是空文件", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "staged.txt"), "staged\n");
  git(repo, ["add", "staged.txt"]);

  const baseDir = tempDir("tender-opendiff-tmp-");
  const ide = fakeIde();
  const { spawnImpl } = fakeSpawn();
  const result = await openGitFileDiff(repo, "staged.txt", { platform: "linux", env: ide.env, baseDir, spawnImpl });

  assert.match(result.left, /staged \(empty\)\.txt$/);
  assert.equal(readFileSync(result.left, "utf8"), "");
  assert.equal(result.right, join(repo, "staged.txt"));
});

test("重复双击同一文件复用同一对临时文件", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n");

  const baseDir = tempDir("tender-opendiff-tmp-");
  const ide = fakeIde();
  const { spawnImpl } = fakeSpawn();
  const options = { platform: "linux", env: ide.env, baseDir, spawnImpl };
  const first = await openGitFileDiff(repo, "a.ts", options);
  const second = await openGitFileDiff(repo, "a.ts", options);

  assert.deepEqual([second.left, second.right], [first.left, first.right]);
});

test("打开前顺手清掉过旧的临时目录", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n");

  const baseDir = tempDir("tender-opendiff-tmp-");
  const stale = join(baseDir, DIFF_TEMP_ROOT, "stale");
  mkdirSync(stale, { recursive: true });
  const past = new Date(Date.now() - 10 * DAY_MS);
  utimesSync(stale, past, past);

  const ide = fakeIde();
  const { spawnImpl } = fakeSpawn();
  await openGitFileDiff(repo, "a.ts", { platform: "linux", env: ide.env, baseDir, spawnImpl });

  assert.equal(existsSync(stale), false);
});

/* ------------------------------------------------------------------ 拒绝的输入 */

test("路径不在刚刚的 status 里 → 拒绝，什么也不启动", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n");

  const baseDir = tempDir("tender-opendiff-tmp-");
  const ide = fakeIde();
  const { calls, spawnImpl } = fakeSpawn();

  await assert.rejects(
    () => openGitFileDiff(repo, "nope.ts", { platform: "linux", env: ide.env, baseDir, spawnImpl }),
    /Not a changed file: nope\.ts/,
  );
  assert.equal(calls.length, 0);
});

test("未跟踪的目录不是文件 → 明确拒绝（不是拼出一个读不了的路径）", async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "fresh-dir"));
  writeFileSync(join(repo, "fresh-dir", "x.txt"), "x\n");

  const baseDir = tempDir("tender-opendiff-tmp-");
  const ide = fakeIde();
  const { spawnImpl } = fakeSpawn();

  await assert.rejects(
    () => openGitFileDiff(repo, "fresh-dir/", { platform: "linux", env: ide.env, baseDir, spawnImpl }),
    /Not a file: fresh-dir\//,
  );
});

test("找不到可用的 IDE → 报错要说清楚怎么办（指定 PI_DESKTOP_DIFF_IDE），且不启动任何东西", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n");

  const baseDir = tempDir("tender-opendiff-tmp-");
  const { calls, spawnImpl } = fakeSpawn();

  await assert.rejects(
    () => openGitFileDiff(repo, "a.ts", { platform: "linux", env: { PATH: "" }, exists: () => false, baseDir, spawnImpl }),
    /PI_DESKTOP_DIFF_IDE/,
  );
  assert.equal(calls.length, 0);
});

test("IDE 启动器不存在（探到了但 spawn 失败）→ 报错，不假装成功", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n");

  const baseDir = tempDir("tender-opendiff-tmp-");
  const ide = fakeIde();
  const { spawnImpl } = fakeSpawn({ failOn: [ide.command] });

  await assert.rejects(
    () => openGitFileDiff(repo, "a.ts", { platform: "linux", env: ide.env, baseDir, spawnImpl }),
    /ENOENT/,
  );
});

test("macOS：用应用包里的 IDE 打开后补一次 activate（后台进程启动的窗口不一定到前台）", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n");

  const baseDir = tempDir("tender-opendiff-tmp-");
  const command = "/Applications/CodeBuddy.app/Contents/Resources/app/bin/code";
  const { calls, spawnImpl } = fakeSpawn();

  const result = await openGitFileDiff(repo, "a.ts", {
    platform: "darwin",
    env: { PATH: "" },
    exists: (candidate) => candidate === command,
    baseDir,
    spawnImpl,
  });

  assert.equal(result.ide, "codebuddy");
  assert.deepEqual(calls, [
    { command, args: ["--diff", result.left, result.right] },
    { command: "osascript", args: ["-e", 'tell application "CodeBuddy" to activate'] },
  ]);
});