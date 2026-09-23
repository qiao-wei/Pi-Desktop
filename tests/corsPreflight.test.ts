import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import { ALLOWED_REQUEST_HEADERS, respondToPreflight, setCors } from "../server/cors.mjs";
import { fetchBootstrap } from "../src/lib/api.ts";

/**
 * 现象：会话结束后前端 console 报
 *   Access to fetch at 'http://127.0.0.1:6474/api/bootstrap' from origin
 *   'http://127.0.0.1:5176' has been blocked by CORS policy: Request header field
 *   if-none-match is not allowed by Access-Control-Allow-Headers in preflight response.
 *
 * `/api/bootstrap` 的条件请求带 `If-None-Match`，它不是 CORS-safelisted 请求头，
 * 所以必须先过 preflight；白名单漏了它就整个请求被拦成 net::ERR_FAILED。
 */

const SAFELISTED_NAMES = new Set(["accept", "accept-language", "content-language"]);
const SAFELISTED_CONTENT_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);

/** Would this header force the request into a preflight? */
function isSafelisted(name: string, value: string): boolean {
  const key = name.toLowerCase();
  if (key === "content-type") {
    return SAFELISTED_CONTENT_TYPES.has(value.toLowerCase());
  }
  return SAFELISTED_NAMES.has(key);
}

/** Browser-equivalent check: does the preflight response allow every requested header? */
function blockedHeaders(allowHeader: string | null, requested: Iterable<string>): string[] {
  const allowed = new Set(
    (allowHeader ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowed.has("*")) {
    return [];
  }
  return [...requested].filter((name) => !allowed.has(name.toLowerCase()));
}

async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    setCors(res);
    if (respondToPreflight(req, res)) {
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

test("preflight allows If-None-Match, so conditional bootstrap GETs are not blocked", async () => {
  const { base, close } = await startServer();
  try {
    const response = await fetch(`${base}/api/bootstrap`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:5176",
        "Access-Control-Request-Method": "GET",
        // What the app actually asks for when it revalidates.
        "Access-Control-Request-Headers": "content-type, if-none-match",
      },
    });

    assert.equal(response.status, 204);
    assert.deepEqual(
      blockedHeaders(response.headers.get("access-control-allow-headers"), [
        "content-type",
        "if-none-match",
      ]),
      [],
    );
    assert.match(response.headers.get("access-control-allow-methods") ?? "", /GET/i);
    assert.ok(
      Number(response.headers.get("access-control-max-age")) > 0,
      "the polled bootstrap route should cache its preflight",
    );
  } finally {
    await close();
  }
});

test("preflight policy stays explicit instead of reflecting any requested header", async () => {
  const { base, close } = await startServer();
  try {
    const response = await fetch(`${base}/api/bootstrap`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:5176",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-some-app-header",
      },
    });
    assert.deepEqual(
      blockedHeaders(response.headers.get("access-control-allow-headers"), ["x-some-app-header"]),
      ["x-some-app-header"],
    );
  } finally {
    await close();
  }
});

test("every header the client sends is in the server allow-list", async () => {
  const calls: Array<Record<string, string>> = [];
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.VITE_PI_DESKTOP_API_BASE;
  process.env.VITE_PI_DESKTOP_API_BASE = "http://127.0.0.1:6474";
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    calls.push(Object.fromEntries(new Headers(init.headers as HeadersInit | undefined).entries()));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ETag: '"v1"' },
    });
  }) as typeof fetch;

  try {
    await fetchBootstrap({ force: true });
    await fetchBootstrap();
    // A 304 shortens the payload, so the cached body is what the caller keeps.
    globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
      calls.push(Object.fromEntries(new Headers(init.headers as HeadersInit | undefined).entries()));
      return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
    }) as typeof fetch;
    assert.equal(await fetchBootstrap(), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.VITE_PI_DESKTOP_API_BASE;
    } else {
      process.env.VITE_PI_DESKTOP_API_BASE = originalEnv;
    }
  }

  assert.equal(calls.length, 3);
  const [forced, revalidating, notModified] = calls;

  // `If-None-Match` needs the preflight allow-list; a bodyless GET must not drag
  // `Content-Type` along, or every poll pays for that preflight.
  assert.equal(forced["content-type"], undefined);
  assert.equal(revalidating["if-none-match"], '"v1"');
  assert.equal(notModified["if-none-match"], '"v1"');

  for (const headers of calls.values()) {
    const needsPreflight = Object.entries(headers).filter(([name, value]) => !isSafelisted(name, value));
    assert.deepEqual(
      blockedHeaders(
        ALLOWED_REQUEST_HEADERS.join(", "),
        needsPreflight.map(([name]) => name),
      ),
      [],
      `client sends headers the preflight would reject: ${needsPreflight.map(([name]) => name).join(", ")}`,
    );
  }
});
