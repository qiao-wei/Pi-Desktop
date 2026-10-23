import type { PendingTurnAction } from "./useAppModel";
import type {
  CapabilityCommandArgument,
} from "../types";
import {
  type BuiltinCommandPhase,
} from "../shared/builtinCommandNotice";
import {
  buildSlashMenuItems,
  type SlashMenuItem,
} from "../features/chat/slashMenu";
import {
  postJson,
} from "../lib/api";
import { AttachmentHoverState, ComposerAttachment } from "./AttachmentHoverCard";
import { CapabilityItem } from "./CapabilitySurfaces";
import { type ViewportState } from "../features/chat/ChatThread";
import { ComposerCapability } from "./AppComposerHelpers";
import { useCallback, useMemo, useRef, useState } from "react";
import { buildComposerModelOptions, modelKey } from "../features/models/customModelForm";
import { createAttachmentHoverGate } from "../shared/attachmentHoverGate";
import { loadUiPreferences, saveUiPreferences } from "../lib/ui-preferences";
import { normalizeProjectCommandTerminal } from "../shared/projectCommandTerminal";
import { perfCount } from "../lib/perf";
import { resolveAppearance, type ThemeId } from "../themes/index.ts";

import { useCustomModels } from "../features/models/useCustomModels";
import { usePiDesktopApp } from "../features/chat/usePiDesktopApp";
import { useT } from "../i18n/react";


/**
 * 状态、ref 与基础派生值（骨架）
 *
 * `useAppModel()` 顺序切出的第 1 段（原 body 语句 1–69，175–404 行）。
 *   · 本段**之前**声明的名字：从共享 `deps` 解构（拿到的是真值本身，闭包身份不变）。
 *   · 本段**之后**才声明的名字：就地写成 `deps.X`（只在延迟执行位置出现；读的是当前 render 的值）。
 * 段内语句一字未改 —— 正确性靠这一点，也靠 `tests/appModelSplit.test.ts` 的顺序与字段校验。
 *
 * 由 `.scratch/split-hook-segments.mjs` 机械搬出。
 */
