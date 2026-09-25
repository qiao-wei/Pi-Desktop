/**
 * Edit-and-resend wiring.
 *
 * The load-bearing claim of this feature is that an edited (rolled-back) turn
 * keeps contributing to the usage panel. That only holds while two things stay
 * true: the edit rewinds pi's *branch* (append-only, nothing deleted) and the
 * usage numbers keep aggregating over *all* entries rather than the visible
 * branch. Both are asserted here, alongside the UI wiring.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const chatThread = readFileSync(new URL("../src/features/chat/ChatThread.tsx", import.meta.url), "utf8");
const editBox = readFileSync(new URL("../src/features/chat/MessageEditBox.tsx", import.meta.url), "utf8");
const thread = readFileSync(new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const useApp = readFileSync(new URL("../src/features/chat/usePiDesktopApp.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const zh = readFileSync(new URL("../src/i18n/zh.ts", import.meta.url), "utf8");
const en = readFileSync(new URL("../src/i18n/en.ts", import.meta.url), "utf8");

/** Extract a named `function`/`async function` body by brace counting. */
function functionBody(source: string, name: string): string {
  const declaration = source.indexOf(`function ${name}`);
  assert.notEqual(declaration, -1, `function ${name} not found`);
  const openParen = source.indexOf("(", declaration);
  let parenDepth = 0;
  let cursor = openParen;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") parenDepth += 1;
    if (source[cursor] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const openBrace = source.indexOf("{", cursor);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace, index + 1);
      }
    }
  }
  assert.fail(`function ${name} body never closes`);
}

/**
 * Extract a `const name = useCallback(...)` body by brace counting. `functionBody`
 * only understands declarations, and the hook builds its callbacks as consts.
 */
function callbackBody(source: string, name: string): string {
  const declaration = source.indexOf(`const ${name} = useCallback(`);
  assert.notEqual(declaration, -1, `callback ${name} not found`);
  const arrow = source.indexOf("=> {", declaration);
  assert.notEqual(arrow, -1, `callback ${name} has no block body`);
  const openBrace = arrow + 3;
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace, index + 1);
      }
    }
  }
  assert.fail(`callback ${name} body never closes`);
}

/** Body of one `url.pathname === "<path>"` route, up to the shared 404 tail. */
function routeBody(path: string): string {
  const marker = `url.pathname === "${path}"`;
  const start = server.indexOf(marker);
  assert.notEqual(start, -1, `route ${path} not found`);
  const end = server.indexOf("sendJson(res, 404", start);
  assert.notEqual(end, -1, `route ${path} tail not found`);
  return server.slice(start, end);
}

test("edit route rewinds the branch before prompting", () => {
  const route = routeBody("/api/messages/edit");
  assert.match(route, /parseChatBubbleId/);
  assert.match(route, /ref\.role !== "user"/);
  assert.match(route, /rewindTurn: ref\.turn/);
});

test("rewindSessionToTurn is branch-based, append-only and summarise-free", () => {
  const body = functionBody(server, "rewindSessionToTurn");
  assert.match(body, /session\.isStreaming/, "must refuse while streaming");
  assert.match(body, /manager\.getBranch\(\)/, "must walk the visible branch");
  assert.match(body, /userMessageEntryIdForTurn\(entries, turn\)/);
  assert.match(body, /navigateTree\(targetEntryId, \{ summarize: false \}\)/, "must not summarise the abandoned branch");
  assert.doesNotMatch(body, /getEntries\(\)\s*\.\s*(splice|pop|shift)/, "must never delete entries");
});

test("the rewound transcript is pushed before the new prompt streams", () => {
  const body = functionBody(server, "streamPrompt");
  const snapshotIndex = body.indexOf('type: "snapshot"');
  const promptIndex = body.indexOf("await activeSession.prompt(");
  assert.notEqual(snapshotIndex, -1, "rewind must emit a snapshot");
  assert.ok(snapshotIndex < promptIndex, "snapshot must precede the new prompt");
  assert.match(body, /options\.rewindTurn/, "snapshot must be gated on the edit path");
});

test("the rewind snapshot reports the edited session as streaming (composer stop button)", () => {
  // `prompt()` has not run yet when the rewind snapshot is built, so
  // `session.isStreaming` is still false. Without `assumeStreaming` the client
  // recomputed `isStreaming` from the snapshot and the stop button vanished for
  // the whole edited run.
  const prompt = functionBody(server, "streamPrompt");
  assert.match(prompt, /buildSnapshot\(activeRuntime, \{ assumeStreaming: true \}\)/);

  const snapshot = functionBody(server, "buildSnapshot");
  assert.match(snapshot, /liveStreamingSessionPaths\(targetRuntime, options\)/);
  assert.match(snapshot, /!sessionIsStreaming\(targetRuntime, options\)/);

  const streaming = functionBody(server, "liveStreamingSessionPaths");
  assert.match(streaming, /options\.assumeStreaming === true/);
  assert.match(streaming, /paths\.add\(targetRuntime\.session\.sessionFile\)/);
  const isStreaming = functionBody(server, "sessionIsStreaming");
  assert.match(isStreaming, /targetRuntime\.session\.isStreaming \|\| options\.assumeStreaming === true/);

  // The flag is the edit path's alone: the end-of-run snapshot must not claim a
  // session is still busy after `prompt()` resolved.
  assert.equal(
    server.match(/assumeStreaming: true/g)?.length,
    1,
    "only the rewind snapshot may assume a starting run",
  );
});

