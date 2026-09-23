/**
 * 项目 git 信息（会话头部右侧徽标的数据源）。
 *
 * 这里分两层：
 * - 纯解析函数直接对 porcelain/numstat/for-each-ref 的真实文本做用例（下面每个 fixture
 *   都是从真仓库里跑出来的格式，含 `-z` 的 NUL 分隔和重命名记录的特殊形状）；
 * - `readGitInfo` / `initGitRepo` 用注入的假 `execFile` 跑，不依赖机器上有没有 git，
 *   也保证只读路径永远不碰写命令。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  GIT_TIMEOUT_MS,
  MAX_COMMIT_MESSAGE_CHARS,
  commitGitChanges,
  commitablePaths,
  createGitBranch,
  emptyGitInfo,
  initGitRepo,
  isReadOnlyGitArgs,
  isSafeBranchName,
  isUnknownGitSubcommand,
  normalizeCommitMessage,
  parseBranchHeader,
  parseBranches,
  parseGitVersion,
  parseNumstat,
  parsePorcelainV2,
  parseUpstreamTrack,
  readGitInfo,
  renameGitBranch,
  runReadOnlyGit,
  summarizeChanges,
  switchGitBranch,
} from "../server/gitInfo.mjs";

/** 假 `execFile`：记录调用，按 argv 返回计划好的结果（callback 风格，和真的一样）。 */
function fakeExecFile(plan) {
  const calls = [];
  const exec = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const result = plan(args, options) ?? { ok: false, code: 1, stdout: "", stderr: "unexpected git call" };
    setImmediate(() => {
      const error = result.ok ? null : Object.assign(new Error("git failed"), { code: result.code ?? 1, killed: false });
      callback(error, result.stdout ?? "", result.stderr ?? "");
    });
  };

  return { exec, calls };
}

const VERSION_LINE = "git version 2.39.5 (Apple Git-154)\n";

/* ------------------------------------------------------------------ 只读白名单 */

test("只读白名单放行本模块真正用到的 argv，拒绝一切写命令", () => {
  for (const args of [
    ["rev-parse", "--is-inside-work-tree"],
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
    ["diff", "HEAD", "--numstat", "-z"],
    ["for-each-ref", "--format=%(HEAD)%09%(refname:short)", "refs/heads"],
    ["log", "-1", "--format=%H"],
  ]) {
    assert.equal(isReadOnlyGitArgs(args), true, `应放行: git ${args.join(" ")}`);
  }

  for (const args of [
    ["init"],
    ["commit", "-m", "x"],
    ["checkout", "main"],
    ["switch", "main"],
    ["branch", "-m", "x"],
    ["push"],
    ["reset", "--hard"],
    ["clean", "-fd"],
    ["config", "user.email", "x"],
    ["diff", "--output=/tmp/leak.patch"],
    [],
    ["status", ""],
    ["status", "a\u0000b"],
  ]) {
    assert.equal(isReadOnlyGitArgs(args), false, `应拒绝: git ${args.join(" ")}`);
  }
});

test("runReadOnlyGit 在拼参数阶段就挡下写命令（不会真的 spawn）", async () => {
  const { exec, calls } = fakeExecFile(() => ({ ok: true, stdout: "" }));
  await assert.rejects(() => runReadOnlyGit("/tmp", ["commit", "-m", "x"], { execImpl: exec }), /non read-only/);
  assert.equal(calls.length, 0, "被拒绝的命令不应产生任何子进程调用");
});

test("runReadOnlyGit 把 cwd 放在 spawn 选项里，不拼进 argv", async () => {
  const { exec, calls } = fakeExecFile(() => ({ ok: true, stdout: "true\n" }));
  await runReadOnlyGit("/tmp/my project", ["rev-parse", "--is-inside-work-tree"], { execImpl: exec });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["rev-parse", "--is-inside-work-tree"]);
  assert.equal(calls[0].options.cwd, "/tmp/my project");
  assert.equal(calls[0].options.timeout, GIT_TIMEOUT_MS);
  assert.equal(calls[0].options.env.GIT_OPTIONAL_LOCKS, "0", "不能和用户自己的 git 抢 index.lock");
});

/* ------------------------------------------------------------------ porcelain v2 */

test("解析分支头：普通分支、上游、领先/落后", () => {
  const header = parseBranchHeader([
    "# branch.oid 1234567890abcdef",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 a b file.txt",
  ]);

  assert.deepEqual(header, {
    branch: "main",
    oid: "1234567890abcdef",
    detached: false,
    unborn: false,
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
  });
});

