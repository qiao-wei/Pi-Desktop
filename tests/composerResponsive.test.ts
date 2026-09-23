/**
 * Composer 窄空间自适应（重叠/出框修复）的回归测试。
 *
 * 背景：composer 工具行两侧都是固定 min-width 的控件组，空间不足时组内按钮缩不动，
 * 内容从组盒子里溢出 —— 左组压到右组（重叠），send 按钮顶出 surface 边框（出框）。
 * 截图场景正是宽窗口开着右侧面板把 composer 压窄：旧的 `@media (max-width: 560px)`
 * 只看视口宽度，面板拖动永远触发不了。
 *
 * 设计（用户拍板）：
 * ① 聊天列（.conversation-surface）作为 inline-size container，composer 的窄档
 *    全部用 container query（拖侧栏/面板实时生效）；
 * ② 工具行单行是硬约束：空间不够按档位收窄 —— <600px 收 Thinking 文字标签，
 *    <460px 语音按钮收起、模型名压到 132px，<380px Thinking 下拉整体收进
 *    ⋯ 菜单（ComposerOverflowMenu：档位 + 语音入口），模型名再压到 110px；
 * ③ 明确不折行（无 flex-wrap），也不许用 overflow: hidden 把出框遮过去。
 *
 * CSS 在 node 里做不了行为级验证，按仓库惯例做「区域限定」的结构断言：每条断言
 * 都先定位目标规则块/at-rule 再检查，避免被文件其它位置的相同写法假绿。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesCss = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const appTsx = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const modelSelectTsx = readFileSync(
  new URL("../src/features/models/ComposerModelSelect.tsx", import.meta.url),
  "utf8",
);

/** 找到以 header 开头的 at-rule 块（@container / @media ...），返回完整块文本。 */
function findAtRuleBlock(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `找不到 at-rule: ${header}`);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") {
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  assert.fail(`at-rule 块没有收尾: ${header}`);
}

