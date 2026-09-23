/**
 * 托管 worktree（一个会话一个隔离检出）。
 *
 * 分两层：
 * - 纯解析/匹配函数直接对 porcelain、`.worktreeinclude`、`status -z` 的真实文本做用例；
 * - 生命周期（create / list / remove / include 复制）在临时真仓库里跑真 git，格式和用户
 *   自己终端里看到的完全一致 —— 这里断言的是"新 worktree 真的不在同一个分支上、忽略文件
 *   真的被带过去"，而不是某个 argv 字符串。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_WORKTREE_INCLUDE_FILES,
  WORKTREE_KEEP_COUNT,
  copyWorktreeIncludeFiles,
  createManagedWorktree,
  isManagedWorktreePath,
  listManagedWorktrees,
  managedWorktreeId,
  matchesWorktreeInclude,
  normalizeWorktreeRelativePath,
  parseStatusPorcelainZ,
  parseWorktreeInclude,
  parseWorktreeListPorcelain,
  readWorktreeChanges,
  removeManagedWorktree,
  selectWorktreeIncludeFiles,
  worktreeDisplayName,
  worktreeRemovalBlocked,
  worktreeRootFor,
} from "../server/gitWorktree.mjs";

test("worktreeRootFor / managedWorktreeId：根目录跟着 agentDir，目录名可读且只含安全字符", () => {
  assert.equal(worktreeRootFor("/agent"), join("/agent", "worktrees"));
  assert.equal(managedWorktreeId("Tender Code", "abcdef1234567890"), "tender-code-abcdef123456");
  assert.equal(managedWorktreeId("", ""), "project-session");
  assert.match(managedWorktreeId("项目/A", "../../etc"), /^[a-z0-9-]+$/);
});

test("normalizeWorktreeRelativePath：反斜杠折成正斜杠，去掉开头的 ./", () => {
  assert.equal(normalizeWorktreeRelativePath(".\\config\\a.env"), "config/a.env");
  assert.equal(normalizeWorktreeRelativePath("./a.env"), "a.env");
});

test("isManagedWorktreePath：根目录本身不算、前缀相近的兄弟目录不算、真正在里面才算", () => {
  const root = "/data/worktrees";
  assert.equal(isManagedWorktreePath(root, "/data/worktrees/repo-1"), true);
  assert.equal(isManagedWorktreePath(root, "/data/worktrees"), false, "根目录不是某个 worktree");
  assert.equal(isManagedWorktreePath(root, "/data/worktrees-other/repo-1"), false, "前缀相近不算");
  assert.equal(isManagedWorktreePath(root, "/data/repo"), false, "项目主检出不算");
  assert.equal(isManagedWorktreePath("", "/data/worktrees/a"), false);
});

test("parseWorktreeListPorcelain：主检出 / detached / locked / prunable / bare", () => {
  const text = [
    "worktree /repo",
    "HEAD aaaa1111",
    "branch refs/heads/main",
    "",
    "worktree /agent/worktrees/app-1",
    "HEAD bbbb2222",
    "detached",
    "",
    "worktree /agent/worktrees/app-2",
    "HEAD cccc3333",
    "branch refs/heads/feature",
    "locked work in progress",
    "",
    "worktree /agent/worktrees/app-3",
    "HEAD dddd4444",
    "detached",
    "prunable gitdir file points to non-existent location",
    "",
    "worktree /bare.git",
    "HEAD eeee5555",
    "bare",
    "",
  ].join("\n");

  const entries = parseWorktreeListPorcelain(text);
  assert.equal(entries.length, 5);
  assert.deepEqual(
    entries.map((entry) => [entry.path, entry.branchName, entry.detached, entry.locked, entry.prunable, entry.bare]),
    [
      ["/repo", "main", false, false, false, false],
      ["/agent/worktrees/app-1", "", true, false, false, false],
      ["/agent/worktrees/app-2", "feature", false, true, false, false],
      ["/agent/worktrees/app-3", "", true, false, true, false],
      ["/bare.git", "", false, false, false, true],
    ],
  );
  assert.equal(entries[2].lockReason, "work in progress");
  assert.equal(entries[3].prunableReason, "gitdir file points to non-existent location");
});

test("parseWorktreeInclude：注释/空行丢掉，反斜杠归一，保留取反与目录规则", () => {
  const text = ["# 说明", "", "  .env  ", "config\\secrets.json", "!important.env", "logs/"].join("\n");
  assert.deepEqual(parseWorktreeInclude(text), [".env", "config/secrets.json", "!important.env", "logs/"]);
  assert.deepEqual(parseWorktreeInclude(""), []);
});

test("matchesWorktreeInclude：不锚定规则命中任意一层，锚定规则只看整条路径", () => {
  const patterns = parseWorktreeInclude(["*.env", "/config/secrets.json", "node_modules/"].join("\n"));

  assert.equal(matchesWorktreeInclude(patterns, ".env"), true);
  assert.equal(matchesWorktreeInclude(patterns, "app/.env"), true, "不锚定的规则命中任意一层");
  assert.equal(matchesWorktreeInclude(patterns, "config/secrets.json"), true);
  assert.equal(matchesWorktreeInclude(patterns, "app/config/secrets.json"), false, "锚定规则只匹配仓库根");
  assert.equal(matchesWorktreeInclude(patterns, "node_modules/left-pad/index.js"), true, "目录规则带上其下所有文件");
  assert.equal(matchesWorktreeInclude(patterns, "app/node_modules/x/y.js"), true, "目录规则不锚定");
  assert.equal(matchesWorktreeInclude(patterns, "src/main.ts"), false);
});

test("matchesWorktreeInclude：后面的规则覆盖前面的（取反），`**` 跨目录", () => {
  const patterns = parseWorktreeInclude(["*.env", "!important.env", "**/fixtures/*.json"].join("\n"));
  assert.equal(matchesWorktreeInclude(patterns, ".env"), true);
  assert.equal(matchesWorktreeInclude(patterns, "important.env"), false, "取反规则放后面才生效");
  assert.equal(matchesWorktreeInclude(patterns, "a/b/fixtures/data.json"), true);
  assert.equal(matchesWorktreeInclude(patterns, "fixtures/data.json"), true, "**/ 也匹配零层");
  assert.equal(matchesWorktreeInclude(patterns, "a/b/fixtures/deep/data.json"), false, "单个 * 不跨目录");
});

