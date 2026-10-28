import test from "node:test";
import assert from "node:assert/strict";

import { mergeStreamingBootstrap, prependOlderMessages } from "../src/features/chat/bootstrapPatch.ts";
import { buildChatBubbles } from "../src/shared/chatBubbles.ts";

/**
 * 快照现在只带**尾部窗口**，所以这条链路上有三个容易搞反的地方：
 *
 * 1. 翻页 prepend 的是绝对编号的气泡，不能重排、不能重复；
 * 2. 收到窗口快照时，窗口之前的气泡是"没发"，不是"删了"；
 * 3. 窗口**内部**消失的气泡仍然要跟着快照走（编辑/回退会改写尾部）。
 *
 * 这些用例刻意走公开函数（`prependOlderMessages` / `mergeStreamingBootstrap`），
 * 而不是模拟 reducer——reducer 只是这两条规则的调用方。
 */

function transcriptOf(turns: number) {
  return Array.from({ length: turns }, (_, index) => [
    { role: "user", content: `q${index + 1}`, timestamp: index * 100 },
    { role: "assistant", content: [{ type: "text", text: `a${index + 1}` }], timestamp: index * 100 + 1 },
  ]).flat();
}

function bootstrapOf(bubbles: ReturnType<typeof buildChatBubbles>, extra: Record<string, unknown> = {}) {
  return {
    activeSessionPath: "/tmp/session.jsonl",
    pendingQueues: { steering: [], followUp: [] },
    snapshot: {
      conversation: {
        sessionFile: "/tmp/session.jsonl",
        messages: bubbles,
        ...extra,
      },
    },
  } as never;
}

function conversationOf(bootstrap: unknown) {
  return (bootstrap as { snapshot: { conversation: { messages: { id: string }[]; oldestTurn?: number; hasMoreBefore?: boolean } } })
    .snapshot.conversation;
}

test("prependOlderMessages：更早的一页接在前面，绝对编号不变", () => {
  const transcript = transcriptOf(6);
  // 客户端手里是 5..6 轮的窗口。
  const windowed = buildChatBubbles(transcript.slice(8), { isStreaming: false, turnOffset: 4 });
  const bootstrap = bootstrapOf(windowed, { oldestTurn: 5, hasMoreBefore: true, totalTurns: 6 });

  // 服务端返回 3..4 轮这一页。
  const page = buildChatBubbles(transcript.slice(4, 8), { isStreaming: false, turnOffset: 2 });
  const next = prependOlderMessages(bootstrap, { messages: page, oldestTurn: 3, hasMoreBefore: true });

  assert.deepEqual(
    conversationOf(next).messages.map((bubble) => bubble.id),
    ["t3#user", "t3#assistant", "t4#user", "t4#assistant", "t5#user", "t5#assistant", "t6#user", "t6#assistant"],
  );
  assert.equal(conversationOf(next).oldestTurn, 3);
  assert.equal(conversationOf(next).hasMoreBefore, true);

  // 原对象不被就地修改（reducer 依赖结构共享）。
  assert.equal(conversationOf(bootstrap).messages.length, 4);
  assert.equal(conversationOf(bootstrap).oldestTurn, 5);
});

test("prependOlderMessages：重复 id 去重，且没有新内容时返回原对象", () => {
  const transcript = transcriptOf(4);
  const windowed = buildChatBubbles(transcript.slice(4), { isStreaming: false, turnOffset: 2 });
  const bootstrap = bootstrapOf(windowed, { oldestTurn: 3, hasMoreBefore: true, totalTurns: 4 });

  // 这一页与已有窗口重叠（3..4 轮已经在了）——不能重复插入。
  const overlapping = buildChatBubbles(transcript.slice(2), { isStreaming: false, turnOffset: 1 });
  const next = prependOlderMessages(bootstrap, { messages: overlapping, oldestTurn: 2, hasMoreBefore: false });

  assert.deepEqual(
    conversationOf(next).messages.map((bubble) => bubble.id),
    ["t2#user", "t2#assistant", "t3#user", "t3#assistant", "t4#user", "t4#assistant"],
  );
  assert.equal(conversationOf(next).oldestTurn, 2);
  assert.equal(conversationOf(next).hasMoreBefore, false);

  // 同一页再来一次：没有变化就必须返回同一个对象，避免无谓的重渲染。
  const again = prependOlderMessages(next, { messages: overlapping, oldestTurn: 2, hasMoreBefore: false });
  assert.equal(again, next);
});

test("mergeStreamingBootstrap：窗口快照不会删掉已经翻出来的旧历史", () => {
  const transcript = transcriptOf(6);
  const local = bootstrapOf(buildChatBubbles(transcript, { isStreaming: false }), {
    oldestTurn: 1,
    hasMoreBefore: false,
    totalTurns: 6,
  });

  // 服务端这次只发 5..6 轮。
  const windowed = bootstrapOf(buildChatBubbles(transcript.slice(8), { isStreaming: false, turnOffset: 4 }), {
    oldestTurn: 5,
    hasMoreBefore: true,
    totalTurns: 6,
  });
  const merged = mergeStreamingBootstrap(local, windowed, "/tmp/session.jsonl");

  assert.deepEqual(
    conversationOf(merged).messages.map((bubble) => bubble.id),
    ["t1#user", "t1#assistant", "t2#user", "t2#assistant", "t3#user", "t3#assistant", "t4#user", "t4#assistant", "t5#user", "t5#assistant", "t6#user", "t6#assistant"],
  );
  // 窗口信息跟着快照走，下一次翻页仍然知道从哪儿往前取。
  assert.equal(conversationOf(merged).oldestTurn, 5);
  assert.equal(conversationOf(merged).hasMoreBefore, true);
});

test("mergeStreamingBootstrap：窗口内被改写/删除的气泡仍然以快照为准", () => {
  const transcript = transcriptOf(4);
  const withStaleTail = buildChatBubbles(transcript, { isStreaming: false });
  const local = bootstrapOf(withStaleTail, { oldestTurn: 1, hasMoreBefore: false, totalTurns: 4 });

  // 第 4 轮被回退掉了：快照窗口只到第 3 轮。
  const windowed = bootstrapOf(buildChatBubbles(transcript.slice(0, 6), { isStreaming: false }), {
    oldestTurn: 1,
    hasMoreBefore: false,
    totalTurns: 3,
  });
  const merged = mergeStreamingBootstrap(local, windowed, "/tmp/session.jsonl");

  assert.deepEqual(
    conversationOf(merged).messages.map((bubble) => bubble.id),
    ["t1#user", "t1#assistant", "t2#user", "t2#assistant", "t3#user", "t3#assistant"],
  );
});

test("mergeStreamingBootstrap：不是当前会话的快照原样返回", () => {
  const local = bootstrapOf(buildChatBubbles(transcriptOf(2), { isStreaming: false }));
  const other = bootstrapOf(buildChatBubbles(transcriptOf(1), { isStreaming: false }));
  const merged = mergeStreamingBootstrap(local, other, "/tmp/another-session.jsonl");
  assert.equal(merged, other);
});