/** 把断言限定在 startMarker 与 endMarker 之间的区间。 */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `找不到区间起点: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `找不到区间终点: ${endMarker}`);
  return source.slice(start, end);
}

/** 某选择器的全部规则块正文（不含嵌套，够用：composer 规则都是平的）。 */
function ruleBodies(source: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(new RegExp(`${escaped} \\{([^}]*)\\}`, "g"))].map((m) => m[1]);
}

/* ---------------------------------------------------------- container 容器 */

test("聊天列是 inline-size container：窄档随面板拖动生效，而不是只看窗口宽", () => {
  const bodies = ruleBodies(stylesCss, ".conversation-surface");
  assert.ok(
    bodies.some((body) => /container-type:\s*inline-size/.test(body)),
    ".conversation-surface 缺 container-type: inline-size",
  );
});

/* ---------------------------------------------------------- 单行硬约束 */

test("工具行不折行：任何 composer 规则里都不再出现 flex-wrap（用户要求单行）", () => {
  for (const body of ruleBodies(stylesCss, ".composer-toolbar")) {
    assert.doesNotMatch(body, /flex-wrap/, ".composer-toolbar 不该折行");
  }
  const tier460 = findAtRuleBlock(stylesCss, "@container (max-width: 460px)");
  assert.doesNotMatch(tier460, /flex-wrap/, "460 档也不该折行");
});

test("不允许用 overflow: hidden 把出框遮过去（那会把 send 裁掉一半）", () => {
  const bodies = ruleBodies(stylesCss, ".composer-surface");
  assert.ok(bodies.length > 0, "找不到 .composer-surface 规则");
  for (const body of bodies) {
    assert.doesNotMatch(body, /overflow:\s*hidden/, ".composer-surface 不该裁剪内容");
  }
});

/* ------------------------------------------------------------ container 档位 */

test("600px 档：收 Thinking 文字标签、压 composer 内边距", () => {
  const tier = findAtRuleBlock(stylesCss, "@container (max-width: 600px)");
  assert.match(tier, /\.thinking-level-label \{[^}]*display:\s*none/);
  assert.match(tier, /\.composer \{[^}]*padding:\s*10px 12px/);
});

test("460px 档：语音按钮收起，模型 trigger 压到 132px", () => {
  const tier = findAtRuleBlock(stylesCss, "@container (max-width: 460px)");
  assert.match(tier, /\.composer-tool-mic \{[^}]*display:\s*none/);
  assert.match(tier, /\.composer-model-trigger \{[^}]*max-width:\s*132px/);
  // usage ring（上下文占用）保留：usage-trigger 不允许出现在隐藏规则里
  assert.doesNotMatch(tier, /usage-trigger[^{]*\{[^}]*display:\s*none/);
});

test("380px 档：Thinking 下拉收进 ⋯ 菜单，⋯ 按钮显示，模型名再压一档", () => {
  const tier = findAtRuleBlock(stylesCss, "@container (max-width: 380px)");
  assert.match(tier, /\.thinking-level-select \{[^}]*display:\s*none/);
  assert.match(tier, /\.composer-tool-overflow \{[^}]*display:\s*inline-flex/);
  assert.match(tier, /\.composer-model-trigger \{[^}]*max-width:\s*110px/);
  // ⋯ 按钮默认隐藏，只在窄档出现
  const base = ruleBodies(stylesCss, ".composer-tool-overflow");
  assert.ok(
    base.some((body) => /display:\s*none/.test(body)),
    ".composer-tool-overflow 缺默认 display: none",
  );
});

test("旧的 560px 视口媒体查询不再携带 composer 档位规则", () => {
  const mediaIndex = stylesCss.indexOf("@media (max-width: 560px)");
  if (mediaIndex < 0) {
    return;
  }
  const block = findAtRuleBlock(stylesCss, "@media (max-width: 560px)");
  assert.doesNotMatch(block, /\.composer|\.thinking-level-label|\.send-button/);
});

/* --------------------------------------------------------------- TSX 接线 */

test("Thinking 下拉挂 thinking-level-select 类、标签挂 thinking-level-label 类，视口隐藏类已移除", () => {
  const region = sliceBetween(appTsx, "function ThinkingLevelSelect", "function thinkingLevelLabel");
  assert.match(region, /"thinking-level-select /, "下拉 wrapper 缺 thinking-level-select 类");
  assert.match(region, /"thinking-level-label /, "标签 span 缺 thinking-level-label 类");
  assert.doesNotMatch(region, /max-\[560px\]:hidden/, "还在用视口媒体查询隐藏");
});

test("⋯ 收纳菜单：档位项接线 onThinkingLevelChange，语音入口保留（disabled）", () => {
  const region = sliceBetween(appTsx, "function ComposerOverflowMenu", "function ThinkingLevelSelect");
  assert.match(region, /composer-tool-button composer-tool-overflow/, "⋯ 按钮缺 composer-tool-overflow 类");
  assert.match(region, /<MoreHorizontal/, "⋯ 按钮缺 MoreHorizontal 图标");
  // 2026-09-16 起菜单按当前模型档位渲染（levels = 模型档位表，缺数据兜底固定 thinkingLevels），
  // 行为级守卫见 modelThinkingLevels.test.ts；这里只保证菜单仍有档位项。
  assert.match(region, /levels\.map/, "菜单缺 Thinking 档位项");
  assert.match(region, /onSelect=\{\(\) => onThinkingLevelChange\(level\)\}/, "档位项没接线 onThinkingLevelChange");
  assert.match(region, /<DropdownMenuItem disabled>/, "菜单缺语音入口（disabled）");
});

test("工具行渲染 ComposerOverflowMenu，档位与原下拉同一套禁用条件", () => {
  const toolbar = sliceBetween(appTsx, 'className="composer-toolbar"', 'className="composer-actions"');
  assert.match(toolbar, /<ComposerOverflowMenu/);
  const call = sliceBetween(appTsx, "<ComposerOverflowMenu", "/>");
  assert.match(call, /state\.selectedThinkingLevel/);
  assert.match(
    call,
    /disabled=\{composerSessionBusy\}/,
    "⋯ 按钮的禁用条件应与 Thinking 下拉一致（与服务端 isSessionBusy 对齐）",
  );
  assert.match(call, /updateSessionThinkingLevel/);
});

test("mic 按钮挂 composer-tool-mic 类，供 460px 档收起", () => {
  // 限定在 mic 按钮 JSX（className 行 → Mic 图标）内，且全文件只此一处
  const button = sliceBetween(
    appTsx,
    'className="composer-tool-button composer-tool-mic"',
    "<Mic size={18} />",
  );
  assert.match(button, /aria-label="Voice input reserved"/);
  assert.equal(appTsx.split("composer-tool-mic").length - 1, 1, "composer-tool-mic 应只挂在 mic 一颗按钮上");
});

test("模型 trigger 允许收缩（min-w-0），truncate 才能在窄档生效", () => {
  assert.match(
    modelSelectTsx,
    /composer-model-trigger h-\[30px\] min-w-0 max-w-\[190px\]/,
    "trigger 缺 min-w-0",
  );
});
