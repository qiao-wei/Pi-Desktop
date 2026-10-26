/**
 * 窄屏（≤920px）下右侧面板是贴右边缘的固定浮层。它必须从标题栏**下面**开始：
 *
 * 标题栏是 `z-[100]` 的不透明横条（App.tsx 里 .app-titlebar），浮层只有 z-20。浮层若用
 * `inset-y-0` 从 y=0 铺满，顶部那一条（`--titlebar-height`，默认 40px / codex 46px）
 * 就被标题栏整条盖住 —— 面板第一行是搜索框，
 * 用户看到的是「面板搜索显示不全」（2026-09-21 截图反馈：搜索框只剩一条边）。
 *
 * 左侧项目栏一直是 `top-[var(--titlebar-height)] + bottom-0`，右侧面板跟着对齐。
 * 这里做区域限定断言：只读 aside 那段 className，不锁整文件其它写法。
 *
 * 2026-10-10：右侧面板的壳（aside + 视图 strip）从 App.tsx 移到了
 * `src/features/workspace/RightPanel.tsx`，断言跟着搬家 —— 契约没变，只是它的家在别处。
 * 起点标记也从 `"context-panel-surface grid` 放宽成 `"context-panel-surface`：面板从
 * `grid + content-start`（整块滚动）改成了 `flex flex-col`（固定 strip + 内层滚动），
 * 把布局方式写进标记就等于锁住了实现细节。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { RIGHT_PANEL_TAB_FRAME } from "../src/features/workspace/rightPanelTabs.ts";
import { appSource as readAppSource } from "./lib/appSource.ts";

const appSourceText = readAppSource();
const rightPanelSource = readFileSync(
  new URL("../src/features/workspace/RightPanel.tsx", import.meta.url),
  "utf8",
);

/** `marker` 到 `endMarker` 之间的源码片段。 */
function sliceBetween(source: string, marker: string, endMarker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `找不到起点: ${marker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `找不到终点: ${endMarker}`);
  return source.slice(start, end);
}

test("窄屏浮层面板从标题栏下面开始铺（不是 inset-y-0）", () => {
  const aside = sliceBetween(rightPanelSource, '"context-panel-surface', 'aria-label={t("rightPanel.aria")}');

  assert.match(aside, /max-\[920px\]:fixed/, "面板在窄屏应是 fixed 浮层");
  assert.match(aside, /max-\[920px\]:top-\[var\(--titlebar-height\)\]/, "面板顶边要对齐标题栏下沿");
  assert.match(aside, /max-\[920px\]:bottom-0/, "面板底边要贴住窗口底");
  assert.doesNotMatch(aside, /inset-y-0/, "inset-y-0 会让标题栏盖住面板第一行（搜索框）");
});

test("左侧项目栏和右侧面板用同一套窄屏定位，不会再次跑偏", () => {
  // 收口用侧栏自己的 aria-label（语义终点），原来的收口是写死的阴影 class 字符串：
  // 阴影改走 `--app-*` token 后那种断言就只是「锁住实现细节」了。
  const sidebar = sliceBetween(
    appSourceText,
    '"project-sidebar-surface',
    'aria-label={t("sidebar.projectsAria")}',
  );

  assert.match(sidebar, /max-\[920px\]:top-\[var\(--titlebar-height\)\]/);
  assert.match(sidebar, /max-\[920px\]:bottom-0/);
  // 抽屉阴影也要跟着主题走：默认主题的值就是原来那个 rgba(20,24,22,0.16)
  assert.match(sidebar, /max-\[920px\]:shadow-\[var\(--app-shadow-drawer-right\)\]/);
});

test("竖直内边距留在 aside 上（codex 主题要覆盖 padding-top，挪进内层就会多一段空隙）", () => {
  const aside = sliceBetween(rightPanelSource, '"context-panel-surface', 'aria-label={t("rightPanel.aria")}');

  assert.match(aside, /\bpt-\[18px\]/, "默认主题下的顶部内边距必须挂在这个 aside 上");
  assert.doesNotMatch(aside, /\bp-\[18px\]\b/, "水平内边距要在内层，滚动条才能贴住面板右边缘");
  // 水平/底部内边距归内层各视图自己（见 rightPanelTabs.test.ts 的内容框常量）：
  // 内容框只负责「钉住头部 + 正文自己滚」，不许把竖直内边距挪进来。
  assert.ok(!RIGHT_PANEL_TAB_FRAME.includes("pt-["));
  assert.match(rightPanelSource, /className=\{RIGHT_PANEL_TAB_FRAME\}/);
});