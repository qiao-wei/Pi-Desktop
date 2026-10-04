/**
 * MCP 服务器表单的纯逻辑（src/shared/mcpForm.ts）。
 *
 * 重点是「transport-aware 载荷」：服务端 upsert 是整条替换，表单如果把另一路的
 * 字段一起发过去，就会把旧配置的残渣写回 mcp.json。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMcpServerPayload,
  pruneToolExposure,
  recordToRows,
  rowsToRecord,
  type McpServerFormInput,
} from "../src/shared/mcpForm.ts";

function form(overrides: Partial<McpServerFormInput> = {}): McpServerFormInput {
  return {
    name: "  fake-mcp  ",
    scope: "user",
    transport: "stdio",
    enabled: true,
    exposure: "codemode",
    description: "  a fake  ",
    command: "  npx  ",
    args: "-y @scope/server --flag",
    cwd: "  /tmp/work  ",
    url: "  https://example.test/mcp  ",
    env: [{ key: "TOKEN", value: "abc" }],
    headers: [{ key: "X-Key", value: "v" }],
    toolExposure: {},
    ...overrides,
  };
}

/* ------------------------------- 行 ↔ 对象 ------------------------------- */

test("recordToRows keeps insertion order and pairs keys with values", () => {
  assert.deepEqual(recordToRows({ A: "1", B: "2" }), [
    { key: "A", value: "1" },
    { key: "B", value: "2" },
  ]);
  assert.deepEqual(recordToRows(undefined), []);
});

test("rowsToRecord trims keys, drops blank keys, keeps blank values", () => {
  assert.deepEqual(
    rowsToRecord([
      { key: " A ", value: "1" },
      { key: "   ", value: "orphan" },
      { key: "EMPTY", value: "" },
    ]),
    { A: "1", EMPTY: "" },
  );
});

test("rows round-trip through recordToRows without loss", () => {
  const record = { TOKEN: "abc", EMPTY: "" };
  assert.deepEqual(rowsToRecord(recordToRows(record)), record);
});

/* --------------------------------- 载荷 --------------------------------- */

test("an stdio payload carries only stdio fields", () => {
  const payload = buildMcpServerPayload(form());

  assert.deepEqual(payload, {
    originalId: undefined,
    name: "fake-mcp",
    scope: "user",
    transport: "stdio",
    enabled: true,
    description: "a fake",
    exposure: "codemode",
    toolExposure: {},
    command: "npx",
    args: "-y @scope/server --flag",
    cwd: "/tmp/work",
    env: { TOKEN: "abc" },
  });
  // 另一个 transport 的字段一个都不许出现。
  assert.ok(!("url" in payload));
  assert.ok(!("headers" in payload));
});

test("an http payload carries only http fields", () => {
  const payload = buildMcpServerPayload(form({ transport: "http" }));

  assert.equal(payload.url, "https://example.test/mcp");
  assert.deepEqual(payload.headers, { "X-Key": "v" });
  assert.deepEqual(payload.env, undefined);
  assert.ok(!("command" in payload));
  assert.ok(!("args" in payload));
  assert.ok(!("cwd" in payload));
});

test("switching to http drops the stdio fields that were still in the form", () => {
  // 用户先填了 stdio，又改成 http 才保存：旧命令不能跟着过去。
  const payload = buildMcpServerPayload(form({ transport: "http", url: "https://x.test/mcp" }));
  for (const key of ["command", "args", "cwd", "env"]) {
    assert.ok(!(key in payload), `${key} 不该出现在 http 载荷里`);
  }
});

test("extras from an imported config are forwarded so oauth survives the form", () => {
  const withExtras = buildMcpServerPayload(form({ extras: { oauth: { clientId: "c" } } }));
  assert.deepEqual(withExtras.extras, { oauth: { clientId: "c" } });
  // 空 extras 不往载荷里塞多余键。
  assert.ok(!("extras" in buildMcpServerPayload(form({ extras: {} }))));
  assert.ok(!("extras" in buildMcpServerPayload(form())));
});

test("editing keeps the original id so the server can drop the old entry on rename", () => {
  const payload = buildMcpServerPayload(form({ originalId: "project:old-name", name: "new-name", scope: "project" }));
  assert.equal(payload.originalId, "project:old-name");
  assert.equal(payload.name, "new-name");
  assert.equal(payload.scope, "project");
});

test("an empty exposure falls through to the server default instead of being written", () => {
  const payload = buildMcpServerPayload(form({ exposure: "" }));
  assert.ok(!("exposure" in payload));
});

test("tool exposure overrides are pruned before they reach mcp.json", () => {
  const payload = buildMcpServerPayload(form({
    toolExposure: { echo: "direct", blank: "", "": "hidden" },
  }));
  assert.deepEqual(payload.toolExposure, { echo: "direct" });
  assert.deepEqual(pruneToolExposure({}), {});
});

test("enabled=false survives even though it is the only field pi writes as a negative", () => {
  assert.equal(buildMcpServerPayload(form({ enabled: false })).enabled, false);
});