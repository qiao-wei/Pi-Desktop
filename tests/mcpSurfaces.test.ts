/**
 * Pi Desktop 的 MCP 表面（pi 0.99 内置 MCP + codemode）。
 *
 * 三件事在这里钉死：
 * 1. 服务端把三个内置扩展塞进了 extensionFactories，并默认打开 `+codemode` / `+tool_search`；
 * 2. 前端「Global skills & packages」有 MCP 标签页、右侧项目面板有 MCP 分区，两处共用同一批
 *    回调，且删除走统一的确认弹窗；
 * 3. 两份语言包都带了新文案。
 *
 * 纯函数（mcp.json 读写 / exposure 计算）在 tests/mcpConfig.test.ts 里按数据测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const hookSource = readFileSync(new URL("../src/features/chat/usePiDesktopApp.ts", import.meta.url), "utf8");

/* ------------------------------- 服务端接入 ------------------------------- */

test("the three built-in extensions from pi 0.99 are registered", () => {
  assert.match(serverSource, /createCodemodeExtension\(\)/);
  assert.match(serverSource, /createToolSearchExtension\(\)/);
  assert.match(serverSource, /createMcpExtension\(\)/);
  // All of them must land in the same extensionFactories list as the Desktop runtime extension.
  const factoryStart = serverSource.indexOf("extensionFactories: [");
  const factories = serverSource.slice(factoryStart, factoryStart + 1200);
  assert.match(factories, /createCodemodeExtension\(\)/);
  assert.match(factories, /createMcpExtension\(\)/);
});

