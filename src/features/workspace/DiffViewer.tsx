import { useMemo, type CSSProperties } from "react";
import type { FileContents, FileDiffOptions } from "@pierre/diffs";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import { cn } from "@/lib/utils";
import { CODE_PREVIEW_THEMES } from "@/shared/codePreviewLanguage";
import { canRenderRichWorkspaceDiff } from "@/shared/workspaceDiff";
import { hasPatchContent, parseUnifiedPatch } from "@/shared/unifiedDiff";

/**
 * 内置 diff 渲染器 —— **和文件正文一样照 ZCode 的做法**（`components/ui/diff-viewer.tsx`）：
 * `@pierre/diffs/react`，所以 diff 里的代码是**带语法高亮**的，不只是绿/红底色那一层。
 *
 * 两条路（和 ZCode 的 `DiffViewer` 同一套分流，选项差别只在 `hunkSeparators`）：
 * - 服务端能读到**两侧全文**（`beforeContent` / `afterContent`）→ `<MultiFileDiff>` +
 *   `hunkSeparators: "line-info"`：这样才有 ZCode 那种「N 行未改动」的可点开分隔条，
 *   长文件里每一处改动都带着上下文，而不是只有补丁里那几行；
 * - 只有 patch（超大文件只回补丁、读不到全文）→ `<PatchDiff>` + `hunkSeparators: "simple"`：
 *   补丁只有局部上下文，画「展开未修改行」是一个点不开的提示，等于骗人。
 *
 * 和正文的 `CodeViewer` 同一条约定：
 * - 引擎固定 `shiki-wasm`（shiki-js 的巨型 RegExp 会把 V8 code range 吃满 → renderer OOM）；
 * - 明暗两档主题一起给 + `themeType`（token 是 `light-dark()`，不显式给档就会跟着系统偏好走，
 *   在深色卡片上渲染成浅色主题的深色文字）；
 * - 底色/字体走 `--diffs-*` 变量（库把内容画在 shadow DOM 里，外层 Tailwind class 进不去）；
 * - `overflow: scroll` 不折行，横向滚动条由宿主那层定高容器负责。
 *
 * 空 patch（只有头部、或补丁为空）直接不画：说「没有可显示的改动」是宿主的事，
 * 渲染器不自己造文案 —— 所以这里仍用 `unifiedDiff.ts` 的解析结果当门槛。
 */

type DiffViewerStyle = CSSProperties & Record<`--diffs-${string}`, string>;

/** 和 Tailwind 的 `font-mono` 同一串栈（shadow DOM 里继承不到外层 class）。 */
const CODE_PREVIEW_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const DIFF_PREFERRED_HIGHLIGHTER: FileDiffOptions<undefined>["preferredHighlighter"] = "shiki-wasm";

/** 默认字号（ZCode `DEFAULT_CODE_PREVIEW_SETTINGS.fontSizePx`）。 */
const DIFF_FONT_SIZE_PX = 12;

/**
 * 两侧全文的内容指纹（ZCode `GitPaneChangeCard` 同做法）。
 *
 * 库按 `cacheKey` 复用高亮结果，且**不会**自己看内容有没有变 —— 内容变了而不换 key，
 * 拿到的就是上一份 token（`FileContents` 的注释写得很直白）。长度 + 首尾各 100 字符足够
 * 区分 agent 每轮的小改动，又不用把整篇文件读进来算哈希。
 */
function sideCacheKey(side: "old" | "new", name: string, contents: string): string {
  return `${side}:${name}:${contents.length}:${contents.slice(0, 100)}:${contents.slice(-100)}`;
}

