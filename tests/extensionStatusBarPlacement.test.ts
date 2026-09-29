/**
 * 扩展信息呈现守卫。
 *
 * - `ctx.ui.setStatus` 的短状态（pi-monitor ⏱、pi-mcp-adapter MCP 计数）：不能再 fixed 在右下角
 *   压住发送按钮，改成模型选择左边的浮动层（朝上弹）。
 * - `ctx.ui.setWidget` 的信息区：内容/位置保持原样，只多一个右上角折叠开关，默认展开。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { functionBody } from "./lib/sourceText.ts";

const read = (path: string): string => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const app = read("src/app/App.tsx");
const styles = read("src/app/styles.css");
const prefs = read("src/lib/ui-preferences.ts");

test("状态条不再固定覆盖在右下角", () => {
  assert.doesNotMatch(
    app,
    /fixed right-\[18px\] bottom-3\.5/,
    "状态条不能再用 fixed 悬浮在右下角，否则又会盖住模型选择/发送按钮",
  );
  // 纯文本出口的既有契约：颜色码必须剥掉。
  assert.match(functionBody(app, "ExtensionStatusBar"), /stripTerminalSequences\(value\)/);
});

test("状态 icon 在模型选择左边，浮层朝上打开", () => {
  const actionsStart = app.indexOf('<div className="composer-actions">');
  const modelSelect = app.indexOf("<ComposerModelSelect", actionsStart);
  const anchor = app.indexOf('className="extension-status-anchor"', actionsStart);
  assert.ok(actionsStart >= 0 && modelSelect > actionsStart, "找不到 composer-actions / 模型选择");
  assert.ok(anchor > actionsStart && anchor < modelSelect, "状态锚点必须在 ComposerModelSelect 之前");

  const renders = [...app.matchAll(/<ExtensionStatusBar status=\{state\.extensionUiStatus\} \/>/g)];
  assert.equal(renders.length, 1, "ExtensionStatusBar 只能有一个渲染点");

  const anchorCss = styles.slice(
    styles.indexOf(".extension-status-anchor"),
    styles.indexOf(".extension-status-trigger"),
  );
  assert.match(anchorCss, /position:\s*relative/, "浮层锚点必须 position: relative");
  const popover = styles.slice(
    styles.indexOf(".extension-status-popover"),
    styles.indexOf(".extension-status-title"),
  );
  assert.match(popover, /position:\s*absolute/);
  assert.match(popover, /bottom:\s*calc\(100% \+ 10px\)/, "浮层必须朝上弹，不能盖住下方工具栏");
  // 模型旁边的状态图标要比通用工具按钮小一号，避免和模型文字不协调。
  assert.match(app, /<Activity size=\{15\} \/>/);
  assert.match(styles, /\.extension-status-trigger \{[^}]*width:\s*26px/);
});

test("widget 信息区保持原样，只加右上角折叠开关（默认展开）", () => {
  const stack = functionBody(app, "ExtensionWidgetStack");
  // 内容与纯文本出口不变。
  assert.match(stack, /stripTerminalSequences\(line\)/);
  // 折叠开关存在，且折叠态有独立分支。
  assert.match(stack, /className="extension-widget-toggle"/);
  assert.match(stack, /extension-widget-stack--collapsed/);
  // 展开态 ▼（点击收起）、折叠态 ▲（点击展开）。
  assert.match(stack, /collapsed \? <ChevronUp size=\{14\} \/> : <ChevronDown size=\{14\} \/>/);
  // 图标要扁平：不能有描边/底色，否则又像一颗立体按钮。
  const toggleCss = styles.slice(
    styles.indexOf("\n.extension-widget-toggle {"),
    styles.indexOf(".extension-widget-toggle:hover"),
  );
  assert.match(toggleCss, /border:\s*0/);
  assert.match(toggleCss, /background:\s*transparent/);
  assert.doesNotMatch(toggleCss, /border:\s*1px/, "折叠图标不要描边");
  // 只有 composer 上方那个实例可折叠；belowEditor 实例保持原样。
  assert.match(app, /extensionAboveWidgets\.length \? \([\s\S]{0,220}collapsible/, "above 实例必须可折叠");
  assert.doesNotMatch(
    app,
    /extensionBelowWidgets\.length \? <ExtensionWidgetStack[\s\S]{0,80}collapsible/,
    "below 实例不应被卷入折叠",
  );
  // 默认展开 + 持久化。
  assert.match(app, /loadUiPreferences\(\)\.extensionWidgetsCollapsed \?\? false/);
  assert.match(app, /saveUiPreferences\(\{ extensionWidgetsCollapsed: next \}\)/);
  assert.match(prefs, /extensionWidgetsCollapsed\?: boolean;/);
});