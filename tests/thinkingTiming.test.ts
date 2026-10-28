import assert from "node:assert/strict";
import test from "node:test";

import {
  carryObservedAnswerTiming,
  carryObservedThinkingTiming,
  hasObservedThinkingTiming,
  observedThinkingSeconds,
} from "../src/shared/thinkingTiming.ts";
import type { MessageProcessBlock } from "../src/types/domain.ts";

const thinking = (
  text: string,
  extra: { streamKey?: string; startedAt?: number; endedAt?: number } = {},
): MessageProcessBlock => ({ kind: "thinking", text, ...extra }) as MessageProcessBlock;

/**
 * 思考块的时长只有「看过它流式的这个客户端」知道（pi 的转录里没有逐块时间戳）。
 * 于是它必须活过两个节点：整轮结束时过程区折叠（行被卸载）、以及快照用转录重建块。
 */
test("两个端点都见过才算一次观测；只有起点不算", () => {
  assert.equal(hasObservedThinkingTiming(thinking("x")), false);
  assert.equal(hasObservedThinkingTiming(thinking("x", { startedAt: 1 })), false, "还在想：没有终点");
  assert.equal(hasObservedThinkingTiming(thinking("x", { endedAt: 9 })), false, "没有起点就没有跨度");
  assert.equal(hasObservedThinkingTiming(thinking("x", { startedAt: 5, endedAt: 4 })), false, "终点早于起点是坏数据");
  assert.equal(hasObservedThinkingTiming(thinking("x", { startedAt: 1, endedAt: 2_000 })), true);
});

test("秒数下限 1 秒，不显示 0 秒", () => {
  assert.equal(observedThinkingSeconds(thinking("x", { startedAt: 0, endedAt: 120 })), 1);
  assert.equal(observedThinkingSeconds(thinking("x", { startedAt: 0, endedAt: 4_400 })), 4);
  assert.equal(observedThinkingSeconds(thinking("x", { startedAt: 0, endedAt: 4_600 })), 5);
  assert.equal(observedThinkingSeconds(thinking("x")), undefined);
});

test("快照重建块时把观测搬过去（按 streamKey 认同一块思考）", () => {
  const observed = thinking("想了很久", { streamKey: "k1", startedAt: 1_000, endedAt: 5_000 });
  const rebuilt = thinking("想了很久", { streamKey: "k1" });
  const carried = carryObservedThinkingTiming([observed], [rebuilt]);
  assert.deepEqual(carried, [thinking("想了很久", { streamKey: "k1", startedAt: 1_000, endedAt: 5_000 })]);
  assert.notEqual(carried?.[0], rebuilt, "搬过来的是新对象（快照那份不许被就地改）");
});

test("没有 streamKey 时按正文认（老转录可能没有 key）", () => {
  const carried = carryObservedThinkingTiming(
    [thinking("同一段思考", { startedAt: 1_000, endedAt: 3_000 })],
    [thinking("同一段思考")],
  );
  assert.deepEqual(carried, [thinking("同一段思考", { startedAt: 1_000, endedAt: 3_000 })]);
});

test("认不出来就原样返回同一个数组（快照对账不能被无谓地写坏）", () => {
  const incoming = [thinking("另一段", { streamKey: "k2" })];
  assert.equal(carryObservedThinkingTiming([thinking("想了很久", { streamKey: "k1", startedAt: 1, endedAt: 2 })], incoming), incoming);
  assert.equal(carryObservedThinkingTiming(undefined, incoming), incoming);
  assert.equal(carryObservedThinkingTiming([thinking("x", { startedAt: 1, endedAt: 2 })], undefined), undefined);
});

test("已经带观测的块不被覆盖，非 thinking 块不参与", () => {
  const own = thinking("想了", { streamKey: "k1", startedAt: 10, endedAt: 20 });
  assert.equal(carryObservedThinkingTiming([thinking("想了", { streamKey: "k1", startedAt: 1, endedAt: 2 })], [own])?.[0], own);

  const tool = { kind: "tool", toolCallId: "t", toolName: "bash", callText: "{}", text: "" } as unknown as MessageProcessBlock;
  const incoming = [tool];
  assert.equal(carryObservedThinkingTiming([thinking("想了", { startedAt: 1, endedAt: 2 })], incoming), incoming);
});
/**
 * 快照重建整条回答时，两件只有本客户端知道的事实必须跟过去：每块思考的时长、
 * 以及这一轮的总时长。少一个，用户就会看到「思考 · 持续了几秒」或者无时长的表头。
 */
test("重建回答时把思考时长和整轮时长一起搬过去", () => {
  const local = {
    id: "t1#assistant",
    role: "assistant",
    kind: "text",
    content: "",
    createdAt: 1_000,
    status: "done",
    turnDurationMs: 5_000,
    liveBlocks: [{ kind: "thinking", text: "想了", streamKey: "k1", open: false, startedAt: 1_000, endedAt: 3_000 }],
  } as unknown as ChatMessage;
  const incoming = {
    id: "t1#assistant",
    role: "assistant",
    kind: "text",
    content: "答",
    createdAt: 1_000,
    status: "done",
    processBlocks: [{ kind: "thinking", text: "想了", streamKey: "k1" }],
  } as unknown as ChatMessage;

  const carried = carryObservedAnswerTiming(incoming, local);
  assert.equal(carried.turnDurationMs, 5_000);
  assert.deepEqual(carried.processBlocks?.[0], {
    kind: "thinking",
    text: "想了",
    streamKey: "k1",
    startedAt: 1_000,
    endedAt: 3_000,
  });
  assert.equal(carried.content, "答", "正文仍然以快照为准");
});

test("没什么可搬时原样返回同一个对象（不让对账白写）", () => {
  const incoming = {
    id: "t1#assistant",
    role: "assistant",
    kind: "text",
    content: "答",
    createdAt: 1_000,
    status: "done",
    turnDurationMs: 5_000,
    processBlocks: [{ kind: "thinking", text: "想了", startedAt: 1_000, endedAt: 3_000 }],
  } as unknown as ChatMessage;
  const local = { ...incoming, turnDurationMs: undefined } as unknown as ChatMessage;
  assert.equal(carryObservedAnswerTiming(incoming, local), incoming);
});
