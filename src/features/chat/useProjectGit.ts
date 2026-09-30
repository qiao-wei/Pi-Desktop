import { useCallback, useEffect, useRef, useState } from "react";

import { fetchJson, postJson } from "../../lib/api";
import { getLocale, t } from "../../i18n";
import type { GitInfo } from "../../shared/gitStatusBadge";

interface UseProjectGitOptions {
  /** 当前项目 id；空串时徽标不显示也不请求。 */
  projectId: string;
  /**
   * 当前会话路径。带上它之后，git 读和写都落在**会话自己的 workspace** 上：worktree 会话
   * 看到、提交的就是 worktree，而不是项目主检出。
   */
  sessionPath?: string;
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
  /** 推送（或首次关联远端并推送）在飞。 */
  isPushing: boolean;
  /** 拉取（fetch + merge 上游）在飞。 */
  isPulling: boolean;
  /** 合并其它分支在飞。 */
  isMergingBranch: boolean;
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
  /** 双击冲突文件：用宿主机的 IDE 打开文件本身（编辑冲突标记）；返回是否成功。 */
  openFile: (path: string) => Promise<boolean>;
  /** 用当前会话的模型根据选中改动生成提交信息；失败返回 null。 */
  generateCommitMessage: (paths: string[]) => Promise<string | null>;
  /** 推送当前分支；没有上游时关联远端（优先 origin）再推。返回是否成功。 */
  pushBranch: () => Promise<boolean>;
  /** 拉取上游分支并合并进当前分支；返回是否成功。 */
  pullBranch: () => Promise<boolean>;
  /** 把选中的其它本地分支合并进当前分支；返回是否成功（冲突算成功，已刷新为冲突状态）。 */
  mergeBranch: (branch: string) => Promise<boolean>;
  /** 读冲突清单与内容拼成一条 prompt（自动解决冲突用）；没有冲突时返回 null。 */
  conflictPrompt: () => Promise<string | null>;
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
export function useProjectGit({ projectId, sessionPath = "", isStreaming, onError }: UseProjectGitOptions): ProjectGitController {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [switchingTo, setSwitchingTo] = useState("");
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isRenamingBranch, setIsRenamingBranch] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isGeneratingMessage, setIsGeneratingMessage] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isMergingBranch, setIsMergingBranch] = useState(false);
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
      const query = new URLSearchParams({ projectId });
      if (sessionPath) {
        query.set("sessionPath", sessionPath);
      }
      const next = await fetchJson<GitInfo>(`/api/projects/git?${query.toString()}`);
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

  // 切项目 / 切会话：先清空再拉，不能让上一个 workspace 的分支名短暂留在头上。
  useEffect(() => {
    requestSeq.current += 1;
    setInfo(null);
    setError("");
    if (projectId) {
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
        const next = await postJson<GitInfo>("/api/projects/git/switch", { projectId, sessionPath, branch });
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
    [projectId, sessionPath, switchingTo, onError],
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
        const next = await postJson<GitInfo>("/api/projects/git/create-branch", { projectId, sessionPath, name });
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
    [projectId, sessionPath, isCreatingBranch, onError],
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
        const next = await postJson<GitInfo>("/api/projects/git/commit", { projectId, sessionPath, message, paths });
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
    [projectId, sessionPath, isCommitting, onError],
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
   * 双击冲突文件：让宿主机上的 IDE 打开**文件本身**（不是 diff），跟改动列表里的其它按钮
   * 一样先过服务端的“这是不是当前改动”校验。
   */
  const openFile = useCallback(
    async (path: string): Promise<boolean> => {
      if (!projectId || !path) {
        return false;
      }

      setError("");

      try {
        await postJson<{ ide: string }>("/api/projects/git/open-file", { projectId, sessionPath, path });
        return true;
      } catch (openError) {
        const reason = messageOf(openError);
        setError(reason);
        onError?.(t("git.openConflictFailed", { reason }));
        return false;
      }
    },
    [projectId, sessionPath, onError],
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
          sessionPath,
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
    [projectId, sessionPath, isGeneratingMessage, onError],
  );

  /**
   * 推送当前分支。没有上游时服务端会先关联远端（优先 origin）再推 —— 同一个入口。
   * 失败时 git 的原话进 `error`（弹层内显示）并交给会话错误横幅（比如需要认证 / 远端拒绝）。
   */
  const pushBranch = useCallback(
    async (): Promise<boolean> => {
      if (!projectId || isPushing) {
        return false;
      }

      setIsPushing(true);
      setError("");

      try {
        const next = await postJson<GitInfo>("/api/projects/git/push", { projectId, sessionPath });
        setInfo(next);
        return true;
      } catch (pushError) {
        const reason = messageOf(pushError);
        setError(reason);
        onError?.(t("git.pushFailed", { reason }));
        return false;
      } finally {
        setIsPushing(false);
      }
    },
    [projectId, sessionPath, isPushing, onError],
  );

  /**
   * 拉取上游分支（服务端跑 fetch + merge）。失败时 git 的原话进 `error`（弹层内显示）
   * 并交给会话错误横幅（比如冲突 / 需要认证）。
   */
  const pullBranch = useCallback(
    async (): Promise<boolean> => {
      if (!projectId || isPulling) {
        return false;
      }

      setIsPulling(true);
      setError("");

      try {
        const next = await postJson<GitInfo>("/api/projects/git/pull", { projectId, sessionPath });
        setInfo(next);
        return true;
      } catch (pullError) {
        const reason = messageOf(pullError);
        // 拉取冲突时 git 已经把冲突标记写进工作区，但接口是 500（抛错）：必须再读一次 info，
        // 否则弹层里看不到刚产生的冲突文件，「自动解决冲突」也就没得点。
        await refresh();
        setError(reason);
        onError?.(t("git.pullFailed", { reason }));
        return false;
      } finally {
        setIsPulling(false);
      }
    },
    [projectId, sessionPath, isPulling, onError, refresh],
  );

  /**
   * 把选中的其它本地分支合并进当前分支。冲突**不是**失败：服务端回 `conflict: true` +
   * 刷新后的 info，`setInfo` 把冲突文件摆到列表里，由弹层里的「自动解决冲突」接手。
   * 其它失败（脏树被 git 拒、分支不见了）才进 `error`。
   */
  const mergeBranch = useCallback(
    async (branch: string): Promise<boolean> => {
      if (!projectId || !branch || isMergingBranch) {
        return false;
      }

      setIsMergingBranch(true);
      setError("");

      try {
        const result = await postJson<{ conflict: boolean; branch: string; info: GitInfo }>("/api/projects/git/merge", {
          projectId,
          sessionPath,
          branch,
        });
        setInfo(result.info);
        return true;
      } catch (mergeError) {
        const reason = messageOf(mergeError);
        setError(reason);
        onError?.(t("git.mergeFailed", { reason }));
        return false;
      } finally {
        setIsMergingBranch(false);
      }
    },
    [projectId, sessionPath, isMergingBranch, onError],
  );

  /**
   * 「自动解决冲突」的第一步：拿服务端拼好的冲突提示词。真正的“新建会话 + 填进 composer”
   * 在 App 里做（那是会话层的动作，不属于 git hook）。没有冲突 / 读失败返回 null。
   */
  const conflictPrompt = useCallback(
    async (): Promise<string | null> => {
      if (!projectId) {
        return null;
      }

      setError("");

      try {
        const result = await postJson<{ prompt: string }>("/api/projects/git/conflicts", {
          projectId,
          sessionPath,
          locale: getLocale(),
        });
        return String(result?.prompt ?? "").trim() || null;
      } catch (conflictError) {
        const reason = messageOf(conflictError);
        setError(reason);
        onError?.(t("git.conflictPromptFailed", { reason }));
        return null;
      }
    },
    [projectId, sessionPath, onError],
  );

  return { info, isRefreshing, isInitializing, switchingTo, isCreatingBranch, isRenamingBranch, isCommitting, isGeneratingMessage, isPushing, isPulling, isMergingBranch, error, refresh, initRepo, switchBranch, createBranch, renameBranch, commitChanges, openDiff, openFile, generateCommitMessage, pushBranch, pullBranch, mergeBranch, conflictPrompt };
}