test("usage totals aggregate every entry, not just the current branch", () => {
  const body = functionBody(server, "usageFields");
  assert.match(body, /sessionManager\.getEntries\(\)/, "cumulative totals come from all entries");
  assert.doesNotMatch(body, /getBranch\(\)/, "usage must not shrink when a branch is abandoned");
});

test("kept attachments are reused from disk instead of re-uploaded", () => {
  const body = functionBody(server, "persistPromptAttachments");
  assert.match(body, /sourcePath/);
  assert.match(body, /projectAttachmentRoot/);
  assert.match(body, /reusablePath/);
});

test("client submitEdit posts to the edit endpoint", () => {
  assert.match(useApp, /"\/api\/messages\/edit"/);
  assert.match(useApp, /const submitEdit = useCallback/);
  assert.match(useApp, /submitTurn,\n\s*submitEdit,/, "hook must expose submitEdit");
});

test("ChatThread swaps the user bubble for the editor only while editing", () => {
  assert.match(chatThread, /<MessageEditBox/);
  assert.match(chatThread, /edit\.editingMessageId !== messageId/);
  assert.match(chatThread, /UserMessageActionsProvider/);
  assert.match(chatThread, /onStartEditMessage/);
  assert.match(chatThread, /ChatThreadEditContext\.Provider/);
});

test("App owns the edit state and clears it on session switch", () => {
  assert.match(app, /const \[editingMessageId, setEditingMessageId\] = useState/);
  assert.match(app, /editingMessageId=\{editingMessageId\}/);
  assert.match(app, /onSubmitEditMessage=\{submitEditMessage\}/);
  const effect = app.slice(app.indexOf("setEditingMessageId(null);\n    setFailedEditText(null);\n    setPendingTurnAction(null);"));
  assert.match(effect.slice(0, 120), /visibleSessionPath/);
});

