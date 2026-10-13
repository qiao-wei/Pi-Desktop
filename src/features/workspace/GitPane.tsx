import { Check, GitCompare, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchJson } from "@/lib/api";
import { useT } from "@/i18n/react";
import {
  gitChangeTotals,
  gitHeadLabel,
  gitStatusLabelKey,
  gitStatusLetter,
  gitStatusLetterClass,
  groupGitFiles,
  isGitClean,
  type GitFileChange,
  type GitFileStatus,
  type GitInfo,
} from "@/shared/gitStatusBadge";
import { cn } from "@/lib/utils";
import {
  buildWorkspaceChangedFilesQuery,
  normalizeChangedFilesResponse,
  WORKSPACE_DIFF_SOURCES,
  type WorkspaceChangedFile,
  type WorkspaceDiffSource,
} from "@/shared/workspaceDiff";

import { FileRowMenu } from "@/components/FileRowMenu";

/**
 * 右面板的「改动」视图。
 *
 * 和 git 徽标里那份的关系：**这里是完整的 review 面**（宽、按来源切、能跳预览），徽标那份是
 * 一眼摘要 + 提交入口。提交是写操作，留在徽标里（用户已经熟悉那个位置），两边不重复。
 *
 * 来源切换只说清「现在看的是哪一份差异」：
 * - 未暂存 = 工作区 ↔ index（含未跟踪），来源列表直接用 porcelain 的分组；
 * - 已暂存 = index ↔ HEAD；
 * - 对比分支 = 工作区 ↔ 上游分叉点（含已提交但未推送的部分），这一份 porcelain 看不到，
 *   所以按需向 `/api/projects/git/files` 要（切到这一档才请求）。
 */

/** chip 上的短文案：`git.source.*` 那几个是「描述」（预览头部用），chip 里放不下。 */
function sourceChipLabelKey(source: WorkspaceDiffSource): string {
  if (source === "staged") {
    return "git.group.staged";
  }
  if (source === "branch") {
    return "rightPanel.gitSourceBranch";
  }
  return "git.group.unstaged";
}

