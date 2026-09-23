import { useCallback, useEffect, useRef, useState } from "react";

import { fetchJson, postJson } from "../../lib/api";
import { getLocale, t } from "../../i18n";
import type { GitInfo } from "../../shared/gitStatusBadge";

interface UseProjectGitOptions {
  /** 当前项目 id；空串时徽标不显示也不请求。 */
  projectId: string;
  /** 会话是否在流式输出。agent 刚改完文件，一轮结束时刷新一次。 */
  isStreaming: boolean;
  /** "初始化仓库"失败时把原因交给会话的错误横幅（读失败不在这里）。 */
  onError?: (message: string) => void;
}

export interface ProjectGitController {
  info: GitInfo | null;
  /** 刷新时不显示 loading（徽标用上一次的数据继续显示），只有首次是 null。 */
  isRefreshing: boolean;
  isInitializing: boolean;
  /** 正在切往的分支名；空串 = 没在切。 */
  switchingTo: string;
  /** 新建分支请求在飞。 */
  isCreatingBranch: boolean;
  /** 重命名当前分支请求在飞。 */
  isRenamingBranch: boolean;
  /** 提交请求在飞。 */
  isCommitting: boolean;
  /** 「智能生成提交信息」在飞。 */
  isGeneratingMessage: boolean;
  /** 最近一次写操作（init / 切分支 / 提交）的失败原因；下一步成功会清掉。 */
  error: string;
  refresh: () => Promise<void>;
  initRepo: () => Promise<void>;
  switchBranch: (branch: string) => Promise<boolean>;
  /** 从当前 HEAD 新建分支并切过去；返回是否成功。 */
  createBranch: (name: string) => Promise<boolean>;
  /** 给当前分支改名；返回是否成功。 */
  renameBranch: (name: string) => Promise<boolean>;
  commitChanges: (input: { message: string; paths: string[] }) => Promise<boolean>;
  /** 双击改动文件：用宿主机的 IDE 打开 HEAD ↔ 工作区的 diff；返回是否成功。 */
  openDiff: (path: string) => Promise<boolean>;
  /** 用当前会话的模型根据选中改动生成提交信息；失败返回 null。 */
  generateCommitMessage: (paths: string[]) => Promise<string | null>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 当前项目的 git 信息。
 *
 * 刷新时机（不轮询）：
 * - 切项目 / 首次挂载；
 * - 一轮回答由"流式中"落到"结束"的那一次 —— agent 的工具刚好改过文件，这是信息最需要
 *   更新的时刻；
 * - 窗口重新获得焦点；
 * - 用户手动刷新（弹层里的按钮）。
 *
 * 失败一律静默：徽标退回"不显示"（`info = null`），不往会话头部塞错误横幅 —— 一个可选
 * 的装饰不该打断提问。只有"初始化仓库"失败会留下 `error`，因为它由用户主动触发。
 */
export function useProjectGit({ projectId, isStreaming, onError }: UseProjectGitOptions): ProjectGitController {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [switchingTo, setSwitchingTo] = useState("");
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isRenamingBranch, setIsRenamingBranch] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isGeneratingMessage, setIsGeneratingMessage] = useState(false);
  const [error, setError] = useState("");
  /** 项目切换/并发刷新时只认最后一次请求，避免旧项目的响应急回来覆盖新项目。 */
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!projectId) {
      return;
    }

    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setIsRefreshing(true);

    try {
      const next = await fetchJson<GitInfo>(`/api/projects/git?projectId=${encodeURIComponent(projectId)}`);
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
  }, [projectId]);

  // 切项目：先清空再拉，不能让上一个项目的分支名短暂留在新项目头上。
  useEffect(() => {
    requestSeq.current += 1;
    setInfo(null);
    setError("");
    if (projectId) {
      void refresh();
    }
  }, [projectId, refresh]);

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

  const initRepo = useCallback(async () => {
    if (!projectId || isInitializing) {
      return;
    }

    setIsInitializing(true);
    setError("");

    try {
      const next = await postJson<GitInfo>("/api/projects/git/init", { projectId });
      setInfo(next);
    } catch (initError) {
      const message = messageOf(initError);
      setError(message);
      onError?.(t("git.initFailed", { reason: message }));
    } finally {
      setIsInitializing(false);
    }
  }, [projectId, isInitializing, onError]);

  /**
   * 切分支。返回是否成功，供弹层决定要不要关：失败时把 git 的原话留在 `error` 里（弹层内
   * 显示）并交给会话错误横幅——像“本地改动会被覆盖，git 拒绝切换”这种信息必须看得见。
   */
  const switchBranch = useCallback(
    async (branch: string): Promise<boolean> => {
      if (!projectId || !branch || switchingTo) {
        return false;
      }

      setSwitchingTo(branch);
      setError("");

      try {
        const next = await postJson<GitInfo>("/api/projects/git/switch", { projectId, branch });
        setInfo(next);
        return true;
      } catch (switchError) {
        const message = messageOf(switchError);
        setError(message);
        onError?.(t("git.switchFailed", { branch, reason: message }));
        return false;
      } finally {
        setSwitchingTo("");
      }
    },
    [projectId, switchingTo, onError],
  );

  /**
   * 从当前分支新建分支（服务端跑 `git switch -c`）。返回是否成功，供弹层决定要不要收起新建表单：
   * 失败时把 git 的原话留在 `error`（弹层内显示）并交给会话错误横幅（比如分支名不合法）。
   */
  const createBranch = useCallback(
    async (name: string): Promise<boolean> => {
      if (!projectId || isCreatingBranch) {
        return false;
      }

      setIsCreatingBranch(true);
      setError("");

      try {
        const next = await postJson<GitInfo>("/api/projects/git/create-branch", { projectId, name });
        setInfo(next);
        return true;
      } catch (createError) {
        const reason = messageOf(createError);
        setError(reason);
        onError?.(t("git.createBranchFailed", { reason }));
        return false;
      } finally {
        setIsCreatingBranch(false);
      }
    },
    [projectId, isCreatingBranch, onError],
  );

  /**
   * 给当前分支改名。返回是否成功，供弹层决定要不要收起改名表单：失败时把 git 的原话留在
   * `error`（弹层内显示）并交给会话错误横幅（比如游离 HEAD / 名字不合法）。
   */
  const renameBranch = useCallback(
    async (name: string): Promise<boolean> => {
      if (!projectId || isRenamingBranch) {
        return false;
      }

      setIsRenamingBranch(true);
      setError("");

      try {
        const next = await postJson<GitInfo>("/api/projects/git/rename-branch", { projectId, name });
        setInfo(next);
        return true;
      } catch (renameError) {
        const reason = messageOf(renameError);
        setError(reason);
        onError?.(t("git.renameBranchFailed", { reason }));
        return false;
      } finally {
        setIsRenamingBranch(false);
      }
    },
    [projectId, isRenamingBranch, onError],
  );

  /**
   * 提交勾选的改动。返回是否成功，供 UI 决定要不要清空提交框：失败时 git 的原话留在
   * `error`（弹层内显示）并交给会话错误横幅（比如"user.email 未配置"）。
   */
  const commitChanges = useCallback(
    async ({ message, paths }: { message: string; paths: string[] }): Promise<boolean> => {
      if (!projectId || isCommitting) {
        return false;
      }

      setIsCommitting(true);
      setError("");

      try {
        const next = await postJson<GitInfo>("/api/projects/git/commit", { projectId, message, paths });
        setInfo(next);
        return true;
      } catch (commitError) {
        const reason = messageOf(commitError);
        setError(reason);
        onError?.(t("git.commitFailed", { reason }));
        return false;
      } finally {
        setIsCommitting(false);
      }
    },
    [projectId, isCommitting, onError],
  );

  /**
   * 双击某个改动文件：让宿主机上的 IDE 打开这个文件的 diff。只读，不需要 loading 态。
   * 失败（没装可识别的 IDE / 路径已不在改动列表里）进 `error` + 会话错误横幅 —— 用户主动
   * 点的操作，静默失败等于点了没反应。
   */
  const openDiff = useCallback(
    async (path: string): Promise<boolean> => {
      if (!projectId || !path) {
        return false;
      }

      setError("");

      try {
        await postJson<{ ide: string }>("/api/projects/git/open-diff", { projectId, path });
        return true;
      } catch (openError) {
        const reason = messageOf(openError);
        setError(reason);
        onError?.(t("git.openDiffFailed", { reason }));
        return false;
      }
    },
    [projectId, onError],
  );

  /**
   * 用当前会话的模型生成提交信息。只拿回文本填进输入框，不直接提交 —— 用户还能改。
   * 失败（没选模型 / 没配 key / 模型没给内容）一律进 `error` + 会话错误横幅。
   */
  const generateCommitMessage = useCallback(
    async (paths: string[]): Promise<string | null> => {
      if (!projectId || isGeneratingMessage) {
        return null;
      }

      setIsGeneratingMessage(true);
      setError("");

      try {
        const result = await postJson<{ message: string }>("/api/projects/git/commit-message", {
          projectId,
          paths,
          locale: getLocale(),
        });
        return String(result?.message ?? "").trim() || null;
      } catch (generateError) {
        const reason = messageOf(generateError);
        setError(reason);
        onError?.(t("git.generateFailed", { reason }));
        return null;
      } finally {
        setIsGeneratingMessage(false);
      }
    },
    [projectId, isGeneratingMessage, onError],
  );

  return { info, isRefreshing, isInitializing, switchingTo, isCreatingBranch, isRenamingBranch, isCommitting, isGeneratingMessage, error, refresh, initRepo, switchBranch, createBranch, renameBranch, commitChanges, openDiff, generateCommitMessage };
}