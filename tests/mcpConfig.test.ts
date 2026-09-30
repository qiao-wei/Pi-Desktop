/**
 * pi 内置 MCP 的 `mcp.json` 读写（`server/mcpConfig.mjs`）。
 *
 * 这组用例钉住三件事：
 * 1. 解析要**和 pi 的 `validateMcpServerConfig` 对齐**——SSE 必须被拒、缺 command/url 必须被拒、
 *    非法条目跳过但不影响其它条目；
 * 2. 写回要保留文件里用户手写、UI 不认识的内容（`oauth` 等），否则编辑一次就丢配置；
 * 3. 全局/项目合并规则是「同名项目整体覆盖」，不是按字段合并。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_MCP_EXPOSURE,
  mcpConfigPath,
  mcpToolExposure,
  mergeMcpServerEntries,
  normalizeMcpServerName,
  parseMcpConfigText,
  patchMcpServer,
  readMcpConfigPath,
  removeMcpServer,
  upsertMcpServer,
  writeMcpConfigPath,
} from "../server/mcpConfig.mjs";

test("mcpConfigPath：全局落在 agent 目录，项目落在 <project>/.pi", () => {
  assert.equal(mcpConfigPath({ agentDir: "/home/u/.pi/agent", projectCwd: "/repo", scope: "user" }), "/home/u/.pi/agent/mcp.json");
  assert.equal(mcpConfigPath({ agentDir: "/home/u/.pi/agent", projectCwd: "/repo", scope: "global" }), "/home/u/.pi/agent/mcp.json");
  assert.equal(mcpConfigPath({ agentDir: "/home/u/.pi/agent", projectCwd: "/repo", scope: "project" }), "/repo/.pi/mcp.json");
});

test("normalizeMcpServerName：只接受字母数字下划线连字符", () => {
  assert.equal(normalizeMcpServerName(" teambition-mcp "), "teambition-mcp");
  assert.equal(normalizeMcpServerName("a_b-1"), "a_b-1");
  assert.equal(normalizeMcpServerName("bad name"), null);
  assert.equal(normalizeMcpServerName("bad/name"), null);
  assert.equal(normalizeMcpServerName(""), null);
});

test("parseMcpConfigText：空文本得到空配置，不报错", () => {
  const parsed = parseMcpConfigText("   ");
  assert.deepEqual(parsed.servers, []);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.config.mcpServers, {});
});

test("parseMcpConfigText：坏 JSON 只报错，不抛", () => {
  const parsed = parseMcpConfigText("{not json");
  assert.equal(parsed.servers.length, 0);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0], /not valid JSON/);
});

test("parseMcpConfigText：stdio / http 两类条目归一化", () => {
  const parsed = parseMcpConfigText(JSON.stringify({
    mcpServers: {
      fs: { command: "npx", args: ["-y", "server-fs", "."], env: { KEY: "${X}" }, cwd: "sub" },
      docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${T}" } },
    },
  }));
  assert.deepEqual(parsed.errors, []);
  const byName = Object.fromEntries(parsed.servers.map((server: any) => [server.name, server]));

  assert.equal(byName.fs.transport, "stdio");
  assert.deepEqual(byName.fs.args, ["-y", "server-fs", "."]);
  assert.deepEqual(byName.fs.env, { KEY: "${X}" });
  assert.equal(byName.fs.cwd, "sub");
  assert.equal(byName.fs.exposure, DEFAULT_MCP_EXPOSURE);
  assert.equal(byName.fs.enabled, true);

  assert.equal(byName.docs.transport, "http");
  assert.deepEqual(byName.docs.headers, { Authorization: "Bearer ${T}" });
});

test("parseMcpConfigText：非法条目跳过并报错，其它条目照常可用", () => {
  const parsed = parseMcpConfigText(JSON.stringify({
    mcpServers: {
      good: { command: "node", args: ["server.js"] },
      sse: { type: "sse", url: "https://x/sse" },
      empty: { env: {} },
      "bad name": { command: "node" },
    },
  }));
  assert.equal(parsed.servers.length, 1);
  assert.equal((parsed.servers[0] as any).name, "good");
  assert.equal(parsed.errors.length, 3);
  assert.ok(parsed.errors.some((error: string) => /legacy SSE/.test(error)));
  assert.ok(parsed.errors.some((error: string) => /needs either/.test(error)));
});

test("parseMcpConfigText：exposure / toolExposure / enabled / timeout 归一化并可被识别", () => {
  const parsed = parseMcpConfigText(JSON.stringify({
    mcpServers: {
      a: {
        command: "node",
        exposure: "direct",
        toolExposure: { danger: "hidden" },
        enabled: false,
        timeout: 30,
      },
    },
  }));
  const server = parsed.servers[0] as any;
  assert.equal(server.exposure, "direct");
  assert.deepEqual(server.toolExposure, { danger: "hidden" });
  assert.equal(server.enabled, false);
  assert.equal(server.timeout, 30);
});

test("parseMcpConfigText：非法 exposure 被拒", () => {
  const parsed = parseMcpConfigText(JSON.stringify({ mcpServers: { a: { command: "node", exposure: "nope" } } }));
  assert.equal(parsed.servers.length, 0);
  assert.match(parsed.errors[0], /exposure must be one of/);
});

test("upsertMcpServer：新建 stdio 条目，默认值不写进文件", () => {
  const config = upsertMcpServer({ mcpServers: {} }, "fs", {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    env: {},
    cwd: "",
    exposure: DEFAULT_MCP_EXPOSURE,
    toolExposure: {},
    enabled: true,
    timeout: undefined,
  });
  assert.deepEqual(config.mcpServers.fs, { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] });
});

test("upsertMcpServer：显式值才落盘（exposure / enabled / timeout / env / cwd）", () => {
  const config = upsertMcpServer({ mcpServers: {} }, "fs", {
    transport: "stdio",
    command: "npx",
    args: [],
    env: { A: "1" },
    cwd: "/tmp",
    exposure: "direct",
    toolExposure: { danger: "hidden" },
    enabled: false,
    timeout: 45,
  });
  assert.deepEqual(config.mcpServers.fs, {
    command: "npx",
    env: { A: "1" },
    cwd: "/tmp",
    exposure: "direct",
    toolExposure: { danger: "hidden" },
    enabled: false,
    timeout: 45,
  });
});

test("upsertMcpServer：编辑 stdio→http 会清掉 stdio 字段，保留 oauth 手写内容", () => {
  const base = { mcpServers: { a: { command: "node", args: ["x"], oauth: { clientId: "c" } } } };
  const config = upsertMcpServer(base, "a", { transport: "http", url: "https://x/mcp", exposure: DEFAULT_MCP_EXPOSURE });
  assert.deepEqual(config.mcpServers.a, { oauth: { clientId: "c" }, url: "https://x/mcp" });
});

test("upsertMcpServer：非法名字直接抛", () => {
  assert.throws(() => upsertMcpServer({ mcpServers: {} }, "bad name", { transport: "stdio", command: "node" }), /Invalid MCP server name/);
});

test("removeMcpServer：删掉存在的条目，返回 removed 标记时不改别的条目", () => {
  const base = { mcpServers: { a: { command: "node" }, b: { command: "node" } } };
  const result = removeMcpServer(base, "a");
  assert.equal(result.removed, true);
  assert.deepEqual(Object.keys(result.config.mcpServers), ["b"]);

  const missing = removeMcpServer(base, "zzz");
  assert.equal(missing.removed, false);
  assert.equal(missing.config, base);
});

test("patchMcpServer：enabled 是 pi 语义（true 删键，false 写 false）", () => {
  const base = { mcpServers: { a: { command: "node", enabled: false } } };
  assert.deepEqual(patchMcpServer(base, "a", { enabled: true }).mcpServers.a, { command: "node" });
  assert.deepEqual(patchMcpServer(base, "a", { enabled: false }).mcpServers.a, { command: "node", enabled: false });
});

test("patchMcpServer：exposure 回到默认就删键，非法值抛", () => {
  const base = { mcpServers: { a: { command: "node", exposure: "direct" } } };
  assert.deepEqual(patchMcpServer(base, "a", { exposure: "codemode" }).mcpServers.a, { command: "node" });
  assert.deepEqual(patchMcpServer(base, "a", { exposure: "hidden" }).mcpServers.a, { command: "node", exposure: "hidden" });
  assert.throws(() => patchMcpServer(base, "a", { exposure: "nope" }), /Invalid MCP exposure/);
});

test("mergeMcpServerEntries：同名项目整体覆盖全局，并标出 overridesGlobal", () => {
  const globalServers = [
    { name: "shared", transport: "stdio", command: "global-cmd" },
    { name: "only-global", transport: "stdio", command: "g" },
  ];
  const projectServers = [
    { name: "shared", transport: "http", url: "https://project/mcp" },
    { name: "only-project", transport: "stdio", command: "p" },
  ];
  const merged = mergeMcpServerEntries(globalServers, projectServers);
  const byName = Object.fromEntries(merged.map((server: any) => [server.name, server]));

  assert.deepEqual(merged.map((server: any) => server.name), ["only-global", "only-project", "shared"]);
  assert.equal(byName.shared.scope, "project");
  assert.equal(byName.shared.command, undefined);
  assert.equal(byName.shared.overridesGlobal, true);
  assert.equal(byName["only-global"].scope, "user");
  assert.equal(byName["only-project"].scope, "project");
  assert.equal(byName["only-project"].overridesGlobal, false);
});

test("read/write 往返：真文件、2 空格缩进、保留未知字段、不存在时不建文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
  try {
    const path = join(dir, "nested", "mcp.json");
    const missing = readMcpConfigPath(path);
    assert.equal(missing.exists, false);
    assert.deepEqual(missing.config.mcpServers, {});

    const config = upsertMcpServer({ mcpServers: {} }, "fs", { transport: "stdio", command: "npx", args: ["-y", "x"] });
    writeMcpConfigPath(path, config);

    const text = readFileSync(path, "utf8");
    assert.ok(text.endsWith("\n"));
    assert.match(text, /\n  "mcpServers": \{/);

    const readBack = readMcpConfigPath(path);
    assert.equal(readBack.exists, true);
    assert.equal(readBack.servers.length, 1);
    assert.equal((readBack.servers[0] as any).command, "npx");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("mcpToolExposure：精确名优先于模式，模式按对象顺序取首个命中，回退服务器默认", () => {
  const server = { exposure: "codemode", toolExposure: { "get_*": "direct", search_code: "deferred", "delete_*": "hidden" } };
  assert.equal(mcpToolExposure(server, "search_code"), "deferred");
  assert.equal(mcpToolExposure(server, "get_issue"), "direct");
  assert.equal(mcpToolExposure(server, "delete_all"), "hidden");
  assert.equal(mcpToolExposure(server, "other"), "codemode");

  const exactWins = { exposure: "hidden", toolExposure: { "get_*": "direct", get_issue: "codemode" } };
  assert.equal(mcpToolExposure(exactWins, "get_issue"), "codemode");
});
