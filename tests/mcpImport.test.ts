/**
 * MCP 配置导入（`server/mcpImport.mjs`）。
 *
 * 这组用例钉住两件事：
 * 1. **自动识别**：`mcpServers` / VS Code `servers` / Zed `context_servers` / 嵌套 `mcp.servers` /
 *    单条目 / 裸表 / 数组，七种形状都要认出并给出正确的 format 代号；
 * 2. **归一化**：传输方式、`command` 的三种写法、args 字符串、env 别名、非法/危险值（SSE、
 *    模板变量）要按 pi 的语义落到 `mcpServers` 条目上，且 `oauth` 这类字段不能在导入时丢掉。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  detectMcpImportShape,
  parseMcpImportText,
  sanitizeImportedName,
  splitCommandString,
} from "../server/mcpImport.mjs";

function byName(parsed: any) {
  return Object.fromEntries(parsed.servers.map((item: any) => [item.name, item]));
}

test("splitCommandString：认单双引号，带空格的参数不拆开", () => {
  assert.deepEqual(splitCommandString("npx -y @scope/server"), ["npx", "-y", "@scope/server"]);
  assert.deepEqual(splitCommandString('node "a b.js" --flag'), ["node", "a b.js", "--flag"]);
  assert.deepEqual(splitCommandString("'x y'"), ["x y"]);
  assert.deepEqual(splitCommandString("   "), []);
});

test("sanitizeImportedName：非法字符换成连字符，救不回来返回空串", () => {
  assert.equal(sanitizeImportedName("teambition-mcp"), "teambition-mcp");
  assert.equal(sanitizeImportedName(" My Server! "), "My-Server");
  assert.equal(sanitizeImportedName("123 API"), "123-API");
  assert.equal(sanitizeImportedName("!!!"), "");
  assert.equal(sanitizeImportedName(""), "");
});

test("detectMcpImportShape：七种顶层形状", () => {
  assert.equal(detectMcpImportShape({ mcpServers: { a: { command: "x" } } })?.format, "mcp-servers");
  assert.equal(detectMcpImportShape({ servers: { a: { type: "stdio", command: "x" } } })?.format, "vscode");
  assert.equal(detectMcpImportShape({ context_servers: { a: { command: "x" } } })?.format, "zed");
  assert.equal(detectMcpImportShape({ mcp: { servers: { a: { command: "x" } } } })?.format, "mcp");
  assert.equal(detectMcpImportShape({ command: "npx", args: [] })?.format, "single");
  assert.equal(detectMcpImportShape({ a: { command: "x" } })?.format, "map");
  assert.equal(detectMcpImportShape([{ name: "a", command: "x" }])?.format, "list");
  assert.equal(detectMcpImportShape({ foo: "bar" }), null);
  assert.equal(detectMcpImportShape("nope"), null);
});

test("Claude / Cursor 的 mcpServers：stdio 与 http 都能翻译", () => {
  const parsed = parseMcpImportText(JSON.stringify({
    mcpServers: {
      fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], env: { ROOT: "/tmp" } },
      docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
    },
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, "mcp-servers");
  assert.deepEqual(parsed.errors, []);

  const map = byName(parsed);
  assert.equal(map.fs.server.transport, "stdio");
  assert.deepEqual(map.fs.entry, {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    env: { ROOT: "/tmp" },
  });
  assert.equal(map.docs.server.transport, "http");
  assert.deepEqual(map.docs.entry, { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } });
});

test("VS Code 的 servers + type：stdio / http 各自落对字段", () => {
  const parsed = parseMcpImportText(JSON.stringify({
    inputs: [{ id: "token", type: "promptString" }],
    servers: {
      local: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
      remote: { type: "http", url: "https://mcp.example.com/mcp" },
    },
  }));
  assert.equal(parsed.format, "vscode");
  const map = byName(parsed);
  assert.equal(map.local.server.transport, "stdio");
  assert.deepEqual(map.local.entry, { command: "uvx", args: ["mcp-server-fetch"] });
  assert.equal(map.remote.server.transport, "http");
  assert.deepEqual(map.remote.entry, { url: "https://mcp.example.com/mcp" });
});

test("Zed 的 context_servers：command 是字符串或对象都要认", () => {
  const parsed = parseMcpImportText(JSON.stringify({
    context_servers: {
      stringy: { source: "custom", command: "npx", args: ["-y", "foo"], env: { A: "1" } },
      objecty: { source: "custom", command: { path: "node", args: ["server.js"], env: { B: "2" } } },
    },
  }));
  assert.equal(parsed.format, "zed");
  const map = byName(parsed);
  assert.deepEqual(map.stringy.entry, { command: "npx", args: ["-y", "foo"], env: { A: "1" } });
  assert.deepEqual(map.objecty.entry, { command: "node", args: ["server.js"], env: { B: "2" } });
  // `source` 是 Zed 的内部字段，翻译后不该写回 pi 的 mcp.json。
  assert.equal("source" in map.objecty.entry, false);
});

test("OpenCode 风格：嵌套 mcp.servers、command 数组、environment 别名", () => {
  const parsed = parseMcpImportText(JSON.stringify({
    mcp: {
      servers: {
        demo: { type: "local", command: ["npx", "-y", "demo-server"], environment: { TOKEN: "t" } },
        web: { type: "remote", url: "https://demo/mcp", headers: { "X-Key": "k" } },
      },
    },
  }));
  assert.equal(parsed.format, "mcp");
  const map = byName(parsed);
  assert.deepEqual(map.demo.entry, { command: "npx", args: ["-y", "demo-server"], env: { TOKEN: "t" } });
  assert.deepEqual(map.web.entry, { url: "https://demo/mcp", headers: { "X-Key": "k" } });
});

test("单条目 / 裸表 / 数组：名字能推断就推断，推断不出用 defaultName", () => {
  const single = parseMcpImportText(JSON.stringify({ command: "npx", args: ["-y", "solo"] }), { defaultName: "my-config" });
  assert.equal(single.format, "single");
  assert.deepEqual(single.servers.map((item: any) => item.name), ["my-config"]);

  const named = parseMcpImportText(JSON.stringify({ name: "explicit", command: "npx" }));
  assert.deepEqual(named.servers.map((item: any) => item.name), ["explicit"]);

  const list = parseMcpImportText(JSON.stringify([
    { name: "one", command: "a" },
    { id: "two", url: "https://two/mcp" },
  ]));
  assert.equal(list.format, "list");
  assert.deepEqual(list.servers.map((item: any) => item.name), ["one", "two"]);

  const bare = parseMcpImportText(JSON.stringify({ alpha: { command: "a" }, beta: { url: "https://b/mcp" } }));
  assert.equal(bare.format, "map");
  assert.deepEqual(bare.servers.map((item: any) => item.name), ["alpha", "beta"]);
});

test("command 是一整串时拆成 command + args", () => {
  const parsed = parseMcpImportText(JSON.stringify({ mcpServers: { s: { command: "npx -y @scope/pkg --flag" } } }));
  const server = byName(parsed).s;
  assert.deepEqual(server.entry, { command: "npx", args: ["-y", "@scope/pkg", "--flag"] });
  assert.ok(parsed.warnings.some((warning: string) => /inline command/.test(warning)));
});

test("SSE 被明确拒绝，但其它条目照常导入", () => {
  const parsed = parseMcpImportText(JSON.stringify({
    mcpServers: {
      good: { command: "node" },
      old: { type: "sse", url: "https://x/sse" },
    },
  }));
  assert.deepEqual(parsed.servers.map((item: any) => item.name), ["good"]);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0], /legacy SSE/);
});

test("模板变量 URL 拒绝，模板变量 command/args 只警告", () => {
  const bad = parseMcpImportText(JSON.stringify({
    servers: { remote: { type: "http", url: "https://x/${input:host}/mcp" } },
  }));
  assert.equal(bad.servers.length, 0);
  assert.match(bad.errors[0], /template variable/);

  const ok = parseMcpImportText(JSON.stringify({
    mcpServers: { local: { command: "node", args: ["server.js", "${workspaceFolder}"] } },
  }));
  assert.equal(ok.servers.length, 1);
  assert.ok(ok.warnings.some((warning: string) => /placeholder/.test(warning)));
});

test("非法名字被归一化 / 重复名字报错", () => {
  const parsed = parseMcpImportText(JSON.stringify({
    mcpServers: {
      "My Server!": { command: "node" },
      "My-Server!": { command: "node" },
      "!!!": { command: "node" },
    },
  }));
  assert.deepEqual(parsed.servers.map((item: any) => item.name), ["My-Server"]);
  assert.ok(parsed.warnings.some((warning: string) => /normalized/.test(warning)));
  assert.equal(parsed.errors.filter((error: string) => /duplicate/.test(error)).length, 1);
  assert.equal(parsed.errors.filter((error: string) => /invalid server name/.test(error)).length, 1);
});

test("pi 认识的未知字段（oauth）收进 extras，别家字段不写回", () => {
  const parsed = parseMcpImportText(JSON.stringify({
    mcpServers: {
      authy: {
        type: "http",
        url: "https://authy/mcp",
        oauth: { clientId: "c", scope: "s" },
        envFile: ".env.local",
        inputs: [],
      },
    },
  }));
  const item = byName(parsed).authy;
  assert.deepEqual(item.entry.oauth, { clientId: "c", scope: "s" });
  // 表单只带 extras，保存时经 `/mcp/save` 原样写回。
  assert.deepEqual(item.extras, { oauth: { clientId: "c", scope: "s" } });
  assert.equal("type" in item.entry, false);
  assert.equal("envFile" in item.entry, false);
  assert.equal("inputs" in item.entry, false);
  assert.equal(item.server.hasOAuth, true);
});

test("exposure / enabled / timeout：合法值落盘，非法值只警告不写", () => {
  const parsed = parseMcpImportText(JSON.stringify({
    mcpServers: {
      tuned: { command: "node", exposure: "direct", toolExposure: { danger: "hidden", weird: "nope" }, disabled: true, timeout: 30 },
      broken: { command: "node", exposure: "nope", timeout: -1 },
    },
  }));
  const map = byName(parsed);
  assert.deepEqual(map.tuned.entry, {
    command: "node",
    exposure: "direct",
    toolExposure: { danger: "hidden" },
    enabled: false,
    timeout: 30,
  });
  assert.deepEqual(map.broken.entry, { command: "node" });
  assert.ok(parsed.warnings.some((warning: string) => /unknown exposure "nope"/.test(warning)));
  assert.ok(parsed.warnings.some((warning: string) => /invalid timeout/.test(warning)));
});

test("空文件 / 坏 JSON / 认不出的结构：ok=false 带原因", () => {
  assert.equal(parseMcpImportText("   ").ok, false);
  assert.match(parseMcpImportText("{not json").errors[0], /not valid JSON/);
  assert.match(parseMcpImportText(JSON.stringify({ foo: 1 })).errors[0], /Unrecognized/);
});
