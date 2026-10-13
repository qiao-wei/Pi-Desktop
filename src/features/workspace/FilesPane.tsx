import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Loader2, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useT } from "@/i18n/react";
import { gitStatusLetter, gitStatusLetterClass, gitStatusLabelKey, type GitFileStatus } from "@/shared/gitStatusBadge";
import { cn } from "@/lib/utils";
import {
  filterWorkspaceTree,
  parentDirectory,
  type WorkspaceFileEntry,
  type WorkspaceTreeFilter,
} from "@/shared/workspaceFiles";

import { FileRowMenu } from "@/components/FileRowMenu";
import type { WorkspaceFilesController } from "./useWorkspaceFiles";

/**
 * 工作区的文件树。**现在挂在左侧栏**（2026-10-12 按 ZCode 的布局：树在左、预览在右），
 * 右侧面板原来的「文件」tab 已经撤掉；`data-right-panel-files*` 这组选择器留着不改名，
 * 免得动一批 e2e 与断言 —— 名字里的 right-panel 是历史包袱，不是它现在的家。
 *
 * 行本身是「单击看内容」，改动过的文件额外显示状态字母 —— 用户想找的往往不是文件本身，
 * 而是「刚才 agent 改了哪个」。目录单击展开/收起，懒加载（展开才读那一层）。
 *
 * 行高固定 22px：树是懒加载的，展开时会插进来一整层，行高不稳的话点击目标会跳。
 */
const ROW_HEIGHT = 22;
const INDENT = 12;

