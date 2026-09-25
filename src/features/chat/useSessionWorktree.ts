import { useCallback, useEffect, useRef, useState } from "react";

import { fetchJson, postJson } from "../../lib/api";
import type { BootstrapResponse } from "../../lib/api";
import { t } from "../../i18n";
import type { SessionWorktreeInfo } from "../../types";

interface UseSessionWorktreeOptions {
  /** 当前项目 id；空串时不请求。 */
  projectId: string;
  /** 当前会话路径（worktree 是会话级的，不是项目级的）。 */
  sessionPath: string;
  /** 回答生成中：agent 正在这个目录里改文件，禁用建分支/移除。 */
  isStreaming: boolean;
  /** 写操作失败时把原因交给会话的错误横幅；读失败静默（徽标只是装饰）。 */
  onError?: (message: string) => void;
  /** 移除 worktree 会返回一份完整 bootstrap，交给它会话退回主检出。 */
  onBootstrap?: (next: BootstrapResponse) => void;
}

export interface SessionWorktreeController {
  info: SessionWorktreeInfo | null;
  isRefreshing: boolean;
  isCreatingBranch: boolean;
  isRemoving: boolean;
  /** 最近一次写操作（建分支/移除）的失败原因；成功会清掉。 */
  error: string;
  refresh: () => Promise<void>;
  revealWorktree: () => Promise<void>;
  /** 把 worktree 里的 detached 提交落到一条真分支上；返回是否成功。 */
  createBranch: (name: string) => Promise<boolean>;
  /** 移除 worktree 并让会话退回主检出；返回是否成功。 */
  removeWorktree: (options?: { force?: boolean }) => Promise<boolean>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 当前会话的托管 worktree 状态（会话头部那枚 Worktree 徽标）。
 *
 * 刷新时机和 git 徽标一致（不轮询）：切会话 / 切项目、一轮回答结束、窗口重新聚焦。
 * 读失败静默隐藏徽标；只有用户主动触发的写操作会把原因留在 `error` 并交给错误横幅。
 */
export function useSessionWorktree({
  projectId,
  sessionPath,
  isStreaming,
  onError,
  onBootstrap,
}: UseSessionWorktreeOptions): SessionWorktreeController {
  const [info, setInfo] = useState<SessionWorktreeInfo | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState("");
  /** 切会话/并发刷新时只认最后一次请求，避免旧会话的响应急回来覆盖新会话。 */
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!projectId || !sessionPath) {
      return;
    }

    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setIsRefreshing(true);

    try {
      const query = new URLSearchParams({ projectId, sessionPath });
      const next = await fetchJson<SessionWorktreeInfo>(`/api/sessions/worktree?${query.toString()}`);
      if (seq === requestSeq.current) {
        setInfo(next);
        setError("");
      }
    } catch {
      if (seq === requestSeq.current) {
        setInfo(null);
      }
    } finally {
      if (seq === requestSeq.current) {
        setIsRefreshing(false);
      }
    }
  }, [projectId, sessionPath]);

  // 切会话：先清空再拉，不能让上一个 worktree 的名字短暂留在新会话头上。
  useEffect(() => {
    requestSeq.current += 1;
    setInfo(null);
    setError("");
    if (projectId && sessionPath) {
      void refresh();
    }
  }, [projectId, sessionPath, refresh]);

  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) {
      void refresh();
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming, refresh]);

  useEffect(() => {
    const handleFocus = () => void refresh();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh]);

  const revealWorktree = useCallback(async () => {
    if (!projectId || !sessionPath) {
      return;
    }

    setError("");
    try {
      await postJson<{ ok: boolean }>("/api/sessions/worktree/reveal", { projectId, sessionPath });
    } catch (revealError) {
      const message = messageOf(revealError);
      setError(message);
      onError?.(t("worktree.revealFailed", { reason: message }));
    }
  }, [projectId, sessionPath, onError]);

  const createBranch = useCallback(
    async (name: string): Promise<boolean> => {
      if (!projectId || !sessionPath || isCreatingBranch) {
        return false;
      }

      setIsCreatingBranch(true);
      setError("");

      try {
        const next = await postJson<SessionWorktreeInfo>("/api/sessions/worktree/branch", {
          projectId,
          sessionPath,
          name,
        });
        setInfo(next);
        return true;
      } catch (createError) {
        const message = messageOf(createError);
        setError(message);
        onError?.(t("worktree.newBranchFailed", { reason: message }));
        return false;
      } finally {
        setIsCreatingBranch(false);
      }
    },
    [projectId, sessionPath, isCreatingBranch, onError],
  );

  const removeWorktree = useCallback(
    async (options: { force?: boolean } = {}): Promise<boolean> => {
      if (!projectId || !sessionPath || isRemoving) {
        return false;
      }

      setIsRemoving(true);
      setError("");

      try {
        const response = await postJson<{ result: BootstrapResponse; worktree: SessionWorktreeInfo }>(
          "/api/sessions/worktree/remove",
          { projectId, sessionPath, force: Boolean(options.force) },
        );
        // 服务端已经把会话退回主检出并重建了 runtime；客户端整体替换，侧栏/头部一次性对齐。
        onBootstrap?.(response.result);
        setInfo(response.worktree?.isWorktree ? response.worktree : null);
        return true;
      } catch (removeError) {
        const message = messageOf(removeError);
        setError(message);
        onError?.(t("worktree.removeFailed", { reason: message }));
        return false;
      } finally {
        setIsRemoving(false);
      }
    },
    [projectId, sessionPath, isRemoving, onBootstrap, onError],
  );

  return { info, isRefreshing, isCreatingBranch, isRemoving, error, refresh, revealWorktree, createBranch, removeWorktree };
}