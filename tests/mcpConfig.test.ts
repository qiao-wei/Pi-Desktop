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
  MCP_NAMESPACE_PREFIX,
  MCP_SERVER_NAME_PATTERN,
  groupMcpToolsByNamespace,
  mcpConfigPath,
  mcpNamespaceOf,
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

test("upsertMcpServer：新建条目会带上 definition.extras（导入的 oauth 等）", () => {
  const config = upsertMcpServer({ mcpServers: {} }, "authy", {
    transport: "http",
    url: "https://authy/mcp",
    exposure: DEFAULT_MCP_EXPOSURE,
    extras: { oauth: { clientId: "c" }, auth: { provider: "gitlab" } },
  });
  assert.deepEqual(config.mcpServers.authy, {
    oauth: { clientId: "c" },
    auth: { provider: "gitlab" },
    url: "https://authy/mcp",
  });
});

test("upsertMcpServer：编辑已有条目时以磁盘上的 unknown 字段为准，不被 extras 改写", () => {
  const base = { mcpServers: { authy: { url: "https://old/mcp", oauth: { clientId: "disk" } } } };
  const config = upsertMcpServer(base, "authy", {
    transport: "http",
    url: "https://new/mcp",
    exposure: DEFAULT_MCP_EXPOSURE,
    extras: { oauth: { clientId: "form" } },
  });
  assert.deepEqual(config.mcpServers.authy.oauth, { clientId: "disk" });
  assert.equal(config.mcpServers.authy.url, "https://new/mcp");
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
test("mcpNamespaceOf：服务器名进会话后被 pi 换成 `mcp__` + `-`→`_`，查工具列表必须按同一条规则", () => {
  // pi ≥0.99.2 的 `mcpNamespace()`：`mcp__${server.replace(/-/g, "_")}`。会话只给命名空间，
  // 所以带 `-` 的服务器（本 app 的名字校验允许）不能拿命名空间后缀当服务器名去查。
  assert.equal(mcpNamespaceOf("fs"), "mcp__fs");
  assert.equal(mcpNamespaceOf("dev-radius"), "mcp__dev_radius");
  assert.equal(mcpNamespaceOf("a-b-c"), "mcp__a_b_c");
  assert.equal(mcpNamespaceOf("already_snake"), "mcp__already_snake", "下划线本来就会被 pi 保留");
  assert.equal(mcpNamespaceOf("mcp2-tools"), "mcp__mcp2_tools");
  // 只换 `-`，不动其它字符：pi 用的是 /-/g 而不是 `[^A-Za-z0-9_]`。
  assert.equal(mcpNamespaceOf("a_b"), "mcp__a_b");
  assert.equal(mcpNamespaceOf(undefined), "mcp__");
  // 名字校验放行的字符，换算后仍落在 pi 的命名空间规律里（`-` 全部消失）。
  for (const name of ["fs", "dev-radius", "a-b_c-1"]) {
    assert.ok(MCP_SERVER_NAME_PATTERN.test(name));
    assert.doesNotMatch(mcpNamespaceOf(name).slice("mcp__".length), /-/);
  }
});

test("groupMcpToolsByNamespace × mcpNamespaceOf：带 `-` 的服务器名也能查到自己那组工具", () => {
  // 真实形状：pi 注册的 MCP 工具带着 `namespace.name` 与 `<命名空间>__<工具>` 的名字。
  const tools = [
    { name: "mcp__dev_radius__get_issue", namespace: { name: "mcp__dev_radius" }, description: "取 issue", exposure: "codemode" },
    { name: "mcp__dev_radius__delete_all", namespace: { name: "mcp__dev_radius" }, description: "危险", exposure: "hidden" },
    { name: "mcp__fs__read_file", namespace: { name: "mcp__fs" }, description: "读文件", exposure: "direct" },
    // 非 MCP 工具（没命名空间 / 不是 mcp__ 前缀）不入表。
    { name: "bash", description: "不相关" },
    { name: "read", namespace: { name: "builtin:read" } },
  ];
  const grouped = groupMcpToolsByNamespace(tools);

  assert.deepEqual([...grouped.keys()].sort(), ["mcp__dev_radius", "mcp__fs"]);
  assert.equal(grouped.has("mcp__dev-radius"), false, "命名空间里不会有连字符");

  // 关键：拿 mcp.json 里的真名查表。这就是旧实现（切前缀当服务器名）会算成 0 个工具的那步。
  const radius = grouped.get(mcpNamespaceOf("dev-radius")) ?? [];
  assert.deepEqual(radius.map((tool) => tool.name), ["delete_all", "get_issue"], "组内按工具名排序");
  assert.equal(radius[1].description, "取 issue");
  assert.equal(radius[0].exposure, "hidden", "per-tool exposure 原样带出，供 UI 展示");
  assert.equal(grouped.get(mcpNamespaceOf("fs"))?.length, 1, "无连字符的名字照旧能用");
  assert.equal(grouped.get(mcpNamespaceOf("missing-server")), undefined);

  // 空/脏输入不能抛：能力页会在会话还没起时调到这里。
  assert.equal(groupMcpToolsByNamespace([]).size, 0);
  assert.equal(groupMcpToolsByNamespace(undefined).size, 0);
  assert.equal(groupMcpToolsByNamespace([{}, { namespace: {} }, { namespace: { name: 7 } }]).size, 0);

  // 命名空间前缀是 pi 的常量，别在别处写死字串。
  assert.equal(mcpNamespaceOf("x"), `${MCP_NAMESPACE_PREFIX}x`);
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
