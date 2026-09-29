/**
 * 扩展状态轨（合并 `aboveEditor` / `belowEditor` widget）的接线守卫。
 *
 * 背景：pi-mcp-adapter / pi-memory / pi-monitor 都用 `ctx.ui.setWidget` 往输入框附近塞状态。
 * 旧实现把 belowEditor 排在 composer 下方，正好落在工具栏那条水平带上，盖住了模型选择与
 * 发送/停止按钮。现在合并成一条轨：折叠一行图标、展开全文、限高可滚，绝不叠在 composer 上。
 *
 * 纯逻辑（chip 文案、告警判定）直接测；App.tsx 的呈现接线按函数体做结构断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { extensionWidgetHasWarning, extensionWidgetLabel } from "../src/shared/extensionWidgets.ts";
import { functionBody } from "./lib/sourceText.ts";

const read = (path: string): string => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const app = read("src/app/App.tsx");
const styles = read("src/app/styles.css");
const prefs = read("src/lib/ui-preferences.ts");

test("chip 文案用扩展 key，空 key 有兜底", () => {
  assert.equal(extensionWidgetLabel("pi-monitor"), "pi-monitor");
  assert.equal(extensionWidgetLabel("  pi-memory  "), "pi-memory");
  assert.equal(extensionWidgetLabel("   "), "extension");
});

test("告警判定只认失败/警告词，不误伤正常统计", () => {
  assert.equal(extensionWidgetHasWarning(["tools 226 (err 3, 1%) · cost $4.4691"]), true);
  assert.equal(extensionWidgetHasWarning(["last: read 2ms ✓"]), false);
  assert.equal(extensionWidgetHasWarning(["memory indexed 12 files"]), false);
  assert.equal(extensionWidgetHasWarning(["1 warning: disk low"]), true);
  // "error" 不能被 "err" 的 \b 边界吃掉后漏判。
  assert.equal(extensionWidgetHasWarning(["provider errors 2"]), true);
});

test("App 只渲染一条状态轨，不再分 above/below 两处", () => {
  assert.doesNotMatch(app, /extensionAboveWidgets|extensionBelowWidgets/, "旧的 above/below 分流必须删掉");
  assert.match(app, /const extensionWidgets = Object\.entries\(state\.extensionUiWidgets\)/);

  const rail = functionBody(app, "ExtensionStatusRail");
  assert.match(rail, /expanded \? <ExtensionWidgetStack widgets=\{widgets\} \/> : null/);
  assert.match(rail, /aria-expanded=\{expanded\}/);
  // 渲染点必须用合并后的 extensionWidgets，而不是任何按 placement 过滤的数组。
  assert.match(app, /<ExtensionStatusRail[\s\S]{0,160}widgets=\{extensionWidgets\}/);
});

test("折叠态默认关闭，开关写进 ui-preferences", () => {
  assert.match(
    app,
    /useState\(\s*\(\) => loadUiPreferences\(\)\.extensionStatusRailExpanded \?\? false,?\s*\)/,
    "缺省必须折叠（false）",
  );
  assert.match(app, /saveUiPreferences\(\{ extensionStatusRailExpanded: next \}\)/);
  assert.match(prefs, /extensionStatusRailExpanded\?: boolean;/);
});

test("展开体限高可滚、折叠行横向可滚，纯文本出口仍剥颜色码", () => {
  const railStart = styles.indexOf(".composer > .extension-rail");
  const railEnd = styles.indexOf("\n.capability-picker {", railStart);
  assert.ok(railStart >= 0 && railEnd > railStart, "找不到状态轨 CSS 块");
  const rail = styles.slice(railStart, railEnd);
  assert.match(rail, /\.extension-rail-body\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/, "展开体必须限高滚动");
  assert.match(rail, /\.extension-rail-chips\s*\{[^}]*overflow-x:\s*auto/, "折叠 chip 行横向溢出可滚");
  // 与 extensionUiMode.test.ts 同一契约：widget 是纯文本出口，必须剥掉终端颜色码。
  assert.match(functionBody(app, "ExtensionWidgetStack"), /stripTerminalSequences\(line\)/);
  // 轨道本身必须留在 composer 正常流里，不能是绝对定位（否则又回到遮挡的老问题）。
  assert.doesNotMatch(rail, /\.composer > \.extension-rail\s*\{[^}]*position:\s*absolute/);
});