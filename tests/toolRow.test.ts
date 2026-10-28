/**
 * 工具行的语法与两个主题的 token。
 *
 * 行是「图标 + 动作词 + 目标 + 状态 + 尾部 chevron」，直接照 ZCode 的
 * `ToolCallBlocks/ToolSummaryRow.tsx` / `ToolLayout.tsx` 抄过来的（见
 * docs/adr/ADR-006）。这些类名和配色不是随便挑的：`text-foreground-subtlest`
 * 那几档在 ZCode 里是「最淡的一层文字」，本仓库原来只有 `text-foreground/35`
 * 这类临时写法，所以这条测试同时钉住 token 与用法 —— 只抄组件、不抄 token，
 * 行的层级就会和参考实现不一样。
 *
 * 结构断言按仓库惯例限定在目标文件内，避免文件别处的相同写法造成假绿。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { toolRowFamily } from "../src/shared/toolDisplay.ts";

const toolRow = readFileSync(
  new URL("../src/components/assistant-ui/elements/tool-row.tsx", import.meta.url),
  "utf8",
);
const toolRowReadouts = readFileSync(
  new URL("../src/components/assistant-ui/elements/tool-row-readouts.tsx", import.meta.url),
  "utf8",
);
const toolBodies = readFileSync(
  new URL("../src/components/assistant-ui/elements/tool-bodies.tsx", import.meta.url),
  "utf8",
);
const tailwindCss = readFileSync(new URL("../src/app/tailwind.css", import.meta.url), "utf8");
const defaultTheme = readFileSync(
  new URL("../src/themes/default/theme.css", import.meta.url),
  "utf8",
);
const codexTheme = readFileSync(
  new URL("../src/themes/codex/theme.css", import.meta.url),
  "utf8",
);

test("工具行按工具名分族：MCP 名字先于内置名判定", () => {
  assert.equal(toolRowFamily("read"), "read");
  assert.equal(toolRowFamily("write"), "write");
  assert.equal(toolRowFamily("edit"), "edit");
  assert.equal(toolRowFamily("bash"), "execute");
  assert.equal(toolRowFamily("powershell"), "execute");
  assert.equal(toolRowFamily("grep"), "search");
  assert.equal(toolRowFamily("ls"), "search");
  assert.equal(toolRowFamily("find"), "search");
  assert.equal(toolRowFamily("mcp__github__create_issue"), "mcp");
  assert.equal(toolRowFamily("codemode"), "other", "未知工具落到 fallback 行，而不是消失");
});

test("行是 ZCode 的 geometry：图标在首、动作词可扫光、内容组最淡", () => {
  assert.match(
    toolRow,
    /group\/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base/,
    "摘要行的类名应与 ToolSummaryRow 一致",
  );
  assert.match(
    toolRow,
    /shrink-0 text-foreground-subtlest \[&_svg\]:text-foreground-subtlest/,
    "首图标用最淡一档，并且要把颜色传给 lucide 的 svg",
  );
  assert.match(
    toolRow,
    /running \? "shimmer motion-reduce:animate-none" : "text-foreground-subtlest"/,
    "运行中的动作词扫光，结束后落到最淡文字（ZCode 的 animated-gradient-text）",
  );
  assert.match(toolRow, /min-w-0 flex max-w-full items-center gap-2 text-foreground-subtlest/);
});

test("状态词只在有信息时出现：失败才带虚线下划线与可复制 tooltip", () => {
  // ZCode 的 showStatusLabel/showFailureStatus：成功行上不出现「Completed」。
  assert.match(
    toolRow,
    /statusLabel=\{isError \? t\("process\.status\.failed"\) : presentation\.statusLabel\}/,
    "只有失败（或工具自己声明）时才给状态词",
  );
  // 状态词与「行」同住一行，但两个只读小件（+N −M / 失败词 + 复制按钮）拆到了
  // tool-row-readouts.tsx（行文件有 max-lines 棘轮）。
  assert.match(toolRowReadouts, /underline decoration-dotted underline-offset-2/);
  assert.match(toolRowReadouts, /navigator\.clipboard\.writeText\(tooltip\)/, "tooltip 里要能复制错误");
  assert.match(toolRow, /<StatusWord label=\{statusLabel\}/, "行渲染的是那个状态词组件");
  // 旧实现把错误正文前缀成 `Error: ` 塞进正文；现在错误只挂在状态词上。
  assert.doesNotMatch(toolRow, /Error: \$\{|`Error: /, "正文不该再被 `Error:` 前缀污染");
});

test("MCP 行显示 server 作为 kindDetail，工具名去重复前缀；skill 之类没有专门行", () => {
  assert.match(toolRow, /parseMcpToolName\(toolName\)/);
  assert.match(toolRow, /t\("process\.tool\.mcp"\)/, "MCP 的动作词走 i18n 词表");
  assert.match(toolRow, /stripRepeatedPrefix\(/, "server 名与 tool 名重复时只显示一次");
  assert.match(toolRow, /kindDetail:/, "server 名走 kindDetail 槽位，不占主文本");
  // pi 没有 skill 工具（skills 是提示资源，不是工具），所以不做 skill 行。
  assert.doesNotMatch(toolRow, /WandSparkles|process\.tool\.skill/);
});

test("read / grep / ls / find 只有摘要行，没有正文", () => {
  const readCase = toolRow.slice(toolRow.indexOf('case "read": {'), toolRow.indexOf('case "write":'));
  assert.ok(readCase.length > 0, "read 分支不见了");
  assert.match(readCase, /canToggle: false/, "read 是纯摘要（ZCode canToggle={false}）");
  assert.doesNotMatch(readCase, /body:/, "read 不展开正文");
  // 搜索族整个分支都不该带 body。
  const searchCase = toolRow.slice(
    toolRow.indexOf('case "search": {'),
    toolRow.indexOf('case "mcp": {'),
  );
  assert.ok(searchCase.length > 0, "search 分支不见了");
  assert.doesNotMatch(searchCase, /body:/, "搜索行是纯摘要（ZCode canToggle={false}）");
  assert.match(searchCase, /process\.tool\.search\.findWithQuery/);
  assert.match(searchCase, /process\.tool\.search\.listIn/);
});

test("正文按模型分派：diff / 终端 / MCP / 参数+结果，且都不解析文本", () => {
  assert.match(toolBodies, /export function DiffBody/);
  assert.match(toolBodies, /export function TerminalBody/);
  assert.match(toolBodies, /export function McpBody/);
  assert.match(toolBodies, /export function PartsBody/);
  assert.match(toolRow, /<DiffBody/);
  assert.match(toolRow, /<TerminalBody/);
  assert.match(toolRow, /<McpBody/);
  assert.match(toolRow, /<PartsBody/);
  // 这些组件只消费 ToolDisplay；一旦出现 JSON.parse / includes("diff ") 之类，
  // 解析就漏到渲染层了。
  assert.doesNotMatch(toolBodies, /JSON\.parse|stringifyValue/);
});

test("展开正文有 300ms 延迟卸载，避免 Radix 收起动画量到错的高度", () => {
  for (const [name, source] of [
    ["tool-row.tsx", toolRow],
    [
      "thinking-row.tsx",
      readFileSync(
        new URL("../src/components/assistant-ui/elements/thinking-row.tsx", import.meta.url),
        "utf8",
      ),
    ],
  ] as const) {
    assert.match(source, /CONTENT_UNMOUNT_DELAY_MS = 300/, `${name} 需要 300ms 卸载保护`);
    assert.match(source, /data-closed:animate-collapsible-up data-open:animate-collapsible-down/);
  }
});

test("ZCode 兼容 token 落在 tailwind.css，深色只在各主题的 .dark 里覆盖", () => {
  // 两份主题都必须能解释这些名字，否则另一套配色下行的层级会退回默认值。
  assert.match(tailwindCss, /--text-ui-base:\s*14px;/);
  assert.match(tailwindCss, /--text-ui-xs:\s*10px;/);
  assert.match(tailwindCss, /--color-foreground-subtle:\s*var\(--foreground-subtle\)/);
  assert.match(
    tailwindCss,
    /--foreground-subtle:\s*color-mix\(in oklab, var\(--foreground\) 60%, transparent\)/,
    "最淡文字要从本主题的前景色算出来，而不是写死中性灰",
  );
  assert.match(tailwindCss, /--color-diff-added:\s*var\(--color-green-600\)/);
  assert.match(tailwindCss, /--color-diff-removed:\s*var\(--color-red-600\)/);
  // 深色下最淡那档要更淡，且 diff 色换一档（ZCode 的 500 系）。
  for (const [name, source] of [
    ["default", defaultTheme],
    ["codex", codexTheme],
  ] as const) {
    assert.match(
      source,
      /--foreground-subtlest:\s*color-mix\(in oklab, var\(--foreground\) 30%, transparent\)/,
      `${name} 的深色要覆盖 subtlest`,
    );
    assert.match(source, /--color-diff-added:\s*var\(--color-green-500\)/, `${name} 的深色 diff`);
  }
});
/**
 * 文件名与路径是两个不同的点击目标（用户 2026-10-27 的对照：ZCode 的
 * `renderFileChip` 点名字打开文件预览，`renderFilePath` 在摘要行里点开内联正文）。
 */
