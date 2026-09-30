/**
 * 「工具开关」（codemode）的接线：服务端路由 / 快照字段 / 前端两处入口。
 *
 * 这里只钉**接线**（字符串级），因为可测的部分都被抽走了：
 * - 读写纯函数 + pi 逐例对照 → tests/toolSettings.test.ts
 * - 中英文语言包对齐 → tests/i18n.test.ts
 *
 * 有一条真正的行为契约放在这里：桌面端**不许**自己打开 codemode（不许硬编码 `"+codemode"`），
 * 默认值和合并规则全归 pi。见 tests/mcpSurfaces.test.ts 里同样的一条。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const hookSource = readFileSync(new URL("../src/features/chat/usePiDesktopApp.ts", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../src/types/domain.ts", import.meta.url), "utf8");

/* ------------------------------- 服务端 ------------------------------- */

test("写开关走 POST /api/tools/settings，读走快照里的 toolSettings", () => {
  assert.match(serverSource, /url\.pathname === "\/api\/tools\/settings"/);
  assert.match(serverSource, /await saveToolSettings\(body\)/);
  // 现状放在 bootstrap 里（不放在 ambient：那是给别的会话轮询用的，没必要跟着变大）。
  assert.match(serverSource, /toolSettings: toolSettingsSnapshotFor\(targetRuntime\)/);
  const ambient = serverSource.slice(serverSource.indexOf("ambient: true"), serverSource.indexOf("function buildSnapshot"));
  assert.doesNotMatch(ambient, /toolSettings/);
});

test("项目清单里带回每个项目自己的三态，但不落 projects.json", () => {
  assert.match(serverSource, /codemode: projectToolToggleState\(project\)/);
  // computed 字段跟着 `saveProjects()` 一起写盘的话，会把死值固化下来。
  const save = serverSource.slice(serverSource.indexOf("function saveProjects()"), serverSource.indexOf("function readActiveProjectId"));
  assert.doesNotMatch(save, /codemode/);
});

test("项目层和 .pi/mcp.json 同一条信任门：未信任不写", () => {
  assert.match(serverSource, /Trust this project before editing its \.pi\/settings\.json\./);
  assert.match(serverSource, /function projectTrustForWrite\(/);
});

test("改完设置立刻落到已打开的会话上，但只碰 codemode 一个名字", () => {
  assert.match(serverSource, /function applyToolToggleToRuntimes\(/);
  assert.match(serverSource, /setActiveToolsByName\(\[\.\.\.active, MANAGED_TOOL_NAME\]\)/);
  assert.match(serverSource, /filter\(\(name\) => name !== MANAGED_TOOL_NAME\)/);
  // 正在跑的会话不碰，和 reloadRuntimeTargets 一致。
  assert.match(serverSource, /applyToolToggleToRuntimes[\s\S]{0,600}isSessionBusy\(targetRuntime\.session\)/);
  // 有 codemode 型 MCP 服务器时不往下摘——摘了 MCP 就没工具给模型了。
  assert.match(serverSource, /function mcpNeedsCodemode\(/);
  assert.match(serverSource, /mcpNeedsCodemode\(targetRuntime\)/);
});

/* -------------------------------- 前端 -------------------------------- */

test("hook 暴露 saveToolSettings，并复用整份 bootstrap 对账路径", () => {
  assert.match(hookSource, /const saveToolSettings = useCallback\(/);
  assert.match(hookSource, /updateCapability\("\/api\/tools\/settings", input\)/);
  assert.match(hookSource, /^\s+saveToolSettings,$/m);
  assert.match(apiSource, /toolSettings\?: ToolSettingsPayload/);
  assert.match(typesSource, /export type ToolToggleState = "inherit" \| "on" \| "off"/);
  assert.match(typesSource, /codemode\?: ToolToggleState/);
});

test("设置页：一个开关绑全局那一层，拨了立即写，不跟保存按钮绑定", () => {
  assert.match(appSource, /id="settings-codemode"/);
  assert.match(appSource, /checked=\{Boolean\(toolSettings\?\.global\)\}/);
  assert.match(appSource, /onCheckedChange=\{\(checked\) => void toggleCodemode\(checked\)\}/);
  assert.match(appSource, /state: enabled \? "on" : "off"/);
  // 项目覆盖住了要说出来，别让用户以为开关坏了。
  assert.match(appSource, /toolSettings\?\.project === "off" && toolSettings\.global/);
  // 「本会话」那行直接看会话里的真值，不拿 effective 糊。
  assert.match(appSource, /toolSettings\?\.activeTools \?\? \[\]\)\.includes\("codemode"\)/);
});

test("编辑项目：三态下拉在弹窗里，提交时才写，且只在真改过时写", () => {
  assert.match(appSource, /id="sidebar-project-codemode"/);
  assert.match(appSource, /value=\{dialog\.codemode\}/);
  assert.match(appSource, /const toolToggleOptions: ReadonlyArray<\{ value: ToolToggleState; labelKey: string \}> = \[/);
  for (const value of ["inherit", "on", "off"]) {
    assert.match(appSource, new RegExp(`value: "${value}", labelKey: "dialog\\.codemode\\.`));
  }
  // 弹窗打开时把当前值带进去（算出来的字段，不在 projects.json 里）。
  assert.match(appSource, /codemode: project\.codemode \?\? "inherit"/);
  assert.match(
    appSource,
    /if \(dialog\.codemode !== \(dialog\.project\.codemode \?\? "inherit"\)\) \{\s*try \{\s*await onSaveToolSettings\(\{\s*scope: "project",\s*projectId: dialog\.project\.id,\s*state: dialog\.codemode,\s*\}\)/,
  );
});

test("两处入口都拿到了 onSaveToolSettings", () => {
  const wired = appSource.match(/onSaveToolSettings=\{\(input\) => saveToolSettings\(input\)\}/g) ?? [];
  assert.equal(wired.length, 2, "设置页和项目侧栏各要一处");
  assert.match(appSource, /^\s+saveToolSettings,$/m);
});

test("新文案中英文都补齐了", () => {
  for (const key of [
    "settings.codemode.section",
    "settings.codemode.label",
    "settings.codemode.desc",
    "settings.codemode.hint",
    "settings.codemode.projectOverride",
    "settings.codemode.activeOn",
    "settings.codemode.activeOff",
    "dialog.codemode.label",
    "dialog.codemode.desc",
    "dialog.codemode.inherit",
    "dialog.codemode.on",
    "dialog.codemode.off",
    "dialog.codemode.hint",
  ]) {
    assert.ok(key in zh, `中文缺 ${key}`);
    assert.ok(key in en, `英文缺 ${key}`);
  }
});