import { Check, GitCompare, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchJson } from "@/lib/api";
import { useT } from "@/i18n/react";
import {
  gitChangeTotals,
  gitHeadLabel,
  groupGitFiles,
  isGitClean,
  type GitFileChange,
  type GitInfo,
} from "@/shared/gitStatusBadge";
import { cn } from "@/lib/utils";
import {
  buildWorkspaceChangedFilesQuery,
  buildWorkspaceDiffQuery,
  normalizeChangedFilesResponse,
  normalizeWorkspaceDiffResponse,
  WORKSPACE_DIFF_SOURCES,
  type WorkspaceChangedFile,
  type WorkspaceDiffSource,
} from "@/shared/workspaceDiff";

import { ChangeCard, type ChangeDiffState } from "./ChangeCard";

/**
 * 右面板的「改动」视图 —— **照 ZCode 的 Review / GitPane 做**：一张清单，行本身就是开关，
 * 点开就在行下面就地展开这份文件的 diff（不再「点一行 → 另开一张标签页」）。
 *
 * 为什么改成就地展开（2026-10-21 用户按 ZCode 的截图反馈）：review 是**扫**的动作 ——
 * 从上往下过一遍文件，遇到可疑的展开看两眼、收起，视线和滚动位置都不离开列表。每点一个
 * 文件都要换一张标签页，扫十个文件就会攒十张标签页，回头还得一张张关。
 * 「在标签页里打开 / 看正文 / 用 IDE 打开」这几条仍然留着，走行上的右键菜单。
 *
 * 和 git 徽标里那份的关系：**这里是完整的 review 面**（宽、按来源切、能就地看 diff），
 * 徽标那份是一眼摘要 + 提交入口。提交是写操作，留在徽标里（用户已经熟悉那个位置），两边不重复。
 *
 * 来源切换只说清「现在看的是哪一份差异」：
 * - 未暂存 = 工作区 ↔ index（含未跟踪），来源列表直接用 porcelain 的分组；
 * - 已暂存 = index ↔ HEAD；
 * - 对比分支 = 工作区 ↔ 上游分叉点（含已提交但未推送的部分），这一份 porcelain 看不到，
 *   所以按需向 `/api/projects/git/files` 要（切到这一档才请求），连 base 一起记下来 ——
 *   展开某一行时要把同一个 base 交给 diff 请求，否则服务端解不出基准。
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

/** 一份 diff 的缓存键：来源不同就是两份不同的东西，同一个文件也要各存一份。 */
function changeDiffKey(source: WorkspaceDiffSource, path: string): string {
  return `${source}:${path}`;
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

function ChangeGroup({
  title,
  files,
  activePath,
  expandedPath,
  diffByKey,
  source,
  themeMode,
  onToggle,
  onRetry,
  onOpenContent,
  onOpenDiffInTab,
  onOpenInIde,
}: {
  title: string;
  files: (GitFileChange | WorkspaceChangedFile)[];
  /** 当前打开在标签页里的文件路径（列表里的选中态）。 */
  activePath: string;
  expandedPath: string;
  diffByKey: Record<string, ChangeDiffState>;
  source: WorkspaceDiffSource;
  themeMode: "light" | "dark";
  onToggle: (path: string) => void;
  onRetry: (path: string) => void;
  onOpenContent: (path: string) => void;
  onOpenDiffInTab: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  if (files.length === 0) {
    return null;
  }

  return (
    <div className="pb-1">
      <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-muted-foreground">{title}</div>
      {files.map((file) => (
        <ChangeCard
          key={file.path}
          path={file.path}
          origPath={file.origPath}
          status={file.status}
          added={file.added}
          removed={file.removed}
          isActive={file.path === activePath}
          isExpanded={file.path === expandedPath}
          diffState={diffByKey[changeDiffKey(source, file.path)] ?? null}
          themeMode={themeMode}
          onToggle={onToggle}
          onRetry={onRetry}
          onOpenContent={onOpenContent}
          onOpenDiffInTab={onOpenDiffInTab}
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
  themeMode,
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
  /** 当前打开在标签页里的文件路径（列表里的选中态）。 */
  activePath: string;
  /** 就地展开的 diff 也要过 shiki，明暗档跟着应用主题（和预览标签页同一个来源）。 */
  themeMode: "light" | "dark";
  onRefresh: () => void;
  /** 在**标签页**里看某份来源的改动（行上的右键菜单；就地展开见 onToggle）。 */
  onOpenDiff: (path: string, source: WorkspaceDiffSource, base?: string) => void;
  /** 看文件正文。 */
  onOpenContent: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  const t = useT();
  const [source, setSource] = useState<WorkspaceDiffSource>("unstaged");
  const [branchFiles, setBranchFiles] = useState<WorkspaceChangedFile[]>([]);
  const [branchSummary, setBranchSummary] = useState("");
  /** 「对比分支」这一档的基准（服务端解出的 merge-base）：展开某个文件时要原样交回去。 */
  const [branchBase, setBranchBase] = useState("");
  const [isLoadingBranch, setIsLoadingBranch] = useState(false);
  const branchSequence = useRef(0);

  /** 现在展开着哪一行（一次只展开一张：再点一行就把上一张收起来）。 */
  const [expandedPath, setExpandedPath] = useState("");
  const [diffByKey, setDiffByKey] = useState<Record<string, ChangeDiffState>>({});
  /** 在途 diff 请求的序号：同一个文件连点两下、或边读边换来源，迟到的响应不许写回来。 */
  const diffSequence = useRef(0);
  const expandedPathRef = useRef(expandedPath);
  expandedPathRef.current = expandedPath;

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
        setBranchBase("");
        setBranchSummary(t("git.diff.unavailable"));
        return;
      }

      setBranchFiles(parsed.files);
      setBranchBase(parsed.base);
      setBranchSummary(parsed.summary);
    } catch (error) {
      if (sequence === branchSequence.current) {
        setBranchFiles([]);
        setBranchBase("");
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

  /** 当前这一档要显示的文件（未暂存那一档把未跟踪合在一起，和原来一致）。 */
  const visibleFiles = useMemo<(GitFileChange | WorkspaceChangedFile)[]>(() => {
    if (!info) {
      return [];
    }
    if (source === "staged") {
      return grouped.staged;
    }
    if (source === "unstaged") {
      return [...grouped.unstaged, ...grouped.untracked];
    }
    return branchFiles;
  }, [branchFiles, grouped, info, source]);

  const visiblePathsRef = useRef<Set<string>>(new Set());
  visiblePathsRef.current = new Set(visibleFiles.map((file) => file.path));
  /** 清单指纹：刷新/换来源后清单变了就重读展开着的那一份（换内容不换身份）。 */
  const visiblePathsKey = visibleFiles.map((file) => file.path).join("\n");

  /**
   * 读一份 diff（原地展开用）。
   *
   * **不缓存**（和预览标签页同一条取舍）：agent 每轮都可能再改同一个文件，缓存下来的 diff
   * 就成了上一轮的。只按「来源 + 路径」存一份在屏数据，用来避免收起再展开时闪白。
   * 换来源时那一份全丢掉：另一档的差异绝不是同一份东西。
   */
  const loadDiff = useCallback(
    async (path: string) => {
      const key = changeDiffKey(source, path);
      const sequence = diffSequence.current + 1;
      diffSequence.current = sequence;
      setDiffByKey((current) => ({
        ...current,
        [key]: { isLoading: true, diff: current[key]?.diff ?? null, error: "" },
      }));

      try {
        const raw = await fetchJson<unknown>(
          buildWorkspaceDiffQuery({
            projectId,
            sessionPath,
            path,
            source,
            // 分支来源必须带 base：服务端要靠它解 merge-base，少了它直接报错。
            base: source === "branch" ? branchBase : undefined,
          }),
        );
        if (diffSequence.current !== sequence) {
          return;
        }

        const parsed = normalizeWorkspaceDiffResponse(raw);
        if (!parsed) {
          setDiffByKey((current) => ({
            ...current,
            [key]: { isLoading: false, diff: null, error: t("git.diff.loadFailed", { reason: String(raw) }) },
          }));
          return;
        }

        setDiffByKey((current) => ({ ...current, [key]: { isLoading: false, diff: parsed, error: "" } }));
      } catch (error) {
        if (diffSequence.current !== sequence) {
          return;
        }
        setDiffByKey((current) => ({
          ...current,
          [key]: { isLoading: false, diff: null, error: error instanceof Error ? error.message : String(error) },
        }));
      }
    },
    [branchBase, projectId, sessionPath, source, t],
  );

  // 换来源：在屏的那一份全作废（另一档的差异不是同一份东西），在途响应也一并失效。
  useEffect(() => {
    diffSequence.current += 1;
    setDiffByKey({});
  }, [source]);

  // 清单变了（刷新 / 换来源 / 分支 base 解出来）：重读展开着的那一份；那一行没了就收起。
  useEffect(() => {
    const path = expandedPathRef.current;
    if (!path) {
      return;
    }
    if (source === "branch" && !branchBase) {
      return;
    }
    if (!visiblePathsRef.current.has(path)) {
      setExpandedPath("");
      return;
    }
    void loadDiff(path);
  }, [branchBase, loadDiff, source, visiblePathsKey]);

  const toggleChange = useCallback(
    (path: string) => {
      const isOpen = expandedPathRef.current === path;
      setExpandedPath(isOpen ? "" : path);
      if (!isOpen) {
        void loadDiff(path);
      }
    },
    [loadDiff],
  );

  const retryChange = useCallback(
    (path: string) => {
      void loadDiff(path);
    },
    [loadDiff],
  );

  const branchBaseForTab = source === "branch" ? branchBase : undefined;
  const openDiffInTab = useCallback(
    (path: string) => onOpenDiff(path, source, branchBaseForTab),
    [branchBaseForTab, onOpenDiff, source],
  );

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
                expandedPath={expandedPath}
                diffByKey={diffByKey}
                source={source}
                themeMode={themeMode}
                files={grouped.unstaged}
                onToggle={toggleChange}
                onRetry={retryChange}
                onOpenContent={onOpenContent}
                onOpenDiffInTab={openDiffInTab}
                onOpenInIde={onOpenInIde}
              />
              <ChangeGroup
                title={t("git.group.untracked")}
                // 未跟踪文件也走 unstaged：服务端会合成一份「整篇新增」的补丁（和徽标一致）。
                activePath={activePath}
                expandedPath={expandedPath}
                diffByKey={diffByKey}
                source={source}
                themeMode={themeMode}
                files={grouped.untracked}
                onToggle={toggleChange}
                onRetry={retryChange}
                onOpenContent={onOpenContent}
                onOpenDiffInTab={openDiffInTab}
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
              expandedPath={expandedPath}
              diffByKey={diffByKey}
              source={source}
              themeMode={themeMode}
              files={grouped.staged}
              onToggle={toggleChange}
              onRetry={retryChange}
              onOpenContent={onOpenContent}
              onOpenDiffInTab={openDiffInTab}
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
                expandedPath={expandedPath}
                diffByKey={diffByKey}
                source={source}
                themeMode={themeMode}
                files={branchFiles}
                onToggle={toggleChange}
                onRetry={retryChange}
                onOpenContent={onOpenContent}
                onOpenDiffInTab={openDiffInTab}
                onOpenInIde={onOpenInIde}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}