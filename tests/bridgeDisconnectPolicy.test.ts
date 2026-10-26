/**
 * 断开策略是一条**声明的值**（`DELIVERY_POLICY.onOwnerDisconnect`），不是散在处理器里的条件。
 *
 * 这个文件测的是它真的成立，而不是只在文档里成立：
 * - **owner 断开 → 这一轮被中止**（`local-live` 声明的就是 `abort-run`）；
 * - **订阅者断开 → 这一轮照跑**（"只有启动这轮的请求断开才中止"，后到的请求不动别人的 run）——
 *   后半句以前只是 `onClientClose` 里的 `!wasStreaming` 门，现在它是订阅入口存在之后必须守住的性质。
 *
 * 断言只看桥自己的两个外部事实：ambient 快照里的 `streamingSessionPaths`，以及提交那条流能不能
 * 正常走到 `done`。不看实现形态。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startE2E } from "../e2e/lib/bridge.mjs";
import { ndjson } from "./lib/ndjsonStream.ts";

/** ambient 快照很便宜（不含整份会话），适合轮询"这一轮还在不在跑"。 */
async function streamingSessions(e2e) {
  const ambient = await e2e.api.get("/api/bootstrap?view=ambient");
  const snapshot = ambient?.snapshot ?? ambient ?? {};
  return snapshot.streamingSessionPaths ?? [];
}

async function waitForStreaming(e2e, expected, label) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const paths = await streamingSessions(e2e);
    if (paths.length > 0 === expected) {
      return paths;
    }
    if (Date.now() > deadline) {
      const logs = e2e.logs();
      assert.fail(
        `等 "${label}" 超时：期望 streaming=${expected}，实际 ${JSON.stringify(paths)}\n${logs.stdout}\n${logs.stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 起一轮并读到第一帧（返回提交那条流的句柄）。 */
async function startRun(e2e, signal) {
  const bootstrap = await e2e.api.get("/api/bootstrap");
  const sessionFile = String(bootstrap?.snapshot?.sessionFile ?? bootstrap?.sessionFile ?? "");
  assert.ok(sessionFile, "bootstrap 里必须有 sessionFile");
  const response = await fetch(`${e2e.apiBase}/api/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello" }),
    signal,
  });
  assert.equal(response.status, 200);
  const stream = ndjson(response);
  const first = await stream.next();
  assert.equal(typeof first.runId, "string");
  return { stream, first, runId: first.runId, sessionFile };
}

test("启动这一轮的请求断开 → 这一轮被中止（声明的是 abort-run）", async () => {
  const e2e = await startE2E({ model: { chunkDelayMs: 400, firstTokenDelayMs: 100 } });
  try {
    await e2e.api.openProject(e2e.workspaceDir);
    await e2e.api.selectE2EModel();

    const controller = new AbortController();
    await startRun(e2e, controller.signal);
    await waitForStreaming(e2e, true, "这一轮跑起来");

    controller.abort();

    await waitForStreaming(e2e, false, "owner 断开之后这一轮停下来");
  } catch (error) {
    const logs = e2e.logs();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.stdout}\n${logs.stderr}`);
  } finally {
    await e2e.stop();
  }
});

test("订阅者断开 → 这一轮照跑（后到的请求不动别人的 run）", async () => {
  const e2e = await startE2E({ model: { chunkDelayMs: 400, firstTokenDelayMs: 100 } });
  try {
    await e2e.api.openProject(e2e.workspaceDir);
    await e2e.api.selectE2EModel();

    const run = await startRun(e2e);
    await waitForStreaming(e2e, true, "这一轮跑起来");

    // 一个订阅者接上、读一帧、然后走掉。
    const subscriber = new AbortController();
    const subscribed = await fetch(`${e2e.apiBase}/api/runs/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionPath: run.sessionFile, runId: run.runId, fromSeq: 1 }),
      signal: subscriber.signal,
    });
    assert.equal(subscribed.status, 200);
    await ndjson(subscribed).next();
    subscriber.abort();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 这一轮必须还在跑：订阅者的断开不是 owner 的断开。
    await waitForStreaming(e2e, true, "订阅者走了之后这一轮还在跑");

    // 提交那条流必须完整走到 done（不是被"别人的断开"顺手收掉）。
    const frames = await run.stream.rest();
    assert.equal(frames.at(-1).type, "done", `提交那条流要以 done 收尾，实际 ${JSON.stringify(frames.at(-1))}`);
  } catch (error) {
    const logs = e2e.logs();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.stdout}\n${logs.stderr}`);
  } finally {
    await e2e.stop();
  }
});