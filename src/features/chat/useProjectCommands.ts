import { useCallback, useEffect, useRef, useState } from "react";

import { fetchJson, postJson } from "../../lib/api";
import { t } from "../../i18n";
import { loadUiPreferences } from "../../lib/ui-preferences";
import { normalizeProjectCommandTerminal, PROJECT_COMMAND_BACKGROUND } from "../../shared/projectCommandTerminal.ts";
import {
  isCommandSaved,
  mergeDetectedCommands,
  normalizeProjectCommands,
  normalizeSelectedCommandId,
  removeProjectCommand,
  selectedProjectCommand,
  type ProjectCommand,
  type ProjectCommandsPayload,
} from "../../shared/projectCommands";
import type { ProjectCommandRunResult } from "../../shared/projectCommandTerminal.ts";

interface UseProjectCommandsOptions {
  /** 当前项目 id；空串时不请求。 */
  projectId: string;
  /** 当前会话路径。探测和运行都落在会话自己的工作区上（worktree 会话 = worktree）。 */
  sessionPath?: string;
  /** 运行方式（后台静默 / 系统默认终端 / 终端 app 名）；缺省读 UI 偏好。 */
  runTarget?: string;
  /** 失败原因交给会话错误横幅；只有用户主动触发的操作会留下它。 */
  onError?: (message: string) => void;
}

