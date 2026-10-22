import { ChevronDown, FileDiff, Loader2, TriangleAlert } from "lucide-react";

import { FileRowMenu } from "@/components/FileRowMenu";
import { useT } from "@/i18n/react";
import { cn } from "@/lib/utils";
import {
  gitStatusLabelKey,
  gitStatusLetter,
  gitStatusLetterClass,
  type GitFileStatus,
} from "@/shared/gitStatusBadge";
import type { WorkspaceDiff } from "@/shared/workspaceDiff";
import { fileNameOf, parentDirectory } from "@/shared/workspaceFiles";

import { DiffViewer } from "./DiffViewer";

/** 一张改动卡片自己的数据状态（按「来源 + 路径」缓存，见 GitPane 的 `diffByKey`）。 */
export interface ChangeDiffState {
  isLoading: boolean;
  diff: WorkspaceDiff | null;
  error: string;
}

/**
 * 「改动」面板里的一行文件 —— **照 ZCode 的 `GitPaneChangeCard`**：行本身就是开关，
 * 点一下在行下面**就地展开**这份文件的 diff（不是另开一张标签页），所以列表能一直
 * 当 review 面用：从上往下滚，遇到想细看的就展开，看完收起，视线不离开列表。
 *
 * 行上的信息按 ZCode 那张截图排：状态字母（谁改的，Pi 自己的词汇）/ 文件名 / 灰色目录 /
 * `+N −M` / 展开箭头。右边缘的目录与统计都要能截断 —— 面板只有 ~340px，路径长的文件
 * 最容易把行撑破。
 *
 * 展开后的正文分四种情况（和服务端的 `availability` 一一对应，不能「有补丁就画」）：
 * 读入中 / 读失败（带重试）/ 有补丁（走 DiffViewer，读得到全文就带「N 行未改动」上下文）/
 * 其余（二进制、被截断、没有改动 —— 显示服务端给的那句原因）。
 */
export function ChangeCard({
  path,
  origPath,
  status,
  added,
  removed,
  /** 这个文件正开在面板的某个文件标签页里（列表里的选中态）。 */
  isActive,
  isExpanded,
  diffState,
  themeMode,
  onToggle,
  onRetry,
  onOpenContent,
  onOpenDiffInTab,
  onOpenInIde,
}: {
  path: string;
  origPath: string;
  status: GitFileStatus;
  added: number;
  removed: number;
  isActive: boolean;
  isExpanded: boolean;
  diffState: ChangeDiffState | null;
  themeMode: "light" | "dark";
  onToggle: (path: string) => void;
  onRetry: (path: string) => void;
  onOpenContent: (path: string) => void;
  onOpenDiffInTab: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  const t = useT();
  const name = fileNameOf(path);
  const dir = parentDirectory(path);
  const showStats = added > 0 || removed > 0;
  const diff = diffState?.diff ?? null;
  const hasPatch = Boolean(diff && diff.availability === "patch" && diff.patch && diff.patch.trim());

  return (
    <div data-change-card={path} className="w-full min-w-0">
      <FileRowMenu
        path={path}
        hasChanges
        hasContent={status !== "deleted"}
        onOpenContent={onOpenContent}
        onOpenDiff={onOpenDiffInTab}
        onOpenInIde={onOpenInIde}
      >
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => onToggle(path)}
          title={origPath ? `${origPath} → ${path}` : path}
          data-change-path={path}
          data-change-active={isActive ? "" : undefined}
          data-change-expanded={isExpanded ? "" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-[var(--app-radius-chip)] px-2 py-[3px] text-left text-[12px] hover:bg-accent/60",
            isActive && "bg-accent text-accent-foreground",
            isExpanded && "bg-accent/60",
          )}
        >
          <span
            className={cn("w-3 shrink-0 text-center font-mono text-[11px]", gitStatusLetterClass(status))}
            title={t(gitStatusLabelKey(status))}
          >
            {gitStatusLetter(status)}
          </span>
          <span className="min-w-0 shrink truncate">{name}</span>
          {/* 目录是次要信息：先让文件名占满，实在挤不下才让它先截断（`shrink` + `truncate`）。 */}
          <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground" title={path}>
            {dir}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
            {showStats ? (
              <>
                {added > 0 ? <span className="text-emerald-600 dark:text-emerald-400">+{added}</span> : null}
                {removed > 0 ? <span className="text-rose-600 dark:text-rose-400">−{removed}</span> : null}
              </>
            ) : null}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                isExpanded && "rotate-180",
              )}
            />
          </span>
        </button>
      </FileRowMenu>

      {isExpanded ? (
        // 横向滚动开在卡片这一层（ZCode 同）：长行 diff 在 340px 里不会被裁掉，也不去动列表
        // 自己的纵向滚动。右边留出和面板正文一致的 18px 沟（`mr-*` 缩窄的是滚动视口本身）。
        <div className="mr-[18px] min-w-0 overflow-x-auto overflow-y-hidden pt-1 pb-2">
          {diffState?.isLoading && !diff ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              {t("git.diff.loading")}
            </div>
          ) : null}

          {diffState?.error ? (
            <div className="flex items-start gap-2 px-2 py-3 text-[12px] text-[var(--app-danger-ink)]">
              <TriangleAlert aria-hidden="true" className="mt-[2px] size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{diffState.error}</span>
              <button
                type="button"
                onClick={() => onRetry(path)}
                className="shrink-0 rounded-[var(--app-radius-chip)] border px-1.5 py-0.5 hover:bg-accent/60"
              >
                {t("git.diff.retry")}
              </button>
            </div>
          ) : null}

          {!diffState?.error && hasPatch && diff?.patch ? (
            <DiffViewer
              patch={diff.patch}
              beforeContent={diff.beforeContent}
              afterContent={diff.afterContent}
              path={path}
              themeMode={themeMode}
            />
          ) : null}

          {!diffState?.error && !diffState?.isLoading && !hasPatch ? (
            <div className="flex items-start gap-2 px-2 py-3 text-[12px] text-muted-foreground">
              <FileDiff aria-hidden="true" className="mt-[2px] size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{diff?.summary ?? t("git.diff.unavailable")}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}