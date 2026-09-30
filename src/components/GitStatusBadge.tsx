import { ArrowDown, ArrowDownToLine, ArrowUp, Check, GitBranch, GitBranchPlus, GitMerge, Loader2, Pencil, RefreshCw, Sparkles, SquarePen, Upload, WandSparkles } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/react";
import {
  gitBadgeKind,
  gitBranchListVisible,
  gitBranchSwitchState,
  gitChangeTotals,
  gitCommitBlockReason,
  gitCommitPlan,
  gitConflictedFiles,
  gitCreateBranchBlockReason,
  gitHeadLabel,
  gitMergeActionState,
  gitMergeTargets,
  gitPullActionState,
  gitPushActionState,
  gitRenameBranchBlockReason,
  gitStatusLabelKey,
  gitStatusLetter,
  groupGitFiles,
  type GitFileChange,
  type GitFileStatus,
  type GitInfo,
} from "../shared/gitStatusBadge";

export interface GitStatusBadgeProps {
  info: GitInfo | null;
  isInitializing: boolean;
  isRefreshing: boolean;
  /** 正在切往的分支名，空串 = 没在切。 */
  switchingTo: string;
  /** 正在新建分支并切过去。 */
  isCreatingBranch: boolean;
  /** 给当前分支改名在飞。 */
  isRenamingBranch: boolean;
  /** 提交请求在飞。 */
  isCommitting: boolean;
  /** 「智能生成提交信息」在飞。 */
  isGeneratingMessage: boolean;
  /** 推送（或首次关联远端并推送）在飞。 */
  isPushing: boolean;
  /** 拉取（fetch + merge 上游）在飞。 */
  isPulling: boolean;
  /** 合并其它分支在飞。 */
  isMergingBranch: boolean;
  /** 回答生成中：禁止切分支/提交（agent 正在改文件）。 */
  isStreaming: boolean;
  /** 最近一次写操作（init / 切分支 / 提交 / 生成信息）的失败原因；只有用户主动触发的操作会留下它。 */
  error: string;
  onInit: () => void;
  onRefresh: () => void;
  onSwitchBranch: (branch: string) => Promise<boolean>;
  /** 从当前分支新建分支并切过去。 */
  onCreateBranch: (name: string) => Promise<boolean>;
  /** 给当前分支改名。 */
  onRenameBranch: (name: string) => Promise<boolean>;
  onCommit: (input: { message: string; paths: string[] }) => Promise<boolean>;
  /** 推送当前分支；没有上游时服务端会先关联远端（优先 origin）再推。 */
  onPush: () => Promise<boolean>;
  /** 拉取上游分支并合并进当前分支。 */
  onPull: () => Promise<boolean>;
  /** 把选中的其它本地分支合并进当前分支；冲突算成功（info 已刷新为冲突状态）。 */
  onMergeBranch: (branch: string) => Promise<boolean>;
  /** 双击冲突文件：用宿主机 IDE 打开文件本身（编辑冲突标记）。 */
  onOpenFile: (path: string) => Promise<boolean>;
  /** 自动解决冲突：新建会话并把冲突 prompt 填进 composer。 */
  onAutoResolveConflicts: () => Promise<void>;
  /** 双击改动文件：用宿主机的 IDE 打开它的 diff（HEAD ↔ 工作区）。 */
  onOpenDiff: (path: string) => void;
  onGenerateMessage: (paths: string[]) => Promise<string | null>;
}

/** 状态字母的颜色。绿/红之外还带字母本身，颜色不是唯一信息载体。 */
function statusLetterClass(status: GitFileStatus): string {
  switch (status) {
    case "added":
      return "text-emerald-600 dark:text-emerald-400";
    case "deleted":
      return "text-rose-600 dark:text-rose-400";
    case "untracked":
      return "text-muted-foreground";
    case "conflicted":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-sky-600 dark:text-sky-400";
  }
}

/**
 * 会话头部右侧的 git 徽标。
 *
 * 三种形态（见 `gitBadgeKind`）：宿主机没装 git → 不渲染；不是仓库 → "初始化 Git
 * 仓库" 按钮；是仓库 → 分支 chip + 点开的改动详情。
 */
