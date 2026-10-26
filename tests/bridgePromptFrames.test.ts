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
  } catch (error) {
    const logs = e2e.logs();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.stdout}\n${logs.stderr}`);
  } finally {
    await e2e.stop();
  }
});