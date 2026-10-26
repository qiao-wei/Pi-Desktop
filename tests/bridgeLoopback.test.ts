/**
 * Boundary `bridge`: the protocol has **two** implementations, and the upper layer cannot tell them
 * apart.
 *
 * The HTTP transport is the one in production. This file swaps in the in-process transport
 * (`src/lib/bridge/loopback.ts`) - no `fetch`, no `Response`, no TCP - and runs the real upper layer
 * (`fetchJson` / `postJson` / `streamNdjson` / `fetchBootstrap` / `reportDiagnostic` from
 * `src/lib/api.ts`) against it. `globalThis.fetch` is replaced with a landmine for the duration, so a
 * leaked HTTP assumption fails loudly instead of quietly reaching the network.
 *
 * What this buys: "the UI does not know about HTTP" stops being a comment and becomes a test. It is
 * also the shape a future host would use (MessagePort bridge, Electron in-process bridge) - the
 * renderer half is `loopback.ts`, the host half is the injected `dispatch`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOL_VERSION } from "../src/shared/protocol/version.ts";
import { createLoopbackBridgeTransport, type BridgeRequestMessage } from "../src/lib/bridge/loopback.ts";
import { setBridgeTransport } from "../src/lib/bridge/transport.ts";
import { fetchBootstrap, fetchJson, postJson, reportDiagnostic, streamNdjson } from "../src/lib/api.ts";

interface Recorded {
  path: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

/**
 * A tiny in-process bridge: enough route surface for the upper layer's real functions, with the same
 * semantics as the HTTP one (ETag/304, JSON errors, NDJSON framing).
 */
function inProcessBridge() {
  const calls: Recorded[] = [];
  let bootstrapVersion = 1;
  const bootstrap = { protocolVersion: PROTOCOL_VERSION, sessions: [], revision: 1, bootCount: 0 };

  const dispatch = async (message: BridgeRequestMessage) => {
    calls.push({
      path: message.path,
      method: message.method,
      body: message.body,
      headers: message.headers,
    });

    if (message.path === "/api/protocol") {
      return { status: 200, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, pid: 42 }) };
    }

    if (message.path === "/api/bootstrap") {
      const tag = `W/"rev-${bootstrap.revision}"`;
      if (message.headers["If-None-Match"] === tag) return { status: 304, headers: { etag: tag } };
      bootstrapVersion += 1;
      return {
        status: 200,
        headers: { etag: tag, "content-type": "application/json" },
        body: JSON.stringify({ ...bootstrap, bootCount: bootstrapVersion }),
      };
    }

    if (message.path === "/api/bootstrap?view=ambient") {
      return { status: 200, body: JSON.stringify({ ambient: true, canPrompt: true, projectTrusted: true }) };
    }

    if (message.path === "/api/prompt") {
      // NDJSON, one object per line, including a deliberately malformed line in the middle.
      const chunks = [
        `${JSON.stringify({ type: "delta", text: "hel" })}\n`,
        `${JSON.stringify({ type: "delta", text: "lo" })}\n`,
        "not json at all\n",
        `${JSON.stringify({ type: "done" })}`,
      ];
      return {
        status: 200,
        body: (async function* generate() {
          for (const chunk of chunks) yield chunk;
        })(),
      };
    }

    if (message.path === "/api/diagnostic") return { status: 204 };

    if (message.path === "/api/extension-ui/response") {
      return { status: 200, body: JSON.stringify({ ok: true }) };
    }

    return { status: 404, body: JSON.stringify({ error: `no route ${message.path}` }) };
  };

  return { dispatch, calls };
}

/** Run `fn` with the loopback transport installed and `fetch` booby-trapped. */
async function withLoopback<T>(fn: (bridge: ReturnType<typeof inProcessBridge>) => Promise<T>): Promise<T> {
  const bridge = inProcessBridge();
  const originalFetch = globalThis.fetch;
  setBridgeTransport(createLoopbackBridgeTransport({ dispatch: bridge.dispatch }));
  globalThis.fetch = (() => {
    throw new Error("the in-process transport must not touch fetch");
  }) as unknown as typeof fetch;
  try {
    return await fn(bridge);
  } finally {
    globalThis.fetch = originalFetch;
    setBridgeTransport(null);
  }
}

test("握手与快照走通路：上层代码一行没改就跑在非 HTTP 实现上", async () => {
  await withLoopback(async (bridge) => {
    const snapshot = await fetchBootstrap({ force: true });
    assert.equal(snapshot?.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(
      bridge.calls.map((call) => call.path),
      ["/api/protocol", "/api/bootstrap"],
      "先握手再搬大包（顺序也是契约的一部分）",
    );
  });
});

test("ETag / 304 语义在第二套实现里一样：第二次拿快照得到 null", async () => {
  await withLoopback(async () => {
    const first = await fetchBootstrap({ force: true });
    assert.ok(first, "第一次拿到正文");
    const revalidated = await fetchBootstrap();
    assert.equal(revalidated, null, "304 必须表达成 null（调用方据此保留旧快照）");
    const forced = await fetchBootstrap({ force: true });
    assert.ok(forced, "force 跳过条件请求");
  });
});

test("POST 的 body 由 transport 负责序列化（上层只给对象）", async () => {
  await withLoopback(async (bridge) => {
    await postJson("/api/extension-ui/response", { text: "hi", sessionId: "s1" });
    const call = bridge.calls.at(-1)!;
    assert.equal(call.method, "POST");
    assert.equal(call.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(call.body)), { text: "hi", sessionId: "s1" });
  });
});

test("NDJSON 分帧一致：逐行回调，坏行变成 error 事件而不是截断整轮", async () => {
  const events: unknown[] = [];
  await withLoopback(async () => {
    await streamNdjson("/api/prompt", { text: "hi" }, (event) => events.push(event));
  });
  assert.deepEqual(events, [
    { type: "delta", text: "hel" },
    { type: "delta", text: "lo" },
    { type: "error", message: "not json at all" },
    { type: "done" },
  ]);
});

test("错误体里的 error 字段被抽成人话抛出来（不是整串 JSON）", async () => {
  await withLoopback(async () => {
    await assert.rejects(() => fetchJson("/api/nope"), /no route \/api\/nope/);
  });
});

test("fireAndForget 类的诊断上报不会抛，也不要求 2xx 正文", async () => {
  // 诊断上报默认是关的（要服务端显式打开），这里打开它才谈得上「走没走 transport」。
  const previous = process.env.VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED;
  process.env.VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED = "1";
  await withLoopback(async (bridge) => {
    reportDiagnostic("client.test.event", { ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    const call = bridge.calls.at(-1);
    assert.equal(call?.method, "POST", "诊断必须真的发出去");
    assert.match(String(call?.body), /client\.test\.event/);
  });
  if (previous === undefined) delete process.env.VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED;
  else process.env.VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED = previous;
});

test("环境变量 / localStorage 之外的东西没被偷偷依赖：整套流程里 fetch 一次都没被调用", async () => {
  // withLoopback 把 fetch 换成了会抛的函数，所以这条用例能通过本身就是断言。
  await withLoopback(async (bridge) => {
    await fetchBootstrap({ force: true });
    await postJson("/api/extension-ui/response", { text: "x" });
    assert.ok(bridge.calls.length >= 2);
  });
});