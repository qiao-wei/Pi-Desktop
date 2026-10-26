/**
 * 真桥 + 假模型：**提交与订阅是两条流**，而它们看的是同一条 run。
 *
 * B2 的验收点全在这个文件里：提交那一条照旧（一个字节不改），新增一条只订阅的入口
 * （`POST /api/runs/stream`，寻址 `(sessionPath, runId, fromSeq)`）；中途接上的人从
 * 他说的那个序号续上，而不是从头重来、也不是从中间悄悄开始。
 *
 * 服务端自己的契约（谁能接、从哪接）在 `tests/runStreams.test.ts` 用假 response 测；这里测的是
 * 穿上 HTTP 之后仍然成立：状态码分得开、两条流的帧逐字节一致。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startE2E } from "../e2e/lib/bridge.mjs";
import { ndjson } from "./lib/ndjsonStream.ts";

/** 期望 200：失败时把响应体贴出来（成功时**不要**碰 body，那会把流锁掉）。 */
async function expectOk(response, label) {
  if (response.status !== 200) {
    assert.fail(`${label} 期望 200，实际 ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
}

const post = (apiBase, path, body) =>
  fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("中途订阅一条进行中的 run：从 fromSeq 续上、帧逐条一致、状态码分得开", async () => {
  const e2e = await startE2E({ model: { chunkDelayMs: 300, firstTokenDelayMs: 100 } });
  try {
    await e2e.api.openProject(e2e.workspaceDir);
    await e2e.api.selectE2EModel();
    const bootstrap = await e2e.api.get("/api/bootstrap");
    const sessionFile = String(bootstrap?.snapshot?.sessionFile ?? bootstrap?.sessionFile ?? "");
    assert.ok(sessionFile, "bootstrap 里必须有 sessionFile，订阅要用它限定会话");

    // ① 提交。不等整段读完：这一轮还要跑几百毫秒，正好用来测"中途"。
    const submitted = await post(e2e.apiBase, "/api/prompt", { input: "hello" });
    assert.equal(submitted.status, 200);
    const submitStream = ndjson(submitted);
    const first = await submitStream.next();
    const runId = first.runId;
    assert.equal(typeof runId, "string", "第一帧就该带 runId（没有它就没法订阅）");
    const submittedRest = submitStream.rest();

    // ② 会话不对：不给订阅（runId 猜不出来，但会话归属还是要挡）。
    const wrongSession = await post(e2e.apiBase, "/api/runs/stream", {
      sessionPath: `${sessionFile}.not-mine`,
      runId,
      fromSeq: 1,
    });
    assert.equal(wrongSession.status, 403);

    // ③ 序号超过这条流已发出的范围：明确拒绝，不静默接上。
    const ahead = await post(e2e.apiBase, "/api/runs/stream", { sessionPath: sessionFile, runId, fromSeq: 9999 });
    assert.equal(ahead.status, 400);

    // ④ 晚到的订阅者：从第 1 条接（日志重放 + 跟着往下）。
    const late = await post(e2e.apiBase, "/api/runs/stream", { sessionPath: sessionFile, runId, fromSeq: 1 });
    await expectOk(late, "从第 1 条接上");

    // ⑤ 真正的用法：客户端说"我收到 N 了"，从 N+1 接。
    const resumed = await post(e2e.apiBase, "/api/runs/stream", {
      sessionPath: sessionFile,
      runId,
      fromSeq: first.streamSeq + 1,
    });
    await expectOk(resumed, "从 N+1 接上");

    // 两条订阅都接上之后才读：`rest()` 会一直读到这一轮结束，先读哪条都会让另一条错过时机。
    const [lateFrames, resumedFrames, submittedFrames] = await Promise.all([
      ndjson(late).rest(),
      ndjson(resumed).rest(),
      submittedRest.then((rest) => [first, ...rest]),
    ]);
    assert.equal(submittedFrames.at(-1).type, "done", "提交那条流照旧以 done 收尾");

    // 晚到的那条：逐帧与提交那条一致（同一份日志 + 同一套编号）。
    assert.deepEqual(lateFrames, submittedFrames, "从第 1 条接上的人必须看到与提交者完全相同的帧");
    // 续订的那条：接着客户端手上的序号往下，不重发、不跳号。
    assert.deepEqual(
      resumedFrames,
      submittedFrames.slice(1),
      `从 ${first.streamSeq + 1} 接上，第一条就该是 ${first.streamSeq + 1}`,
    );
    assert.equal(resumedFrames.at(-1).type, "done", "订阅者也要收到收尾帧，否则它只能一直等");

    // ⑥ 跑完的 run 不再可订阅（注册表里已经没有它）。
    const after = await post(e2e.apiBase, "/api/runs/stream", { sessionPath: sessionFile, runId, fromSeq: 1 });
    assert.equal(after.status, 404);
  } catch (error) {
    const logs = e2e.logs();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.stdout}\n${logs.stderr}`);
  } finally {
    await e2e.stop();
  }
});