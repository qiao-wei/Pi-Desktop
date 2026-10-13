import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { hasPatchContent, parseUnifiedPatch, type DiffHunk, type DiffLine } from "@/shared/unifiedDiff";

/**
 * 内置 diff 渲染器。
 *
 * M2b 的定位是「抽象壳 + 够用的观感」：这一层只吃一份 unified patch，输出行号 / 增删底色 /
 * 块头。M2e 换成 `@pierre/diffs`（ZCode 的真实现）时，替换的就是这个文件 —— 对外只有一个
 * `patch` 入参，宿主（`PreviewPane`）不用改。
 *
 * 刻意不做的事：
 * - 不引入语法高亮（零依赖是 M2b 的硬约束，shiki/wasm 的体积和 worker 池是 M2e 单独要验的）；
 * - 不做字级（word-alt）高亮，只按行着色；
 * - 长行不折行（横向滚），和 ZCode 的 `overflow: scroll` + `wrapLongLines: false` 对齐：
 *   代码在窄面板里折行会让行号列和内容错位，比横向滚动更难读。横向滚动条由宿主那个定高的
 *   滚动容器负责（见下面的注释），两个方向滚动条都贴在可见区边缘。
 *
 * 配色沿用 git 徽标里文件行的那套（emerald / rose + 深色变体），不新增 token；底色是
 * `500/10` 这种淡洗，落在任何主题的表层上都成立。
 */

/** git 自己的写法，不翻译：用户在终端里看到的就是这一句。 */
const NO_NEWLINE = "\\ No newline at end of file";

const GUTTER_CLASS = "w-[34px] shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground/60";

function signOf(kind: DiffLine["kind"]): string {
  if (kind === "add") {
    return "+";
  }
  if (kind === "remove") {
    return "−";
  }
  return " ";
}

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      // w-max + min-w-full：内容比面板窄时底色仍铺满整行，比面板宽时跟着一起横向滚。
      className={cn(
        "flex w-max min-w-full",
        line.kind === "add" && "bg-emerald-500/10",
        line.kind === "remove" && "bg-rose-500/10",
      )}
    >
      <span className={GUTTER_CLASS}>{line.oldLine ?? ""}</span>
      <span className={GUTTER_CLASS}>{line.newLine ?? ""}</span>
      <span
        className={cn(
          "w-4 shrink-0 select-none text-center",
          line.kind === "add" && "text-emerald-600 dark:text-emerald-400",
          line.kind === "remove" && "text-rose-600 dark:text-rose-400",
        )}
        aria-hidden="true"
      >
        {signOf(line.kind)}
      </span>
      <span className="whitespace-pre pr-3">{line.text}</span>
      {line.noNewline ? (
        <span className="shrink-0 whitespace-pre pr-3 text-[11px] text-muted-foreground/70">{NO_NEWLINE}</span>
      ) : null}
    </div>
  );
}

function DiffHunkBlock({ hunk }: { hunk: DiffHunk }) {
  return (
    <div>
      {/* 块头：有「这是哪个函数」的说明就显示它（行号区间已经在两侧行号列里了），
          没有说明时退回原样的 `@@ ... @@`。 */}
      <div className="flex w-max min-w-full bg-muted/60" title={hunk.header}>
        <span className="whitespace-pre px-2 py-0.5 text-[11px] text-muted-foreground">{hunk.section || hunk.header}</span>
      </div>
      {hunk.lines.map((line, index) => (
        // 行本身没有 id：同一份补丁的同一位置永远是同一行，索引就是稳定的 key。
        <DiffRow key={index} line={line} />
      ))}
    </div>
  );
}

export function DiffViewer({ patch, className }: { patch: string; className?: string }) {
  const parsed = useMemo(() => parseUnifiedPatch(patch), [patch]);

  // 没有块（只有头部、或补丁为空）时什么都不画：说「没有可显示的改动」是宿主的事，
  // 渲染器不该自己造一句文案。
  if (!hasPatchContent(parsed)) {
    return null;
  }

  return (
    // 不在这里开横向滚动：横向滚动条要贴在**可见区**底边，所以两个方向一起交给宿主那个
    // 定高的滚动容器（PreviewPane）。当在这里（高度=内容高度）加 overflow-x 时，长文件的
    // 横向滚动条会落在整篇补丁的末端，得先滚到最后才能横向拖。
    <div className={cn("font-mono text-[12px] leading-[1.55]", className)}>
      {parsed.hunks.map((hunk, index) => (
        <DiffHunkBlock key={`${hunk.header}:${index}`} hunk={hunk} />
      ))}
    </div>
  );
}