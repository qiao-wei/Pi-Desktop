/**
 * 托管 worktree 的显示规则与接线（参考 Codex 桌面端）。
 *
 * 分两层：
 * - `src/shared/sessionWorktree.ts` 的纯函数直接跑用例（null / 空字段 / 脏 / 目录消失 /
 *   streaming，以及"删除要不要 force"）；
 * - 生命周期本身在 `gitWorktree.test.ts` 里用临时真仓库验证；这里只断言 React/服务端的
 *   接线没有断（App.tsx 是 .tsx，`node --test` 不能 import，只能按仓库惯例读源码 + 区域锚点）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isWorktreeDirty,
  worktreeBadgeKind,
  worktreeChangeTotals,
  worktreeCreateBranchBlockReason,
  worktreeExists,
  worktreeHeadLabel,
  worktreeRemoveBlockReason,
  worktreeRemoveNeedsForce,
} from "../src/shared/sessionWorktree.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const hookSource = readFileSync(new URL("../src/features/chat/useProjectGit.ts", import.meta.url), "utf8");
const worktreeHookSource = readFileSync(new URL("../src/features/chat/useSessionWorktree.ts", import.meta.url), "utf8");
const badgeSource = readFileSync(new URL("../src/components/SessionWorktreeBadge.tsx", import.meta.url), "utf8");
const appHookSource = readFileSync(new URL("../src/features/chat/usePiDesktopApp.ts", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../src/i18n/zh.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../src/i18n/en.ts", import.meta.url), "utf8");

/** 取 `start 标记` 到 `end 标记` 之间的源码区间，两边锚点都必须唯一。 */
function region(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  assert.ok(start >= 0, `找不到起始锚点: ${startMark}`);
  const end = source.indexOf(endMark, start);
  assert.ok(end > start, `找不到结束锚点: ${endMark}`);
  return source.slice(start, end);
}

function info(patch = {}) {
  return { isWorktree: true, path: "/agent/worktrees/app-1", displayName: "app-1", exists: true, branch: "", detached: true, changes: { changed: 0, untracked: 0, ignored: 0 }, ...patch };
}

test("worktreeBadgeKind：null / 非 worktree 都隐藏，只有真 worktree 才显示", () => {
  assert.equal(worktreeBadgeKind(null), "hidden");
  assert.equal(worktreeBadgeKind(undefined), "hidden");
  assert.equal(worktreeBadgeKind({ isWorktree: false }), "hidden");
  assert.equal(worktreeBadgeKind({ isWorktree: true }), "worktree");
});

test("worktreeChangeTotals / isWorktreeDirty：缺字段按 0，三类任一非零就是脏", () => {
  assert.deepEqual(worktreeChangeTotals(null), { changed: 0, untracked: 0, ignored: 0, total: 0 });
  assert.deepEqual(worktreeChangeTotals({ isWorktree: true }), { changed: 0, untracked: 0, ignored: 0, total: 0 });
  assert.equal(isWorktreeDirty({ isWorktree: true, changes: { changed: 2, untracked: 0, ignored: 1 } }), true);
  assert.equal(isWorktreeDirty(info()), false);
});

test("worktreeExists / worktreeHeadLabel：目录消失是 false；建过分支显示分支名", () => {
  assert.equal(worktreeExists(info()), true);
  assert.equal(worktreeExists(info({ exists: false })), false);
  assert.equal(worktreeExists(null), false);
  assert.equal(worktreeHeadLabel(info(), "游离 HEAD"), "游离 HEAD");
  assert.equal(worktreeHeadLabel(info({ branch: "codex/task" }), "游离 HEAD"), "codex/task");
});

test("worktreeCreateBranchBlockReason：streaming > busy > 目录消失 > 可操作", () => {
  const ok = { isStreaming: false, isBusy: false, info: info() };
  assert.equal(worktreeCreateBranchBlockReason(ok), "ok");
  assert.equal(worktreeCreateBranchBlockReason({ ...ok, isBusy: true }), "busy");
  assert.equal(worktreeCreateBranchBlockReason({ ...ok, isStreaming: true, isBusy: true }), "streaming");
  assert.equal(worktreeCreateBranchBlockReason({ isStreaming: false, isBusy: false, info: info({ exists: false }) }), "missing");
  assert.equal(worktreeCreateBranchBlockReason({ isStreaming: false, isBusy: false, info: null }), "missing");
});

