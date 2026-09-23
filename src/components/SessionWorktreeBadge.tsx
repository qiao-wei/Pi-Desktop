import { AlertTriangle, FolderOpen, GitFork, GitBranchPlus, Loader2, Trash2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/react";
import {
  isWorktreeDirty,
  worktreeCreateBranchBlockReason,
  worktreeBadgeKind,
  worktreeChangeTotals,
  worktreeHeadLabel,
  worktreeRemoveBlockReason,
  worktreeRemoveNeedsForce,
} from "../shared/sessionWorktree";
import type { SessionWorktreeInfo } from "../types";

export interface SessionWorktreeBadgeProps {
  info: SessionWorktreeInfo | null;
  isCreatingBranch: boolean;
  isRemoving: boolean;
  /** 回答生成中：agent 正在这个目录里改文件，禁用建分支/移除。 */
  isStreaming: boolean;
  onRefresh: () => void;
  onReveal: () => void;
  /** 把 detached 提交落到一条真分支上；返回是否成功。 */
  onCreateBranch: (name: string) => Promise<boolean>;
  /** 移除 worktree；`force` 表示用户已在确认框里被告知有未提交内容。 */
  onRemove: (options: { force: boolean }) => Promise<boolean>;
}

/**
 * 会话头部右侧的 worktree 徽标。
 *
 * 只在会话真的跑在托管 worktree 里时渲染（`info.isWorktree`），否则整块消失 —— 普通会话
 * 的头部不该多一个装饰。徽标本身只读，点开才是操作（建分支 / 移除 / 在访达中显示）。
 */
export function SessionWorktreeBadge({
  info,
  isCreatingBranch,
  isRemoving,
  isStreaming,
  onRefresh,
  onReveal,
  onCreateBranch,
  onRemove,
}: SessionWorktreeBadgeProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [isBranchFormOpen, setIsBranchFormOpen] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [isRemoveOpen, setIsRemoveOpen] = useState(false);

  if (worktreeBadgeKind(info) === "hidden" || !info) {
    return null;
  }

  const dirty = isWorktreeDirty(info);
  // 目录被外部删掉（worktree 已被清理、磁盘被手动删）：徽标转红、操作全部禁用。
  const missing = info.exists === false;
  const head = worktreeHeadLabel(info, t("worktree.detached"));
  const displayName = info.displayName || info.path || "";
  const totals = worktreeChangeTotals(info);
  const changesLabel = t("worktree.changes", {
    changed: totals.changed,
    untracked: totals.untracked,
    ignored: totals.ignored,
  });
  const title = `${t("worktree.badge")} · ${displayName} · ${head} · ${missing ? t("worktree.missing") : dirty ? changesLabel : t("worktree.clean")}`;
  const busy = isCreatingBranch || isRemoving;
  // 建分支：目录没了就没得建；移除：目录没了反而更要能点（清掉残留注册信息）。
  const branchBlock = worktreeCreateBranchBlockReason({ isStreaming, isBusy: busy, info });
  const actionsDisabled = branchBlock !== "ok";
  const disabledTitle = branchBlock === "streaming" ? t("worktree.removeDisabledStreaming") : missing ? t("worktree.missing") : undefined;
  const removeBlock = worktreeRemoveBlockReason({ isStreaming, isBusy: busy });
  const removeDisabled = removeBlock !== "ok";
  const removeDisabledTitle = removeBlock === "streaming" ? t("worktree.removeDisabledStreaming") : undefined;

  const createBranchClick = async () => {
    const name = branchName.trim();
    if (!name || busy || isStreaming) {
      return;
    }
    // 成功才收表单：失败（名字不合法 / 重名）留着让用户改，原因由错误横幅说。
    const created = await onCreateBranch(name);
    if (created) {
      setBranchName("");
      setIsBranchFormOpen(false);
    }
  };

  const removeClick = async () => {
    const removed = await onRemove({ force: worktreeRemoveNeedsForce(info) });
    setIsRemoveOpen(false);
    if (removed) {
      setOpen(false);
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
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={title}
            title={title}
            className={cn(
              "flex h-7 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-md px-2 text-[0.78rem] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none max-[560px]:max-w-[7rem] max-[560px]:px-1.5",
              open && "bg-accent text-accent-foreground",
              missing && "text-destructive hover:text-destructive",
            )}
          >
            <GitFork className="size-[14px] shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate font-medium">{displayName}</span>
            {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" /> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom" sideOffset={6} className="w-[24rem] max-w-[92vw] overflow-hidden p-0 text-xs">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <GitFork className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 truncate font-medium">{displayName}</span>
            </div>
            <span className={cn("shrink-0 text-muted-foreground", !info.branch && "font-mono text-[0.72rem]")}>{head}</span>
          </div>

          <div className="grid gap-2 border-b px-3 py-2 text-muted-foreground">
            <div className="min-w-0 truncate font-mono text-[0.72rem]" title={info.path}>
              {info.path}
            </div>
            <div className={cn(missing && "text-destructive", !missing && dirty && "text-amber-600 dark:text-amber-400")}>
              {missing ? t("worktree.missing") : dirty ? changesLabel : t("worktree.clean")}
            </div>
          </div>

          <div className="grid gap-1.5 p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={onReveal}
              disabled={missing}
            >
              <FolderOpen aria-hidden="true" />
              {t("worktree.openFolder")}
            </Button>

            {!info.branch && info.exists !== false ? (
              isBranchFormOpen ? (
                <div className="grid gap-1.5 rounded-md bg-muted/50 p-2">
                  <Input
                    autoFocus
                    value={branchName}
                    onChange={(event) => setBranchName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void createBranchClick();
                      }
                    }}
                    placeholder={t("worktree.newBranchName")}
                    disabled={actionsDisabled}
                    className="h-8"
                  />
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void createBranchClick()}
                      disabled={!branchName.trim() || actionsDisabled}
                    >
                      {isCreatingBranch ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                      {isCreatingBranch ? t("worktree.newBranchPending") : t("worktree.newBranchCreate")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setIsBranchFormOpen(false)}
                      disabled={isCreatingBranch}
                    >
                      {t("worktree.newBranchCancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  // Button 基类带 `whitespace-nowrap`（单行标签用），这里两行式按钮必须覆盖，
                  // 否则副标题那一长句不换行，直接溢出弹层盖到聊天区上。
                  className="h-auto w-full flex-col items-start gap-0.5 py-1.5 text-left whitespace-normal"
                  onClick={() => setIsBranchFormOpen(true)}
                  disabled={actionsDisabled}
                  title={disabledTitle ?? t("worktree.newBranchHint")}
                >
                  <span className="flex items-center gap-1.5">
                    <GitBranchPlus aria-hidden="true" />
                    {t("worktree.newBranch")}
                  </span>
                  <span className="w-full text-left text-[0.7rem] leading-snug font-normal text-muted-foreground">
                    {t("worktree.newBranchHint")}
                  </span>
                </Button>
              )
            ) : null}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto w-full flex-col items-start gap-0.5 py-1.5 text-left text-destructive whitespace-normal hover:text-destructive"
              onClick={() => {
                setOpen(false);
                setIsRemoveOpen(true);
              }}
              disabled={removeDisabled}
              title={removeDisabledTitle ?? (missing ? t("worktree.removeMissingHint") : t("worktree.removeHint"))}
            >
              <span className="flex items-center gap-1.5">
                {isRemoving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                {isRemoving ? t("worktree.removePending") : t("worktree.remove")}
              </span>
              <span className="w-full text-left text-[0.7rem] leading-snug font-normal text-muted-foreground">
                {missing ? t("worktree.removeMissingHint") : t("worktree.removeHint")}
              </span>
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <AlertDialog open={isRemoveOpen} onOpenChange={setIsRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {dirty ? <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" /> : null}
              {dirty ? t("worktree.removeDirtyTitle") : t("worktree.remove")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dirty ? t("worktree.removeDirtyDesc", { reason: changesLabel }) : missing ? t("worktree.removeMissingDesc") : t("worktree.removeHint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("worktree.removeCancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                void removeClick();
              }}
              disabled={busy}
            >
              {t("worktree.removeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}