test("解析分支头：游离 HEAD 没有分支名，空仓库标记 unborn", () => {
  const detached = parseBranchHeader(["# branch.oid abc123", "# branch.head (detached)"]);
  assert.equal(detached.branch, "");
  assert.equal(detached.detached, true);
  assert.equal(detached.oid, "abc123");

  const unborn = parseBranchHeader(["# branch.oid (initial)", "# branch.head main"]);
  assert.equal(unborn.unborn, true);
  assert.equal(unborn.oid, "", "还没有 commit 时不应露出 (initial) 当 oid");
  assert.equal(unborn.branch, "main");
});

test("解析变更条目：普通修改 / 已暂存 / 重命名 / 未跟踪 / 冲突", () => {
  const entries = parsePorcelainV2([
    "# branch.head main",
    "1 .M N... 100644 100644 100644 aaa bbb src/app.ts",
    "1 M. N... 100644 100644 100644 ccc ddd src/staged file.ts",
    "2 R. N... 100644 100644 100644 eee fff R100 src/new-name.ts",
    "src/old-name.ts",
    "? notes.md",
    "u UU N... 100644 100644 100644 100644 ggg hhh iii src/conflicted.ts",
  ]);

  assert.deepEqual(
    entries.map((entry) => [entry.path, entry.indexStatus, entry.worktreeStatus, entry.origPath ?? ""]),
    [
      ["src/app.ts", ".", "M", ""],
      ["src/staged file.ts", "M", ".", ""],
      ["src/new-name.ts", "R", ".", "src/old-name.ts"],
      ["notes.md", "?", "?", ""],
      ["src/conflicted.ts", "U", "U", ""],
    ],
  );
});

test("解析变更条目：头信息块不会被当成文件", () => {
  const entries = parsePorcelainV2(["# branch.head main", "# branch.ab +0 -0"]);
  assert.deepEqual(entries, []);
});

/* ------------------------------------------------------------------ numstat */

test("解析 numstat：普通文件、二进制、含空格路径", () => {
  const counts = parseNumstat("3\t1\tsrc/app.ts\u0000-\t-\tlogo.png\u00001\t0\tsrc/a file.ts\u0000");

  assert.deepEqual(counts.get("src/app.ts"), { added: 3, removed: 1 });
  assert.deepEqual(counts.get("logo.png"), { added: 0, removed: 0 }, "二进制文件算 0/0，不能把 '-' 变成 NaN");
  assert.deepEqual(counts.get("src/a file.ts"), { added: 1, removed: 0 });
});

test("解析 numstat：重命名记录把计数归到新路径", () => {
  // 真格式：`<added>\t<removed>\t\u0000<旧路径>\u0000<新路径>`
  const counts = parseNumstat("0\t0\t\u0000src/old-name.ts\u0000src/new-name.ts\u00002\t1\tsrc/other.ts\u0000");

  assert.deepEqual(counts.get("src/new-name.ts"), { added: 0, removed: 0 });
  assert.deepEqual(counts.get("src/other.ts"), { added: 2, removed: 1 });
  assert.equal(counts.size, 2, "旧路径不应单独占一条");
});

/* ------------------------------------------------------------------ 汇总 */

test("汇总：状态分类、暂存标记、总数、按路径排序", () => {
  const entries = parsePorcelainV2([
    "1 .M N... 100644 100644 100644 aaa bbb src/b.ts",
    "1 M. N... 100644 100644 100644 ccc ddd src/a.ts",
    "2 R. N... 100644 100644 100644 eee fff R100 src/renamed.ts",
    "src/gone.ts",
    "? zz.md",
    "u UU N... 100644 100644 100644 100644 ggg hhh iii src/conflict.ts",
  ]);
  const counts = parseNumstat("3\t1\tsrc/b.ts\u00001\t0\tsrc/a.ts\u00000\t0\t\u0000src/gone.ts\u0000src/renamed.ts\u0000");

  const summary = summarizeChanges(entries, counts);

  assert.deepEqual(
    summary.files.map((file) => [file.path, file.status, file.staged, file.untracked, file.conflicted, file.added, file.removed]),
    [
      ["src/a.ts", "modified", true, false, false, 1, 0],
      ["src/b.ts", "modified", false, false, false, 3, 1],
      ["src/conflict.ts", "conflicted", false, false, true, 0, 0],
      ["src/renamed.ts", "renamed", true, false, false, 0, 0],
      ["zz.md", "untracked", false, true, false, 0, 0],
    ],
  );
  assert.equal(summary.added, 4);
  assert.equal(summary.removed, 1);
});

