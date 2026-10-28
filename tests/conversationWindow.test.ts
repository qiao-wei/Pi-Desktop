import test from "node:test";
import assert from "node:assert/strict";

import {
  CONVERSATION_PAGE_MAX_TURNS,
  CONVERSATION_TAIL_TURNS,
  transcriptPageWindow,
  transcriptTailWindow,
  transcriptTurnWindow,
} from "../server/conversationWindow.mjs";
import { buildChatBubbles } from "../src/shared/chatBubbles.ts";

/** 每轮：一条 user + 两条 assistant（其中一条带工具往返），用来检查"不切开一轮"。 */
function transcriptOf(turns: number) {
  return Array.from({ length: turns }, (_, index) => [
    { role: "user", content: `q${index + 1}`, timestamp: index * 100 },
    { role: "assistant", content: [{ type: "toolCall", id: `call-${index + 1}`, name: "bash", arguments: {} }], timestamp: index * 100 + 10 },
    { role: "toolResult", toolCallId: `call-${index + 1}`, content: [{ type: "text", text: "ok" }], timestamp: index * 100 + 20 },
    { role: "assistant", content: [{ type: "text", text: `a${index + 1}` }], timestamp: index * 100 + 30 },
  ]).flat();
}

test("尾部窗口：只带最后 N 轮，hasMoreBefore 如实回答", () => {
  const transcript = transcriptOf(5);
  const window = transcriptTailWindow(transcript, 2);

  assert.equal(window.totalTurns, 5);
  assert.equal(window.startTurn, 4);
  assert.equal(window.endTurn, 5);
  assert.equal(window.hasMoreBefore, true);
  // 每轮 4 条消息，窗口不切开任何一轮。
  assert.equal(window.messages.length, 8);
  assert.equal(window.messages[0]?.content, "q4");

  const all = transcriptTailWindow(transcript, 5);
  assert.equal(all.hasMoreBefore, false);
  assert.equal(all.startTurn, 1);
  assert.equal(all.messages.length, transcript.length);

  // 会话比窗口还短：整份都发，且别把 startTurn 算成 0 或负数。
  const short = transcriptTailWindow(transcriptOf(2), CONVERSATION_TAIL_TURNS);
  assert.equal(short.startTurn, 1);
  assert.equal(short.hasMoreBefore, false);
});

test("窗口里的气泡编号是绝对的（与服务端 turnOffset 配合）", () => {
  const transcript = transcriptOf(5);
  const full = buildChatBubbles(transcript, { isStreaming: false });
  const window = transcriptTailWindow(transcript, 2);
  const windowed = buildChatBubbles(window.messages, {
    isStreaming: false,
    turnOffset: window.startTurn - 1,
  });

  assert.deepEqual(
    windowed.map((bubble) => bubble.id),
    ["t4#user", "t4#assistant", "t5#user", "t5#assistant"],
  );
  // 同一条消息在整份与窗口里得到同一个 id —— 这是"prepend 不 remount"的前提。
  for (const bubble of windowed) {
    assert.ok(full.some((candidate) => candidate.id === bubble.id), `${bubble.id} 在整份里找不到`);
  }
});

test("翻页：beforeTurn 往前取一页，到第 1 轮为止", () => {
  const transcript = transcriptOf(5);

  const page = transcriptPageWindow(transcript, 4, 2);
  assert.equal(page.startTurn, 2);
  assert.equal(page.endTurn, 3);
  assert.equal(page.hasMoreBefore, true);
  assert.equal(page.messages[0]?.content, "q2");

  const first = transcriptPageWindow(transcript, 3, 2);
  assert.equal(first.startTurn, 1);
  assert.equal(first.endTurn, 2);
  assert.equal(first.hasMoreBefore, false);

  // 已经到顶：空页而不是报错，也不会把 endTurn 算成 0 以外的负数。
  const none = transcriptPageWindow(transcript, 1, 60);
  assert.deepEqual(none.messages, []);
  assert.equal(none.hasMoreBefore, false);
  assert.equal(none.endTurn, 0);
});

test("翻页：单页上限与非法参数都不会变成全量拉取", () => {
  const transcript = transcriptOf(CONVERSATION_PAGE_MAX_TURNS + 10);

  const totalTurns = CONVERSATION_PAGE_MAX_TURNS + 10;
  const clamped = transcriptPageWindow(transcript, 300, 10_000);
  // beforeTurn 超出总轮数 → 夹到最后一轮；limit 夹到单页上限。
  assert.equal(clamped.endTurn, totalTurns);
  assert.equal(clamped.startTurn, totalTurns - CONVERSATION_PAGE_MAX_TURNS + 1);
  assert.equal(clamped.messages.length, CONVERSATION_PAGE_MAX_TURNS * 4);

  // 负数 / NaN / 空串：退回默认页大小，而不是 NaN 或整份。
  for (const limit of [-5, Number.NaN, "", null, undefined]) {
    const page = transcriptPageWindow(transcript, 200, limit);
    assert.ok(page.messages.length > 0, `limit=${String(limit)} 不应得到空页`);
    assert.ok(page.messages.length <= 60 * 4, `limit=${String(limit)} 退回了过多消息`);
  }

  // beforeTurn 超出总轮数：夹到最后一轮，不能越界。
  const beyond = transcriptPageWindow(transcript, 9999, 2);
  assert.equal(beyond.endTurn, transcript.length / 4);
  assert.equal(beyond.hasMoreBefore, true);
});

test("翻页与尾部窗口在边界处不重不漏", () => {
  const transcript = transcriptOf(7);
  const tail = transcriptTailWindow(transcript, 2); // 6..7
  const page = transcriptPageWindow(transcript, tail.startTurn, 2); // 4..5
  const next = transcriptPageWindow(transcript, page.startTurn, 2); // 2..3
  const last = transcriptPageWindow(transcript, next.startTurn, 2); // 1

  assert.deepEqual(
    [last.startTurn, next.startTurn, page.startTurn, tail.startTurn],
    [1, 2, 4, 6],
  );
  // 拼起来正好覆盖 1..7 轮，没有重复轮次。
  const covered = [last, next, page, tail].flatMap((window) =>
    Array.from(new Set(window.messages.filter((message) => message.role === "user").map((message) => message.content))),
  );
  assert.deepEqual(covered, ["q1", "q2", "q3", "q4", "q5", "q6", "q7"]);
  assert.equal(last.hasMoreBefore, false);
});

test("transcriptTurnWindow：早于第一轮的消息不会混进来", () => {
  const withPreamble = [
    { role: "system", content: "sys" },
    ...transcriptOf(2),
  ];
  const window = transcriptTurnWindow(withPreamble, 2, 2);
  assert.equal(window.startTurn, 2);
  assert.equal(window.messages.length, 4);
  assert.equal(window.messages[0]?.content, "q2");
  assert.ok(window.messages.every((message) => message.content !== "sys"));
});