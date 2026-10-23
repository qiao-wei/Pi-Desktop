/**
 * Boundary `perf`: the probe is a port now, not a global that happens to exist.
 *
 * The interesting case is the second one: install a fake probe, drive the **real** HTTP transport's
 * `/api/bootstrap` request with a stubbed `fetch`, and assert the marks the transport produced. That
 * is the difference between "there is an interface" and "the request path is measurably replaceable".
 * Before, the only way to observe this was to create a `globalThis.__piDesktopPerf` and hope the
 * transport looked it up.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { activePerfPort, getPerfPort, setPerfPort } from "../src/lib/perf-port.ts";
import type { PerfPort } from "../src/shared/protocol/perf.ts";
import { createHttpBridgeTransport, setBridgeTransport } from "../src/lib/bridge/transport.ts";

function recordingProbe(enabled = true): PerfPort & { marks: { name: string; ms: number; detail: unknown }[] } {
  const marks: { name: string; ms: number; detail: unknown }[] = [];
  return {
    marks,
    enabled,
    mark(name, ms, detail) {
      marks.push({ name, ms, detail });
    },
  };
}

/** Minimal `fetch` stand-in: one JSON body, recording what was requested. */
function withFetch<T>(body: unknown, fn: (urls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", etag: 'W/"1"' },
    });
  }) as unknown as typeof fetch;
  return fn(urls).finally(() => {
    globalThis.fetch = original;
  });
}

test("装上的端口可以被读到；卸掉之后没有探针", () => {
  const probe = recordingProbe();
  setPerfPort(probe);
  try {
    assert.equal(getPerfPort(), probe);
    assert.equal(activePerfPort(), probe);
  } finally {
    setPerfPort(null);
  }
  assert.equal(getPerfPort(), null, "卸掉之后不该残留");
  assert.equal(activePerfPort(), null);
});

test("enabled=false 的探针不算数（测量必须是显式打开的）", () => {
  setPerfPort(recordingProbe(false));
  try {
    assert.equal(activePerfPort(), null, "关着的探针不参与");
  } finally {
    setPerfPort(null);
  }
});

test("真实 transport 在 /api/bootstrap 上把耗时打给装上的探针（换实现即有测量）", async () => {
  const probe = recordingProbe();
  const transport = createHttpBridgeTransport("http://127.0.0.1:1");
  setBridgeTransport(transport);
  setPerfPort(probe);
  try {
    await withFetch({ ok: true }, async () => {
      await transport.request("/api/bootstrap", { method: "POST", body: {} });
      await transport.request("/api/ping");
      return null;
    });
  } finally {
    setPerfPort(null);
    setBridgeTransport(null);
  }

  const names = probe.marks.map((mark) => mark.name);
  assert.ok(names.includes("bootstrap.fetch"), `bootstrap 必须被计时，实际记录：${names.join(",")}`);
  const mark = probe.marks.find((entry) => entry.name === "bootstrap.fetch")!;
  assert.equal(typeof mark.ms, "number");
  assert.ok(Number.isFinite(mark.ms), "耗时必须是有限数");
  assert.ok(
    !probe.marks.some((entry) => String(entry.detail ?? "").includes("/api/ping")),
    "非 bootstrap 路径不该被计时（这是启动路径的测量，不是全量埋点）",
  );
});

test("没装探针时请求路径照常工作（测量缺席不是错误）", async () => {
  const transport = createHttpBridgeTransport("http://127.0.0.1:1");
  setBridgeTransport(transport);
  setPerfPort(null);
  try {
    const result = await withFetch({ ok: 1 }, () => transport.request<{ ok: number }>("/api/bootstrap", { body: {} }));
    assert.deepEqual(result, { ok: 1 });
  } finally {
    setBridgeTransport(null);
  }
});