test("汇总：删除/新增/冲突的状态归类", () => {
  const entries = parsePorcelainV2([
    "1 D. N... 100644 100644 100644 aaa bbb deleted.ts",
    "1 A. N... 100644 100644 100644 aaa bbb added.ts",
    "1 .D N... 100644 100644 100644 aaa bbb worktree-deleted.ts",
  ]);
  const summary = summarizeChanges(entries);

  assert.deepEqual(
    summary.files.map((file) => file.status),
    ["added", "deleted", "deleted"],
  );
});

/* ------------------------------------------------------------------ 分支列表 */

test("解析 upstream track 与分支列表", () => {
  assert.deepEqual(parseUpstreamTrack("[ahead 2, behind 1]"), { ahead: 2, behind: 1, gone: false });
  assert.deepEqual(parseUpstreamTrack(""), { ahead: 0, behind: 0, gone: false });
  assert.deepEqual(parseUpstreamTrack("[gone]"), { ahead: 0, behind: 0, gone: true });

  const branches = parseBranches("*\tmain\torigin/main\t[ahead 2, behind 1]\n \tfeature\torigin/feature\t[gone]\n \tlocal-only\t\t\n");

  assert.deepEqual(branches, [
    { name: "main", current: true, upstream: "origin/main", ahead: 2, behind: 1, gone: false },
    { name: "feature", current: false, upstream: "origin/feature", ahead: 0, behind: 0, gone: true },
    { name: "local-only", current: false, upstream: "", ahead: 0, behind: 0, gone: false },
  ]);
});

test("解析 git 版本号", () => {
  assert.equal(parseGitVersion(VERSION_LINE), "2.39.5");
  assert.equal(parseGitVersion(""), "");
  assert.equal(parseGitVersion("nope"), "");
});

/* ------------------------------------------------------------------ readGitInfo */

const REPO_STATUS = [
  "# branch.oid 1234567890abcdef1234567890abcdef12345678",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -1",
  "1 .M N... 100644 100644 100644 aaa bbb src/app.ts",
  "2 R. N... 100644 100644 100644 eee fff R100 src/new-name.ts",
  "src/old-name.ts",
  "? notes.md",
].join("\u0000");
const REPO_NUMSTAT = ["3\t1\tsrc/app.ts", "0\t0\t", "src/old-name.ts", "src/new-name.ts"].join("\u0000");
const REPO_BRANCHES = "*\tmain\torigin/main\t[ahead 2, behind 1]\n \tfeature\torigin/feature\t\n";

/** 一个"装了 git 的正常仓库"的命令计划。 */
function repoPlan(overrides = {}) {
  return (args) => {
    const key = args.join(" ");
    if (overrides[key]) {
      return overrides[key];
    }
    switch (key) {
      case "--version":
        return { ok: true, stdout: VERSION_LINE };
      case "rev-parse --is-inside-work-tree":
        return { ok: true, stdout: "true\n" };
      case "status --porcelain=v2 --branch -z --untracked-files=normal":
        return { ok: true, stdout: `${REPO_STATUS}\u0000` };
      case "diff HEAD --numstat -z":
        return { ok: true, stdout: `${REPO_NUMSTAT}\u0000` };
      default:
        return key.startsWith("for-each-ref")
          ? { ok: true, stdout: REPO_BRANCHES }
          : { ok: false, code: 1, stdout: "", stderr: "unexpected" };
    }
  };
}

test("宿主机没装 git：gitInstalled=false，UI 靠它整块不显示", async () => {
  const { exec } = fakeExecFile(() => ({ ok: false, code: "ENOENT", stdout: "", stderr: "" }));
  const info = await readGitInfo("/tmp/anything", { execImpl: exec });

  assert.equal(info.gitInstalled, false);
  assert.equal(info.isRepo, false);
  assert.deepEqual(info, emptyGitInfo({ gitInstalled: false }));
});

test("装了 git 但项目不是仓库：gitInstalled=true / isRepo=false（显示初始化按钮）", async () => {
  const { exec } = fakeExecFile((args) =>
    args[0] === "--version"
      ? { ok: true, stdout: VERSION_LINE }
      : { ok: false, code: 128, stdout: "", stderr: "fatal: not a git repository\n" },
  );
  const info = await readGitInfo("/tmp/not-a-repo", { execImpl: exec });

  assert.equal(info.gitInstalled, true);
  assert.equal(info.isRepo, false);
  assert.equal(info.gitVersion, "2.39.5");
  assert.deepEqual(info.files, []);
});