export interface ProjectCommandsController {
  commands: ProjectCommand[];
  selectedCommandId: string;
  /** 当前选中的命令；没有就 null（「运行」按钮据此禁用）。 */
  selected: ProjectCommand | null;
  /** 上一次探测的候选；null = 还没探测过（下拉里不显示探测结果区）。 */
  candidates: ProjectCommand[] | null;
  isDetecting: boolean;
  isRunning: boolean;
  isLoading: boolean;
  /** 用户主动触发的操作（探测 / 保存 / 运行）的失败原因；下一次成功会清掉。 */
  error: string;
  /**
   * 只读加载失败（桥还没起来 / 还是个没这个接口的旧版本）。
   *
   * 和 `error` 分开：加载失败不是用户做了什么错事，不能把「运行」按钮染红（那看起来
   * 像功能坏了），只在面板里说明原因；窗口重新聚焦时会自己重试。
   */
  loadError: string;
  detect: () => Promise<ProjectCommand[]>;
  /** 把一条候选并进列表并选中它（面板不关，可以接着加下一条）。 */
  addCommand: (candidate: ProjectCommand) => Promise<boolean>;
  selectCommand: (id: string) => Promise<boolean>;
  removeCommand: (id: string) => Promise<boolean>;
  /** 跑当前选中的命令：后台静默或交给终端（看运行方式）。 */
  run: () => Promise<boolean>;
  /** 上一次成功启动的结果（后台运行有日志路径）；给界面的「已启动」提示用。 */
  lastRun: ProjectCommandRunResult | null;
  clearLastRun: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 当前项目的命令列表（会话头部「运行」+ 命令下拉）。
 *
 * 服务端 `projects.json` 是唯一持久化点，但这里自己持有状态（和 `useProjectGit` 同一个
 * 取舍）：命令列表是这个小控件自己的事，为它重建一整份 bootstrap 快照不划算。切项目时
 * 先清空再拉，旧项目的响应不许覆盖新项目。
 */
export function useProjectCommands({ projectId, sessionPath = "", runTarget, onError }: UseProjectCommandsOptions): ProjectCommandsController {
  const [commands, setCommands] = useState<ProjectCommand[]>([]);
  const [selectedCommandId, setSelectedCommandId] = useState("");
  const [candidates, setCandidates] = useState<ProjectCommand[] | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [lastRun, setLastRun] = useState<ProjectCommandRunResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const requestSeq = useRef(0);

  const applyPayload = useCallback((payload: ProjectCommandsPayload | undefined) => {
    const nextCommands = normalizeProjectCommands(payload?.commands);
    setCommands(nextCommands);
    setSelectedCommandId(normalizeSelectedCommandId(payload?.selectedCommandId, nextCommands));
  }, []);

  const refresh = useCallback(async () => {
    if (!projectId) {
      return;
    }

    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setIsLoading(true);

    try {
      const query = new URLSearchParams({ projectId });
      const payload = await fetchJson<ProjectCommandsPayload>(`/api/projects/commands?${query.toString()}`);
      if (seq === requestSeq.current) {
        applyPayload(payload);
        setError("");
        setLoadError("");
      }
    } catch (failure) {
      if (seq === requestSeq.current) {
        setCommands([]);
        setSelectedCommandId("");
        setLoadError(messageOf(failure));
      }
    } finally {
      if (seq === requestSeq.current) {
        setIsLoading(false);
      }
    }
  }, [projectId, applyPayload]);

  // 切项目：先清空再拉，不能让上一个项目的命令短暂留在下拉里。
  useEffect(() => {
    requestSeq.current += 1;
    setCommands([]);
    setSelectedCommandId("");
    setCandidates(null);
    setError("");
    setLoadError("");
    if (projectId) {
      void refresh();
    }
  }, [projectId, refresh]);

  // 启动竞态（渲染层先发请求、桥后监听）和版本不一致都会让首次读取失败，
  // 窗口重新获得焦点时重试一次 —— 和 git 徽标同一个理由。
  useEffect(() => {
    const handleFocus = () => void refresh();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh]);

  /** 整表替换（添加 / 删除走这条），服务端回什么就以什么为准。 */
  const persist = useCallback(
    async (next: { commands: ProjectCommand[]; selectedCommandId: string }): Promise<boolean> => {
      if (!projectId) {
        return false;
      }
      setError("");
      try {
        const payload = await postJson<ProjectCommandsPayload>("/api/projects/commands", {
          projectId,
          commands: next.commands,
          selectedCommandId: next.selectedCommandId,
        });
        applyPayload(payload);
        return true;
      } catch (saveError) {
        const reason = messageOf(saveError);
        setError(reason);
        onError?.(t("projectCommand.saveFailed", { reason }));
        return false;
      }
    },
    [projectId, applyPayload, onError],
  );

  const detect = useCallback(async (): Promise<ProjectCommand[]> => {
    if (!projectId || isDetecting) {
      return candidates ?? [];
    }

    setIsDetecting(true);
    setError("");
    try {
      const result = await postJson<{ candidates?: ProjectCommand[] }>("/api/projects/commands/detect", {
        projectId,
        sessionPath,
      });
      const detected = normalizeProjectCommands(result?.candidates);
      setCandidates(detected);
      return detected;
    } catch (detectError) {
      const reason = messageOf(detectError);
      setError(reason);
      onError?.(t("projectCommand.detectFailed", { reason }));
      setCandidates([]);
      return [];
    } finally {
      setIsDetecting(false);
    }
  }, [projectId, sessionPath, isDetecting, candidates, onError]);

  const addCommand = useCallback(
    async (candidate: ProjectCommand): Promise<boolean> => {
      const already = isCommandSaved(commands, candidate);
      const merged = mergeDetectedCommands(commands, selectedCommandId, [candidate]);
      // 刚加进来的这条直接设成选中：点「+」就是想跑它；连着加好几条时勾会跟着走。
      const next = already ? merged : { ...merged, selectedCommandId: candidate.id };
      return persist(next);
    },
    [commands, selectedCommandId, persist],
  );

  const selectCommand = useCallback(
    async (id: string): Promise<boolean> => {
      if (!projectId || !id) {
        return false;
      }
      // 先乐观切过去（下拉开着，点一下要立刻见到勾），服务端失败再回滚成列表的第一条。
      const previous = selectedCommandId;
      setSelectedCommandId(id);
      setError("");
      try {
        const payload = await postJson<ProjectCommandsPayload>("/api/projects/commands/select", { projectId, commandId: id });
        applyPayload(payload);
        return true;
      } catch (selectError) {
        const reason = messageOf(selectError);
        setSelectedCommandId(normalizeSelectedCommandId(previous, commands));
        setError(reason);
        onError?.(t("projectCommand.saveFailed", { reason }));
        return false;
      }
    },
    [projectId, selectedCommandId, commands, applyPayload, onError],
  );

  const removeCommand = useCallback(
    async (id: string): Promise<boolean> => {
      const next = removeProjectCommand(commands, selectedCommandId, id);
      return persist(next);
    },
    [commands, selectedCommandId, persist],
  );

  const run = useCallback(async (): Promise<boolean> => {
    if (!projectId || isRunning) {
      return false;
    }
    const command = selectedProjectCommand(commands, selectedCommandId);
    if (!command) {
      return false;
    }

    setIsRunning(true);
    setError("");
    try {
      const target = normalizeProjectCommandTerminal(runTarget ?? loadUiPreferences().projectCommandTerminal);
      const result = await postJson<{ launcher?: string; logPath?: string; pid?: number }>("/api/projects/commands/run", {
        projectId,
        sessionPath,
        commandId: command.id,
        background: target === PROJECT_COMMAND_BACKGROUND,
        terminal: target,
      });
      setLastRun({
        launcher: result?.launcher ?? "",
        command: command.command,
        logPath: result?.logPath,
        pid: result?.pid,
      });
      return true;
    } catch (runError) {
      const reason = messageOf(runError);
      setError(reason);
      onError?.(t("projectCommand.runFailed", { reason }));
      return false;
    } finally {
      setIsRunning(false);
    }
  }, [projectId, sessionPath, isRunning, commands, selectedCommandId, runTarget, onError]);

  const clearLastRun = useCallback(() => setLastRun(null), []);

  return {
    commands,
    selectedCommandId,
    selected: selectedProjectCommand(commands, selectedCommandId),
    candidates,
    isDetecting,
    isRunning,
    isLoading,
    error,
    loadError,
    lastRun,
    detect,
    addCommand,
    selectCommand,
    removeCommand,
    run,
    clearLastRun,
  };
}