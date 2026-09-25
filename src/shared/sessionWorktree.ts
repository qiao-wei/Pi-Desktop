/**
 * Worktree 徽标的显示规则（纯函数）。
 *
 * 和 `gitStatusBadge.ts` 一样：组件只负责画，判断"该不该显示、脏不脏、按钮能不能点、
 * 删除要不要 force"都在这里，`node --test` 直接对输入做用例。
 */
import type { SessionWorktreeInfo } from "../types";

export type SessionWorktreeBadgeKind = "hidden" | "worktree";

/** 只有真的跑在托管 worktree 里才显示；普通会话头部不该多一个装饰。 */
export function worktreeBadgeKind(info: SessionWorktreeInfo | null | undefined): SessionWorktreeBadgeKind {
  return info?.isWorktree ? "worktree" : "hidden";
}

/**
 * 侧栏会话行末尾那枚 worktree 徽标的显示规则。
 *
 * 列表里没有逐会话的 worktree 详情（那要 N 次请求），服务端在会话摘要里带一个
 * `inWorktree` 布尔，这里只回答"显不显示"。判定与头部徽标同源，但只看"是不是托管
 * worktree 会话"，不管目录还在不在 —— 目录被外部删掉时它依然是一条 worktree 会话。
 */
export function worktreeSessionBadgeKind(session: { inWorktree?: boolean } | null | undefined): SessionWorktreeBadgeKind {
  return session?.inWorktree ? "worktree" : "hidden";
}

export interface WorktreeChangeTotals {
  changed: number;
  untracked: number;
  ignored: number;
  total: number;
}

/** 三类未提交内容的合计（缺字段按 0 算，接口老/new 都能读）。 */
export function worktreeChangeTotals(info: SessionWorktreeInfo | null | undefined): WorktreeChangeTotals {
  const changed = info?.changes?.changed ?? 0;
  const untracked = info?.changes?.untracked ?? 0;
  const ignored = info?.changes?.ignored ?? 0;
  return { changed, untracked, ignored, total: changed + untracked + ignored };
}

/** 有未提交内容 = 徽标上要有脏点、移除时要二次确认并 force。 */
export function isWorktreeDirty(info: SessionWorktreeInfo | null | undefined): boolean {
  return worktreeChangeTotals(info).total > 0;
}

/** worktree 目录还在不在（被外部删掉时徽标转红、操作禁用）。 */
export function worktreeExists(info: SessionWorktreeInfo | null | undefined): boolean {
  return info?.isWorktree ? info.exists !== false : false;
}

/**
 * 头部显示的头部标签：建过分支就显示分支名，否则是游离 HEAD。
 * `detachedLabel` 由调用方传（组件里是翻译过的文案），保持这个模块不依赖 i18n。
 */
export function worktreeHeadLabel(info: SessionWorktreeInfo | null | undefined, detachedLabel: string): string {
  return info?.branch || detachedLabel;
}

export type WorktreeActionBlockReason = "ok" | "streaming" | "busy" | "missing";

/**
 * 「在这里新建分支」能不能点。
 * 顺序即优先级：回答生成中（目录正在被 agent 改）> 上一次操作还没结束 > 目录已消失。
 */
export function worktreeCreateBranchBlockReason(options: {
  isStreaming: boolean;
  isBusy: boolean;
  info: SessionWorktreeInfo | null | undefined;
}): WorktreeActionBlockReason {
  if (options.isStreaming) {
    return "streaming";
  }
  if (options.isBusy) {
    return "busy";
  }
  if (!worktreeExists(options.info)) {
    return "missing";
  }
  return "ok";
}

export type WorktreeRemoveBlockReason = "ok" | "streaming" | "busy";

/**
 * 「移除 worktree」能不能点。
 *
 * 和建分支相反：目录已经被外部删掉时**更**要点一次 —— 那时移除是清掉 git 里残留注册信息
 * 的唯一入口（服务端走 `worktree prune`），所以这里不看 `exists`。
 */
export function worktreeRemoveBlockReason(options: {
  isStreaming: boolean;
  isBusy: boolean;
}): WorktreeRemoveBlockReason {
  if (options.isStreaming) {
    return "streaming";
  }
  if (options.isBusy) {
    return "busy";
  }
  return "ok";
}

/**
 * 移除时要不要带 `force`。
 *
 * 只有"有未提交内容"这一种情况需要：那时服务端的闸会拒绝，而用户已经通过确认框被告知
 * 会丢东西。目录不存在时不 force —— 该走的是清理注册信息，不该拿 force 去删别的东西。
 */
export function worktreeRemoveNeedsForce(info: SessionWorktreeInfo | null | undefined): boolean {
  return isWorktreeDirty(info);
}