test("正常仓库：分支、上游、领先/落后、改动明细与总数", async () => {
  const { exec, calls } = fakeExecFile(repoPlan());
  const info = await readGitInfo("/tmp/repo", { execImpl: exec });

  assert.equal(info.isRepo, true);
  assert.equal(info.branch, "main");
  assert.equal(info.upstream, "origin/main");
  assert.equal(info.ahead, 2);
  assert.equal(info.behind, 1);
  assert.equal(info.gitVersion, "2.39.5");
  assert.deepEqual(
    info.files.map((file) => [file.path, file.status, file.origPath, file.added, file.removed]),
    [
      ["notes.md", "untracked", "", 0, 0],
      ["src/app.ts", "modified", "", 3, 1],
      ["src/new-name.ts", "renamed", "src/old-name.ts", 0, 0],
    ],
  );
  assert.equal(info.added, 3);
  assert.equal(info.removed, 1);
  assert.deepEqual(info.branches, [
    { name: "main", current: true, upstream: "origin/main", ahead: 2, behind: 1, gone: false },
    { name: "feature", current: false, upstream: "origin/feature", ahead: 0, behind: 0, gone: false },
  ]);

  // 只读路径只能出现白名单里的子命令（外加 --version 探测）。
  for (const call of calls) {
    assert.equal(call.command, "git");
    if (call.args[0] !== "--version") {
      assert.equal(isReadOnlyGitArgs(call.args), true, `读路径里出现了非只读命令: ${call.args.join(" ")}`);
    }
  }
});

test("空仓库（还没有第一个 commit）：退回索引/工作区 diff，不因为 HEAD 不存在就报错", async () => {
  const { exec } = fakeExecFile(
    repoPlan({
      "status --porcelain=v2 --branch -z --untracked-files=normal": {
        ok: true,
        stdout: [
          "# branch.oid (initial)",
          "# branch.head main",
          "1 A. N... 000000 100644 100644 0000000 aaa staged.ts",
          "1 .M N... 100644 100644 100644 bbb ccc worktree.ts",
          "? x.txt",
        ].join("\u0000"),
      },
      "diff HEAD --numstat -z": { ok: false, code: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD'\n" },
      "diff --numstat -z": { ok: true, stdout: "4\t0\tworktree.ts\u0000" },
      "diff --cached --numstat -z": { ok: true, stdout: "7\t2\tstaged.ts\u0000" },
    }),
  );
  const info = await readGitInfo("/tmp/empty-repo", { execImpl: exec });

  assert.equal(info.isRepo, true);
  assert.equal(info.unborn, true);
  assert.equal(info.branch, "main");
  assert.equal(info.added, 11, "索引侧和工作区侧的行数都要算上");
  assert.equal(info.removed, 2);
  assert.deepEqual(
    info.files.map((file) => [file.path, file.status, file.staged, file.added, file.removed]),
    [
      ["staged.ts", "added", true, 7, 2],
      ["worktree.ts", "modified", false, 4, 0],
      ["x.txt", "untracked", false, 0, 0],
    ],
  );
});

test("没装 git 时不会去探测项目路径（也不会误报成 isRepo=false + 初始化按钮）", async () => {
  const { exec, calls } = fakeExecFile(() => ({ ok: false, code: "ENOENT", stdout: "", stderr: "" }));
  await readGitInfo("/tmp/anything", { execImpl: exec });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--version"]);
});

/* ------------------------------------------------------------------ initGitRepo */

test("initGitRepo 在项目目录里跑 `git init`", async () => {
  const { exec, calls } = fakeExecFile(() => ({ ok: true, stdout: "Initialized empty Git repository in /tmp/repo/.git/\n" }));

  await initGitRepo("/tmp/repo", { execImpl: exec });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["init"], "不传 -b：分支名交给用户自己的 init.defaultBranch");
  assert.equal(calls[0].options.cwd, "/tmp/repo");
});

test("initGitRepo 失败时把 git 的 stderr 当原因抛出", async () => {
  const { exec } = fakeExecFile(() => ({ ok: false, code: 128, stdout: "", stderr: "fatal: cannot mkdir\n" }));

  await assert.rejects(() => initGitRepo("/tmp/repo", { execImpl: exec }), /fatal: cannot mkdir/);
  await assert.rejects(() => initGitRepo("", { execImpl: exec }), /without a project folder/);
});

