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

/** 与 frameWriter 测试同形的假 response：只实现写入器用到的字段。 */
function fakeResponse() {
  return {
    written: [],
    ended: false,
    destroyed: false,
    listeners: new Map(),
    write(text) {
      this.written.push(text);
      return true;
    },
    once(event, listener) {
      const set = this.listeners.get(event) ?? new Set();
      set.add(listener);
      this.listeners.set(event, set);
      return this;
    },
    off(event, listener) {
      this.listeners.get(event)?.delete(listener);
      return this;
    },
    close() {
      this.destroyed = true;
      for (const listener of [...(this.listeners.get("close") ?? [])]) {
        listener();
      }
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