/**
 * 内联 diff 的语法高亮**计划**（纯函数，不做 I/O，也不认识 shiki）。
 *
 * ZCode 的内联 diff 是两遍画的：先出纯文本（第一帧必须有东西），再把 token 异步补上。
 * 这里只负责第一件事之外的两件纯事：**按同色块切段**（一段一次 tokenize，跨行语法才连得上）
 * 和**把 token 贴回行**（对不上就整段不要 —— 宁可不着色，也不能把某行的颜色画到别的行上）。
 */

import type { ToolDiffLine, ToolDiffLineKind } from "./toolDisplay.ts";

/** shiki token 的最小形状（只要这两样，免得纯层依赖它的类型）。 */
export interface HighlightTokenLike {
  content: string;
  color?: string;
}

export interface DiffHighlightSpan {
  text: string;
  color?: string;
}

/** 一次 tokenize 的输入：连续的、同一种行（增 / 删 / 上下文）。 */
export interface DiffHighlightRun {
  /** 这段在 `lines` 里的起始下标。 */
  start: number;
  kind: ToolDiffLineKind;
  /** 整段正文（行之间用 `\n`），直接喂给 highlighter。 */
  text: string;
  lineCount: number;
}

/**
 * 把行切成「同色的连续段」。
 *
 * 为什么不是整篇一起 tokenize：增行和删行拼在同一份文档里，一半是旧代码一半是新代码，
 * 语法会互相干扰（一个删掉的花括号会去闭新增的块）。为什么不是逐行：多行字符串 / 注释 /
 * 模板串跨行才有意义，逐行会把它们全打断。
 */
export function diffHighlightRuns(lines: readonly ToolDiffLine[]): DiffHighlightRun[] {
  const runs: DiffHighlightRun[] = [];
  let index = 0;
  while (index < lines.length) {
    const kind = lines[index]!.kind;
    let end = index + 1;
    while (end < lines.length && lines[end]!.kind === kind) {
      end += 1;
    }
    runs.push({
      start: index,
      kind,
      text: lines.slice(index, end).map((line) => line.text).join("\n"),
      lineCount: end - index,
    });
    index = end;
  }
  return runs;
}

/**
 * 把每一段的 token 行贴回整篇的行号。**对不上就丢整段**：
 * - 行数不一致（高亮器少给了 / 多给了行）；
 * - 某行 token 拼起来的文本和那行的正文不相等。
 *
 * 两种都意味着「这个颜色属于别的东西」，画上去就是假的。
 */
export function mapHighlightTokens(
  lines: readonly ToolDiffLine[],
  runs: readonly DiffHighlightRun[],
  perRun: readonly (readonly (readonly HighlightTokenLike[])[] | undefined)[],
): Map<number, DiffHighlightSpan[]> {
  const map = new Map<number, DiffHighlightSpan[]>();
  runs.forEach((run, runIndex) => {
    const tokenLines = perRun[runIndex];
    if (!tokenLines || tokenLines.length !== run.lineCount) {
      return;
    }
    // 先整段校验，再写入：不能留下「前两行有颜色、第三行没有」的半截结果。
    for (let offset = 0; offset < run.lineCount; offset += 1) {
      const tokens = tokenLines[offset] ?? [];
      const text = tokens.map((token) => token.content).join("");
      if (text !== lines[run.start + offset]!.text) {
        return;
      }
    }
    for (let offset = 0; offset < run.lineCount; offset += 1) {
      const tokens = tokenLines[offset] ?? [];
      // 只有一个 token 且没有颜色时不必包 span：纯文本就是最终形态。
      if (tokens.length <= 1 && !tokens[0]?.color) {
        continue;
      }
      map.set(
        run.start + offset,
        tokens.map((token) => ({ text: token.content, color: token.color })),
      );
    }
  });
  return map;
}

/**
 * 这份正文值不值得跑第二遍。纯文本语言（`log`）没有语法规则，跑一遍只会拿到
 * 「一个没有颜色的 token」—— 等于白花几毫秒和一次动态 import。
 */
export function shouldHighlightLanguage(language: string, plainTextLanguage: string): boolean {
  return language.length > 0 && language !== plainTextLanguage;
}