/* ------------------------------------------------------------------ switchGitBranch */

const SWITCH_BRANCHES = "*\tmain\torigin/main\t\n \tfeature\torigin/feature\t\n \told\t\t[gone]\n";

/** 分支列表固定，写命令按 override 决定成败。 */
function switchPlan(overrides = {}) {
  return (args) => {
    const key = args.join(" ");
    if (overrides[key]) {
      return overrides[key];
    }
    return key.startsWith("for-each-ref")
      ? { ok: true, stdout: SWITCH_BRANCHES }
      : { ok: false, code: 1, stdout: "", stderr: `unexpected: ${key}` };
  };
}

function writeCalls(calls) {
  return calls.filter((call) => call.args[0] === "switch" || call.args[0] === "checkout");
}

test("分支名安全校验：正常名字放行，选项/控制字符挡下", () => {
  for (const name of ["main", "feature/git-info", "release-1.2", "修复/中文", "user@host"]) {
    assert.equal(isSafeBranchName(name), true, `应放行: ${name}`);
  }

  for (const name of ["", "   ", "-D", "--force", "main\nrm -rf /", "a\u0000b"]) {
    assert.equal(isSafeBranchName(String(name).trim()), false, `应拒绝: ${JSON.stringify(name)}`);
  }
});

test("识别未知子命令（老 git 没 switch）", () => {
  assert.equal(isUnknownGitSubcommand("git: 'switch' is not a git command. See 'git --help'.\n"), true);
  assert.equal(isUnknownGitSubcommand("error: Your local changes would be overwritten\n"), false);
  assert.equal(isUnknownGitSubcommand(""), false);
});

test("switchGitBranch：切到本地已有分支", async () => {
  const { exec, calls } = fakeExecFile(switchPlan({ "switch feature": { ok: true, stdout: "Switched to branch 'feature'\n" } }));

  await switchGitBranch("/tmp/repo", "feature", { execImpl: exec });

  assert.deepEqual(writeCalls(calls).map((call) => call.args), [["switch", "feature"]]);
  assert.equal(writeCalls(calls)[0].options.cwd, "/tmp/repo");
});

test("switchGitBranch：目标就是当前分支时一条写命令都不发", async () => {
  const { exec, calls } = fakeExecFile(switchPlan());

  await switchGitBranch("/tmp/repo", "main", { execImpl: exec });

  assert.equal(calls.length, 1, "只应该有那次 for-each-ref 探测");
  assert.equal(writeCalls(calls).length, 0);
});

test("switchGitBranch：分支不存在 / 名字不合法 → 写命令根本不出门", async () => {
  const unknown = fakeExecFile(switchPlan());
  await assert.rejects(() => switchGitBranch("/tmp/repo", "nope", { execImpl: unknown.exec }), /Unknown branch: nope/);
  assert.equal(writeCalls(unknown.calls).length, 0);

  const unsafe = fakeExecFile(switchPlan());
  await assert.rejects(() => switchGitBranch("/tmp/repo", "--force", { execImpl: unsafe.exec }), /Invalid branch name/);
  assert.equal(unsafe.calls.length, 0, "名字不合法时连探测都不需要");

  await assert.rejects(() => switchGitBranch("", "main", { execImpl: unknown.exec }), /without a project folder/);
});

test("switchGitBranch：老 git 没有 switch 时退回 checkout", async () => {
  const { exec, calls } = fakeExecFile(
    switchPlan({
      "switch feature": { ok: false, code: 1, stderr: "git: 'switch' is not a git command. See 'git --help'.\n" },
      "checkout feature": { ok: true, stderr: "Switched to branch 'feature'\n" },
    }),
  );

  await switchGitBranch("/tmp/repo", "feature", { execImpl: exec });

  assert.deepEqual(writeCalls(calls).map((call) => call.args), [
    ["switch", "feature"],
    ["checkout", "feature"],
  ]);
});

test("switchGitBranch：git 拒绝切换（本地改动会被覆盖）时把原文抛出，不退回 checkout", async () => {
  const { exec, calls } = fakeExecFile(
    switchPlan({
      "switch feature": {
        ok: false,
        code: 1,
        stderr:
          "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/app.ts\nPlease commit your changes or stash them before you switch branches.\nAborting\n",
      },
    }),
  );

  await assert.rejects(() => switchGitBranch("/tmp/repo", "feature", { execImpl: exec }), /would be overwritten by checkout/);
  assert.deepEqual(writeCalls(calls).map((call) => call.args), [["switch", "feature"]], "只有 unknown subcommand 才退回 checkout");
});
/* ------------------------------------------------------------------ createGitBranch */

