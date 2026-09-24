/**
 * `src/shared/terminalText.ts` is the whole "render an extension's terminal panel in the
 * window" contract: parse the styling a terminal would draw, and turn a click into the keys a
 * keyboard user would send. Both halves are pure, so they are exercised for real here instead
 * of being asserted as source strings.
 *
 * The fixtures mirror what the bridge's `ansiUiTheme` emits (see tests/extensionUiMode.test.ts
 * for the cross-check that pins the accent colour both sides rely on).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createWheelStepReader,
  EXTENSION_UI_ACCENT_COLOR,
  parseTerminalLines,
  readRowTargets,
  stripTerminalSequences,
  TERMINAL_KEYS,
  type TerminalLine,
  wheelDeltaPx,
} from "../src/shared/terminalText.ts";

const accent = (text: string): string => `\u001b[96m${text}\u001b[39m`;
const muted = (text: string): string => `\u001b[90m${text}\u001b[39m`;
const green = (text: string): string => `\u001b[92m${text}\u001b[39m`;
const bold = (text: string): string => `\u001b[1m${text}\u001b[22m`;
const dim = (text: string): string => `\u001b[2m${text}\u001b[22m`;
const frame = (text: string): string => muted(text);
/** One content row exactly as the MCP panel's `row()` draws it: border + " " + content. */
const row = (content: string): string => `${frame("│")} ${content}`;

test("stripTerminalSequences 只扔转义序列，文本原样留下", () => {
  assert.equal(stripTerminalSequences(`${accent("hello")} ${frame("│")}`), "hello │");
  assert.equal(stripTerminalSequences(`\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007`), "link");
  assert.equal(stripTerminalSequences("plain"), "plain");
});

test("没有转义的行解析成一个无样式片段", () => {
  const [line] = parseTerminalLines(["just text"]);
  assert.deepEqual(line, { segments: [{ text: "just text", style: {} }], text: "just text" });
});

test("颜色/字重变成样式记录，而不是留在字符串里", () => {
  const [line] = parseTerminalLines([`${accent(bold("name"))} ${muted("14/153")}`]);
  assert.deepEqual(line!.segments, [
    { text: "name", style: { color: "ansi-bright-cyan", bold: true } },
    { text: " ", style: {} },
    { text: "14/153", style: { color: "ansi-bright-black" } },
  ]);
  assert.equal(line!.text, "name 14/153");
  assert.ok(!line!.text.includes("\u001b"), "text 字段必须是纯文本");
});

test("相邻同样式片段合并，样式切换才断开", () => {
  const [line] = parseTerminalLines([`${accent("a")}${accent("b")}${muted("c")}`]);
  assert.deepEqual(line!.segments, [
    { text: "ab", style: { color: "ansi-bright-cyan" } },
    { text: "c", style: { color: "ansi-bright-black" } },
  ]);
});

test("39 只清颜色、22 只清粗体，0 全清（相邻同样式会合并）", () => {
  const [line] = parseTerminalLines(["\u001b[96m\u001b[1ma\u001b[39mb\u001b[22mc\u001b[0md"]);
  assert.deepEqual(line!.segments, [
    { text: "a", style: { color: "ansi-bright-cyan", bold: true } },
    { text: "b", style: { bold: true } },
    { text: "cd", style: {} },
  ]);
});

test("反色/斜体/下划线/删除线/暗色都各就各位", () => {
  const [line] = parseTerminalLines(["\u001b[7mA\u001b[27m\u001b[3mB\u001b[23m\u001b[4mC\u001b[24m\u001b[9mD\u001b[29m\u001b[2mE\u001b[22m"]);
  assert.deepEqual(
    line!.segments.map((segment) => segment.style),
    [{ inverse: true }, { italic: true }, { underline: true }, { strike: true }, { dim: true }],
  );
});

test("256 色与真彩色转成 CSS 颜色，主题色留在 ansi-* 记号里", () => {
  const [line] = parseTerminalLines([
    "\u001b[38;5;196mred\u001b[39m\u001b[38;5;232mblack\u001b[39m\u001b[38;2;18;52;86mblue\u001b[39m\u001b[48;5;236mbg\u001b[49m\u001b[96mtoken\u001b[39m",
  ]);
  assert.deepEqual(
    line!.segments.map((segment) => ({ color: segment.style.color, background: segment.style.background })),
    [
      { color: "#ff0000", background: undefined },
      { color: "#080808", background: undefined },
      { color: "#123456", background: undefined },
      { color: undefined, background: "#303030" },
      { color: EXTENSION_UI_ACCENT_COLOR, background: undefined },
    ],
  );
});

test("unknown/残缺的 SGR 参数被忽略，不会破坏后面的内容", () => {
  const [line] = parseTerminalLines(["\u001b[999mX\u001b[38;5mY\u001b[38;2;1;2mZ\u001b[mW"]);
  assert.equal(line!.text, "XYZ W".replace(" ", ""));
  assert.deepEqual(line!.segments.at(-1), { text: "W", style: {} });
});

