/**
 * 会话头部 git 徽标的显示规则与接线。
 *
 * 徽标形态由 `src/shared/gitStatusBadge.ts` 的纯函数决定（这里覆盖它），React 部分
 * (`src/components/GitStatusBadge.tsx`) 和 App.tsx 的接线按仓库惯例从源码断言 —— App.tsx
 * 是 .tsx，`node --test` 不能 import 它。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  gitBadgeKind,
  gitBranchDeleteState,
  gitBranchListVisible,
  gitBranchSwitchState,
  gitChangeTotals,
  gitCommitBlockReason,
  gitCommitPlan,
  gitConflictedFiles,
  gitCreateBranchBlockReason,
  gitHeadLabel,
  gitMergeActionState,
  gitMergeTargets,
  gitPullActionState,
  gitPushActionState,
  gitRenameBranchBlockReason,
  gitStatusLabelKey,
  gitStatusLetter,
  groupGitFiles,
  isGitClean,
  type GitBranchSummary,
  type GitFileChange,
  type GitInfo,
} from "../src/shared/gitStatusBadge.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const badgeSource = readFileSync(new URL("../src/components/GitStatusBadge.tsx", import.meta.url), "utf8");
const hookSource = readFileSync(new URL("../src/features/chat/useProjectGit.ts", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../src/i18n/zh.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../src/i18n/en.ts", import.meta.url), "utf8");

function makeInfo(patch: Partial<GitInfo> = {}): GitInfo {
  return {
    gitInstalled: true,
    gitVersion: "2.39.5",
    isRepo: true,
    branch: "main",
    oid: "",
    detached: false,
    unborn: false,
    upstream: "",
    ahead: 0,
    behind: 0,
    files: [],
    added: 0,
    removed: 0,
    branches: [],
    ...patch,
  };
}

function makeFile(patch: Partial<GitFileChange> = {}): GitFileChange {
  return {
    path: "src/a.ts",
    origPath: "",
    status: "modified",
    staged: false,
    untracked: false,
    conflicted: false,
    added: 0,
    removed: 0,
    ...patch,
  };
}

/* ------------------------------------------------------------------ 显示规则 */

test("宿主机没装 git → 整块不显示；未加载（null）也不显示", () => {
  assert.equal(gitBadgeKind(null), "hidden");
  assert.equal(gitBadgeKind(undefined), "hidden");
  assert.equal(gitBadgeKind(makeInfo({ gitInstalled: false, isRepo: false })), "hidden");
  // 没装 git 时即使项目恰好是仓库也不显示（gitInstalled 优先）。
  assert.equal(gitBadgeKind(makeInfo({ gitInstalled: false })), "hidden");
});

test("装了 git 但项目不是仓库 → 显示初始化按钮；是仓库 → 显示状态", () => {
  assert.equal(gitBadgeKind(makeInfo({ isRepo: false })), "init");
  assert.equal(gitBadgeKind(makeInfo()), "status");
});

test("分支标签：普通分支用名字，游离 HEAD 用短 oid，空仓库仍有分支名", () => {
  assert.equal(gitHeadLabel(makeInfo({ branch: "feature/x" })), "feature/x");
  assert.equal(gitHeadLabel(makeInfo({ detached: true, branch: "", oid: "1234567890abcdef" })), "1234567");
  assert.equal(gitHeadLabel(makeInfo({ detached: true, branch: "", oid: "" })), "HEAD");
  assert.equal(gitHeadLabel(makeInfo({ unborn: true, branch: "main", oid: "" })), "main");
  assert.equal(gitHeadLabel(makeInfo({ branch: "" })), "HEAD", "拿不到名字时不能渲染成空白");
});

test("改动统计与干净判定", () => {
  const info = makeInfo({
    files: [makeFile(), makeFile({ path: "b.ts" })],
    added: 12,
    removed: 3,
  });

  assert.deepEqual(gitChangeTotals(info), { files: 2, added: 12, removed: 3 });
  assert.equal(isGitClean(info), false);
  assert.equal(isGitClean(makeInfo()), true);
});

test("状态字母与 i18n key 覆盖全部六种状态", () => {
  assert.deepEqual(
    (["modified", "added", "deleted", "renamed", "untracked", "conflicted"] as const).map((status) => [status, gitStatusLetter(status), gitStatusLabelKey(status)]),
    [
      ["modified", "M", "git.file.modified"],
      ["added", "A", "git.file.added"],
      ["deleted", "D", "git.file.deleted"],
      ["renamed", "R", "git.file.renamed"],
      ["untracked", "?", "git.file.untracked"],
      ["conflicted", "U", "git.file.conflicted"],
    ],
  );
});

test("分组：已暂存 / 未暂存 / 未跟踪，冲突归未暂存", () => {
  const staged = makeFile({ path: "staged.ts", staged: true });
  const unstaged = makeFile({ path: "unstaged.ts" });
  const conflicted = makeFile({ path: "conflict.ts", conflicted: true, status: "conflicted" });
  const untracked = makeFile({ path: "new.md", untracked: true, status: "untracked" });

  const grouped = groupGitFiles([staged, unstaged, conflicted, untracked]);

  assert.deepEqual(grouped.staged.map((file) => file.path), ["staged.ts"]);
  assert.deepEqual(grouped.unstaged.map((file) => file.path), ["unstaged.ts", "conflict.ts"]);
  assert.deepEqual(grouped.untracked.map((file) => file.path), ["new.md"]);
});

/* ------------------------------------------------------------------ 切分支 */

function makeBranch(patch: Partial<GitBranchSummary> = {}): GitBranchSummary {
  return { name: "feature", current: false, upstream: "", ahead: 0, behind: 0, gone: false, ...patch };
}