test("createGitBranch：从当前 HEAD 新建并切过去（只发一条写命令）", async () => {
  const { exec, calls } = fakeExecFile(
    switchPlan({ "switch -c feature/x": { ok: true, stdout: "", stderr: "Switched to a new branch 'feature/x'\n" } }),
  );

  await createGitBranch("/tmp/repo", "feature/x", { execImpl: exec });

  assert.deepEqual(
    writeCalls(calls).map((call) => call.args),
    [["switch", "-c", "feature/x"]],
    "起点不进 argv：当前 HEAD 就是基线",
  );
  assert.equal(writeCalls(calls)[0].options.cwd, "/tmp/repo");
});

test("createGitBranch：重名 / 名字不合法 / 没有项目目录 → 写命令根本不出门", async () => {
  const existing = fakeExecFile(switchPlan());
  await assert.rejects(
    () => createGitBranch("/tmp/repo", "feature", { execImpl: existing.exec }),
    /Branch already exists: feature/,
  );
  assert.equal(writeCalls(existing.calls).length, 0, "已存在的分支不能当新建目标（更不允许隐式切过去）");

  const unsafe = fakeExecFile(switchPlan());
  await assert.rejects(() => createGitBranch("/tmp/repo", "-D", { execImpl: unsafe.exec }), /Invalid branch name/);
  await assert.rejects(() => createGitBranch("/tmp/repo", "   ", { execImpl: unsafe.exec }), /Invalid branch name/);
  assert.equal(unsafe.calls.length, 0, "名字不合法时连探测都不需要");

  await assert.rejects(() => createGitBranch("", "feature", { execImpl: existing.exec }), /without a project folder/);
});

test("createGitBranch：老 git 没有 switch 时退回 checkout -b", async () => {
  const { exec, calls } = fakeExecFile(
    switchPlan({
      "switch -c topic": { ok: false, code: 1, stderr: "git: 'switch' is not a git command. See 'git --help'.\n" },
      "checkout -b topic": { ok: true, stderr: "Switched to a new branch 'topic'\n" },
    }),
  );

  await createGitBranch("/tmp/repo", "topic", { execImpl: exec });

  assert.deepEqual(writeCalls(calls).map((call) => call.args), [
    ["switch", "-c", "topic"],
    ["checkout", "-b", "topic"],
  ]);
});

test("createGitBranch：git 自己拒绝（ref 名不合法）时把原文抛出，不退回 checkout", async () => {
  const { exec, calls } = fakeExecFile(
    switchPlan({ "switch -c bad..name": { ok: false, code: 128, stderr: "fatal: 'bad..name' is not a valid branch name\n" } }),
  );

  await assert.rejects(() => createGitBranch("/tmp/repo", "bad..name", { execImpl: exec }), /not a valid branch name/);
  assert.deepEqual(
    writeCalls(calls).map((call) => call.args),
    [["switch", "-c", "bad..name"]],
    "只有 unknown subcommand 才退回 checkout",
  );
});

/* ------------------------------------------------------------------ renameGitBranch */

/** 只有 `branch` 是写命令；`for-each-ref` 是探测。 */
function branchWriteCalls(calls) {
  return calls.filter((call) => call.args[0] === "branch");
}

test("renameGitBranch：给当前分支改名只发一条 `git branch -m`，旧名字不进 argv", async () => {
  const { exec, calls } = fakeExecFile(switchPlan({ "branch -m feature/x": { ok: true, stdout: "" } }));

  await renameGitBranch("/tmp/repo", "feature/x", { execImpl: exec });

  assert.deepEqual(
    branchWriteCalls(calls).map((call) => call.args),
    [["branch", "-m", "feature/x"]],
    "旧分支名就是 HEAD，不进 argv",
  );
  assert.equal(branchWriteCalls(calls)[0].options.cwd, "/tmp/repo");
});