function TreeRow({
  entry,
  depth,
  isExpanded,
  isActive,
  status,
  onToggleDir,
  onOpenContent,
  onOpenDiff,
  onOpenInIde,
}: {
  entry: WorkspaceFileEntry;
  depth: number;
  isExpanded: boolean;
  /** 这个文件正开在面板的某个 tab 里（Codex 里打开的文件在树上会被选中）。 */
  isActive: boolean;
  /** 有改动时的 git 状态（后端只给有改动的文件）。 */
  status: GitFileStatus | null;
  onToggleDir: (path: string) => void;
  onOpenContent: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  const t = useT();
  const isDirectory = entry.isDir;
  const Icon = isDirectory ? (isExpanded ? FolderOpen : Folder) : File;

  const row = (
    <button
      type="button"
      // 行是 button：键盘能走通整棵树（Tab 进、Enter 打开），比 div + onClick 多一份无障碍。
      className={cn(
        "flex w-full items-center gap-1 rounded-[var(--app-radius-chip)] pr-2 text-left text-[12px] hover:bg-accent/60",
        isActive ? "bg-accent text-accent-foreground" : status ? "text-foreground" : "text-foreground/90",
      )}
      style={{ height: ROW_HEIGHT, paddingLeft: 4 + depth * INDENT }}
      title={entry.path}
      onClick={() => (isDirectory ? onToggleDir(entry.path) : onOpenContent(entry.path))}
      data-file-path={entry.path}
      data-file-active={isActive ? "" : undefined}
      aria-current={isActive ? "true" : undefined}
    >
      {isDirectory ? (
        isExpanded ? (
          <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        )
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <Icon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", isDirectory ? "text-muted-foreground" : "text-muted-foreground/80")}
      />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.isLink ? <span className="shrink-0 text-[10px] text-muted-foreground">↗</span> : null}
      {status ? (
        <span
          className={cn("w-3 shrink-0 text-center font-mono text-[11px]", gitStatusLetterClass(status))}
          title={t(gitStatusLabelKey(status))}
        >
          {gitStatusLetter(status)}
        </span>
      ) : null}
    </button>
  );

  if (isDirectory) {
    return row;
  }

  return (
    <FileRowMenu
      path={entry.path}
      hasChanges={status !== null}
      hasContent
      onOpenContent={onOpenContent}
      onOpenDiff={onOpenDiff}
      onOpenInIde={onOpenInIde}
    >
      {row}
    </FileRowMenu>
  );
}

function TreeLevel({
  dir,
  depth,
  files,
  changedFiles,
  filter,
  activePath,
  onToggleDir,
  onOpenContent,
  onOpenDiff,
  onOpenInIde,
}: {
  dir: string;
  depth: number;
  files: WorkspaceFilesController;
  /** 相对路径 → git 状态（只含工作区里有改动的文件）。 */
  changedFiles: ReadonlyMap<string, GitFileStatus>;
  /** 筛选态（null = 没在筛）。命中的行才显示，祖先目录自动展开。 */
  filter: WorkspaceTreeFilter | null;
  /** 当前打开在 tab 里的文件路径（树上的选中态）。 */
  activePath: string;
  onToggleDir: (path: string) => void;
  onOpenContent: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  const t = useT();
  const entries = files.entriesByDir.get(dir);
  if (!entries) {
    return null;
  }

  if (entries.length === 0) {
    return (
      <div className="px-2 py-1 text-[11px] text-muted-foreground" style={{ paddingLeft: 8 + depth * INDENT }}>
        {t("rightPanel.filesEmpty")}
      </div>
    );
  }

  return (
    <>
      {entries.map((entry) => {
        if (filter && !filter.visible.has(entry.path)) {
          return null;
        }

        // 筛选时命中的目录要自动展开，否则命中行藏在收起的目录里（看起来就是「没搜到」）。
        const isExpanded = entry.isDir && (files.expanded.has(entry.path) || (filter?.expand.has(entry.path) ?? false));
        const error = entry.isDir ? files.errorsByDir.get(entry.path) : undefined;

        return (
          <div key={entry.path}>
            <TreeRow
              entry={entry}
              depth={depth}
              isExpanded={isExpanded}
              isActive={!entry.isDir && entry.path === activePath}
              status={changedFiles.get(entry.path) ?? null}
              onToggleDir={onToggleDir}
              onOpenContent={onOpenContent}
              onOpenDiff={onOpenDiff}
              onOpenInIde={onOpenInIde}
            />
            {isExpanded ? <TreeLevel dir={entry.path} depth={depth + 1} files={files} changedFiles={changedFiles} filter={filter} activePath={activePath} onToggleDir={onToggleDir} onOpenContent={onOpenContent} onOpenDiff={onOpenDiff} onOpenInIde={onOpenInIde} /> : null}
            {error ? (
              <div
                className="flex items-start gap-1.5 py-1 pr-2 text-[11px] text-[var(--app-danger-ink)]"
                style={{ paddingLeft: 8 + (depth + 1) * INDENT }}
              >
                <TriangleAlert aria-hidden="true" className="mt-[2px] size-3 shrink-0" />
                <span className="min-w-0 break-words">{t("rightPanel.filesReadFailed", { reason: error })}</span>
              </div>
            ) : null}
            {entry.isDir && isExpanded && files.loadingDirs.has(entry.path) ? (
              <div
                className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground"
                style={{ paddingLeft: 8 + (depth + 1) * INDENT }}
              >
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                {t("rightPanel.filesLoading")}
              </div>
            ) : null}
            {entry.isDir && files.truncatedDirs.has(entry.path) ? (
              <div
                className="py-1 pr-2 text-[11px] text-muted-foreground"
                style={{ paddingLeft: 8 + (depth + 1) * INDENT }}
              >
                {t("rightPanel.filesMore")}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function FilesPane({
  files,
  changedFiles,
  activePath,
  onOpenContent,
  onOpenDiff,
  onOpenInIde,
}: {
  files: WorkspaceFilesController;
  changedFiles: ReadonlyMap<string, GitFileStatus>;
  /** 当前打开在 tab 里的文件路径（为空表示没有打开的文件）。 */
  activePath: string;
  onOpenContent: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  const t = useT();
  const rootError = files.errorsByDir.get("");
  const [filterText, setFilterText] = useState("");
  const filter = useMemo(() => filterWorkspaceTree(files.entriesByDir, filterText), [files.entriesByDir, filterText]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 打开的文件可能藏在没展开的目录里：把它的每一级祖先目录都展开（按需拉那一层），
  // 露出那一行再滚到可见位置。没有这一步，树里就永远看不到高亮 —— 只有碰巧展开过才看得到。
  useEffect(() => {
    if (!activePath) {
      return;
    }

    let parent = parentDirectory(activePath);
    while (parent) {
      files.expandDir(parent);
      parent = parentDirectory(parent);
    }
    // 只有 expandDir 是稳定的（依赖 entriesByDir 的引用会变），这一条只在换文件时跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // 行渲染出来之后再滚（祖先刚展开的那一层要等一次 render）。
  useEffect(() => {
    if (!activePath) {
      return;
    }
    const row = scrollRef.current?.querySelector("[data-file-active]");
    row?.scrollIntoView({ block: "nearest" });
  }, [activePath, files.entriesByDir]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-w-0 shrink-0 items-center gap-2 px-[18px] pb-1 pt-3">
        {/* Codex 的文件面板头部就是一枚「Filter files...」搜索框：只筛**已经读回来的**那几层
            （树是懒加载的，没有全仓索引），所以下面会带一句说明。 */}
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search aria-hidden="true" className="pointer-events-none absolute left-1.5 size-3 text-muted-foreground" />
          <input
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            aria-label={t("rightPanel.filesFilter")}
            title={t("rightPanel.filesFilterHint")}
            placeholder={t("rightPanel.filesFilter")}
            data-right-panel-files-filter
            className="h-6 w-full min-w-0 rounded-[var(--app-radius-chip)] bg-muted/50 pr-1.5 pl-5 text-[12px] text-foreground placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={files.reload}
          aria-label={t("rightPanel.filesReload")}
          title={t("rightPanel.filesReload")}
          className="rounded-[var(--app-radius-chip)] p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <RefreshCw aria-hidden="true" className="size-3.5" />
        </button>
      </header>
      <div className="mt-0 shrink-0 border-t border-border" />

      <div
        ref={scrollRef}
        className="min-h-0 min-w-0 flex-1 overflow-auto py-1 pr-1"
        aria-label={t("rightPanel.filesAria")}
        data-right-panel-files
      >
        {files.isRootLoading && !rootError ? (
          <div className="flex items-center gap-2 px-[18px] py-3 text-[12px] text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            {t("rightPanel.filesLoading")}
          </div>
        ) : null}
        {rootError ? (
          <div className="flex items-start gap-2 px-[18px] py-3 text-[12px] text-[var(--app-danger-ink)]">
            <TriangleAlert aria-hidden="true" className="mt-[2px] size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{t("rightPanel.filesReadFailed", { reason: rootError })}</span>
          </div>
        ) : null}
        {filter && filter.matchCount === 0 ? (
          <div className="px-[18px] py-2 text-[11px] text-muted-foreground" data-right-panel-files-filter-empty>
            {t("rightPanel.filesFilterEmpty")}
          </div>
        ) : null}
        <TreeLevel
          dir=""
          depth={0}
          files={files}
          changedFiles={changedFiles}
          filter={filter}
          activePath={activePath}
          onToggleDir={files.toggleDir}
          onOpenContent={onOpenContent}
          onOpenDiff={onOpenDiff}
          onOpenInIde={onOpenInIde}
        />
        {filter ? (
          <div className="px-[18px] py-2 text-[11px] text-muted-foreground">{t("rightPanel.filesFilterHint")}</div>
        ) : null}
      </div>
    </div>
  );
}