test("分支行的可点击状态：当前分支 / 回答生成中 / 已有切换在飞", () => {
  const idle = { isStreaming: false, switchingTo: "" };

  assert.deepEqual(gitBranchSwitchState(makeBranch({ current: true }), idle), {
    isCurrent: true,
    isSwitching: false,
    disabled: true,
    reason: "current",
  });

  assert.deepEqual(gitBranchSwitchState(makeBranch(), { isStreaming: true, switchingTo: "" }), {
    isCurrent: false,
    isSwitching: false,
    disabled: true,
    reason: "streaming",
  });

  const busy = gitBranchSwitchState(makeBranch(), { isStreaming: false, switchingTo: "feature" });
  assert.equal(busy.disabled, true);
  assert.equal(busy.reason, "busy");
  assert.equal(busy.isSwitching, true, "正在切的那一行要转圈");
  assert.equal(
    gitBranchSwitchState(makeBranch({ name: "other" }), { isStreaming: false, switchingTo: "feature" }).isSwitching,
    false,
    "没在切的那一行不转圈",
  );

  // 新建分支也是改 HEAD 的写操作：它飞在路上的时候，分支行同样不能点（不然两个写操作打架）。
  const creating = gitBranchSwitchState(makeBranch(), { isStreaming: false, switchingTo: "", isCreating: true });
  assert.equal(creating.disabled, true);
  assert.equal(creating.reason, "busy");
  assert.equal(creating.isSwitching, false, "新建分支不给某一行转圈");

  // 删除分支期间，别的分支行也不能切（写操作不排队）。
  const deleting = gitBranchSwitchState(makeBranch(), { isStreaming: false, switchingTo: "", isBusy: true });
  assert.equal(deleting.disabled, true);
  assert.equal(deleting.reason, "busy");

  assert.deepEqual(gitBranchSwitchState(makeBranch(), idle), {
    isCurrent: false,
    isSwitching: false,
    disabled: false,
    reason: "ok",
  });

  // 流式中优先报 streaming（提示文案不同），即使同时有切换在飞。
  assert.equal(gitBranchSwitchState(makeBranch(), { isStreaming: true, switchingTo: "feature" }).reason, "streaming");
});

test("分支列表：有本地分支就显示（包括只有一个分支的情况）", () => {
  assert.equal(gitBranchListVisible(makeInfo()), false);
  assert.equal(gitBranchListVisible(makeInfo({ branches: [makeBranch({ current: true, name: "main" })] })), true);
  assert.equal(gitBranchListVisible(makeInfo({ branches: [makeBranch({ current: true, name: "main" }), makeBranch()] })), true);
});

test("删除图标状态：当前分支 → current；删除中/别的写在飞 → busy；流式 → streaming", () => {
  const idle = { isStreaming: false, deletingBranch: "" };

  assert.deepEqual(gitBranchDeleteState(makeBranch({ current: true }), idle), {
    isCurrent: true,
    isDeleting: false,
    disabled: true,
    reason: "current",
  });

  // 正在删的那一行转圈。
  assert.deepEqual(gitBranchDeleteState(makeBranch(), { isStreaming: false, deletingBranch: "feature" }), {
    isCurrent: false,
    isDeleting: true,
    disabled: true,
    reason: "busy",
  });

  // 别的行在删除期间也不能点（避免并发写）。
  const other = gitBranchDeleteState(makeBranch({ name: "other" }), { isStreaming: false, deletingBranch: "feature" });
  assert.equal(other.disabled, true);
  assert.equal(other.reason, "busy");
  assert.equal(other.isDeleting, false);

  assert.equal(
    gitBranchDeleteState(makeBranch({ name: "other" }), { isStreaming: true, deletingBranch: "feature" }).reason,
    "streaming",
    "流式优先报 streaming（提示文案不同）",
  );
  assert.equal(gitBranchDeleteState(makeBranch(), { isStreaming: false, deletingBranch: "", isBusy: true }).reason, "busy");

  assert.deepEqual(gitBranchDeleteState(makeBranch(), idle), {
    isCurrent: false,
    isDeleting: false,
    disabled: false,
    reason: "ok",
  });
});

test("新建分支表单：流式 > 新建中 > 空名字 > 重名 > ok", () => {
  const reason = (patch: Partial<Parameters<typeof gitCreateBranchBlockReason>[0]> = {}) =>
    gitCreateBranchBlockReason({
      isStreaming: false,
      isCreating: false,
      name: "topic",
      branches: [makeBranch({ name: "main", current: true }), makeBranch({ name: "feature" })],
      ...patch,
    });

  assert.equal(reason(), "ok");
  assert.equal(reason({ isStreaming: true }), "streaming");
  assert.equal(reason({ isStreaming: true, isCreating: true }), "streaming", "流式优先报 streaming（文案不同）");
  assert.equal(reason({ isCreating: true }), "busy");
  assert.equal(reason({ name: "" }), "empty");
  assert.equal(reason({ name: "   " }), "empty");
  assert.equal(reason({ name: " feature " }), "exists", "trim 后再比重名");
  assert.equal(reason({ name: "feature/git-info" }), "ok", "不重名的斜杠名字放行");
});

test("重命名当前分支：流式 > 重命名中 > 空名字 > 同名 > 重名 > ok", () => {
  const reason = (patch: Partial<Parameters<typeof gitRenameBranchBlockReason>[0]> = {}) =>
    gitRenameBranchBlockReason({
      isStreaming: false,
      isRenaming: false,
      name: "topic",
      current: "main",
      branches: [makeBranch({ name: "main", current: true }), makeBranch({ name: "feature" })],
      ...patch,
    });

  assert.equal(reason(), "ok");
  assert.equal(reason({ isStreaming: true }), "streaming");
  assert.equal(reason({ isStreaming: true, isRenaming: true }), "streaming", "流式优先报 streaming（文案不同）");
  assert.equal(reason({ isRenaming: true }), "busy");
  assert.equal(reason({ name: "" }), "empty");
  assert.equal(reason({ name: "   " }), "empty");
  assert.equal(reason({ name: " main " }), "unchanged", "trim 后和当前分支同名 → 空操作，确认按钮应禁用");
  assert.equal(reason({ name: " feature " }), "exists", "trim 后再比重名");
  assert.equal(reason({ name: "feature/git-info" }), "ok", "不重名的斜杠名字放行");
});

/* ------------------------------------------------------------------ 提交 */

test("提交计划：默认全选、取消勾选生效、冲突文件排除在外", () => {
  const info = makeInfo({
    files: [
      makeFile({ path: "src/a.ts" }),
      makeFile({ path: "src/b.ts" }),
      makeFile({ path: "src/conflict.ts", conflicted: true, status: "conflicted" }),
    ],
  });

  const all = gitCommitPlan(info);
  assert.deepEqual(all.paths, ["src/a.ts", "src/b.ts"]);
  assert.equal(all.fileCount, 2, "fileCount 数的是文件，不是 paths 条数");
  assert.deepEqual(all.conflicted.map((file) => file.path), ["src/conflict.ts"]);

  const partial = gitCommitPlan(info, new Set(["src/b.ts"]));
  assert.deepEqual(partial.paths, ["src/a.ts"]);
  assert.equal(partial.fileCount, 1);
});