test("renameGitBranch：同名是空操作；重名 / 非法 / 没目录 → 写命令根本不出门", async () => {
  const same = fakeExecFile(switchPlan());
  await renameGitBranch("/tmp/repo", "main", { execImpl: same.exec });
  assert.equal(branchWriteCalls(same.calls).length, 0, "改成和当前分支同名不必发写命令（git 自己也是空操作）");

  const existing = fakeExecFile(switchPlan());
  await assert.rejects(
    () => renameGitBranch("/tmp/repo", "feature", { execImpl: existing.exec }),
    /Branch already exists: feature/,
  );
  assert.equal(branchWriteCalls(existing.calls).length, 0, "已存在的名字不能当目标（git 也会拒绝）");

  const unsafe = fakeExecFile(switchPlan());
  await assert.rejects(() => renameGitBranch("/tmp/repo", "-D", { execImpl: unsafe.exec }), /Invalid branch name/);
  await assert.rejects(() => renameGitBranch("/tmp/repo", "   ", { execImpl: unsafe.exec }), /Invalid branch name/);
  assert.equal(unsafe.calls.length, 0, "名字不合法时连探测都不需要");

  await assert.rejects(() => renameGitBranch("", "topic", { execImpl: existing.exec }), /without a project folder/);
});

test("renameGitBranch：游离 HEAD 被 git 拒绝时把原文抛出", async () => {
  const { exec, calls } = fakeExecFile(
    switchPlan({
      "branch -m topic": { ok: false, code: 128, stderr: "fatal: cannot rename the current branch while not on any.\n" },
    }),
  );

  await assert.rejects(
    () => renameGitBranch("/tmp/repo", "topic", { execImpl: exec }),
    /cannot rename the current branch while not on any/,
  );
  assert.deepEqual(branchWriteCalls(calls).map((call) => call.args), [["branch", "-m", "topic"]]);
});

/* ------------------------------------------------------------------ commitGitChanges */

const COMMIT_STATUS = `${[
  "# branch.head main",
  "1 .M N... 100644 100644 100644 aaa bbb src/app.ts",
  "2 R. N... 100644 100644 100644 eee fff R100 src/new.ts",
  "src/old.ts",
  "? notes.md",
  "u UU N... 100644 100644 100644 100644 ggg hhh iii src/conflict.ts",
].join("\u0000")}\u0000`;

/** status 固定为 COMMIT_STATUS，写命令按 override 决定成败。 */
function commitPlan(overrides = {}) {
  return (args) => {
    const key = args.join(" ");
    if (overrides[key]) {
      return overrides[key];
    }
    return key.startsWith("status --porcelain=v2")
      ? { ok: true, stdout: COMMIT_STATUS }
      : { ok: false, code: 1, stdout: "", stderr: `unexpected: ${key}` };
  };
}

const COMMIT_UPDATE = "add --";
const COMMIT_RECORD = "commit -m";

function writeArgs(calls, prefix) {
  return calls.filter((call) => call.args.join(" ").startsWith(prefix)).map((call) => call.args);
}

test("提交信息校验：trim、拒空、拒 NUL、拒超长", () => {
  assert.equal(normalizeCommitMessage("  fix: 修复  "), "fix: 修复");
  assert.equal(normalizeCommitMessage("multi\nline"), "multi\nline");
  for (const bad of ["", "   ", "\n\t"]) {
    assert.throws(() => normalizeCommitMessage(bad), /Commit message is required/);
  }
  assert.throws(() => normalizeCommitMessage("a\u0000b"), /cannot contain NUL/);
  assert.throws(() => normalizeCommitMessage("x".repeat(MAX_COMMIT_MESSAGE_CHARS + 1)), /too long/);
});

test("可提交路径：排除冲突、带回重命名的旧路径", () => {
  const { paths, conflicted } = commitablePaths(parsePorcelainV2(COMMIT_STATUS.split("\u0000")));

  assert.deepEqual([...paths].sort(), ["notes.md", "src/app.ts", "src/new.ts", "src/old.ts"]);
  assert.deepEqual([...conflicted], ["src/conflict.ts"]);
});

test("commitGitChanges：修改过的文件不用 add，未跟踪文件先 add 再 commit", async () => {
  const { exec, calls } = fakeExecFile(
    commitPlan({
      "add -- notes.md": { ok: true, stdout: "" },
      "commit -m fix: 头部徽标 -- notes.md src/app.ts": { ok: true, stdout: "[main abc1234] fix: 头部徽标\n 2 files changed\n" },
    }),
  );

  const output = await commitGitChanges(
    "/tmp/repo",
    { message: "  fix: 头部徽标  ", paths: ["src/app.ts", "notes.md", "src/app.ts"] },
    { execImpl: exec },
  );

  assert.match(output, /\[main abc1234\]/);
  // 部分提交自己就取工作区内容，不需要也不应该对已跟踪的文件先 add。
  assert.deepEqual(writeArgs(calls, "add "), [["add", "--", "notes.md"]]);
  assert.deepEqual(writeArgs(calls, COMMIT_RECORD), [["commit", "-m", "fix: 头部徽标", "--", "notes.md", "src/app.ts"]]);
  assert.equal(calls[1].options.cwd, "/tmp/repo");
});