test("非 SGR 的 CSI（清行/移动光标）与孤立 ESC 都不产生字面字符", () => {
  const [line] = parseTerminalLines(["a\u001b[Kb\u001b[2Jc\u001b(Bd\u001b"]);
  assert.equal(line!.text, "abcd");
});

test("OSC 8 是超链接：开、关、以及非 8 的 OSC 静默丢弃", () => {
  const [line] = parseTerminalLines([
    "\u001b]8;;https://example.com\u0007clip\u001b]8;;\u0007 plain\u001b]1337;File=x\u0007",
  ]);
  assert.deepEqual(line!.segments.map((segment) => ({ text: segment.text, link: segment.style.link })), [
    { text: "clip", link: "https://example.com" },
    { text: " plain", link: undefined },
  ]);
});

test("颜色重置不会顺手清掉同一个片段上的链接", () => {
  // OSC 管理链接、SGR 管理颜色，两者互不相干。
  const [line] = parseTerminalLines(["\u001b]8;;https://example.com\u0007\u001b[0m\u001b[96mlink\u001b[39m"]);
  assert.equal(line!.segments[0]!.style.link, "https://example.com");
  assert.equal(line!.segments[0]!.style.color, "ansi-bright-cyan");
});

test("未终止的转义序列不会抛错，也不会吞掉行尾", () => {
  assert.equal(parseTerminalLines(["a\u001b[38;5"])[0]!.text, "a");
  assert.equal(parseTerminalLines(["a\u001b]8;;https://x"])[0]!.text, "a");
  assert.equal(parseTerminalLines(["\u001b"])[0]!.text, "");
});

/** The navigable window of an MCP-ish panel: banner, search, rule, servers/tools, hints. */
const serverRow = (prefix: string, toggle: string, name: string, meta = ""): string =>
  row(`${prefix} ${toggle} ${name}${meta ? `  ${muted(meta)}` : ""}`);
/** Tool rows are indented two extra columns: `"  " + cursor + " " + toggle + " " + name`. */
const toolRow = (prefix: string, toggle: string, name: string): string => row(`  ${prefix} ${toggle} ${name}`);

function panelLines(): string[] {
  return [
    frame("╭──── MCP Servers ────╮"),
    row(`${frame("◎")}  ${dim("search...")}`),
    frame("├────┤"),
    serverRow(muted("·"), green("●"), muted("other-mcp"), "3/3"),
    serverRow(accent("▸"), green("●"), bold(accent("teambition-mcp")), "14/153  ~2,413"),
    toolRow(" ", muted("○"), muted("tool-one")),
    toolRow(" ", muted("◐"), muted("tool-two")),
    row(dim("14 direct  ~2,413 tokens")),
    row(dim("↑↓ navigate  space toggle")),
    row(`${muted("●")} ${muted("●")} ${muted("○")}  ${dim("3/153")}`),
    frame("╰────╯"),
  ];
}

function targets(lines: readonly string[]): Map<number, { cursor: boolean; keys: string[] }> {
  return readRowTargets(parseTerminalLines(lines));
}

test("只有在光标可落到的行上才给点击目标", () => {
  const result = targets(panelLines());
  assert.deepEqual([...result.keys()].sort((a, b) => a - b), [3, 4, 5, 6]);
  assert.deepEqual(
    [...result.keys()].filter((index) => result.get(index)!.cursor),
    [4],
    "光标行只能是唯一带 ▸ 的那一行",
  );
  // 进度点、提示行、分隔线都不在结果里 —— 点它们不该发按键。
  for (const inert of [0, 1, 2, 7, 8, 9, 10]) assert.equal(result.has(inert), false, `第 ${inert} 行不该可点`);
});

test("点击的距离换算成上下键，最后再多一个回车", () => {
  const result = targets(panelLines());
  assert.deepEqual(result.get(4)!.keys, [TERMINAL_KEYS.enter], "点光标行只确认");
  assert.deepEqual(result.get(5)!.keys, [TERMINAL_KEYS.down, TERMINAL_KEYS.enter]);
  assert.deepEqual(result.get(6)!.keys, [TERMINAL_KEYS.down, TERMINAL_KEYS.down, TERMINAL_KEYS.enter]);
  assert.deepEqual(result.get(3)!.keys, [TERMINAL_KEYS.up, TERMINAL_KEYS.enter]);
});

test("光标在展开行上：▾ 只靠强调色区分（空闲展开行是灰的）", () => {
  const lines = panelLines();
  lines[3] = serverRow(muted("▾"), green("●"), muted("other-mcp"), "3/3");
  lines[4] = serverRow(accent("▾"), green("●"), bold(accent("teambition-mcp")), "14/153  ~2,413");
  const result = targets(lines);
  assert.deepEqual([...result.keys()].filter((index) => result.get(index)!.cursor), [4]);
});

