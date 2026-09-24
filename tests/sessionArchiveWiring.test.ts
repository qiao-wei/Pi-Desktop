/**
 * 「删除」改成「归档」+ 设置页新增「归档聊天」的接线。
 *
 * server/index.mjs 与 App.tsx 都不能被测试进程 import（前者 import 即起服务，后者是 .tsx），
 * 这里断言的是接线本身：端点存在且指向归档逻辑、bootstrap 带出归档清单、侧栏的破坏性删除
 * 已经全部换成归档、设置弹窗真的渲染了归档页。SQL 与筛选逻辑另有真跑的单测
 * （sessionArchiveStore.test.ts / archivedChats.test.ts）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const server = read("server/index.mjs");
const hook = read("src/features/chat/usePiDesktopApp.ts");
const app = read("src/app/App.tsx");
const component = read("src/features/settings/ArchivedChatsSettings.tsx");

/** Source of a top-level `function name(...) { ... }`, delimited at the next flush-left brace. */
function topLevelFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return source.slice(start, end);
}

test("bridge exposes archive / bulk-delete endpoints, and bootstrap carries the archived list", () => {
  assert.match(server, /url\.pathname === "\/api\/sessions\/archive"/);
  assert.match(server, /await archiveProjectSession\(/);
  assert.match(server, /url\.pathname === "\/api\/sessions\/delete-archived"/);
  assert.match(server, /await deleteArchivedSessions\(/);
  assert.match(server, /archivedSessions: listArchivedSessions\(\)/);
  // 归档只打标记，文件仍在；侧栏列表由 SQL 层排除归档行（见 sessionArchive.mjs）。
  assert.match(server, /sessionStore\.setArchived\(project\.id, resolvedPath, archived\)/);
  // 归档的是当前会话时必须切走，否则会在一个不可见的会话上继续对话。
  assert.match(server, /if \(archived && isActiveSession\)/);
  assert.match(server, /removeSessionRecord\(project, resolvedPath\)/);
  // 归档会话不能被当成可打开的会话：项目 lastSessionPath 可能还指着它。
  assert.match(server, /sessionStore\.isArchived\(project\.id, requestedSessionPath\)/);
});

test("fresh DB schema declares the archived column", () => {
  assert.match(server, /archived INTEGER NOT NULL DEFAULT 0/);
});

test("hook posts archive/unarchive through one state-mutating path and rethrows failures", () => {
  assert.match(hook, /"\/api\/sessions\/archive", \{ projectId, sessionPath, archived: true \}/);
  assert.match(hook, /"\/api\/sessions\/archive", \{ projectId, sessionPath, archived: false \}/);
  assert.match(hook, /"\/api\/sessions\/delete-archived"/);

  const returned = hook.slice(hook.indexOf("return {"), hook.indexOf("function createMessage("));
  for (const name of ["archiveSession", "unarchiveSession", "deleteArchivedSession", "deleteAllArchivedSessions"]) {
    assert.match(returned, new RegExp(`\\b${name},`), `${name} must be exposed by the hook`);
  }

  // 归档页在设置弹窗里，宿主错误条被模态挡住：失败必须往上抛，页面就地显示。
  const mutate = hook.slice(hook.indexOf("const mutateSessionState"), hook.indexOf("const archiveSession"));
  assert.match(mutate, /throw error;/);
});

test("the sidebar's delete action opens a dialog with archive AND direct delete", () => {
  const row = topLevelFunctionSource(app, "SidebarSessionRow");
  assert.match(row, /onArchive\(session\.title\)/);
  assert.match(row, /t\("sidebar\.archiveSession"\)/);
  assert.doesNotMatch(row, /onDelete\(session\.title\)/);
  assert.doesNotMatch(row, /sidebar\.deleteSession/);

  const sidebar = topLevelFunctionSource(app, "ProjectSidebar");
  assert.match(sidebar, /kind: "archive-session"/);
  assert.doesNotMatch(sidebar, /kind: "delete-session"/);
  // 不走归档的第二个出口：直接删文件。
  assert.match(sidebar, /onDeleteSession\(dialog\.projectId, dialog\.sessionPath\)/);

  assert.match(app, /kind: "archive-session"; projectId: string; sessionPath: string; title: string/);
  // 说明文案按会话是否跑在 worktree 里分岔：worktree 会话要多讲一句「worktree 会被一起删」，
  // 普通会话仍走原文案（实现有意改动，断言跟着更新，不是回归）。
  assert.match(
    app,
    /t\(dialog\.inWorktree \? "dialog\.archiveSessionDescWorktree" : "dialog\.archiveSessionDesc", \{ title: dialog\.title \}\)/,
  );

  const dialogView = topLevelFunctionSource(app, "SidebarDialogView");
  assert.match(dialogView, /t\("dialog\.deleteSessionForever"\)/);
  assert.match(dialogView, /t\("dialog\.archiveAction"\)/);
  assert.match(dialogView, /<AlertDialogCancel>\{t\("common\.cancel"\)\}<\/AlertDialogCancel>/);
});

test("settings gained an Archived chats tab wired to the new page", () => {
  assert.match(app, /<TabsTrigger value="archived"/);
  assert.match(app, /t\("settings\.tab\.archived"\)/);
  assert.match(app, /<TabsContent value="archived">/);
  assert.match(app, /<ArchivedChatsSettings/);
  // 数据从 bootstrap 快照来，动作回调来自 hook。
  assert.match(app, /archivedSessions=\{bootstrap\.archivedSessions \?\? \[\]\}/);
  assert.match(app, /onUnarchiveSession=\{unarchiveSession\}/);
  assert.match(app, /onDeleteArchivedSession=\{deleteArchivedSession\}/);
  assert.match(app, /onDeleteAllArchivedSessions=\{deleteAllArchivedSessions\}/);
});

test("the archived page offers unarchive, per-row delete and delete-all", () => {
  assert.match(component, /groupArchivedSessions\(/);
  assert.match(component, /filterArchivedSessions\(/);
  assert.match(component, /t\("archived\.unarchive"\)/);
  assert.match(component, /t\("archived\.deleteForever"\)/);
  assert.match(component, /t\("archived\.deleteProjectAll"\)/);
  assert.match(component, /onDeleteMany\(\)/);
  // 失败画在弹层里（role=alert），不依赖被模态挡住的全局错误条。
  assert.match(component, /role="alert"/);
});