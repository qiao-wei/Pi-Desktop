/**
 * 边界 `bridge` 的一致性与握手行为。
 *
 * 这里回答"协议是不是真的"：
 * - 两侧版本号字面量相等（改一侧不行）；
 * - 冻结表面既不能少一条客户端调用，也不能少一条桥路由；
 * - 握手分类函数在 `missing / older / newer / ok` 四种情况下都正确（含边界值）；
 * - `fetchBootstrap` 真的会在搬大包之前先握手，并且在版本不对时抛错而不是静默继续。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PROTOCOL_VERSION,
  checkProtocolCompatibility,
  protocolMismatch,
  protocolMismatchMessage,
} from "../src/shared/protocol/version.ts";
import {
  BRIDGE_ENDPOINTS,
  BRIDGE_ENDPOINTS_BY_PATH,
} from "../src/shared/protocol/bridgeEndpoints.ts";
import { setBridgeTransport } from "../src/lib/bridge/transport.ts";
import { fetchBootstrap, postJson, probeBridgeProtocol } from "../src/lib/api.ts";
import { REPO_ROOT, extractBridgeRoutes, loadPolicy } from "../scripts/architecture/check.mjs";
import { bridgeSource } from "./lib/bridgeSource.ts";

const policy = loadPolicy(REPO_ROOT);

function fakeTransport({ responses = {}, onRequest } = {}) {
  const calls = [];
  return {
    apiBase: "http://test.invalid",
    calls,
    async request(path, init) {
      calls.push({ path, method: init?.method ?? "GET", headers: init?.headers ?? {} });
      if (onRequest) onRequest(path, init);
      const value = responses[path];
      return typeof value === "function" ? value() : (value ?? null);
    },
    lastEtag: () => undefined,
    async stream(path, body, onEvent) {
      calls.push({ path, method: "POST" });
      for (const event of responses.stream ?? []) onEvent(event);
    },
    fireAndForget(path, body) {
      calls.push({ path, method: "POST" });
    },
  };
}

test("版本号两侧字面量相等，且是一个正整数", () => {
  const mirror = readFileSync(join(REPO_ROOT, "server/protocolVersion.mjs"), "utf8");
  const mirrored = Number(mirror.match(/PROTOCOL_VERSION\s*=\s*(\d+)/)[1]);
  assert.equal(mirrored, PROTOCOL_VERSION);
  assert.ok(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION > 0);
});

test("握手分类：相等是 ok，缺字段是 missing，低于/高于都算不兼容", () => {
  assert.equal(checkProtocolCompatibility(PROTOCOL_VERSION), "ok");
  assert.equal(checkProtocolCompatibility(PROTOCOL_VERSION - 1), "older");
  assert.equal(checkProtocolCompatibility(PROTOCOL_VERSION + 1), "newer", "新桥也不算兼容：渲染进程只认识自己构建时的形状");
  assert.equal(checkProtocolCompatibility(undefined), "missing");
  assert.equal(checkProtocolCompatibility(null), "missing");
  assert.equal(checkProtocolCompatibility(Number.NaN), "missing");
  assert.equal(checkProtocolCompatibility(0), "older");
});

test("不兼容时给出可操作的文案，兼容时为 null", () => {
  assert.equal(protocolMismatch(PROTOCOL_VERSION), null);
  for (const announced of [undefined, PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1]) {
    const mismatch = protocolMismatch(announced);
    assert.ok(mismatch, `announced=${String(announced)} 应该不兼容`);
    assert.match(mismatch.message, /Protocol mismatch/);
    assert.match(mismatch.message, new RegExp(`v?${PROTOCOL_VERSION}`));
    assert.equal(mismatch.message, protocolMismatchMessage(mismatch.compatibility, announced));
  }
});

test("手写核心端点都在桥里实现，路径不重复", () => {
  const routes = extractBridgeRoutes(bridgeSource());
  const seen = new Set();
  for (const endpoint of Object.values(BRIDGE_ENDPOINTS)) {
    assert.equal(seen.has(endpoint.path), false, `重复声明: ${endpoint.path}`);
    seen.add(endpoint.path);
    const path = endpoint.path.replace(/\?.*$/, "");
    assert.ok(
      [...routes.keys()].some((pattern) => pattern === path || pattern.startsWith(path)),
      `${endpoint.path} 在 bridge 里没有对应路由`,
    );
    assert.ok(endpoint.since <= PROTOCOL_VERSION, `${endpoint.path} 的 since 超过了当前版本`);
    assert.ok(endpoint.summary.length > 8, `${endpoint.path} 缺少可读说明`);
  }
  assert.equal(BRIDGE_ENDPOINTS_BY_PATH["/api/bootstrap"].transport, "json");
  assert.equal(BRIDGE_ENDPOINTS.prompt.transport, "ndjson");
});

test("冻结表面覆盖两个方向（客户端调用点 与 桥路由）", () => {
  const surface = JSON.parse(
    readFileSync(join(REPO_ROOT, "architecture/generated/bridge-surface.json"), "utf8"),
  ).routes;
  const routes = extractBridgeRoutes(bridgeSource());

  const missingClientPaths = Object.keys(surface).filter((path) => !surface[path].callers.length);
  // bridge-only 路由是允许的（attachment/local-media 这类由 <img src> 直接取），但必须标明是桥侧亲口应答的。
  for (const path of missingClientPaths) {
    assert.equal(surface[path].bridge, true, `${path} 既没有调用点，桥也不应答`);
  }
  for (const [pattern] of routes) {
    if (pattern.includes("*")) continue;
    assert.ok(surface[pattern], `桥路由 ${pattern} 不在冻结表面里`);
  }
});

test("fetchBootstrap 先握手再搬包；版本不对时抛错而不是继续", async () => {
  const good = fakeTransport({
    responses: {
      "/api/protocol": { protocolVersion: PROTOCOL_VERSION, pid: 123 },
      "/api/bootstrap": { protocolVersion: PROTOCOL_VERSION, snapshot: {}, projects: [] },
    },
  });
  setBridgeTransport(good);
  const snapshot = await fetchBootstrap({ force: true });
  assert.deepEqual(
    good.calls.map((call) => call.path),
    ["/api/protocol", "/api/bootstrap"],
    "握手必须发生在 bootstrap 之前",
  );
  assert.ok(snapshot);

  // 同一个 transport 只问一次
  await fetchBootstrap({ force: true });
  assert.equal(good.calls.filter((call) => call.path === "/api/protocol").length, 1);

  // 旧桥：没有 protocolVersion
  setBridgeTransport(
    fakeTransport({
      responses: { "/api/protocol": { pid: 1 }, "/api/bootstrap": { snapshot: {} } },
    }),
  );
  await assert.rejects(() => fetchBootstrap({ force: true }), /Protocol mismatch/);

  // 版本落后
  setBridgeTransport(
    fakeTransport({
      responses: {
        "/api/protocol": { protocolVersion: PROTOCOL_VERSION - 1 },
        "/api/bootstrap": { protocolVersion: PROTOCOL_VERSION - 1 },
      },
    }),
  );
  await assert.rejects(() => probeBridgeProtocol(), /Protocol mismatch/);

  setBridgeTransport(null);
});

test("postJson 走 transport，未安装 transport 时报错而不是静默", async () => {
  const transport = fakeTransport({ responses: { "/api/x": { ok: true } } });
  setBridgeTransport(transport);
  assert.deepEqual(await postJson("/api/x", { a: 1 }), { ok: true });
  assert.equal(transport.calls[0].method, "POST");

  setBridgeTransport(null);
  await assert.rejects(() => postJson("/api/x", {}), /transport not installed/);
});

test("协议模块声明了 4 条边界，且每条都有契约、文档锚点与一致性测试", () => {
  // 2026-10-22：4 → 7。C 组把已经可替换的边界也登记成协议：perf（原来是 globalThis 上的隐式协议）、
  // local-store（渲染进程本地存储）、locale（语言偏好）。断言从「数量」改成「集合 + 每条都要有证据」——
  // 数量本身不是契约，「哪些边界、有没有契约/换实现说明/一致性测试」才是。
  const ids = policy.protocols.map((protocol) => protocol.id).sort();
  assert.deepEqual(ids, ["bridge", "kernel-adapter", "locale", "local-store", "perf", "shell", "storage"].sort());
  for (const protocol of policy.protocols) {
    assert.ok(protocol.contract, `${protocol.id} 缺契约文件`);
    assert.ok(protocol.swap?.length > 20, `${protocol.id} 没有写"换实现"的做法`);
    assert.ok(protocol.conformance?.startsWith("tests/"), `${protocol.id} 缺一致性测试`);
    assert.ok(readFileSync(join(REPO_ROOT, protocol.contract), "utf8").length > 0, `${protocol.contract} 不存在`);
  }
});