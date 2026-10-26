/**
 * 桥 → 客户端这条流的**帧写入器**：序号、背压、上限，一个模块一件事。
 *
 * 为什么要单独测它（而不是只靠 e2e）：三件事的失败方式都很安静。
 * `res.write()` 返回 `false` 时继续写 → 客户端不读时桥的内存无上限地涨；没有序号 →
 * 客户端无法判断自己是否漏帧；没有上限 → 客户端断在半路时队列会一直堆。
 * 这里用一个「可暂停」的假 response 把三种情形都逼出来，不碰真 socket、不花时间。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createFrameWriter } from "../server/frameWriter.mjs";

/**
 * 假 response：只实现写入器真正用到的那几个字段。
 *
 * `pause()` = socket 缓冲区满了（`write()` 返回 `false`，数据仍然收下）。真实 Node 用高水位
 * 自己判定，这里由用例直接开关，于是"背压"不需要靠灌数据去凑。
 */
function fakeResponse() {
  const written = [];
  const listeners = new Map();
  let paused = false;
  const emit = (event) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener();
    }
  };
  return {
    written,
    ended: false,
    destroyed: false,
    write(text) {
      written.push(text);
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
    end() {
      this.ended = true;
    },
    /** socket 满了。 */
    pause() {
      paused = true;
    },
    /** 放行一次背压（Node 的 `drain`）。 */
    drain() {
      paused = false;
      emit("drain");
    },
    close() {
      this.destroyed = true;
      emit("close");
    },
  };
}

const parse = (texts) => texts.map((text) => JSON.parse(text));
const types = (res) => parse(res.written).map((frame) => frame.type);
/** 让写入器内部的 flush 走到它不该再等的地方。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("帧按调用顺序写出，并且一帧一个递增的 streamSeq", async () => {
  const res = fakeResponse();
  const frames = createFrameWriter(res);

  frames.write({ type: "delta", text: "a" });
  frames.write({ type: "delta", text: "b" });
  frames.write({ type: "done" });
  await settle();

  assert.deepEqual(parse(res.written), [
    { type: "delta", text: "a", streamSeq: 1 },
    { type: "delta", text: "b", streamSeq: 2 },
    { type: "done", streamSeq: 3 },
  ]);
});

test("payload 自带的 streamSeq 不能盖掉写入器的计数", async () => {
  const res = fakeResponse();
  const frames = createFrameWriter(res);

  frames.write({ type: "delta", streamSeq: 99 });
  await settle();

  assert.deepEqual(parse(res.written).map((frame) => frame.streamSeq), [1]);
});

test("res.write() 返回 false 时先停下，等到 drain 才继续", async () => {
  const res = fakeResponse();
  const frames = createFrameWriter(res);
  res.pause();

  frames.write({ type: "delta", text: "a" });
  frames.write({ type: "delta", text: "b" });
  await settle();

  assert.equal(res.written.length, 1, "背压期间不许继续写（否则就是在替客户端攒内存）");

  res.drain();
  await settle();

  assert.deepEqual(parse(res.written), [
    { type: "delta", text: "a", streamSeq: 1 },
    { type: "delta", text: "b", streamSeq: 2 },
  ]);
});

test("等 drain 期间进来的帧也算在待发字节里，越限就止损", async () => {
  const res = fakeResponse();
  // 单帧约 40 字节：两条就该越限。
  const frames = createFrameWriter(res, { maxPendingBytes: 60 });
  res.pause();

  frames.write({ type: "delta", text: "a" });
  await settle();
  assert.equal(res.written.length, 1, "第一条已经交给 socket（只是还没发出去）");

  frames.write({ type: "delta", text: "b" });
  frames.write({ type: "delta", text: "c" });
  await settle();

  res.drain();
  await settle();

  const written = parse(res.written);
  // 在等 drain 的那一条不能不算数：它占着 socket 的内存。b 越限被丢掉，c 根本没收。
  assert.deepEqual(
    written.map((frame) => frame.text ?? frame.code ?? frame.type),
    ["a", "overflow"],
  );
});

test("上限只产出一帧 overflow，之后不再收帧，而且它必须是最后一帧", async () => {
  const res = fakeResponse();
  const frames = createFrameWriter(res, { maxPendingBytes: 80 });

  // 已经写出去的那条不能被"止损"抹掉。
  frames.write({ type: "delta", text: "kept" });
  await settle();

  res.pause();
  for (let index = 0; index < 20; index += 1) {
    frames.write({ type: "delta", text: "x".repeat(20) });
  }
  await settle();
  res.drain();
  await settle();

  const written = parse(res.written);
  const overflow = written.filter((frame) => frame.code === "overflow");
  assert.equal(overflow.length, 1, "上限只该产出一帧 overflow");
  assert.equal(overflow[0].type, "transport_error");
  assert.equal(written.at(-1), overflow[0], "overflow 必须是最后一帧");
  assert.equal(written[0].text, "kept", "已经写到线上的帧不该被回退");
  assert.ok(written.length < 20, `越限之后不许再堆帧（实际写了 ${written.length} 帧）`);
});

test("带上 runId 时每一帧都带它，而且 payload 盖不掉", async () => {
  const res = fakeResponse();
  const frames = createFrameWriter(res, { runId: "run-1" });

  frames.write({ type: "delta", text: "a", runId: "骗人的" });
  frames.write({ type: "done" });
  await settle();

  assert.deepEqual(parse(res.written), [
    { type: "delta", text: "a", runId: "run-1", streamSeq: 1 },
    { type: "done", runId: "run-1", streamSeq: 2 },
  ]);
});

test("没有 runId 的写入器不加这个字段（进度流的帧形状不变）", async () => {
  const res = fakeResponse();
  const frames = createFrameWriter(res);

  frames.write({ type: "done" });
  await settle();

  assert.deepEqual(parse(res.written), [{ type: "done", streamSeq: 1 }]);
});

test("close() 先把排队的帧写完再 end()，尾帧不会因为 end() 掉在半路", async () => {
  const res = fakeResponse();
  const frames = createFrameWriter(res);

  frames.write({ type: "delta", text: "a" });
  frames.write({ type: "done" });
  await frames.close();

  assert.deepEqual(types(res), ["delta", "done"]);
  assert.equal(res.ended, true);
});

test("客户端已经断开时不再写、也不再等 drain", async () => {
  const res = fakeResponse();
  const frames = createFrameWriter(res);
  res.pause();

  frames.write({ type: "delta", text: "a" });
  await settle();
  // 断开：close 事件到了，写入器不该把剩下的帧继续往死 socket 上写，close() 也不该挂住。
  res.close();
  frames.write({ type: "delta", text: "b" });
  await frames.close();

  assert.deepEqual(types(res), ["delta"]);
  assert.equal(res.ended, false, "已经 destroyed 的 response 不该再 end()");
});