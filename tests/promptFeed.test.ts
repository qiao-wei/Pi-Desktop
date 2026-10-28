/**
 * 客户端的「流坏了」契约：先续订同一条 run，续不上才退回快照。
 *
 * 为什么要一个专门的测试：这件事的失败方式全是**静默**的——续订地址算错一帧，界面会少一段
 * 正文；坏帧被当成业务错误，这一轮会被提前标成 done 并谎报完成；该退快照的时候还在重试，
 * 用户会盯着一个永远不动的界面。这里用一条脚本化的假流把每个分支都逼出来，不碰真桥。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BridgeStreamError } from "../src/lib/bridge/transport.ts";
import { createPromptFeed } from "../src/features/chat/promptFeed.ts";

const sessionPath = "/tmp/pi-desktop/session.jsonl";

/** 一条 run 帧。`seq` 省略 = 传输层自己那种没有序号的帧。 */
function frame(type, seq, extra = {}) {
  return { type, runId: "run-1", ...(seq === undefined ? {} : { streamSeq: seq }), ...extra };
}

/**
 * 假传输：第 N 次调用消费第 N 个脚本。
 * 已经 abort 的 signal 要像 `fetch` 一样立刻抛 AbortError，否则停止路径的行为是假的。
 */
function scriptedStream(steps, calls) {
  return async (path, body, onEvent, options = {}) => {
    calls.push({ path, body });
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const step = steps[calls.length - 1] ?? { frames: [] };
    for (const event of step.frames ?? []) {
      onEvent(event);
    }
    if (step.error) {
      throw step.error;
    }
  };
}

function harness(steps, options = {}) {
  const calls = [];
  const applied = [];
  const losses = [];
  const repairs = [];
  const controller = options.controller ?? new AbortController();
  let current = true;
  const feed = createPromptFeed({
    sessionPath,
    stream: scriptedStream(steps, calls),
    isCurrent: () => current && (options.isCurrent?.() ?? true),
    ownerSignal: () => controller.signal,
    apply: (event) => applied.push(event),
    onLost: (loss) => losses.push(loss),
    onRepair: (repair) => repairs.push(repair),
    maxAttempts: options.maxAttempts ?? 3,
    retryDelayMs: 1,
  });
  return {
    feed,
    calls,
    applied,
    losses,
    repairs,
    controller,
    stop: () => {
      current = false;
    },
    types: () => applied.map((event) => event.type),
  };
}

test("溢出帧不占序号：游标停在最后一条 run 帧，从它的下一帧续订", async () => {
  const overflow = frame("transport_error", undefined, { code: "overflow", message: "backlog" });
  const h = harness([{ frames: [frame("delta", 3), frame("done", 4)] }]);

  assert.equal(h.feed.accept(frame("delta", 1)), "applied");
  h.feed.accept(frame("assistant_partial", 2));
  assert.equal(h.feed.accept(overflow), "damaged", "坏帧本身不应用");
  await h.feed.settled();

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, "/api/runs/stream");
  assert.deepEqual(h.calls[0].body, { sessionPath, runId: "run-1", fromSeq: 3 });
  assert.deepEqual(h.types(), ["delta", "assistant_partial", "delta", "done"]);
  assert.deepEqual(h.losses, [], "接上了就不该报丢失");
  assert.equal(h.feed.cursor.lastSeq, 4);
  assert.deepEqual(h.repairs, [{ attempt: 1, fromSeq: 3 }]);
});

test("漏帧（序号跳号）也续订，而且游标停在洞前面——漏掉的那帧会被重放", async () => {
  const h = harness([{ frames: [frame("delta", 2), frame("delta", 3), frame("done", 4)] }]);

  h.feed.accept(frame("delta", 1));
  assert.equal(h.feed.accept(frame("delta", 3)), "damaged", "跳号本身就是证据，不必等错误帧");
  await h.feed.settled();

  // 从 2 续订（不是 4）：有洞时游标必须停在洞前面，否则漏掉的那帧永远补不回来。
  assert.equal(h.calls[0].body.fromSeq, 2);
  assert.deepEqual(h.applied.map((event) => event.streamSeq), [1, 2, 3, 4], "洞被重放补上，后续帧各应用一次");
  assert.deepEqual(h.types(), ["delta", "delta", "delta", "done"]);
});

