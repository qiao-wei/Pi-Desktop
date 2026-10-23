/**
 * `disable-model-invocation: true` 的技能（manual-only）在能力页只能被说成「仅手动」。
 *
 * 背景（用户实测）：pi 的 `formatSkillsForPrompt`（`dist/core/skills.js`）会把这些技能从
 * `<available_skills>` 里整条过滤掉，模型永远看不到它们；但能力页把它们和普通技能一样
 * 列出来、标成「工具」。用户按「工具」去理解，就会以为它会进模型的技能清单，然后在对话里
 * 问「你加载的技能列表」时发现没有 —— 观察没问题，是标签在撒谎。
 *
 * 本次只修表述（行为不变）：徽标改走 i18n 的「仅手动」/「Manual only」，详情页补一行
 * 说明。纯文案改动，按仓库惯例做区域限定的结构断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { zh } from "../src/i18n/zh.ts";
import { en } from "../src/i18n/en.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** 取顶层 `function name(...) { ... }` 的源码（到下一个顶格 `}` 结束）。 */
function topLevelFunctionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = appSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return appSource.slice(start, end);
}

const card = topLevelFunctionSource("CapabilityMarketCard");
const detail = topLevelFunctionSource("CapabilityDetailDialog");

test("技能卡片徽标走 i18n，卡片里不再有硬编码的「工具」", () => {
  assert.match(
    card,
    /item\.disableModelInvocation \? \(\s*<Badge variant="secondary" title=\{t\("capability\.detail\.manualOnlyNote"\)\}>\s*\{t\("capability\.badge\.manualOnly"\)\}/,
    "manual-only 徽标必须由 t(\"capability.badge.manualOnly\") 渲染（此前是硬编码中文「工具」，英文界面也照样显示中文）",
  );
  assert.equal(
    card.includes(">工具<"),
    false,
    "卡片里又出现了硬编码的「工具」：它会让人以为这个技能在模型的自动选择清单里",
  );
});

test("徽标仍然只挂在 disable-model-invocation 的技能上", () => {
  // 命中文案、但没有 gate 的话，普通技能也会被标成「仅手动」。
  assert.match(
    card,
    /item\.kind === "skill" && item\.disableModelInvocation/,
    "徽标的 gate 变了：普通技能不该带「仅手动」",
  );
});

test("详情页的说明挂同一个 gate，不是无条件渲染", () => {
  assert.match(
    detail,
    /\{item\.disableModelInvocation \? \(\s*<p className="text-sm text-muted-foreground">\{t\("capability\.detail\.manualOnlyNote"\)\}<\/p>\s*\) : null\}/,
    "详情页要有一行「不会出现在模型的自动选择列表」，且只对声明了 disable-model-invocation 的技能显示",
  );
});

test("两包文案说的是「手动」，不是「工具」", () => {
  assert.equal(zh["capability.badge.manualOnly"], "仅手动");
  assert.equal(en["capability.badge.manualOnly"], "Manual only");

  for (const locale of [zh, en] as const) {
    const note = locale["capability.detail.manualOnlyNote"];
    assert.ok(
      note.includes("disable-model-invocation: true"),
      "说明要点出原因（该技能自己的 frontmatter 声明），否则用户还是不知道为什么它不在清单里",
    );
  }
  assert.ok(zh["capability.detail.manualOnlyNote"].includes("自动选择列表"), "中文说明要落到「不在模型的自动选择列表」");
  assert.ok(
    en["capability.detail.manualOnlyNote"].includes("model's automatic skill selection"),
    "英文说明要落到「left out of the model's automatic skill selection」",
  );
});