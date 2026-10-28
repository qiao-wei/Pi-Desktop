/**
 * 内联 diff 的**第二遍**：把 shiki 的 token 补到已经画出来的纯文本行上（ZCode 同款）。
 *
 * 三条约束：
 * - **第一帧不许等它**。默认就是纯文本，token 到了才换上；高亮失败就当没发生（catch 里什么都不做）。
 * - **只在展开时跑**。折叠的 diff 一行都没渲染，没必要给不可见的东西算颜色。
 * - **复用宿主已有的高亮器**。`@pierre/diffs` 的 shared highlighter 就是右侧代码面板用的那个
 *   （同一个 `shiki-wasm` 引擎、同一份语言表），所以这里不引入新的 shiki 实例，语言名直接用
 *   `shared/codePreviewLanguage.ts` 解出来的那一个。
 */

import { useEffect, useMemo, useState } from "react";

import {
  mapHighlightTokens,
  diffHighlightRuns,
  shouldHighlightLanguage,
  type DiffHighlightSpan,
  type HighlightTokenLike,
} from "@/shared/diffHighlight";
import {
  CODE_PREVIEW_THEMES,
  PLAIN_TEXT_CODE_LANGUAGE,
  inferCodeLanguage,
} from "@/shared/codePreviewLanguage";
import type { ToolDiffLine } from "@/shared/toolDisplay";

/** 与右侧面板同一个引擎：`shiki-js` 的巨型 RegExp 会把 V8 code range 吃满（见 DiffViewer）。 */
const PREFERRED_HIGHLIGHTER = "shiki-wasm" as const;

/** 一次 tokenize 的上限。`toolDiffLines` 已经把行数压到 800，这里只是防御性的一层。 */
const MAX_HIGHLIGHT_LINES = 800;

export type DiffHighlightMap = Map<number, DiffHighlightSpan[]>;

export function useDiffHighlight({
  path,
  lines,
  enabled,
  themeMode,
}: {
  path: string;
  lines: readonly ToolDiffLine[];
  enabled: boolean;
  themeMode: "light" | "dark";
}): DiffHighlightMap | null {
  const runs = useMemo(() => diffHighlightRuns(lines), [lines]);
  const language = useMemo(
    () => inferCodeLanguage(path, lines.map((line) => line.text).join("\n")),
    [lines, path],
  );
  const wantsHighlight =
    enabled &&
    lines.length > 0 &&
    lines.length <= MAX_HIGHLIGHT_LINES &&
    shouldHighlightLanguage(language, PLAIN_TEXT_CODE_LANGUAGE);
  // 主题、语言、正文任何一样变了都要重算；`key` 同时用来丢弃过期的结果。
  const key = `${themeMode}\u0000${language}\u0000${path.length}\u0000${lines.length}\u0000${lineSignature(lines)}`;

  const [painted, setPainted] = useState<{ key: string; map: DiffHighlightMap } | null>(null);

  useEffect(() => {
    if (!wantsHighlight) {
      return undefined;
    }
    let cancelled = false;
    const theme = CODE_PREVIEW_THEMES[themeMode];
    void (async () => {
      try {
        const { getSharedHighlighter } = await import("@pierre/diffs");
        const highlighter = await getSharedHighlighter({
          themes: [theme],
          langs: [language as never],
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
        });
        // 保持与 `runs` 一一对应：某一整段 tokenize 失败只丢那一段，后面的段不受影响。
        const perRun = runs.map((run) => {
          try {
            return highlighter.codeToTokens(run.text, { lang: language as never, theme })
              .tokens as HighlightTokenLike[][];
          } catch {
            return undefined;
          }
        });
        if (cancelled) {
          return;
        }
        setPainted({ key, map: mapHighlightTokens(lines, runs, perRun) });
      } catch {
        // 高亮是可选的第二遍：拿不到就保持纯文本，不报错也不重试。
      }
    })();
    return () => {
      cancelled = true;
    };
    // `key` 已经把主题、语言、路径和正文都编码进去了。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wantsHighlight]);

  return painted && painted.key === key ? painted.map : null;
}

/**
 * 正文的指纹。用它而不是直接依赖 `lines` 数组：每次预览重算都会造新数组，
 * 依赖引用会让 effect 每帧都跑一遍。
 */
function lineSignature(lines: readonly ToolDiffLine[]): string {
  let hash = 0;
  for (const line of lines) {
    const text = line.kind + line.text;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) | 0;
    }
  }
  return String(hash);
}