import { useMemo, type CSSProperties } from "react";
import type { FileContents } from "@pierre/diffs";
import { File as DiffsFile, type FileOptions } from "@pierre/diffs/react";

import { codePreviewLeaf, inferCodeLanguage, isDarkCodePreviewTheme, CODE_PREVIEW_THEMES } from "@/shared/codePreviewLanguage";

/**
 * 文件正文的代码查看器 —— **完全照 ZCode 的做法**（`components/ui/code-viewer.tsx`）：
 * `@pierre/diffs/react` 的 `<File>` + shiki 高亮，而不是我们自己数行号画 `<span>`。
 *
 * 三处必须和 ZCode 一致，不然会踩同样的坑：
 *
 * 1. **引擎固定 shiki-wasm**：shiki 的 JS 引擎把 TextMate 语法翻成巨型 RegExp 并永久缓存在
 *    V8 的 code space 里，双字节文本（中文注释）还要再编一份，长时间跑会把 256MB code range
 *    吃满 → renderer OOM（old-space 还有大把空闲，报的却是 code cage 用尽）。
 *    oniguruma 的正则活在 wasm 线性内存里，不占代码区。
 *    ZCode 另外还起了 worker 池（`DiffsWorkerPoolProvider` + `workers/diffs.worker.ts`）——
 *    那是**性能**优化，我们先不开：worker 需要打包器额外吐一个 chunk，两个宿主（Electron 与
 *    Tauri 的资源协议）都得跟着陪跑。开之前先把 worker 文件与打包脚本一起验一遍。
 * 2. **明暗两套主题一起给**：`theme: { light, dark }` + `themeType`，配合 style 上的
 *    `colorScheme`。@pierre/diffs 的 token 是 `light-dark()` 形式的，不给 colorScheme 时
 *    深浅会跟着**系统**偏好走，在深色卡片上渲染浅色主题的文字。
 * 3. **`cacheKey` 必须带上主题与内容指纹**：库按 `file.cacheKey` 复用 token，键里少了主题，
 *    同一张 tab 上切换深浅会继续用旧高亮（ZCode 踩过）。
 *
 * 大小限制不在这里：超过 256KB 的文件服务端直接判 `too-large`（和 ZCode 同一个阈值、同样
 * 不渲染半截），见 `server/workspaceFiles.mjs:readWorkspaceFile`。
 */
const DIFFS_PREFERRED_HIGHLIGHTER: FileOptions<undefined>["preferredHighlighter"] = "shiki-wasm";

/** 默认字号（ZCode `DEFAULT_CODE_PREVIEW_SETTINGS.fontSizePx`）。 */
const CODE_PREVIEW_FONT_SIZE_PX = 12;

/** 和 Tailwind 的 `font-mono` 同一串栈：库把字体画在 shadow DOM 里，只能用 CSS 变量传进去。 */
const CODE_PREVIEW_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

type CodeViewerStyle = CSSProperties & Record<`--diffs-${string}`, string>;

/** ZCode 的 djb2：内容指纹进 cacheKey，改一个字就必须重新 token。 */
function hashCodeViewerContent(code: string): string {
  let hash = 5381;
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 33) ^ code.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

export function CodeViewer({
  code,
  path,
  themeMode,
  showLineNumbers = true,
  wrapLongLines = false,
}: {
  code: string;
  /** 用来看扩展名解语言；正文只是兜底（没有后缀的脚本看 shebang）。 */
  path?: string | null;
  themeMode: "light" | "dark";
  showLineNumbers?: boolean;
  wrapLongLines?: boolean;
}) {
  const language = useMemo(() => inferCodeLanguage(path, code), [path, code]);
  const themes = CODE_PREVIEW_THEMES;

  const file = useMemo<FileContents>(() => {
    const name = `preview.${language}`;
    return {
      name,
      contents: code,
      lang: language,
      // 主题 + 语言 + 长度 + 内容指纹：少任何一项都会命中过期的 token。
      cacheKey: `${isDarkCodePreviewTheme(themes[themeMode]) ? "dark" : "light"}:${name}:${code.length}:${hashCodeViewerContent(code)}`,
    };
  }, [code, language, themeMode, themes]);

  const options = useMemo<FileOptions<undefined>>(
    () => ({
      // 头部我们自己画（文件名 / 目录 / 大小），库里的那个重复。
      disableFileHeader: true,
      disableLineNumbers: !showLineNumbers,
      // `scroll` 不折行：长行由外层容器横向滚（和 ZCode 的 `overflow: scroll` 一致）。
      overflow: wrapLongLines ? "wrap" : "scroll",
      theme: themes,
      themeType: themeMode,
      preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
      tokenizeMaxLineLength: 1_000,
      useTokenTransformer: false,
    }),
    [showLineNumbers, themeMode, themes, wrapLongLines],
  );

  const style = useMemo<CodeViewerStyle>(
    () => ({
      colorScheme: themeMode,
      // 底色跟主题走：库自己的底色是写死的白/黑，会在卡片上开一个方洞。
      "--diffs-bg": "var(--background)",
      "--diffs-light-bg": "var(--background)",
      "--diffs-dark-bg": "var(--background)",
      "--diffs-font-family": CODE_PREVIEW_FONT_FAMILY,
      "--diffs-font-size": `${CODE_PREVIEW_FONT_SIZE_PX}px`,
    }),
    [themeMode],
  );

  return (
    <div
      className="h-full w-full overflow-auto"
      style={style}
      data-code-viewer=""
      data-language={language}
      data-code-path={codePreviewLeaf(path) || undefined}
    >
      <DiffsFile file={file} options={options} className="min-h-full w-full" />
    </div>
  );
}