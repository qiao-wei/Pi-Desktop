/**
 * UsagePopover 元信息行（大百分比右侧那块）的回归测试。
 *
 * 背景：「已使用 x / y · 预计费用 ¥z」在 336px 弹层里内容顶边，值一长就折行
 * （用户截图反馈）。用户口径：**任何情况下都保持单行不换行**。
 * 现在：整块 meta 一个 whitespace-nowrap（单行硬约束），弹层加宽到 380px
 * 兑付这个 nowrap；费用仍走 estimatedCostUsd != null 条件渲染。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appTsx = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** 限定在 UsagePopover 函数体内，避免被文件其它位置的相同写法假绿。 */
function usagePopoverBody(): string {
  const start = appTsx.indexOf("function UsagePopover");
  assert.ok(start >= 0, "找不到 UsagePopover");
  const end = appTsx.indexOf("function formatCny", start);
  assert.ok(end > start, "找不到 UsagePopover 区间终点");
  return appTsx.slice(start, end);
}

test("元信息单行硬约束：整块 whitespace-nowrap，token 与费用仍用「·」内联", () => {
  const body = usagePopoverBody();
  assert.match(
    body,
    /className="min-w-0 whitespace-nowrap text-xs leading-snug text-muted-foreground"/,
    "meta 块缺 whitespace-nowrap（单行硬约束）",
  );
  assert.match(body, /\{" · "\}/, "token 与费用之间应保留「·」分隔");
  assert.match(body, /t\("usage\.usedOfWindow", \{ used: formatTokens\(stats\.contextTokens\), total: formatTokens\(stats\.contextWindow\) \}\)/);
  assert.match(body, /t\("usage\.estimatedCost", \{ cost: formatCny\(estimatedCostUsd\) \}\)/);
});

test("弹层加宽到 380px（移动端 356px），给 nowrap 留出余量", () => {
  const body = usagePopoverBody();
  assert.match(body, /w-\[min\(380px,calc\(100vw-28px\)\)\]/, "弹层基础宽度应加宽到 380px");
  assert.match(body, /max-\[560px\]:w-\[min\(356px,calc\(100vw-24px\)\)\]/, "移动端档应加宽到 356px");
});

test("费用段只在有预计费用时渲染", () => {
  const body = usagePopoverBody();
  assert.match(
    body,
    /\{estimatedCostUsd != null \? \([\s\S]{0,160}t\("usage\.estimatedCost", \{ cost: formatCny\(estimatedCostUsd\) \}\)/,
    "费用段应保留 estimatedCostUsd != null 的条件渲染",
  );
});
