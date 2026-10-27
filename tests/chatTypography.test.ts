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
 * 会话文本是同一套字号：正文、用户气泡、thinking / 工具行都落在 14px。
 * 只把正文调小、把这些行留在 15px，会让工具标签比答案正文还大，层级反过来。
 *
 * 2026-10-27：过程行换成 `text-ui-base`（= 14px，见 tailwind.css 的 ZCode 兼容 token），
 * 所以这里连带钉住 token 的值 —— 行不再写死 `text-[14px]`，改成引用 token 后才可能
 * 因为 token 被改而整体漂移。
 */
test("会话文本同为 14px，没有 15px 残留", () => {
  const files = {
    "thread.aui.tsx": threadTsx,
    "thinking-row.tsx": readFileSync(
      new URL("../src/components/assistant-ui/elements/thinking-row.tsx", import.meta.url),
      "utf8",
    ),
    "tool-row.tsx": readFileSync(
      new URL("../src/components/assistant-ui/elements/tool-row.tsx", import.meta.url),
      "utf8",
    ),
    "tool-bodies.tsx": readFileSync(
      new URL("../src/components/assistant-ui/elements/tool-bodies.tsx", import.meta.url),
      "utf8",
    ),
  };
  for (const [name, source] of Object.entries(files)) {
    assert.ok(!source.includes("text-[15px]"), `${name} 里不应再有 text-[15px]`);
  }
  assert.match(
    tailwindCss,
    /--text-ui-base:\s*14px;/,
    "过程行的字号 token 必须还是 14px",
  );
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
 * ZCode 的行语法：**图标在前，箭头在后**。
 *
 * 旧的「过程摘要 / 工具卡」是前置 chevron（`-ms-1` 把墨迹拉到正文左边缘），整行像一棵
 * 可折叠树的根。ZCode 两种行反过来：开头是语义图标（工具/思考），chevron 在末尾、且只在
 * hover 或展开时才可见（`group-hover/...:opacity-100`）—— 收起态下它不该出现在视线里。
 * 两条都要钉住：只把 chevron 挪到末尾、忘了 hover 才显示，行尾巴会永久多出一个箭头。
 */
test("过程行的图标在首、chevron 在尾且只在 hover/展开时可见", () => {
  const toolRowTsx = readFileSync(
    new URL("../src/components/assistant-ui/elements/tool-row.tsx", import.meta.url),
    "utf8",
  );
  const thinkingRowTsx = readFileSync(
    new URL("../src/components/assistant-ui/elements/thinking-row.tsx", import.meta.url),
    "utf8",
  );

  for (const [name, source, group] of [
    ["tool-row.tsx", toolRowTsx, "tool-summary"],
    ["thinking-row.tsx", thinkingRowTsx, "reasoning"],
  ] as const) {
    // 末尾的 chevron：hover 才显形，展开时固定显形并旋转 90°。
    const chevron = source.slice(source.indexOf("ChevronRightIcon"));
    assert.match(
      chevron,
      new RegExp(`group-hover/${group}:opacity-100`),
      `${name} 的 chevron 应该只在 hover 时出现`,
    );
    assert.match(chevron, /rotate-90 opacity-100/, `${name} 展开时 chevron 应旋转并固定显形`);
    assert.doesNotMatch(
      source,
      /-ms-1 size-4 shrink-0/,
      `${name} 不该再回到「前置 chevron」的写法`,
    );
  }
});
/* -------------------------------------------------------------------------- */
/* 块与块的节奏                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 过程行（思考 / 工具）与助手正文是**同一个列里的兄弟**，共用 ZCode 的 `--conversation-block-gap`。
 *
 * 之前不是：正文靠自己的段落外边距、行组靠一个 6px 的 `gap-1.5` 包裹层，于是
 * 「思考 · 查阅 · 思考 · 终端」这几行挤在一起，而它们与正文之间的距离又是另一套值 ——
 * 同一个时间线读起来像两种东西（用户 2026-10-27 给的 ZCode 截图就是唯一间距）。
 * 要守住三件事：列上有间距、行组不再自己加间距、正文段落的首尾外边距仍然是 0
 * （否则正文与相邻行会拿到「列间距 + 段落外边距」两份）。
 */
test("过程行与正文共用一个列间距（ZCode 的 block gap）", () => {
  assert.match(
    tailwindCss,
    /--conversation-block-gap:\s*1rem;/,
    "列间距要有名字（ZCode 默认档 = 16px）",
  );

  const content = classNameAt(threadTsx, 'data-slot="aui_assistant-message-content"');
  for (const cls of ["flex", "flex-col", "gap-[var(--conversation-block-gap)]"]) {
    assert.ok(hasClass(content, cls), `助手内容列缺少 ${cls}（当前：${content}）`);
  }

  // 行组包裹层必须是 `contents`：它自己在列里就是一个 flex item，若再有 gap，
  // 组内的行间距会比组外紧一档。
  assert.match(
    threadTsx,
    /case "group-chainOfThought":[\s\S]{0,400}?data-slot="aui_chain-of-thought" className="contents"/,
    "行组包裹层不能再带自己的 gap（否则行间距比正文间距紧）",
  );

  // 段落首尾外边距必须留着归零：文本块是 flex item，首段的上外边距会叠加在列间距上。
  assert.match(
    markdownTsx,
    /aui-md-p my-3 leading-\[1\.85\] first:mt-0 last:mb-0/,
    "正文段落要靠 first:mt-0 / last:mb-0 把首尾外边距清掉",
  );

  // 也会出现在同一条时间线上的其它 part 同样不该自带垂直 padding/margin。
  assert.doesNotMatch(threadTsx, /data-slot="aui_assistant-message-file" className="py-1"/);
  assert.doesNotMatch(threadTsx, /aui-message-error-root[^"]* mt-2/);
});
