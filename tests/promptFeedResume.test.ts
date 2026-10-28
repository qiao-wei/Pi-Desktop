/**
 * 两端合起来的那条路：**桥的帧日志越限止损 → 客户端从游标续订 → 补齐 → 这一轮照常收尾**。
 *
 * `runStreams.test.ts` 证明桥侧能从任意序号补回帧，`promptFeed.test.ts` 用脚本化的假流证明
 * 客户端会算对续订地址。两个模块各自绿了，中间仍可能接不上（地址算错、序号不从客户端期望的
 * 地方接着数、越限帧被当成了 run 的帧）。这里让它们**真的对着跑**：一个真 `createRunStreams`，
 * 客户端那侧用假 response 当 socket，客户端的续订请求直接打到同一个 run 上。
 *
 * 这正是 2026-10-28 那次事故的形状：4 MiB 待发上限一开火，客户端就把这一轮当失败收尾，
 * 而桥上的 run 还在跑、帧还在日志里。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createRunStreams } from "../server/runStreams.mjs";
import { createPromptFeed } from "../src/features/chat/promptFeed.ts";

const sessionPath = "/tmp/pi-desktop/session.jsonl";
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 假 response：写进去的每一行都算「客户端读到了」，并转给 `onLine`。
 * `pause()` 之后 `write()` 返回 false —— 这就是背压，跟真 socket 满了同一回事。
 */
function fakeResponse(onLine) {
  let paused = false;
  const listeners = new Map();
  const emit = (event) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener();
    }
  };
  return {
    written: [],
    destroyed: false,
    write(text) {
      this.written.push(text);
      for (const line of text.split("\n")) {
        if (line) {
          onLine?.(JSON.parse(line));
        }
      }
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
    pause() {
      paused = true;
    },
    drain() {
      paused = false;
      emit("drain");
    },
    end() {},
  };
}

const frames = (res) => res.written.map((text) => JSON.parse(text));

test("越限之后客户端自己接回来：续订、补齐、`done` 照常落地（这一轮不算失败）", async () => {
  const overflows = [];
  const run = createRunStreams({
    maxPendingBytes: 80,
    onOverflow: (stats) => overflows.push(stats),
  }).open({ runId: "r1", sessionPath });

  const applied = [];
  const losses = [];
  const repairs = [];
  /** @type {ReturnType<typeof createPromptFeed>} */
  let feed;
  // 提交那条流：写出来的每一帧都会被当成「客户端收到的帧」喂回给 feed —— 与真实接线一致。
  const owner = fakeResponse((event) => feed.accept(event));
  feed = createPromptFeed({
    sessionPath,
    // 续订真的打到同一个 run 上：地址对了才有帧，地址错了这里会立刻炸。
    stream: async (path, body, onEvent) => {
      assert.equal(path, "/api/runs/stream");
      const plan = run.plan(body.fromSeq);
      assert.equal(plan.kind, "ok", "run 还活着、日志还在窗口里，就必须能接上");
      const subscription = fakeResponse((event) => onEvent(event));
      run.attach(subscription, plan);
      // attach 的重放是异步 flush 的：等它写完再让这次订阅「正常结束」。
      await settle();
      await settle();
    },
    isCurrent: () => true,
    ownerSignal: () => null,
    apply: (event) => applied.push(event),
    onLost: (loss) => losses.push(loss),
    onRepair: (repair) => repairs.push(repair),
    retryDelayMs: 1,
  });

  run.attach(owner, run.plan(1));
  run.publish({ type: "delta", text: "a" });
  await settle();
  owner.pause();
  // 客户端不读之后桥还在发：累计到上限就止损，但日志照旧在长。
  for (const text of ["b", "c", "d", "e"]) {
    run.publish({ type: "delta", text });
  }
  await settle();
  await feed.settled();

  // 续订接上之后这一轮继续跑：`done` 必须真的落到 apply 里，而不是被当成「流已死」丢掉。
  run.publish({ type: "done" });
  await settle();

  assert.equal(overflows.length, 1, "越限报告一次（宿主据此记诊断）");
  assert.equal(overflows[0].runId, "r1");
  assert.equal(overflowedFrame(owner)?.code, "overflow", "客户端确实收到了那条越限帧");

  assert.deepEqual(
    repairs,
    [{ attempt: 1, fromSeq: 2 }],
    "续订地址 = 最后一条**带序号**的帧 + 1（越限帧不占号）",
  );
  assert.deepEqual(losses, [], "接得上就不该退回快照，也不该收尾");
  assert.deepEqual(
    frameTexts(applied),
    ["a", "b", "c", "d", "e", undefined],
    "被丢掉的 b/c/d/e 一帧不少地补齐，done 也在最后",
  );
  assert.equal(applied.at(-1).type, "done");
  assert.deepEqual(
    seqNumbers(applied),
    [1, 2, 3, 4, 5, 6],
    "客户端看到的事件流是连续的：洞被日志填平了，没有跳号",
  );
  assert.deepEqual(applied.filter((event) => event.type === "transport_error"), []);
});

const overflowedFrame = (res) => frames(res).find((frame) => frame.type === "transport_error");
const frameTexts = (events) => events.map((event) => (event.type === "delta" ? event.text : undefined));
const seqNumbers = (events) => events.map((event) => event.streamSeq);