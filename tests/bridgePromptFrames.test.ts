/**
 * 真桥 + 假模型端点，直接读 `/api/prompt` 的**原始 NDJSON**：一轮对话的帧序列本身是契约。
 *
 * 为什么这一层必须有：帧写入器（`server/frameWriter.mjs`）有单测，但"promptStream 真的用了它"
 * 只能在这条线上看出来。这层回答两个问题——每一帧是否都带 `streamSeq`，以及这段序号是否连续
 * （客户端就是靠它判断自己有没有漏帧的）。
 *
 * 只读原始字节，不经过浏览器：DOM 那一层由 `e2e/specs/streamTurn.spec.ts` 管。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startE2E } from "../e2e/lib/bridge.mjs";

test("一轮对话的每一帧都带连续递增的 streamSeq，并以 done 收尾", async () => {
  const e2e = await startE2E({ model: { chunkDelayMs: 10, firstTokenDelayMs: 10 } });
  try {
    await e2e.api.openProject(e2e.workspaceDir);
    await e2e.api.selectE2EModel();
    const frames = await e2e.api.prompt({ input: "hello" });

    assert.ok(frames.length > 3, `一轮对话不该只有 ${frames.length} 帧`);
    assert.deepEqual(
      frames.filter((frame) => frame.type === "unparsed"),
      [],
      "桥自己写出来的 NDJSON 不该有解析不了的行",
    );

    const sequences = frames.map((frame) => frame.streamSeq);
    assert.deepEqual(
      sequences,
      frames.map((_, index) => index + 1),
      `帧序号必须是 1..n 连续递增（实际 ${JSON.stringify(sequences)}）`,
    );

    const done = frames.at(-1);
    assert.equal(done.type, "done");
    assert.equal(done.lifecycle, "run");

    // 帧的归属：这一轮的所有帧都认同一个 runId，下一轮换一个。
    // 没有它，已经发出去的帧永远无法归到某一次运行上（订阅/重连只能全量重发）。
    const runIds = new Set(frames.map((frame) => frame.runId));
    assert.equal(runIds.size, 1, `同一轮的帧必须只有一个 runId（实际 ${JSON.stringify([...runIds])}）`);
    assert.equal(typeof [...runIds][0], "string");

    const nextRun = await e2e.api.prompt({ input: "again" });
    assert.notEqual(nextRun[0].runId, [...runIds][0], "下一轮必须是新的 runId");
    assert.deepEqual(
      nextRun.map((frame) => frame.streamSeq),
      nextRun.map((_, index) => index + 1),
      "第二轮同样从 1 开始编号",
    );
  } catch (error) {
    const logs = e2e.logs();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.stdout}\n${logs.stderr}`);
  } finally {
    await e2e.stop();
  }
});
/**
 * 一份 300 KB 的 `write` 走完整条链路：不能把桥的流打爆，也不能把整份正文发给客户端。
 *
 * 这是「4 MiB 待发上限」那次事故的正面用例：以前一帧就有几百 KB 到几 MB，第一帧入队
 * 就把待发预算吃满，下一帧直接越限（`droppedFrames: 0`），界面把这一轮当失败收尾。
 * 现在参数在**发帧之前**被裁（`__omitted` 带原始行数/字节），参数流 delta 也在 64 KiB 处停发。
 */
test("超大 write：无 transport_error，参数被裁剪且行数仍然真实", async () => {
  const e2e = await startE2E({ model: { chunkDelayMs: 0, firstTokenDelayMs: 0 } });
  try {
    await e2e.api.openProject(e2e.workspaceDir);
    await e2e.api.selectE2EModel();
    const frames = await e2e.api.prompt("E2E-TOOL-WRITE-BIG");

    assert.deepEqual(
      frames.filter((frame) => frame.type === "transport_error"),
      [],
      "预算生效时不该出现传输层止损帧",
    );

    // 参数流：客户端拼出来的 callText 不会超过预算（这里留一点帧开销余量）。
    const streamedBytes = frames
      .filter((frame) => frame.type === "tool_call_stream_delta")
      .reduce((sum, frame) => sum + Buffer.byteLength(String(frame.argsText ?? "")), 0);
    assert.ok(
      streamedBytes <= 64 * 1024,
      `参数流被转发太多：${streamedBytes} 字节（上限 64 KiB）`,
    );

    const end = frames.find(
      (frame) => frame.type === "tool_execution_end" && frame.toolName === "write",
    );
    assert.ok(end, "这一轮必须真的跑过 write");
    const content = String(end.args?.content ?? "");
    assert.ok(content.length > 0, "裁剪后仍要留下可读的预览");
    assert.ok(
      Buffer.byteLength(content) < 200 * 1024,
      `正文没有被裁：${Buffer.byteLength(content)} 字节`,
    );
    assert.ok(content.includes("\n…\n"), "裁法是 head + tail");
    assert.equal(end.args.__omitted?.[0]?.path, "content");
    assert.equal(end.args.__omitted?.[0]?.lines, 8000, "行数来自原文，不是预览");
    assert.ok(end.args.__omitted?.[0]?.bytes > 200_000);

    // 这一轮正常收尾。
    assert.equal(frames.at(-1).type, "done");
  } catch (error) {
    const logs = e2e.logs();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.stdout}\n${logs.stderr}`);
  } finally {
    await e2e.stop();
  }
});