test("文件名是打开文件面板的链接，路径才是展开内联的开关", () => {
  assert.match(toolRow, /data-slot="tool-row-file-link"/, "文件名要是一个独立的可点目标");
  assert.match(toolRow, /hover:underline/, "链接要有可点的手感（ZCode 的 chip 就是 hover 下划线）");
  // 摘要行本身是 Radix 折叠触发器：名字上的点击必须拦两次，否则会顺手展开正文。
  const link = toolRow.slice(toolRow.indexOf('data-slot="tool-row-file-link"'));
  const upToClick = link.slice(0, link.indexOf("onClick"));
  assert.match(upToClick, /onMouseDown=\{\(event\) => \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/, "mousedown 也要拦（焦点/拖选不该触发折叠）");
  assert.match(link, /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*openFile\(filePath\);/, "点击只打开文件，不折叠");
  // 没有宿主（只读回放）时名字保持纯文本，而不是点了没反应的按钮。
  assert.match(toolRow, /primaryText && filePath && openFile \?/, "没有文件或没有宿主时不渲染链接");
});

test("只有项目内的单个文件才可点（右面板拒绝项目外路径）", () => {
  assert.match(toolRow, /function isPanelPath\(path: string\): boolean/, "路径可点性要有单独判据");
  assert.match(toolRow, /!path\.startsWith\("\/"\)/, "绝对路径（项目外）不可点");
  assert.match(toolRow, /filePath: isPanelPath\(relative\) \? relative : undefined/);
  assert.match(toolRow, /filePath: !multiple && isPanelPath\(first\) \? first : undefined/, "多文件行不选一个当目标");
});
