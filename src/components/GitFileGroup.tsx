import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { gitStatusLabelKey, gitStatusLetter, gitStatusLetterClass, type GitFileChange } from "@/shared/gitStatusBadge";
import type { WorkspaceDiffSource } from "@/shared/workspaceDiff";
import { useT } from "../i18n/react";

/**
 * 改动文件分组（已暂存 / 未暂存 / 未跟踪）的一列行。
 *
 * 从 `GitStatusBadge.tsx` 搬出来的：那个文件被 `max-lines` 棘轮冻着，而这一簇（行渲染 +
 * 单击看改动 / 双击给 IDE / 勾选框的热区边界）自包含。纯搬家，行为一字未改。
 */
export function GitFileGroup({
  title,
  source,
  files,
  unselected,
  onToggle,
  onOpenDiff,
  onOpenFile,
  onPreviewDiff,
}: {
  title: string;
  /** 这一组文件看哪个来源的改动：已暂存组是 index↔HEAD，其余是工作区。 */
  source: WorkspaceDiffSource;
  files: GitFileChange[];
  unselected: ReadonlySet<string>;
  onToggle: (path: string, checked: boolean) => void;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onPreviewDiff: (path: string, source: WorkspaceDiffSource) => void;
}) {
  const t = useT();
  if (files.length === 0) {
    return null;
  }

  return (
    <div className="py-0.5">
      <div className="px-3 py-1 text-[0.7rem] font-medium text-muted-foreground">{title}</div>
      {files.map((file) => (
        // 规则：**只有勾选框自己**会选中/取消（所以这里故意用 div、不用 label —— label 会把
        // 整行都变成勾选框的热区）；行上剩下的动作是单击（在右面板看改动）与双击（用 IDE 看）。
        <div
          key={`${file.origPath ? `${file.origPath}→` : ""}${file.path}`}
          onClick={(event) => {
            // 勾选框自己的点击不能穿透到行动作，否则勾一个文件就会顺手把预览顶开。
            if ((event.target as HTMLElement).closest('[role="checkbox"]')) {
              return;
            }
            // 冲突文件在右面板里没得看：要看的是三方合并的标记，不是 HEAD ↔ 工作区的 diff。
            if (file.conflicted) {
              return;
            }
            onPreviewDiff(file.path, source);
          }}
          onDoubleClick={(event) => {
            if ((event.target as HTMLElement).closest('[role="checkbox"]')) {
              return;
            }
            // 冲突文件要看的是冲突标记本身，不是 HEAD ↔ 工作区的 diff。
            if (file.conflicted) {
              onOpenFile(file.path);
              return;
            }
            onOpenDiff(file.path);
          }}
          className={cn(
            "flex items-center gap-2 px-3 py-[3px]",
            file.conflicted ? "cursor-default" : "cursor-pointer hover:bg-accent/60",
          )}
          title={`${
            file.conflicted
              ? t("git.openConflictHint")
              : file.origPath
                ? `${file.origPath} → ${file.path}`
                : file.path
          }${file.conflicted ? "" : ` · ${t("git.openDiffHint")}`}`}
        >
          {file.conflicted ? (
            // 冲突文件不能提交：对冲突路径 `git add` 等于宣告冲突已解决，必须由用户在别处处理。
            <span className="w-3.5 shrink-0 text-center text-amber-600 dark:text-amber-400" aria-hidden="true">
              !
            </span>
          ) : (
            <Checkbox
              checked={!unselected.has(file.path)}
              onCheckedChange={(checked) => onToggle(file.path, checked === true)}
              aria-label={t("git.commitInclude", { path: file.path })}
              className="size-3.5 shrink-0"
            />
          )}
          <span
            className={cn("w-3 shrink-0 text-center font-mono", gitStatusLetterClass(file.status))}
            title={t(gitStatusLabelKey(file.status))}
          >
            {gitStatusLetter(file.status)}
          </span>
          <span className="min-w-0 flex-1 truncate">{file.path}</span>
          <span className="shrink-0 font-mono tabular-nums">
            {file.added > 0 ? <span className="text-emerald-600 dark:text-emerald-400">+{file.added}</span> : null}
            {file.removed > 0 ? (
              <span className="text-rose-600 dark:text-rose-400">
                {file.added > 0 ? " " : ""}−{file.removed}
              </span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}