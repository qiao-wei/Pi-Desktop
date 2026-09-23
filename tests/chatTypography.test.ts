/**
 * 主聊天区排版对齐 codex-ui 的回归测试。
 *
 * 口径（对齐 codex-ui 的 `src/styles/global.css`）：
 * - 全局字体栈：`-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", ...`
 *   （不再把可能没被加载的 Inter 排在第一位，避免和 codex-ui 渲染出两套字形）；
 * - 助手正文：14px / line-height 1.85（codex-ui `.prose` 为 1.72；2026-09-19 先由 15px 下调到 14px，
 *   随即用户要求「行间隔大一点」，行高由 1.72 提到 1.85，行盒回到下调前的绝对高度）；
 * - 用户气泡：14px / line-height 1.6（codex-ui `.user-bubble`，2026-09-19 由 14.5px 对齐助手正文）；
 * - 行内代码：0.86em + `--mono` 等宽栈（codex-ui `.inline-code` / `--mono`）。
 *
 * 这些是纯样式值，node 里跑不了行为级验证，因此按仓库惯例（见 composerResponsive.test.ts）
 * 做「区域限定」的结构断言：每条断言都先定位目标规则/元素区间再检查，
 * 避免被文件其它位置的相同写法假绿。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesCss = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const tailwindCss = readFileSync(new URL("../src/app/tailwind.css", import.meta.url), "utf8");
const threadTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url),
  "utf8",
);
const markdownTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/markdown-text.tsx", import.meta.url),
  "utf8",
);

/** 以 selector 开头的第一个规则块正文（不含选择器与花括号）。 */
function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `找不到规则: ${selector}`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `规则没有正文: ${selector}`);
  const close = source.indexOf("}", open);
  assert.ok(close > open, `规则没有收尾: ${selector}`);
  return source.slice(open + 1, close);
}

