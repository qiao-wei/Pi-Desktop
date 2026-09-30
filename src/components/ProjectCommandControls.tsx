import { Check, ChevronDown, Loader2, Play, Plus, Search, Sparkles, Square, Terminal, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/react";
import {
  filterProjectCommands,
  isCommandSaved,
  runCommandDisabledReason,
  selectedProjectCommand,
  type ProjectCommand,
} from "../shared/projectCommands";
import {
  findCommandRun,
  isProjectCommandBackground,
  PROJECT_COMMAND_BACKGROUND,
  PROJECT_COMMAND_DEFAULT_TERMINAL,
  type ProjectCommandRun,
  type ProjectCommandRunResult,
} from "../shared/projectCommandTerminal";

/** 「已启动」提示停留多久（后台运行没别的反馈，给用户一点时间点「查看日志」）。 */
const RUN_NOTICE_DISMISS_MS = 9000;

export interface ProjectCommandControlsProps {
  commands: ProjectCommand[];
  selectedCommandId: string;
  /** 上一次探测的候选；null = 还没探测过。 */
  candidates: ProjectCommand[] | null;
  isDetecting: boolean;
  isRunning: boolean;
  isLoading: boolean;
  /** 用户主动触发的操作失败（探测 / 保存 / 运行）。 */
  error: string;
  /** 只读加载失败（旧桥 / 启动竞态）：只在面板里说，不把「运行」染红。 */
  loadError: string;
  /** 当前运行方式：`background` / `default` / 终端 app 名。 */
  runTarget: string;
  onRunTargetChange: (target: string) => void;
  /** 上一次成功启动的结果；null = 没有可显示的提示。 */
  lastRun: ProjectCommandRunResult | null;
  /** 后台还在跑的命令（存活进程），最新的在前。 */
  runs: ProjectCommandRun[];
  /** 正在停某条后台命令。 */
  isStoppingRun: boolean;
  onStopRun: (runId: string) => void;
  onDismissRun: () => void;
  onRun: () => void;
  onRevealLog: (logPath: string) => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onDetect: () => void;
  onAdd: (candidate: ProjectCommand) => void;
}

/**
 * 会话头部的「运行 + 命令下拉」。
 *
 * 位置在 git 徽标左边：左边是「运行」按钮，右边是命令列表；点「运行」执行列表里当前选中的
 * 那条。列表为空（或想加更多）时下拉里有「自动探测」——探测结果列在下拉里，点一条加一条、
 * 加进去就选中，用户自己挑。
 */
export function ProjectCommandControls({
  commands,
  selectedCommandId,
  candidates,
  isDetecting,
  isRunning,
  isLoading,
  error,
  loadError,
  runTarget,
  onRunTargetChange,
  lastRun,
  runs,
  isStoppingRun,
  onStopRun,
  onDismissRun,
  onRun,
  onRevealLog,
  onSelect,
  onRemove,
  onDetect,
  onAdd,
}: ProjectCommandControlsProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [terminals, setTerminals] = useState<string[]>([]);
  const selected = selectedProjectCommand(commands, selectedCommandId);
  const disabledReason = runCommandDisabledReason(selected, isRunning);
  const runDisabledHint = disabledReason === "running" ? t("projectCommand.runPending") : t("projectCommand.runDisabled");
  const runTitle = selected
    ? t(isProjectCommandBackground(runTarget) ? "projectCommand.runHintBackground" : "projectCommand.runHint", { command: selected.command })
    : runDisabledHint;

  const visibleCommands = filterProjectCommands(commands, query);
  const visibleCandidates = candidates ? filterProjectCommands(candidates, query) : null;
  // 探测一次可能是几十条（NextClaw 的根 package.json 就有 40+ 个脚本），没搜索只能靠眼扫。
  const showSearch = commands.length + (candidates?.length ?? 0) > 8;
  // 选中的命令正在后台跑 →「运行」按钮变成「停止」。其余还在跑的命令（用户切到别的命令了）
  // 用一个常驻小条继续保留停止入口，否则切一下命令就没法停它了。
  const runningSelected = selected ? findCommandRun(runs, selected.id) : null;
  const otherRuns = runningSelected ? runs.filter((run) => run.id !== runningSelected.id) : runs;
  const otherRun = otherRuns[0] ?? null;
  const otherRunsTitle = otherRuns.map((run) => `${run.command}${run.cwd ? `  (${run.cwd})` : ""}`).join("\n");

  // 关闭时清掉搜索词，下次打开还是完整列表。
  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  // 第一次打开下拉时拿一次「装了哪些终端」（只读扫描，失败就只留系统默认）。
  useEffect(() => {
    if (!open || terminals.length > 0) {
      return;
    }
    let cancelled = false;
    void fetchJson<{ terminals?: string[] }>("/api/projects/commands/terminals")
      .then((payload) => {
        if (!cancelled) {
          setTerminals(Array.isArray(payload?.terminals) ? payload.terminals.filter((name) => name && name !== "Terminal") : []);
        }
      })
      .catch(() => {
        // 老桥没有这个接口：忽略，只显示「后台运行 / 系统默认终端」。
      });
    return () => {
      cancelled = true;
    };
  }, [open, terminals.length]);

  // 「已启动」提示自己走掉，别一直占着头部。
  useEffect(() => {
    if (!lastRun) {
      return;
    }
    const timer = window.setTimeout(onDismissRun, RUN_NOTICE_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [lastRun, onDismissRun]);

  const pick = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

  // 加完**不关面板**：探测一次可能几十条，用户往往想连着加好几条（加过的会变成勾）。
  const add = (candidate: ProjectCommand) => {
    onAdd(candidate);
  };

  return (
    <div className="flex shrink-0 items-center gap-1" aria-label={t("projectCommand.menuTitle")}>
      {runningSelected ? (
        <button
          type="button"
          onClick={() => onStopRun(runningSelected.id)}
          disabled={isStoppingRun}
          aria-label={t("projectCommand.stop")}
          title={t("projectCommand.stopHint", { command: runningSelected.command })}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[0.78rem] text-destructive transition-colors hover:bg-destructive/10 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
        >
          {isStoppingRun ? (
            <Loader2 className="size-[14px] animate-spin" aria-hidden="true" />
          ) : (
            <Square className="size-3.5 fill-current" aria-hidden="true" />
          )}
          <span className="max-[720px]:hidden">
            {isStoppingRun ? t("projectCommand.stopping") : t("projectCommand.stop")}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onRun}
          disabled={disabledReason !== null}
          aria-label={runTitle}
          title={runTitle}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[0.78rem] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
            error && "text-destructive hover:text-destructive",
          )}
        >
          {isRunning ? (
            <Loader2 className="size-[14px] animate-spin" aria-hidden="true" />
          ) : (
            <Play className="size-[14px]" aria-hidden="true" />
          )}
          <span className="max-[720px]:hidden">{isRunning ? t("projectCommand.runPending") : t("projectCommand.run")}</span>
        </button>
      )}

      {runningSelected?.logPath ? (
        <button
          type="button"
          onClick={() => onRevealLog(runningSelected.logPath)}
          className="flex h-7 shrink-0 items-center rounded-md px-1.5 text-[0.78rem] text-muted-foreground underline underline-offset-2 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {t("projectCommand.viewLog")}
        </button>
      ) : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("projectCommand.menuTitle")}
            title={selected ? `${selected.command}${selected.cwd ? `  (${selected.cwd})` : ""}` : t("projectCommand.selectPlaceholder")}
            className={cn(
              "flex h-7 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[0.78rem] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none max-[560px]:max-w-[8rem]",
              open && "bg-accent text-accent-foreground",
            )}
          >
            <Terminal className="size-[14px] shrink-0" aria-hidden="true" />
            <span className={cn("min-w-0 flex-1 truncate text-left", selected && "font-medium text-foreground")}>
              {selected ? selected.label : t("projectCommand.selectPlaceholder")}
            </span>
            <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="bottom"
          sideOffset={6}
          collisionPadding={{ top: 8, right: 8, bottom: 8, left: 8 }}
          className="flex max-h-[var(--radix-popover-content-available-height,calc(100vh-4rem))] w-[22rem] max-w-[92vw] flex-col overflow-hidden p-0 text-xs"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
            <span className="font-medium text-muted-foreground">{t("projectCommand.menuTitle")}</span>
            <button
              type="button"
              onClick={onDetect}
              disabled={isDetecting}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.72rem] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
            >
              {isDetecting ? (
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="size-3" aria-hidden="true" />
              )}
              {isDetecting ? t("projectCommand.detecting") : t("projectCommand.detect")}
            </button>
          </div>

          {showSearch ? (
            <div className="relative shrink-0 border-b px-3 py-0.5">
              <Search
                className="pointer-events-none absolute top-1/2 left-5 size-3 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("projectCommand.search")}
                aria-label={t("projectCommand.search")}
                spellCheck={false}
                className="w-full bg-transparent py-1 pl-5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
            {isLoading && commands.length === 0 ? (
              <p className="px-3 py-2 text-muted-foreground">{t("projectCommand.loading")}</p>
            ) : null}
            {!isLoading && commands.length === 0 ? (
              <p className="px-3 py-2 text-muted-foreground">{t("projectCommand.empty")}</p>
            ) : null}
            {commands.length > 0 && visibleCommands.length === 0 ? (
              <p className="px-3 py-2 text-muted-foreground">{t("projectCommand.noMatch")}</p>
            ) : null}
            {visibleCommands.map((command) => (
              <div key={command.id} className="group flex items-center gap-1 px-1.5">
                <button
                  type="button"
                  onClick={() => pick(command.id)}
                  aria-label={command.command}
                  title={command.command}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <span className="flex w-3 shrink-0 items-center justify-center" aria-hidden="true">
                    {command.id === selectedCommandId ? <Check className="size-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate", command.id === selectedCommandId && "font-medium")}>{command.label}</span>
                    <span className="block truncate font-mono text-[0.68rem] text-muted-foreground">
                      {command.command}
                      {command.cwd ? ` · ${command.cwd}` : ""}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(command.id)}
                  aria-label={t("projectCommand.remove")}
                  title={t("projectCommand.remove")}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <Trash2 className="size-3" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>

          {candidates && visibleCandidates ? (
            <div className="max-h-72 shrink-0 overflow-y-auto overscroll-contain border-t py-1">
              <div className="px-3 py-1 text-[0.7rem] font-medium text-muted-foreground">
                {candidates.length
                  ? t("projectCommand.detected", { count: candidates.length })
                  : t("projectCommand.detectedNone")}
              </div>
              {visibleCandidates.map((candidate) => {
                const saved = isCommandSaved(commands, candidate);
                return (
                  <div key={candidate.id} className="flex items-center gap-1 px-1.5">
                    <span className="min-w-0 flex-1 px-1.5 py-1">
                      <span className={cn("block truncate", saved && "text-muted-foreground")}>{candidate.label}</span>
                      <span className="block truncate font-mono text-[0.68rem] text-muted-foreground">{candidate.command}</span>
                    </span>
                    {saved ? (
                      <span
                        aria-label={t("projectCommand.added")}
                        title={t("projectCommand.added")}
                        className="flex size-6 shrink-0 items-center justify-center text-muted-foreground"
                      >
                        <Check className="size-3" aria-hidden="true" />
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => add(candidate)}
                        aria-label={t("projectCommand.add")}
                        title={t("projectCommand.add")}
                        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        <Plus className="size-3" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {error ? <p className="shrink-0 border-t px-3 py-2 text-destructive">{error}</p> : null}
          {!error && loadError ? <p className="shrink-0 border-t px-3 py-2 text-muted-foreground">{loadError}</p> : null}

          <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2">
            <span className="text-muted-foreground">{t("projectCommand.runTargetLabel")}</span>
            <Select value={runTarget} onValueChange={onRunTargetChange}>
              <SelectTrigger
                size="sm"
                aria-label={t("projectCommand.runTargetLabel")}
                title={t("projectCommand.runTargetHint")}
                className="h-7 w-[9.5rem] text-[0.72rem]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PROJECT_COMMAND_BACKGROUND}>{t("projectCommand.runTargetBackground")}</SelectItem>
                <SelectItem value={PROJECT_COMMAND_DEFAULT_TERMINAL}>{t("projectCommand.runTargetDefault")}</SelectItem>
                {runTarget !== PROJECT_COMMAND_BACKGROUND &&
                runTarget !== PROJECT_COMMAND_DEFAULT_TERMINAL &&
                !terminals.includes(runTarget) ? (
                  <SelectItem value={runTarget}>{runTarget}</SelectItem>
                ) : null}
                {terminals.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </PopoverContent>
      </Popover>

      {otherRun ? (
        <span
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[0.72rem] text-muted-foreground"
          title={otherRunsTitle}
        >
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--app-success)]" aria-hidden="true" />
          <span className="max-[900px]:hidden">
            {otherRuns.length > 1 ? t("projectCommand.runningCount", { count: otherRuns.length }) : t("projectCommand.running")}
          </span>
          {otherRun.logPath ? (
            <button
              type="button"
              onClick={() => onRevealLog(otherRun.logPath)}
              className="rounded-md px-1 underline underline-offset-2 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {t("projectCommand.viewLog")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onStopRun(otherRun.id)}
            disabled={isStoppingRun}
            aria-label={t("projectCommand.stop")}
            title={t("projectCommand.stopHint", { command: otherRun.command })}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-destructive transition-colors hover:bg-destructive/10 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
          >
            {isStoppingRun ? (
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            ) : (
              <Square className="size-2.5 fill-current" aria-hidden="true" />
            )}
            {t("projectCommand.stop")}
          </button>
        </span>
      ) : null}

      {lastRun ? (
        <span
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[0.72rem] text-muted-foreground"
          title={lastRun.logPath ?? lastRun.command}
        >
          <span className="max-[900px]:hidden">
            {isProjectCommandBackground(lastRun.launcher)
              ? t("projectCommand.backgroundStarted")
              : t("projectCommand.terminalOpened")}
          </span>
          {lastRun.logPath ? (
            <button
              type="button"
              onClick={() => onRevealLog(lastRun.logPath as string)}
              className="rounded-md px-1 underline underline-offset-2 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {t("projectCommand.viewLog")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismissRun}
            aria-label={t("projectCommand.dismissRunNotice")}
            title={t("projectCommand.dismissRunNotice")}
            className="flex size-4 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ) : null}
    </div>
  );
}