test("editor keeps the composer surface: slash skills, paste sanitising, files, drag & drop", () => {
  assert.match(editBox, /matchSlashTrigger/);
  assert.match(editBox, /htmlToSanitizedMarkup/);
  assert.match(editBox, /renamePastedImage/);
  // 拖放仍归这个编辑框处理，但入口换成 `shared/composerDrop` 的决策：直接把
  // `dataTransfer.files` 交给 addFiles 会让拖进来的文件夹变成零长附件，提交时 FileReader 报错。
  // （行为级覆盖在 tests/composerDrop.test.ts，接线守卫在 tests/dragDropGuard.test.ts。）
  assert.match(editBox, /collectDroppedItems\(event\.dataTransfer/);
  assert.doesNotMatch(editBox, /addFiles\(event\.dataTransfer\.files\)/);
  assert.match(editBox, /className="composer-editor message-edit-editor"/);
  assert.match(editBox, /capability-badge/);
  // No run-configuration controls in edit mode.
  assert.doesNotMatch(editBox, /ThinkingLevelSelect|ComposerModelSelect/);
});

test("the user bubble footer carries time, copy and edit, hidden until hover", () => {
  const start = thread.indexOf("const UserMessageFooter");
  assert.notEqual(start, -1, "UserMessageFooter not found");
  const footer = thread.slice(start, thread.indexOf("function formatMessageTime", start));
  assert.match(footer, /formatMessageTime/);
  // 复制按钮改为自己写富文本：正文走 writeClipboardRichText，badge 走 HTML。
  assert.match(footer, /onClick=\{copyMessage\}/);
  assert.match(footer, /userMessageClipboardHtml\(parts, attachments\)/);
  assert.match(thread, /writeClipboardRichText\(plainText, html\)/);
  assert.match(footer, /onEditMessage\(messageId\)/);
  const classes = footer.slice(0, footer.indexOf("</time>"));
  assert.match(classes, /opacity-0/);
  assert.match(classes, /group-hover:opacity-100/);
});

test("usage popover marks the token/cost rows as cumulative", () => {
  assert.match(app, /usage\.cumulativeHint/);
  assert.match(styles, /\.message-edit-surface \.capability-picker\.slash-menu/);
});

test("delete is intentionally absent: no endpoint and no footer action", () => {
  assert.doesNotMatch(server, /messages\/delete/, "no delete route");
  assert.doesNotMatch(useApp, /deleteTurn/, "no deleteTurn callback");
  assert.doesNotMatch(thread, /onDeleteMessage|aui-user-action-delete/, "no delete button");
  assert.doesNotMatch(app, /onDeleteMessage|deleteTurn/, "App must not wire delete");
});

test("a middle turn still goes through the truncate confirm before editing", () => {
  assert.match(app, /const \[pendingTurnAction, setPendingTurnAction\] = useState/);
  assert.match(app, /action\.messageId !== lastUserMessageId/);
  assert.match(app, /const confirmTurnAction = useCallback/);
  assert.match(app, /message\.truncateEditTitle/);
  assert.match(app, /message\.truncateEditDesc/);
});

test("regenerate is wired through assistant-ui's Reload with the parent user bubble", () => {
  // assistant-ui calls `onReload(parentId, config)`; `parentId` is the id of the
  // message *before* the assistant one, i.e. our `tN#user` bubble.
  assert.match(chatThread, /onReloadMessage\?: \(parentMessageId: string\)/);
  assert.match(chatThread, /\(parentId: string \| null\)/);
  assert.match(chatThread, /onReloadMessage\(parentId\)/);
  assert.match(chatThread, /\.\.\.\(onReloadMessage \? \{ onReload \} : \{\}\)/);
  assert.match(app, /onReloadMessage=\{refreshMessage\}/);
  assert.match(thread, /ActionBarPrimitive\.Reload/);
});

test("the assistant action bar is localised, refresh included", () => {
  assert.match(thread, /tooltip=\{t\("message\.copy"\)\}/);
  assert.match(thread, /tooltip=\{t\("message\.refresh"\)\}/);
  assert.match(thread, /tooltip=\{t\("message\.more"\)\}/);
  assert.doesNotMatch(thread, /tooltip="(Copy|Refresh|More)"/, "no hardcoded English tooltips");
});

test("regenerate re-sends the original user turn without re-uploading attachments", () => {
  assert.match(app, /const runRefresh = useCallback/);
  assert.match(app, /toAttachmentInputs\(userMessage\.attachments \?\? \[\], \(\) => undefined\)/);
  assert.match(app, /submitEdit\(\s*userMessage\.id,\s*userMessage\.content,/);
  // The content comes from the bubble, not from a fresh editor payload.
  assert.doesNotMatch(app, /runRefresh[\s\S]{0,400}?MessageEditPayload/);
});

test("regenerate on a middle turn confirms the truncation like edit does", () => {
  assert.match(app, /kind: "edit" \| "refresh"/);
  assert.match(app, /requestTurnAction\(\{ kind: "refresh", messageId: userMessage\.id \}\)/);
  assert.match(app, /message\.truncateRefreshTitle/);
  assert.match(app, /message\.truncateRefreshDesc/);
  assert.match(app, /message\.truncateRefreshConfirm/);
});

test("编辑框的按钮是发送，不是更新", () => {
  assert.match(editBox, /t\("message\.editSend"\)/);
  assert.match(editBox, /t\("message\.editSending"\)/);
  assert.doesNotMatch(editBox, /message\.editSave/);
  assert.match(zh, /"message\.editSend": "发送"/);
  assert.match(en, /"message\.editSend": "Send"/);
});

test("点发送的交互和 composer 提交一致：立刻关框、滚到底、不等着流结束", () => {
  const body = callbackBody(app, "submitEditMessage");
  const closeIndex = body.indexOf("setEditingMessageId(null)");
  const awaitIndex = body.indexOf("await submitEdit(");
  assert.notEqual(closeIndex, -1, "must close the editor");
  assert.notEqual(awaitIndex, -1, "must still send");
  assert.ok(closeIndex < awaitIndex, "关闭编辑框必须发生在 await 之前（否则编辑框会挂在流式对话上）");
  assert.match(body, /followLatestScroll\(visibleSessionPath\)/);
  assert.match(body, /setFailedEditText/);
  assert.match(body, /composer\.error\.submitFailed/);
});

test("编辑重发在发请求前就把该轮换成乐观占位，失败则回滚", () => {
  const body = callbackBody(useApp, "submitEdit");
  const placeIndex = body.indexOf("placeOptimisticEditTurn(");
  const streamIndex = body.indexOf('"/api/messages/edit"');
  assert.notEqual(placeIndex, -1, "编辑必须先放占位");
  assert.ok(placeIndex < streamIndex, "占位要早于请求，才会和 composer 一样即时");
  assert.match(body, /rollbackOptimisticTurn\(sessionPath, clientMessageId\)/);
  const helper = functionBody(useApp, "placeOptimisticEditTurn");
  assert.match(helper, /replaceTurnWithProvisional\(/);
  assert.match(helper, /bubbleTurnOf\(options\.targetMessageId\)/);
});

test("发送失败后重新打开的编辑框保留用户打的字", () => {
  assert.match(app, /failedEditText\?\.messageId === editingMessageId \? failedEditText\.text : null/);
  assert.match(chatThread, /draftText=\{edit\.draftText\}/);
  const body = functionBody(editBox, "MessageEditBox");
  assert.match(body, /draftText/);
  assert.match(editBox, /draftText == null/);
});