test("提交计划：重命名带旧路径，但只计一个文件", () => {
  const info = makeInfo({
    files: [makeFile({ path: "src/new.ts", origPath: "src/old.ts", status: "renamed", staged: true })],
  });

  const plan = gitCommitPlan(info);
  assert.deepEqual(plan.paths, ["src/new.ts", "src/old.ts"]);
  assert.equal(plan.fileCount, 1);
});

test("提交按钮的禁用原因：流式 > 提交中 > 信息为空 > 没选文件 > ok", () => {
  const reason = (patch: Partial<Parameters<typeof gitCommitBlockReason>[0]>) =>
    gitCommitBlockReason({ isStreaming: false, isCommitting: false, message: "fix", fileCount: 2, ...patch });

  assert.equal(reason({}), "ok");
  assert.equal(reason({ isStreaming: true }), "streaming");
  assert.equal(reason({ isStreaming: true, isCommitting: true }), "streaming");
  assert.equal(reason({ isCommitting: true }), "busy");
  assert.equal(reason({ message: "   " }), "emptyMessage");
  assert.equal(reason({ fileCount: 0 }), "noFiles");
  assert.equal(reason({ message: "", fileCount: 0 }), "emptyMessage", "先抱怨信息为空，再抱怨没选文件");
});

test("弹层里能从当前分支新建分支：按钮→表单→服务端", () => {
  assert.match(badgeSource, /gitCreateBranchBlockReason\(\{/, "表单可用性由纯函数算");
  assert.match(badgeSource, /t\("git\.newBranch"\)/, "要有新建分支按钮文案");
  assert.match(badgeSource, /<GitBranchPlus[\s\S]{0,120}t\("git\.newBranch"\)/, "新建分支按钮要有图标");
  assert.match(badgeSource, /t\("git\.newBranchFrom", \{ branch: head \}\)/, "按钮要说明基线就是当前分支");
  assert.match(badgeSource, /onClick=\{openCreateForm\}/, "点按钮展开新建表单");
  assert.match(badgeSource, /const created = await onCreateBranch\(newBranchName\.trim\(\)\)/, "提交前 trim，成功后才收起表单");
  assert.match(badgeSource, /t\("git\.newBranchExists", \{ branch: newBranchName\.trim\(\) \}\)/, "重名要在表单里说清楚");
  assert.match(
    badgeSource,
    /disabled=\{isStreaming \|\| Boolean\(switchingTo\) \|\| isCreatingBranch\}/,
    "流式/有写操作在飞时不能开始新建",
  );
  assert.match(hookSource, /postJson<GitInfo>\("\/api\/projects\/git\/create-branch", \{ projectId, sessionPath, name \}\)/, "要打新建分支的路由");
  assert.match(hookSource, /t\("git\.createBranchFailed", \{ reason \}\)/, "失败原因要进会话错误横幅");
  assert.match(appSource, /onCreateBranch=\{projectGit\.createBranch\}/, "App.tsx 要接上 createBranch");
  assert.match(appSource, /isCreatingBranch=\{projectGit\.isCreatingBranch\}/, "新建中要能禁用按钮");
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/create-branch"/, "缺少 POST /api/projects/git/create-branch");
  // worktree 会话必须在自己那个检出里建分支，否则新分支会落到主检出上。
  // cwd 仍然只由服务端从 projectId/sessionPath 解析，客户端不能直接传路径。
  assert.match(
    serverSource,
    /const cwd = requestWorkspaceCwd\(project, body\);\s*await createGitBranch\(cwd, String\(body\?\.name \?\? ""\)\)/,
    "新建分支路由在会话 workspace 里执行；起点由服务端定（不接受参数）",
  );
  assert.ok(!/createGitBranch\([^)]*body\?\.from/.test(serverSource), "客户端不能指定分支起点");
});

test("分支名后面有铅笔：点它把当前分支名变成输入框，回车改名", () => {
  assert.match(badgeSource, /gitRenameBranchBlockReason\(\{/, "改名表单可用性由纯函数算");
  assert.match(badgeSource, /<Pencil/, "要有铅笔图标");
  assert.match(
    badgeSource,
    /aria-label=\{t\("git\.renameBranch"\)\}/,
    "铅笔按钮要有无障碍名字（图标按钮不能只有 title）",
  );
  assert.match(badgeSource, /onClick=\{openRenameForm\}/, "点铅笔展开改名表单");
  assert.match(
    badgeSource,
    /onOpenChange=\{\(next\) => \{[\s\S]{0,500}closeRenameForm\(\)/,
    "收起弹层要重置改名表单，不该带着上次没提交的名字",
  );
  assert.match(badgeSource, /setRenameName\(head\)/, "输入框预填当前分支名");
  assert.match(badgeSource, /const renamed = await onRenameBranch\(renameName\.trim\(\)\)/, "提交前 trim，成功后才收起表单");
  assert.match(badgeSource, /t\("git\.renameBranchExists", \{ branch: renameName\.trim\(\) \}\)/, "重名要在表单里说清楚");
  assert.match(
    badgeSource,
    /isRenaming && renameHint[\s\S]{0,220}\{renameHint\}/,
    "重名/同名原因要摆在输入框下面，不靠 hover 看 title",
  );
  // 改名只针对 HEAD 所在的分支：游离 HEAD 没有分支名可改，铅笔不渲染。
  assert.match(
    badgeSource,
    /\{!info\.detached \? \([\s\S]{0,1400}<Pencil/,
    "游离 HEAD 时藏掉铅笔（那里没有分支名可改）",
  );
  // 铅笔要跟在分支名后面（同一行左侧）；行尾只剩刷新。
  const headerStart = badgeSource.indexOf('border-b px-3 py-2"');
  const nameRow = badgeSource.slice(headerStart, badgeSource.indexOf("<RefreshCw", headerStart));
  const headAt = nameRow.indexOf("{head}");
  assert.ok(nameRow.includes("<Pencil"), "铅笔要跟分支名同组，不跟刷新挤在最右边");
  assert.ok(headAt !== -1 && nameRow.indexOf("<Pencil") > headAt, "铅笔要在分支名之后");
  assert.match(hookSource, /postJson<GitInfo>\("\/api\/projects\/git\/rename-branch", \{ projectId, name \}\)/, "要打改名的路由");
  assert.match(hookSource, /t\("git\.renameBranchFailed", \{ reason \}\)/, "失败原因要进会话错误横幅");
  assert.match(appSource, /onRenameBranch=\{projectGit\.renameBranch\}/, "App.tsx 要接上 renameBranch");
  assert.match(appSource, /isRenamingBranch=\{projectGit\.isRenamingBranch\}/, "改名中要能禁用按钮");
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/rename-branch"/, "缺少 POST /api/projects/git/rename-branch");
  assert.match(
    serverSource,
    /renameGitBranch\(project\.cwd, String\(body\?\.name \?\? ""\)\)/,
    "改名路由从项目表取 cwd；旧分支名由服务端定（不接受参数）",
  );
  assert.ok(!/renameGitBranch\([^)]*body\?\.(from|old)/.test(serverSource), "客户端不能指定要改哪个分支");
});

/* ------------------------------------------------------------------ 同步动作（拉取 / 合并 / 推送 / 冲突） */

test("拉取按钮：没有上游 / 流式 / 游离 HEAD / 空仓库 / 有同步在飞 → 禁用；有上游且空闲 → 可点", () => {
  const idle = { isStreaming: false, isPulling: false, isPushing: false };
  const withUpstream = makeInfo({ upstream: "origin/main" });

  assert.deepEqual(gitPullActionState(withUpstream, idle), { disabled: false, reason: "ok" });
  assert.deepEqual(gitPullActionState(makeInfo(), idle), { disabled: true, reason: "noUpstream" }, "没有上游就没有可拉取的目标");
  assert.deepEqual(
    gitPullActionState(withUpstream, { ...idle, isStreaming: true }),
    { disabled: true, reason: "streaming" },
    "拉取会动工作区，流式时禁用（同切分支）",
  );
  assert.deepEqual(gitPullActionState(withUpstream, { ...idle, isPulling: true }), { disabled: true, reason: "busy" });
  assert.deepEqual(gitPullActionState(withUpstream, { ...idle, isPushing: true }), { disabled: true, reason: "busy" }, "推送在飞时禁拉取");
  assert.deepEqual(
    gitPullActionState(makeInfo({ upstream: "origin/main", detached: true }), idle),
    { disabled: true, reason: "detached" },
  );
  assert.deepEqual(
    gitPullActionState(makeInfo({ upstream: "origin/main", unborn: true }), idle),
    { disabled: true, reason: "unborn" },
  );
});

test("合并按钮：没有其它本地分支 / 流式 / 游离 HEAD / 空仓库 / 有同步在飞 → 禁用；有目标且空闲 → 可点", () => {
  const idle = { isStreaming: false, isMerging: false, isPulling: false, isPushing: false };
  const withTarget = makeInfo({
    branch: "main",
    branches: [makeBranch({ name: "main", current: true }), makeBranch({ name: "feature" })],
  });

  assert.deepEqual(gitMergeTargets(withTarget).map((branch) => branch.name), ["feature"], "当前分支不算合并目标");
  assert.deepEqual(gitMergeTargets(makeInfo({ detached: true, branches: [makeBranch({ name: "feature" })] })), [], "游离 HEAD 没有目标");
  assert.deepEqual(gitMergeActionState(withTarget, idle), { disabled: false, reason: "ok" });
  assert.deepEqual(
    gitMergeActionState(makeInfo({ branches: [makeBranch({ name: "main", current: true })] }), idle),
    { disabled: true, reason: "noTarget" },
    "只有当前分支时没有目标",
  );
  assert.deepEqual(gitMergeActionState(withTarget, { ...idle, isStreaming: true }), { disabled: true, reason: "streaming" });
  assert.deepEqual(gitMergeActionState(withTarget, { ...idle, isMerging: true }), { disabled: true, reason: "busy" });
  assert.deepEqual(gitMergeActionState(withTarget, { ...idle, isPulling: true }), { disabled: true, reason: "busy" });
  assert.deepEqual(gitMergeActionState(withTarget, { ...idle, isPushing: true }), { disabled: true, reason: "busy" });
  assert.deepEqual(
    gitMergeActionState(makeInfo({ detached: true, branches: [makeBranch({ name: "feature" })] }), idle),
    { disabled: true, reason: "detached" },
  );
  assert.deepEqual(
    gitMergeActionState(makeInfo({ unborn: true, branches: [makeBranch({ name: "feature" })] }), idle),
    { disabled: true, reason: "unborn" },
  );
  assert.equal(
    gitMergeActionState(withTarget, { ...idle, isStreaming: true, isMerging: true }).reason,
    "streaming",
    "流式优先报 streaming（文案不同）",
  );
});

test("推送按钮：没有上游仍然可点（那是「关联远端」）；游离 HEAD / 空仓库 / 有同步在飞 → 禁用", () => {
  const idle = { isPushing: false, isPulling: false, isMerging: false };

  assert.deepEqual(gitPushActionState(makeInfo(), idle), { disabled: false, reason: "ok" }, "没有上游 = 关联远端，不该禁用");
  assert.deepEqual(gitPushActionState(makeInfo({ upstream: "origin/main" }), idle), { disabled: false, reason: "ok" });
  assert.deepEqual(gitPushActionState(makeInfo({ detached: true }), idle), { disabled: true, reason: "detached" });
  assert.deepEqual(gitPushActionState(makeInfo({ unborn: true }), idle), { disabled: true, reason: "unborn" });
  assert.deepEqual(gitPushActionState(makeInfo(), { isPushing: true, isPulling: false, isMerging: false }), { disabled: true, reason: "busy" });
  assert.deepEqual(
    gitPushActionState(makeInfo(), { isPushing: false, isPulling: true, isMerging: false }),
    { disabled: true, reason: "busy" },
    "拉取在飞时禁推送",
  );
  assert.deepEqual(
    gitPushActionState(makeInfo(), { isPushing: false, isPulling: false, isMerging: true }),
    { disabled: true, reason: "busy" },
    "合并在飞时禁推送",
  );
});

test("冲突文件：gitConflictedFiles 只挑冲突条目", () => {
  const info = makeInfo({
    files: [
      makeFile({ path: "a.ts" }),
      makeFile({ path: "conflict.ts", conflicted: true, status: "conflicted" }),
    ],
  });

  assert.deepEqual(gitConflictedFiles(info).map((file) => file.path), ["conflict.ts"]);
  assert.deepEqual(gitConflictedFiles(makeInfo()), []);
});

test("弹层顶部：拉取 → 合并（下拉）→ 推送 → 刷新；推送无上游时叫「关联远端」", () => {
  assert.match(badgeSource, /gitPullActionState\(info, \{ isStreaming, isPulling, isPushing \}\)/, "拉取可用性由纯函数算");
  assert.match(
    badgeSource,
    /gitMergeActionState\(info, \{ isStreaming, isMerging: isMergingBranch, isPulling, isPushing \}\)/,
    "合并可用性由纯函数算",
  );
  assert.match(badgeSource, /gitPushActionState\(info, \{ isPushing, isPulling, isMerging: isMergingBranch \}\)/, "推送可用性由纯函数算");
  assert.match(badgeSource, /gitMergeTargets\(info\)/, "合并目标来自本地分支纯函数");
  assert.match(badgeSource, /<ArrowDownToLine[\s\S]{0,2600}<GitMerge[\s\S]{0,2600}<Upload[\s\S]{0,1800}<RefreshCw/, "四枚图标按拉取/合并/推送/刷新排列");
  assert.match(badgeSource, /onClick=\{\(\) => void onPull\(\)\}/, "拉取按钮要有处理函数");
  assert.match(badgeSource, /onSelect=\{\(\) => void onMergeBranch\(branch\.name\)\}/, "合并下拉每一项触发合并");
  assert.match(badgeSource, /onClick=\{\(\) => void onPush\(\)\}/, "推送按钮要有处理函数");
  assert.match(badgeSource, /aria-label=\{pullTitle\}/, "拉取按钮要有无障碍名字");
  assert.match(badgeSource, /aria-label=\{mergeTitle\}/, "合并按钮要有无障碍名字（图标按钮不能只有 title）");
  assert.match(badgeSource, /aria-label=\{pushTitle\}/, "推送按钮要有无障碍名字");
  assert.match(badgeSource, /t\("git\.pushSetUpstream"\)/, "没有上游时推送要显示为「关联远端」");
  assert.match(badgeSource, /t\("git\.mergeIntoLabel", \{ current: head \}\)/, "合并下拉要说清楚合到当前分支");
  assert.match(badgeSource, /disabled=\{pullState\.disabled\}/, "拉取按钮受状态控制");
  assert.match(badgeSource, /disabled=\{mergeState\.disabled\}/, "合并按钮受状态控制");
  assert.match(badgeSource, /disabled=\{pushState\.disabled\}/, "推送按钮受状态控制");
  assert.match(hookSource, /postJson<GitInfo>\("\/api\/projects\/git\/push", \{ projectId, sessionPath \}\)/, "要打推送的路由");
  assert.match(hookSource, /postJson<GitInfo>\("\/api\/projects\/git\/pull", \{ projectId, sessionPath \}\)/, "要打拉取的路由（不再是 merge）");
  assert.match(hookSource, /postJson<\{ conflict: boolean; branch: string; info: GitInfo \}>\("\/api\/projects\/git\/merge"/, "合并走 merge 路由并带回 info");
  assert.match(hookSource, /t\("git\.pushFailed", \{ reason \}\)/, "推送失败原因要进会话错误横幅");
  assert.match(hookSource, /t\("git\.pullFailed", \{ reason \}\)/, "拉取失败原因要进会话错误横幅");
  assert.match(hookSource, /t\("git\.mergeFailed", \{ reason \}\)/, "合并失败原因要进会话错误横幅");
  assert.match(appSource, /onPush=\{projectGit\.pushBranch\}/, "App.tsx 要接上 pushBranch");
  assert.match(appSource, /onPull=\{projectGit\.pullBranch\}/, "App.tsx 要接上 pullBranch");
  assert.match(appSource, /onMergeBranch=\{projectGit\.mergeBranch\}/, "App.tsx 要接上 mergeBranch");
  assert.match(appSource, /isPushing=\{projectGit\.isPushing\}/, "推送中要能禁用按钮");
  assert.match(appSource, /isPulling=\{projectGit\.isPulling\}/, "拉取中要能禁用按钮");
  assert.match(appSource, /isMergingBranch=\{projectGit\.isMergingBranch\}/, "合并中要能禁用按钮");
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/push"/, "缺少 POST /api/projects/git/push");
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/pull"/, "缺少 POST /api/projects/git/pull");
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/merge"/, "缺少 POST /api/projects/git/merge");
  assert.match(serverSource, /await pushGitBranch\(cwd\)/, "推送在会话 workspace 里执行");
  assert.match(serverSource, /await pullGitBranch\(cwd\)/, "拉取在会话 workspace 里执行");
  assert.match(serverSource, /await mergeGitBranchInto\(cwd, String\(body\?\.branch \?\? ""\)\)/, "合并只收分支名，目标由服务端校验");
});

test("合并成功后弹层里要有成功提示（快进合并可能什么都不变，列表看不出来）", () => {
  assert.match(
    hookSource,
    /if \(!result\.conflict\) \{\s*showNotice\(t\("git\.mergeSuccess", \{ branch: result\.branch, current: result\.info\.branch \}\)\);/,
    "干净合并在 hook 里发成功提示（冲突不发，避免和冲突提示自相矛盾）",
  );
  assert.match(hookSource, /notice: string;/, "controller 要暴露 notice 字段");
  assert.match(hookSource, /GIT_NOTICE_DISMISS_MS/, "提示会自动消失，不赖在弹层里");
  assert.match(badgeSource, /notice: string;/, "弹层 props 要收 notice");
  assert.match(badgeSource, /role="status"/, "成功提示要能被辅助技术读出来");
  assert.match(appSource, /notice=\{projectGit\.notice\}/, "App.tsx 要把 notice 传给弹层");
});

test("冲突入口：双击开文件（不是 diff），另有「打开冲突文件 / 自动解决冲突」", () => {
  assert.match(badgeSource, /if \(file\.conflicted\) \{\s*onOpenFile\(file\.path\);/, "冲突行双击打开文件本身");
  assert.match(badgeSource, /t\("git\.openConflictHint"\)/, "冲突行要说清楚双击是编辑冲突");
  assert.match(badgeSource, /gitConflictedFiles\(info\)/, "冲突清单由纯函数算");
  assert.match(badgeSource, /onClick=\{openConflictsClick\}/, "要有「用 IDE 打开冲突文件」按钮");
  assert.match(badgeSource, /onClick=\{\(\) => void autoResolveConflictsClick\(\)\}/, "要有「自动解决冲突」按钮");
  assert.match(badgeSource, /t\("git\.resolveConflicts"\)/, "自动解决按钮要有 i18n 文案");
  assert.match(hookSource, /postJson<\{ ide: string \}>\("\/api\/projects\/git\/open-file", \{ projectId, sessionPath, path \}\)/, "要打打开文件的路由");
  assert.match(hookSource, /postJson<\{ prompt: string \}>\("\/api\/projects\/git\/conflicts"/, "要打冲突 prompt 的路由");
  assert.match(hookSource, /t\("git\.openConflictFailed", \{ reason \}\)/, "打开冲突文件失败要进会话错误横幅");
  assert.match(hookSource, /t\("git\.conflictPromptFailed", \{ reason \}\)/, "读冲突信息失败要进会话错误横幅");
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/open-file"/, "缺少 POST /api/projects/git/open-file");
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/conflicts"/, "缺少 POST /api/projects/git/conflicts");
  assert.match(serverSource, /openGitFileInIde\(cwd, String\(body\?\.path \?\? ""\)\)/, "打开文件要在会话 workspace 里执行");
  assert.match(serverSource, /buildConflictPrompt\(\{ locale: body\?\.locale, context: \{ \.\.\.context, projectCwd: project\.cwd \} \}\)/, "prompt 由服务端按 locale 拼");
  assert.match(appSource, /onOpenFile=\{projectGit\.openFile\}/, "App.tsx 要接上 openFile");
  assert.match(appSource, /onAutoResolveConflicts=\{autoResolveConflicts\}/, "App.tsx 要接上自动解决冲突");
  assert.match(appSource, /await createSession\(projectId\);\s*setDraft\(prompt\);/, "自动解决：新建会话后把 prompt 填进 composer");
  assert.match(appSource, /setDraft,/, "App 要从 hook 拿到 setDraft");
});

/* ------------------------------------------------------------------ 界面接线 */

test("合并成功提示文案中英都在，且用 {branch}/{current} 两个占位符", () => {
  assert.match(zhSource, /"git\.mergeSuccess": "[^"]*\{branch\}[^"]*\{current\}[^"]*"/, "中文要用上两个占位符");
  assert.match(enSource, /"git\.mergeSuccess": "[^"]*\{branch\}[^"]*\{current\}[^"]*"/, "英文要用上两个占位符");
});

test("git 徽标挂在会话头部的右部（标题之后），不是别处", () => {
  const start = appSource.indexOf('<header className="conversation-header');
  assert.notEqual(start, -1, "会话头部不见了");
  const end = appSource.indexOf("</header>", start);
  const header = appSource.slice(start, end);

  const badgeAt = header.indexOf("<GitStatusBadge");
  assert.notEqual(badgeAt, -1, "会话头部里应有 GitStatusBadge");
  assert.ok(badgeAt > header.indexOf("{conversation.title}"), "徽标必须在标题右侧");
  // 头部右部的那个容器里必须同时装着徽标和设置按钮（原样保留）。
  const rightSide = header.slice(header.indexOf('<div className="flex shrink-0 items-center gap-2">'));
  assert.ok(rightSide.indexOf("<GitStatusBadge") < rightSide.indexOf("</div>"), "徽标要落在右侧容器内");
});

test("App.tsx 用 useProjectGit 驱动徽标：跟着当前项目、一轮结束刷新、失败上报", () => {
  assert.match(appSource, /useProjectGit\(\{/, "App.tsx 应调用 useProjectGit");
  assert.match(appSource, /projectId:\s*bootstrap\.activeProjectId/, "要跟随当前项目，而不是固定项目");
  assert.match(appSource, /isStreaming:\s*state\.isStreaming/, "一轮回答结束时需要刷新一次");
  assert.match(appSource, /onError:\s*reportError/, "初始化/切分支失败要交给会话错误横幅");
  assert.match(appSource, /onInit=\{\(\) => void projectGit\.initRepo\(\)\}/, "初始化按钮要接到 initRepo");
  assert.match(appSource, /onRefresh=\{\(\) => void projectGit\.refresh\(\)\}/, "弹层里的刷新按钮要接到 refresh");
  assert.match(appSource, /onSwitchBranch=\{projectGit\.switchBranch\}/, "分支行要接到 switchBranch");
  assert.match(appSource, /onCommit=\{projectGit\.commitChanges\}/, "提交按钮要接到 commitChanges");
  assert.match(appSource, /isCommitting=\{projectGit\.isCommitting\}/, "提交中要能禁用按钮");
  assert.match(appSource, /isStreaming=\{state\.isStreaming\}/, "徽标要知道是否在流式（决定能不能切分支/提交）");
});

test("提交面板：勾选框 + 信息框 + 受控按钮，冲突文件不可选", () => {
  assert.match(badgeSource, /<Checkbox[\s\S]*?onCheckedChange=\{\(checked\) => onToggle\(file\.path, checked === true\)\}/, "文件行要有勾选框");
  assert.match(badgeSource, /<Textarea[\s\S]*?aria-label=\{t\("git\.commitMessage"\)\}/, "要有提交信息输入框");
  assert.match(badgeSource, /disabled=\{blockReason !== "ok"\}/, "按钮禁用要由 gitCommitBlockReason 决定");
  assert.match(badgeSource, /onClick=\{\(\) => void commitClick\(\)\}/, "提交按钮要有处理函数");
  assert.match(badgeSource, /const committed = await onCommit\(\{ message: commitMessage\.trim\(\)/, "提交前 trim，成功后才清空输入");
  assert.match(badgeSource, /if \(file\.conflicted\) \{\s*onOpenFile\(file\.path\);/, "冲突文件行双击打开文件本身，不是 diff");
  assert.match(badgeSource, /git\.openConflictHint/, "冲突文件行要说清楚双击是编辑冲突");
  assert.match(badgeSource, /gitCommitPlan\(info, unselected\)/, "提交计划由纯函数算");
  assert.match(badgeSource, /t\("git\.commit"\)/, "提交按钮要有 i18n 文案");
});

test("提交按钮用最小尺寸，旁边是「用当前模型生成」", () => {
  // 用户反馈过按钮太大：提交/生成/冲突操作都用 xs（h-6）。只数提交面板里的：新建分支表单也有
  // 自己的 xs 按钮，不该被当成"提交面板多出来的按钮"。
  const panelStart = badgeSource.indexOf("{/* 提交面板");
  const panelEnd = badgeSource.indexOf("{gitBranchListVisible(info)", panelStart);
  assert.notEqual(panelStart, -1, "找不到提交面板的标记注释");
  const commitPanel = badgeSource.slice(panelStart, panelEnd);
  assert.equal((commitPanel.match(/size="xs"/g) ?? []).length, 4, "生成/提交 + 打开冲突/自动解决四个按钮都用最小尺寸");
  const commitButton = /<Button[\s\S]{0,300}?onClick=\{\(\) => void commitClick\(\)\}[\s\S]{0,200}?t\("git\.commit"\)/.exec(badgeSource)?.[0] ?? "";
  assert.match(commitButton, /size="xs"/, "提交按钮要用最小尺寸");
  assert.match(commitButton, /onClick=\{\(\) => void commitClick\(\)\}/, "这段确实就是提交按钮");
  assert.ok(!/size="sm"/.test(badgeSource), "提交面板里不应再出现大号按钮");

  assert.match(badgeSource, /<Sparkles/, "生成按钮要有图标");
  assert.match(badgeSource, /onClick=\{\(\) => void generateClick\(\)\}/, "生成按钮要有处理函数");
  assert.match(badgeSource, /const generated = await onGenerateMessage\(plan\.paths\)/, "生成要带上选中路径");
  assert.match(badgeSource, /setCommitMessage\(generated\)/, "生成结果直接填进输入框（不自动提交）");
  assert.match(badgeSource, /disabled=\{plan\.fileCount === 0 \|\| isGeneratingMessage \|\| isCommitting \|\| isStreaming\}/, "生成按钮的禁用条件");
  assert.match(badgeSource, /t\("git\.generateMessage"\)/, "生成按钮要有 i18n 文案");
  assert.match(appSource, /onGenerateMessage=\{projectGit\.generateCommitMessage\}/, "App.tsx 要接上 generateCommitMessage");
  assert.match(appSource, /isGeneratingMessage=\{projectGit\.isGeneratingMessage\}/, "生成中要能禁用按钮");
});

/* ------------------------------------------------------------------ 双击看 diff */

test("双击改动文件：用宿主机的 IDE 打开 diff（渲染层只发一个请求，不自己跑 git 或 IDE）", () => {
  assert.match(badgeSource, /onDoubleClick={\(event\) => {/, "文件行要有双击处理");
  assert.match(badgeSource, /onOpenDiff\(file\.path\)/, "双击要带上这一行的文件路径");
  assert.match(badgeSource, /closest\('\[role="checkbox"\]'\)/, "点在勾选框上不算打开（那次点击只该切勾选）");
  assert.match(badgeSource, /t\("git\.openDiffHint"\)/, "行 tooltip 要说明双击能看 diff");
  assert.match(badgeSource, /<GitFileGroup[\s\S]*?onOpenDiff={onOpenDiff}/, "已暂存/未暂存/未跟踪三个分组都要接上 onOpenDiff");
  assert.ok(!/child_process|execFile|spawn/.test(badgeSource), "渲染层不能自己启动 IDE");

  // 只有勾选框自己会选中/取消：文件行不能是 label（label 会把整行都变成勾选框的热区）。
  const groupStart = badgeSource.indexOf("function GitFileGroup(");
  assert.notEqual(groupStart, -1, "GitFileGroup 不见了");
  const groupEnd = badgeSource.indexOf("\n}\n", groupStart);
  const group = badgeSource.slice(groupStart, groupEnd === -1 ? undefined : groupEnd);
  assert.ok(!/<label[\s>]/.test(group), "文件行不能用 <label>，否则点行内任何地方都会切勾选");
  assert.match(group, /<Checkbox[\s\S]*?onCheckedChange/, "勾选只能来自勾选框自己");

  assert.match(hookSource, /postJson<\{ ide: string \}>\("\/api\/projects\/git\/open-diff", \{ projectId, path \}\)/, "要打打开 diff 的路由");
  assert.match(hookSource, /t\("git\.openDiffFailed", \{ reason \}\)/, "失败原因要进会话错误横幅");
  assert.match(appSource, /onOpenDiff={projectGit\.openDiff}/, "App.tsx 要接上 openDiff");

  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/open-diff"/, "缺少 POST /api/projects/git/open-diff");
  assert.match(serverSource, /openGitFileDiff\(project\.cwd, String\(body\?\.path \?\? ""\)\)/, "要从项目表取 cwd，路径交给服务端校验");
});

test("弹层高度封顶：信息写长了不会顶出窗口，内容自己滚", () => {
  // 用户报过：提交信息框（field-sizing-content）写长后整个弹层超出窗口，而弹层是 fixed 定位，
  // 页面滚不动 → 底部按钮永远点不到。修法是给弹层加「可用高度上限」并自己滚，各块不压缩。
  const content = /<PopoverContent[\s\S]*?>/.exec(badgeSource)?.[0] ?? "";
  assert.match(content, /max-h-\[var\(--radix-popover-content-available-height/, "弹层要受 Radix 算出的可用高度限制");
  assert.match(content, /flex-col/, "弹层要竖着排，子块才好分别控制");
  assert.match(content, /overflow-y-auto/, "弹层自己要能滚");
  assert.match(
    badgeSource,
    /className="max-h-64 min-h-\[6rem\] flex-1 overflow-auto border-t py-1"/,
    "文件列表自己滚，且既不会被挤没也不吃掉整个高度",
  );
  assert.match(
    badgeSource,
    /className="max-h-32 min-h-\[3rem\] resize-none overflow-y-auto text-xs"/,
    "提交信息框最高 8rem 后内滚（不然就是它把弹层顶出去的）",
  );
  assert.equal((badgeSource.match(/shrink-0 space-y-2 border-t px-3 py-2/g) ?? []).length, 1, "提交面板不能被压缩");
  assert.match(badgeSource, /flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2/, "标题行不能被压缩");
});

test("生成信息走服务端且用当前会话的模型，不把 diff 发到别处", () => {
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/commit-message"/, "缺少生成信息的路由");
  assert.match(serverSource, /const cwd = requestWorkspaceCwd\(project, body\);\s*const context = await readCommitDiff\(cwd, body\?\.paths\)/, "服务端自己读 diff，不信客户端传的内容");
  assert.match(serverSource, /const model = getRuntimeForRequest\(body\)\.session\.model;/, "要用目标会话的模型（而不是面板里碰巧选中的那个）");
  assert.match(serverSource, /buildCommitMessagePrompt\(\{ locale: body\?\.locale, context \}\)/, "prompt 由纯函数拼");
  assert.match(serverSource, /normalizeGeneratedCommitMessage\(assistantContentText\(response\)\)/, "模型输出要规范化");
  assert.match(serverSource, /sendJson\(res, 200, \{ message, model: `\$\{model\.provider\}\/\$\{model\.id\}` \}\)/, "只回文本，不直接提交");
});

test("分支行是按钮：当前分支不可点，脏工作区先弹确认", () => {
  assert.match(
    badgeSource,
    /gitBranchSwitchState\(branch, \{\s*isStreaming,\s*switchingTo,\s*isCreating: isCreatingBranch,\s*isBusy: isRenamingBranch \|\| Boolean\(deletingBranch\),\s*\}\)/,
    "每行都要算可点状态",
  );
  assert.match(badgeSource, /onClick=\{\(\) => branchClick\(branch\.name\)\}/, "点分支行触发切换");
  assert.match(badgeSource, /disabled=\{state\.disabled\}/, "不可点的行要真的 disabled");
  assert.match(badgeSource, /changedFiles > 0[\s\S]{0,200}setPendingBranch\(branch\)/, "脏工作区要先记下待确认的目标分支");
  assert.match(badgeSource, /<AlertDialog[\s\S]*?open=\{Boolean\(pendingBranch\)\}/, "脏工作区确认要用 AlertDialog");
  assert.match(badgeSource, /t\("git\.switchDirtyDesc", \{ count: changedFiles, branch: pendingBranch \}\)/, "确认框要说清楚会带上哪些改动");
  assert.match(badgeSource, /onClick=\{\(\) => void runSwitch\(pendingBranch\)\}/, "确认后才真的切");
  assert.match(badgeSource, /const switched = await onSwitchBranch\(branch\)/, "切换结果决定弹层关不关");
});

test("分支行末尾的删除图标：当前分支不显示，点击先弹确认框再删", () => {
  assert.match(
    badgeSource,
    /gitBranchDeleteState\(branch, \{ isStreaming, deletingBranch, isBusy: branchWriteBusy \}\)/,
    "每行删除图标都要算可用状态",
  );
  assert.match(badgeSource, /aria-label=\{t\("git\.deleteBranch"\)\}/, "删除图标要有可访问名");
  assert.match(badgeSource, /<Trash2 className="size-3" aria-hidden="true" \/>/, "删除图标用 Trash2");
  assert.match(badgeSource, /deleteState\.isCurrent \? null :/, "当前分支不渲染删除图标");
  assert.match(badgeSource, /setPendingDelete\(branch\.name\)/, "点删除记下待确认的分支名");
  assert.ok(!/setOpen\(false\);\s*setPendingDelete/.test(badgeSource), "点删除不再先收弹层：确认删分支时 git 面板要留在视野里");
  assert.match(
    badgeSource,
    /if \(!next && pendingDelete\) \{\s*return;/,
    "删除确认框开着时不许让焦点移走把 Popover 自动收起",
  );
  assert.match(
    badgeSource,
    /onFocusOutside=\{\(event\) => \{\s*if \(pendingDelete\) \{\s*event\.preventDefault\(\)/,
    "焦点移进 AlertDialog 时不许收面板",
  );
  assert.match(badgeSource, /<AlertDialog\s*open=\{Boolean\(pendingDelete\)\}/, "删除确认要用 AlertDialog");
  assert.ok(!/\bconfirm\(/.test(badgeSource), "不许用浏览器内置 confirm");
  assert.match(badgeSource, /t\("git\.deleteBranchDesc", \{ branch: pendingDelete \}\)/, "确认框要说清楚删的是哪个分支");
  assert.match(badgeSource, /const deleted = await onDeleteBranch\(branch\)/, "确认后才真的删");
  assert.match(appSource, /onDeleteBranch=\{projectGit\.deleteBranch\}/, "App 要把删除接到 hook");
  assert.match(appSource, /deletingBranch=\{projectGit\.deletingBranch\}/, "删除中的分支名要传给徽标转圈");
  assert.match(hookSource, /postJson<GitInfo>\("\/api\/projects\/git\/delete-branch"/, "删除走服务端路由");
});

test("徽标组件只消费数据：自己不发请求、不碰 git 进程", () => {
  assert.ok(!/child_process|execFile|spawn/.test(badgeSource), "渲染层不能自己执行 git");
  assert.ok(!/fetchJson|postJson|fetch\(/.test(badgeSource), "徽标组件不发请求，数据由 hook 给");
  assert.match(badgeSource, /kind === "hidden"/, "hidden 形态必须 return null（没装 git 时什么都不渲染）");
  assert.match(badgeSource, /t\("git\.init"\)/, "初始化按钮要有 i18n 文案");
});

test("hook 的刷新只由事件驱动，不做轮询", () => {
  assert.match(hookSource, /window\.addEventListener\("focus"/, "窗口重新聚焦时刷新");
  assert.match(hookSource, /wasStreaming\.current && !isStreaming/, "流式结束的那一刻刷新");
  assert.ok(!/setInterval/.test(hookSource), "不许轮询");
  // setTimeout 只允许用来让成功提示自己消失（`GIT_NOTICE_DISMISS_MS`），不能拿它定时刷新。
  assert.ok(!/setTimeout\([^)]*refresh/.test(hookSource), "不许用定时器定时刷新");
  assert.match(hookSource, /GIT_NOTICE_DISMISS_MS/, "唯一的一次性定时器是提示自动消失");
  assert.match(hookSource, /requestSeq/, "并发/切项目的旧响应要丢弃");
  assert.ok(!/child_process|execFile/.test(hookSource), "渲染层不直接跑 git（走服务端 /api/projects/git）");
});

test("服务端提供只读查询 / init / 切分支 / 提交四条路由，路径由项目表解析", () => {
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git"/, "缺少 GET /api/projects/git");
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/init"/, "缺少 POST /api/projects/git/init");
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/switch"/, "缺少 POST /api/projects/git/switch");
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/commit"/, "缺少 POST /api/projects/git/commit");
  // 读：按会话 workspace 读（worktree 会话显示自己的分支/改动），但 cwd 仍从项目表 + 会话解析。
  assert.match(serverSource, /readGitInfo\(requestWorkspaceCwd\(project, \{ sessionPath \}\)\)/, "只读路由应解析出会话 workspace 后读取");
  // init 永远针对主检出：worktree 是主检出的从属检出，主检出没仓库就无从建 worktree。
  assert.match(serverSource, /initGitRepo\(project\.cwd\)/, "init 路由应从项目表取 cwd");
  assert.match(serverSource, /const cwd = requestWorkspaceCwd\(project, body\);\s*await switchGitBranch\(cwd, String\(body\?\.branch \?\? ""\)\)/, "切分支要在会话 workspace 里执行");
  assert.match(serverSource, /commitGitChanges\(cwd, \{ message: body\?\.message, paths: body\?\.paths \}\)/, "提交路由要把信息与路径交给服务端校验");
  assert.match(serverSource, /url\.pathname === "\/api\/projects\/git\/delete-branch"/, "缺少 POST /api/projects/git/delete-branch");
  assert.match(
    serverSource,
    /await deleteGitBranch\(cwd, String\(body\?\.branch \?\? ""\)\)/,
    "删除分支要在会话 workspace 里执行，且目标只从请求体取分支名",
  );
});