function SourceChips({
  value,
  onChange,
}: {
  value: WorkspaceDiffSource;
  onChange: (source: WorkspaceDiffSource) => void;
}) {
  const t = useT();

  return (
    <div
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 px-[18px] pb-1"
      role="group"
      aria-label={t("rightPanel.gitSource")}
    >
      {WORKSPACE_DIFF_SOURCES.map((source) => (
        <button
          key={source}
          type="button"
          aria-pressed={source === value}
          onClick={() => onChange(source)}
          data-git-source={source}
          className={cn(
            "shrink-0 whitespace-nowrap rounded-full border px-2 py-[2px] text-[11px] transition-colors",
            source === value
              ? "border-transparent bg-accent text-accent-foreground"
              : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          {t(sourceChipLabelKey(source))}
        </button>
      ))}
    </div>
  );
}

function ChangeRow({
  path,
  origPath,
  status,
  isActive,
  onOpenDiff,
  onOpenContent,
  onOpenInIde,
}: {
  path: string;
  origPath: string;
  status: GitFileStatus;
  /** 这个文件正开在面板的某个 tab 里（列表里的选中态）。 */
  isActive: boolean;
  onOpenDiff: (path: string) => void;
  onOpenContent: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  const t = useT();

  const row = (
    <button
      type="button"
      onClick={() => onOpenDiff(path)}
      className={cn(
        "flex w-full items-center gap-2 rounded-[var(--app-radius-chip)] px-2 py-[3px] text-left text-[12px] hover:bg-accent/60",
        isActive && "bg-accent text-accent-foreground",
      )}
      title={`${origPath ? `${origPath} → ${path}` : path} · ${t("git.openDiffHint")}`}
      data-change-path={path}
      data-change-active={isActive ? "" : undefined}
    >
      <span
        className={cn("w-3 shrink-0 text-center font-mono text-[11px]", gitStatusLetterClass(status))}
        title={t(gitStatusLabelKey(status))}
      >
        {gitStatusLetter(status)}
      </span>
      <span className="min-w-0 flex-1 truncate">{path}</span>
    </button>
  );

  return (
    <FileRowMenu
      path={path}
      hasChanges
      hasContent={status !== "deleted"}
      onOpenContent={onOpenContent}
      onOpenDiff={onOpenDiff}
      onOpenInIde={onOpenInIde}
    >
      {row}
    </FileRowMenu>
  );
}

function ChangeGroup({
  title,
  files,
  activePath,
  onOpenDiff,
  onOpenContent,
  onOpenInIde,
}: {
  title: string;
  files: (GitFileChange | WorkspaceChangedFile)[];
  /** 当前打开在 tab 里的文件路径（列表里的选中态）。 */
  activePath: string;
  onOpenDiff: (path: string) => void;
  onOpenContent: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  if (files.length === 0) {
    return null;
  }

  return (
    <div className="pb-1">
      <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-muted-foreground">{title}</div>
      {files.map((file) => (
        <ChangeRow
          key={file.path}
          path={file.path}
          origPath={file.origPath}
          status={file.status}
          isActive={file.path === activePath}
          onOpenDiff={onOpenDiff}
          onOpenContent={onOpenContent}
          onOpenInIde={onOpenInIde}
        />
      ))}
    </div>
  );
}

export function GitPane({
  info,
  projectId,
  sessionPath,
  isRefreshing,
  activePath,
  onRefresh,
  onOpenDiff,
  onOpenContent,
  onOpenInIde,
}: {
  /** porcelain 那份状态（未暂存 / 已暂存 / 未跟踪的分组就从这里来）。 */
  info: GitInfo | null;
  /** 「对比分支」那一份要自己向服务端要，需要 projectId + 会话工作区。 */
  projectId: string;
  sessionPath: string;
  isRefreshing: boolean;
  /** 当前打开在 tab 里的文件路径（列表里的选中态）。 */
  activePath: string;
  onRefresh: () => void;
  /** 看某份来源的改动（进预览视图）。 */
  onOpenDiff: (path: string, source: WorkspaceDiffSource) => void;
  /** 看文件正文。 */
  onOpenContent: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  const t = useT();
  const [source, setSource] = useState<WorkspaceDiffSource>("unstaged");
  const [branchFiles, setBranchFiles] = useState<WorkspaceChangedFile[]>([]);
  const [branchSummary, setBranchSummary] = useState("");
  const [isLoadingBranch, setIsLoadingBranch] = useState(false);
  const branchSequence = useRef(0);

  const grouped = useMemo(() => groupGitFiles(info?.files ?? []), [info]);

  /**
   * 拉「对比分支」那一份清单。
   *
   * porcelain 看不到「已提交但没推送」的改动，所以这一档必须问 git；而且它要跑
   * merge-base + diff，只在真的切到这一档时才请求（另外两档分组直接来自 porcelain）。
   */
  const loadBranchFiles = useCallback(async () => {
    if (!projectId) {
      return;
    }

    const sequence = branchSequence.current + 1;
    branchSequence.current = sequence;
    setIsLoadingBranch(true);

    try {
      const raw = await fetchJson<unknown>(buildWorkspaceChangedFilesQuery({ projectId, sessionPath, source: "branch" }));
      if (sequence !== branchSequence.current) {
        return;
      }

      const parsed = normalizeChangedFilesResponse(raw);
      if (!parsed) {
        setBranchFiles([]);
        setBranchSummary(t("git.diff.unavailable"));
        return;
      }

      setBranchFiles(parsed.files);
      setBranchSummary(parsed.summary);
    } catch (error) {
      if (sequence === branchSequence.current) {
        setBranchFiles([]);
        setBranchSummary(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (sequence === branchSequence.current) {
        setIsLoadingBranch(false);
      }
    }
  }, [projectId, sessionPath, t]);

  // 切到这一档、以及 gitInfo 每次刷新（回答结束、窗口 focus）都重拉一次：
  // agent 每轮都可能改文件，分支清单和 porcelain 必须是同一时刻的。
  useEffect(() => {
    if (source === "branch") {
      void loadBranchFiles();
    }
  }, [source, info, loadBranchFiles]);

  const totals = info ? gitChangeTotals(info) : { added: 0, removed: 0 };
  const retryBranch = useCallback(() => {
    void loadBranchFiles();
  }, [loadBranchFiles]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-w-0 shrink-0 items-center gap-2 px-[18px] pb-1 pt-3">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {info ? gitHeadLabel(info) : t("rightPanel.gitNoRepo")}
        </span>
        {info && !isGitClean(info) ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            {totals.added > 0 ? (
              <span className="text-emerald-600 dark:text-emerald-400">+{totals.added}</span>
            ) : null}
            {totals.removed > 0 ? (
              <span className="text-rose-600 dark:text-rose-400">
                {totals.added > 0 ? " " : ""}−{totals.removed}
              </span>
            ) : null}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onRefresh}
          aria-label={t("git.refresh")}
          title={t("git.refresh")}
          className="rounded-[var(--app-radius-chip)] p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <RefreshCw aria-hidden="true" className={cn("size-3.5", isRefreshing && "animate-spin")} />
        </button>
      </header>

      {info ? <SourceChips value={source} onChange={setSource} /> : null}
      <div className="mt-1 shrink-0 border-t border-border" />

      <div className="min-h-0 min-w-0 flex-1 overflow-auto py-1 pr-1" aria-label={t("rightPanel.gitAria")} data-right-panel-git>
        {!info ? (
          <div className="flex items-start gap-2 px-[18px] py-3 text-[12px] text-muted-foreground">
            <GitCompare aria-hidden="true" className="mt-[2px] size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{t("rightPanel.gitNoRepo")}</span>
          </div>
        ) : null}

        {info && source === "unstaged" ? (
          grouped.staged.length === 0 && grouped.unstaged.length === 0 && grouped.untracked.length === 0 ? (
            <div className="flex items-start gap-2 px-[18px] py-3 text-[12px] text-muted-foreground">
              <Check aria-hidden="true" className="mt-[2px] size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{t("rightPanel.gitEmpty")}</span>
            </div>
          ) : (
            <>
              <ChangeGroup
                title={t("git.group.unstaged")}
                activePath={activePath}
                files={grouped.unstaged}
                onOpenDiff={(path) => onOpenDiff(path, "unstaged")}
                onOpenContent={onOpenContent}
                onOpenInIde={onOpenInIde}
              />
              <ChangeGroup
                title={t("git.group.untracked")}
                // 未跟踪文件也走 unstaged：服务端会合成一份「整篇新增」的补丁（和徽标一致）。
                activePath={activePath}
                files={grouped.untracked}
                onOpenDiff={(path) => onOpenDiff(path, "unstaged")}
                onOpenContent={onOpenContent}
                onOpenInIde={onOpenInIde}
              />
              {grouped.unstaged.length === 0 ? (
                <p className="px-[18px] py-2 text-[11px] text-muted-foreground">{t("git.group.unstagedEmpty")}</p>
              ) : null}
            </>
          )
        ) : null}

        {info && source === "staged" ? (
          grouped.staged.length === 0 ? (
            <p className="px-[18px] py-2 text-[11px] text-muted-foreground">{t("git.group.stagedEmpty")}</p>
          ) : (
            <ChangeGroup
              title={t("git.group.staged")}
              activePath={activePath}
              files={grouped.staged}
              onOpenDiff={(path) => onOpenDiff(path, "staged")}
              onOpenContent={onOpenContent}
              onOpenInIde={onOpenInIde}
            />
          )
        ) : null}

        {info && source === "branch" ? (
          <>
            {isLoadingBranch ? (
              <div className="flex items-center gap-2 px-[18px] py-3 text-[12px] text-muted-foreground">
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                {t("rightPanel.gitLoading")}
              </div>
            ) : null}
            {!isLoadingBranch && branchSummary ? (
              <div className="flex items-start gap-2 px-[18px] py-3 text-[12px] text-muted-foreground">
                <TriangleAlert aria-hidden="true" className="mt-[2px] size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 break-words">{branchSummary}</span>
                <button
                  type="button"
                  onClick={retryBranch}
                  className="shrink-0 rounded-[var(--app-radius-chip)] border px-1.5 py-0.5 hover:bg-accent/60"
                >
                  {t("git.diff.retry")}
                </button>
              </div>
            ) : null}
            {!isLoadingBranch && !branchSummary && branchFiles.length === 0 ? (
              <p className="px-[18px] py-2 text-[11px] text-muted-foreground">{t("rightPanel.gitEmpty")}</p>
            ) : null}
            {!isLoadingBranch && !branchSummary && branchFiles.length > 0 ? (
              <ChangeGroup
                title={t("git.source.branch")}
                activePath={activePath}
                files={branchFiles}
                onOpenDiff={(path) => onOpenDiff(path, "branch")}
                onOpenContent={onOpenContent}
                onOpenInIde={onOpenInIde}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}