test("worktreeRemoveBlockReason：目录消失不拦（移除就是清残留登记信息的入口）", () => {
  assert.equal(worktreeRemoveBlockReason({ isStreaming: false, isBusy: false }), "ok");
  assert.equal(worktreeRemoveBlockReason({ isStreaming: false, isBusy: true }), "busy");
  assert.equal(worktreeRemoveBlockReason({ isStreaming: true, isBusy: false }), "streaming");
});

test("worktreeRemoveNeedsForce：只有有未提交内容才 force", () => {
  assert.equal(worktreeRemoveNeedsForce(info()), false);
  assert.equal(worktreeRemoveNeedsForce(info({ changes: { changed: 1, untracked: 0, ignored: 0 } })), true);
  assert.equal(worktreeRemoveNeedsForce(info({ changes: { changed: 0, untracked: 0, ignored: 3 } })), true);
  assert.equal(worktreeRemoveNeedsForce(info({ exists: false, changes: { changed: 4, untracked: 0, ignored: 0 } })), true);
});

test("App：git 徽标按会话的 workspace 取，worktree 徽标同时接线", () => {
  assert.match(
    appSource,
    /const projectGit = useProjectGit\(\{\s*projectId: bootstrap\.activeProjectId,\s*sessionPath: visibleSessionPath,/,
    "useProjectGit 必须带上 sessionPath（否则 worktree 会话会显示主检出的分支/改动）",
  );
  assert.match(
    appSource,
    /const sessionWorktree = useSessionWorktree\(\{\s*projectId: bootstrap\.activeProjectId,\s*sessionPath: visibleSessionPath,\s*isStreaming: state\.isStreaming,\s*onError: reportError,\s*onBootstrap: replaceBootstrap,/,
    "useSessionWorktree 要按会话取，并把移除后返回的 bootstrap 交回应用",
  );
  const header = region(appSource, "<SessionWorktreeBadge", "<GitStatusBadge");
  assert.match(header, /onCreateBranch=\{sessionWorktree\.createBranch\}/);
  assert.match(header, /onRemove=\{sessionWorktree\.removeWorktree\}/);
  assert.match(header, /isStreaming=\{state\.isStreaming\}/);
});

test("useProjectGit：读用 sessionPath 查询参数，四个写操作都带 sessionPath", () => {
  assert.match(hookSource, /sessionPath\?: string;/, "选项要声明 sessionPath");
  assert.match(hookSource, /query\.set\("sessionPath", sessionPath\)/, "GET /api/projects/git 要带 sessionPath");
  for (const route of ["switch", "create-branch", "commit"]) {
    const call = region(hookSource, `"/api/projects/git/${route}"`, ");");
    assert.match(call, /projectId, sessionPath,/, `${route} 的请求体要带 sessionPath`);
  }
  const commitMessage = region(hookSource, '"/api/projects/git/commit-message"', "});");
  assert.match(commitMessage, /sessionPath,/, "commit-message 的请求体要带 sessionPath");
});

test("侧栏「＋」：一次点击就是普通新会话，⌥/Alt 点击走 worktree，项目菜单里也有入口", () => {
  const plus = region(appSource, "aria-label={t(\"sidebar.newSession\")}", "<SidebarNewSessionIcon size={16} />");
  // 常规路径不能退化成「先开菜单再选一项」：点一下就要建出普通会话。
  assert.match(
    plus,
    /onClick=\{\(event\) => createSessionFromSidebar\(project\.id, event\.altKey \? \{ worktree: true \} : undefined\)\}/,
    "「＋」要一次点击直接建普通会话，⌥/Alt 点击才走 worktree",
  );
  assert.doesNotMatch(plus, /DropdownMenuTrigger/, "「＋」不再是菜单触发器（那会多一步）");
  assert.match(plus, /title=\{t\("sidebar\.newSessionHint"\)\}/, "tooltip 要说明 ⌥/Alt 的用法");

  // worktree 的发现入口放在项目 ⋯ 菜单里（不占「＋」的点击）。
  const projectMenu = region(appSource, 'aria-label={t("sidebar.projectMenu")}', "</DropdownMenu>");
  assert.match(projectMenu, /createSessionFromSidebar\(project\.id, \{ worktree: true \}\)/, "项目菜单里要有 worktree 入口");

  const fn = region(appSource, "function createSessionFromSidebar", "async function selectSessionFromSidebar");
  assert.match(fn, /onCreateSession\(projectId, undefined, options\)/, "选项要透传给 onCreateSession");

  const create = region(appHookSource, "const createSession = useCallback(", "const updateSession = useCallback(");
  assert.match(create, /worktree: options\?\.worktree \? \{ enabled: true \} : undefined/, "createSession 要把 worktree 开关发给 /api/sessions");
});

test("useSessionWorktree：移除会把服务端返回的 bootstrap 整体替换，建分支只刷新徽标", () => {
  assert.match(worktreeHookSource, /\/api\/sessions\/worktree\?/, "读 worktree 信息");
  assert.match(worktreeHookSource, /"\/api\/sessions\/worktree\/branch"/, "建分支路由");
  assert.match(worktreeHookSource, /"\/api\/sessions\/worktree\/remove"/, "移除路由");
  assert.match(worktreeHookSource, /onBootstrap\?\.\(response\.result\)/, "移除后必须整体替换 bootstrap（会话已退回主检出）");
  assert.match(worktreeHookSource, /force: Boolean\(options\.force\)/, "force 要透传给服务端");
});

test("徽标组件：移除永远先弹确认框，force 由纯函数决定", () => {
  assert.match(badgeSource, /worktreeBadgeKind\(info\) === "hidden"/, "非 worktree 直接不渲染");
  assert.match(badgeSource, /<AlertDialog open=\{isRemoveOpen\}/, "移除要走确认框");
  assert.match(badgeSource, /onRemove\(\{ force: worktreeRemoveNeedsForce\(info\) \}\)/, "force 由共享规则决定");
  assert.match(badgeSource, /worktreeCreateBranchBlockReason\(\{ isStreaming, isBusy: busy, info \}\)/, "建分支按钮的禁用口径走共享规则");
  assert.match(badgeSource, /const removeBlock = worktreeRemoveBlockReason\(\{ isStreaming, isBusy: busy \}\)/, "移除按钮的禁用口径走共享规则");
  assert.match(badgeSource, /const removeDisabled = removeBlock !== "ok"/, "移除是否禁用只看这个规则（不看目录是否存在）");
  assert.match(badgeSource, /disabled=\{removeDisabled\}/, "移除按钮要真的用上这个结果");
  assert.match(badgeSource, /t\("worktree.removeMissingDesc"\)/, "目录已消失时确认框要说清楚只是清登记信息");
});

test("徽标组件：操作按钮的副标题会换行，不溢出弹层", () => {
  // Button 基类带 `whitespace-nowrap`（给单行标签用的）。这里是「图标 + 单行标题 + 一段说明」
  // 的两行式按钮，不覆盖就只能让说明横着冲出弹层（2026-09-23 真机截图发现）。
  const actionButtons = badgeSource.match(/className="h-auto [^"]*flex-col items-start[^"]*"/g) ?? [];
  assert.equal(actionButtons.length, 2, "建分支/移除两个按钮要保持两行式结构");
  for (const button of actionButtons) {
    assert.match(button, /whitespace-normal/, `两行式按钮必须覆盖 whitespace-nowrap：${button}`);
    assert.match(button, /w-full/, "按钮要撑满弹层宽度，否则 flex 子项不收缩");
  }
  const hintSpans = badgeSource.match(/className="w-full text-left text-\[0\.7rem\] leading-snug font-normal text-muted-foreground"/g) ?? [];
  assert.equal(hintSpans.length, 2, "两段说明都要能换行（w-full + leading-snug）");
});

test("服务端接线：worktree 路由 / 会话 cwd / git 写操作都落在会话 workspace 上", () => {
  assert.match(serverSource, /url\.pathname === "\/api\/sessions\/worktree"/, "worktree 信息路由");
  assert.match(serverSource, /url\.pathname === "\/api\/sessions\/worktree\/branch"/, "worktree 建分支路由");
  assert.match(serverSource, /url\.pathname === "\/api\/sessions\/worktree\/remove"/, "worktree 移除路由");
  assert.match(serverSource, /worktreeRequest\?\.enabled \? await createSessionWorktree\(project, worktreeRequest\)/, "新会话按开关建 worktree");
  // 会话文件头里的 cwd 才是会话自己的工作目录，不能再被 cwdOverride 拽回项目目录。
  assert.match(serverSource, /SessionManager\.open\(sessionPath, getProjectSessionDir\(project\)\)/, "打开会话不再传 cwdOverride");
  // 索引里的 cwd 也要走同一判定，否则删掉 worktree 后还会把死路径写回去。
  assert.match(serverSource, /cwd: sessionWorkspaceCwd\(project, sessionManager\)/, "会话索引 cwd 走 workspace 判定");
  // git 的四个写操作必须按会话 workspace 干活（否则会提交到主检出）。
  for (const route of ["switch", "create-branch", "commit"]) {
    const call = region(serverSource, `url.pathname === "/api/projects/git/${route}"`, "return;");
    assert.match(call, /requestWorkspaceCwd\(project, body\)/, `${route} 要在会话 workspace 里执行`);
  }
  // 删会话时顺手回收 worktree；目录已被外部删掉时也要能把登记信息清掉。
  assert.match(serverSource, /scheduleWorktreeCleanup\(project, resolvedPath\)/, "删除会话要回收 worktree");
  const remove = region(serverSource, "async function removeSessionWorktree", "function scheduleWorktreeCleanup");
  assert.ok(
    !/requireSessionWorktreeCwd/.test(remove),
    "移除 worktree 不能用「目录必须存在」的闸：目录被外部删掉时那是唯一的清理入口",
  );
  assert.match(remove, /isManagedWorktreePath\(worktreesRoot, cwd\)/, "移除仍然限定在应用自己的 worktree 里");
});

test("i18n：worktree 文案中英都有（English 包按中文键集类型校验，漏一个就编译不过）", () => {
  const keys = [
    "worktree.badge",
    "worktree.detached",
    "worktree.clean",
    "worktree.changes",
    "worktree.missing",
    "worktree.openFolder",
    "worktree.newBranch",
    "worktree.remove",
    "worktree.removeDirtyTitle",
    "worktree.removeConfirm",
    "worktree.createFailed",
    "sidebar.newSessionInWorktree",
  ];
  for (const key of keys) {
    assert.ok(zhSource.includes(`"${key}"`), `zh 缺 ${key}`);
    assert.ok(enSource.includes(`"${key}"`), `en 缺 ${key}`);
  }
});
test("会话头 cwd 已消失（worktree 被移除）时会话要能重开", () => {
  // pi 的 runtime 会拿 SessionManager.getCwd() 断言目录存在，不存在就抛
  // "Stored session working directory does not exist" —— 移除 worktree 后立刻重开这条会话
  // 就会撞上。createRuntime 必须先发现失效，再用解析出的 workspace 重开一次。
  const create = region(serverSource, "async function createRuntime", "const workspaceCwd =");
  assert.match(create, /!existsSync\(sessionManager\.getCwd\(\)\)/, "先判断会话头 cwd 是否失效");
  assert.match(
    create,
    /sessionManager = SessionManager\.open\(\s*sessionPath,\s*getProjectSessionDir\(project\),\s*sessionWorkspaceCwd\(project, sessionManager\),?\s*\)/,
    "失效时用 workspace（已退回项目目录）重开，拿到一个真实目录",
  );
});
