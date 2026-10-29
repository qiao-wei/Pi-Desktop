/**
 * 「N 个文件已更改」卡片 —— 逐字对齐 ZCode 的 `ConversationFileSummaryPanel`。
 *
 * 这份 UI 走过两次弯路，所以钉的是**与参考实现的具体差距**，而不只是"有个卡片"：
 *
 * 1. 形态：一行淡灰小字 → 卡片；下一步补齐了表头 `h-10 + hover:bg-hover`、行内
 *    `hover:bg-hover/30`、`Review`/`Open` 的**分段**按钮与 20px 下拉箭头、行数只画非零。
 * 2. 位置：卡片在正文之后、`aui_assistant-message-footer` 之前（走消息的 `trailing` 槽位）。
 * 3. 接线：`bg-hover` 这类类名必须有对应 token（否则 Tailwind 静默失效，看着有类名、
 *    界面没有反馈）；`Review` 渲染**这一轮的补丁**而不是现读 git；两条点击都要把
 *    **相对项目根**的路径交给右面板（绝对路径会被判成"不在项目里"）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

const card = read("features/chat/TurnChangedFiles.tsx");
const slots = read("features/chat/ChatThreadSlots.tsx");
const thread = read("components/assistant-ui/elements/thread.aui.tsx");
const tailwind = read("app/tailwind.css");
const defaultTheme = read("themes/default/theme.css");
const codexTheme = read("themes/codex/theme.css");
const previewPane = read("features/workspace/PreviewPane.tsx");
const panelTabs = read("features/workspace/useWorkspacePanelTabs.ts");
const zh = read("i18n/zh.ts");
const en = read("i18n/en.ts");

test("外壳是 ZCode 那张卡片：圆角边框 + card 底色 + shadow-none", () => {
  assert.match(
    card,
    /data-slot="aui_turn-changed-files"\s*\n\s*className="overflow-hidden rounded-\[12px\] border border-border bg-card shadow-none"/,
  );
  // 半径必须是**绝对**像素：`rounded-xl` 在本仓是 `calc(var(--radius) + 4px)`，而 `--radius`
  // 是主题级的（默认 10px、codex 16px）→ codex 主题下 40px 高的表头会变成胶囊
  //（用户原话「这个圆角太大了」）。参考实现的 `--radius-xl` 就是 12px。
  assert.match(card, /rounded-\[8px\] border border-border bg-card px-2/);
  assert.doesNotMatch(card, /className="[^"]*rounded-(xl|lg)\b/);
  assert.doesNotMatch(card, /text-\[13px\] text-muted-foreground/, "旧的淡灰小字表头要删掉");
  assert.doesNotMatch(card, /border-s border-border\/60/, "旧的左侧竖线路径列表要删掉");
});

test("表头与行都用 ZCode 的悬停 token（token 必须真的存在）", () => {
  assert.match(card, /flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-hover/);
  assert.match(card, /px-2 py-2 text-left transition-colors hover:bg-hover\/30/);
  // 类名写了 `bg-hover`，token 没有 → Tailwind 不产出这条规则，悬停静默失效（踩过两次）。
  assert.match(tailwind, /--color-hover: var\(--color-neutral-200\)/);
  assert.match(tailwind, /--color-border-hover: color-mix/);
  assert.match(defaultTheme, /--color-hover:/);
  assert.match(codexTheme, /--color-hover:/);
});

test("表头：chevron + 标题 + 聚合增删（参考实现的破折号是 ASCII 的 -）", () => {
  assert.match(card, /group-data-open\/turn-files:rotate-90/);
  assert.match(card, /t\("chat\.changedFiles\.title", \{ count: files\.length \}\)/);
  assert.match(card, /text-diff-added">\+{totals\.added}</);
  assert.match(card, /text-diff-removed">-\{totals\.removed}</);
  assert.match(card, /aria-label=\{t\("chat\.changedFiles\.expand"\)\}/);
  // 一条都数不出来时不许出现 +0 -0（表头聚合只在有真数字时画）。
  assert.match(card, /\{anythingCounted \? \(/);
});

test("展开后每行：整行可点看改动 + 名字/目录 + 非零增删 + 审查/打开", () => {
  assert.match(card, /data-slot="aui_turn-changed-file"/);
  assert.match(card, /role="button"\s*\n\s*tabIndex=\{0\}/, "整行是 role=button（ZCode 同）");
  assert.match(card, /onClick=\{\(\) => onOpenDiff\(file\.panelPath, file\.patch\)\}/);
  assert.match(card, /\{pathLeaf\(file\.relative\)\}/);
  assert.match(card, /\{toolRowFolder\(file\.relative, workspaceRoot\)\}/);
  // 行内的数字只画**非零**那一侧（新增文件只有 `+20`，没有 `-0`）。
  assert.match(card, /\{file\.added > 0 \? \(/);
  assert.match(card, /\{file\.removed > 0 \? \(/);
  assert.match(card, /t\("chat\.changedFiles\.review"\)/);
  assert.match(card, /t\("chat\.changedFiles\.open"\)/);
  // 打开是分段控件：左边看正文，右边 20px 箭头下拉（ZCode 的 OpenSplitButton）。
  assert.match(card, /data-slot="aui_turn-changed-file-open"/);
  assert.match(card, /data-slot="aui_turn-changed-file-open-with"/);
  assert.match(card, /className="flex h-7 w-5 shrink-0/);
  assert.match(card, /onSelect=\{\(\) => onOpenInIde\(file\.panelPath\)\}/);
});

test("两条点击都把**相对项目根**的路径交给右面板（绝对路径会被判成不在项目里）", () => {
  assert.match(card, /const relative = toWorkspaceRelativePath\(file\.path, workspaceRoot\)/);
  assert.match(card, /panelPath: relative \|\| file\.path/);
  // 交给面板的一律是 panelPath，不许再出现裸的 file.path 点击。
  assert.doesNotMatch(card, /onOpenDiff\(file\.path\)/);
  assert.doesNotMatch(card, /onOpenContent\(file\.path\)/);
});

test("审查渲染这一轮的补丁，而不是现读 git（新建文件在 git 里还是 untracked）", () => {
  assert.match(card, /onOpenDiff\(file\.panelPath, file\.patch\)/);
  assert.match(panelTabs, /if \(tab\.mode === "diff" && typeof tab\.patch === "string"\)/);
  assert.match(panelTabs, /diffStatsFromPatch\(tab\.patch\)/);
  assert.match(previewPane, /subject\.origin === "turn"/);
  assert.match(zh, /"git\.source\.turn": "本轮改动"/);
});

test("位置：卡片在正文之后、操作栏之前（消息内的 trailing 槽位）", () => {
  const trailing = thread.indexOf("{trailing}");
  const footer = thread.indexOf('data-slot="aui_assistant-message-footer"');
  assert.ok(trailing > 0 && footer > 0 && trailing < footer, "trailing 必须在操作栏之前");
  assert.match(thread, /<MessageError \/>\s*\n\s*\{trailing\}\s*\n\s*<\/div>/);
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

test("两个语言包都有一致的文案键", () => {
  for (const [locale, source] of [["zh", zh], ["en", en]] as const) {
    for (const key of ["title", "review", "open", "openInIde", "expand", "openWith"]) {
      assert.ok(source.includes(`"chat.changedFiles.${key}"`), `${locale} 缺 chat.changedFiles.${key}`);
    }
  }
  assert.match(zh, /"chat\.changedFiles\.title": "\{count\} 个文件已更改"/);
  assert.match(en, /"chat\.changedFiles\.title": "\{count\} files changed"/);
  // ZCode 表头右侧的「撤销」本仓还没有 rewind 接口：不许先画一个假按钮。
  assert.doesNotMatch(card, /chat\.changedFiles\.rewind/);
});