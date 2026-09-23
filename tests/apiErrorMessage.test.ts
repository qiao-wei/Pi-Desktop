/**
 * 桥报错进红框前的最后一道：`src/lib/api.ts` 的 `readError`。
 *
 * 桥的错误体是 `{"error":"..."}`。以前把整串 JSON 当 message 抛出去，设置页红框里
 * 就是一堆引号（`{"error":"Base URL is required."}`），用户不知道该做什么。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { fetchJson, postJson } from "../src/lib/api.ts";

function fakeResponse({ status = 200, ok = status < 400, body = "", headers = {} }) {
  return {
    ok,
    status,
    statusText: "Internal Server Error",
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

async function withFetch(response, run) {
  const original = globalThis.fetch;
  // 记下发出去的请求，顺手确认调用方没把 body 弄丢。
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return response;
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("错误体是 {\"error\":\"...\"} 时，抛出去的是那句话本身", async () => {
  await withFetch(fakeResponse({ status: 500, body: '{"error":"Base URL is required."}' }), async () => {
    await assert.rejects(() => postJson("/api/custom-models", {}), (error) => {
      assert.equal(error.message, "Base URL is required.");
      return true;
    });
  });
});

test("`message` 字段也认；两个字段都没有就退回原文", async () => {
  await withFetch(fakeResponse({ status: 400, body: '{"message":"Nope."}' }), async () => {
    await assert.rejects(() => postJson("/api/x", {}), /^Error: Nope\.$/);
  });
  await withFetch(fakeResponse({ status: 400, body: '{"code":"weird"}' }), async () => {
    await assert.rejects(() => postJson("/api/x", {}), /^Error: \{"code":"weird"\}$/);
  });
  await withFetch(fakeResponse({ status: 400, body: '{"error":"   "}' }), async () => {
    await assert.rejects(() => postJson("/api/x", {}), /^Error: \{"error":"   "\}$/);
  });
});

test("非 JSON 的错误体（反代的 HTML 页）原样给出，别吞掉", async () => {
  await withFetch(fakeResponse({ status: 502, body: "<html>502 Bad Gateway</html>" }), async () => {
    await assert.rejects(() => postJson("/api/x", {}), /502 Bad Gateway/);
  });
});

test("完全没 body 时退回状态码行", async () => {
  await withFetch(fakeResponse({ status: 500, body: "" }), async () => {
    await assert.rejects(() => postJson("/api/x", {}), /^Error: 500 Internal Server Error$/);
  });
});

test("成功响应不受影响：照常解析 JSON，带 body 的请求仍然发 Content-Type", async () => {
  await withFetch(fakeResponse({ status: 200, body: '{"ok":true}' }), async (calls) => {
    assert.deepEqual(await postJson("/api/custom-models", { a: 1 }), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    // 无 body 的 GET 不发 Content-Type：那是每次预检的代价。
    await fetchJson("/api/custom-models");
    assert.deepEqual(calls[1].init.headers, {});
  });
});