/** 锚点所在元素上的 className 字符串（从锚点切到该元素的 `>`）。 */
function classNameAt(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  assert.ok(start >= 0, `找不到锚点: ${anchor}`);
  const end = source.indexOf(">", start);
  assert.ok(end > start, `锚点所在元素没有收尾: ${anchor}`);
  const region = source.slice(start, end);
  const match = /className=(["'`])([^"'`]*)\1/.exec(region);
  assert.ok(match, `锚点所在元素没有 className: ${anchor}`);
  return match[2];
}

/** className 里是否含某个 Tailwind token（用空白切分，避开 `]` 后 \b 不成立的坑）。 */
function hasClass(className: string, token: string): boolean {
  return className.split(/\s+/).includes(token);
}

/** 包含 fragment 的第一个 className 字符串（锚点本身就在类名里时用）。 */
function classNameContaining(source: string, fragment: string): string {
  const re = /className=(["'`])([^"'`]*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[2].includes(fragment)) {
      return match[2];
    }
  }
  assert.fail(`找不到包含 ${fragment} 的 className`);
}

test("全局字体栈对齐 codex-ui（系统字体优先，不再优先 Inter）", () => {
  const root = ruleBody(stylesCss, ":root {");
  assert.match(root, /font-family:\s*\n?\s*-apple-system, BlinkMacSystemFont, "SF Pro Text"/, "字体栈第一梯队应为 -apple-system / SF Pro Text");
  assert.match(root, /"PingFang SC"/, "需要显式声明中文回退字体 PingFang SC");
  assert.doesNotMatch(root, /\bInter\b/, "Inter 未随应用加载，不应再排在字体栈第一位");
});

test("助手正文 14px / 1.85", () => {
  const cls = classNameAt(threadTsx, 'data-slot="aui_assistant-message-content"');
  assert.ok(hasClass(cls, "text-[14px]"), `助手正文应为 14px（当前：${cls}）`);
  assert.ok(hasClass(cls, "leading-[1.85]"), `助手正文行高应为 1.85（当前：${cls}）`);
  assert.ok(!hasClass(cls, "leading-relaxed"), "leading-relaxed（1.625）会盖掉 1.85");
});

test("用户气泡 14px / 1.6（codex-ui .user-bubble）", () => {
  const cls = classNameContaining(threadTsx, "aui-user-message-content peer");
  assert.ok(hasClass(cls, "text-[14px]"), `用户气泡应为 14px（当前：${cls}）`);
  assert.ok(hasClass(cls, "leading-[1.6]"), `用户气泡行高应为 1.6（当前：${cls}）`);
});

/**
 * 会话文本是同一套字号：正文、用户气泡、thinking / 工具 / 过程行都落在 14px。
 * 只把正文调小、把这些行留在 15px，会让工具标签比答案正文还大，层级反过来。
 */
test("会话文本同为 14px，没有 15px 残留", () => {
  const files = {
    "thread.aui.tsx": threadTsx,
    "reasoning.tsx": readFileSync(
      new URL("../src/components/assistant-ui/elements/reasoning.tsx", import.meta.url),
      "utf8",
    ),
    "tool-call.tsx": readFileSync(
      new URL("../src/components/assistant-ui/elements/tool-call.tsx", import.meta.url),
      "utf8",
    ),
    "tool-group.aui.tsx": readFileSync(
      new URL("../src/components/assistant-ui/elements/tool-group.aui.tsx", import.meta.url),
      "utf8",
    ),
    "tool-fallback.aui.tsx": readFileSync(
      new URL("../src/components/assistant-ui/elements/tool-fallback.aui.tsx", import.meta.url),
      "utf8",
    ),
  };
  for (const [name, source] of Object.entries(files)) {
    assert.ok(!source.includes("text-[15px]"), `${name} 里不应再有 text-[15px]`);
  }
});

test("气泡内文本行高与气泡一致（不让 1.55 覆盖）", () => {
  const body = ruleBody(stylesCss, ".aui-user-message-content .inline-message-text {");
  assert.match(body, /line-height:\s*1\.6\s*;/, "inline-message-text 行高应跟随气泡 1.6");
});

test("markdown 正文段落/列表行高 1.85", () => {
  assert.match(markdownTsx, /aui-md-p my-3 leading-\[1\.85\]/, "段落行高应为 1.85");
  assert.match(markdownTsx, /aui-md-li leading-\[1\.85\]/, "列表项行高应为 1.85");
});

test("行内代码 0.86em + codex-ui 等宽栈", () => {
  assert.match(markdownTsx, /aui-md-inline-code[^"]*text-\[0\.86em\]/, "行内代码应为 0.86em");
  const theme = tailwindCss.slice(tailwindCss.indexOf("@theme inline"));
  assert.match(theme, /--font-mono:\s*"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;/, "--font-mono 应对齐 codex-ui 的 --mono");
});

/**
 * 前置摺叠箭头要与正文排在同一列：chevron 图标的字面（glyph）在 16px 盒子里左侧
 * 有 6px 空白，只对齐盒子会让箭头看起来比正文右移，因此用 `-ms-1` 把整组（箭头 + 标签）
 * 向左拉 4px，使箭头墨迹与段落左边缘齐平。
 */
test("前置摺叠箭头向左拉一档，与正文左边缘对齐", () => {
  const leadingChevrons = [
    ["thread.aui.tsx（过程摘要）", threadTsx, /"-ms-1 size-4 shrink-0 opacity-70/],
    ["tool-call.tsx（工具行）", readFileSync(
      new URL("../src/components/assistant-ui/elements/tool-call.tsx", import.meta.url),
      "utf8",
    ), /"-ms-1 size-4 shrink-0 opacity-60/],
  ] as const;

  for (const [name, source, pattern] of leadingChevrons) {
    assert.match(source, pattern, `${name} 的前置 chevron 需要 -ms-1`);
  }
});