test("commitGitChanges：只选已跟踪的文件时一条 add 都不发（不碰别人暂存的东西）", async () => {
  const { exec, calls } = fakeExecFile(
    commitPlan({ "commit -m only-tracked -- src/app.ts": { ok: true, stdout: "[main abc] only-tracked\n" } }),
  );

  await commitGitChanges("/tmp/repo", { message: "only-tracked", paths: ["src/app.ts"] }, { execImpl: exec });

  assert.equal(writeArgs(calls, "add ").length, 0);
});

test("commitGitChanges：只传新路径也会带上重命名的旧路径，且不需要 add", async () => {
  const { exec, calls } = fakeExecFile(
    commitPlan({
      "commit -m rename -- src/new.ts src/old.ts": { ok: true, stdout: "[main abc] rename\n" },
      // 对已暂存的重命名再 add 会以 "pathspec did not match" fatal，实测过，所以必须不出现。
      "add -- src/new.ts": { ok: false, code: 128, stdout: "", stderr: "fatal: pathspec 'src/new.ts' did not match\n" },
    }),
  );

  await commitGitChanges("/tmp/repo", { message: "rename", paths: ["src/new.ts"] }, { execImpl: exec });

  assert.equal(writeArgs(calls, "add ").length, 0);
  assert.deepEqual(writeArgs(calls, COMMIT_RECORD), [["commit", "-m", "rename", "--", "src/new.ts", "src/old.ts"]]);
});

test("commitGitChanges：路径不在 status 里 / 是冲突文件 / 信息为空 → 一条写命令都不发", async () => {
  const notChanged = fakeExecFile(commitPlan());
  await assert.rejects(
    () => commitGitChanges("/tmp/repo", { message: "x", paths: ["src/secret.env"] }, { execImpl: notChanged.exec }),
    /Not a changed file: src\/secret.env/,
  );
  assert.equal(writeArgs(notChanged.calls, COMMIT_UPDATE).length, 0);

  const conflicted = fakeExecFile(commitPlan());
  await assert.rejects(
    () => commitGitChanges("/tmp/repo", { message: "x", paths: ["src/conflict.ts"] }, { execImpl: conflicted.exec }),
    /Resolve conflicts before committing/,
  );
  assert.equal(writeArgs(conflicted.calls, COMMIT_UPDATE).length, 0);

  const emptyMessage = fakeExecFile(commitPlan());
  await assert.rejects(() => commitGitChanges("/tmp/repo", { message: "  ", paths: ["notes.md"] }, { execImpl: emptyMessage.exec }), /required/);
  assert.equal(emptyMessage.calls.length, 0, "信息不合法时连 status 都不需要读");

  const emptyPaths = fakeExecFile(commitPlan());
  await assert.rejects(() => commitGitChanges("/tmp/repo", { message: "x", paths: [] }, { execImpl: emptyPaths.exec }), /at least one file/);
  assert.equal(emptyPaths.calls.length, 0);
});

test("commitGitChanges：git 拒绝时抛原文，add 失败就不会走到 commit", async () => {
  const { exec, calls } = fakeExecFile(
    commitPlan({ "add -- notes.md": { ok: false, code: 1, stderr: "error: unable to index file 'notes.md'\n" } }),
  );

  await assert.rejects(() => commitGitChanges("/tmp/repo", { message: "x", paths: ["notes.md"] }, { execImpl: exec }), /unable to index file/);
  assert.equal(writeArgs(calls, COMMIT_RECORD).length, 0, "add 失败后不能继续 commit");

  const identity = fakeExecFile(
    commitPlan({
      "commit -m x -- src/app.ts": {
        ok: false,
        code: 128,
        stderr: "Author identity unknown\n\n*** Please tell me who you are.\n",
      },
    }),
  );
  await assert.rejects(
    () => commitGitChanges("/tmp/repo", { message: "x", paths: ["src/app.ts"] }, { execImpl: identity.exec }),
    /Please tell me who you are/,
  );
});