test("旧桥给传输帧也盖了序号：一样不采信（否则续订会跳过被丢掉的那帧）", async () => {
  const overflow = frame("transport_error", 2, { code: "overflow" });
  const h = harness([{ frames: [frame("delta", 2), frame("done", 3)] }]);

  h.feed.accept(frame("delta", 1));
  h.feed.accept(overflow);
  await h.feed.settled();

  assert.equal(h.feed.cursor.lastSeq, 3);
  assert.equal(h.calls[0].body.fromSeq, 2, "被丢掉的是第 2 帧，不是第 3 帧");
  assert.deepEqual(h.types(), ["delta", "delta", "done"]);
});

test("坏掉的 feed 之后到的帧一律丢弃，不应用也不推游标", async () => {
  const h = harness([{ frames: [frame("done", 2)] }]);

  h.feed.accept(frame("delta", 1));
  h.feed.accept(frame("transport_error", undefined, { code: "overflow" }));
  // 同一条老 feed 还在吐（漏帧那种情形），它的后续帧属于已经被取代的历史。
  assert.equal(h.feed.accept(frame("delta", 2)), "stale");
  await h.feed.settled();

  assert.deepEqual(h.types(), ["delta", "done"], "第 2 帧只能从续订那条来，不能来两次");
  assert.equal(h.calls[0].body.fromSeq, 2);
});

test("run 已经结束（404）：不再重试，交给快照", async () => {
  const h = harness([{ error: new BridgeStreamError("Unknown run", 404) }]);

  h.feed.accept(frame("delta", 1));
  h.feed.accept(frame("transport_error", undefined, { code: "overflow" }));
  await h.feed.settled();

  assert.equal(h.calls.length, 1, "404 重试没有意义");
  assert.deepEqual(
    h.losses.map((loss) => [loss.reason, loss.runId, loss.lastSeq]),
    [["not-found", "run-1", 1]],
  );
});

test("帧日志已滚出窗口（409）：退快照，而不是从中间假装接上", async () => {
  const h = harness([{ error: new BridgeStreamError("frame 2 is no longer in this run's log", 409) }]);

  h.feed.accept(frame("delta", 1));
  h.feed.accept(frame("transport_error", undefined, { code: "overflow" }));
  await h.feed.settled();

  assert.equal(h.calls.length, 1);
  assert.equal(h.losses[0].reason, "truncated");
});

test("网络抖动才重试，用完次数后报 exhausted", async () => {
  const h = harness([{ error: new Error("socket hang up") }, { error: new Error("socket hang up") }], {
    maxAttempts: 2,
  });

  h.feed.accept(frame("delta", 1));
  h.feed.accept(frame("transport_error", undefined, { code: "malformed_line" }));
  await h.feed.settled();

  assert.equal(h.calls.length, 2, "两次续订尝试都失败，就不再试了");
  assert.deepEqual(h.losses.map((loss) => loss.reason), ["exhausted"]);
});

test("续订那条自己也坏了：用更新后的游标接着续", async () => {
  const damaged = () => frame("transport_error", undefined, { code: "overflow" });
  const h = harness([
    { frames: [frame("delta", 2), damaged()] },
    { frames: [frame("delta", 3), frame("done", 4)] },
  ]);

  h.feed.accept(frame("delta", 1));
  h.feed.accept(damaged());
  await h.feed.settled();

  assert.deepEqual(h.calls.map((call) => call.body.fromSeq), [2, 3]);
  assert.deepEqual(h.types(), ["delta", "delta", "delta", "done"]);
  assert.deepEqual(h.losses, []);
});

test("用户按了停止：续订立刻放弃，不报丢失、不抢停止路径的 UI", async () => {
  const controller = new AbortController();
  const h = harness([{ frames: [frame("done", 2)] }], { controller });

  h.feed.accept(frame("delta", 1));
  h.feed.accept(frame("transport_error", undefined, { code: "overflow" }));
  controller.abort();
  await h.feed.settled();

  assert.deepEqual(h.losses, []);
});

test("还没有可续订的地址（没有 runId）：直接退快照，不发订阅请求", async () => {
  const h = harness([{ frames: [] }]);

  h.feed.accept({ type: "delta", streamSeq: 1 });
  h.feed.accept({ type: "transport_error", code: "overflow" });
  await h.feed.settled();

  assert.equal(h.calls.length, 0, "没有地址就不该去试");
  assert.equal(h.losses[0].reason, "no-address");
});

test("这一轮已经被取代（isCurrent 为假）：续订不再开始", async () => {
  const h = harness([{ frames: [] }]);

  h.feed.accept(frame("delta", 1));
  h.stop();
  h.feed.accept(frame("transport_error", undefined, { code: "overflow" }));
  await h.feed.settled();

  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.losses, []);
});