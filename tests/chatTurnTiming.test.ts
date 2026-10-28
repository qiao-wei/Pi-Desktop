import assert from "node:assert/strict";
import test from "node:test";

import {
  observedTurnDuration,
  settleStreamingAnswer,
  turnDurationOf,
  turnDurationSeconds,
} from "../src/shared/chatTurnTiming.ts";

/* -------------------------------------------------------------------------- */
/* 时长来源：转录自己的时间戳                                                  */
/* -------------------------------------------------------------------------- */

test("一轮的时长 = 首条条目到末条条目（提示 → 最后一次工具结果/回答）", () => {
  const started = Date.parse("2026-10-27T10:00:00.000Z");
  assert.equal(
    turnDurationOf([
      { timestamp: started },
      { timestamp: started + 3_000 },
      { timestamp: started + 58_000 },
    ]),
    58_000,
    "取最早的入口和最晚的出口，不是相邻两跳",
  );
});

test("条目顺序不影响结果（工具结果可能先于助手的后续消息到达）", () => {
  const started = Date.parse("2026-10-27T10:00:00.000Z");
  assert.equal(
    turnDurationOf([
      { timestamp: started + 9_000 },
      { timestamp: started },
      { timestamp: started + 4_000 },
    ]),
    9_000,
  );
});

test("拿不到时间戳就说不知道，不说 0 秒", () => {
  assert.equal(turnDurationOf([]), undefined);
  assert.equal(turnDurationOf([{}, { timestamp: null }]), undefined);
  assert.equal(turnDurationOf([{ timestamp: "not-a-number" }]), undefined);
  assert.equal(turnDurationOf([{ timestamp: 0 }]), undefined, "0 是「没有时间戳」的编码，不是 1970 年");
  // 只有一个时间戳就没有跨度可言 —— 仍然是「不知道」，不是 0。
  assert.equal(turnDurationOf([{ timestamp: 1_700_000_000_000 }]), undefined);
});

test("亚秒跨度是真实跨度，只是展示层会把它读成 1 秒", () => {
  const started = Date.parse("2026-10-27T10:00:00.000Z");
  assert.equal(turnDurationOf([{ timestamp: started }, { timestamp: started + 120 }]), 120);
  assert.equal(turnDurationSeconds(120), 1);
});

test("秒数四舍五入，且不足一秒按 1 秒算", () => {
  assert.equal(turnDurationSeconds(0), undefined);
  assert.equal(turnDurationSeconds(undefined), undefined);
  assert.equal(turnDurationSeconds(-5), undefined);
  assert.equal(turnDurationSeconds(Number.NaN), undefined);
  assert.equal(turnDurationSeconds(120), 1, "0.12 秒对读者来说就是「1 秒」，但不是「0 秒」");
  assert.equal(turnDurationSeconds(999), 1);
  assert.equal(turnDurationSeconds(58_000), 58);
  assert.equal(turnDurationSeconds(58_600), 59);
});
/**
 * 轮次刚结束时，转录里的时间戳可能还没描述到这一轮（pi 落后几百毫秒），但表头
 * 立刻就要印「已工作 N 秒」。这时能用的只有「这个客户端看了多久」——它是一次真实
 * 的测量，不是编的数字；下一份快照会把它换成转录自己的值。
 */
test("落定瞬间的时长来自本客户端的观测区间", () => {
  assert.equal(observedTurnDuration(1_000, 5_000), 4_000);
  assert.equal(observedTurnDuration(1_000, 1_000), 0, "同一毫秒是合法观测，交给秒数换算去取 1 秒下限");
  assert.equal(observedTurnDuration(0, 5_000), undefined, "0 是「没有起点」的编码");
  assert.equal(observedTurnDuration(undefined, 5_000), undefined);
  assert.equal(observedTurnDuration(5_000, 1_000), undefined, "终点早于起点是坏数据");
});

test("落定时只碰还在流式的回答，且不覆盖已有的时长", () => {
  const streaming = {
    id: "t1#assistant",
    role: "assistant",
    kind: "text",
    content: "",
    createdAt: 1_000,
    status: "streaming",
  } as const;
  const settled = settleStreamingAnswer({ ...streaming }, 4_000);
  assert.equal(settled?.status, "done");
  assert.equal(settled?.turnDurationMs, 3_000);

  const measured = settleStreamingAnswer({ ...streaming, turnDurationMs: 99 } as never, 4_000);
  assert.equal(measured?.turnDurationMs, 99, "已经有真值时不覆盖");

  const done = settleStreamingAnswer({ ...streaming, status: "done" } as never, 4_000);
  assert.equal(done, undefined, "已经落定的不归这里管");
  const question = { ...streaming, role: "user" } as never;
  assert.equal(settleStreamingAnswer(question, 4_000), undefined);
});
