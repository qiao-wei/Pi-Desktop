/**
 * 右侧 context 面板（skills & packages）和聊天列共用同一个 --app-content-surface，
 * 界面里没有任何边界线索 —— 所以在两者之间的 resize 手柄上画一条常显的 1px 分隔线。
 *
 * 纯样式 + JSX 接线，node 里做不了行为级验证，按仓库惯例做「区域限定」结构断言：
 * ① CSS：data-divider="true" 的 ::before 拉满整列并常显，hover / 拖动时换成 --ring；
 * ② App：右侧手柄带该 flag，且由 !rightPanelCollapsed 兜住 —— 面板收起时不留悬空线；
 * ③ App：左侧手柄不带（只有右侧需要：左侧栏本来就有独立的 --app-sidebar-surface）；
 * ④ App：拖动高亮有真实来源（[data-resizing] 此前是死选择器，指针拖离手柄后
 *     :hover 会失效，线会中途变回细色）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesCss = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const appTsx = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** 以 selector 开头的第一个规则块正文。 */
function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `找不到规则: ${selector}`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `规则没有正文: ${selector}`);
  const close = source.indexOf("}", open);
  assert.ok(close > open, `规则没有收尾: ${selector}`);
  return source.slice(open + 1, close);
}

/** 具名函数的函数体：先跳过参数表，再数花括号（解构参数里的 `{}` 不算函数体）。 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到函数: ${name}`);
  const openParen = source.indexOf("(", start);
  let depth = 0;
  let cursor = openParen;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") depth += 1;
    if (source[cursor] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const openBrace = source.indexOf("{", cursor);
  assert.ok(openBrace >= 0, `函数没有正文: ${name}`);
  depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace, index + 1);
      }
    }
  }
  assert.fail(`函数体没有收尾: ${name}`);
}

/** 具名函数的签名 + 函数体（参数类型声明也在这个区间里）。 */
function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到函数: ${name}`);
  const body = functionBody(source, name);
  return source.slice(start, source.indexOf(body) + body.length);
}

/** 某个 <PanelResizeHandle /> 的 JSX 区间（按 side 定位）。 */
function handleJsx(side: "left" | "right"): string {
  const anchor = appTsx.indexOf(`side="${side}"`);
  assert.ok(anchor >= 0, `找不到 side="${side}" 的手柄`);
  const end = appTsx.indexOf("/>", anchor);
  assert.ok(end > anchor, `side="${side}" 的手柄没有收尾`);
  return appTsx.slice(anchor, end);
}

test("CSS：data-divider 的 ::before 拉满整列并常显（覆盖 hover 短滑块）", () => {
  const body = ruleBody(stylesCss, '.panel-resize-handle[data-divider="true"]::before');
  assert.match(body, /inset-block:\s*0\s*;/, "分隔线要撑满整列高度");
  assert.match(body, /height:\s*auto\s*;/, "height: auto 才能被 inset-block 拉伸");
  assert.match(body, /transform:\s*translateX\(-50%\)\s*;/, "常显时不能再留 -50% 的 Y 位移");
  assert.match(body, /opacity:\s*1\s*;/, "分隔线必须常显，不能只在 hover 出现");
  assert.match(body, /background:\s*var\(--border\)\s*;/, "分隔线用 --border");
});

test("CSS：hover / 拖动时分隔线换成 --ring", () => {
  const hover = ruleBody(stylesCss, '.panel-resize-handle[data-divider="true"]:hover::before');
  assert.match(hover, /background:\s*var\(--ring\)\s*;/, "hover 应高亮分隔线本身");
  const dragging = ruleBody(stylesCss, '.panel-resize-handle[data-divider="true"][data-resizing="true"]::before');
  assert.match(dragging, /background:\s*var\(--ring\)\s*;/, "拖动中也要高亮（:hover 可能已失效）");
});

test("App：手柄把 flag 渲染成 data-* 属性", () => {
  const component = functionSource(appTsx, "PanelResizeHandle");
  assert.ok(component.includes('data-divider={divider ? "true" : undefined}'), "缺少 data-divider 渲染");
  assert.ok(component.includes('data-resizing={resizing ? "true" : undefined}'), "缺少 data-resizing 渲染");
  assert.ok(component.includes("divider?: boolean;"), "缺少 divider prop 类型");
  assert.ok(component.includes("resizing?: boolean;"), "缺少 resizing prop 类型");
});

test("App：只有右侧手柄带分隔线，且面板收起时不画", () => {
  const right = handleJsx("right");
  assert.ok(right.includes("divider={!rightPanelCollapsed}"), `右侧手柄应带分隔线并受收起状态约束：${right}`);
  assert.ok(!handleJsx("left").includes("divider="), "左侧栏有独立底色，不该再加线");
});

test("App：拖动状态喂给 data-resizing（pointerdown 置位、pointerup 清掉）", () => {
  assert.match(functionBody(appTsx, "handlePanelResizeStart"), /setResizingSide\(side\)/);
  assert.match(functionBody(appTsx, "handlePanelResizeEnd"), /setResizingSide\(null\)/);
  assert.ok(handleJsx("right").includes('resizing={resizingSide === "right"}'), "右侧手柄要接拖动状态");
  assert.ok(handleJsx("left").includes('resizing={resizingSide === "left"}'), "左侧手柄也接（hover 短滑块同样会失效）");
});