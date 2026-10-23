/**
 * 思考等级菜单按模型渲染的接线守卫。
 *
 * 产品口径:每个模型的思考档位由它的 thinkingLevelMap 决定——表里非 null 的档就显示几档;
 * 编辑入口(设置页)是每档一个输入框:填值 = 选中时发给端点的 effort,留空 = 该档不存在。
 * pi 那边「未声明的档」只有两种效果(基础档按同名放行、xhigh/max 算不支持),都能用这两态
 * 表达,所以桥下发给编辑器的是摊平后的七档表(未声明的基础档 = 同名)。菜单渲染直接复用 pi 的
 * getSupportedThinkingLevels(桥算好),缺字段时兜底固定列表,空数组不兜。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildThinkingLevelMap, emptyThinkingLevels, thinkingLevelsFromMap } from "../src/features/models/customModelForm.ts";

import { bridgeSource } from "./lib/bridgeSource.ts";
import { appSource } from "./lib/appSource.ts";

const server = bridgeSource();
// 桥对内核的引用现在只走适配层（见 docs/architecture/protocols.md 的 kernel-adapter 边界）：
// 断言因此要同时看适配层的 re-export 与桥的导入来源，而不能只看桥里的 import 字样。
const piKernel = readFileSync(join(import.meta.dirname, "../server/piKernel.mjs"), "utf8");
const appTsx = appSource();
const settingsTsx = readFileSync(join(import.meta.dirname, "../src/features/models/CustomModelsSettings.tsx"), "utf8");
const formTs = readFileSync(join(import.meta.dirname, "../src/features/models/customModelForm.ts"), "utf8");
const apiTs = readFileSync(join(import.meta.dirname, "../src/features/models/customModelsApi.ts"), "utf8");

/** 按 "function name(" 定位,先跳过参数表再数花括号,返回完整函数体。 */
function functionBody(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `source 里找不到 function ${name}(`);
  let i = start + marker.length;
  let parenDepth = 1;
  while (i < source.length && parenDepth > 0) {
    if (source[i] === "(") parenDepth += 1;
    else if (source[i] === ")") parenDepth -= 1;
    i += 1;
  }
  assert.ok(parenDepth === 0, `function ${name} 的参数表没闭合`);
  while (i < source.length && source[i] !== "{") i += 1;
  assert.ok(i < source.length, `function ${name} 没有函数体`);
  return balancedBraces(source, i, `function ${name}`);
}

function balancedBraces(source: string, openBraceIndex: number, label: string): string {
  let depth = 0;
  let i = openBraceIndex;
  while (i < source.length) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, i + 1);
    }
    i += 1;
  }
  throw new Error(`${label} 的花括号没配平`);
}

