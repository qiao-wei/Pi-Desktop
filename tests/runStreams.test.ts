/**
 * 一次运行的**帧日志 + 多 sink 扇出**：提交那条流是 sink #1，后来者从日志接上。
 *
 * 为什么要这一步（B2）：`streamSeq` 让"漏了一帧"可见、`runId` 让帧有归属，但帧本身还是只写进
 * 那一个 response —— 谁接上谁重来。有了 run 级日志，"提交"与"订阅"才有可能分开。
 *
 * 这里只测这个模块自己的契约（谁能接、从哪接、拒绝时说什么），HTTP 层在
 * `tests/bridgeRunSubscription.test.ts` 用真桥测。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createRunStreams } from "../server/runStreams.mjs";

/** 与 frameWriter 测试同形的假 response：只实现写入器用到的字段。`pause()` = socket 已满。 */
function fakeResponse() {
  let paused = false;
  const listeners = new Map();
  const emit = (event) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener();
    }
  };
  return {
    written: [],
    ended: false,
    destroyed: false,
    listeners,
    write(text) {
      this.written.push(text);
      return !paused;
    },
    once(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return this;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    close() {
      this.destroyed = true;
      emit("close");
    },
    pause() {
      paused = true;
    },
    drain() {
      paused = false;
      emit("drain");
    },
    end() {
      this.ended = true;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const frames = (res) => res.written.map((text) => JSON.parse(text));

test("两个 sink 收到同一串帧：第一个边跑边发，第二个从日志补齐后逐帧一致", async () => {
  const run = createRunStreams().open({ runId: "r1", sessionPath: "/tmp/s.jsonl" });
  const first = fakeResponse();
  run.attach(first, run.plan(1));

  run.publish({ type: "delta", text: "a" });
  run.publish({ type: "delta", text: "b" });
  await settle();

  const second = fakeResponse();
  const plan = run.plan(1);
  assert.equal(plan.kind, "ok");
  run.attach(second, plan);
  run.publish({ type: "delta", text: "c" });
  await settle();

  const expected = [
    { type: "delta", text: "a", runId: "r1", streamSeq: 1 },
    { type: "delta", text: "b", runId: "r1", streamSeq: 2 },
    { type: "delta", text: "c", runId: "r1", streamSeq: 3 },
  ];
  assert.deepEqual(frames(first), expected);
  assert.deepEqual(frames(second), expected, "晚到的 sink 补齐后必须与先到的那条逐帧一致");
});

test("从中间接上：只重放 fromSeq 之后的，序号跟着 run 走而不是重新编号", async () => {
  const run = createRunStreams().open({ runId: "r1", sessionPath: "/tmp/s.jsonl" });
  run.publish({ type: "delta", text: "a" });
  run.publish({ type: "delta", text: "b" });

  const plan = run.plan(2);
  assert.equal(plan.kind, "ok");
  assert.deepEqual(plan.replay, [{ type: "delta", text: "b" }]);

  const late = fakeResponse();
  run.attach(late, plan);
  run.publish({ type: "delta", text: "c" });
  await settle();

  assert.deepEqual(
    frames(late).map((frame) => [frame.streamSeq, frame.text]),
    [
      [2, "b"],
      [3, "c"],
    ],
    "客户端说「我收到 1 了」，接下来的第一条必须是 2",
  );
});

test("fromSeq = 已发出条数 + 1 是合法的「只听后面的」", async () => {
  const run = createRunStreams().open({ runId: "r1", sessionPath: "/tmp/s.jsonl" });
  run.publish({ type: "delta", text: "a" });
  assert.deepEqual(run.plan(2), { kind: "ok", fromSeq: 2, startSeq: 1, replay: [] });
});

test("fromSeq 超过了这条流已发出的范围 → beyond，不静默接上", () => {
  const run = createRunStreams().open({ runId: "r1", sessionPath: "/tmp/s.jsonl" });
  run.publish({ type: "delta", text: "a" });
  assert.deepEqual(run.plan(9), { kind: "beyond", fromSeq: 9, seq: 1 });
});

test("日志被上限截断后，来晚的订阅者拿到 truncated 与还能给的最早序号", () => {
  const run = createRunStreams({ maxLogBytes: 60 }).open({ runId: "r1", sessionPath: "/tmp/s.jsonl" });
  for (const text of ["a", "b", "c", "d"]) {
    run.publish({ type: "delta", text });
  }
  const plan = run.plan(1);
  assert.equal(plan.kind, "truncated");
  assert.ok(plan.oldestSeq > 1, `截断后最早可服务的序号必须 >1（实际 ${plan.oldestSeq}）`);
  // 从"还能给的最早那条"接上是允许的：截断不等于整条流作废。
  assert.equal(run.plan(plan.oldestSeq).kind, "ok");
});

test("owner 的 socket 越限了，但 run 还在：后来者从客户端最后收到的序号接上，能补齐它错过的一切", async () => {
  const overflows = [];
  const runs = createRunStreams({
    maxPendingBytes: 80,
    onOverflow: (stats) => overflows.push(stats),
  });
  const run = runs.open({ runId: "r1", sessionPath: "/tmp/s.jsonl" });
  const owner = fakeResponse();
  run.attach(owner, run.plan(1));

  run.publish({ type: "delta", text: "a" });
  await settle();
  owner.pause();
  // 客户端不读之后桥还在发：累计到上限就止损，但日志照旧在长。
  for (const text of ["b", "c", "d", "e"]) {
    run.publish({ type: "delta", text });
  }
  await settle();
  owner.drain();
  await settle();

  assert.equal(overflows.length, 1, "越限要报告一次，并带上 run 的归属");
  assert.equal(overflows[0].runId, "r1");
  assert.equal(overflows[0].sessionPath, "/tmp/s.jsonl");

  const ownerFrames = frames(owner);
  const overflow = ownerFrames.at(-1);
  assert.equal(overflow.code, "overflow");
  // `b`、`c` 还在写入器的队列里就被越限清掉了，`d` 是触发越限的那一条，`e` 根本没进 sink：
  // 客户端只收到了 `a`（最后一条带序号的帧），续订地址因此是 2。
  const lastSeq = ownerFrames.filter((frame) => "streamSeq" in frame).at(-1).streamSeq;
  assert.equal(lastSeq, 1);

  const plan = run.plan(lastSeq + 1);
  assert.equal(plan.kind, "ok", "run 还活着，日志也还在，就必须能接上");
  assert.deepEqual(
    plan.replay.map((frame) => frame.text),
    ["b", "c", "d", "e"],
    "被丢掉和根本没进 sink 的帧都在日志里",
  );
  const late = fakeResponse();
  run.attach(late, plan);
  await settle();

  assert.deepEqual(
    frames(late).map((frame) => [frame.streamSeq, frame.text]),
    [
      [2, "b"],
      [3, "c"],
      [4, "d"],
      [5, "e"],
    ],
    "owner 丢掉的帧必须一帧不少地重放回来",
  );
});

test("close() 收尾每一个 sink，之后这条 run 不再可订阅", async () => {
  const runs = createRunStreams();
  const run = runs.open({ runId: "r1", sessionPath: "/tmp/s.jsonl" });
  const first = fakeResponse();
  const second = fakeResponse();
  run.attach(first, run.plan(1));
  run.publish({ type: "delta", text: "a" });
  run.attach(second, run.plan(1));

  await run.close();

  assert.equal(runs.get("r1"), undefined, "结束的 run 必须从注册表里消失");
  assert.equal(first.ended, true);
  assert.equal(second.ended, true, "订阅者那一条也要收尾，否则它会一直等一个不会再来的 done");
  assert.deepEqual(run.plan(1).kind, "closed");
});

test("订阅者那条 socket 关掉时，它的 sink 立刻从扇出里摘掉", async () => {
  const run = createRunStreams().open({ runId: "r1", sessionPath: "/tmp/s.jsonl" });
  const owner = fakeResponse();
  const subscriber = fakeResponse();
  run.attach(owner, run.plan(1));
  run.attach(subscriber, run.plan(1));

  // 断线：response 被 destroyed 并发出 close（真实 Node 就是这个形态）。
  subscriber.destroyed = true;
  subscriber.close();
  run.publish({ type: "delta", text: "a" });
  await settle();

  assert.deepEqual(frames(subscriber), [], "已经关掉的 response 不该再收到帧");
  assert.equal(frames(owner).length, 1, "别的订阅者照收");
});

test("订阅者只摘自己的 sink：它断开不影响这条 run", async () => {
  const run = createRunStreams().open({ runId: "r1", sessionPath: "/tmp/s.jsonl" });
  const owner = fakeResponse();
  const subscriber = fakeResponse();
  run.attach(owner, run.plan(1));
  const sink = run.attach(subscriber, run.plan(1));

  await sink.close();

  assert.equal(subscriber.ended, true);
  assert.equal(owner.ended, false, "订阅者断开不能把别人的流也收掉");
  run.publish({ type: "delta", text: "a" });
  await settle();
  assert.deepEqual(frames(owner).length, 1);
});
/**
 * 帧预算落在**进日志之前**：日志里存的必须是订阅者真会收到的那一份。
 *
 * 否则续订是自欺欺人的——重放给出 4 MB 的原帧，正好把刚排空的 socket 再打满一次，
 * 而它还是同一个「越限 → 续订 → 越限」的循环。这里断言两件事：单帧被裁到上限内，
 * 且晚到的 sink 补到的字节与先到的那条完全一致（`__cuts` 也一起重放）。
 */
test("超大帧在进日志前就被裁：晚到的 sink 拿到的与先到的一致，且不越限", async () => {
  const run = createRunStreams({ maxFrameBytes: 64 * 1024 }).open({
    runId: "r1",
    sessionPath: "/tmp/s.jsonl",
  });
  const first = fakeResponse();
  run.attach(first, run.plan(1));

  const huge = JSON.stringify({ blob: "x".repeat(200_000) });
  run.publish({ type: "tool_execution_end", toolCallId: "c1", result: huge });
  await settle();

  const second = fakeResponse();
  run.attach(second, run.plan(1));
  await settle();

  const [frame] = frames(first);
  assert.equal(frame.type, "tool_execution_end");
  assert.equal(frame.toolCallId, "c1", "结构字段留下，事件仍能落到正确的行");
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= 64 * 1024);
  assert.ok(Array.isArray(frame.__cuts) && frame.__cuts.length > 0, "裁过就要说明");
  assert.deepEqual(frames(second), frames(first), "重放的是裁剪后的同一份帧");
});

test("裁剪会报告给宿主（诊断日志），并且不影响正常小帧", async () => {
  const budgets = [];
  const run = createRunStreams({ maxFrameBytes: 32 * 1024, onFrameBudget: (stats) => budgets.push(stats) }).open({
    runId: "r2",
    sessionPath: "/tmp/s.jsonl",
  });
  const sink = fakeResponse();
  run.attach(sink, run.plan(1));

  run.publish({ type: "delta", text: "ok" });
  assert.equal(budgets.length, 0, "正常帧不该触发诊断");
  run.publish({ type: "delta", text: "y".repeat(100_000) });
  assert.equal(budgets.length, 1);
  assert.equal(budgets[0]?.type, "delta");
  assert.equal(budgets[0]?.runId, "r2");
  assert.ok(budgets[0]?.originalBytes > budgets[0]?.bytes);
});
