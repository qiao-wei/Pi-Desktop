import { useCallback, useEffect, useRef, useState } from "react";

import { fetchJson, postJson } from "../../lib/api";
import { t } from "../../i18n";
import { loadUiPreferences } from "../../lib/ui-preferences";
import { normalizeProjectCommandTerminal, normalizeProjectCommandRuns, PROJECT_COMMAND_BACKGROUND, sameProjectCommandRuns } from "../../shared/projectCommandTerminal.ts";
import {
  appendProjectCommand,
  commandLine,
  isCommandSaved,
  mergeDetectedCommands,
  normalizeProjectCommands,
  normalizeSelectedCommandId,
  removeProjectCommand,
  selectedProjectCommand,
  updateProjectCommand,
  type ProjectCommand,
  type ProjectCommandEditInput,
  type ProjectCommandsPayload,
} from "../../shared/projectCommands";
import type { ProjectCommandRun, ProjectCommandRunResult } from "../../shared/projectCommandTerminal.ts";

/** 后台进程存活状态的轮询间隔：够快地发现退出，又不至于一直打桥。 */
export const PROJECT_COMMAND_RUN_POLL_MS = 3000;

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
  /** 改一条已保存的命令（命令 / 参数 / 环境变量 / 子目录）。 */
  updateCommand: (id: string, patch: ProjectCommandEditInput) => Promise<boolean>;
  /** 手动新增一条命令（探测不到、或需要自己写参数 / 环境变量）。 */
  addManualCommand: (input: ProjectCommandEditInput & { command: string }) => Promise<boolean>;
  selectCommand: (id: string) => Promise<boolean>;
  removeCommand: (id: string) => Promise<boolean>;
  /** 跑当前选中的命令：后台静默或交给终端（看运行方式）。 */
  run: () => Promise<boolean>;
  /**
   * 后台还在跑的命令（只含存活进程，最新的在前）。
   *
   * 有内容时 hook 会按 `PROJECT_COMMAND_RUN_POLL_MS` 轮询，进程结束会自己从列表里消失。
   */
  runs: ProjectCommandRun[];
  /** 正在停某条后台命令（「停止」按钮的 loading）。 */
  isStoppingRun: boolean;
  /** 停掉一条后台命令（结束进程树），列表刷新后不再出现。 */
  stopRun: (runId: string) => Promise<boolean>;
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
  const [runs, setRuns] = useState<ProjectCommandRun[]>([]);
  const [isStoppingRun, setIsStoppingRun] = useState(false);
  const [lastRun, setLastRun] = useState<ProjectCommandRunResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const requestSeq = useRef(0);
  const runsSeq = useRef(0);

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

  /**
   * 后台命令的存活状态。失败（旧桥 / 启动竞态）当作「没有运行中」——这只是附加信息，
   * 不能让它把「运行」按钮或错误横幅弄脏。
   */
  const refreshRuns = useCallback(async () => {
    if (!projectId) {
      return;
    }
    const seq = runsSeq.current + 1;
    runsSeq.current = seq;
    try {
      const query = new URLSearchParams({ projectId });
      const payload = await fetchJson<{ runs?: unknown }>(`/api/projects/commands/status?${query.toString()}`);
      if (seq === runsSeq.current) {
        const next = normalizeProjectCommandRuns(payload?.runs);
        // 3 秒一次轮询：内容没变就返回旧引用，避免白重渲染整个 App。
        setRuns((current) => (sameProjectCommandRuns(current, next) ? current : next));
      }
    } catch {
      if (seq === runsSeq.current) {
        setRuns((current) => (current.length === 0 ? current : []));
      }
    }
  }, [projectId]);

  // 切项目：先清空再拉，不能让上一个项目的命令短暂留在下拉里。
  useEffect(() => {
    requestSeq.current += 1;
    runsSeq.current += 1;
    setCommands([]);
    setSelectedCommandId("");
    setCandidates(null);
    setRuns([]);
    setError("");
    setLoadError("");
    if (projectId) {
      void refresh();
      // 桥重启后内存里什么都没有，但被 detached 抛出的 dev server 还活着：靠台账找回来。
      void refreshRuns();
    }
  }, [projectId, refresh, refreshRuns]);

  // 有后台命令在跑时才轮询：进程退出 / 用户按「停止」后列表变空，轮询自然停下。
  useEffect(() => {
    if (!projectId || runs.length === 0) {
      return;
    }
    const timer = window.setInterval(() => void refreshRuns(), PROJECT_COMMAND_RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [projectId, runs.length, refreshRuns]);

  // 启动竞态（渲染层先发请求、桥后监听）和版本不一致都会让首次读取失败，
  // 窗口重新获得焦点时重试一次 —— 和 git 徽标同一个理由。
  useEffect(() => {
    const handleFocus = () => {
      void refresh();
      void refreshRuns();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh, refreshRuns]);

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

  const updateCommand = useCallback(
    async (id: string, patch: ProjectCommandEditInput): Promise<boolean> => {
      if (!projectId || !id) {
        return false;
      }
      return persist(updateProjectCommand(commands, selectedCommandId, id, patch));
    },
    [projectId, commands, selectedCommandId, persist],
  );

  const addManualCommand = useCallback(
    async (input: ProjectCommandEditInput & { command: string }): Promise<boolean> => {
      if (!projectId) {
        return false;
      }
      return persist(appendProjectCommand(commands, selectedCommandId, input));
    },
    [projectId, commands, selectedCommandId, persist],
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
        command: commandLine(command.command, command.args),
        logPath: result?.logPath,
        pid: result?.pid,
      });
      // 后台运行：立刻查一次台账，「运行中」提示不用等下一次轮询。
      if (result?.launcher === "background") {
        void refreshRuns();
      }
      return true;
    } catch (runError) {
      const reason = messageOf(runError);
      setError(reason);
      onError?.(t("projectCommand.runFailed", { reason }));
      return false;
    } finally {
      setIsRunning(false);
    }
  }, [projectId, sessionPath, isRunning, commands, selectedCommandId, runTarget, onError, refreshRuns]);

  const stopRun = useCallback(
    async (runId: string): Promise<boolean> => {
      if (!runId || isStoppingRun) {
        return false;
      }
      const previous = runs;
      // 乐观移除：点「停止」要立刻有反馈，失败再放回去。
      setRuns((current) => current.filter((run) => run.id !== runId));
      setIsStoppingRun(true);
      setError("");
      try {
        await postJson("/api/projects/commands/stop", { runId });
        void refreshRuns();
        return true;
      } catch (stopError) {
        const reason = messageOf(stopError);
        setRuns(previous);
        setError(reason);
        onError?.(t("projectCommand.stopFailed", { reason }));
        return false;
      } finally {
        setIsStoppingRun(false);
      }
    },
    [runs, isStoppingRun, refreshRuns, onError],
  );

  // 台账确认了刚启动的那条后台 run 之后，9 秒的「已启动」小条就该退位给「运行中」常驻提示。
  useEffect(() => {
    if (lastRun?.launcher !== "background" || runs.length === 0) {
      return;
    }
    setLastRun((current) => (current?.launcher === "background" ? null : current));
  }, [lastRun?.launcher, runs.length]);

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
    runs,
    isStoppingRun,
    stopRun,
    lastRun,
    detect,
    addCommand,
    updateCommand,
    addManualCommand,
    selectCommand,
    removeCommand,
    run,
    clearLastRun,
  };
}