test("桥给每个模型下发 supportedThinkingLevels(复用 pi 的按模型计算)", () => {
  assert.match(
    piKernel,
    /import \{ StringEnum, getSupportedThinkingLevels \} from "@earendil-works\/pi-ai";/,
    "getSupportedThinkingLevels 必须从 pi-ai 公开入口导入（适配层）",
  );
  // 2026-10-22：改成 `import` 绑定 + `export` 再导出（原来是 `export … from`），因为
  // `createKernelAdapter` 需要这个绑定在局部作用域里 —— `export … from` 不产生局部绑定
  // （`node-typecheck` 会用 TS18004 抓住这类写法）。导出面没变，仍由适配层转发给桥。
  assert.match(
    piKernel,
    /export \{\s*StringEnum,\s*getSupportedThinkingLevels,/,
    "适配层必须把 kernels 的这两个入口再导出给桥",
  );
  assert.match(
    server,
    /import \{ StringEnum, supportedThinkingLevelsFor, builtinProviders \} from "\.\/piKernel\.mjs";/,
    "桥自己只能通过 piKernel.mjs 拿到内核入口",
  );
  const describeModel = functionBody(server, "describeModel");
  // 菜单显示几档 = 模型映射表说了算。不要给「没映射表」另立口径（pi 对开了推理的模型
  // 默认放行 off..high），否则菜单与真实能发出的档位脱节。
  // 2026-10-22：改走 kernel-adapter 缝（`supportedThinkingLevelsFor`），契约不变 —— 真正的
  // 兑现者仍然是 pi 的按模型计算，行为级别的兑现见 tests/kernelAdapter.test.ts 的假内核用例。
  assert.match(
    describeModel,
    /supportedThinkingLevels: supportedThinkingLevelsFor\(model\),/,
    "describeModel 必须复用 pi 的按模型计算（经 kernel-adapter 缝）",
  );
  assert.ok(
    !/supportedThinkingLevels: model\.thinkingLevelMap \?/.test(describeModel),
    "不允许再按「有没有映射表」手改档位表",
  );
});

test("编辑弹窗：每档一个输入框（留空 = 该档不存在），只有打开推理才可配", () => {
  // 简化后的口径：三态被压成两态就能完整表达 pi（未声明的基础档效果 = 同名，所以摊平成同名值即可）
  assert.match(formTs, /export type ThinkingLevelDraftMap = Record<ThinkingLevel, string>;/, "缺逐档草稿类型");
  assert.match(formTs, /export function thinkingLevelsFromMap\(/, "缺「已存映射表 → 逐档草稿」");
  assert.match(formTs, /export function buildThinkingLevelMap\(/, "缺「逐档草稿 → 落盘映射表」");
  assert.match(formTs, /map\[level\] = draft\[level\]\?\.trim\(\) \? draft\[level\]\.trim\(\) : null;/, "留空落 null、填值落该值");
  assert.ok(!/disabled: boolean/.test(formTs), "不应该再有不支持勾选那套三态");

  const levelsBlock = settingsTsx.slice(settingsTsx.indexOf("思考档位映射"));
  assert.ok(levelsBlock.startsWith("思考档位映射"), "找不到映射表编辑器");
  assert.match(levelsBlock.slice(0, 400), /\{draft\.reasoning \? \(/, "映射编辑器必须只在推理打开时渲染");
  assert.ok(!/thinkingUnsupported/.test(settingsTsx), "不支持勾选已被删掉（留空就是该档不存在）");
  assert.match(
    apiTs,
    /thinkingLevelMap: draft\.reasoning \? buildThinkingLevelMap\(draft\.thinkingLevels\) : undefined,/,
    "关掉推理时不能回传映射表(文件里的旧表要留着)",
  );
  assert.ok(!/thinkingLevels: draft\.reasoning \? draft\.thinkingLevels/.test(apiTs), "不能再回传一维档位数组");
});

test("composer 档位表：缺字段才兜底，空数组不兜底", () => {
  for (const name of ["ThinkingLevelSelect", "ComposerOverflowMenu"]) {
    const body = functionBody(appTsx, name);
    assert.match(body, /const levels = supportedThinkingLevels \?\? thinkingLevels;/, `${name} 应用空值合并兜底`);
    assert.ok(!/supportedThinkingLevels\?\.length/.test(body), `${name} 不能把空数组当“没数据”兜回七档`);
    assert.match(body, /levels\.map\(\(level\) => \(/, `${name} 菜单必须用兜底后的 levels 渲染`);
    assert.ok(!body.includes("thinkingLevels.map"), `${name} 不允许再直接渲染固定列表`);
  }
});

test("供应商分组可折叠，且折叠状态走 UI 偏好持久化", () => {
  assert.match(settingsTsx, /const \[collapsedProviders, setCollapsedProviders\] = useState<string\[]>\(\(\) => loadUiPreferences\(\)\.modelsCollapsedProviderIds \?\? \[\]\)/, "折叠状态必须从 UI 偏好初始化");
  assert.match(settingsTsx, /saveUiPreferences\(\{ modelsCollapsedProviderIds: next \}\)/, "切换折叠必须落盘");
  assert.match(settingsTsx, /aria-expanded=\{!collapsedProviders\.includes\(group\.providerId\)\}/, "折叠开关要有 aria-expanded");
  assert.match(settingsTsx, /\{collapsedProviders\.includes\(group\.providerId\) \? null : \(\s*<ul className="settings-list">/, "折叠后不能渲染模型列表");
});

test("非思考模型不渲染思考选择入口（同 pi 的 supportsThinking 设计）", () => {
  assert.match(
    appTsx,
    /const modelSupportsThinking = activeModelThinkingLevels\s*\?\s*activeModelThinkingLevels\.some\(\(level\) => level !== "off"\)\s*:\s*true/,
    "缺少按模型判定是否支持思考",
  );
  assert.equal(
    (appTsx.match(/\{modelSupportsThinking \? \(/g) ?? []).length,
    2,
    "两个思考入口（下拉+收纳菜单）都要用 modelSupportsThinking 条件渲染",
  );
});

test("前端两个思考菜单按当前模型档位渲染,缺数据兜底固定列表", () => {
  // 渲染点把当前模型的档位表传下去(composer 两处入口)。
  assert.equal(
    (appTsx.match(/supportedThinkingLevels=\{activeModelThinkingLevels\}/g) ?? []).length,
    2,
    "两个思考菜单入口都要接 activeModelThinkingLevels",
  );
  assert.match(
    appTsx,
    /availableModels\.find\(\s*\(candidate\) => candidate\.provider === selectedProvider && candidate\.model === selectedModel,\s*\)\?\.supportedThinkingLevels/,
    "activeModelThinkingLevels 必须按当前模型查档位表",
  );
});

test("草稿往返：填值=发该值、留空=null、未声明的基础档摊平成同名", () => {
  // 新建模型的默认：基础档同名（= pi 对「没有映射表」的默认行为），xhigh/max 留空
  assert.deepEqual(emptyThinkingLevels(), {
    off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "", max: "",
  });

  // 桥下发的七档表 → 草稿（null 显示成空框）
  const draft = thinkingLevelsFromMap({ off: null, minimal: null, low: "low", medium: "medium", high: "max", xhigh: "xhigh", max: null });
  assert.deepEqual(draft, {
    off: "", minimal: "", low: "low", medium: "medium", high: "max", xhigh: "xhigh", max: "",
  });

  // 草稿 → 落盘：七档全写，空 = null（所见即所发）
  assert.deepEqual(buildThinkingLevelMap(draft), {
    off: null, minimal: null, low: "low", medium: "medium", high: "max", xhigh: "xhigh", max: null,
  });

  // 全留空 = 这个模型没有任何思考档位
  const cleared = buildThinkingLevelMap({ off: "", minimal: "", low: "", medium: "", high: "", xhigh: "", max: "" });
  assert.deepEqual(Object.values(cleared), [null, null, null, null, null, null, null]);

  // 空白串不算值（不能把 "   " 当 effort 发出去）
  assert.equal(buildThinkingLevelMap({ ...emptyThinkingLevels(), high: "   " }).high, null);
});