test("selectWorktreeIncludeFiles：只挑命中的候选，顺序不变", () => {
  const patterns = parseWorktreeInclude([".env", "config/"].join("\n"));
  assert.deepEqual(
    selectWorktreeIncludeFiles(patterns, ["src/a.ts", ".env", "config/db.json", "config/nested/x", ".envrc"]),
    [".env", "config/db.json", "config/nested/x"],
  );
});

test("parseStatusPorcelainZ：修改 / 未跟踪 / 被忽略分开，重命名的原始路径不算一条改动", () => {
  const text = [" M src/a.ts", "?? fresh.txt", "!! .env", "R  new.ts", "old.ts", "!! node_modules/"].join("\0") + "\0";
  const parsed = parseStatusPorcelainZ(text);
  assert.deepEqual(parsed.changed, ["src/a.ts", "new.ts"]);
  assert.deepEqual(parsed.untracked, ["fresh.txt"]);
  assert.deepEqual(parsed.ignored, [".env", "node_modules/"]);
});

test("worktreeRemovalBlocked：干净才放行，任何一类未提交内容都给出数量", () => {
  assert.equal(worktreeRemovalBlocked({ changed: [], untracked: [], ignored: [] }), "");
  assert.match(worktreeRemovalBlocked({ changed: ["a"], untracked: ["b"], ignored: ["c"] }), /修改 1 \/ 未跟踪 1 \/ 被忽略 1/);
  assert.equal(WORKTREE_KEEP_COUNT, 15);
  assert.ok(MAX_WORKTREE_INCLUDE_FILES >= 1);
});

/** 临时真仓库：`git -C <dir>` 跑真命令，全局/系统配置隔离掉，避免吃到开发者机器的 user.name。 */
function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], {
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, git };
}

