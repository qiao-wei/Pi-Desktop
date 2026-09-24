import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  queuedComposerEntriesFromBubbles,
  selectRestorableQueuedEntries,
} from "../src/features/chat/queuedComposerText.ts";
import type { ChatMessage } from "../src/types/domain.ts";

const ROOT = join(import.meta.dirname, "..");

function userBubble(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "prov:user:t2:x",
    role: "user",
    kind: "text",
    content: "看下这个",
    createdAt: 0,
    provisional: true,
    queued: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// queuedComposerEntriesFromBubbles：本地排队气泡 → 退回条目
// ---------------------------------------------------------------------------

test("queuedComposerEntriesFromBubbles：只取 provisional + queued 的用户气泡，保留 parts/附件", () => {
  const parts = [
    { kind: "text" as const, text: "看下这张图 " },
    { kind: "attachment" as const, attachmentId: "a1" },
  ];
  const attachments = [
    { id: "a1", name: "shot.png", mimeType: "image/png", size: 100, kind: "image" as const },
  ];
  const bubbles: ChatMessage[] = [
    userBubble({ id: "confirmed", provisional: false, queued: false, content: "已确认" }),
    userBubble({ id: "run", provisional: true, queued: false, clientMessageId: "run" }),
    userBubble({ id: "queued", content: "看下这张图", contentParts: parts, attachments }),
    userBubble({ role: "assistant", content: "回答" }),
  ];

  const entries = queuedComposerEntriesFromBubbles(bubbles);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "看下这张图");
  assert.deepEqual(entries[0].parts, parts);
  assert.deepEqual(entries[0].attachments, attachments);
});

test("queuedComposerEntriesFromBubbles：没有排队气泡时返回空数组", () => {
  assert.deepEqual(queuedComposerEntriesFromBubbles([]), []);
  assert.deepEqual(queuedComposerEntriesFromBubbles([userBubble({ queued: false })]), []);
});

// ---------------------------------------------------------------------------
// selectRestorableQueuedEntries：本地 parts 优先，服务端原文兜底
// ---------------------------------------------------------------------------

test("selectRestorableQueuedEntries：服务端队列为空时什么都不退回", () => {
  assert.deepEqual(
    selectRestorableQueuedEntries([{ text: "本地插话" }], { steering: [], followUp: [] }),
    [],
  );
  assert.deepEqual(
    selectRestorableQueuedEntries([{ text: "本地插话" }], { steering: ["   "], followUp: [""] }),
    [],
  );
});

test("selectRestorableQueuedEntries：本地条数够时取尾部（最老的已被消费，不再插回）", () => {
  const local = [{ text: "第一条" }, { text: "第二条" }, { text: "第三条" }];
  const selected = selectRestorableQueuedEntries(local, { steering: ["a", "b"], followUp: [] });
  assert.deepEqual(selected, [{ text: "第二条" }, { text: "第三条" }]);
});

test("selectRestorableQueuedEntries：本地条数与服务端一致时原样退回（徽标 parts 不丢）", () => {
  const local = [{ text: "带徽标", parts: [{ kind: "capability" as const, capability: { id: "s", kind: "skill" as const, name: "skill", description: "" } }] }];
  const selected = selectRestorableQueuedEntries(local, { steering: ["x"], followUp: [] });
  assert.deepEqual(selected, local);
});

test("selectRestorableQueuedEntries：本地比服务端少时，缺的按原文补成纯文本（steering 在前）", () => {
  const local = [{ text: "本地插话" }];
  const selected = selectRestorableQueuedEntries(local, {
    steering: ["别的客户端 1", "别的客户端 2"],
    followUp: ["别的客户端 3"],
  });
  assert.deepEqual(selected, [
    { text: "别的客户端 1", parts: [] },
    { text: "别的客户端 2", parts: [] },
    { text: "本地插话" },
  ]);
});

// ---------------------------------------------------------------------------
// 接线（窄断言，限定在目标函数/区域内，避免全文件级结构性断言的假绿）
// ---------------------------------------------------------------------------

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `找不到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, `找不到结束标记：${endMarker}`);
  return source.slice(start, end);
}

test("usePiDesktopApp.stopTurn：停止前抓本地排队气泡，响应一到连 parts 一起交给回调", () => {
  const source = readFileSync(join(ROOT, "src/features/chat/usePiDesktopApp.ts"), "utf8");
  const stopTurnBody = sliceBetween(source, "async function stopTurn(", "输入框旁切换模型");
  assert.match(stopTurnBody, /onClearedQueue\?: \(cleared: ClearedComposerQueue\) => void/);
  assert.match(stopTurnBody, /queuedComposerEntriesFromBubbles\(currentBubbles\(sessionPath\) \?\? \[\]\)/);
  assert.match(
    stopTurnBody,
    /onClearedQueue\?\.\(\{\s*steering: next\.clearedQueue\?\.steering \?\? \[\],\s*followUp: next\.clearedQueue\?\.followUp \?\? \[\],\s*entries: queuedEntries,\s*\}\);/,
  );
});

test("App：停止后按本地 parts 重建徽标退回输入框，最后才退化成原文", () => {
  const source = readFileSync(join(ROOT, "src/app/App.tsx"), "utf8");

  // 停止按钮区域（限定在 stop-button 附近）必须用 handleStopTurn
  const buttonRegion = sliceBetween(source, 'className="icon-button stop-button"', "send-button");
  assert.match(buttonRegion, /onClick=\{\(\) => void handleStopTurn\(\)\}/);

  const restoreBody = sliceBetween(source, "function restoreQueuedComposerMessages", "function appendQueuedComposerEntry");
  assert.match(restoreBody, /selectRestorableQueuedEntries\(cleared\.entries \?\? \[\], cleared\)/);
  assert.match(restoreBody, /appendQueuedComposerEntry\(fragment, entry\)/);
  assert.match(restoreBody, /isComposerEmpty\(editor\)\) \{[\s\S]*?\n\s*fragment\.appendChild\(document\.createTextNode\("\\n\\n"\)\);/);

  // 徽标必须用真的 composer 徽标节点重建，而不是把名字当文本贴回去
  const appendBody = sliceBetween(source, "function appendQueuedComposerEntry", "async function handleStopTurn");
  assert.match(appendBody, /createAttachmentBadgeNode\(composerAttachment\)/);
  assert.match(appendBody, /createCapabilityBadgeNode\(capability\)/);
  assert.match(appendBody, /composerAttachmentMapRef\.current\.set/);
  assert.match(appendBody, /composerCapabilityMapRef\.current\.set/);

  const handleBody = sliceBetween(source, "async function handleStopTurn", "function insertAttachmentsAtCursor");
  assert.match(handleBody, /stopTurn\(\(cleared\) => restoreQueuedComposerMessages\(cleared\)\)/);
});

test("服务端契约：/api/stop 的 stopSession 必须把 clearQueue() 取出的原文放进响应", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");
  const stopSessionBody = sliceBetween(
    source,
    "async function stopSession(targetRuntime, options = {})",
    "async function abortSession(session, { requestId, reason })",
  );
  assert.match(stopSessionBody, /activeSession\.clearQueue\(\)/);
  assert.match(stopSessionBody, /clearedQueue,/);
});