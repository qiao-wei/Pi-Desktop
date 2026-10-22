/**
 * 侧栏会话行的「任务正在进行」状态槽（2026-10-22 按 ZCode 任务列表拍的）。
 *
 * 用户的要求是「用如图的图标，而且**真的**要一直转」：ZCode 的 `TaskListItem` 在 leading slot
 * 里放一枚 `Loader`（八道辐条）并 `animate-spin`，而 Pi Desktop 原来放的是 `Clock3` +
 * `animate-pulse` —— 时钟只脉冲，看上去像在闪，不像在转。
 *
 * 规则在纯模块里（这里直接覆盖：优先级、空槽位、动画挂哪一层），React 接线按仓库惯例从源码断言
 * —— `App.tsx` 是 .tsx，node --test 只擦类型不认 JSX，所以只能读源码。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SIDEBAR_SESSION_BUSY_ICON_CLASS,
  SIDEBAR_SESSION_BUSY_SLOT_CLASS,
  sidebarSessionBusyIndicator,
} from "../src/features/chat/sidebarStreaming.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** `SidebarSessionRow` 的源码段（到下一个顶层 `function ` 为止）。 */
function sessionRowSource(): string {
  const start = appSource.indexOf("function SidebarSessionRow(");
  assert.notEqual(start, -1, "SidebarSessionRow is gone from App.tsx");
  const end = appSource.indexOf("\nfunction ", start + 1);
  return appSource.slice(start, end === -1 ? appSource.length : end);
}

test("状态槽优先级：pending 压过 streaming，两者都不是就留空", () => {
  assert.equal(sidebarSessionBusyIndicator(true, true), "pending", "刚点下去的那一行才是用户在看的");
  assert.equal(sidebarSessionBusyIndicator(true, false), "pending");
  assert.equal(sidebarSessionBusyIndicator(false, true), "streaming");
  assert.equal(sidebarSessionBusyIndicator(false, false), "none", "空闲行不画占位圆点");
});

test("旋转挂在槽位（HTML）上，绝不挂在图标（SVG）上", () => {
  assert.match(SIDEBAR_SESSION_BUSY_SLOT_CLASS, /animate-spin/);
  assert.doesNotMatch(SIDEBAR_SESSION_BUSY_ICON_CLASS, /animate-/, "SVG 自己转会让浏览器逐帧重算样式");
});

test("会话行用会转的 Loader，不再是脉冲的时钟", () => {
  const row = sessionRowSource();

  assert.match(row, /sidebarSessionBusyIndicator\(isPending, isStreaming\)/, "状态要由纯规则判定");
  assert.match(row, /busyIndicator === "none" \? null/, "none 时整块不渲染");
  assert.match(row, /<Loader\b/, "用 ZCode 那枚八道辐条的 Loader");
  assert.match(row, /SIDEBAR_SESSION_BUSY_SLOT_CLASS/);
  assert.match(row, /t\("sidebar\.generating"\)/, "生成中的无障碍文案仍走语言包");

  // 旧实现（时钟脉冲）必须彻底让位：它既不转，语义也对不上「正在进行」。
  assert.doesNotMatch(row, /Clock3/);
  assert.doesNotMatch(row, /animate-pulse/);
});

test("Loader 图标来自 lucide，而不是自绘的替代品", () => {
  assert.match(appSource, /^\s*Loader,$/m, "App.tsx 要从 lucide-react 引入 Loader");
  assert.doesNotMatch(appSource, /^\s*Clock3,$/m, "Clock3 已无调用点，不该留着");
});