export function DiffViewer({
  patch,
  beforeContent,
  afterContent,
  path = "",
  themeMode,
  className,
}: {
  patch: string;
  /**
   * 两侧全文（服务端读得到时给）。两个都拿到才走富渲染：只来一侧就当成读不到
   * （服务端有同样的约定 —— 否则会把「读不到」画成「整篇新增/删除」）。
   */
  beforeContent?: string | null;
  afterContent?: string | null;
  /** 文件路径：库靠它推断语法高亮语言（我们不画文件头，`disableFileHeader`）。 */
  path?: string;
  /** 高亮的明暗档跟着应用主题（`@pierre/diffs` 的 token 是 light-dark()）。 */
  themeMode: "light" | "dark";
  className?: string;
}) {
  // 门槛用我们自己的解析器：不是 unified patch（或没有 hunk）就什么都不画。
  const parsed = useMemo(() => parseUnifiedPatch(patch), [patch]);

  const richFiles = useMemo<{ oldFile: FileContents; newFile: FileContents } | null>(() => {
    // 能不能走富渲染是 `shared/` 里的纯规则（两侧齐 + 篇幅没超上限）：大文件同步比整篇会把
    // 点开那一帧卡住，超限就退回落差补丁 —— 不是不画。
    const sides = { beforeContent, afterContent };
    if (!canRenderRichWorkspaceDiff(sides)) {
      return null;
    }

    const name = path.trim() || "file";
    return {
      oldFile: { name, contents: sides.beforeContent, cacheKey: sideCacheKey("old", name, sides.beforeContent) },
      newFile: { name, contents: sides.afterContent, cacheKey: sideCacheKey("new", name, sides.afterContent) },
    };
  }, [afterContent, beforeContent, path]);

  const themes = CODE_PREVIEW_THEMES;
  const options = useMemo<FileDiffOptions<undefined>>(
    () => ({
      diffStyle: "unified",
      diffIndicators: "bars",
      // 头部（文件名 / 来源 / 增删统计）由宿主自己画，库里的那个重复。
      disableFileHeader: true,
      // 有全文才敢画「N 行未改动」的分隔条；只有 patch 时画出来也点不开（ZCode 同）。
      hunkSeparators: richFiles ? "line-info" : "simple",
      lineDiffType: "word-alt",
      maxLineDiffLength: 1_000,
      overflow: "scroll",
      theme: themes,
      themeType: themeMode,
      preferredHighlighter: DIFF_PREFERRED_HIGHLIGHTER,
      tokenizeMaxLineLength: 1_000,
      useTokenTransformer: false,
    }),
    [richFiles, themeMode, themes],
  );

  const style = useMemo<DiffViewerStyle>(
    () => ({
      // token 的颜色依赖 color-scheme：不显式指定就会跟着**系统**偏好而不是应用主题走。
      colorScheme: themeMode,
      "--diffs-bg": "var(--background)",
      "--diffs-light-bg": "var(--background)",
      "--diffs-dark-bg": "var(--background)",
      "--diffs-font-family": CODE_PREVIEW_FONT_FAMILY,
      "--diffs-font-size": `${DIFF_FONT_SIZE_PX}px`,
    }),
    [themeMode],
  );

  if (!richFiles && !hasPatchContent(parsed)) {
    return null;
  }

  return (
    // 不在这里开滚动：横向滚动条要贴在**可见区**底边，两个方向一起交给宿主那个定高的
    // 滚动容器（PreviewPane / 改动卡片）。库自己那层也只是内容高度。
    // 和 CodeViewer 同一套：外层负责滚动，这里只把内容撑到实际宽度。
    <div className={cn("min-h-full w-max min-w-full", className)} style={style} data-diff-viewer="">
      {richFiles ? (
        // 富渲染这层**不能**给 `w-max`：库内部那个网格自己就是一个横向滚动容器
        // （`overflow-x: scroll`），而滚动容器对 max-content 的贡献是 0 —— 于是宿主宽度
        // 塌成 0，整个 diff 被裁没（真机实测：宿主 rect 宽度 0、行都在但画不出来）。
        // `w-full` 让库自己那一层去滚长行（ZCode 也是这样：外层 `overflow-auto` + 库 `w-full`）。
        <MultiFileDiff
          oldFile={richFiles.oldFile}
          newFile={richFiles.newFile}
          options={options}
          className="block min-h-full w-full"
        />
      ) : (
        <PatchDiff patch={patch} options={options} className="min-h-full w-max" />
      )}
    </div>
  );
}