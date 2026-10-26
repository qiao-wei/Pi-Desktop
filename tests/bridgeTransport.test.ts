/**
 * 边界 `bridge` 的**可替换性**本身。
 *
 * "每层有协议、可轻松替换"如果只写在文档里，第一次改动就会失效。所以这里真的换掉 transport：
 * 上层（`postJson` / `streamNdjson` / `fetchBootstrap` / `reportDiagnostic`）在换实现后行为不变；
 * 同时验证 HTTP 那版 transport 自己的协议语义（304、ETag、错误文案、NDJSON 分帧、坏行不丢）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpBridgeTransport,
  getBridgeTransport,
  readBridgeErrorMessage,
  setBridgeTransport,
  type BridgeTransport,
} from "../src/lib/bridge/transport.ts";
import {
  fetchBootstrap,
  postJson,
  reportDiagnostic,
  streamNdjson,
} from "../src/lib/api.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol/version.ts";

/** 一个最小但完整的假实现：证明上层只依赖接口，不依赖 fetch。 */
class FakeTransport implements BridgeTransport {
  apiBase = "fake://bridge";
  readonly requests: string[] = [];
  readonly streams: string[] = [];
  readonly fireAndForgetCalls: string[] = [];
  private readonly etags = new Map<string, string>();
  responses = new Map<string, unknown>();

  async request<T>(path: string): Promise<T | null> {
    this.requests.push(path);
    const value = this.responses.get(path);
    return value === undefined ? null : (value as T);
  }

  lastEtag(path: string): string | undefined {
    return this.etags.get(path);
  }

  async stream<T>(path: string, _body: unknown, onEvent: (event: T) => void): Promise<void> {
    this.streams.push(path);
    onEvent({ type: "text_delta", text: "hi" } as T);
    onEvent({ type: "done" } as T);
  }

  fireAndForget(path: string): void {
    this.fireAndForgetCalls.push(path);
  }
}

function withFetch(response: unknown, run: (calls: Array<{ url: string; init: RequestInit }>) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return typeof response === "function" ? (response as (u: string, i: RequestInit) => unknown)(String(url), init) : response;
  }) as unknown as typeof fetch;
  return run(calls).finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse({ status = 200, body = "{}", etag = null as string | null }) {
  return {
    ok: status < 400,
    status,
    statusText: status === 304 ? "Not Modified" : "OK",
    headers: { get: (name: string) => (name.toLowerCase() === "etag" ? etag : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

test("换掉 transport 后，上层的四个入口行为不变", async () => {
  const fake = new FakeTransport();
  fake.responses.set("/api/protocol", { protocolVersion: PROTOCOL_VERSION });
  fake.responses.set("/api/bootstrap", { protocolVersion: PROTOCOL_VERSION, snapshot: { id: "s" } });
  fake.responses.set("/api/custom-models", { models: [] });
  setBridgeTransport(fake);

  try {
    assert.deepEqual(await postJson("/api/custom-models", { a: 1 }), { models: [] });

    const events: unknown[] = [];
    await streamNdjson("/api/prompt", { message: "hi" }, (event) => events.push(event));
    assert.deepEqual(events, [{ type: "text_delta", text: "hi" }, { type: "done" }]);

    const snapshot = await fetchBootstrap({ force: true });
    assert.deepEqual(snapshot, { protocolVersion: PROTOCOL_VERSION, snapshot: { id: "s" } });

    reportDiagnostic("arch.test", { ok: true });
    // 诊断默认关闭（VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED 未设）——开关打开时才发。
    assert.deepEqual(fake.fireAndForgetCalls, []);

    assert.deepEqual(fake.requests, ["/api/custom-models", "/api/protocol", "/api/bootstrap"]);
    assert.deepEqual(fake.streams, ["/api/prompt"]);
    assert.equal(getBridgeTransport(), fake);
  } finally {
    setBridgeTransport(null);
  }
});

test("HTTP transport：附带 ETag 的 304 返回 null（调用方保留已有状态）", async () => {
  const transport = createHttpBridgeTransport("http://127.0.0.1:6474");
  await withFetch(jsonResponse({ status: 304 }), async () => {
    assert.equal(await transport.request("/api/bootstrap"), null);
  });
  await withFetch(jsonResponse({ body: '{"a":1}', etag: '"v1"' }), async (calls) => {
    assert.deepEqual(await transport.request("/api/bootstrap"), { a: 1 });
    assert.equal(transport.lastEtag("/api/bootstrap"), '"v1"', "ETag 要留给下次条件请求");
    assert.equal(calls[0].url, "http://127.0.0.1:6474/api/bootstrap");
    assert.equal(calls[0].init.method, "GET");
  });
});

test("HTTP transport：无 body 的 GET 不带 Content-Type（否则每次轮询多一次预检）", async () => {
  const transport = createHttpBridgeTransport("http://127.0.0.1:6474");
  await withFetch(jsonResponse({ body: "[]" }), async (calls) => {
    await transport.request("/api/models");
    assert.equal(calls[0].init.headers, undefined);
  });
  await withFetch(jsonResponse({ body: "{}" }), async (calls) => {
    await transport.request("/api/models", { method: "POST", body: { a: 1 } });
    assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
    assert.equal(calls[0].init.body, '{"a":1}');
  });
});

test("HTTP transport：非 ok 抛出桥给的原文，不把整串 JSON 丢给用户", async () => {
  const transport = createHttpBridgeTransport("http://127.0.0.1:6474");
  await withFetch(jsonResponse({ status: 500, body: '{"error":"Base URL is required."}' }), async () => {
    await assert.rejects(() => transport.request("/api/x"), /^Error: Base URL is required\.$/);
  });
  await withFetch(jsonResponse({ status: 502, body: "<html>502</html>" }), async () => {
    await assert.rejects(() => transport.request("/api/x"), /<html>502<\/html>/);
  });
  assert.equal(await readBridgeErrorMessage({ status: 503, statusText: "Unavailable", text: async () => "" }), "503 Unavailable");
});

test("HTTP transport：NDJSON 逐行解析，坏行降级成 error 事件而不是丢弃整段", async () => {
  const transport = createHttpBridgeTransport("http://127.0.0.1:6474");
  const body = '{"type":"a"}\n{"type":"b"}\n{broken\n{"type":"c"}\n{"type":"tail"}';
  const chunks = [body.slice(0, 7), body.slice(7, 20), body.slice(20)];
  const streamResponse = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body,
    body: {
      getReader() {
        let index = 0;
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: new TextEncoder().encode(chunks[index++]) };
          },
        };
      },
    },
  };
  await withFetch(streamResponse, async () => {
    const events: unknown[] = [];
    await transport.stream("/api/prompt", { message: "x" }, (event) => events.push(event));
    assert.deepEqual(events, [
      { type: "a" },
      { type: "b" },
      { type: "error", message: "{broken" },
      { type: "c" },
      { type: "tail" },
    ]);
  });
});

test("fireAndForget 永远不会把错误抛回调用方", async () => {
  const transport = createHttpBridgeTransport("http://127.0.0.1:6474");
  await withFetch(() => { throw new Error("network down"); }, async () => {
    assert.doesNotThrow(() => transport.fireAndForget("/api/diagnostic", { event: "x" }));
  });
});

test("setBridgeTransport(null) 之后调用是响的，不是静默", async () => {
  setBridgeTransport(null);
  assert.throws(() => getBridgeTransport(), /transport not installed/);
});