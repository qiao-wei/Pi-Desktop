/**
 * 技能加载诊断（pi 加载器的 `getSkills().diagnostics`）要真的走到能力页。
 *
 * 重名技能时 pi 保留先发现的那份、把后来的丢掉，只留一条 `collision` 诊断。以前
 * `discoverAllProjectSkills` 只取 `.skills`，于是用户看到的是「某个技能莫名不见了」。
 * 这组用例钉住三层接线：服务端快照带字段 → 页面渲染 → i18n 两套语言都在。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { appSource as readAppSource } from "./lib/appSource.ts";
import { bridgeSource } from "./lib/bridgeSource.ts";
import test from "node:test";

import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";
import { functionBody } from "./lib/sourceText.ts";

const server = bridgeSource();
const appSource = readAppSource();

test("服务端：诊断与清单同源，并进快照；重载时跟着更新", () => {
  const discover = functionBody(server, "discoverAllProjectSkillResources");
  assert.match(discover, /const result = loader\.getSkills\(\)/);
  assert.match(discover, /diagnostics: normalizeSkillDiagnostics\(result\?\.diagnostics\)/);

  // 预解析（能力清单的来源）必须把诊断一起存起来，否则快照里永远是空的。
  const paths = functionBody(server, "resolveRuntimeCapabilityPaths");
  assert.match(
    paths,
    /const skillResources = await discoverAllProjectSkillResources\(project, settingsManager\)/,
  );
  assert.match(paths, /skillDiagnostics: skillResources\.diagnostics/);
  assert.match(
    functionBody(server, "refreshRuntimeCapabilityPaths"),
    /current\.skillDiagnostics = next\.skillDiagnostics/,
  );

  const snapshot = functionBody(server, "buildCapabilitiesSnapshot");
  assert.match(
    snapshot,
    /const skillDiagnostics = targetRuntime\.capabilityPaths\?\.skillDiagnostics \?\? fallbackSkillResources\?\.diagnostics \?\? \[\]/,
  );
  assert.match(snapshot, /skillDiagnostics,/);
});

test("服务端：pi 设置 enableSkillCommands 进快照（缺失时视为开启）", () => {
  const snapshot = functionBody(server, "buildCapabilitiesSnapshot");
  assert.match(
    snapshot,
    /skillCommandsEnabled: targetRuntime\.settingsManager\?\.getEnableSkillCommands\?\.\(\) !== false/,
  );
});

test("能力页：只在 Skills 标签渲染告警块，文案与保留路径都在", () => {
  const page = functionBody(appSource, "CapabilitiesPage");
  assert.match(page, /const skillDiagnostics = capabilities\.skillDiagnostics \?\? \[\]/);
  assert.match(page, /tab === "skill" && skillDiagnostics\.length \?/);
  assert.match(page, /t\("capability\.skillDiagnostics\.title"\)/);
  assert.match(page, /t\("capability\.skillDiagnostics\.hint"\)/);
  // 冲突要说出「实际保留的是哪一份」，否则用户还是不知道该改哪个。
  assert.match(page, /diagnostic\.collision\?\.winnerPath/);
  assert.match(
    page,
    /t\("capability\.skillDiagnostics\.kept", \{ path: diagnostic\.collision\.winnerPath \}\)/,
  );
  assert.match(page, /diagnostic\.path/);
});

test("渲染进程的 normalizeCapabilities 不能把新字段吃掉", () => {
  const hook = readFileSync(
    new URL("../src/features/chat/usePiDesktopApp.ts", import.meta.url),
    "utf8",
  );
  const body = functionBody(hook, "normalizeCapabilities");
  // 它是「默认值 + 服务端快照」的合并：新增字段靠 spread 透传，别再手写白名单丢掉它们。
  assert.match(body, /\.\.\.\(capabilities \?\? \{\}\)/);
  assert.doesNotMatch(
    body,
    /skillDiagnostics: capabilities\?\.skillDiagnostics \?\? \[\]/,
    "透传即可，别在白名单里重复一遍",
  );
});

test("能力页：告警默认收起，把手在筛选行右端，展开后才渲染详情", () => {
  const page = functionBody(appSource, "CapabilitiesPage");
  // 默认收起：几行重名路径以前会把技能列表整体压下去，用户反馈过「占位太大」。
  assert.match(page, /const \[skillDiagnosticsOpen, setSkillDiagnosticsOpen\] = useState\(false\)/);
  // 收起时不是卸载，而是 `hidden`：内容仍在 DOM 里，`aria-controls` 才有指向。
  assert.match(page, /id=\{SKILL_DIAGNOSTICS_ID\}/);
  assert.match(page, /hidden=\{!skillDiagnosticsOpen\}/);
  assert.match(page, /aria-expanded=\{skillDiagnosticsOpen\}/);
  assert.match(page, /aria-controls=\{SKILL_DIAGNOSTICS_ID\}/);
  // 把手上的数字就是诊断条数，否则收起后看不出有几条。
  assert.match(page, /<Badge variant="secondary"[^>]*>\s*\{skillDiagnostics\.length\}/);
  assert.ok(
    /const SKILL_DIAGNOSTICS_ID = "[a-z0-9-]+"/.test(appSource),
    "折叠把手与内容块要共用同一个 id 常量",
  );
});

test("i18n：两套语言都有告警文案，且 {path} 槽位一致", () => {
  for (const key of [
    "capability.skillDiagnostics.title",
    "capability.skillDiagnostics.hint",
    "capability.skillDiagnostics.expand",
    "capability.skillDiagnostics.collapse",
    "capability.slashMenu.skillCommandsDisabled",
  ]) {
    assert.equal(typeof zh[key], "string", `zh 缺 ${key}`);
    assert.equal(typeof en[key], "string", `en 缺 ${key}`);
    assert.ok(zh[key].trim().length > 0 && en[key].trim().length > 0);
  }
  assert.ok(zh["capability.skillDiagnostics.kept"].includes("{path}"));
  assert.ok(en["capability.skillDiagnostics.kept"].includes("{path}"));
});
