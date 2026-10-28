/**
 * 「N 个文件已更改」卡片的形状与位置（对齐 ZCode 的 `ConversationFileSummaryPanel`）。
 *
 * 这份 UI 之前是一行淡灰小字 + 缩进的等宽路径列表：没有汇总数字、没有单行增删、
 * 没有打开入口，而且挂在消息操作栏**下面**（读起来像消息的装饰，不像这一轮回答的
 * 一部分）。所以这里钉住的是三件容易回退的事：
 *
 * 1. **卡片语法**：`rounded-xl border border-border bg-card` 的外壳、`h-10` 表头、
 *    表头里强行数（`+X −Y`）、展开后每行「名字 + 目录 + 增删 + 审查/打开」。
 * 2. **位置**：卡片在正文之后、`aui_assistant-message-footer` 之前 —— 走消息里的
 *    `trailing` 槽位，而不是 `ChatThreadSlots` 里 `<AssistantMessage />` 的兄弟节点。
 * 3. **不编数字**：一条都数不出来时，表头不显示 `+0 −0`。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

const card = read("features/chat/TurnChangedFiles.tsx");
const slots = read("features/chat/ChatThreadSlots.tsx");
const thread = read("components/assistant-ui/elements/thread.aui.tsx");
const zh = read("i18n/zh.ts");
const en = read("i18n/en.ts");

test("外壳是 ZCode 那张卡片：圆角边框 + card 底色，不是一行淡灰小字", () => {
  assert.match(
    card,
    /data-slot="aui_turn-changed-files"\s*\n\s*className="w-full overflow-hidden rounded-xl border border-border bg-card"/,
    "卡片外壳必须是 rounded-xl + border-border + bg-card",
  );
  assert.doesNotMatch(card, /text-\[13px\] text-muted-foreground/, "旧的淡灰小字表头要删掉");
  assert.doesNotMatch(card, /border-s border-border\/60/, "旧的左侧竖线路径列表要删掉");
});

test("表头：chevron + 标题 + 聚合增删，高度与 ZCode 一致（h-10）", () => {
  assert.match(card, /flex h-10 items-center justify-between gap-3 px-2/);
  assert.match(card, /group-data-open\/turn-files:rotate-90/, "展开时 chevron 转 90°");
  assert.match(card, /t\("chat\.changedFiles\.title", \{ count: files\.length \}\)/);
  assert.match(card, /text-diff-added">\+{totals\.added}</);
  assert.match(card, /text-diff-removed">−{totals\.removed}</);
  // 一条都数不出来时不许出现 +0 −0（"没有值"和"零"在界面上长得一样，但意思相反）。
  assert.match(card, /\{anythingCounted \? \(/);
});

test("展开后每行：类型图标 + 文件名 + 目录 + 自己的增删 + 审查/打开", () => {
  assert.match(card, /data-slot="aui_turn-changed-file"/);
  assert.match(card, /data-changed-path=\{file\.relative\}/);
  assert.match(card, /<FileText aria-hidden="true" className="size-3\.5/);
  assert.match(card, /\{pathLeaf\(file\.relative\)\}/);
  assert.match(card, /\{toolRowFolder\(file\.relative, workspaceRoot\)\}/);
  assert.match(card, /\{file\.counted \? \(/, "数不出来的行不显示增删");
  assert.match(card, /t\("chat\.changedFiles\.review"\)/);
  assert.match(card, /t\("chat\.changedFiles\.open"\)/);
  // 点名字/行 → 看 diff；「打开」→ 看内容；右键菜单还用得上 IDE。
  assert.match(card, /onClick=\{\(\) => onOpenDiff\(file\.path\)\}/);
  assert.match(card, /onClick=\{\(\) => onOpenContent\(file\.path\)\}/);
  assert.match(card, /onOpenInIde=\{onOpenInIde\}/);
});

test("位置：卡片在正文之后、操作栏之前（消息内的 trailing 槽位）", () => {
  const trailing = thread.indexOf("{trailing}");
  const footer = thread.indexOf('data-slot="aui_assistant-message-footer"');
  assert.ok(trailing > 0, "消息里要渲染 trailing");
  assert.ok(footer > 0, "操作栏还在");
  assert.ok(trailing < footer, "trailing 必须在操作栏之前，否则卡片落到消息脚注下面");
  assert.match(thread, /const AssistantMessageTrailingContext = createContext<ReactNode>\(null\)/);
  assert.match(thread, /export function AssistantMessageTrailingProvider/);
  // 槽位 DOM 层：紧跟 parts 之后、仍在 content 列内（`<MessageError />` 后面那一行），
  // 不是 Root 的最后一个孩子 —— 列本身带着正文字号与 `--conversation-block-gap` 的节奏。
  assert.match(thread, /<MessageError \/>\s*\n\s*\{trailing\}\s*\n\s*<\/div>/);
  // 挂载点：ChatThreadSlots 通过 provider 传入，不再在 <AssistantMessage /> 之后并列渲染。
  assert.match(slots, /<AssistantMessageTrailingProvider/);
  assert.match(slots, /trailing=\{[\s\S]*?<TurnChangedFiles/);
  assert.doesNotMatch(
    slots,
    /<\/AssistantMessage>\s*\n\s*\{actions && !isRunning \? \(\s*\n\s*<TurnChangedFiles/,
    "不许再挂到 <AssistantMessage /> 外面",
  );
});

test("仍在跑的时候不出现（工具还在跑，列表会一行行往外蹦）", () => {
  assert.match(slots, /actions && !isRunning \? \(/);
});

test("两个语言包都有一致的文案键（标题 + 审查 + 打开）", () => {
  for (const [locale, source] of [["zh", zh], ["en", en]] as const) {
    for (const key of ["title", "review", "open", "openInIde"]) {
      assert.ok(source.includes(`"chat.changedFiles.${key}"`), `${locale} 缺 chat.changedFiles.${key}`);
    }
  }
  assert.match(zh, /"chat\.changedFiles\.title": "\{count\} 个文件已更改"/);
  assert.match(en, /"chat\.changedFiles\.title": "\{count\} files changed"/);
  // ZCode 表头右侧的「撤销」本仓还没有 rewind 接口：不许先画一个假按钮。
  assert.doesNotMatch(card, /chat\.changedFiles\.rewind/);
});