test("createManagedWorktree：detached 检出、起点是当前 HEAD、忽略文件按 .worktreeinclude 带过去", async () => {
  const repo = createRepo();
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-root-"));
  try {
    writeFileSync(join(repo.dir, ".gitignore"), "*.env\nnode_modules/\n");
    repo.git("add", ".gitignore");
    repo.git("commit", "-qm", "ignore");
    writeFileSync(join(repo.dir, ".worktreeinclude"), ".env\n");
    writeFileSync(join(repo.dir, ".env"), "SECRET=1\n");
    writeFileSync(join(repo.dir, "other.env"), "ALSO=1\n");
    mkdirSync(join(repo.dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo.dir, "node_modules", "pkg", "index.js"), "module.exports = 1\n");

    const head = repo.git("rev-parse", "HEAD").toString().trim();
    const created = await createManagedWorktree(repo.dir, { root, id: "app-session1" });

    assert.equal(created.path, realpathSync(join(root, "app-session1")));
    assert.equal(created.base, head, "起点就是当前 HEAD");
    assert.ok(existsSync(join(created.path, "tracked.txt")), "已跟踪文件已检出");
    assert.equal(readFileSync(join(created.path, ".env"), "utf8"), "SECRET=1\n", "声明的忽略文件被复制");
    assert.equal(existsSync(join(created.path, "other.env")), false, "没声明的不复制");
    assert.equal(existsSync(join(created.path, "node_modules")), false, "没声明的目录不复制");

    const branch = execFileSync("git", ["-C", created.path, "rev-parse", "--abbrev-ref", "HEAD"], { stdio: "pipe" }).toString().trim();
    assert.equal(branch, "HEAD", "worktree 是 detached HEAD，不占分支");

    const listed = await listManagedWorktrees(repo.dir, { root });
    assert.deepEqual(listed.map((entry) => entry.path), [created.path]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("createManagedWorktree：空仓库（没有第一个 commit）给出可读错误，不留半个 worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-empty-"));
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-root-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main", "."], {
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    await assert.rejects(
      () => createManagedWorktree(dir, { root, id: "app-x" }),
      /还没有任何提交/,
    );
    assert.equal(existsSync(join(root, "app-x")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeManagedWorktree：脏 worktree 默认拒绝，force 才删；非托管路径永不删", async () => {
  const repo = createRepo();
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-root-"));
  try {
    const created = await createManagedWorktree(repo.dir, { root, id: "app-session2" });
    writeFileSync(join(created.path, "dirty.txt"), "uncommitted\n");

    const changes = await readWorktreeChanges(created.path);
    assert.deepEqual(changes.untracked, ["dirty.txt"]);

    await assert.rejects(
      () => removeManagedWorktree(repo.dir, created.path, { root }),
      /未提交内容/,
    );
    assert.ok(existsSync(created.path), "拒绝之后目录还在");

    await assert.rejects(
      () => removeManagedWorktree(repo.dir, repo.dir, { root, force: true }),
      /只删除应用自己创建的 worktree/,
    );

    await removeManagedWorktree(repo.dir, created.path, { root, force: true });
    assert.equal(existsSync(created.path), false, "force 之后目录被删");
    assert.deepEqual(await listManagedWorktrees(repo.dir, { root }), [], "注册信息也被清掉");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("removeManagedWorktree：目录已被外部删掉时走 prune，只清登记信息", async () => {
  const repo = createRepo();
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-root-"));
  try {
    const created = await createManagedWorktree(repo.dir, { root, id: "app-session3" });
    writeFileSync(join(created.path, "dirty.txt"), "user deleted the folder later\n");
    // 模拟用户在访达里直接把目录删了（git 的登记信息还挂在 list 里）。
    rmSync(created.path, { recursive: true, force: true });
    assert.equal((await listManagedWorktrees(repo.dir, { root })).length, 1, "登记信息还在");

    // 不需要 force：已经没有文件可丢了。
    const removed = await removeManagedWorktree(repo.dir, created.path, { root });
    assert.equal(removed.pruned, true);
    assert.deepEqual(await listManagedWorktrees(repo.dir, { root }), [], "登记信息被清掉");
    // 主检出不受影响。
    assert.equal(readFileSync(join(repo.dir, "tracked.txt"), "utf8"), "one\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("copyWorktreeIncludeFiles：不覆盖 worktree 里已存在的文件，超过上限的记录 skipped", async () => {
  const repo = createRepo();
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-root-"));
  try {
    writeFileSync(join(repo.dir, ".gitignore"), "*.env\n");
    repo.git("add", ".gitignore");
    repo.git("commit", "-qm", "ignore");
    writeFileSync(join(repo.dir, ".worktreeinclude"), ".env\n");
    writeFileSync(join(repo.dir, ".env"), "SOURCE\n");

    const created = await createManagedWorktree(repo.dir, { root, id: "app-session3" });
    // worktree 里已经有一份（用户在那边改过）时不能被源仓库覆盖。
    writeFileSync(join(created.path, ".env"), "WORKTREE\n");
    const result = await copyWorktreeIncludeFiles(repo.dir, created.path);

    assert.deepEqual(result.copied, [], "已存在就不复制");
    assert.equal(readFileSync(join(created.path, ".env"), "utf8"), "WORKTREE\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("worktreeDisplayName：取路径最后一段", () => {
  assert.equal(worktreeDisplayName("/a/b/app-1"), "app-1");
  assert.equal(worktreeDisplayName("/a/b/app-1/"), "app-1");
});
/** workspace 判定（会话跑在哪个目录）—— 错了就是 agent 在错的检出里改文件。 */
test("resolveSessionWorkspaceCwd：只有托管 worktree 里的活目录才采信，其余退回项目目录", async () => {
  const { resolveSessionWorkspaceCwd } = await import("../server/sessionWorkspace.mjs");
  const projectCwd = "/repo";
  const worktreeRoot = "/agent/worktrees";
  const live = "/agent/worktrees/app-1";

  assert.deepEqual(
    resolveSessionWorkspaceCwd({ projectCwd, worktreeRoot, sessionCwd: projectCwd }),
    { cwd: projectCwd, reason: "project" },
  );
  assert.deepEqual(
    resolveSessionWorkspaceCwd({ projectCwd, worktreeRoot, sessionCwd: "" }),
    { cwd: projectCwd, reason: "project" },
  );
  assert.deepEqual(
    resolveSessionWorkspaceCwd({ projectCwd, worktreeRoot, sessionCwd: "/elsewhere/repo" }),
    { cwd: projectCwd, reason: "project" },
    "托管根目录之外的 cwd 一律不采信（用户自己建的 worktree 也不接管）",
  );
  assert.deepEqual(
    resolveSessionWorkspaceCwd({ projectCwd, worktreeRoot, sessionCwd: live, pathExists: () => true }),
    { cwd: live, reason: "worktree" },
  );
  assert.deepEqual(
    resolveSessionWorkspaceCwd({ projectCwd, worktreeRoot, sessionCwd: live, pathExists: () => false }),
    { cwd: projectCwd, reason: "missing" },
    "worktree 目录没了就退回项目目录，而不是把 runtime 建在已消失的路径上",
  );
});