test("桌面端不再替用户默认打开 codemode：这块设置完全交给 pi", () => {
  // 行为契约：桥里没有硬编码的 `+codemode`，也不 applyOverrides defaultTools。
  // 开关走「设置 → 个性化」和「编辑项目」，写的是 pi 自己的 settings 文件，
  // 默认值和合并规则由 pi 说了算（逐例对照见 tests/toolSettings.test.ts）。
  assert.doesNotMatch(serverSource, /"\+codemode"/);
  assert.doesNotMatch(serverSource, /defaultTools: \[/);
  assert.match(serverSource, /readToolSettingsSnapshot\(/);
  assert.match(serverSource, /applyToolToggle\(/);
});

/** 用真的 SettingsManager + 真的 settings.json 走一遍，而不是只看源码字符串。 */
function freshDefaultTools(settings: Record<string, unknown>): string[] | undefined {
  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-mcp-"));
  const agentDir = join(dir, "agent");
  const projectDir = join(dir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings), "utf8");

  return SettingsManager.create(projectDir, agentDir, { projectTrusted: false }).getDefaultTools();
}

test("新装的 agent 目录里 codemode 是关的（不写 defaultTools = 内建四件套）", () => {
  assert.equal(freshDefaultTools({ theme: "dark" }), undefined);
  assert.deepEqual(freshDefaultTools({ defaultTools: ["+codemode"] }), ["read", "bash", "edit", "write", "codemode"]);
  assert.deepEqual(freshDefaultTools({ defaultTools: ["read", "bash"] }), ["read", "bash"]);
});

test("MCP writes go through pi's mcp.json, app metadata through capabilities.json", () => {
  assert.match(serverSource, /\/api\/capabilities\/mcp\/save/);
  assert.match(serverSource, /\/api\/capabilities\/mcp\/remove/);
  assert.match(serverSource, /\/api\/capabilities\/mcp\/inspect/);
  assert.match(serverSource, /\/api\/capabilities\/mcp\/read/);
  // 服务器定义写的是 mcp.json 路径，元数据（pinned / 描述）写 capabilities.json 的 mcp 段。
  assert.match(serverSource, /writeMcpConfigPath\(path, upsertMcpServer/);
  assert.match(serverSource, /config\.mcp = \{/);
});

test("the tool inventory comes from the live session, not a second connection", () => {
  assert.match(serverSource, /function mcpToolsByNamespace\(targetRuntime\)/);
  assert.match(serverSource, /getAllTools\?\.\(\)/);
  assert.match(serverSource, /groupMcpToolsByNamespace\(targetRuntime\.session/);
  // 分组键是命名空间（mcp__<server>），不是 mcp.json 里的服务器名：pi 会把命名空间里的 `-` 换成
  // `_`，拿后缀当服务器名会让带 `-` 的服务器少掉整份工具列表。查表必须经过 mcpNamespaceOf。
  assert.match(serverSource, /toolsByNamespace\.get\(mcpNamespaceOf\(server\.name\)\)/);
  assert.doesNotMatch(serverSource, /namespace\.slice\("mcp__"\.length\)/);
  // 旧的 pi-mcp-adapter 代理层必须彻底退场，否则两套 MCP 语义会并存。
  assert.doesNotMatch(serverSource, /pi-mcp-adapter/);
  assert.doesNotMatch(serverSource, /createMcpAdapterStatus/);
});

/* -------------------------------- 全局页 --------------------------------- */

test("the global page gained an MCP tab wired to its own cards", () => {
  assert.match(appSource, /mcp: \{ label: "MCP", Icon: Plug \}/);
  assert.match(appSource, /capabilities\.mcpServers \?\? \[\]/);
  assert.match(appSource, /function CapabilityMcpCard\(/);
  assert.match(appSource, /<CapabilityMcpCard/);
  // MCP 卡片自成一系：连接状态 / transport / exposure 都是它自己的徽章。
  assert.match(appSource, /capability\.mcp\.connected/);
  assert.match(appSource, /capability\.mcp\.overridesGlobal/);
});

test("MCP editing is a first-class dialog with transport-specific fields", () => {
  assert.match(appSource, /function McpServerDialog\(/);
  assert.match(appSource, /function McpServerEditor\(/);
  assert.match(appSource, /function KeyValueEditor\(/);
  // stdio 与 http 各自只显示自己能用的字段。
  assert.match(appSource, /transport === "stdio" \?/);
  assert.match(appSource, /capability\.mcp\.headers/);
  assert.match(appSource, /capability\.mcp\.env/);
  // 单工具 exposure 覆盖也在这里配。
  assert.match(appSource, /capability\.mcp\.toolExposureAria/);
});

/* ------------------------------ 右侧项目面板 ------------------------------ */

test("the context panel lists project-scoped MCP servers too", () => {
  const panel = appSource.slice(appSource.indexOf("function ProjectCapabilitiesPanel"));
  assert.match(panel, /capabilities\.mcpServers \?\? \[\]/);
  assert.match(panel, /server\.scope === "project"/);
  assert.match(panel, /renderSection\("mcp", t\("capability\.section\.mcp"\)/);
  assert.match(panel, /setMcpDialogOpen\(true\)/);
  // 项目面板新增默认就落在项目作用域。
  assert.match(panel, /<McpServerDialog[\s\S]*?defaultScope="project"/);
});

test("both surfaces share one removal path and one confirm dialog", () => {
  // 项目面板的详情弹层也要能编辑 / 测试连接，所以三个回调两处都传。
  assert.equal((appSource.match(/onSaveMcpServer=\{saveMcpServer\}/g) ?? []).length, 2);
  assert.equal((appSource.match(/onReadMcpServer=\{readMcpServerDetail\}/g) ?? []).length, 2);
  assert.match(appSource, /capability\.delete\.mcpTitle/);
});

/* ------------------------------ 前端 action ------------------------------- */

test("the chat hook exposes MCP actions against the five endpoints", () => {
  for (const endpoint of [
    "/api/capabilities/mcp/save",
    "/api/capabilities/mcp/remove",
    "/api/capabilities/mcp/inspect",
    "/api/capabilities/mcp/read",
    "/api/capabilities/mcp/import",
  ]) {
    assert.ok(hookSource.includes(endpoint), `hook 没打到 ${endpoint}`);
  }
  for (const name of ["saveMcpServer", "removeMcpServer", "inspectMcpServer", "readMcpServerDetail", "parseMcpImport"]) {
    assert.match(hookSource, new RegExp(`\\b${name},`), `hook 没导出 ${name}`);
  }
});

/* -------------------------------- 导入配置 -------------------------------- */

test("the server exposes a parse-only import endpoint", () => {
  assert.match(serverSource, /\/api\/capabilities\/mcp\/import/);
  assert.match(serverSource, /function parseMcpImportRequest\(body\)/);
  assert.match(serverSource, /parseMcpImportText\(body\?\.text/);
  // 只解析：不落盘。真正的保存仍走 /mcp/save，所以不能出现导入专用的写路径。
  assert.doesNotMatch(serverSource, /mergeImportedServers/);
  assert.doesNotMatch(serverSource, /function importMcpServersCapability\(/);
});

test("import lives inside the add-server editor and fills the form", () => {
  // 不再是独立弹窗。
  assert.doesNotMatch(appSource, /function McpImportDialog\(/);
  assert.match(appSource, /function McpServerEditor\(/);
  // 导入区只在新增（无 server）时出现，且解析回调是从 McpServerDialog 透传的。
  assert.match(appSource, /!editing && onParseImport/);
  assert.match(appSource, /onParseImport\?: \(text: string, defaultName\?: string\)/);
  assert.match(appSource, /<McpServerDialog[\s\S]*?onParseImport=/);
  // 文件 + 粘贴两种输入，自动识别后点条目回填。
  assert.match(appSource, /capability\.mcp\.importChooseFile/);
  assert.match(appSource, /capability\.mcp\.importPasteLabel/);
  assert.match(appSource, /accept="\.json,application\/json"/);
  assert.match(appSource, /function applyImported\(imported: CapabilityMcpImportServer\)/);
  assert.match(appSource, /capability\.mcp\.importPick/);
  assert.match(appSource, /mcpImportFormatKey/);
  // 导入的 oauth 等字段随表单保存（extras），不能丢。
  assert.match(appSource, /extras,/);
  assert.match(appSource, /onParseMcpImport/);
});

test("every detected import format has copy in both packs", () => {
  // 这些 key 通过 `mcpImportFormatKey()` 拼出来，`.test.ts` 的 t() 字面量扫描抓不到，单独钉。
  for (const key of [
    "capability.mcp.importFormat.none",
    "capability.mcp.importFormat.mcp-servers",
    "capability.mcp.importFormat.vscode",
    "capability.mcp.importFormat.zed",
    "capability.mcp.importFormat.mcp",
    "capability.mcp.importFormat.list",
    "capability.mcp.importFormat.single",
    "capability.mcp.importFormat.map",
  ]) {
    assert.ok(key in zh, `中文包缺 key: ${key}`);
    assert.ok(key in en, `英文包缺 key: ${key}`);
  }
});

/* --------------------------------- 文案 ---------------------------------- */

test("both language packs carry the MCP copy", () => {
  const keys = Object.keys(zh).filter((key) => key.startsWith("capability.mcp."));
  assert.ok(keys.length >= 40, "MCP 文案明显缺失");
  for (const key of keys) {
    assert.ok(key in en, `英文包缺 key: ${key}`);
  }
  for (const key of ["capability.section.mcp", "capability.context.noMcp", "capability.delete.mcpTitle"]) {
    assert.ok(key in zh, `中文包缺 key: ${key}`);
    assert.ok(key in en, `英文包缺 key: ${key}`);
  }
});

test("MCP import copy is present in both language packs", () => {
  for (const key of [
    "capability.mcp.importSection",
    "capability.mcp.importHint",
    "capability.mcp.importChooseFile",
    "capability.mcp.importPasteLabel",
    "capability.mcp.importPlaceholder",
    "capability.mcp.importFormat",
    "capability.mcp.importFound",
    "capability.mcp.importPick",
    "capability.mcp.importApplied",
    "capability.mcp.importArgSpaces",
    "capability.mcp.importOauth",
    "capability.mcp.importWarningsTitle",
    "capability.mcp.importErrorsTitle",
  ]) {
    assert.ok(key in zh, `中文包缺 key: ${key}`);
    assert.ok(key in en, `英文包缺 key: ${key}`);
  }
});