export function useAppCore(_deps: unknown) {
  const t = useT();

  // Idle-window probe: if the thread subtree commits while `render.messages`
  // stays at zero, this counter says whether the churn starts above ChatThread.
  perfCount("render.app");

  const {
    state,
    bootstrap,
    conversation,
    stats,
    modelConfig,
    capabilities,
    availableModels,
    projects,
    activeProject,
    submitTurn,
    submitEdit,
    savePersonalization,
    saveToolSettings,
    compactContext,
    createProject,
    updateProject,
    pinProject,
    reorderProjects,
    removeProject,
    revealProject,
    trustProject,
    createSession,
    updateSession,
    pinSession,
    archiveSession,
    deleteSession,
    unarchiveSession,
    deleteArchivedSession,
    deleteAllArchivedSessions,
    selectSession,
    stopTurn,
    selectComposerModel,
    refreshAvailableModels,
    updateSessionThinkingLevel,
    setCapabilityDefault,
    setCapabilityPinned,
    setSessionSkill,
    setSessionPackage,
    setSessionExtension,
    installPackage,
    removePackage,
    updatePackage,
    runPackageCommand,
    loadPackageCommandArguments,
    runBuiltinCommand,
    deleteSkill,
    importSkill,
    saveMcpServer,
    removeMcpServer,
    inspectMcpServer,
    readMcpServerDetail,
    parseMcpImport,
    respondExtensionUi,
    dismissError,
    reportError,
    dismissCompactionNotice,
    replaceBootstrap,
    setDraft,
  } = usePiDesktopApp();

  // 输入框旁的模型列表和设置页读同一份自定义模型，设置页保存后这里跟着刷新。
  const customModels = useCustomModels();

  /**
   * One removal path for every capability surface: the page cards, the page's
   * detail sheet and the conversation context panel all call this handler.
   */
  const deleteCapabilityItem = useCallback(
    async (item: CapabilityItem) => {
      if (item.kind === "skill") {
        await deleteSkill(item.id);
      } else if (item.kind === "package") {
        await removePackage(item.source, item.scope);
      } else if (item.kind === "mcp") {
        await removeMcpServer(item.id);
      }
    },
    [deleteSkill, removePackage, removeMcpServer],
  );

  const [showPanel, setShowPanel] = useState(false);

  const [showUsagePopover, setShowUsagePopover] = useState(false);

  const [showExtensionStatus, setShowExtensionStatus] = useState(false);

  const [showLeftPanel, setShowLeftPanel] = useState(false);

  const [showSettings, setShowSettings] = useState(false);

  const [theme, setTheme] = useState<"light" | "dark">(() => loadUiPreferences().theme);

  // 配色主题（目录自动发现）：与浅色/深色正交，决定的是同一明暗下用哪套 token。
  // 持久化里可能是已删主题的残留 id，所以先过一遍 `resolveAppearance()`（未知 → 默认）。
  const [appearance, setAppearance] = useState<ThemeId>(() =>
    resolveAppearance(loadUiPreferences().appearance),
  );

  const [activeMainView, setActiveMainView] = useState<"chat" | "capabilities">("chat");

  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  // 一次发送失败后，重新打开的编辑框要用它把用户打的字填回去。
  const [failedEditText, setFailedEditText] = useState<{ messageId: string; text: string } | null>(null);

  const [pendingTurnAction, setPendingTurnAction] = useState<PendingTurnAction | null>(null);

  const [showCapabilityPicker, setShowCapabilityPicker] = useState(false);

  const [slashQuery, setSlashQuery] = useState("");

  const [slashHighlight, setSlashHighlight] = useState(0);

  /**
   * 用户是否真的“选”过参数菜单里的某一项（↑↓ 移动或鼠标点击）。
   * 参数默认不一定必选：菜单刚弹出、用户没动过时，回车应该直接提交命令；
   * 只有动过选择后，回车才表示“选这一项”。
   */
  const [slashArgumentArmed, setSlashArgumentArmed] = useState(false);

  /** 已选中的包命令：`/name` 已在编辑器里，正在给它补参数（TUI 参数补全）。 */
  const [slashCommandContext, setSlashCommandContext] = useState<{ packageId: string; name: string; prefix: string } | null>(null);

  const [slashArgumentItems, setSlashArgumentItems] = useState<CapabilityCommandArgument[]>([]);

  const [customUiCancelVersion, setCustomUiCancelVersion] = useState(0);

  const [leftSidebarWidth, setLeftSidebarWidth] = useState(() => loadUiPreferences().leftSidebarWidth);

  const [rightPanelWidth, setRightPanelWidth] = useState(() => loadUiPreferences().rightPanelWidth);

  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(() => loadUiPreferences().leftSidebarCollapsed);

  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(() => loadUiPreferences().rightPanelCollapsed);

  /** 全局搜索面板（⌘K / 标题栏搜索图标）。 */
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);

  type InTaskSearchState = { open: boolean; query: string; activeIndex: number };

  const [inTaskSearch, setInTaskSearch] = useState<InTaskSearchState>({ open: false, query: "", activeIndex: 0 });

  const [inTaskMatchCount, setInTaskMatchCount] = useState(0);

  // 输入框上方扩展 widget 区是否折叠（右上角 chevron）。缺省展开 = 保持原来的常驻显示。
  const [extensionWidgetsCollapsed, setExtensionWidgetsCollapsed] = useState(
    () => loadUiPreferences().extensionWidgetsCollapsed ?? false,
  );

  const toggleExtensionWidgets = useCallback(() => {
    setExtensionWidgetsCollapsed((collapsed) => {
      const next = !collapsed;
      saveUiPreferences({ extensionWidgetsCollapsed: next });
      return next;
    });
  }, []);

  // 「运行命令」跑在哪里：后台静默（默认）/ 系统默认终端 / 某个终端 app。跟会话头部的
  // 「运行 + 命令下拉」走，存在 UI 偏好里。
  const [projectCommandTerminal, setProjectCommandTerminal] = useState(() =>
    normalizeProjectCommandTerminal(loadUiPreferences().projectCommandTerminal),
  );

  const handleProjectCommandTerminalChange = useCallback((target: string) => {
    const next = normalizeProjectCommandTerminal(target);
    setProjectCommandTerminal(next);
    saveUiPreferences({ projectCommandTerminal: next });
  }, []);

  // 「查看日志」：后台运行的输出文件，用系统默认程序打开。
  const revealRunLog = useCallback(async (logPath: string) => {
    try {
      await postJson("/api/projects/commands/reveal-log", { logPath });
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    }
  }, [reportError]);

  /** 拖动中的手柄：pointer capture 后指针拖离手柄会让 :hover 失效，得显式记着。 */
  const [resizingSide, setResizingSide] = useState<"left" | "right" | null>(null);

  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);

  const [composerText, setComposerText] = useState("");

  /** 编辑器里挂着的技能/扩展徽标数量。只挂徽标不打字也是一次合法提交，发送按钮要跟着亮。 */
  const [composerCapabilityCount, setComposerCapabilityCount] = useState(0);

  const [isDraggingFiles, setIsDraggingFiles] = useState(false);

  const [isPreparingAttachments, setIsPreparingAttachments] = useState(false);

  const [composerError, setComposerError] = useState("");

  // 内置命令不往对话里写东西（见 shared/builtinCommandNotice.ts），用一条状态带告知进行中/已完成。
  const [builtinNotice, setBuiltinNotice] = useState<{ tone: BuiltinCommandPhase; text: string } | null>(null);

  const builtinNoticeTimerRef = useRef<number | null>(null);

  const [attachmentHover, setAttachmentHover] = useState<AttachmentHoverState | null>(null);

  const usagePopoverRef = useRef<HTMLDivElement | null>(null);

  const extensionStatusRef = useRef<HTMLDivElement | null>(null);

  const composerEditorRef = useRef<HTMLDivElement | null>(null);

  const composerSelectionRef = useRef<Range | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const attachmentPreviewUrlsRef = useRef(new Map<string, string>());

  const pendingPreviewUrlsRef = useRef(new Set<string>());

  const pendingCapabilitySyncRef = useRef<Promise<boolean> | null>(null);

  const composerAttachmentMapRef = useRef(new Map<string, ComposerAttachment>());

  /** 粘贴/拖放插入的徽章不要因为指针正好停在插入点就弹预览，等指针真动了再判断。 */
  const attachmentHoverGateRef = useRef(createAttachmentHoverGate());

  const composerCapabilityMapRef = useRef(new Map<string, ComposerCapability>());

  const dragDepthRef = useRef(0);

  const scrollStateRef = useRef(new Map<string, ViewportState>());

  const panelResizeRef = useRef<{ side: "left" | "right"; startX: number; startWidth: number } | null>(null);

  // 输入框旁的模型列表与会话当前模型对齐：会话已经选了就用它，还没选过（新任务默认）
  // 就落在列表第一项 —— 下拉框显示的就是实际会用的。
  const composerModelOptions = useMemo(
    () =>
      buildComposerModelOptions({
        availableModels,
        customModels: customModels.entries,
        currentProvider: modelConfig.provider,
        currentModel: modelConfig.model,
      }),
    [availableModels, customModels.entries, modelConfig.provider, modelConfig.model],
  );

  const selectedComposerModel = useMemo(
    () =>
      composerModelOptions.find((option) => option.key === modelKey(modelConfig.provider, modelConfig.model)) ??
      // 会话还没定模型：取第一个“鉴权已就绪”的，跟服务端 `defaultComposerModel()` 同一口径，
      // 否则会出现“下拉框选中一个用不了的模型、实际跑的却是另一个”。
      composerModelOptions.find((option) => option.available) ??
      composerModelOptions[0],
    [composerModelOptions, modelConfig.provider, modelConfig.model],
  );

  const selectedProvider = selectedComposerModel?.provider ?? "";

  const selectedModel = selectedComposerModel?.model ?? "";

  // 当前模型真实支持的思考档位（桥复用 pi 的 getSupportedThinkingLevels 按模型算好）；
  // 拿不到时菜单兜底固定列表。
  const activeModelThinkingLevels = availableModels.find(
    (candidate) => candidate.provider === selectedProvider && candidate.model === selectedModel,
  )?.supportedThinkingLevels;

  // 模型不支持思考（档位表只有 off，同 pi 的 supportsThinking：!model.reasoning）时
  // 整个思考选择器不渲染；元数据缺失时兜底显示（与旧行为一致）。
  const modelSupportsThinking = activeModelThinkingLevels
    ? activeModelThinkingLevels.some((level) => level !== "off")
    : true;

  // "/" 自动补全：技能在前、包指令在后，查询词取斜杠之后的文本。
  // 一旦进入"命令参数"态，菜单换成该命令的参数候选（TUI 的 getArgumentCompletions）。
  const slashItems = useMemo<SlashMenuItem[]>(() => {
    if (slashCommandContext) {
      return slashArgumentItems.map((item) => ({
        kind: "argument" as const,
        value: item.value,
        label: item.label,
        ...(item.description ? { description: item.description } : {}),
      }));
    }
    return buildSlashMenuItems(capabilities, slashQuery);
  }, [capabilities, slashArgumentItems, slashCommandContext, slashQuery]);

  const activeSlashIndex = Math.min(slashHighlight, Math.max(0, slashItems.length - 1));

  // 参数菜单未“选中”前不显示任何高亮：回车是提交，不是选第一项。
  const visibleSlashHighlight = slashItems[0]?.kind === "argument" && !slashArgumentArmed ? -1 : activeSlashIndex;

  return { activeMainView, activeModelThinkingLevels, activeProject, activeSlashIndex, appearance, archiveSession, attachmentHover, attachmentHoverGateRef, attachmentPreviewUrlsRef, attachments, availableModels, bootstrap, builtinNotice, builtinNoticeTimerRef, capabilities, compactContext, composerAttachmentMapRef, composerCapabilityCount, composerCapabilityMapRef, composerEditorRef, composerError, composerModelOptions, composerSelectionRef, composerText, conversation, createProject, createSession, customModels, customUiCancelVersion, deleteAllArchivedSessions, deleteArchivedSession, deleteCapabilityItem, deleteSession, deleteSkill, dismissCompactionNotice, dismissError, dragDepthRef, editingMessageId, extensionStatusRef, extensionWidgetsCollapsed, failedEditText, fileInputRef, globalSearchOpen, handleProjectCommandTerminalChange, importSkill, inTaskMatchCount, inTaskSearch, inspectMcpServer, installPackage, isDraggingFiles, isPreparingAttachments, leftSidebarCollapsed, leftSidebarWidth, loadPackageCommandArguments, modelConfig, modelSupportsThinking, panelResizeRef, parseMcpImport, pendingCapabilitySyncRef, pendingPreviewUrlsRef, pendingTurnAction, pinProject, pinSession, projectCommandTerminal, projects, readMcpServerDetail, refreshAvailableModels, removeMcpServer, removePackage, removeProject, reorderProjects, replaceBootstrap, reportError, resizingSide, respondExtensionUi, revealProject, revealRunLog, rightPanelCollapsed, rightPanelWidth, runBuiltinCommand, runPackageCommand, saveMcpServer, savePersonalization, saveToolSettings, scrollStateRef, selectComposerModel, selectSession, selectedComposerModel, selectedModel, selectedProvider, setActiveMainView, setAppearance, setAttachmentHover, setAttachments, setBuiltinNotice, setCapabilityDefault, setCapabilityPinned, setComposerCapabilityCount, setComposerError, setComposerText, setCustomUiCancelVersion, setDraft, setEditingMessageId, setExtensionWidgetsCollapsed, setFailedEditText, setGlobalSearchOpen, setInTaskMatchCount, setInTaskSearch, setIsDraggingFiles, setIsPreparingAttachments, setLeftSidebarCollapsed, setLeftSidebarWidth, setPendingTurnAction, setProjectCommandTerminal, setResizingSide, setRightPanelCollapsed, setRightPanelWidth, setSessionExtension, setSessionPackage, setSessionSkill, setShowCapabilityPicker, setShowExtensionStatus, setShowLeftPanel, setShowPanel, setShowSettings, setShowUsagePopover, setSlashArgumentArmed, setSlashArgumentItems, setSlashCommandContext, setSlashHighlight, setSlashQuery, setTheme, showCapabilityPicker, showExtensionStatus, showLeftPanel, showPanel, showSettings, showUsagePopover, slashArgumentArmed, slashArgumentItems, slashCommandContext, slashHighlight, slashItems, slashQuery, state, stats, stopTurn, submitEdit, submitTurn, t, theme, toggleExtensionWidgets, trustProject, unarchiveSession, updatePackage, updateProject, updateSession, updateSessionThinkingLevel, usagePopoverRef, visibleSlashHighlight };
}