test("光标落在工具行上时同样认得出（工具行的 ▸ 缩进更靠右）", () => {
  const lines = panelLines();
  lines[3] = serverRow(muted("·"), green("●"), muted("other-mcp"), "3/3");
  lines[4] = serverRow(muted("·"), green("●"), muted("teambition-mcp"), "14/153  ~2,413");
  lines[6] = toolRow(accent("▸"), muted("◐"), bold(accent("tool-two")));
  const result = targets(lines);
  assert.deepEqual([...result.keys()].filter((index) => result.get(index)!.cursor), [6]);
  assert.deepEqual(result.get(3)!.keys, [
    TERMINAL_KEYS.up,
    TERMINAL_KEYS.up,
    TERMINAL_KEYS.up,
    TERMINAL_KEYS.enter,
  ]);
});

test("光标不在窗口里时（没有任何 ▸/▾）不给目标，宁可不给点击也不乱发按键", () => {
  const lines = panelLines().map((line) => line.replaceAll(accent("▸"), muted("·")));
  assert.equal(targets(lines).size, 0);
  assert.equal(targets([frame("╭──╮"), frame("╰──╯")]).size, 0);
});

test("面板语法之外的行（横幅、输入框、确认提示）一律不动", () => {
  const lines: TerminalLine[] = parseTerminalLines([
    row(`${muted("●")} ready to run`),
    row(`${frame("◎")}  search...`),
    row(`Discard unsaved changes?  ${dim("Discard")}   ${dim("Keep & Close")}`),
  ]);
  assert.equal(readRowTargets(lines).size, 0);
});

// ---------------------------------------------------------------------------
// 滚轮 → 方向键：面板只认按键，而浏览器的滚轮 delta 既不是「一行」也不是一档
// ---------------------------------------------------------------------------

test("wheelDeltaPx 把三种 deltaMode 归一到像素", () => {
  assert.equal(wheelDeltaPx({ deltaY: 12 }), 12, "像素模式原样");
  assert.equal(wheelDeltaPx({ deltaY: 12, deltaMode: 0 }), 12);
  assert.equal(wheelDeltaPx({ deltaY: 3, deltaMode: 1 }), 48, "行模式按行高换算");
  assert.equal(wheelDeltaPx({ deltaY: 2, deltaMode: 2 }), 1200, "页模式按页高换算");
  assert.equal(wheelDeltaPx({ deltaY: -3, deltaMode: 1 }), -48, "方向保留");
  assert.equal(wheelDeltaPx({ deltaY: Number.NaN }), 0, "脏 delta 不能变成一步");
  assert.equal(wheelDeltaPx({ deltaY: 3, deltaMode: 1 }, { lineHeightPx: 20 }), 60);
});

test("触控板的小 delta 累积成一整行，没攒够就一步也不发", () => {
  const reader = createWheelStepReader({ stepPx: 40 });
  assert.equal(reader.push({ deltaY: 15 }, 0), 0);
  assert.equal(reader.push({ deltaY: 15 }, 10), 0);
  assert.equal(reader.push({ deltaY: 15 }, 20), 1, "45px 攒够一行");
  assert.equal(reader.push({ deltaY: 10 }, 30), 0, "余下的 5px 继续攒");
});

test("一格滚轮不会变成十步（大 delta 有上限）", () => {
  const reader = createWheelStepReader({ stepPx: 40, maxSteps: 3 });
  assert.equal(reader.push({ deltaY: 400 }, 0), 3);
  assert.equal(reader.push({ deltaY: -400 }, 10), -3, "方向也要带上限");
});

test("反向立即响应，不用先抵消残留", () => {
  const reader = createWheelStepReader({ stepPx: 40 });
  assert.equal(reader.push({ deltaY: 35 }, 0), 0);
  assert.equal(reader.push({ deltaY: -45 }, 10), -1, "反向那一下就该动，不能把 35px 当成 −35");

  // 残留被丢弃而不是被抵消：+35 后反向 −30 只攒到 −30，再 −15 就该满一行。
  // 若实现把两种方向相加（35 − 30 = 5，5 − 15 = −10），这里会停在 0。
  const fresh = createWheelStepReader({ stepPx: 40 });
  fresh.push({ deltaY: 35 }, 0);
  assert.equal(fresh.push({ deltaY: -30 }, 10), 0);
  assert.equal(fresh.push({ deltaY: -15 }, 20), -1);
});

test("停顿后重新开始：残留不跨手势累积", () => {
  const reader = createWheelStepReader({ stepPx: 40, resetMs: 160 });
  reader.push({ deltaY: 35 }, 0);
  assert.equal(reader.push({ deltaY: 35 }, 500), 0, "旧手势的 35px 已经丢弃");
  assert.equal(reader.push({ deltaY: 35 }, 510), 1);
});

test("慢速连续滚动（每次都在间隔内）仍然能一行行推进", () => {
  const reader = createWheelStepReader({ stepPx: 40 });
  const steps = [0, 100, 200, 300, 400, 500].map((now) => reader.push({ deltaY: 45 }, now));
  assert.deepEqual(steps, [1, 1, 1, 1, 1, 1]);
  assert.deepEqual([0, 100].map((now) => reader.push({ deltaY: -45 }, now)), [-1, -1]);
});
