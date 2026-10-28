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
const toolRowPresentation = readFileSync(
  new URL("../src/components/assistant-ui/elements/tool-row-presentation.tsx", import.meta.url),
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
    /running \? "shimmer shimmer-spread-30 shimmer-angle-0 motion-reduce:animate-none" : "text-foreground-subtlest"/,
    "运行中的动作词扫光（窄带、不倾斜），结束后落到最淡文字",
  );
  assert.match(toolRow, /min-w-0 flex max-w-full items-center gap-2 text-foreground-subtlest/);
});

/**
 * 运行态：动作词必须变成「正在…」并挂上扫光。
 *
 * 这是用户报的那条 bug 的**根因**：插槽是 `<ToolFallbackComponent {...part} />`，part 里
 * 带的是 assistant-ui 的 `status`，而本组件只声明了一个可选的 `running`（默认 false）——
 * 于是所有行永远停在落定态，「正在写入 / 正在编辑 / 正在执行」三条键一条都到不了屏幕。
 * 断言的落点是**接线 + 兜底文案**两件事，缺一样用户还是看不到。
 */
test("运行态来自 part 的 status，动作词与扫光一起出现", () => {
  assert.match(
    toolRow,
    /const isRunning = running \?\? status\?\.type === "running"/,
    "running 必须从 assistant-ui 的 status 推出来（缺这一步等于没有运行态）",
  );
  assert.match(
    toolRow,
    /status\?: \{ type: string \};/,
    "props 里要显式声明 status，否则 {...part} 传进来也没人读",
  );
  assert.match(
    toolRow,
    /running=\{isRunning\}/,
    "布局层拿到的必须是推导后的值，不是那个恒为 false 的入参",
  );
  // 扫光仍然只在运行时挂（落定态回到最淡一档）。
  assert.match(
    toolRow,
    /running \? "shimmer shimmer-spread-30 shimmer-angle-0 motion-reduce:animate-none" : "text-foreground-subtlest"/,
    "短动作词要用窄扫光带：插件默认带宽（4ch+80px、200px 轨道、15°）比四个汉字还宽，"
      + "整行会长期落在软色带里，看起来就是一行淡灰字",
  );
  // 参数还在流、display 还没派生出来的那一小段时间，动作词也必须说人话：
  // 旧实现走 `fallbackPresentation` 的英文工具名（Write / Todo write），中文界面里露英文。
  const fallback = toolRowPresentation.slice(
    toolRowPresentation.indexOf("function fallbackPresentation("),
    toolRowPresentation.indexOf("function stringArg("),
  );
  for (const key of [
    "process.tool.read.running",
    "process.tool.write.running",
    "process.tool.edit.running",
    "process.tool.execute.running",
    "process.tool.search.running",
  ]) {
    assert.ok(fallback.includes(key), `兜底文案必须按 family 取本地化键：缺 ${key}`);
  }
  assert.doesNotMatch(
    fallback,
    /kindLabel: label,/,
    "已知 family 不许把英文工具名当动作词（label 只留给未知工具）",
  );
  assert.match(fallback, /kindLabel: familyLabel \? t\(familyLabel\) : label/);
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
  assert.match(toolRowPresentation, /parseMcpToolName\(toolName\)/);
  assert.match(toolRowPresentation, /t\("process\.tool\.mcp"\)/, "MCP 的动作词走 i18n 词表");
  assert.match(toolRowPresentation, /stripRepeatedPrefix\(/, "server 名与 tool 名重复时只显示一次");
  assert.match(toolRowPresentation, /kindDetail:/, "server 名走 kindDetail 槽位，不占主文本");
  // pi 没有 skill 工具（skills 是提示资源，不是工具），所以不做 skill 行。
  assert.doesNotMatch(toolRowPresentation, /WandSparkles|process\.tool\.skill/);
});

test("read / grep / ls / find 只有摘要行，没有正文", () => {
  const readCase = toolRowPresentation.slice(
    toolRowPresentation.indexOf('case "read": {'),
    toolRowPresentation.indexOf('case "write":'),
  );
  assert.ok(readCase.length > 0, "read 分支不见了");
  assert.match(readCase, /canToggle: false/, "read 是纯摘要（ZCode canToggle={false}）");
  assert.doesNotMatch(readCase, /body:/, "read 不展开正文");
  // 搜索族整个分支都不该带 body。
  const searchCase = toolRowPresentation.slice(
    toolRowPresentation.indexOf('case "search": {'),
    toolRowPresentation.indexOf('case "mcp": {'),
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
  assert.match(toolRowPresentation, /<DiffBody/);
  assert.match(toolRowPresentation, /<TerminalBody/);
  assert.match(toolRowPresentation, /<McpBody/);
  assert.match(toolRowPresentation, /<PartsBody/);
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
  // 判据住在 presentation 模块（和「哪个 family 给什么文案」在一起）。
  assert.match(
    toolRowPresentation,
    /function isPanelPath\(path: string\): boolean/,
    "路径可点性要有单独判据",
  );
  assert.match(toolRowPresentation, /!path\.startsWith\("\/"\)/, "绝对路径（项目外）不可点");
  assert.match(toolRowPresentation, /filePath: isPanelPath\(relative\) \? relative : undefined/);
  assert.match(
    toolRowPresentation,
    /filePath: !multiple && isPanelPath\(first\) \? first : undefined/,
    "多文件行不选一个当目标",
  );
});

/**
 * 「内容太大，没随流传输」必须**看得见**。
 *
 * 预算（`toolPayloadBudget`）把正文裁掉之后，行里剩下的 `+N` 仍然是真的，但正文是空的；
 * 一个空 diff 会被读成"这个文件没有改动"。所以要钉两件事：空 patch 时渲染那句说明，
 * 并且 `resultTruncated` 真的被传进每一个正文组件（否则说明是死代码）。
 */
test("正文被预算裁掉时显示说明，不是空 diff", () => {
  assert.match(
    toolBodies,
    /file\.patch === "" \? file\.omitted : undefined/,
    "只有裁过（且 patch 为空）才显示说明",
  );
  assert.match(toolBodies, /process\.payload\.omittedBody/);
  // 结果正文的三种形态（终端 / MCP / 通用）都要能说出"只显示了首尾"。
  assert.equal(
    (toolBodies.match(/<ResultTruncatedNote truncated=\{truncated\} t=\{t\} \/>/g) ?? []).length,
    3,
    "每个结果正文都要带上裁剪说明",
  );
  const rowPasses = (toolRowPresentation.match(/truncated=\{input\.resultTruncated\}/g) ?? [])
    .length;
  assert.equal(rowPasses, 3, "行必须把 resultTruncated 传给三个正文组件");
});