export function GitStatusBadge({
  info,
  isInitializing,
  isRefreshing,
  switchingTo,
  isCreatingBranch,
  isRenamingBranch,
  isCommitting,
  isGeneratingMessage,
  isPushing,
  isPulling,
  isMergingBranch,
  isStreaming,
  error,
  onInit,
  onRefresh,
  onSwitchBranch,
  onCreateBranch,
  onRenameBranch,
  onCommit,
  onPush,
  onPull,
  onMergeBranch,
  onOpenFile,
  onAutoResolveConflicts,
  onOpenDiff,
  onGenerateMessage,
}: GitStatusBadgeProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  /** 脏工作区时待确认的目标分支；非空时弹确认框。 */
  const [pendingBranch, setPendingBranch] = useState("");
  /** 新建分支的表单是否展开（收起时连输入框都不渲染）。 */
  const [isCreatingFormOpen, setIsCreatingFormOpen] = useState(false);
  /** 新建分支表单里的名字（未 trim）。 */
  const [newBranchName, setNewBranchName] = useState("");
  /** 改名表单是否展开（展开时分支名位置换成输入框）。 */
  const [isRenaming, setIsRenaming] = useState(false);
  /** 改名表单里的名字（未 trim，初值是当前分支名）。 */
  const [renameName, setRenameName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  /** 「自动解决冲突」正在拿冲突 prompt（新建会话 + 填 composer 在 App 里做）。 */
  const [isPreparingConflicts, setIsPreparingConflicts] = useState(false);
  /** 存“取消勾选”的路径（默认全选，见 gitCommitPlan）。 */
  const [unselected, setUnselected] = useState<ReadonlySet<string>>(() => new Set());
  const kind = gitBadgeKind(info);

  if (kind === "hidden" || !info) {
    return null;
  }

  if (kind === "init") {
    const label = isInitializing ? t("git.initPending") : t("git.init");
    return (
      <button
        type="button"
        onClick={onInit}
        disabled={isInitializing}
        aria-label={label}
        title={error ? `${label}: ${error}` : label}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
          error && "text-destructive hover:text-destructive",
        )}
      >
        {isInitializing ? (
          <Loader2 className="size-[15px] animate-spin" aria-hidden="true" />
        ) : (
          <GitBranchPlus className="size-[15px]" aria-hidden="true" />
        )}
      </button>
    );
  }

  const head = gitHeadLabel(info);
  const { files: changedFiles, added, removed } = gitChangeTotals(info);
  const grouped = groupGitFiles(info.files);
  const headTitle = info.detached ? `${t("git.detachedHead")} ${head}` : head;
  const badgeTitle = info.unborn
    ? `${headTitle} · ${t("git.unborn")}`
    : `${headTitle} · ${changedFiles > 0 ? t("git.changedFiles", { count: changedFiles }) : t("git.clean")}`;

  // 同步类动作（拉取 / 合并其它分支 / 推送）的可用性与提示：可用性由纯函数算（见
  // gitStatusBadge），这里只把 reason 映射成文案。推送在回答生成中仍然可点（只碰远端
  // refs，不动工作区）；没有上游时它变成「关联远端」而不是被禁用。
  const mergeState = gitMergeActionState(info, { isStreaming, isMerging: isMergingBranch, isPulling, isPushing });
  const pullState = gitPullActionState(info, { isStreaming, isPulling, isPushing });
  const pushState = gitPushActionState(info, { isPushing, isPulling, isMerging: isMergingBranch });
  const mergeTargets = gitMergeTargets(info);
  const conflictFiles = gitConflictedFiles(info);

  const pullTitle =
    pullState.reason === "streaming"
      ? t("git.pullDisabledStreaming")
      : pullState.reason === "detached"
        ? t("git.pullDisabledDetached")
        : pullState.reason === "unborn"
          ? t("git.pullDisabledUnborn")
          : pullState.reason === "noUpstream"
            ? t("git.pullDisabledNoUpstream")
            : t("git.pull");
  const mergeTitle =
    mergeState.reason === "streaming"
      ? t("git.mergeDisabledStreaming")
      : mergeState.reason === "detached"
        ? t("git.mergeDisabledDetached")
        : mergeState.reason === "unborn"
          ? t("git.mergeDisabledUnborn")
          : mergeState.reason === "noTarget"
            ? t("git.mergeDisabledNoTarget")
            : t("git.merge");
  const pushTitle =
    pushState.reason === "detached"
      ? t("git.pushDisabledDetached")
      : pushState.reason === "unborn"
        ? t("git.pushDisabledUnborn")
        : info.upstream
          ? t("git.push")
          : t("git.pushSetUpstream");

  const runSwitch = async (branch: string) => {
    const switched = await onSwitchBranch(branch);
    setPendingBranch("");
    if (switched) {
      setOpen(false);
    }
  };

  const branchClick = (branch: string) => {
    if (switchingTo) {
      return;
    }
    if (changedFiles > 0) {
      // 脏工作区：先关弹层再弹确认，避免 Popover 和 AlertDialog 的焦点打架。
      setOpen(false);
      setPendingBranch(branch);
      return;
    }
    void runSwitch(branch);
  };

  const plan = gitCommitPlan(info, unselected);
  const blockReason = gitCommitBlockReason({
    isStreaming,
    isCommitting,
    message: commitMessage,
    fileCount: plan.fileCount,
  });

  const toggleFile = (path: string, checked: boolean) => {
    setUnselected((current) => {
      const next = new Set(current);
      if (checked) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const commitClick = async () => {
    if (blockReason !== "ok") {
      return;
    }
    const committed = await onCommit({ message: commitMessage.trim(), paths: plan.paths });
    if (committed) {
      // 成功后清掉输入和勾选：下一次提交是一张白纸（未勾选集合也会随新 status 自然失效）。
      setCommitMessage("");
      setUnselected(new Set());
    }
  };

  /** 智能生成：拿当前会话的模型写一条信息填进输入框，用户改完再提交。 */
  const generateClick = async () => {
    if (plan.fileCount === 0 || isGeneratingMessage || isCommitting || isStreaming) {
      return;
    }
    const generated = await onGenerateMessage(plan.paths);
    if (generated) {
      setCommitMessage(generated);
    }
  };

  /** 一键用 IDE 打开所有冲突文件（逐个；服务端各自校验路径仍在改动列表里）。 */
  const openConflictsClick = () => {
    for (const file of conflictFiles) {
      void onOpenFile(file.path);
    }
  };

  /** 自动解决冲突：App 会新建一个会话并把冲突 prompt 填进 composer，用户自己点提交。 */
  const autoResolveConflictsClick = async () => {
    if (isPreparingConflicts) {
      return;
    }
    setIsPreparingConflicts(true);
    try {
      await onAutoResolveConflicts();
      // 会话已经切走，弹层留在新会话头上会很怪 —— 收掉它。
      setOpen(false);
    } finally {
      setIsPreparingConflicts(false);
    }
  };

  // 新建分支：只做 UI 侧能判的两件事（空名字 / 重名），安全性和 git 的 ref 规则交给服务端。
  const createReason = gitCreateBranchBlockReason({
    isStreaming,
    isCreating: isCreatingBranch,
    name: newBranchName,
    branches: info.branches,
  });
  const createHint =
    createReason === "exists" ? t("git.newBranchExists", { branch: newBranchName.trim() }) : "";
  const openCreateForm = () => {
    setNewBranchName("");
    setIsCreatingFormOpen(true);
  };
  const closeCreateForm = () => {
    setIsCreatingFormOpen(false);
    setNewBranchName("");
  };
  const createBranchClick = async () => {
    if (createReason !== "ok") {
      return;
    }
    // 成功才收表单：失败（名字不合法 / git 拒绝）留着让用户改，错误原因在下面那行显示。
    const created = await onCreateBranch(newBranchName.trim());
    if (created) {
      closeCreateForm();
    }
  };

  // 改名：点击分支名旁边的铅笔 → 分支名位置瞬时变成输入框（预填当前分支名），回车/点按钮提交。
  const renameReason = gitRenameBranchBlockReason({
    isStreaming,
    isRenaming: isRenamingBranch,
    name: renameName,
    current: head,
    branches: info.branches,
  });
  const renameHint =
    renameReason === "exists"
      ? t("git.renameBranchExists", { branch: renameName.trim() })
      : renameReason === "unchanged"
        ? t("git.renameBranchUnchanged")
        : "";
  const openRenameForm = () => {
    setRenameName(head);
    setIsRenaming(true);
  };
  const closeRenameForm = () => {
    setIsRenaming(false);
    setRenameName("");
  };
  const renameBranchClick = async () => {
    if (renameReason !== "ok") {
      return;
    }
    // 成功才收表单：失败（名字不合法 / 游离 HEAD）留着让用户改，错误原因在下面那行显示。
    const renamed = await onRenameBranch(renameName.trim());
    if (renamed) {
      closeRenameForm();
    }
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            onRefresh();
          } else {
            // 收起弹层就把改名表单收掉：下次点开是一张白纸，不会带着上次没提交的名字。
            closeRenameForm();
          }
        }}
      >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={badgeTitle}
          title={badgeTitle}
          className={cn(
            "flex h-7 max-w-[16rem] shrink-0 items-center gap-1.5 rounded-md px-2 text-[0.78rem] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none max-[560px]:max-w-[8rem] max-[560px]:px-1.5",
            open && "bg-accent text-accent-foreground",
          )}
        >
          <GitBranch className="size-[14px] shrink-0" aria-hidden="true" />
          <span className={cn("min-w-0 truncate", info.detached ? "font-mono text-[0.74rem]" : "font-medium")}>{head}</span>
          {info.ahead > 0 ? <ArrowUp className="size-[11px] shrink-0" aria-hidden="true" /> : null}
          {info.ahead > 0 ? <span className="shrink-0 tabular-nums">{info.ahead}</span> : null}
          {info.behind > 0 ? <ArrowDown className="size-[11px] shrink-0" aria-hidden="true" /> : null}
          {info.behind > 0 ? <span className="shrink-0 tabular-nums">{info.behind}</span> : null}
          {changedFiles > 0 ? (
            <>
              <span className="shrink-0 opacity-60" aria-hidden="true">
                •
              </span>
              <span className="shrink-0 tabular-nums">{changedFiles}</span>
            </>
          ) : null}
          {changedFiles > 0 && added + removed > 0 ? (
            <span className="shrink-0 font-mono text-[0.72rem] tabular-nums max-[560px]:hidden">
              {added > 0 ? <span className="text-emerald-600 dark:text-emerald-400">+{added}</span> : null}
              {removed > 0 ? <span className="text-rose-600 dark:text-rose-400">{added > 0 ? " " : ""}−{removed}</span> : null}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        // 高度上限：Radix 算好的"这一侧还能放多少"（回退到视口高度）。
        // 不能靠内容自然撑开 —— 提交信息框是 field-sizing-content，写长了会把整个弹层顶出窗口底部，
        // 而弹层是 fixed 定位的，页面滚不动，用户就永远点不到下面的按钮。
        className="flex max-h-[var(--radix-popover-content-available-height,calc(100vh-4rem))] w-[24rem] max-w-[92vw] flex-col overflow-y-auto overscroll-contain p-0 text-xs"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          {isRenaming ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void renameBranchClick();
              }}
            >
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Input
                autoFocus
                value={renameName}
                onChange={(event) => setRenameName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeRenameForm();
                  }
                }}
                placeholder={t("git.renameBranchName")}
                aria-label={t("git.renameBranchName")}
                disabled={isRenamingBranch}
                className="h-7 min-w-0 flex-1 text-xs"
              />
              <Button
                type="submit"
                size="xs"
                disabled={renameReason !== "ok"}
                title={renameReason === "empty" ? t("git.renameBranchName") : renameHint || t("git.renameBranch")}
              >
                {isRenamingBranch ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
                {isRenamingBranch ? t("git.renameBranchPending") : t("git.renameBranchConfirm")}
              </Button>
              <Button type="button" variant="ghost" size="xs" disabled={isRenamingBranch} onClick={closeRenameForm}>
                {t("git.renameBranchCancel")}
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className={cn("min-w-0 truncate font-medium", info.detached && "font-mono")}>{head}</span>
              {/* 改名只针对当前分支（HEAD）：游离 HEAD 没有分支名可改，藏起来。铅笔紧跟在分支名后面。 */}
              {!info.detached ? (
                <button
                  type="button"
                  onClick={openRenameForm}
                  disabled={isStreaming || Boolean(switchingTo) || isCreatingBranch || isRenamingBranch}
                  aria-label={t("git.renameBranch")}
                  title={isStreaming ? t("git.renameBranchDisabledStreaming") : t("git.renameBranch")}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
                >
                  <Pencil className="size-3" aria-hidden="true" />
                </button>
              ) : null}
              {info.unborn ? <span className="shrink-0 text-muted-foreground">· {t("git.unborn")}</span> : null}
            </div>
          )}
          {isRenaming ? null : (
            <div className="flex shrink-0 items-center gap-0.5">
              {/* 同步动作排在刷新左边，顺序是「拉取 → 合并其它分支 → 推送 → 刷新」。
                  拉取 = fetch + merge 上游；合并 = 把选中的本地分支合进当前分支（有下拉）。 */}
              <button
                type="button"
                onClick={() => void onPull()}
                disabled={pullState.disabled}
                aria-label={pullTitle}
                title={pullTitle}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
              >
                {isPulling ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <ArrowDownToLine className="size-3.5" aria-hidden="true" />}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={mergeState.disabled}
                    aria-label={mergeTitle}
                    title={mergeTitle}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
                  >
                    {isMergingBranch ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <GitMerge className="size-3.5" aria-hidden="true" />}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
                  <DropdownMenuLabel className="text-[0.7rem] text-muted-foreground">
                    {t("git.mergeIntoLabel", { current: head })}
                  </DropdownMenuLabel>
                  {mergeTargets.map((branch) => (
                    <DropdownMenuItem key={branch.name} onSelect={() => void onMergeBranch(branch.name)}>
                      <GitMerge className="size-3.5" aria-hidden="true" />
                      <span className="min-w-0 truncate">{branch.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                type="button"
                onClick={() => void onPush()}
                disabled={pushState.disabled}
                aria-label={pushTitle}
                title={pushTitle}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
              >
                {isPushing ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Upload className="size-3.5" aria-hidden="true" />}
              </button>
              <button
                type="button"
                onClick={onRefresh}
                aria-label={t("git.refresh")}
                title={t("git.refresh")}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        {/* 改名失败的原因（重名 / 和当前分支同名）直接摆在输入框下面，不靠 hover 看 title。 */}
        {isRenaming && renameHint ? (
          <p className="shrink-0 border-b px-3 py-2 text-[0.7rem] text-amber-600 dark:text-amber-400">{renameHint}</p>
        ) : null}

        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-muted-foreground">
          {info.upstream ? (
            <span className="min-w-0 truncate" title={info.upstream}>
              {t("git.upstream", { upstream: info.upstream })}
            </span>
          ) : (
            <span>{t("git.noUpstream")}</span>
          )}
          {info.ahead > 0 ? <span>{t("git.ahead", { count: info.ahead })}</span> : null}
          {info.behind > 0 ? <span>{t("git.behind", { count: info.behind })}</span> : null}
        </div>

        {info.files.length === 0 ? (
          <p className="shrink-0 border-t px-3 py-3 text-muted-foreground">{t("git.clean")}</p>
        ) : (
          // 文件列表自己滚：min-h 保证它不会被挤成一条线，max-h 保证它不会吃掉整个弹层高度。
          <div className="max-h-64 min-h-[6rem] flex-1 overflow-auto border-t py-1">
            <GitFileGroup
              title={t("git.group.staged")}
              files={grouped.staged}
              unselected={unselected}
              onToggle={toggleFile}
              onOpenDiff={onOpenDiff}
              onOpenFile={onOpenFile}
            />
            <GitFileGroup
              title={t("git.group.unstaged")}
              files={grouped.unstaged}
              unselected={unselected}
              onToggle={toggleFile}
              onOpenDiff={onOpenDiff}
              onOpenFile={onOpenFile}
            />
            <GitFileGroup
              title={t("git.group.untracked")}
              files={grouped.untracked}
              unselected={unselected}
              onToggle={toggleFile}
              onOpenDiff={onOpenDiff}
              onOpenFile={onOpenFile}
            />
          </div>
        )}

        {/* 提交面板：勾选哪些文件 + 一句信息。两个都是写操作的输入，默认全选、信息为空时禁用。 */}
        {info.files.length > 0 ? (
          <div className="shrink-0 space-y-2 border-t px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.7rem] font-medium text-muted-foreground">
                {t("git.commitSelected", { count: plan.fileCount })}
              </span>
              <button
                type="button"
                onClick={() => setUnselected(plan.fileCount === 0 ? new Set() : new Set(info.files.filter((file) => !file.conflicted).map((file) => file.path)))}
                className="shrink-0 text-[0.7rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {plan.fileCount === 0 ? t("git.selectAll") : t("git.selectNone")}
              </button>
            </div>
            <Textarea
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder={t("git.commitPlaceholder")}
              aria-label={t("git.commitMessage")}
              rows={2}
              // 最高 8rem 后内滚：field-sizing-content 会随内容长高，不封顶就会把弹层顶出窗口。
              className="max-h-32 min-h-[3rem] resize-none overflow-y-auto text-xs"
            />
            {plan.conflicted.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[0.7rem] text-amber-600 dark:text-amber-400">
                  {t("git.conflictHint", { count: plan.conflicted.length })}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    title={t("git.openConflicts")}
                    onClick={openConflictsClick}
                  >
                    <SquarePen className="size-3" aria-hidden="true" />
                    {t("git.openConflicts")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={isPreparingConflicts}
                    title={t("git.resolveConflicts")}
                    onClick={() => void autoResolveConflictsClick()}
                  >
                    {isPreparingConflicts ? (
                      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                    ) : (
                      <WandSparkles className="size-3" aria-hidden="true" />
                    )}
                    {isPreparingConflicts ? t("git.resolveConflictsPreparing") : t("git.resolveConflicts")}
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={plan.fileCount === 0 || isGeneratingMessage || isCommitting || isStreaming}
                title={
                  isStreaming ? t("git.generateDisabledStreaming") : plan.fileCount === 0 ? t("git.generateNoFiles") : t("git.generateMessage")
                }
                aria-label={t("git.generateMessage")}
                onClick={() => void generateClick()}
              >
                {isGeneratingMessage ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="size-3" aria-hidden="true" />
                )}
                {isGeneratingMessage ? t("git.generatingMessage") : t("git.generateMessage")}
              </Button>
              <Button
                type="button"
                size="xs"
                disabled={blockReason !== "ok"}
                title={blockReason === "streaming" ? t("git.commitDisabledStreaming") : undefined}
                onClick={() => void commitClick()}
              >
                {isCommitting ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
                {isCommitting ? t("git.commitPending") : t("git.commit")}
              </Button>
            </div>
          </div>
        ) : null}

        {gitBranchListVisible(info) ? (
          <div className="max-h-40 overflow-auto border-t py-1">
            <div className="px-3 py-1 text-[0.7rem] font-medium text-muted-foreground">{t("git.branches")}</div>
            {info.branches.map((branch) => {
              const state = gitBranchSwitchState(branch, { isStreaming, switchingTo, isCreating: isCreatingBranch });
              return (
                <button
                  key={branch.name}
                  type="button"
                  disabled={state.disabled}
                  onClick={() => branchClick(branch.name)}
                  aria-label={state.isCurrent ? `${branch.name} (${t("git.currentBranch")})` : t("git.switchTo", { branch: branch.name })}
                  title={
                    state.reason === "streaming"
                      ? t("git.switchDisabledStreaming")
                      : state.isCurrent
                        ? t("git.currentBranch")
                        : t("git.switchTo", { branch: branch.name })
                  }
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-[3px] text-left transition-colors",
                    state.disabled ? "cursor-default" : "hover:bg-accent hover:text-accent-foreground",
                    state.reason === "streaming" && "opacity-60",
                  )}
                >
                  <span className="flex w-3 shrink-0 items-center justify-center" aria-hidden="true">
                    {state.isSwitching ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : state.isCurrent ? (
                      <Check className="size-3" />
                    ) : null}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", state.isCurrent && "font-medium")}>{branch.name}</span>
                  {branch.gone ? <span className="shrink-0 text-amber-600 dark:text-amber-400">{t("git.upstreamGone")}</span> : null}
                  {branch.ahead > 0 ? <span className="shrink-0 tabular-nums text-muted-foreground">↑{branch.ahead}</span> : null}
                  {branch.behind > 0 ? <span className="shrink-0 tabular-nums text-muted-foreground">↓{branch.behind}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* 从当前分支新建分支：起点固定是当前 HEAD（服务端不接受起点参数），所以表单只有一个名字。
            空仓库（还没第一个 commit）里藏起来：那时没有 commit 可当基线，“新建分支”只会把
            未出生的分支改名，用户真正需要的是提交第一个 commit。 */}
        {!info.unborn ? (
          <div className="shrink-0 border-t px-3 py-2">
            {isCreatingFormOpen ? (
              <form
                className="space-y-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createBranchClick();
                }}
              >
                <div className="flex items-center gap-1.5">
                  <Input
                    autoFocus
                    value={newBranchName}
                    onChange={(event) => setNewBranchName(event.target.value)}
                    placeholder={t("git.newBranchName")}
                    aria-label={t("git.newBranchName")}
                    disabled={isCreatingBranch}
                    className="h-7 flex-1 text-xs"
                  />
                  <Button
                    type="submit"
                    size="xs"
                    disabled={createReason !== "ok"}
                    title={createReason === "empty" ? t("git.newBranchName") : createHint || t("git.newBranch")}
                  >
                    {isCreatingBranch ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
                    {isCreatingBranch ? t("git.newBranchPending") : t("git.newBranchCreate")}
                  </Button>
                  <Button type="button" variant="ghost" size="xs" disabled={isCreatingBranch} onClick={closeCreateForm}>
                    {t("git.newBranchCancel")}
                  </Button>
                </div>
                {/* 重名/非法名字要在按钮旁边说清楚，表单不关 —— 用户改一个字就能继续。 */}
                {createHint ? <p className="text-[0.7rem] text-amber-600 dark:text-amber-400">{createHint}</p> : null}
              </form>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={isStreaming || Boolean(switchingTo) || isCreatingBranch}
                title={isStreaming ? t("git.newBranchDisabledStreaming") : t("git.newBranchFrom", { branch: head })}
                onClick={openCreateForm}
              >
                <GitBranchPlus className="size-3" aria-hidden="true" />
                {t("git.newBranch")}
              </Button>
            )}
          </div>
        ) : null}

        {error ? <p className="border-t px-3 py-2 text-destructive">{error}</p> : null}

        <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[0.7rem] text-muted-foreground">
          <span className="truncate">{info.gitVersion ? t("git.version", { version: info.gitVersion }) : ""}</span>
          <span className="shrink-0">{t("git.changedFiles", { count: info.files.length })}</span>
        </div>
        </PopoverContent>
      </Popover>

      {/* 脏工作区切分支：git 可能拒绝（不会丢改动），所以先让用户知道会带上什么。 */}
      <AlertDialog
        open={Boolean(pendingBranch)}
        onOpenChange={(next) => {
          if (!next) {
            setPendingBranch("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("git.switchDirtyTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("git.switchDirtyDesc", { count: changedFiles, branch: pendingBranch })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("git.switchCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runSwitch(pendingBranch)}>{t("git.switchConfirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function GitFileGroup({
  title,
  files,
  unselected,
  onToggle,
  onOpenDiff,
  onOpenFile,
}: {
  title: string;
  files: GitFileChange[];
  unselected: ReadonlySet<string>;
  onToggle: (path: string, checked: boolean) => void;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
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
        // 整行都变成勾选框的热区）；行上剩下的动作只有双击（用 IDE 看 diff）。
        <div
          key={`${file.origPath ? `${file.origPath}→` : ""}${file.path}`}
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
            className={cn("w-3 shrink-0 text-center font-mono", statusLetterClass(file.status))}
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