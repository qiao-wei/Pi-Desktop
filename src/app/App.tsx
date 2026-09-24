import {
  AlertTriangle,
  Archive,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardCopy,
  DatabaseZap,
  ExternalLink,
  FileText,
  Clock3,
  Folder,
  FolderOpen,
  Mic,
  Moon,
  Minus,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pin,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  Square as SquareIcon,
  Terminal,
  Trash2,
  Wrench,
  Loader2,
  Sun,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  SyntheticEvent as ReactSyntheticEvent,
  ReactNode,
  CSSProperties,
} from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchJson,
  postJson,
  reportDiagnostic,
  type ExtensionWebUiAction,
  type ExtensionWebUiField,
  type ExtensionUiRequest,
  type ExtensionUiResponse,
  type PromptAttachmentInput,
  type PromptMessagePartInput,
} from "../lib/api";
import { MarkdownContent } from "../lib/markdown";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { canOpenTarget, openTarget } from "../lib/open-target";
import { createId } from "../lib/id";
import { perfCount } from "../lib/perf";
import { syncShellAppearance } from "../lib/shell-appearance";
import { loadUiPreferences, saveUiPreferences, type UiAppearance } from "../lib/ui-preferences";
import { findProjectByCwd } from "../shared/projectPaths";
import { collectDroppedItems, pickDroppedProjectFolder, supportsDroppedFolderPaths } from "../shared/droppedProjectFolder";
import { compactActionState, compactionNotice } from "../shared/compactionNotice";
import { t, setLocale } from "../i18n/index.ts";
import { useT, useLocale } from "../i18n/react";
import { resolveProjectSidebarLock } from "../shared/projectSidebarLock";
import { filterPackageCommands } from "../shared/capabilityCommands";
import { expandProjectForNewSession } from "../shared/sidebarProjectExpansion";
import { platformRevealFolderLabelKey } from "../shared/revealFolderLabel";
import { cachePercent, formatCacheDetail, formatTokens, percentOf } from "./usageFormat";
import { sidebarHoverActionClass } from "../shared/sidebarActionVisibility";
import { createAttachmentHoverGate } from "../shared/attachmentHoverGate";
import {
  SidebarArchiveIcon,
  SidebarFolderIcon,
  SidebarFolderOpenIcon,
  SidebarMessageIcon,
  SidebarMonitorIcon,
  SidebarNewSessionIcon,
  SidebarPinIcon,
} from "../components/sidebarIcons";
import {
  SIDEBAR_PROJECT_CARD_HEIGHT,
  SIDEBAR_PROJECT_CARD_WIDTH,
  SIDEBAR_SESSION_CARD_HEIGHT,
  SIDEBAR_SESSION_CARD_WIDTH,
  formatSidebarRelativeTime,
  formatSidebarSessionCount,
  placeSidebarHoverCard,
  pointerKeepsSidebarCardOpen,
  sidebarSessionPreview,
} from "../shared/sidebarHoverPreview";
import { AutoHideScroll } from "../components/AutoHideScroll";
import { ExtensionCustomUiPanel } from "../components/ExtensionCustomUiPanel";
import { stripTerminalSequences } from "../shared/terminalText.ts";
import { GitStatusBadge } from "../components/GitStatusBadge";
import {
  CAPABILITY_TABS,
  SKILL_SOURCE_CATEGORIES,
  SKILL_SOURCE_CATEGORY_LABEL_KEYS,
  canDeleteCapability,
  capabilitySourceLabel,
  matchesCapabilityQuery,
  matchesSkillCategory,
  scopedCapabilityItems,
  type CapabilityScopeTab,
  type SkillSourceCategory,
} from "../shared/capabilityScope";
import { usePiDesktopApp } from "../features/chat/usePiDesktopApp";
import { useProjectGit } from "../features/chat/useProjectGit";
import { combineQueuedComposerText, mergeQueuedWithCurrentText } from "../features/chat/queuedComposerText";
import { ChatThread, type ViewportState } from "../features/chat/ChatThread";
import { sidebarStreamingSessionPaths } from "../features/chat/sidebarStreaming";
import type { MessageEditPayload } from "../features/chat/MessageEditBox";
import { toAttachmentInputs } from "../features/chat/editorParts";
import { badgeBeforeCaret, isMarkerOnlyTextNode, stepOverCaretMarker as stepSelectionOverCaretMarker } from "../features/chat/caretMarkerStep";
import { ComposerModelSelect } from "../features/models/ComposerModelSelect";
import { CustomModelsSettings } from "../features/models/CustomModelsSettings";
import { ArchivedChatsSettings } from "../features/settings/ArchivedChatsSettings";
import { NotificationSettings } from "../features/settings/NotificationSettings";
import { buildComposerModelOptions, modelKey } from "../features/models/customModelForm";
import { useCustomModels } from "../features/models/useCustomModels";
import type { CustomModelsController } from "../features/models/useCustomModels";
import { chatScrollToBottomBus } from "../shared/chatScrollBus";
import { sessionControlsDisabled } from "../shared/sessionBusy";
import {
  buildSlashMenuItems,
  findSlashStart,
  matchSlashTrigger,
  moveHighlight,
  readTriggerText,
  type SlashMenuItem,
} from "../features/chat/slashMenu";
import {
  COMPOSER_BLOCK_TAGS,
  escapeHtml,
  htmlToSanitizedMarkup,
} from "../features/chat/pasteSanitize";
import {
  applyAttachmentBadgeAttributes,
  applyCapabilityBadgeAttributes,
  replacePasteBadgePlaceholders,
  type ClipboardBadge,
} from "../features/chat/badgeClipboard";
import { markThreadSwitch } from "../components/assistant-ui/elements/thread.aui";
import type {
  CapabilitiesState,
  ArchivedSessionSummary,
  CapabilityCommand,
  CapabilityKind,
  CapabilityPackage,
  CapabilityPackageResourceDetails,
  CapabilityPackageResourceEntry,
  CapabilityPackageResourceType,
  CapabilityPackageFilePreview,
  CapabilityExtension,
  CapabilitySkill,
  ChatAttachment,
  ConversationStats,
  CreateProjectResult,
  PersonalizationSettings,
  ProjectSummary,
  SkillSummary,
  ThinkingLevel,
} from "../types";
import { CAPABILITY_PACKAGE_RESOURCE_TYPES } from "../types";

const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const skillDescriptionPreviewLength = 120;
const maxAttachmentCount = 10;
const maxAttachmentSize = 25 * 1024 * 1024;
const maxAttachmentTotalSize = 50 * 1024 * 1024;
const initialProjectSessionLimit = 5;
const additionalProjectSessionLimit = 10;
const projectDropBoundarySize = 12;
const composerCaretMarker = "\u200b";
const statusBannerStyles =
  "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200";
const statusBannerButtonStyles =
  "text-amber-900 hover:bg-amber-100 hover:text-amber-900 dark:text-amber-200 dark:hover:bg-amber-900/40";
const personalizationStyleOptions = [
  { value: "default", labelKey: "settings.style.default.label", descKey: "settings.style.default.desc" },
  { value: "professional", labelKey: "settings.style.professional.label", descKey: "settings.style.professional.desc" },
  { value: "friendly", labelKey: "settings.style.friendly.label", descKey: "settings.style.friendly.desc" },
  { value: "concise", labelKey: "settings.style.concise.label", descKey: "settings.style.concise.desc" },
  { value: "imaginative", labelKey: "settings.style.imaginative.label", descKey: "settings.style.imaginative.desc" },
  { value: "efficient", labelKey: "settings.style.efficient.label", descKey: "settings.style.efficient.desc" },
  { value: "sharp", labelKey: "settings.style.sharp.label", descKey: "settings.style.sharp.desc" },
  { value: "socratic", labelKey: "settings.style.socratic.label", descKey: "settings.style.socratic.desc" },
] as const;
/** Extension-panel presentation; the values mirror `ExtensionUiMode` in `src/types` and the server list. */
const personalizationExtensionUiOptions = [
  { value: "tui", labelKey: "settings.extensionUi.tui.label", descKey: "settings.extensionUi.tui.desc" },
  { value: "webui", labelKey: "settings.extensionUi.webui.label", descKey: "settings.extensionUi.webui.desc" },
] as const;
/**
 * 界面配色主题。与浅色/深色正交：每个主题都有两套完整 token（见 tailwind.css），
 * 标题栏的太阳/月亮按钮仍然管明暗。
 */
const appearanceOptions = [
  { value: "default", labelKey: "settings.appearance.default.label", descKey: "settings.appearance.default.desc" },
  { value: "codex", labelKey: "settings.appearance.codex.label", descKey: "settings.appearance.codex.desc" },
] as const satisfies readonly { value: UiAppearance; labelKey: string; descKey: string }[];

interface ComposerAttachment extends ChatAttachment {
  /** Absent for badges pasted from a sent message; the server reuses `sourcePath`. */
  file?: File;
}

type ComposerCapability = Pick<CapabilitySkill, "id" | "kind" | "name" | "description"> & {
  active?: boolean;
  instanceId?: string;
};

type ComposerPart =
  | { kind: "text"; text: string }
  | { kind: "attachment"; attachment: ComposerAttachment }
  | { kind: "capability"; capability: ComposerCapability };

/** Editing or regenerating a middle turn truncates the turns after it, so both confirm first. */
type PendingTurnAction = { kind: "edit" | "refresh"; messageId: string };

interface AttachmentHoverState {
  attachment: ChatAttachment;
  rect: DOMRect;
}

function isDialogExtensionUiRequest(
  request: ExtensionUiRequest,
): request is Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }> {
  return request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor";
}

function isCustomExtensionUiRequest(
  request: ExtensionUiRequest,
): request is Extract<ExtensionUiRequest, { method: "custom" }> {
  return request.method === "custom";
}

function isWebExtensionUiRequest(
  request: ExtensionUiRequest,
): request is Extract<ExtensionUiRequest, { method: "web" }> {
  return request.method === "web";
}

export function App() {
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
    deleteSkill,
    importSkill,
    respondExtensionUi,
    dismissError,
    reportError,
    dismissCompactionNotice,
  } = usePiDesktopApp();

  // 会话头部右侧的 git 徽标：只读、可失败、非轮询（切项目 / 一轮结束 / 窗口重新聚焦时刷新）。
  const projectGit = useProjectGit({
    projectId: bootstrap.activeProjectId,
    isStreaming: state.isStreaming,
    onError: reportError,
  });

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
      }
    },
    [deleteSkill, removePackage],
  );

  const [showPanel, setShowPanel] = useState(false);
  const [showUsagePopover, setShowUsagePopover] = useState(false);
  const [showLeftPanel, setShowLeftPanel] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => loadUiPreferences().theme);
  // 配色主题（默认 / Codex）：与浅色/深色正交，决定的是同一明暗下用哪套 token。
  const [appearance, setAppearance] = useState<UiAppearance>(() => loadUiPreferences().appearance);
  const [activeMainView, setActiveMainView] = useState<"chat" | "capabilities">("chat");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  // 一次发送失败后，重新打开的编辑框要用它把用户打的字填回去。
  const [failedEditText, setFailedEditText] = useState<{ messageId: string; text: string } | null>(null);
  const [pendingTurnAction, setPendingTurnAction] = useState<PendingTurnAction | null>(null);
  const [showCapabilityPicker, setShowCapabilityPicker] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [customUiCancelVersion, setCustomUiCancelVersion] = useState(0);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(() => loadUiPreferences().leftSidebarWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState(() => loadUiPreferences().rightPanelWidth);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(() => loadUiPreferences().leftSidebarCollapsed);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(() => loadUiPreferences().rightPanelCollapsed);
  /** 拖动中的手柄：pointer capture 后指针拖离手柄会让 :hover 失效，得显式记着。 */
  const [resizingSide, setResizingSide] = useState<"left" | "right" | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [composerText, setComposerText] = useState("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isPreparingAttachments, setIsPreparingAttachments] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [attachmentHover, setAttachmentHover] = useState<AttachmentHoverState | null>(null);
  const usagePopoverRef = useRef<HTMLDivElement | null>(null);
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
  const slashItems = useMemo(
    () => buildSlashMenuItems(capabilities, slashQuery),
    [capabilities, slashQuery],
  );
  const activeSlashIndex = Math.min(slashHighlight, Math.max(0, slashItems.length - 1));
  const contextPercent = normalizePercent(stats.contextPercent);
  const handleComposerModelChange = useCallback(
    (provider: string, model: string) => {
      if (!provider || !model) {
        return;
      }
      if (provider === selectedProvider && model === selectedModel) {
        return;
      }
      setComposerError("");
      void selectComposerModel(provider, model);
    },
    [selectComposerModel, selectedProvider, selectedModel],
  );
  // 会话还没定下模型时（首次启动、也没记住过任何选择），把下拉框显示的那一项真的用到会话上，
  // 别让“看到的是第一个”和“实际用的不是”分叉。每个 key 只试一次，失败交给错误条说。
  const autoAppliedModelRef = useRef("");
  useEffect(() => {
    if (modelConfig.provider && modelConfig.model) {
      autoAppliedModelRef.current = "";
      return;
    }
    if (!selectedProvider || !selectedModel || state.isBootstrapping || state.isStreaming) {
      return;
    }
    // 一个鉴权都没就绪的模型不要自动应用，只会多一条报错横幅。
    if (!selectedComposerModel?.available) {
      return;
    }
    const key = modelKey(selectedProvider, selectedModel);
    if (autoAppliedModelRef.current === key) {
      return;
    }
    autoAppliedModelRef.current = key;
    void selectComposerModel(selectedProvider, selectedModel);
  }, [
    modelConfig.provider,
    modelConfig.model,
    selectedComposerModel?.available,
    selectedProvider,
    selectedModel,
    state.isBootstrapping,
    state.isStreaming,
    selectComposerModel,
  ]);
  const canQueueFollowUp = state.isStreaming && !state.isStopping && Boolean(selectedProvider && selectedModel);
  const hasConfiguredModel = Boolean(modelConfig.provider && modelConfig.model && modelConfig.apiKeyConfigured);
  const canSubmitPrompt = !state.isStopping && (bootstrap.canPrompt || canQueueFollowUp || hasConfiguredModel);
  // 思考 / 模型这些「改动会打到 pi 运行态」的控件，禁用口径必须和服务端 isSessionBusy()
  // 一致：光看 isStreaming/isCompacting 会在「点了停止仍在 abort」与「pi 队列里还压着
  // 插话/跟进」时把下拉框留成可点的，点下去必被服务端拒绝。
  const composerSessionBusy = sessionControlsDisabled({
    isStreaming: state.isStreaming,
    isCompacting: state.isCompacting,
    isStopping: state.isStopping,
    isBootstrapping: state.isBootstrapping,
    pendingQueues: bootstrap.pendingQueues,
  });
  const visibleSessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile ?? "local-bootstrap";
  // 本窗口自己拥有的运行不会写进 bootstrap.streamingSessionPaths（那会启动 watchdog），
  // 所以侧栏的时钟要把本地 isStreaming 合进去，否则刚提交的会话整轮都不显示时钟。
  const streamingSessionPaths = useMemo(
    () => sidebarStreamingSessionPaths(bootstrap.streamingSessionPaths, visibleSessionPath, state.isStreaming),
    [bootstrap.streamingSessionPaths, visibleSessionPath, state.isStreaming],
  );
  const compactionNoticeView = compactionNotice({
    isCompacting: state.isCompacting,
    compactionError:
      state.compactionError?.sessionPath === visibleSessionPath ? state.compactionError.message : null,
  });
  const activeExtensionUiRequest = state.extensionUiRequests.find(isDialogExtensionUiRequest) ?? null;
  const activeWebExtensionUiRequest = state.extensionUiRequests.find(isWebExtensionUiRequest) ?? null;
  const activeCustomExtensionUiRequest = state.extensionUiRequests.find(isCustomExtensionUiRequest) ?? null;
  const extensionAboveWidgets = Object.entries(state.extensionUiWidgets).filter(([, widget]) => widget.placement === "aboveEditor");
  const extensionBelowWidgets = Object.entries(state.extensionUiWidgets).filter(([, widget]) => widget.placement === "belowEditor");

  function getScrollState(sessionPath: string) {
    const existing = scrollStateRef.current.get(sessionPath);
    if (existing) {
      return existing;
    }

    const next = { scrollTop: 0, shouldFollow: true };
    scrollStateRef.current.set(sessionPath, next);
    return next;
  }

  /**
   * ChatThread reads viewport-state records as immutable snapshots, so flipping
   * `shouldFollow` on the stored object in place is not enough: the hook may
   * still be holding the previous record. Always publish a new object.
   */
  function followLatestScroll(sessionPath: string) {
    const existing = scrollStateRef.current.get(sessionPath);
    scrollStateRef.current.set(sessionPath, {
      scrollTop: existing?.scrollTop ?? 0,
      shouldFollow: true,
    });
    // ... and the record alone is still not enough *during* a visit: the thread's
    // viewport owner read it on entry and only re-reads it on a switch. Ask the
    // live owner to pin, so submitting while scrolled up lands on the reply.
    chatScrollToBottomBus.request(sessionPath, "submit");
  }

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    // 首帧之前 index.html 的引导脚本已经贴过一次（防闪）；这里是运行期的唯一权威。
    document.documentElement.dataset.appearance = appearance;
    // macOS 的原生侧栏材质只认窗口外观（NSAppearance），不认 `<html class="dark">`；
    // 不同步的话系统浅色 + 界面深色会得到一块发白的玻璃（见 lib/shell-appearance.ts）。
    syncShellAppearance(theme);
    saveUiPreferences({
      theme,
      appearance,
      leftSidebarWidth,
      rightPanelWidth,
      leftSidebarCollapsed,
      rightPanelCollapsed,
    });
  }, [appearance, leftSidebarCollapsed, leftSidebarWidth, rightPanelCollapsed, rightPanelWidth, theme]);

  useEffect(() => () => {
    for (const url of attachmentPreviewUrlsRef.current.values()) {
      URL.revokeObjectURL(url);
    }
  }, []);

  // 扩展可能用 `theme.fg(...)` 涂过标题；window title / tooltip 只展示纯文本。
  useEffect(() => {
    document.title = stripTerminalSequences(state.extensionTitle ?? "").trim() || `Pi Desktop - ${conversation.title}`;
  }, [conversation.title, state.extensionTitle]);

  useEffect(() => {
    if (!showUsagePopover) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!usagePopoverRef.current?.contains(event.target as Node)) {
        setShowUsagePopover(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowUsagePopover(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showUsagePopover]);

  useEffect(() => {
    const editor = composerEditorRef.current;
    if (state.extensionEditorText === undefined || !editor) {
      return;
    }

    composerAttachmentMapRef.current.clear();
    composerCapabilityMapRef.current.clear();
    setAttachments([]);
    editor.textContent = state.extensionEditorText;
    composerSelectionRef.current = null;
    syncComposerState();
    editor.focus({ preventScroll: true });
  }, [state.extensionEditorText]);

  useEffect(() => {
    const conversationPreviewUrls = new Set(
      conversation.messages.flatMap((message) => message.attachments?.map((attachment) => attachment.previewUrl) ?? []),
    );
    for (const url of pendingPreviewUrlsRef.current) {
      if (conversationPreviewUrls.has(url)) {
        pendingPreviewUrlsRef.current.delete(url);
      }
    }

    const referencedUrls = new Set(
      [
        ...attachments.map((attachment) => attachment.previewUrl),
        ...conversation.messages.flatMap((message) => message.attachments?.map((attachment) => attachment.previewUrl) ?? []),
        ...pendingPreviewUrlsRef.current,
      ].filter((url): url is string => Boolean(url)),
    );

    for (const [id, url] of attachmentPreviewUrlsRef.current.entries()) {
      if (!referencedUrls.has(url)) {
        URL.revokeObjectURL(url);
        attachmentPreviewUrlsRef.current.delete(id);
      }
    }
  }, [attachments, conversation.messages]);


  useEffect(() => {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    const currentEditor = editor;

    function handleSelectionChange() {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) {
        return;
      }

      const range = selection.getRangeAt(0);
      if (currentEditor.contains(range.startContainer) && currentEditor.contains(range.endContainer)) {
        composerSelectionRef.current = range.cloneRange();
      }
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  /** 用户真的碰了 composer（点击 / 输入）→ 绿色聚焦框该回来了。 */
  function restoreComposerFocusRing(event: ReactSyntheticEvent<HTMLElement>) {
    event.currentTarget.removeAttribute("data-focus-quiet");
  }

  /**
   * 程序化聚焦 composer（新建 / 切换会话之后）不该亮起那个绿色聚焦框：用户还没碰过
   * 键鼠，绿框看起来像「选中了但没输入」。
   * 用 DOM 属性而不是 state 传这个「暂时压住」信号，是为了能在 focus() 之前同步生效，
   * 否则先 focus 后 re-render 会闪一帧绿框；用户一按下/一输入，restoreComposerFocusRing
   * 就把属性摘掉，绿框恢复。
   */
  function focusComposerQuietly() {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }
    editor.closest<HTMLElement>(".composer-surface")?.setAttribute("data-focus-quiet", "true");
    editor.focus({ preventScroll: true });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!(await waitForPendingCapabilitySync())) {
      return;
    }
    const orderedParts = readComposerParts(composerEditorRef.current);
    const orderedAttachments = orderedParts
      .filter((part): part is { kind: "attachment"; attachment: ComposerAttachment } => part.kind === "attachment")
      .map((part) => part.attachment);
    const orderedText = orderedParts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join("");
    const messageParts = toPromptMessageParts(orderedParts);

    if ((!orderedText.trim() && orderedAttachments.length === 0) || isPreparingAttachments) {
      return;
    }
    if (state.isStopping) {
      setComposerError(t("composer.error.stopping"));
      return;
    }
    if (!canSubmitPrompt) {
      if (!modelConfig.provider || !modelConfig.model) {
        setComposerError(t("composer.error.noModel"));
      } else if (!modelConfig.apiKeyConfigured) {
        setComposerError(t("composer.error.noApiKey", { provider: modelConfig.provider }));
      } else {
        setComposerError(t("composer.error.notReady"));
      }
      return;
    }

    const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
    if (!sessionPath) {
      setComposerError(t("composer.error.noSession"));
      return;
    }
    if (state.isBootstrapping) {
      setComposerError(t("composer.error.loading"));
      return;
    }
    followLatestScroll(visibleSessionPath);
    setComposerError("");
    setIsPreparingAttachments(true);
    try {
      const payload = await Promise.all(orderedAttachments.map(readAttachment));
      const submitPromise = submitTurn(orderedText, payload, messageParts);
      const preservedPreviewUrls = new Set(
        orderedAttachments.map((attachment) => attachment.previewUrl).filter((url): url is string => Boolean(url)),
      );
      preservedPreviewUrls.forEach((url) => pendingPreviewUrlsRef.current.add(url));
      clearComposer(preservedPreviewUrls);
      void submitPromise
        .then((submitted) => {
          if (!submitted) {
            preservedPreviewUrls.forEach((url) => pendingPreviewUrlsRef.current.delete(url));
            const editor = composerEditorRef.current;
            if (!orderedAttachments.length && orderedText.trim() && editor && !editor.textContent?.trim()) {
              editor.textContent = orderedText;
              setComposerText(orderedText);
            }
            setComposerError(t("composer.error.submitFailed"));
          }
        })
        .catch((error) => {
          preservedPreviewUrls.forEach((url) => pendingPreviewUrlsRef.current.delete(url));
          setComposerError(error instanceof Error ? error.message : String(error));
        });
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPreparingAttachments(false);
    }
  }

  function addFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList);
    if (!incoming.length) {
      return;
    }

    const availableSlots = Math.max(0, maxAttachmentCount - attachments.length);
    const selected = incoming.slice(0, availableSlots);
    const existingSize = attachments.reduce((total, attachment) => total + attachment.size, 0);
    const next: ComposerAttachment[] = [];
    let totalSize = existingSize;
    let errorMessage = incoming.length > availableSlots ? t("composer.error.tooManyAttachments", { count: maxAttachmentCount }) : "";

    for (const file of selected) {
      if (file.size > maxAttachmentSize) {
        errorMessage = t("composer.error.attachmentTooLarge", { name: file.name, limit: maxAttachmentSize / 1024 / 1024 });
        continue;
      }
      if (totalSize + file.size > maxAttachmentTotalSize) {
        errorMessage = t("composer.error.attachmentsTooLargeTotal", { limit: maxAttachmentTotalSize / 1024 / 1024 });
        break;
      }

      const isImage = file.type.startsWith("image/");
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      const id = createAttachmentId();
      next.push({
        id,
        name: file.name || (isImage ? "Screenshot.png" : "Untitled file"),
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind: isImage ? "image" : "file",
        previewUrl,
        file,
      });
      totalSize += file.size;
    }

    if (next.length) {
      insertAttachmentsAtCursor(next);
    }
    setComposerError(errorMessage);
  }

  /**
   * 删除 徽标时连同它后面的零宽光标标记一起收掉。
   * 不清理的话会留下一个看不见的 \u200b：下一次 Backspace 先把它删掉（还什么都不动），
   * 看起来就像「要先删一个空白才能删徽标」。附件与技能走同一条路径。
   */
  function removeBadgeNode(node: Element | null) {
    if (!node) {
      return;
    }
    const nextSibling = node.nextSibling;
    node.parentNode?.removeChild(node);
    removeLeadingCaretMarker(nextSibling);
  }

  function removeAttachment(id: string) {
    // 徽章被删时鼠标仍悬在它上面，mouseleave 永远不会触发，预览卡会一直残留。
    hideAttachmentHover();
    const editor = composerEditorRef.current;
    const target = composerAttachmentMapRef.current.get(id);
    if (target?.previewUrl) {
      const previewEntry = [...attachmentPreviewUrlsRef.current.entries()].find(([, url]) => url === target.previewUrl);
      if (previewEntry) {
        URL.revokeObjectURL(previewEntry[1]);
        attachmentPreviewUrlsRef.current.delete(previewEntry[0]);
      }
    }
    composerAttachmentMapRef.current.delete(id);
    const node = editor?.querySelector(`[data-attachment-id="${escapeCssIdent(id)}"]`);
    removeBadgeNode(node ?? null);
    syncComposerState();
  }

  function handlePaste(event: ReactClipboardEvent<HTMLDivElement>) {
    const clipboard = event.clipboardData;
    const images = Array.from(clipboard.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (images.length) {
      event.preventDefault();
      addFiles(images.map((file, index) => renamePastedImage(file, index)));
      return;
    }

    // 富文本粘贴（网页/文档/表格）只保留文本、简单文本样式与换行：
    // 表格拍平成行（单元格空格分隔），样式只留 b/i/u/code，其余全部剥掉。
    // 我们自己复制出来的 inline badge 除外：识别出来后原地还原成徽标。
    const html = clipboard.getData("text/html");
    const plain = clipboard.getData("text/plain");
    if (!html && !plain) {
      return;
    }
    event.preventDefault();
    const badges: ClipboardBadge[] = [];
    const markup = html
      ? htmlToSanitizedMarkup(parsedBody(html), { badges })
      : escapeHtml(plain).replaceAll("\n", "<br>");
    insertPastedMarkup(markup, badges);
  }

  function parsedBody(html: string): HTMLElement {
    return new DOMParser().parseFromString(html, "text/html").body;
  }

  /** 从剪贴板描述还原一个徽标；附件在 composer 里已有原件时复用它的 File。 */
  function createPastedBadge(badge: ClipboardBadge): Node | null {
    if (badge.kind === "capability") {
      const capability: ComposerCapability = {
        id: badge.capability.id,
        kind: "skill",
        name: badge.capability.name,
        description: badge.capability.description,
        active: true,
        instanceId: createCapabilityInstanceId(),
      };
      composerCapabilityMapRef.current.set(capabilityBadgeKey(capability), capability);
      const capabilityUpdate = setSessionSkill(capability.id, true);
      trackPendingCapabilitySync(capabilityUpdate);
      void capabilityUpdate.catch((error) => {
        setComposerError(error instanceof Error ? error.message : String(error));
      });
      return createCapabilityBadgeNode(capability);
    }

    if (composerAttachmentMapRef.current.size >= maxAttachmentCount) {
      setComposerError(t("composer.error.tooManyAttachments", { count: maxAttachmentCount }));
      return null;
    }
    const existing = composerAttachmentMapRef.current.get(badge.attachment.id);
    const source = existing ?? badge.attachment;
    const previewUrl = existing?.file && source.kind === "image"
      ? URL.createObjectURL(existing.file)
      : source.previewUrl;
    const attachment: ComposerAttachment = {
      id: createAttachmentId(),
      name: source.name,
      mimeType: source.mimeType,
      size: source.size,
      kind: source.kind,
      previewUrl,
      sourcePath: source.sourcePath,
      file: existing?.file,
    };
    composerAttachmentMapRef.current.set(attachment.id, attachment);
    if (attachment.previewUrl) {
      attachmentPreviewUrlsRef.current.set(attachment.id, attachment.previewUrl);
    }
    return createAttachmentBadgeNode(attachment);
  }

  function insertPastedMarkup(markup: string, badges: ClipboardBadge[] = []) {
    if (!markup) {
      return;
    }
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    const template = document.createElement("template");
    template.innerHTML = markup;
    const fragment = template.content;
    replacePasteBadgePlaceholders(fragment, badges, createPastedBadge, composerCaretMarker);
    const selection = window.getSelection();
    rememberComposerSelection();
    let range = composerSelectionRef.current?.cloneRange();
    if (!range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    editor.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    range.deleteContents();
    const lastNode = fragment.lastChild;
    range.insertNode(fragment);
    if (lastNode) {
      range.setStartAfter(lastNode);
    }
    range.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    composerSelectionRef.current = range.cloneRange();
    syncComposerState();
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (showCapabilityPicker) {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowCapabilityPicker(false);
        return;
      }

      if (slashItems.length) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSlashHighlight((current) => moveHighlight(current, 1, slashItems.length));
          return;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSlashHighlight((current) => moveHighlight(current, -1, slashItems.length));
          return;
        }

        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          const item = slashItems[activeSlashIndex];
          if (item) {
            selectSlashItem(item);
          }
          return;
        }
      }
    }

    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.nativeEvent.isComposing &&
      stepOverCaretMarker(event.key === "ArrowLeft" ? -1 : 1)
    ) {
      event.preventDefault();
      return;
    }

    if (event.key === "Backspace" && removeAttachmentBeforeCaret()) {
      event.preventDefault();
      return;
    }

    if (event.key === "Backspace" && removeCapabilityBeforeCaret()) {
      event.preventDefault();
      return;
    }

    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    event.currentTarget.closest("form")?.requestSubmit();
  }

  function handleDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    rememberComposerSelectionFromPoint(event.clientX, event.clientY);
    addFiles(event.dataTransfer.files);
  }

  function handleComposerInput() {
    rememberComposerSelection();
    syncComposerState();
    const editor = composerEditorRef.current;
    // textContent 会把徽章内部文字（图标/名字/×）算进去，导致徽章后打 / 看似词中；
    // 触发检测只看真实文本节点。
    const query = editor ? matchSlashTrigger(readTriggerText(editor)) : null;
    if (query == null) {
      if (showCapabilityPicker) {
        setShowCapabilityPicker(false);
        setSlashQuery("");
      }
      return;
    }

    if (!showCapabilityPicker) {
      setSlashHighlight(0);
      setShowCapabilityPicker(true);
    }
    if (query !== slashQuery) {
      setSlashQuery(query);
      setSlashHighlight(0);
    }
  }

  function clearComposer(preservedPreviewUrls = new Set<string>()) {
    // 提交/清空同样会移除悬停中的徽章，同步收掉预览卡。
    hideAttachmentHover();
    const editor = composerEditorRef.current;
    composerAttachmentMapRef.current.forEach((attachment) => {
      if (attachment.previewUrl) {
        const previewEntry = [...attachmentPreviewUrlsRef.current.entries()].find(([, url]) => url === attachment.previewUrl);
        if (previewEntry && !preservedPreviewUrls.has(attachment.previewUrl)) {
          URL.revokeObjectURL(previewEntry[1]);
          attachmentPreviewUrlsRef.current.delete(previewEntry[0]);
        }
      }
    });
    composerAttachmentMapRef.current.clear();
    composerCapabilityMapRef.current.clear();
    setAttachments([]);
    setComposerText("");
    setShowCapabilityPicker(false);
    setSlashQuery("");
    if (editor) {
      editor.innerHTML = "";
      composerSelectionRef.current = null;
    }
  }

  // These two are passed to `ChatThread` and end up as the value of the inline
  // attachment context: a fresh identity per App render makes every user bubble
  // re-render on each keystroke in the composer (measured: 9 user renders per App
  // render, ~22 App renders/s while typing). They only close over `setState`,
  // which React already guarantees is stable, so an empty dep list is correct.
  const showAttachmentHover = useCallback((attachment: ChatAttachment, element: HTMLElement) => {
    setAttachmentHover({
      attachment,
      rect: element.getBoundingClientRect(),
    });
  }, []);

  const hideAttachmentHover = useCallback(() => {
    setAttachmentHover(null);
  }, []);

  // 上闸后的第一次 pointermove 才算"用户真的动了鼠标"：如果这时指针还在徽章上（新徽章不会
  // 再补发 mouseenter），就把预览补上，否则解除静默，等自然的 mouseenter。
  useEffect(() => {
    function handleAttachmentHoverPointerMove(event: PointerEvent) {
      const gate = attachmentHoverGateRef.current;
      if (!gate.isSuppressed() || !gate.releaseOnPointerMove()) {
        return;
      }

      const target = event.target as Element | null;
      const badge = target?.closest?.(".attachment-badge") as HTMLElement | null;
      const attachmentId = badge?.dataset.attachmentId;
      const attachment = attachmentId ? composerAttachmentMapRef.current.get(attachmentId) : undefined;
      if (attachment && badge) {
        showAttachmentHover(attachment, badge);
      }
    }

    window.addEventListener("pointermove", handleAttachmentHoverPointerMove);
    return () => window.removeEventListener("pointermove", handleAttachmentHoverPointerMove);
  }, [showAttachmentHover]);

  /**
   * 编辑 / 删除都作用于整轮。因为 pi 是线性 append-only 分支，回退到中间某一轮
   * 会把后面的轮次一起从当前分支拿掉；后面还有内容时先弹一次确认说清楚。
   */
  const lastUserMessageId = useMemo(() => {
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      if (conversation.messages[index].role === "user") {
        return conversation.messages[index].id;
      }
    }
    return null;
  }, [conversation.messages]);

  /**
   * 重新生成：不重传用户那轮的内容，直接用气泡里原样的 parts/附件再跑一遍。附件带着
   * `sourcePath`，服务端复用磁盘上那份，不要求客户端把字节读回来。
   */
  const runRefresh = useCallback(
    async (messageId: string) => {
      const userMessage = conversation.messages.find(
        (message) => message.id === messageId && message.role === "user",
      );
      if (!userMessage) {
        return;
      }
      setEditingMessageId(null);
      const attachmentInputs = await toAttachmentInputs(userMessage.attachments ?? [], () => undefined);
      await submitEdit(
        userMessage.id,
        userMessage.content,
        attachmentInputs,
        userMessage.contentParts ?? [],
      );
    },
    [conversation.messages, submitEdit],
  );

  const applyTurnAction = useCallback(
    (action: PendingTurnAction) => {
      setFailedEditText(null);
      if (action.kind === "edit") {
        setEditingMessageId(action.messageId);
        return;
      }
      void runRefresh(action.messageId);
    },
    [runRefresh],
  );

  const requestTurnAction = useCallback(
    (action: PendingTurnAction) => {
      if (state.isStreaming || state.isBootstrapping || state.isStopping) {
        return;
      }
      // 只有最后一轮能原地改/重生成；中间轮会连带移掉后面几轮，先让用户确认。
      if (action.messageId !== lastUserMessageId) {
        setPendingTurnAction(action);
        return;
      }
      applyTurnAction(action);
    },
    [applyTurnAction, lastUserMessageId, state.isBootstrapping, state.isStopping, state.isStreaming],
  );

  const startEditMessage = useCallback(
    (messageId: string) => requestTurnAction({ kind: "edit", messageId }),
    [requestTurnAction],
  );

  /**
   * assistant-ui 的 Reload 会把「这个回答前面那条消息」的 id 递过来，也就是同一轮的
   * `tN#user` 气泡。
   */
  const refreshMessage = useCallback(
    (parentMessageId: string) => {
      const userMessage = conversation.messages.find(
        (message) => message.id === parentMessageId && message.role === "user",
      );
      if (!userMessage || userMessage.provisional) {
        return;
      }
      requestTurnAction({ kind: "refresh", messageId: userMessage.id });
    },
    [conversation.messages, requestTurnAction],
  );

  const confirmTurnAction = useCallback(() => {
    const action = pendingTurnAction;
    setPendingTurnAction(null);
    if (action) {
      applyTurnAction(action);
    }
  }, [applyTurnAction, pendingTurnAction]);

  const cancelEditMessage = useCallback(() => {
    setEditingMessageId(null);
    setFailedEditText(null);
  }, []);

  const submitEditMessage = useCallback(
    async (messageId: string, payload: MessageEditPayload) => {
      // 和 composer 提交一样的节奏：点发送这一刻编辑框就消失、对话滚到底、那一轮
      // 立刻在屏幕上换成新内容 —— 等整段回答回来才关框，用户会看着编辑框悬在已经
      // 在流式的对话上面。
      setEditingMessageId(null);
      setFailedEditText(null);
      followLatestScroll(visibleSessionPath);
      const accepted = await submitEdit(messageId, payload.text, payload.attachments, payload.messageParts);
      if (accepted) {
        return true;
      }
      // 失败时和 composer 一样：把没发出去的文本放回去，别让用户白打一遍。
      // （带附件时不回填，附件字节已经随请求送走了，composer 也是这个规则。）
      if (!payload.attachments.length && payload.text.trim()) {
        setFailedEditText({ messageId, text: payload.text });
        setEditingMessageId(messageId);
      }
      setComposerError(t("composer.error.submitFailed"));
      return false;
    },
    [followLatestScroll, submitEdit, visibleSessionPath],
  );

  // 切会话时丢弃正在进行的编辑与确认（气泡已经不在了）。
  useEffect(() => {
    setEditingMessageId(null);
    setFailedEditText(null);
    setPendingTurnAction(null);
  }, [visibleSessionPath]);

  function syncComposerState() {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    const parts = readComposerParts(editor);
    const nextAttachments = parts
      .filter((part): part is { kind: "attachment"; attachment: ComposerAttachment } => part.kind === "attachment")
      .map((part) => part.attachment);
    const nextText = parts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join("");

    setAttachments(nextAttachments);
    setComposerText(nextText);
    clearEmptyComposerMarkers(editor, nextAttachments, nextText);
  }

  // pi TUI 对齐（interactive-mode.js 的 restoreQueuedMessagesToEditor）：中断时把服务端
  // clearQueue() 取出的未消费 steering / follow-up 退回编辑器；排队文本在前，已有文本在后。
  function restoreQueuedComposerMessages(cleared: { steering?: string[]; followUp?: string[] }) {
    const queuedText = combineQueuedComposerText(cleared.steering ?? [], cleared.followUp ?? []);
    if (!queuedText) {
      return;
    }
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }
    const parts = readComposerParts(editor);
    composerSelectionRef.current = null;
    if (parts.some((part) => part.kind === "attachment")) {
      // 编辑器里有附件时不能整体重写（会丢附件），把排队文本作为文本节点插到最前面。
      editor.insertBefore(document.createTextNode(`${queuedText}\n\n`), editor.firstChild);
    } else {
      const currentText = parts
        .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
        .map((part) => part.text)
        .join("");
      editor.textContent = mergeQueuedWithCurrentText(queuedText, currentText);
    }
    syncComposerState();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    editor.focus({ preventScroll: true });
  }

  async function handleStopTurn() {
    await stopTurn((cleared) => restoreQueuedComposerMessages(cleared));
  }

  function insertAttachmentsAtCursor(nextAttachments: ComposerAttachment[]) {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    if (nextAttachments.length) {
      // 插入点常常就在指针下面（粘贴截图 / 拖放文件），浏览器会给刚出现的新徽章补发
      // mouseenter。先收掉旧预览并上闸，等指针真动过再按指针位置重新判断。
      hideAttachmentHover();
      attachmentHoverGateRef.current.suppress();
    }

    const selection = window.getSelection();
    rememberComposerSelection();
    let range = composerSelectionRef.current?.cloneRange();
    if (!range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    editor.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    range.deleteContents();

    for (const attachment of nextAttachments) {
      composerAttachmentMapRef.current.set(attachment.id, attachment);
      if (attachment.previewUrl) {
        attachmentPreviewUrlsRef.current.set(attachment.id, attachment.previewUrl);
      }

      const badge = createAttachmentBadgeNode(attachment);
      const caretNode = document.createTextNode(composerCaretMarker);
      range.insertNode(badge);
      badge.after(caretNode);
      range.setStart(caretNode, caretNode.textContent?.length ?? 0);
      range.collapse(true);
    }

    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    composerSelectionRef.current = range.cloneRange();
    syncComposerState();
  }

  /** Packages 页点击指令的同款逻辑：立即执行 /api/capabilities/package/command，
   *  并把 composer 里已输入的 "/命令" 文本清除（不等发送）。 */
  function runCommandFromSlash(item: Extract<SlashMenuItem, { kind: "command" }>) {
    const editor = composerEditorRef.current;
    if (editor) {
      const selection = window.getSelection();
      rememberComposerSelection();
      let range = composerSelectionRef.current?.cloneRange();
      if (!range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      removeSlashBeforeRange(range);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      composerSelectionRef.current = range.cloneRange();
      syncComposerState();
    }

    void runPackageCommand(item.packageId, item.name).catch((error) => {
      setComposerError(error instanceof Error ? error.message : String(error));
    });
  }

  function selectSlashItem(item: SlashMenuItem) {
    setShowCapabilityPicker(false);
    setSlashQuery("");
    if (item.kind === "skill") {
      insertCapabilityAtCursor({ kind: "skill", id: item.id, name: item.name, description: item.description, active: true });
      return;
    }
    runCommandFromSlash(item);
  }

  function insertCapabilityAtCursor(capability: ComposerCapability) {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    setShowCapabilityPicker(false);
    const selection = window.getSelection();
    rememberComposerSelection();
    let range = composerSelectionRef.current?.cloneRange();
    if (!range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    editor.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    removeSlashBeforeRange(range);

    const selectedCapability = { ...capability, active: true, instanceId: createCapabilityInstanceId() };
    composerCapabilityMapRef.current.set(capabilityBadgeKey(selectedCapability), selectedCapability);
    const badge = createCapabilityBadgeNode(selectedCapability);
    const caretNode = document.createTextNode(composerCaretMarker);
    range.insertNode(badge);
    badge.after(caretNode);
    range.setStart(caretNode, caretNode.textContent?.length ?? 0);
    range.collapse(true);

    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    composerSelectionRef.current = range.cloneRange();
    syncComposerState();
    if (selectedCapability.kind === "skill") {
      const capabilityUpdate = setSessionSkill(selectedCapability.id, true);
      trackPendingCapabilitySync(capabilityUpdate);
      void capabilityUpdate.catch((error) => {
        setComposerError(error instanceof Error ? error.message : String(error));
      });
    }
  }

  function rememberComposerSelection() {
    const editor = composerEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || !selection.rangeCount) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (editor.contains(range.startContainer) && editor.contains(range.endContainer)) {
      composerSelectionRef.current = range.cloneRange();
    }
  }

  function rememberComposerSelectionFromPoint(clientX: number, clientY: number) {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    const documentWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let range = documentWithCaret.caretRangeFromPoint?.(clientX, clientY) ?? null;
    const caretPosition = !range ? documentWithCaret.caretPositionFromPoint?.(clientX, clientY) : null;
    if (!range && caretPosition) {
      range = document.createRange();
      range.setStart(caretPosition.offsetNode, caretPosition.offset);
      range.collapse(true);
    }

    if (range && editor.contains(range.startContainer)) {
      composerSelectionRef.current = range.cloneRange();
    }
  }

  function createAttachmentBadgeNode(attachment: ComposerAttachment) {
    const badge = document.createElement("span");
    badge.className = `attachment-badge ${attachment.kind}`;
    badge.dataset.attachmentId = attachment.id;
    applyAttachmentBadgeAttributes(badge, attachment);
    badge.contentEditable = "false";
    badge.addEventListener("mouseenter", () => {
      if (attachmentHoverGateRef.current.isSuppressed()) {
        return;
      }
      showAttachmentHover(attachment, badge);
    });
    badge.addEventListener("mouseleave", hideAttachmentHover);

    if (attachment.kind === "image" && attachment.previewUrl) {
      const image = document.createElement("img");
      image.alt = "";
      image.src = attachment.previewUrl;
      badge.appendChild(image);
    } else {
      const icon = document.createElement("span");
      icon.className = "attachment-badge-icon";
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg>`;
      badge.appendChild(icon);
    }

    const copy = document.createElement("span");
    copy.className = "attachment-badge-copy";
    const title = document.createElement("strong");
    title.title = attachment.name;
    title.textContent = attachment.name;
    const size = document.createElement("small");
    size.textContent = formatFileSize(attachment.size);
    copy.append(title, size);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${attachment.name}`);
    remove.title = `Remove ${attachment.name}`;
    remove.innerHTML = "<span aria-hidden='true'>×</span>";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeAttachment(attachment.id);
    });

    badge.append(copy, remove);
    return badge;
  }

  function createCapabilityBadgeNode(capability: ComposerCapability) {
    const badge = document.createElement("span");
    badge.className = `attachment-badge capability-badge ${capability.kind}`;
    badge.dataset.capabilityId = capability.id;
    badge.dataset.capabilityKind = capability.kind;
    badge.dataset.capabilityInstanceId = capability.instanceId ?? "";
    applyCapabilityBadgeAttributes(badge, capability);
    badge.contentEditable = "false";

    const icon = document.createElement("span");
    icon.className = "attachment-badge-icon";
    icon.textContent = "S";

    const copy = document.createElement("span");
    copy.className = "attachment-badge-copy";
    const title = document.createElement("strong");
    title.title = capability.name;
    title.textContent = capability.name;
    const subtitle = document.createElement("small");
    subtitle.textContent = "Skill";
    copy.append(title, subtitle);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${capability.name}`);
    remove.title = `Remove ${capability.name}`;
    remove.innerHTML = "<span aria-hidden='true'>×</span>";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeCapability(capability);
    });

    badge.append(icon, copy, remove);
    return badge;
  }

  function removeAttachmentBeforeCaret() {
    const node = removableBadgeBeforeCaret("attachmentId");
    const attachmentId = node?.dataset.attachmentId;
    if (!attachmentId) {
      return false;
    }

    const parent = node.parentNode;
    const offset = parent ? Array.prototype.indexOf.call(parent.childNodes, node) : 0;
    removeAttachment(attachmentId);
    restoreComposerCaret(parent, offset);
    return true;
  }

  function removeCapabilityBeforeCaret() {
    const node = removableBadgeBeforeCaret("capabilityId");
    const capabilityId = node?.dataset?.capabilityId;
    const capabilityKind = node?.dataset?.capabilityKind as CapabilityKind | undefined;
    if (!capabilityId || capabilityKind !== "skill") {
      return false;
    }

    const capabilityKey = capabilityBadgeKey({
      id: capabilityId,
      kind: capabilityKind,
      instanceId: node.dataset.capabilityInstanceId,
    });
    const capability = composerCapabilityMapRef.current.get(capabilityKey);
    const parent = node.parentNode;
    const offset = parent ? Array.prototype.indexOf.call(parent.childNodes, node) : 0;
    removeBadgeNode(node);
    composerCapabilityMapRef.current.delete(capabilityKey);
    restoreComposerCaret(parent, offset);
    syncComposerState();
    if (capability?.kind === "skill" && !hasComposerCapability(capability)) {
      const capabilityUpdate = setSessionSkill(capability.id, false);
      trackPendingCapabilitySync(capabilityUpdate);
      void capabilityUpdate.catch((error) => {
        setComposerError(error instanceof Error ? error.message : String(error));
      });
    }
    return true;
  }

  function removeCapability(capability: ComposerCapability) {
    const badgeId = capabilityBadgeKey(capability);
    const node = composerEditorRef.current?.querySelector(capabilitySelector(capability));
    removeBadgeNode(node ?? null);
    composerCapabilityMapRef.current.delete(badgeId);
    syncComposerState();
    if (hasComposerCapability(capability)) {
      return;
    }
    if (capability.kind === "skill") {
      const capabilityUpdate = setSessionSkill(capability.id, false);
      trackPendingCapabilitySync(capabilityUpdate);
      void capabilityUpdate.catch((error) => {
        setComposerError(error instanceof Error ? error.message : String(error));
      });
    }
  }

  function trackPendingCapabilitySync(promise: Promise<unknown>) {
    const tracked = promise.then(() => true, () => false);
    pendingCapabilitySyncRef.current = tracked;
    void tracked.then(() => {
      if (pendingCapabilitySyncRef.current === tracked) {
        pendingCapabilitySyncRef.current = null;
      }
    });
  }

  async function waitForPendingCapabilitySync() {
    if (!pendingCapabilitySyncRef.current) {
      return true;
    }

    return pendingCapabilitySyncRef.current;
  }

  function restoreComposerCaret(container: Node | null, offset: number) {
    const editor = composerEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection) {
      return;
    }

    const target = container && editor.contains(container) ? container : editor;
    const range = document.createRange();
    range.setStart(target, Math.min(offset, target.childNodes.length));
    range.collapse(true);
    editor.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    composerSelectionRef.current = range.cloneRange();
  }

  function removableBadgeBeforeCaret(dataKey: "attachmentId" | "capabilityId") {
    const editor = composerEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || !selection.rangeCount || !selection.isCollapsed) {
      return null;
    }

    // 与方向键共用同一套「徽标右侧边界」识别：光标可能停在零宽标记节点内部、被 Chrome
    // 规范成的父子边界上，或标记与正文并进同一个文本节点后的开头偏移。只认「父子边界+
    // 前一个兄弟是徽标」会漏掉夹着标记的情况，于是 Backspace 先删掉那个看不见的标记
    // （Chrome 还会补一个 <br> 占位），要再按一次才删徽标。
    const range = selection.getRangeAt(0);
    const badge = badgeBeforeCaret(range.startContainer, range.startOffset, composerCaretMarker);
    if (!badge || !editor.contains(badge) || !(badge as HTMLElement).dataset?.[dataKey]) {
      return null;
    }
    return badge as HTMLSpanElement;
  }

  function isAttachmentElement(node: Node | null): node is HTMLSpanElement {
    return Boolean(node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset?.attachmentId);
  }

  function isCapabilityElement(node: Node | null): node is HTMLSpanElement {
    return Boolean(node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset?.capabilityId);
  }

  function hasComposerCapability(capability: Pick<ComposerCapability, "kind" | "id">) {
    return Boolean(composerEditorRef.current?.querySelector(capabilitySelector(capability)));
  }

  /**
   * 光标停在徽标后的零宽标记上时，用共享的跨标记逻辑把光标移到徽标外侧，
   * 避免方向键「按一次没反应」（具体说明见 caretMarkerStep.ts）。
   * 返回 true 表示已经处理并移动了光标。
   */
  function stepOverCaretMarker(direction: -1 | 1) {
    const next = stepSelectionOverCaretMarker(
      composerEditorRef.current,
      window.getSelection(),
      direction,
      composerCaretMarker,
    );
    if (!next) {
      return false;
    }
    composerSelectionRef.current = next.cloneRange();
    return true;
  }

  function removeLeadingCaretMarker(node: Node | null) {
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      return;
    }

    const text = node.textContent ?? "";
    if (!text.startsWith(composerCaretMarker)) {
      return;
    }

    node.textContent = text.slice(composerCaretMarker.length);
    if (!node.textContent) {
      node.parentNode?.removeChild(node);
    }
  }

  function clearEmptyComposerMarkers(editor: HTMLDivElement, nextAttachments: ComposerAttachment[], nextText: string) {
    if (nextAttachments.length > 0 || nextText.length > 0 || editor.childNodes.length === 0) {
      return;
    }

    if (Array.from(editor.childNodes).every((node) => isMarkerOnlyTextNode(node, composerCaretMarker))) {
      editor.innerHTML = "";
      composerSelectionRef.current = null;
    }
  }

  function readComposerParts(editor: HTMLDivElement | null) {
    const parts: ComposerPart[] = [];
    if (!editor) {
      return parts;
    }

    appendComposerParts(editor, parts);
    return normalizeComposerTextParts(compactComposerParts(parts));
  }

  function appendComposerParts(
    root: Node,
    parts: ComposerPart[],
  ) {
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent ?? "").replaceAll(composerCaretMarker, "");
        if (text) {
          parts.push({ kind: "text", text });
        }
        continue;
      }

      if (isAttachmentElement(node)) {
        const attachmentId = node.dataset.attachmentId;
        const attachment = attachmentId ? composerAttachmentMapRef.current.get(attachmentId) : undefined;
        if (attachment) {
          parts.push({ kind: "attachment", attachment });
        }
        continue;
      }

      if (isCapabilityElement(node)) {
        const capabilityId = node.dataset.capabilityId;
        const capabilityKind = node.dataset.capabilityKind as CapabilityKind | undefined;
        if (capabilityKind !== "skill") {
          continue;
        }
        const capability = capabilityId && capabilityKind
          ? composerCapabilityMapRef.current.get(capabilityBadgeKey({
              id: capabilityId,
              kind: capabilityKind,
              instanceId: node.dataset.capabilityInstanceId,
            }))
          : undefined;
        if (capability) {
          parts.push({ kind: "capability", capability });
        }
        continue;
      }

      appendComposerParts(node, parts);
      // <br>（Shift+Enter / 粘贴换行）与块级边界都算换行，提交时保留。
      const tagName = (node as Element).nodeName?.toUpperCase() ?? "";
      if (tagName === "BR" || COMPOSER_BLOCK_TAGS.has(tagName)) {
        parts.push({ kind: "text", text: "\n" });
      }
    }
  }

  function compactComposerParts(parts: ComposerPart[]) {
    const compacted: ComposerPart[] = [];
    for (const part of parts) {
      const previous = compacted.at(-1);
      if (part.kind === "text" && previous?.kind === "text") {
        previous.text += part.text;
      } else {
        compacted.push(part);
      }
    }
    return compacted;
  }

  /** 提交序列化的换行保留：连续 3+ 个换行压成两个，去掉结尾换行（块级边界累积产生）。 */
  function normalizeComposerTextParts(parts: ComposerPart[]): ComposerPart[] {
    return parts
      .map((part, index) => {
        if (part.kind !== "text") {
          return part;
        }
        let text = part.text.replace(/\n{3,}/g, "\n\n");
        if (index === parts.length - 1) {
          text = text.replace(/\s+$/u, "");
        }
        return text ? { ...part, text } : null;
      })
      .filter((part): part is ComposerPart => part !== null);
  }

  /**
   * Removes the "/query" text (or a bare "/") right before the caret, so a
   * picked menu item replaces the trigger instead of leaving residue behind.
   * Zero-width caret markers are invisible to the match but kept in the text.
   */
  function removeSlashBeforeRange(range: Range) {
    const container = range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE || range.startOffset === 0) {
      return;
    }

    const text = container.textContent ?? "";
    const slashIndex = findSlashStart(text.slice(0, range.startOffset));
    if (slashIndex == null) {
      return;
    }

    container.textContent = `${text.slice(0, slashIndex)}${text.slice(range.startOffset)}`;
    range.setStart(container, slashIndex);
    range.collapse(true);
  }

  function handlePanelResizeStart(side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panelResizeRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === "left" ? leftSidebarWidth : rightPanelWidth,
    };
    setResizingSide(side);
  }

  function handlePanelResize(side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    const resize = panelResizeRef.current;
    if (!resize || resize.side !== side) {
      return;
    }

    const delta = event.clientX - resize.startX;
    const nextWidth = side === "left" ? resize.startWidth + delta : resize.startWidth - delta;
    const clamped = side === "left" ? clampPanelWidth(nextWidth, "left") : clampPanelWidth(nextWidth, "right");

    if (side === "left") {
      setLeftSidebarCollapsed(false);
      setLeftSidebarWidth(clamped);
    } else {
      setRightPanelCollapsed(false);
      setRightPanelWidth(clamped);
    }
  }

  function handlePanelResizeEnd(side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    if (panelResizeRef.current?.side === side) {
      panelResizeRef.current = null;
    }
    setResizingSide(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function toggleRightPanel() {
    if (window.innerWidth <= 920) {
      setShowPanel((value) => !value);
      return;
    }

    setRightPanelCollapsed((value) => !value);
  }

  function toggleLeftPanel() {
    if (window.innerWidth <= 920) {
      setShowLeftPanel((value) => !value);
      return;
    }

    setLeftSidebarCollapsed((value) => !value);
  }

  // The context panel lists what *this conversation* pulls in, so the full-width
  // Global skills & packages page has no right panel next to it.
  const showContextPanel = activeMainView === "chat";

  return (
    <div className="app-shell-surface flex h-dvh max-h-dvh min-h-0 flex-col overflow-hidden rounded-[var(--window-radius)] border">
      <TitleBar
        title={stripTerminalSequences(state.extensionTitle ?? "").trim() || conversation.title}
        leftSidebarCollapsed={leftSidebarCollapsed}
        rightPanelCollapsed={rightPanelCollapsed}
        showContextPanel={showContextPanel}
        onToggleLeft={toggleLeftPanel}
        onToggleRight={toggleRightPanel}
      />
      <main
        className="app-main grid h-[calc(100dvh-var(--titlebar-height))] max-h-[calc(100dvh-var(--titlebar-height))] min-h-0 grid-cols-[var(--left-sidebar-width)_3px_minmax(0,1fr)_3px_var(--right-panel-width)] overflow-hidden max-[920px]:grid-cols-[minmax(0,1fr)]"
        style={
          {
            "--left-sidebar-width": leftSidebarCollapsed ? "0px" : `${leftSidebarWidth}px`,
            "--right-panel-width": rightPanelCollapsed || !showContextPanel ? "0px" : `${rightPanelWidth}px`,
          } as CSSProperties
        }
      >
        <ProjectSidebar
          isOpen={showLeftPanel}
          collapsed={leftSidebarCollapsed}
          isBootstrapped={Boolean(state.bootstrap)}
          projects={projects}
          activeProjectId={bootstrap.activeProjectId}
          activeSessionPath={bootstrap.activeSessionPath}
          streamingSessionPaths={streamingSessionPaths}
          isBusy={state.isBootstrapping}
          onCreateProject={createProject}
          onUpdateProject={updateProject}
          onPinProject={pinProject}
          onReorderProjects={reorderProjects}
          onRemoveProject={removeProject}
          onRevealProject={revealProject}
          onCreateSession={createSession}
          onUpdateSession={updateSession}
          onPinSession={pinSession}
          onArchiveSession={archiveSession}
          onDeleteSession={deleteSession}
          onSelectSession={selectSession}
          onFocusComposer={focusComposerQuietly}
          activeMainView={activeMainView}
          onOpenCapabilities={() => {
            setActiveMainView("capabilities");
            setShowLeftPanel(false);
          }}
          onOpenSettings={() => setShowSettings(true)}
          theme={theme}
          onToggleTheme={() => setTheme((value) => (value === "dark" ? "light" : "dark"))}
          onOpenChat={() => setActiveMainView("chat")}
        />
        <PanelResizeHandle
          side="left"
          resizing={resizingSide === "left"}
          onPointerDown={handlePanelResizeStart}
          onPointerMove={handlePanelResize}
          onPointerUp={handlePanelResizeEnd}
          onDoubleClick={() => setLeftSidebarCollapsed((value) => !value)}
        />
        {/* 会话区在「全局技能与扩展」页打开时也保持挂载：composer 的正文存在 contentEditable
            DOM 里（composerText 只是派生值），卸载它会连草稿和会话滚动位置一起丢掉。改成把
            整页盖在会话上，并用 inert 把被遮住的聊天移出 Tab 顺序、挡住误点。 */}
        <div
          className="relative h-full min-h-0 min-w-0 overflow-hidden"
        >
        <section
          className="conversation-surface flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
          inert={activeMainView === "capabilities"}
        >
        {/* 单行头：左边一个文件夹按钮（点击＝在访达/资源管理器里打开项目文件夹），
            右边依次是项目名和会话标题。原来的三行堆叠（项目名 / 标题 / 路径）和右下角的
            三点菜单都收掉了，路径移到文件夹按钮的 tooltip 里，头部高度少一半。 */}
        <header className="conversation-header flex flex-none items-center gap-2.5 px-3 py-2 max-[560px]:gap-1.5 max-[560px]:px-2">
          {/* 项目名 + 标题用同一套字号/字重/颜色，只有中间一条细分割线区分两者；
              文件夹图标 + 项目名是一个可点单元（整块一层 hover 底色），点它打开项目文件夹。 */}
          <button
            type="button"
            className="flex h-7 min-w-0 max-w-[42%] items-center gap-1.5 rounded-md pr-2 pl-1.5 text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            onClick={() => void revealProject(activeProject.id)}
            aria-label={t(platformRevealFolderLabelKey())}
            title={`${t(platformRevealFolderLabelKey())}: ${activeProject.cwd}`}
          >
            <FolderOpen className="size-[15px] shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate text-[0.86rem] font-medium text-foreground">
              {activeProject.name}
            </span>
          </button>
          <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
          <h1
            className="min-w-0 flex-1 truncate text-[0.86rem] leading-snug font-medium text-foreground"
            title={conversation.title}
          >
            {conversation.title}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            <GitStatusBadge
              info={projectGit.info}
              isInitializing={projectGit.isInitializing}
              isRefreshing={projectGit.isRefreshing}
              switchingTo={projectGit.switchingTo}
              isCreatingBranch={projectGit.isCreatingBranch}
              isRenamingBranch={projectGit.isRenamingBranch}
              isCommitting={projectGit.isCommitting}
              isGeneratingMessage={projectGit.isGeneratingMessage}
              isStreaming={state.isStreaming}
              error={projectGit.error}
              onInit={() => void projectGit.initRepo()}
              onRefresh={() => void projectGit.refresh()}
              onSwitchBranch={projectGit.switchBranch}
              onCreateBranch={projectGit.createBranch}
              onRenameBranch={projectGit.renameBranch}
              onCommit={projectGit.commitChanges}
              onOpenDiff={projectGit.openDiff}
              onGenerateMessage={projectGit.generateCommitMessage}
            />
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              className="hidden max-[920px]:inline-flex max-[560px]:size-[38px]"
              onClick={() => setShowSettings(true)}
              aria-label="Open settings"
              title="Open settings"
            >
              <Settings />
            </Button>
          </div>
        </header>

        {state.error ? (
          <div className={cn("flex flex-none items-center justify-between gap-3 border-b px-5 py-2.5", statusBannerStyles)} role="status">
            <span className="min-w-0 break-words">{state.error}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={statusBannerButtonStyles}
              onClick={dismissError}
              aria-label="Dismiss"
            >
              <X />
            </Button>
          </div>
        ) : null}
        {!bootstrap.projectTrusted ? (
          <div className={cn("flex flex-none items-center justify-between gap-3 border-b px-5 py-2.5", statusBannerStyles)} role="status">
            <span className="min-w-0 break-words">{t("trust.untrustedNotice")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn("h-8 min-w-max", statusBannerButtonStyles)}
              onClick={() => void trustProject()}
              disabled={state.isBootstrapping}
            >
              {t("trust.trustAndLoad")}
            </Button>
          </div>
        ) : null}

        <ChatThread
          key={visibleSessionPath}
          messages={conversation.messages}
          isStreaming={state.isStreaming}
          sessionPath={visibleSessionPath}
          viewportStates={scrollStateRef.current}
          onAttachmentHoverStart={showAttachmentHover}
          onAttachmentHoverEnd={hideAttachmentHover}
          editingMessageId={editingMessageId}
          editDraftText={failedEditText?.messageId === editingMessageId ? failedEditText.text : null}
          capabilities={capabilities}
          onStartEditMessage={startEditMessage}
          onReloadMessage={refreshMessage}
          onCancelEditMessage={cancelEditMessage}
          onSubmitEditMessage={submitEditMessage}
        />

        <form className="composer" onSubmit={handleSubmit}>
          {compactionNoticeView ? (
            <div
              className="compaction-notice"
              data-tone={compactionNoticeView.tone}
              role={compactionNoticeView.tone === "failed" ? "alert" : "status"}
            >
              {compactionNoticeView.tone === "running" ? <Loader2 className="compaction-notice-spin" /> : null}
              <span className="compaction-notice-text">{compactionNoticeView.text}</span>
              {compactionNoticeView.tone === "failed" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="compaction-notice-close"
                  onClick={dismissCompactionNotice}
                  aria-label="Dismiss"
                >
                  <X />
                </Button>
              ) : null}
            </div>
          ) : null}
          {extensionAboveWidgets.length ? <ExtensionWidgetStack widgets={extensionAboveWidgets} /> : null}
          <input
            ref={fileInputRef}
            className="composer-file-input"
            type="file"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              if (event.target.files) {
                addFiles(event.target.files);
              }
              event.target.value = "";
            }}
          />
          <div
            className={`composer-surface ${isDraggingFiles ? "is-dragging" : ""}`}
            onPointerDown={restoreComposerFocusRing}
            onKeyDown={restoreComposerFocusRing}
            onInput={restoreComposerFocusRing}
            onDragEnter={handleDragEnter}
            onDragOver={(event) => {
              if (hasDraggedFiles(event)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div
              ref={composerEditorRef}
              className="composer-editor"
              contentEditable
              role="textbox"
              aria-multiline="true"
              aria-label={t("composer.messageAria")}
              data-placeholder={
                isDraggingFiles
                  ? t("composer.dropzone.dropToAdd")
                  : state.isStreaming
                      ? t("composer.placeholder.steering")
                      : state.isStopping
                        ? t("composer.stop.stopping")
                      : bootstrap.canPrompt
                        ? t("composer.placeholder.ready")
                        : t("composer.placeholder.noModel")
              }
              suppressContentEditableWarning
              onInput={handleComposerInput}
              onKeyDown={handleComposerKeyDown}
              onPaste={handlePaste}
            />
            <div className="composer-toolbar">
              <div className="composer-tools">
                <button
                  className="composer-tool-button"
                  type="button"
                  onMouseDown={rememberComposerSelection}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isPreparingAttachments}
                  aria-label="Add files"
                  title="Add files"
                >
                  <Plus size={19} />
                </button>
                {modelSupportsThinking ? (
                  <ThinkingLevelSelect
                    value={state.selectedThinkingLevel}
                    onChange={(thinkingLevel) => void updateSessionThinkingLevel(thinkingLevel)}
                    disabled={composerSessionBusy}
                    supportedThinkingLevels={activeModelThinkingLevels}
                  />
                ) : null}
                <div className="usage-popover-anchor" ref={usagePopoverRef}>
                  <button
                    className={`usage-trigger ${showUsagePopover ? "is-open" : ""}`}
                    type="button"
                    onClick={() => setShowUsagePopover((value) => !value)}
                    aria-expanded={showUsagePopover}
                    aria-label="Show context usage"
                    title="Show context usage"
                  >
                    <span
                      className="usage-ring"
                      style={{ "--usage-percent": `${contextPercent ?? 0}%` } as CSSProperties}
                    >
                      <span>{contextPercent == null ? "--" : `${Math.round(contextPercent)}%`}</span>
                    </span>
                  </button>
                  {showUsagePopover ? (
                    <UsagePopover
                      stats={stats}
                      contextPercent={contextPercent}
                      capabilities={capabilities}
                      thinkingLevel={state.selectedThinkingLevel}
                      hasThinking={Boolean(modelConfig.model && state.selectedThinkingLevel !== "off")}
                      isCompacting={state.isCompacting}
                      isStreaming={state.isStreaming}
                      canCompact={Boolean(modelConfig.model && stats.contextPercent != null && stats.contextPercent >= 80)}
                      onCompact={() => void compactContext()}
                      onClose={() => setShowUsagePopover(false)}
                    />
                  ) : null}
                </div>
                <button
                  className="composer-tool-button composer-tool-mic"
                  type="button"
                  aria-label="Voice input reserved"
                  disabled
                >
                  <Mic size={18} />
                </button>
                {modelSupportsThinking ? (
                  <ComposerOverflowMenu
                    thinkingLevel={state.selectedThinkingLevel}
                    disabled={composerSessionBusy}
                    onThinkingLevelChange={(thinkingLevel) => void updateSessionThinkingLevel(thinkingLevel)}
                    supportedThinkingLevels={activeModelThinkingLevels}
                  />
                ) : null}
                {composerError ? <span className="composer-error">{composerError}</span> : null}
              </div>
              <div className="composer-actions">
                <ComposerModelSelect
                  availableModels={availableModels}
                  customModels={customModels.entries}
                  currentProvider={selectedProvider}
                  currentModel={selectedModel}
                  disabled={composerSessionBusy}
                  onChange={handleComposerModelChange}
                />
                {state.isStreaming ? (
                  <button
                    className="icon-button stop-button"
                    type="button"
                    onClick={() => void handleStopTurn()}
                    aria-label="Stop"
                    title="Stop current response and running tools"
                  >
                    <Square size={16} />
                  </button>
                ) : null}
                <button
                  className="send-button"
                  type="submit"
                  disabled={(!composerText.trim() && attachments.length === 0) || isPreparingAttachments || state.isStopping}
                  aria-label={state.isStreaming ? "Queue follow-up" : "Send"}
                  title={state.isStreaming ? "Queue follow-up" : "Send"}
                >
                  <Send size={18} />
                </button>
              </div>
            </div>
          </div>
          {showCapabilityPicker ? (
            <SlashMenu
              items={slashItems}
              highlightIndex={activeSlashIndex}
              onSelect={selectSlashItem}
              onHighlight={setSlashHighlight}
            />
          ) : null}
          {extensionBelowWidgets.length ? <ExtensionWidgetStack widgets={extensionBelowWidgets} /> : null}
        </form>
        </section>
        {activeMainView === "capabilities" ? (
          <div className="absolute inset-0 z-20">
            <CapabilitiesPage
              capabilities={capabilities}
              onSetDefault={setCapabilityDefault}
              onSetPinned={setCapabilityPinned}
              onDelete={deleteCapabilityItem}
              onImportSkill={importSkill}
              onInstallPackage={installPackage}
              onUpdatePackage={updatePackage}
              onRunPackageCommand={runPackageCommand}
              customUiCancelVersion={customUiCancelVersion}
            />
          </div>
        ) : null}
        </div>

        {attachmentHover ? <AttachmentHoverCard hover={attachmentHover} /> : null}
        {pendingTurnAction ? (
          <AlertDialog
            open
            onOpenChange={(next) => {
              if (!next) {
                setPendingTurnAction(null);
              }
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingTurnAction.kind === "edit"
                    ? t("message.truncateEditTitle")
                    : t("message.truncateRefreshTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingTurnAction.kind === "edit"
                    ? t("message.truncateEditDesc")
                    : t("message.truncateRefreshDesc")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={confirmTurnAction}>
                  {pendingTurnAction.kind === "edit"
                    ? t("message.truncateEditConfirm")
                    : t("message.truncateRefreshConfirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
        {Object.keys(state.extensionUiStatus).length ? <ExtensionStatusBar status={state.extensionUiStatus} /> : null}
        {state.extensionUiNotifications.length ? <ExtensionNotifications notifications={state.extensionUiNotifications} /> : null}
        {activeExtensionUiRequest ? (
          <ExtensionUiDialog
            request={activeExtensionUiRequest}
            onRespond={(response) => void respondExtensionUi(response)}
          />
        ) : null}
        {activeWebExtensionUiRequest && !activeExtensionUiRequest ? (
          <ExtensionWebUi
            request={activeWebExtensionUiRequest}
            onRespond={(response) => void respondExtensionUi(response)}
          />
        ) : null}
        {activeCustomExtensionUiRequest && !activeExtensionUiRequest && !activeWebExtensionUiRequest ? (
          <ExtensionCustomUiPanel
            request={activeCustomExtensionUiRequest}
            onRespond={(response) => void respondExtensionUi(response)}
            onCancelled={() => setCustomUiCancelVersion((version) => version + 1)}
          />
        ) : null}

      {showContextPanel && showPanel ? (
        <button
          className="fixed top-[var(--titlebar-height)] right-0 bottom-0 left-0 z-10 hidden h-full w-full border-0 bg-[var(--app-scrim)] max-[920px]:block"
          type="button"
          onClick={() => setShowPanel(false)}
          aria-label="Close settings"
        />
      ) : null}

      {showLeftPanel ? (
        <button
          className="fixed top-[var(--titlebar-height)] right-0 bottom-0 left-0 z-10 hidden h-full w-full border-0 bg-[var(--app-scrim)] max-[920px]:block"
          type="button"
          onClick={() => setShowLeftPanel(false)}
          aria-label={t("common.closeProjects")}
        />
      ) : null}

        {showContextPanel ? (
          <>
        <PanelResizeHandle
          side="right"
          // 右侧面板与聊天列同底色，需要一条常显分隔线；面板收起时不画（否则会在窗口
          // 右边缘留下一条悬空线）。
          divider={!rightPanelCollapsed}
          resizing={resizingSide === "right"}
          onPointerDown={handlePanelResizeStart}
          onPointerMove={handlePanelResize}
          onPointerUp={handlePanelResizeEnd}
          onDoubleClick={() => setRightPanelCollapsed((value) => !value)}
        />
        <aside
          className={cn(
            "context-panel-surface grid min-h-0 min-w-0 content-start overflow-y-auto p-[18px]",
            rightPanelCollapsed && "invisible pointer-events-none",
            // 窄屏（≤920px）这个面板是贴右边缘的浮层。它必须从标题栏下面开始：标题栏
            // 是 z-[100] 的不透明条，浮层 z-20 从 y=0 起就会被整条盖住 —— 面板第一行
            // 是搜索框，用户看到的就是「搜索显示不全」。左侧项目栏同样用
            // top-[var(--titlebar-height)] + bottom-0，两边保持一致。
            "max-[920px]:fixed max-[920px]:top-[var(--titlebar-height)] max-[920px]:bottom-0 max-[920px]:right-0 max-[920px]:left-auto max-[920px]:z-20 max-[920px]:w-[min(88vw,360px)] max-[920px]:translate-x-[105%] max-[920px]:shadow-[var(--app-shadow-drawer-left)] max-[920px]:transition-transform",
            showPanel && "max-[920px]:visible max-[920px]:translate-x-0 max-[920px]:pointer-events-auto",
          )}
          aria-label={t("capability.context.panelAria")}
        >
        {/* Only what this project adds — builtin/agent-level capabilities live in
            the Global skills & packages page and must not be listed twice. */}
        <ProjectCapabilitiesPanel
          capabilities={capabilities}
          projectName={activeProject.name}
          onSetDefault={setCapabilityDefault}
          onSetPinned={setCapabilityPinned}
          onDelete={deleteCapabilityItem}
          onImportSkill={importSkill}
          onInstallPackage={installPackage}
          onUpdatePackage={updatePackage}
          onRunPackageCommand={runPackageCommand}
        />
        </aside>
          </>
        ) : null}

        <SettingsModal
          open={showSettings}
          onOpenChange={setShowSettings}
          models={customModels}
          onModelsChanged={() => void refreshAvailableModels()}
          personalization={bootstrap.personalization}
          onSavePersonalization={savePersonalization}
          appearance={appearance}
          onAppearanceChange={setAppearance}
          archivedSessions={bootstrap.archivedSessions ?? []}
          onUnarchiveSession={unarchiveSession}
          onDeleteArchivedSession={deleteArchivedSession}
          onDeleteAllArchivedSessions={deleteAllArchivedSessions}
        />
      </main>
    </div>
  );
}

function TitleBar({
  title,
  leftSidebarCollapsed,
  rightPanelCollapsed,
  showContextPanel = true,
  onToggleLeft,
  onToggleRight,
}: {
  title: string;
  leftSidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  /** Hidden when the visible view has no context panel to toggle. */
  showContextPanel?: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const isDesktopRuntime = isTauriRuntime();
  const isMac = isMacPlatform();
  const titlebarToggleAtRef = useRef(0);

  function handleTitleBarMouseDown(event: ReactMouseEvent<HTMLElement>) {
    if (!isDesktopRuntime || event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }

    if (event.detail >= 2) {
      event.preventDefault();
      titlebarToggleAtRef.current = Date.now();
      void invoke("toggle_window_maximize");
      return;
    }

    void invoke("start_window_drag");
  }

  function handleTitleBarDoubleClick(event: ReactMouseEvent<HTMLElement>) {
    if (!isDesktopRuntime || (event.target as HTMLElement).closest("button")) {
      return;
    }

    event.preventDefault();
    if (Date.now() - titlebarToggleAtRef.current < 350) {
      return;
    }

    titlebarToggleAtRef.current = Date.now();
    void invoke("toggle_window_maximize");
  }

  return (
    <header
      className="app-titlebar relative z-[100] grid h-[var(--titlebar-height)] flex-none grid-cols-[minmax(220px,1fr)_auto_minmax(220px,1fr)] items-center px-2.5 select-none [-webkit-app-region:drag]"
      data-tauri-drag-region
      onMouseDown={handleTitleBarMouseDown}
      onDoubleClick={handleTitleBarDoubleClick}
    >
      <div className="flex min-w-0 items-center gap-2 max-[920px]:gap-1" data-tauri-drag-region>
        {isMac && isDesktopRuntime ? <WindowControls platform="mac" /> : null}
        <TitleBarIconButton
          onClick={onToggleLeft}
          active={!leftSidebarCollapsed}
          label={leftSidebarCollapsed ? t("titlebar.showProjects") : t("titlebar.hideProjects")}
        >
          <PanelLeft />
        </TitleBarIconButton>
      </div>
      <div className="min-w-0 text-center text-sm font-bold">
        <span className="block truncate">{title}</span>
      </div>
      <div className="flex min-w-0 items-center justify-end gap-2" data-tauri-drag-region>
        <TitleBarIconButton
          onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
          active={locale === "en"}
          label={locale === "zh" ? t("titlebar.switchToEnglish") : t("titlebar.switchToChinese")}
        >
          <span className="text-[11px] font-bold tracking-wide">{locale === "zh" ? "EN" : "中"}</span>
        </TitleBarIconButton>
        {showContextPanel ? (
          <TitleBarIconButton
            onClick={onToggleRight}
            active={!rightPanelCollapsed}
            label={rightPanelCollapsed ? t("titlebar.showContext") : t("titlebar.hideContext")}
          >
            <PanelRight />
          </TitleBarIconButton>
        ) : null}
        {!isMac && isDesktopRuntime ? <WindowControls platform="windows" /> : null}
      </div>
    </header>
  );
}

// The titlebar is a drag region, so every button inside it has to opt out of
// dragging explicitly via -webkit-app-region: no-drag.
function TitleBarIconButton({
  onClick,
  active,
  label,
  children,
}: {
  onClick: () => void;
  active: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn(
        "size-7 text-muted-foreground [-webkit-app-region:no-drag]",
        active && "bg-accent text-accent-foreground",
      )}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {children}
    </Button>
  );
}

function WindowControls({ platform }: { platform: "mac" | "windows" }) {
  if (platform === "mac") {
    // Traffic-light colours are fixed macOS system colours, so they stay literal
    // rather than being mapped onto theme tokens.
    return (
      <div className="inline-flex items-center gap-2 pr-2 pl-1.5 [-webkit-app-region:no-drag]" aria-label="Window controls">
        <button
          type="button"
          className="size-3 rounded-full border border-black/15 bg-[#ff5f57] hover:brightness-[0.96]"
          onClick={() => void invoke("close_window")}
          aria-label="Close"
          title="Close"
        />
        <button
          type="button"
          className="size-3 rounded-full border border-black/15 bg-[#ffbd2e] hover:brightness-[0.96]"
          onClick={() => void invoke("minimize_window")}
          aria-label="Minimize"
          title="Minimize"
        />
        <button
          type="button"
          className="size-3 rounded-full border border-black/15 bg-[#28c840] hover:brightness-[0.96]"
          onClick={() => void invoke("toggle_window_maximize")}
          aria-label="Maximize"
          title="Maximize"
        />
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-0.5 border-l pl-1 [-webkit-app-region:no-drag]" aria-label="Window controls">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 text-muted-foreground [-webkit-app-region:no-drag]"
        onClick={() => void invoke("minimize_window")}
        aria-label="Minimize"
        title="Minimize"
      >
        <Minus />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 text-muted-foreground [-webkit-app-region:no-drag]"
        onClick={() => void invoke("toggle_window_maximize")}
        aria-label="Maximize"
        title="Maximize"
      >
        <SquareIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 text-muted-foreground hover:bg-destructive hover:text-white [-webkit-app-region:no-drag]"
        onClick={() => void invoke("close_window")}
        aria-label="Close"
        title="Close"
      >
        <X />
      </Button>
    </div>
  );
}

function PanelResizeHandle({
  side,
  divider = false,
  resizing = false,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onDoubleClick,
}: {
  side: "left" | "right";
  /** 该边界是否需要常显分隔线（右侧面板与聊天列同底色时用）。 */
  divider?: boolean;
  /** 是否正在拖这个手柄（:hover 在 pointer capture 期间可能失效）。 */
  resizing?: boolean;
  onPointerDown: (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      className={cn(
        "panel-resize-handle relative z-[5] min-h-0 min-w-0 cursor-col-resize touch-none bg-transparent outline-none max-[920px]:hidden",
      )}
      data-divider={divider ? "true" : undefined}
      data-resizing={resizing ? "true" : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side === "left" ? "projects" : "context"} panel`}
      tabIndex={0}
      onPointerDown={(event) => onPointerDown(side, event)}
      onPointerMove={(event) => onPointerMove(side, event)}
      onPointerUp={(event) => onPointerUp(side, event)}
      onDoubleClick={onDoubleClick}
    />
  );
}

/* 窄列收纳菜单：Thinking 档位与语音入口在 container query 窄档里从工具行收进来，
   保证工具行任何宽度都保持单行（不折两行）。 */
function ComposerOverflowMenu({
  thinkingLevel,
  disabled,
  onThinkingLevelChange,
  supportedThinkingLevels,
}: {
  thinkingLevel: ThinkingLevel;
  disabled?: boolean;
  onThinkingLevelChange: (thinkingLevel: ThinkingLevel) => void;
  supportedThinkingLevels?: ThinkingLevel[];
}) {
  const t = useT();
  // 只在桥根本没下发档位表时才兜底回固定列表；空数组是「这个模型一档都没有」（映射全清空），
  // 必须照实渲染成空菜单，不能兜回七档。
  const levels = supportedThinkingLevels ?? thinkingLevels;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="composer-tool-button composer-tool-overflow"
          type="button"
          disabled={disabled}
          aria-label={t("composer.moreTools")}
          title={t("composer.moreTools")}
        >
          <MoreHorizontal size={19} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[230px]">
        <DropdownMenuLabel>{t("thinking.label")}</DropdownMenuLabel>
        {levels.map((level) => (
          <DropdownMenuItem
            key={level}
            className="items-start gap-2"
            onSelect={() => onThinkingLevelChange(level)}
          >
            <Check
              className={cn("mt-0.5 size-4 shrink-0", level === thinkingLevel ? "opacity-100" : "opacity-0")}
            />
            <span className="flex min-w-0 flex-col items-start gap-0.5">
              <strong className="font-medium">{thinkingLevelLabel(level)}</strong>
              <small className="text-xs text-muted-foreground">{thinkingLevelDescription(level)}</small>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* 与工具行里被收起的语音按钮保持同一入口（暂未开放）。 */}
        <DropdownMenuItem disabled>
          <Mic className="size-4 shrink-0" />
          <span>{t("composer.voiceInput")}</span>
          <span className="ml-auto text-xs text-muted-foreground">{t("common.comingSoon")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThinkingLevelSelect({
  value,
  disabled,
  onChange,
  supportedThinkingLevels,
}: {
  value: ThinkingLevel;
  disabled?: boolean;
  onChange: (thinkingLevel: ThinkingLevel) => void;
  supportedThinkingLevels?: ThinkingLevel[];
}) {
  const t = useT();
  // 同上：空数组不兜底，缺字段（旧桥）才用固定列表。
  const levels = supportedThinkingLevels ?? thinkingLevels;
  return (
    <div className="thinking-level-select inline-flex min-w-0 items-center gap-2 pr-0.5 pl-1" title={t("thinking.sessionTitle")}>
      <span
        className={cn(
          "thinking-level-label text-xs font-bold whitespace-nowrap text-muted-foreground",
          disabled && "opacity-50",
        )}
      >
        {t("thinking.label")}
      </span>
      <Select value={value} onValueChange={(next) => onChange(next as ThinkingLevel)} disabled={disabled}>
        {/* The trigger renders the label itself rather than using SelectValue:
            Radix mirrors the whole selected item into the trigger, which would
            drag each level's description in with it. */}
        <SelectTrigger size="sm" className="h-[30px] w-26" aria-label={t("thinking.sessionTitle")}>
          <span className="truncate">{thinkingLevelLabel(value)}</span>
        </SelectTrigger>
        <SelectContent position="popper" align="start" sideOffset={4}>
          {levels.map((level) => (
            <SelectItem key={level} value={level}>
              <span className="flex flex-col items-start gap-0.5">
                <strong className="font-medium">{thinkingLevelLabel(level)}</strong>
                <small className="text-xs text-muted-foreground">{thinkingLevelDescription(level)}</small>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function thinkingLevelLabel(level: ThinkingLevel) {
  if (level === "xhigh") {
    return "X High";
  }

  return level.charAt(0).toUpperCase() + level.slice(1);
}

function thinkingLevelDescription(level: ThinkingLevel) {
  if (level === "off") {
    return "Fastest responses";
  }
  if (level === "minimal") {
    return "Light reasoning";
  }
  if (level === "low") {
    return "Quick reasoning";
  }
  if (level === "medium") {
    return "Balanced reasoning";
  }
  if (level === "high") {
    return "Deep reasoning";
  }
  if (level === "xhigh") {
    return "Extra deep reasoning";
  }
  return "Maximum reasoning";
}

function SettingsModal({
  open,
  onOpenChange,
  models,
  onModelsChanged,
  personalization,
  onSavePersonalization,
  appearance,
  onAppearanceChange,
  archivedSessions,
  onUnarchiveSession,
  onDeleteArchivedSession,
  onDeleteAllArchivedSessions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 自定义模型清单：与输入框旁的切换器共用，设置页保存后这里同步。 */
  models: CustomModelsController;
  onModelsChanged: () => void;
  personalization: PersonalizationSettings;
  onSavePersonalization: (settings: PersonalizationSettings) => Promise<void>;
  /** 配色主题；和明暗一样属于 UI 偏好，改完立即生效，不走下面的保存按钮。 */
  appearance: UiAppearance;
  onAppearanceChange: (appearance: UiAppearance) => void;
  /** 归档会话（跨项目），归「归档聊天」页唯一使用。 */
  archivedSessions: ArchivedSessionSummary[];
  onUnarchiveSession: (projectId: string, sessionPath: string) => Promise<void>;
  onDeleteArchivedSession: (projectId: string, sessionPath: string) => Promise<void>;
  onDeleteAllArchivedSessions: (projectId?: string) => Promise<void>;
}) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<"models" | "personalization" | "archived" | "notifications">("models");
  const [personalizationDraft, setPersonalizationDraft] = useState(personalization);
  const [isSavingPersonalization, setIsSavingPersonalization] = useState(false);

  useEffect(() => {
    setPersonalizationDraft(personalization);
  }, [personalization]);

  async function savePersonalizationSettings() {
    setIsSavingPersonalization(true);
    try {
      await onSavePersonalization(personalizationDraft);
    } finally {
      setIsSavingPersonalization(false);
    }
  }

  // 每个分区都有 `settings.heading.<tab>`：加分区时不需要再扩一条嵌套三元。
  const heading = t(`settings.heading.${activeTab}`);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* sm:max-w-none is not redundant: DialogContent's base classes end with
          sm:max-w-lg, and tailwind-merge keeps it alongside an unprefixed
          max-w-none, so the sm: variant would clamp the dialog to 512px. */}
      <DialogContent
        showCloseButton={false}
        className="settings-dialog grid h-[min(88svh,760px)] w-[min(92vw,1180px)] max-w-none gap-0 overflow-hidden border-border bg-[var(--app-content-surface)] p-0 sm:max-w-none"
      >
        <DialogDescription className="sr-only">
          Configure models, personalization, notifications, and archived chats.
        </DialogDescription>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as typeof activeTab)}
          orientation="vertical"
          className="settings-modal grid min-h-0 grid-cols-[260px_minmax(0,1fr)] gap-0 overflow-hidden"
        >
          {/* The sidebar chrome lives on this wrapper, not on TabsList: the vertical
              tabs variant forces h-fit, so a border on the list itself would stop
              short of the dialog bottom. */}
          <div className="settings-sidebar flex h-full min-h-0 flex-col gap-1 border-r border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2 px-2 pt-1 pb-3 text-sm font-semibold text-foreground">
              <Settings size={18} />
              <span>{t("settings.title")}</span>
            </div>
            <TabsList
              variant="line"
              aria-label={t("settings.sectionsAria")}
              className="w-full items-stretch justify-start gap-1 rounded-none bg-transparent p-0"
            >
              <TabsTrigger value="models" className="h-9 gap-2 px-2">
                <Settings size={18} />
                <span>{t("settings.tab.models")}</span>
              </TabsTrigger>
              <TabsTrigger value="personalization" className="h-9 gap-2 px-2">
                <Sparkles size={18} />
                <span>{t("settings.tab.personalization")}</span>
              </TabsTrigger>
              <TabsTrigger value="archived" className="h-9 gap-2 px-2">
                <Archive size={18} />
                <span>{t("settings.tab.archived")}</span>
                {archivedSessions.length ? (
                  <Badge variant="secondary" className="ml-auto tabular-nums">
                    {archivedSessions.length}
                  </Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="notifications" className="h-9 gap-2 px-2">
                <Bell size={18} />
                <span>{t("settings.tab.notifications")}</span>
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex min-w-0 flex-col overflow-hidden">
            <div className="settings-header flex flex-none items-center justify-between gap-4 border-b border-border px-6 py-4">
              <DialogTitle className="truncate">{heading}</DialogTitle>
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="-mr-2 shrink-0"
                  aria-label={t("settings.close")}
                  title={t("settings.close")}
                >
                  <X />
                </Button>
              </DialogClose>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <TabsContent value="models">
                <CustomModelsSettings models={models} onModelsChanged={onModelsChanged} />
                <p className="mt-4 text-xs text-muted-foreground">
                  {t("models.settings.switchHint")}
                </p>
              </TabsContent>

              <TabsContent value="personalization" className="grid max-w-2xl gap-6">
                {/*
                  主题选择放在最前面，且**立即生效**（不走下面的保存按钮）：
                  主题是 UI 偏好（localStorage），不是 pi 的个性化设置（服务端），
                  而且切换必须能当场看到效果，否则「选一下再保存」体验很怪。
                */}
                <div className="grid gap-2">
                  <Label>{t("settings.appearance.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.appearance.desc")}
                  </p>
                  <div
                    className="grid grid-cols-2 gap-2.5"
                    role="radiogroup"
                    aria-label={t("settings.appearance.label")}
                  >
                    {appearanceOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={appearance === option.value}
                        data-appearance-option={option.value}
                        className={cn(
                          "grid min-w-0 gap-1.5 rounded-md border p-3.5 text-left hover:bg-accent",
                          appearance === option.value && "border-primary bg-accent",
                        )}
                        onClick={() => onAppearanceChange(option.value)}
                      >
                        <strong className="text-sm">{t(option.labelKey)}</strong>
                        <span className="text-xs leading-relaxed text-muted-foreground">
                          {t(option.descKey)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="settings-style">{t("settings.style.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.style.desc")}
                  </p>
                  <Select
                    value={personalizationDraft.style}
                    onValueChange={(value) =>
                      setPersonalizationDraft((current) => ({ ...current, style: value }))
                    }
                  >
                    <SelectTrigger id="settings-style" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {personalizationStyleOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {t(option.labelKey)} - {t(option.descKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="settings-persona">{t("settings.persona.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.persona.desc")}
                  </p>
                  <Textarea
                    id="settings-persona"
                    className="min-h-28"
                    value={personalizationDraft.persona}
                    maxLength={1000}
                    onChange={(event) =>
                      setPersonalizationDraft((current) => ({ ...current, persona: event.target.value }))
                    }
                    placeholder={t("settings.persona.placeholder")}
                  />
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {personalizationDraft.persona.length} / 1000
                  </p>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="settings-instructions">{t("settings.instructions.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.instructions.desc")}
                  </p>
                  <Textarea
                    id="settings-instructions"
                    className="min-h-28"
                    value={personalizationDraft.customInstructions}
                    maxLength={1500}
                    onChange={(event) =>
                      setPersonalizationDraft((current) => ({
                        ...current,
                        customInstructions: event.target.value,
                      }))
                    }
                    placeholder={t("settings.instructions.placeholder")}
                  />
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {personalizationDraft.customInstructions.length} / 1500
                  </p>
                </div>

                <div className="grid gap-2">
                  <Label>{t("settings.extensionUi.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.extensionUi.desc")}
                  </p>
                  <div
                    className="grid grid-cols-2 gap-2.5"
                    role="radiogroup"
                    aria-label={t("settings.extensionUi.label")}
                  >
                    {personalizationExtensionUiOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={personalizationDraft.extensionUi === option.value}
                        className={cn(
                          "grid min-w-0 gap-1.5 rounded-md border p-3.5 text-left hover:bg-accent",
                          personalizationDraft.extensionUi === option.value && "border-primary bg-accent",
                        )}
                        onClick={() =>
                          setPersonalizationDraft((current) => ({ ...current, extensionUi: option.value }))
                        }
                      >
                        <strong className="text-sm">{t(option.labelKey)}</strong>
                        <span className="text-xs leading-relaxed text-muted-foreground">{t(option.descKey)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <Button
                  type="button"
                  className="w-fit"
                  onClick={() => void savePersonalizationSettings()}
                  disabled={isSavingPersonalization}
                >
                  <Save size={16} />
                  {isSavingPersonalization ? t("common.saving") : t("settings.savePersonalization")}
                </Button>
              </TabsContent>

              <TabsContent value="archived">
                <ArchivedChatsSettings
                  sessions={archivedSessions}
                  onUnarchive={onUnarchiveSession}
                  onDelete={onDeleteArchivedSession}
                  onDeleteMany={onDeleteAllArchivedSessions}
                />
              </TabsContent>

              <TabsContent value="notifications">
                <NotificationSettings />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ConversationCapabilitiesSettings({
  capabilities,
  onSetSessionSkill,
  onSetSessionPackage,
  onSetSessionExtension,
}: {
  capabilities: CapabilitiesState;
  onSetSessionSkill: (id: string, enabled: boolean) => Promise<unknown>;
  onSetSessionPackage: (id: string, enabled: boolean) => Promise<unknown>;
  onSetSessionExtension: (id: string, enabled: boolean) => Promise<unknown>;
}) {
  const t = useT();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function toggle(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  function renderRow(
    id: string,
    name: string,
    description: string,
    active: boolean,
    action: () => Promise<unknown>,
  ) {
    return (
      <div
        key={id}
        className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5"
      >
        <div className="grid min-w-0 gap-0.5">
          <strong className="truncate text-sm font-medium">{name}</strong>
          <span className="truncate text-xs text-muted-foreground">{description}</span>
        </div>
        <Switch
          checked={active}
          disabled={Boolean(busy)}
          onCheckedChange={() => void toggle(id, action)}
          aria-label={active ? t("capability.toggleOff", { name }) : t("capability.toggleOn", { name })}
          title={active ? t("capability.toggleOffTitle") : t("capability.toggleOnTitle")}
        />
      </div>
    );
  }

  function renderSectionHeading(title: string, count: number) {
    return (
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
          {count}
        </span>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground">
        {t("capability.sessionOnlyNote")}
      </p>
      {error ? (
        <p className="text-sm text-destructive" role="status">
          {error}
        </p>
      ) : null}
      <section className="grid gap-2">
        {renderSectionHeading("Skills", capabilities.skills.length)}
        {capabilities.skills.length ? capabilities.skills.map((item) => renderRow(
          `skill:${item.id}`,
          item.name,
          item.description || item.path,
          item.active,
          () => onSetSessionSkill(item.id, !item.active),
        )) : <p className="text-sm text-muted-foreground">{t("capability.noSkills")}</p>}
      </section>
      <section className="grid gap-2">
        {renderSectionHeading("Packages", capabilities.packages.length)}
        {capabilities.packages.length ? capabilities.packages.map((item) => renderRow(
          `package:${item.id}`,
          item.name,
          item.source,
          item.active,
          () => onSetSessionPackage(item.id, !item.active),
        )) : <p className="text-sm text-muted-foreground">{t("capability.noPackages")}</p>}
      </section>
      <section className="grid gap-2">
        {renderSectionHeading("Extensions", capabilities.extensions.length)}
        {capabilities.extensions.length ? capabilities.extensions.map((item) => renderRow(
          `extension:${item.id}`,
          item.name,
          item.path,
          item.active,
          () => onSetSessionExtension(item.id, !item.active),
        )) : <p className="text-sm text-muted-foreground">{t("capability.noExtensions")}</p>}
      </section>
    </div>
  );
}

function slashMenuItemKey(item: SlashMenuItem) {
  return item.kind === "skill" ? `skill:${item.id}` : `command:${item.packageId}:${item.name}`;
}

function SlashMenu({
  items,
  highlightIndex,
  onSelect,
  onHighlight,
}: {
  items: SlashMenuItem[];
  highlightIndex: number;
  onSelect: (item: SlashMenuItem) => void;
  onHighlight: (index: number) => void;
}) {
  const t = useT();
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    itemRefs.current[highlightIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, items]);

  const entries = items.map((item, index) => ({ item, index }));
  const skills = entries.filter((entry) => entry.item.kind === "skill");
  const commands = entries.filter((entry) => entry.item.kind === "command");

  const renderRow = ({ item, index }: { item: SlashMenuItem; index: number }) => (
    <button
      key={slashMenuItemKey(item)}
      ref={(node) => {
        itemRefs.current[index] = node;
      }}
      type="button"
      role="option"
      aria-selected={index === highlightIndex}
      onClick={() => onSelect(item)}
      onMouseEnter={() => onHighlight(index)}
      className={`capability-picker-row ${index === highlightIndex ? "is-active" : ""}`}
    >
      <span className={`capability-dot ${item.kind === "skill" ? "skill" : "command"}`}>
        {item.kind === "skill" ? "S" : "/"}
      </span>
      <span className="slash-menu-row-text">
        <strong>{item.name}</strong>
        {item.description ? <small>{item.description}</small> : null}
      </span>
      {item.kind === "command" ? <small className="slash-menu-package">{item.packageName}</small> : null}
    </button>
  );

  const renderSkills = skills.length ? (
    <div className="slash-menu-section">
      <p className="slash-menu-section-label">{t("capability.slashMenu.skills", { count: skills.length })}</p>
      {skills.map(renderRow)}
    </div>
  ) : null;

  const renderCommands = commands.length ? (
    <div className="slash-menu-section">
      <p className="slash-menu-section-label">{t("capability.slashMenu.commands", { count: commands.length })}</p>
      {commands.map(renderRow)}
    </div>
  ) : null;

  // 分组顺序由 items 决定（buildSlashMenuItems 已把含最佳匹配的分组排前面）。
  const commandsFirst = items[0]?.kind === "command";

  return (
    <div className="capability-picker slash-menu" role="listbox" aria-label={t("capability.slashMenu.aria")}>
      {commandsFirst ? renderCommands : renderSkills}
      {commandsFirst ? renderSkills : renderCommands}
      {!items.length ? <p className="empty-text">{t("capability.slashMenu.empty")}</p> : null}
    </div>
  );
}
const CAPABILITY_TAB_META: Record<CapabilityScopeTab, { label: string; Icon: typeof BookOpen }> = {
  skill: { label: "Skills", Icon: BookOpen },
  package: { label: "Packages", Icon: Folder },
};

/**
 * pi 官方的 Package 目录。全局页与项目面板各有一个入口，共用这一个常量，避免两处各自
 * 硬编码 URL 后漂移。
 */
const PACKAGE_CATALOG_URL = "https://pi.dev/packages";

/**
 * A request to inspect one resource type of one package. The dialog fetches on demand, so this is
 * just what the click already knew.
 */
type PackageResourcesRequest = { item: CapabilityPackage; type: CapabilityPackageResourceType };

/** The committed result of the two reads the dialog needs: the list, plus one file's preview. */
type PackageResourcesLoaded = {
  entries: CapabilityPackageResourceEntry[];
  /** The list request itself failed (nothing was resolved for the type). */
  listError: string;
  /** Selected file with its committed preview; a non-empty `error` means the read failed. */
  file: { path: string; preview: CapabilityPackageFilePreview | null; error: string } | null;
};

/** The skill folder picker: Tauri in the desktop shell, IPC-hosted in Electron. */
async function chooseSkillFolderPath() {
  return invoke<string | null>("choose_skill_folder", { defaultPath: undefined });
}

/**
 * One file at a time, read-only: the server only serves paths pi resolved for this package.
 * Never throws — a failed read is part of the file slot, so callers commit list + content together.
 */
async function loadPackageResourceFile(item: CapabilityPackage, entry: CapabilityPackageResourceEntry) {
  try {
    const preview = await postJson<CapabilityPackageFilePreview>(
      "/api/capabilities/package/file",
      { packageId: item.id, path: entry.path },
    );
    return { path: entry.path, preview, error: "" };
  } catch (nextError) {
    const message = nextError instanceof Error ? nextError.message : String(nextError);
    return { path: entry.path, preview: null, error: message };
  }
}

/**
 * Import a skill folder: pick the scope, then let the server copy it in. Shared by the Global
 * skills & packages page and the project panel, so both offer the same rules — the folder picker is
 * the only part each host runs itself.
 */
function SkillImportDialog({
  path,
  onClose,
  onImport,
}: {
  path: string;
  onClose: () => void;
  onImport: (sourcePath: string, scope: "user" | "project") => Promise<unknown>;
}) {
  const t = useT();
  const [scope, setScope] = useState<"user" | "project">("project");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await onImport(path, scope);
      onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) { onClose(); } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("capability.importScope.title")}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{path}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label={t("capability.importScope.groupAria")}>
          {([
            ["user", t("capability.importScope.user"), t("capability.importScope.userHint")],
            ["project", t("capability.importScope.project"), t("capability.importScope.projectHint")],
          ] as const).map(([value, title, hint]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              className={cn(
                "grid min-w-0 gap-1.5 rounded-md border p-3.5 text-left hover:bg-accent",
                scope === value && "border-primary bg-accent",
              )}
              onClick={() => setScope(value)}
            >
              <strong className="text-sm">{title}</strong>
              <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>
            </button>
          ))}
        </div>
        {error ? <p className="text-sm text-destructive" role="status">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            <Plus />
            {busy ? t("capability.importScope.importing") : t("capability.importScope.import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Install a pi package: source, scope, autoload — the same three choices pi's own CLI asks for.
 * Shared by the Global page and the project panel (which defaults to the project scope) so both
 * surfaces behave identically; pi's install progress is shown here instead of on the host page.
 */
function PackageInstallDialog({
  defaultScope = "user",
  onClose,
  onInstall,
}: {
  defaultScope?: "user" | "project";
  onClose: () => void;
  onInstall: (
    source: string,
    scope: "user" | "project",
    autoload: boolean,
    onProgress: (message: string) => void,
  ) => Promise<unknown>;
}) {
  const t = useT();
  const id = useId();
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"user" | "project">(defaultScope);
  const [autoload, setAutoload] = useState(true);
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    setProgress("");
    try {
      await onInstall(source.trim(), scope, autoload, setProgress);
      onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) { onClose(); } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("capability.detail.installPackage")}</DialogTitle>
          <DialogDescription>{t("capability.detail.fillSourceHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3.5">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-source`}>{t("capability.detail.packageSource")}</Label>
            <Input
              id={`${id}-source`}
              value={source}
              autoFocus
              onChange={(event) => setSource(event.target.value)}
              placeholder={t("capability.detail.packageSourcePlaceholder")}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-scope`}>{t("capability.detail.installScope")}</Label>
            <Select value={scope} onValueChange={(value) => setScope(value as "user" | "project")}>
              <SelectTrigger id={`${id}-scope`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t("capability.detail.scopeUser")}</SelectItem>
                <SelectItem value="project">{t("capability.detail.scopeProject")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-autoload`}
              checked={autoload}
              onCheckedChange={(value) => setAutoload(value === true)}
            />
            <Label htmlFor={`${id}-autoload`}>{t("capability.detail.autoload")}</Label>
          </div>
          {busy && progress ? <p className="text-xs break-all text-muted-foreground" role="status">{progress}</p> : null}
          {error ? <p className="text-sm text-destructive" role="status">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="button" disabled={!source.trim() || busy} onClick={() => void submit()}>
            <Save />
            {t("capability.detail.install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Read-only view of a package's resources: the files pi resolved for one type on the left, the
 * selected file's content on the right.
 *
 * List and first file are both fetched before the dialog renders, so it opens fully populated —
 * opening first and filling in after made the right pane flash through "select a file" → loading
 * → text on every click. A local resolve + read measures 1-4 ms, so the wait is imperceptible.
 */
function PackageResourcesDialog({ request, onClose }: { request: PackageResourcesRequest | null; onClose: () => void }) {
  const t = useT();
  const [loaded, setLoaded] = useState<PackageResourcesLoaded | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (!request) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    setLoaded(null);
    setCopyState("idle");
    void (async () => {
      try {
        const result = await postJson<{ resources: CapabilityPackageResourceDetails }>(
          "/api/capabilities/package/resources",
          { packageId: request.item.id },
        );
        const entries = result.resources?.[request.type] ?? [];
        const file = entries[0] ? await loadPackageResourceFile(request.item, entries[0]) : null;
        if (!cancelled) {
          setLoaded({ entries, listError: "", file });
        }
      } catch (nextError) {
        if (!cancelled) {
          const message = nextError instanceof Error ? nextError.message : String(nextError);
          setLoaded({ entries: [], listError: message, file: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  /** Read first, then swap: the clicked row must not highlight before its content is ready. */
  async function selectFile(entry: CapabilityPackageResourceEntry) {
    if (!request) {
      return;
    }
    setCopyState("idle");
    const file = await loadPackageResourceFile(request.item, entry);
    setLoaded((current) => (current ? { ...current, file } : current));
  }

  async function copyContent() {
    const content = loaded?.file?.preview?.content ?? "";
    if (!content) {
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState((current) => (current === "idle" ? current : "idle")), 1600);
  }

  // Nothing rendered until the content is ready: an open-but-empty dialog is exactly the flash we
  // are avoiding.
  if (!request || !loaded) {
    return null;
  }

  const selectedPath = loaded.file
    ? (loaded.entries.find((entry) => entry.path === loaded.file?.path)?.relativePath ?? loaded.file.path)
    : "";

  return (
    <Dialog open onOpenChange={(next) => { if (!next) { onClose(); } }}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-4xl max-h-[min(86svh,720px)]">
        <DialogHeader>
          <DialogTitle className="min-w-0 break-all text-lg">
            {t("capability.resource.dialogTitle", {
              name: request.item.name,
              type: t(CAPABILITY_RESOURCE_LABEL_KEYS[request.type]),
            })}
          </DialogTitle>
          <DialogDescription>{t("capability.resource.dialogHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
          {/* Left: the files pi resolved for this type. */}
          <div className="grid min-h-0 content-start gap-1 overflow-y-auto rounded-md border p-1.5">
            {loaded.listError ? (
              <p className="px-1.5 py-1 text-sm text-destructive" role="status">
                {t("capability.resource.error", { reason: loaded.listError })}
              </p>
            ) : null}
            {!loaded.listError && loaded.entries.length === 0 ? (
              <p className="px-1.5 py-1 text-sm text-muted-foreground">{t("capability.resource.empty")}</p>
            ) : null}
            {loaded.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                aria-current={loaded.file?.path === entry.path ? "true" : undefined}
                className={cn(
                  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent",
                  loaded.file?.path === entry.path && "bg-accent",
                )}
                onClick={() => void selectFile(entry)}
              >
                <code className="min-w-0 break-all font-mono">{entry.relativePath || entry.path}</code>
                {entry.enabled ? null : <span className="text-[10px] text-muted-foreground">{t("capability.resource.disabled")}</span>}
              </button>
            ))}
          </div>

          {/* Right: read-only content of the selected file, copyable as-is. */}
          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">{selectedPath}</code>
              {loaded.file?.preview && !loaded.file.preview.directory && !loaded.file.preview.binary && loaded.file.preview.content ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="shrink-0"
                  aria-label={t("capability.resource.copy")}
                  title={t("capability.resource.copy")}
                  onClick={() => void copyContent()}
                >
                  {copyState === "copied" ? <Check /> : <ClipboardCopy />}
                  {t(copyState === "copied" ? "capability.resource.copied" : copyState === "failed" ? "capability.resource.copyFailed" : "capability.resource.copy")}
                </Button>
              ) : null}
            </div>
            <div className="min-h-0 overflow-auto rounded-md border bg-muted/40">
              {!loaded.file ? (
                <p className="p-3 text-sm text-muted-foreground">{t("capability.resource.selectFile")}</p>
              ) : loaded.file.error ? (
                <p className="p-3 text-sm text-destructive" role="status">
                  {t("capability.resource.error", { reason: loaded.file.error })}
                </p>
              ) : !loaded.file.preview ? (
                <p className="p-3 text-sm text-muted-foreground">{t("capability.resource.loading")}</p>
              ) : loaded.file.preview.directory ? (
                <p className="p-3 text-sm text-muted-foreground">{t("capability.resource.directory")}</p>
              ) : loaded.file.preview.binary ? (
                <p className="p-3 text-sm text-muted-foreground">
                  {t("capability.resource.binary", { size: formatFileSize(loaded.file.preview.bytes) })}
                </p>
              ) : (
                <pre className="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                  {loaded.file.preview.content}
                  {loaded.file.preview.truncated
                    ? `\n\n${t("capability.resource.truncated", { size: formatFileSize(loaded.file.preview.bytes) })}`
                    : ""}
                </pre>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The capability detail sheet — shared by the Global page and the project panel, so a project skill
 * opens the same SKILL.md preview as a Global one and a project package gets the same
 * source/update view.
 *
 * The sheet owns the two operations it performs itself (reading a skill's content, running pi's
 * package update) together with their progress and errors: the host's error strip sits *behind* a
 * modal, so a failure there is invisible. Capability-level actions (default / pin / delete) still go
 * through the host's handlers, which already exist once per surface.
 */
function CapabilityDetailDialog({
  item,
  busy,
  onClose,
  onSetDefault,
  onSetPinned,
  onDelete,
  onUpdatePackage,
}: {
  item: CapabilityItem;
  /** The host's busy label; this sheet's own operations are tracked locally. */
  busy: string;
  onClose: () => void;
  onSetDefault: (kind: CapabilityKind, id: string, enabled: boolean) => Promise<unknown>;
  onSetPinned: (kind: CapabilityKind, id: string, pinned: boolean) => Promise<unknown>;
  onDelete: (item: CapabilityItem) => void;
  onUpdatePackage: (source?: string, onProgress?: (message: string) => void) => Promise<unknown>;
}) {
  const t = useT();
  const [busyAction, setBusyAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [skillContent, setSkillContent] = useState("");
  const [isReadingSkill, setIsReadingSkill] = useState(false);
  const [updateProgress, setUpdateProgress] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);

  const skillPath = item.kind === "skill" ? item.path : "";

  useEffect(() => {
    if (!skillPath) {
      return;
    }
    let cancelled = false;
    setSkillContent("");
    setIsReadingSkill(true);
    setActionError("");
    void fetchJson<{ content: string }>(`/api/skills/content?path=${encodeURIComponent(skillPath)}`)
      .then((result) => {
        if (!cancelled) {
          setSkillContent(result.content);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setActionError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsReadingSkill(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [skillPath]);

  /** Shared by the three capability-level actions so a failure lands next to them, not behind. */
  function runAction(label: string, action: () => Promise<unknown>) {
    setBusyAction(label);
    setActionError("");
    return action()
      .catch((nextError) => {
        setActionError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => setBusyAction(""));
  }

  async function runUpdate() {
    if (item.kind !== "package") {
      return;
    }
    setIsUpdating(true);
    setActionError("");
    setUpdateProgress("");
    try {
      await onUpdatePackage(item.source, setUpdateProgress);
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setIsUpdating(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) { onClose(); } }}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-3xl max-h-[min(86svh,760px)]">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-3">
            <CapabilityDot kind={item.kind}>{capabilityInitial(item)}</CapabilityDot>
            <span className="min-w-0 break-all text-xl">{item.name}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("capability.detail.detailAndSettings", { name: item.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3.5 overflow-y-auto pr-1">
          <CapabilityActions
            item={item}
            busy={busy || busyAction || (isUpdating ? "package-update" : "")}
            onSetDefault={(kind, id, enabled) => runAction("default", () => onSetDefault(kind, id, enabled))}
            onSetPinned={(kind, id, pinned) => runAction("pin", () => onSetPinned(kind, id, pinned))}
            onDelete={() => onDelete(item)}
          />
          {actionError ? <p className="text-sm text-destructive" role="status">{actionError}</p> : null}
          {item.kind === "skill" ? (
            <>
              <p className="text-sm">{item.description || item.path}</p>
              <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">{item.path}</code>
              {isReadingSkill ? <p className="text-sm text-muted-foreground">{t("capability.detail.readingContent")}</p> : null}
              {skillContent ? <MarkdownContent text={skillContent} /> : null}
            </>
          ) : item.kind === "package" ? (
            <div className="grid gap-1.5">
              <p className="text-sm">{item.description}</p>
              <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">{item.source}</code>
              {isUpdating && updateProgress ? (
                <p className="text-xs break-all text-muted-foreground" role="status">{updateProgress}</p>
              ) : null}
              <div className="flex justify-end">
                <Button type="button" variant="outline" disabled={Boolean(busy) || isUpdating} onClick={() => void runUpdate()}>
                  <RefreshCw />
                  {t("capability.detail.update")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CapabilitiesPage({
  capabilities,
  onSetDefault,
  onSetPinned,
  onDelete,
  onImportSkill,
  onInstallPackage,
  onUpdatePackage,
  onRunPackageCommand,
  customUiCancelVersion,
}: {
  capabilities: CapabilitiesState;
  onSetDefault: (kind: CapabilityKind, id: string, enabled: boolean) => Promise<unknown>;
  onSetPinned: (kind: CapabilityKind, id: string, pinned: boolean) => Promise<unknown>;
  onDelete: (item: CapabilityItem) => Promise<unknown>;
  onImportSkill: (sourcePath: string, scope?: "user" | "project") => Promise<unknown>;
  onInstallPackage: (source: string, scope?: "user" | "project", autoload?: boolean, onProgress?: (message: string) => void) => Promise<unknown>;
  onUpdatePackage: (source?: string, onProgress?: (message: string) => void) => Promise<unknown>;
  onRunPackageCommand: (packageId: string, command: string, args?: string) => Promise<unknown>;
  customUiCancelVersion: number;
}) {
  const t = useT();
  const [tab, setTab] = useState<CapabilityScopeTab>(() => loadUiPreferences().capabilityScopeTab ?? "skill");
  const [selectedKey, setSelectedKey] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CapabilityItem | null>(null);
  const [skillCategory, setSkillCategory] = useState<SkillSourceCategory>("all");
  const [query, setQuery] = useState("");
  const [skillImportPath, setSkillImportPath] = useState("");
  const [isChoosingSkillFolder, setIsChoosingSkillFolder] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [resourceRequest, setResourceRequest] = useState<PackageResourcesRequest | null>(null);

  /** 标签页跟着页面实例一起被卸载，所以把选择写进 ui-preferences；下次进来还停在 Packages。 */
  function selectTab(next: CapabilityScopeTab) {
    setTab(next);
    saveUiPreferences({ capabilityScopeTab: next });
  }

  // This page is the *global* surface: builtin + agent-level skills and
  // user-scope packages. Project-scoped ones belong to the conversation panel.
  const rawItems: CapabilityItem[] = tab === "skill" ? capabilities.skills : capabilities.packages;
  const globalItems = useMemo(() => scopedCapabilityItems(rawItems, "global"), [rawItems]);
  const searchedItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return globalItems.filter((item) => !needle || `${item.name} ${item.description} ${item.kind}`.toLowerCase().includes(needle));
  }, [query, globalItems]);
  const pinnedItems = searchedItems.filter((item) => item.pinned);
  const installedItems = searchedItems.filter((item) => (
    !item.pinned
    && (tab !== "skill" || matchesSkillCategory(item, skillCategory))
  ));
  const selected = globalItems.find((item) => `${item.kind}:${item.id}` === selectedKey);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  /**
   * Removing a capability deletes files on disk, so the card and the detail
   * sheet only *request* it; the actual call runs from the confirmation dialog.
   */
  function requestDelete(item: CapabilityItem) {
    setPendingDelete(item);
  }

  async function confirmDelete() {
    const item = pendingDelete;
    if (!item) {
      return;
    }
    // The prompt stays up while the bridge works — a package delete shells out to
    // `npm uninstall`, which can take tens of seconds, and a prompt that vanishes on
    // click reads as "already done". It closes once the call settles, either way, so a
    // failure still lands in the page's own error strip instead of behind the dialog.
    await run("delete", async () => {
      await onDelete(item);
      setDetailOpen(false);
    });
    setPendingDelete(null);
  }

  /** Only records what was clicked: CapabilityDetailDialog reads the content for both surfaces. */
  function openItem(item: CapabilityItem) {
    setSelectedKey(`${item.kind}:${item.id}`);
    setInstallOpen(false);
    setDetailOpen(true);
  }

  function openNewPackage() {
    setSelectedKey("");
    // Installing lives in its own dialog now; make sure a package detail sheet opened earlier is not
    // left sitting behind it.
    setDetailOpen(false);
    setInstallOpen(true);
  }

  function handlePackageCommand(packageId: string, command: string, args?: string) {
    return run(`package-command:${packageId}:${command}`, () => onRunPackageCommand(packageId, command, args));
  }

  /** The chips only carry counts from the snapshot; entries are resolved when the dialog opens. */
  function openPackageResources(item: CapabilityPackage, type: CapabilityPackageResourceType) {
    setResourceRequest({ item, type });
  }

  async function chooseSkillFolder() {
    setError("");
    setIsChoosingSkillFolder(true);
    try {
      const folder = await chooseSkillFolderPath();
      if (folder) {
        setSkillImportPath(folder);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setIsChoosingSkillFolder(false);
    }
  }

  function closeSkillImport() {
    setSkillImportPath("");
    setError("");
  }

  useEffect(() => {
    if (customUiCancelVersion > 0) {
      setBusy("");
      setError("");
    }
  }, [customUiCancelVersion]);

  const addLabel = tab === "skill"
    ? (isChoosingSkillFolder ? t("capability.market.choosingFolder") : t("capability.market.importSkill"))
    : t("capability.market.installPackage");

  return (
    <section className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-muted" aria-labelledby="capabilities-page-title">
      <header className="flex min-w-0 items-center justify-between gap-[18px] px-6 pt-5 pb-3.5 max-[920px]:flex-col max-[920px]:items-stretch">
        <h1 id="capabilities-page-title" className="sr-only">Global skills &amp; packages</h1>
        <nav className="flex min-w-0 items-center gap-2.5" aria-label={t("capability.market.typeAria")}>
          {CAPABILITY_TABS.map((value) => {
            const { label, Icon } = CAPABILITY_TAB_META[value];

            return (
              <Button
                key={value}
                type="button"
                variant={tab === value ? "default" : "ghost"}
                className="h-10 px-4 font-semibold"
                aria-current={tab === value ? "page" : undefined}
                onClick={() => selectTab(value)}
              >
                <Icon className="size-[18px]" />
                <span>{label}</span>
              </Button>
            );
          })}
        </nav>
        <div className="flex min-w-[280px] items-center justify-end gap-2.5 max-[920px]:min-w-0 max-[920px]:flex-col max-[920px]:items-stretch">
          <Input
            className="h-10 w-[min(100%,280px)] bg-background max-[920px]:w-full"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tab === "skill" ? t("capability.market.searchSkills") : t("capability.market.searchPackages")}
            aria-label={tab === "skill" ? t("capability.market.searchSkills") : t("capability.market.searchPackages")}
          />
          {/* 目录入口只在 Packages 标签下出现：它通向 pi.dev 的 Package 目录，和 Skills 无关。 */}
          {tab === "package" ? (
            <Button
              type="button"
              variant="outline"
              className="h-10 font-semibold"
              onClick={() => void openTarget(PACKAGE_CATALOG_URL)}
              aria-label={t("capability.market.packageCatalog")}
              title={t("capability.market.packageCatalogHint")}
            >
              <ExternalLink />
              {t("capability.market.packageCatalog")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="h-10 font-semibold"
            disabled={tab === "skill" && isChoosingSkillFolder}
            onClick={tab === "skill" ? () => void chooseSkillFolder() : openNewPackage}
          >
            {tab === "skill" ? <FolderOpen /> : <Plus />}
            {addLabel}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] px-6 pb-6 max-[920px]:overflow-y-auto">
        <div className="min-h-0 min-w-0 overflow-y-auto pr-1 max-[920px]:overflow-visible">
          {error ? <p className="mb-3 text-sm text-destructive" role="status">{error}</p> : null}

          {pinnedItems.length ? (
          <section className="mb-[30px] grid gap-3.5">
            <div className="flex min-w-0 items-baseline gap-[18px]">
              <h2 className="text-2xl leading-tight font-semibold">{t("capability.market.pinnedTitle")}</h2>
              <Badge variant="secondary" className="min-w-[26px] text-sm">{pinnedItems.length}</Badge>
            </div>
            <div className="grid min-w-0 grid-cols-3 gap-3.5 max-[1350px]:grid-cols-2 max-[920px]:grid-cols-1">
              {pinnedItems.length ? pinnedItems.map((item) => (
                <CapabilityMarketCard
                  key={`featured:${item.kind}:${item.id}`}
                  item={item}
                  selected={selected?.id === item.id}
                  busy={busy}
                  onOpen={openItem}
                  onOpenResources={openPackageResources}
                  onSetDefault={onSetDefault}
                  onSetPinned={onSetPinned}
                  onDelete={requestDelete}
                  onRunPackageCommand={handlePackageCommand}
                />
              )) : null}
            </div>
          </section>
          ) : null}

          <section className="mb-[30px] grid gap-3.5">
            <div className="flex min-w-0 items-baseline gap-[18px]">
              <h2 className="text-2xl leading-tight font-semibold">{t("capability.market.installedTitle")}</h2>
              <Badge variant="secondary" className="min-w-[26px] text-sm">{installedItems.length}</Badge>
            </div>
            {tab === "skill" ? (
              <div className="flex min-w-0 gap-2 overflow-x-auto pb-0.5" aria-label={t("capability.market.sourceCategoryAria")}>
                {SKILL_SOURCE_CATEGORIES.map((category) => (
                  <Button
                    key={category}
                    type="button"
                    size="sm"
                    variant={skillCategory === category ? "secondary" : "ghost"}
                    className="font-semibold"
                    aria-pressed={skillCategory === category}
                    onClick={() => setSkillCategory(category)}
                  >
                    {t(SKILL_SOURCE_CATEGORY_LABEL_KEYS[category])}
                  </Button>
                ))}
              </div>
            ) : null}
            <div className="grid min-w-0 grid-cols-3 gap-3.5 max-[1350px]:grid-cols-2 max-[920px]:grid-cols-1">
              {installedItems.length ? installedItems.map((item) => (
                <CapabilityMarketCard
                  key={`${item.kind}:${item.id}`}
                  item={item}
                  selected={selected?.id === item.id}
                  busy={busy}
                  onOpen={openItem}
                  onOpenResources={openPackageResources}
                  onSetDefault={onSetDefault}
                  onSetPinned={onSetPinned}
                  onDelete={requestDelete}
                  onRunPackageCommand={handlePackageCommand}
                />
              )) : <p className="text-sm text-muted-foreground">{t("capability.market.noInstalledProjects")}</p>}
            </div>
          </section>

        </div>
      </div>

      {skillImportPath ? (
        <SkillImportDialog path={skillImportPath} onClose={closeSkillImport} onImport={onImportSkill} />
      ) : null}

      {installOpen ? (
        <PackageInstallDialog
          defaultScope="user"
          onClose={() => setInstallOpen(false)}
          onInstall={onInstallPackage}
        />
      ) : null}

      {detailOpen && selected ? (
        <CapabilityDetailDialog
          item={selected}
          busy={busy}
          onClose={() => setDetailOpen(false)}
          onSetDefault={onSetDefault}
          onSetPinned={onSetPinned}
          onDelete={requestDelete}
          onUpdatePackage={onUpdatePackage}
        />
      ) : null}

      <PackageResourcesDialog request={resourceRequest} onClose={() => setResourceRequest(null)} />

      <CapabilityDeleteDialog
        item={pendingDelete}
        busy={busy === "delete"}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}

/**
 * Every destructive capability removal (page cards, detail sheet, context
 * panel) passes through this prompt before anything is deleted from disk.
 */
function CapabilityDeleteDialog({
  item,
  busy = false,
  onCancel,
  onConfirm,
}: {
  item: CapabilityItem | null;
  /** True while the bridge is deleting: a package delete runs `npm uninstall` first. */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <AlertDialog
      open={Boolean(item)}
      onOpenChange={(next) => {
        // Radix asks to close on Action / Cancel / ESC. Once the delete is in flight the prompt
        // has to stay put until it settles, so those close requests are ignored while busy.
        if (!next && !busy) {
          onCancel();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {item?.kind === "package" ? t("capability.delete.packageTitle") : t("capability.delete.skillTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("capability.delete.description", { name: item?.name ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {busy ? (
            <p className="mr-auto flex items-center gap-2 self-center text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("capability.delete.deleting")}
            </p>
          ) : null}
          <AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
            {t("capability.delete.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type CapabilityItem = CapabilitySkill | CapabilityPackage | CapabilityExtension;

/** The project panel's two sections; the id is what UI preferences store as collapsed. */
type CapabilitySectionId = "skills" | "packages";

/** 超过这个数量才给搜索框：更短的列表一整屏就看得见，搜索只是噪音。 */
const CAPABILITY_COMMAND_SEARCH_THRESHOLD = 6;

/**
 * 应用的标题条（AppTitleBar，`z-[100]`，`--titlebar-height` 40px）是浮在内容之上的带子，
 * 而 Radix 只知道视口边界。按钮贴到页面顶部时它会把面板放到标题条底下 —— 2026-09-22 实测：
 * 整条搜索框被盖住，只看得到第一行命令。让 Radix 把顶部当成已有 40px + 8px 间距。
 */
const CAPABILITY_COMMAND_MENU_TOP_INSET = 48;

/**
 * A package's `/` commands collapse into one trigger instead of one button each, so a package
 * with many commands still fits on its card. Shared by the Packages tab cards and the
 * context-panel package rows; both lay it out themselves (the card puts it at the end of the
 * status row, which is the card's bottom-right), so this wrapper adds no alignment of its own.
 *
 * 2026-09-22 用户实测「action 较多的时候显示不全」：19 条命令要 ~530px 的行高，而按钮上方
 * 往往只留得下 ~450px（窗口不高、卡片又在列表底部时更少）。所以这里不指望「一屏放下」——
 * 列表按 Radix 给的真实可用高度滚动（和模型供应商选择器同一套做法），命令多时顶上钉一个
 * 搜索框，滚动条由 AutoHideScroll 自己画（`thumbAlwaysVisible`：macOS 的原生 overlay 滚动条
 * 不滚动就看不见，而这里的截断恰好落在行边界上，看起来就像列表只有这么多）。
 * 不能用 DropdownMenu：它里面放输入框会被菜单的 typeahead / 方向键抢走按键。
 */
function CapabilityCommandMenu({
  commands,
  disabled,
  onRun,
}: {
  commands: CapabilityCommand[];
  disabled?: boolean;
  onRun: (command: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchable = commands.length > CAPABILITY_COMMAND_SEARCH_THRESHOLD;
  const matches = filterPackageCommands(commands, query);

  // 展开就把光标放到能继续操作的地方：有搜索框就进搜索框（展开即打字），短列表落在第一行。
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (searchable) {
        searchRef.current?.focus();
      } else {
        listRef.current?.querySelector<HTMLButtonElement>("[data-command-row]")?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, searchable]);

  function run(name: string) {
    setOpen(false);
    onRun(name);
  }

  /** 上下键在行间走位；搜索框里也走这套，否则光标进了输入框就只能用鼠标。 */
  function moveRow(step: number) {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-command-row]") ?? []);
    if (!rows.length) return;
    const current = rows.findIndex((row) => row === document.activeElement);
    const index = current < 0 ? (step > 0 ? 0 : rows.length - 1) : (current + step + rows.length) % rows.length;
    rows[index]?.focus();
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveRow(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    // 回车 = 执行第一条匹配：搜到就直接回车，不用再点一下。
    if (event.key === "Enter") {
      const first = matches[0];
      if (first) {
        event.preventDefault();
        run(first.name);
      }
    }
  }

  function onRowKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveRow(event.key === "ArrowDown" ? 1 : -1);
  }

  return (
    <div className="flex shrink-0" aria-label="Package commands" onClick={(event) => event.stopPropagation()}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={disabled}
            title={t("capability.card.commandsTitle")}
            aria-label={t("capability.card.commandsAria", { count: commands.length })}
          >
            <Terminal />
            {t("capability.card.actions")}
            <Badge variant="secondary" className="min-w-[18px] px-1 text-[10px]">{commands.length}</Badge>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          collisionPadding={{ top: CAPABILITY_COMMAND_MENU_TOP_INSET, right: 8, bottom: 8, left: 8 }}
          className="flex max-h-[var(--radix-popover-content-available-height,calc(100dvh-6rem))] w-[320px] max-w-(--radix-popover-content-available-width) flex-col overflow-hidden p-1"
        >
          {searchable ? (
            <div className="relative shrink-0 px-1 pt-1 pb-0.5">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                className="h-8 pl-7 text-xs"
                value={query}
                placeholder={t("capability.card.commandsSearch", { count: commands.length })}
                aria-label={t("capability.card.commandsSearchAria")}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
              />
            </div>
          ) : null}
          <AutoHideScroll className="min-h-0 flex-1" thumbAlwaysVisible>
            <div
              ref={listRef}
              aria-label={t("capability.card.commandsAria", { count: commands.length })}
              className="grid content-start gap-0.5 p-1"
            >
              {matches.length ? matches.map((command) => (
                <button
                  key={command.name}
                  type="button"
                  data-command-row
                  className="flex w-full min-w-0 cursor-default items-baseline gap-2 rounded-sm px-2 py-1.5 text-left outline-hidden select-none hover:bg-accent focus-visible:bg-accent"
                  onClick={() => run(command.name)}
                  onKeyDown={onRowKeyDown}
                >
                  <span className="min-w-0 shrink-0 font-mono text-xs">/{command.name}</span>
                  {command.description ? (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{command.description}</span>
                  ) : null}
                </button>
              )) : (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("capability.card.commandsEmpty")}</p>
              )}
            </div>
          </AutoHideScroll>
        </PopoverContent>
      </Popover>
    </div>
  );
}

const CAPABILITY_RESOURCE_LABEL_KEYS: Record<CapabilityPackageResourceType, string> = {
  extensions: "capability.resource.extensions",
  skills: "capability.resource.skills",
  prompts: "capability.resource.prompts",
  themes: "capability.resource.themes",
};

/**
 * What a package actually ships, straight from pi's own resolution: four chips with counts. A
 * chip with entries opens the detail dialog; an empty one is disabled so a click cannot promise
 * a list that does not exist.
 */
function CapabilityResourceChips({
  item,
  onOpen,
  compact = false,
}: {
  item: CapabilityPackage;
  onOpen: (item: CapabilityPackage, type: CapabilityPackageResourceType) => void;
  /**
   * Panel rows are narrow and read as a list, not as a market grid: drop the empty types and the
   * pill padding so a package shows one short line of what it actually ships.
   */
  compact?: boolean;
}) {
  const t = useT();
  const types = CAPABILITY_PACKAGE_RESOURCE_TYPES.filter(
    (type) => !compact || (item.resources?.[type] ?? 0) > 0,
  );

  if (!types.length) {
    return null;
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {types.map((type) => {
        const count = item.resources?.[type] ?? 0;
        const label = t(CAPABILITY_RESOURCE_LABEL_KEYS[type]);
        const title = t("capability.resource.openAria", { type: label, count });
        return (
          <button
            key={type}
            type="button"
            disabled={count === 0}
            aria-label={title}
            title={title}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border border-transparent bg-secondary px-1.5 text-secondary-foreground",
              compact ? "py-0 text-[10.5px] font-normal" : "py-0.5 text-[11px] font-medium",
              count > 0 ? "cursor-pointer hover:border-border hover:bg-accent" : "opacity-45",
            )}
            onClick={() => onOpen(item, type)}
          >
            {label}
            <span className="tabular-nums opacity-70">{count}</span>
          </button>
        );
      })}
    </span>
  );
}

function CapabilityMarketCard({
  item,
  selected,
  busy,
  onOpen,
  onOpenResources,
  onSetDefault,
  onSetPinned,
  onDelete,
  onRunPackageCommand,
}: {
  item: CapabilityItem;
  selected: boolean;
  busy: string;
  onOpen: (item: CapabilityItem) => void;
  onOpenResources: (item: CapabilityPackage, type: CapabilityPackageResourceType) => void;
  onSetDefault: (kind: CapabilityKind, id: string, enabled: boolean) => Promise<unknown>;
  onSetPinned: (kind: CapabilityKind, id: string, pinned: boolean) => Promise<unknown>;
  onDelete: (item: CapabilityItem) => void;
  onRunPackageCommand: (packageId: string, command: string, args?: string) => Promise<unknown>;
}) {
  const t = useT();
  return (
    <Card
      className={cn(
        "min-h-[150px] cursor-pointer gap-[18px] rounded-lg border-transparent py-5 shadow-sm hover:border-border",
        selected && "border-border",
      )}
      onClick={() => onOpen(item)}
    >
      <div className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)_auto] items-start gap-x-3.5 gap-y-2 px-5">
        <CapabilityDot kind={item.kind}>{capabilityInitial(item)}</CapabilityDot>
        <div className="grid min-w-0 content-start justify-items-start gap-1">
          <strong className="line-clamp-2 min-w-0 max-w-full break-words text-base leading-tight">{item.name}</strong>
          {item.kind === "extension" ? (
            <Badge variant="secondary">standalone</Badge>
          ) : null}
          {item.kind === "skill" && item.disableModelInvocation ? <Badge variant="secondary">工具</Badge> : null}
        </div>
        <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
          {item.kind === "package" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              disabled={Boolean(busy)}
              onClick={() => onOpen(item)}
              aria-label={t("capability.card.openSettings")}
              title={t("capability.card.openSettings")}
            >
              <Settings />
            </Button>
          ) : null}
          {canDeleteCapability(item) ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              disabled={Boolean(busy)}
              onClick={() => onDelete(item)}
              aria-label={t("capability.context.delete")}
              title={t("capability.context.delete")}
            >
              <Trash2 />
            </Button>
          ) : null}
          <Button
            type="button"
            variant={item.pinned ? "secondary" : "ghost"}
            size="icon-sm"
            className="size-7"
            disabled={Boolean(busy)}
            onClick={() => void onSetPinned(item.kind, item.id, !item.pinned)}
            aria-label={item.pinned ? t("capability.card.unpin") : t("capability.card.pin")}
            title={item.pinned ? t("capability.card.unpin") : t("capability.card.pin")}
          >
            <Pin />
          </Button>
          <Switch
            checked={item.defaultEnabled}
            disabled={Boolean(busy)}
            onCheckedChange={(next) => void onSetDefault(item.kind, item.id, next)}
            aria-label={item.defaultEnabled ? t("capability.card.disableAutoload") : t("capability.card.enableAutoload")}
            title={item.defaultEnabled ? t("capability.card.disableAutoload") : t("capability.card.enableAutoload")}
          />
        </div>
        {/* 资源 tag 独占一行并横跨整卡：留在中间列时宽度只有 119–205px，四个 tag 需要 ~287px，
            结果就是 tag 换行、而操作列下方那一整片空间空着（操作只有一行高）。 */}
        {item.kind === "package" ? (
          <div className="col-span-3 min-w-0">
            <CapabilityResourceChips item={item} onOpen={onOpenResources} />
          </div>
        ) : null}
      </div>
      <p className="line-clamp-2 min-h-0 px-5 text-sm leading-relaxed break-words text-muted-foreground">
        {item.description || (item.kind === "package" ? item.source : item.path)}
      </p>
      <div className="mt-auto grid min-w-0 gap-2.5 px-5">
        {item.kind === "package" && item.loadErrors.length > 0 ? (
          <p className="line-clamp-3 rounded-md bg-secondary/60 px-2.5 py-1.5 font-mono text-xs break-words text-destructive" role="status">
            {item.loadErrors.join(t("capability.card.loadErrorsSeparator"))}
          </p>
        ) : null}
        {/* Status text and the command menu share one row: the menu sits in the card's
            bottom-right, not floating on a row of its own. */}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{item.kind === "package" ? (item.autoload ? t("capability.card.autoloadOn") : t("capability.card.autoloadOff")) : capabilitySourceLabel(item)}</span>
            <span className={capabilityLoadClass(item)} title={item.kind === "package" ? item.loadErrors.join("\n") : undefined}>
              {capabilityLoadLabel(item)}
            </span>
          </div>
          {item.kind === "package" && item.commands.length > 0 ? (
            <CapabilityCommandMenu
              commands={item.commands}
              disabled={Boolean(busy)}
              onRun={(command) => void onRunPackageCommand(item.id, command)}
            />
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function CapabilityDot({ kind, children }: { kind: CapabilityKind; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex size-10 min-w-10 items-center justify-center rounded-full text-sm font-bold",
        kind === "extension" ? "bg-secondary text-secondary-foreground" : "bg-primary text-primary-foreground",
      )}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

function capabilityInitial(item: CapabilityItem) {
  if (item.kind === "package") return "P";
  if (item.kind === "extension") return "E";
  return item.name.trim().slice(0, 1).toUpperCase() || "S";
}

/**
 * `active` only means "this session selected it". Whether pi really put its extensions in the
 * session is a separate fact (`loadStatus`), and conflating the two is what let an installed
 * package sit invisible in the session while the panel still glowed green.
 */
function capabilityLoadLabel(item: CapabilityItem): string {
  if (item.kind === "package") {
    switch (item.loadStatus) {
      case "loaded":
        return item.loadedTools.length > 0
          ? t(item.loadedTools.length === 1 ? "capability.state.loadedWithTools.one" : "capability.state.loadedWithTools.other", { count: item.loadedTools.length })
          : t("capability.state.loaded");
      case "failed":
        return t("capability.state.loadFailed");
      case "missing":
        return t("capability.state.notLoadedAutoload");
      case "disabled":
        return t("capability.state.disabled");
      case "not-installed":
        return t("capability.state.noEntry");
      default:
        return item.active ? t("capability.state.enabled") : t("capability.state.disabled");
    }
  }
  if (item.kind === "extension" && typeof item.loaded === "boolean") {
    return item.loaded ? t("capability.state.loaded") : item.active ? t("capability.state.enabledNotLoaded") : t("capability.state.notLoaded");
  }
  return item.active ? t("capability.state.enabled") : t("capability.state.disabled");
}

function capabilityLoadClass(item: CapabilityItem): string {
  if (item.kind !== "package") {
    return item.active ? "text-muted-foreground" : "text-muted-foreground";
  }
  if (item.loadStatus === "failed") {
    return "font-medium text-destructive";
  }
  if (item.loadStatus === "missing" || item.loadStatus === "not-installed") {
    return "font-medium text-amber-900 dark:text-amber-200";
  }
  return "text-muted-foreground";
}

/**
 * Conversation context panel: only what *this project* brings in. The open/close
 * switch fires the very same `onSetDefault` call the Global skills & packages
 * cards use, so both surfaces always agree on the stored default.
 */
function ProjectCapabilitiesPanel({
  capabilities,
  projectName,
  onSetDefault,
  onSetPinned,
  onDelete,
  onImportSkill,
  onInstallPackage,
  onUpdatePackage,
  onRunPackageCommand,
}: {
  capabilities: CapabilitiesState;
  /** 面板只列项目级能力，标题里却全是 Skills / Packages —— 用项目名把归属说清楚。 */
  projectName: string;
  onSetDefault: (kind: CapabilityKind, id: string, enabled: boolean) => Promise<unknown>;
  onSetPinned: (kind: CapabilityKind, id: string, pinned: boolean) => Promise<unknown>;
  onDelete: (item: CapabilityItem) => Promise<unknown>;
  onImportSkill: (sourcePath: string, scope?: "user" | "project") => Promise<unknown>;
  onInstallPackage: (source: string, scope?: "user" | "project", autoload?: boolean, onProgress?: (message: string) => void) => Promise<unknown>;
  onUpdatePackage: (source?: string, onProgress?: (message: string) => void) => Promise<unknown>;
  onRunPackageCommand: (packageId: string, command: string, args?: string) => Promise<unknown>;
}) {
  const t = useT();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<CapabilityItem | null>(null);
  const [query, setQuery] = useState("");
  const [skillImportPath, setSkillImportPath] = useState("");
  const [isChoosingSkillFolder, setIsChoosingSkillFolder] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [resourceRequest, setResourceRequest] = useState<PackageResourcesRequest | null>(null);
  /** The row the detail sheet is open for; both kinds click through to the same sheet as the page. */
  const [selected, setSelected] = useState<CapabilityItem | null>(null);
  // Folded sections are remembered across restarts, same as the settings page's provider groups.
  const [collapsedSections, setCollapsedSections] = useState<CapabilitySectionId[]>(
    () => (loadUiPreferences().capabilityPanelCollapsedSections ?? []) as CapabilitySectionId[],
  );
  const projectSkills = useMemo(() => scopedCapabilityItems(capabilities.skills, "project"), [capabilities.skills]);
  const projectPackages = useMemo(() => scopedCapabilityItems(capabilities.packages, "project"), [capabilities.packages]);
  const searchedSkills = useMemo(
    () => projectSkills.filter((item) => matchesCapabilityQuery(item, query)),
    [projectSkills, query],
  );
  const searchedPackages = useMemo(
    () => projectPackages.filter((item) => matchesCapabilityQuery(item, query)),
    [projectPackages, query],
  );

  async function toggle(item: CapabilityItem, enabled: boolean) {
    setBusy(`${item.kind}:${item.id}`);
    setError("");
    try {
      await onSetDefault(item.kind, item.id, enabled);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  function runPackageCommand(packageId: string, command: string) {
    setBusy(`package-command:${packageId}:${command}`);
    setError("");
    onRunPackageCommand(packageId, command).catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }).finally(() => setBusy(""));
  }

  /** Same two-step contract as the page: request here, delete only on confirm. */
  async function confirmDelete() {
    const item = pendingDelete;
    if (!item) {
      return;
    }
    // Same as the page: hold the prompt (with its "deleting" state) until the bridge answers.
    setSelected(null);
    setBusy("delete");
    setError("");
    try {
      await onDelete(item);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
      setPendingDelete(null);
    }
  }

  /** Same flow as the Global page: choose a folder first, then pick the scope in the dialog. */
  async function chooseSkillFolder() {
    setError("");
    setIsChoosingSkillFolder(true);
    try {
      const folder = await chooseSkillFolderPath();
      if (folder) {
        setSkillImportPath(folder);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setIsChoosingSkillFolder(false);
    }
  }

  /**
   * Both sections fold independently, and the fold is remembered in UI preferences (same idea as
   * the settings page's provider groups) so reopening the panel keeps the shape the user left it in.
   */
  function toggleSection(section: CapabilitySectionId) {
    setCollapsedSections((current) => {
      const next = current.includes(section)
        ? current.filter((id) => id !== section)
        : [...current, section];
      saveUiPreferences({ capabilityPanelCollapsedSections: next });
      return next;
    });
  }

  function renderSection(
    section: CapabilitySectionId,
    title: string,
    items: CapabilityItem[],
    emptyText: string,
    action: ReactNode,
  ) {
    return (
      <CapabilityPanelSection
        key={section}
        title={title}
        count={items.length}
        collapsed={collapsedSections.includes(section)}
        onToggleCollapsed={() => toggleSection(section)}
        action={action}
      >
        {items.length ? items.map((item) => {
          const key = `${item.kind}:${item.id}`;
          const label = item.defaultEnabled ? t("capability.state.turnOff") : t("capability.state.turnOn");

          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              className="flex cursor-pointer items-start justify-between gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              onClick={() => setSelected(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelected(item);
                }
              }}
            >
              <div className="grid min-w-0 gap-1">
                <strong className="truncate text-[13px] font-medium">{item.name}</strong>
                <span className="truncate text-[12px] text-muted-foreground">
                  {item.kind === "package" ? item.source : item.description || item.path}
                </span>
                {/* Same four resource types as the Global page's package cards, minus the empty
                    ones + the pill padding — a narrow panel row is a list, not a market grid. */}
                {item.kind === "package" && item.resources ? (
                  <CapabilityResourceChips
                    compact
                    item={item}
                    onOpen={(pkg, type) => setResourceRequest({ item: pkg, type })}
                  />
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 pt-0.5" onClick={(event) => event.stopPropagation()}>
                {item.kind === "package" && item.commands.length > 0 ? (
                  <CapabilityCommandMenu
                    commands={item.commands}
                    disabled={Boolean(busy)}
                    onRun={(command) => runPackageCommand(item.id, command)}
                  />
                ) : null}
                {canDeleteCapability(item) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 text-muted-foreground"
                    disabled={Boolean(busy)}
                    onClick={() => setPendingDelete(item)}
                    aria-label={t("capability.context.delete")}
                    title={t("capability.context.delete")}
                  >
                    <Trash2 className="size-[15px]" />
                  </Button>
                ) : null}
                <Switch
                  checked={item.defaultEnabled}
                  disabled={Boolean(busy)}
                  onCheckedChange={(next) => void toggle(item, next)}
                  aria-label={`${label} ${item.name}`}
                  title={t("capability.state.effectiveAfterToggle", { action: label })}
                />
              </div>
            </div>
          );
        }) : <p className="px-1 py-1 text-[12.5px] text-muted-foreground">{query.trim() ? t("capability.state.noMatch") : emptyText}</p>}
      </CapabilityPanelSection>
    );
  }

  return (
    <>
      {error ? <p className="mb-3 text-sm text-destructive" role="status">{error}</p> : null}
      {/* 面板和全局页的 section 名完全一样（Skills / Packages），光看标题分不出范围。
          所以在搜索框上方常驻一行「项目级 · <项目名>」+ 一句来源提示。 */}
      <div className="mb-2.5 grid min-w-0 gap-0.5" title={t("capability.context.scopeHintTitle")}>
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant="secondary" className="h-[18px] shrink-0 rounded px-1.5 text-[10.5px] font-medium">
            {t("capability.context.scopeBadge")}
          </Badge>
          <span className="min-w-0 truncate text-[12px] font-medium text-foreground">{projectName}</span>
        </div>
        <p className="min-w-0 text-[11px] text-muted-foreground">{t("capability.context.scopeHint")}</p>
      </div>
      <Input
        className="mb-3 h-8 bg-background text-[13px]"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("capability.context.searchPlaceholder")}
        aria-label={t("capability.context.searchAria")}
      />
      {renderSection("skills", t("capability.section.skills"), searchedSkills, t("capability.context.noSkills"), (
        // Icon-only + tooltip, like the left sidebar's “new project”: a labelled outline button
        // dominates a panel this narrow.
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-mr-1 size-7 shrink-0 text-muted-foreground"
          disabled={isChoosingSkillFolder}
          onClick={() => void chooseSkillFolder()}
          aria-label={t("capability.market.importSkill")}
          title={isChoosingSkillFolder ? t("capability.market.choosingFolder") : t("capability.market.importSkill")}
        >
          <FolderOpen className="size-[17px]" />
        </Button>
      ))}
      {renderSection("packages", t("capability.section.packages"), searchedPackages, t("capability.context.noPackages"), (
        <div className="flex shrink-0 items-center gap-0.5">
          {/* 面板这里和全局页的 Packages 一样，给一个通向 pi.dev 目录的入口。 */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0 text-muted-foreground"
            onClick={() => void openTarget(PACKAGE_CATALOG_URL)}
            aria-label={t("capability.market.packageCatalog")}
            title={t("capability.market.packageCatalogHint")}
          >
            <ExternalLink className="size-[17px]" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-1 size-7 shrink-0 text-muted-foreground"
            onClick={() => setInstallOpen(true)}
            aria-label={t("capability.market.installPackage")}
            title={t("capability.market.installPackage")}
          >
            <Plus className="size-[17px]" />
          </Button>
        </div>
      ))}
      <CapabilityDeleteDialog
        item={pendingDelete}
        busy={busy === "delete"}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
      {skillImportPath ? (
        <SkillImportDialog path={skillImportPath} onClose={() => setSkillImportPath("")} onImport={onImportSkill} />
      ) : null}
      {installOpen ? (
        <PackageInstallDialog
          defaultScope="project"
          onClose={() => setInstallOpen(false)}
          onInstall={onInstallPackage}
        />
      ) : null}
      <PackageResourcesDialog request={resourceRequest} onClose={() => setResourceRequest(null)} />
      {selected ? (
        <CapabilityDetailDialog
          item={selected}
          busy={busy}
          onClose={() => setSelected(null)}
          onSetDefault={onSetDefault}
          onSetPinned={onSetPinned}
          onDelete={setPendingDelete}
          onUpdatePackage={onUpdatePackage}
        />
      ) : null}
    </>
  );
}

function CapabilityActions({
  item,
  busy,
  onSetDefault,
  onSetPinned,
  onDelete,
}: {
  item: CapabilityItem;
  busy: string;
  onSetDefault: (kind: CapabilityKind, id: string, enabled: boolean) => Promise<unknown>;
  onSetPinned: (kind: CapabilityKind, id: string, pinned: boolean) => Promise<unknown>;
  onDelete: (item: CapabilityItem) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap justify-start gap-2" onClick={(event) => event.stopPropagation()}>
      <Button
        type="button"
        variant={item.defaultEnabled ? "default" : "secondary"}
        size="sm"
        disabled={Boolean(busy)}
        aria-pressed={item.defaultEnabled}
        onClick={() => void onSetDefault(item.kind, item.id, !item.defaultEnabled)}
      >
        {t("capability.context.defaultBadge")}
      </Button>
      <Button
        type="button"
        variant={item.pinned ? "default" : "secondary"}
        size="icon-sm"
        disabled={Boolean(busy)}
        aria-pressed={item.pinned}
        onClick={() => void onSetPinned(item.kind, item.id, !item.pinned)}
        aria-label={item.pinned ? t("capability.card.unpin") : t("capability.card.pin")}
        title={item.pinned ? t("capability.card.unpin") : t("capability.card.pin")}
      >
        <Pin />
      </Button>
      {canDeleteCapability(item) ? (
        <Button
          type="button"
          variant="destructive"
          size="icon-sm"
          disabled={Boolean(busy)}
          onClick={() => onDelete(item)}
          aria-label={t("capability.context.delete")}
          title={t("capability.context.delete")}
        >
          <Trash2 />
        </Button>
      ) : null}
    </div>
  );
}

/** Show the hover card only after the pointer settles on a row. */
const hoverCardShowDelay = 300;
/** Grace period for moving from a row onto its interactive project card. */
const hoverCardHideGrace = 200;
/**
 * Temporarily hidden: pinning a project persists `pinned` but nothing reads it yet (projects are
 * not reordered by it, and the row badge is the only visible change), so the menu item and the
 * hover-card button promise an effect they do not have. Flip to `true` to bring both back once
 * project pinning actually changes the sidebar order.
 */
const projectPinActionsVisible: boolean = false;

type SidebarHoverCardState =
  | {
      kind: "session";
      x: number;
      y: number;
      side: "right" | "left";
      title: string;
      preview: string;
      project: string;
      time: string;
    }
  | { kind: "project"; x: number; y: number; side: "right" | "left"; project: ProjectSummary };

function ProjectSidebar({
  isOpen = false,
  collapsed = false,
  isBootstrapped,
  projects,
  activeProjectId,
  activeSessionPath,
  streamingSessionPaths,
  isBusy,
  onCreateProject,
  onUpdateProject,
  onPinProject,
  onReorderProjects,
  onRemoveProject,
  onRevealProject,
  onCreateSession,
  onUpdateSession,
  onPinSession,
  onArchiveSession,
  onDeleteSession,
  onSelectSession,
  onFocusComposer,
  activeMainView,
  onOpenCapabilities,
  onOpenSettings,
  theme,
  onToggleTheme,
  onOpenChat,
}: {
  isOpen?: boolean;
  collapsed?: boolean;
  isBootstrapped: boolean;
  projects: ProjectSummary[];
  activeProjectId: string;
  activeSessionPath?: string;
  streamingSessionPaths: string[];
  isBusy: boolean;
  onCreateProject: (name: string, cwd: string) => Promise<CreateProjectResult>;
  onUpdateProject: (projectId: string, name: string, cwd: string) => Promise<void>;
  onPinProject: (projectId: string, pinned: boolean) => Promise<void>;
  onReorderProjects: (projectIds: string[]) => Promise<void>;
  onRemoveProject: (projectId: string) => Promise<void>;
  onRevealProject: (projectId: string) => Promise<void>;
  onCreateSession: (projectId?: string, name?: string) => Promise<void>;
  onUpdateSession: (projectId: string, sessionPath: string, name: string) => Promise<void>;
  onPinSession: (projectId: string, sessionPath: string, pinned: boolean) => Promise<void>;
  onArchiveSession: (projectId: string, sessionPath: string) => Promise<void>;
  /** 弹窗里的「直接删除」：不归档，直接删会话文件。 */
  onDeleteSession: (projectId: string, sessionPath: string) => Promise<void>;
  onSelectSession: (projectId: string, sessionPath: string, traceId?: string) => Promise<void>;
  /** 新建会话就绪后把焦点交回 composer（不然焦点会留在侧栏按钮上）。 */
  onFocusComposer: () => void;
  activeMainView: "chat" | "capabilities";
  onOpenCapabilities: () => void;
  onOpenSettings: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenChat: () => void;
}) {
  const t = useT();
  const projectSidebarPreferencesRef = useRef(loadUiPreferences());
  const [dialog, setDialog] = useState<SidebarDialog | null>(null);
  // The main-area error banner sits *behind* this modal, so project dialogs keep
  // their own failure message next to the submit button.
  const [projectSubmitError, setProjectSubmitError] = useState<string | null>(null);
  const [editingSession, setEditingSession] = useState<{ projectId: string; sessionPath: string; title: string } | null>(null);
  const [showPinned, setShowPinned] = useState(() => projectSidebarPreferencesRef.current.projectSidebarShowPinned);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const [isSidebarStateRestored, setIsSidebarStateRestored] = useState(false);
  const [sessionDisplayLimits, setSessionDisplayLimits] = useState<Record<string, number>>({});
  const [projectDropTarget, setProjectDropTarget] = useState<{ projectId: string; position: "before" | "after" } | null>(null);
  const [projectDragPreview, setProjectDragPreview] = useState<{ name: string; x: number; y: number } | null>(null);
  // Dropping a folder anywhere on the sidebar opens "New project" prefilled with
  // it. `dragenter`/`dragleave` fire for every descendant, so visibility is kept
  // by a depth counter, not by the events themselves (same trick as the composer).
  const [isProjectFolderDragOver, setIsProjectFolderDragOver] = useState(false);
  const projectFolderDragDepthRef = useRef(0);
  const projectDragRef = useRef<{
    projectId: string;
    name: string;
    startX: number;
    startY: number;
    pointerId: number;
    dragging: boolean;
  } | null>(null);
  const projectDropTargetRef = useRef<typeof projectDropTarget>(null);
  const skipNextProjectClickRef = useRef(false);
  // Conversation the user clicked and whose response has not landed yet. Kept in a
  // ref too so the click guard reads the same value the render does.
  const [pendingSwitchSessionPath, setPendingSwitchSessionPath] = useState<string | null>(null);
  const pendingSwitchSessionPathRef = useRef<string | null>(null);
  // Hover preview cards (ported from codex-ui): the session card explains what a
  // conversation is about, the project card exposes pin / path / Edit project without
  // selecting the project. Timers mirror codex-ui: 300ms before showing, 200ms grace
  // when leaving a project row so the pointer can travel onto its (interactive) card.
  const sidebarRef = useRef<HTMLElement | null>(null);
  const hoverShowTimerRef = useRef(0);
  const hoverHideTimerRef = useRef(0);
  // The card is fixed-positioned outside the scrolling list, so DOM containment cannot tell
  // us whether the pointer is still on it (see `pointerKeepsSidebarCardOpen`). Remember the
  // two rects involved — the open card and the row that opened it — so pointer coordinates
  // can keep it alive across the gap between them.
  const hoverCardRef = useRef<HTMLDivElement | null>(null);
  const hoverAnchorRef = useRef<HTMLElement | null>(null);
  const [hoverCard, setHoverCard] = useState<SidebarHoverCardState | null>(null);
  const revealLabel = t(platformRevealFolderLabelKey());
  const sidebarLock = resolveProjectSidebarLock({ isBootstrapping: isBusy, pendingSessionPath: pendingSwitchSessionPath });
  // Drag-a-folder-to-create-a-project is Electron-only: it is the one host whose
  // preload can turn a dropped folder into an absolute path. Elsewhere the drop
  // would only carry a name, i.e. exactly the manual re-pick this feature exists
  // to avoid, so the sidebar does not offer (or accept) it at all.
  const folderDropEnabled = supportsDroppedFolderPaths(window.__PI_DESKTOP_FILES__);
  const pinnedSessions = projects.flatMap((project) =>
    project.sessions
      .filter((session) => session.pinned)
      .map((session) => ({
        projectId: project.id,
        projectName: project.name,
        session,
      })),
  );

  useEffect(() => {
    if (!isSidebarStateRestored) {
      return;
    }

    saveUiPreferences({
      projectSidebarShowPinned: showPinned,
      projectSidebarExpandedProjectIds: [...expandedProjectIds],
    });
  }, [expandedProjectIds, isSidebarStateRestored, showPinned]);

  useEffect(() => {
    if (!isBootstrapped || isSidebarStateRestored) {
      return;
    }

    const projectIds = new Set(projects.map((project) => project.id));
    const savedProjectIds = projectSidebarPreferencesRef.current.projectSidebarExpandedProjectIds;
    setExpandedProjectIds(new Set(
      savedProjectIds
        ? savedProjectIds.filter((projectId) => projectIds.has(projectId))
        : projectIds.has(activeProjectId) ? [activeProjectId] : [],
    ));
    setIsSidebarStateRestored(true);
  }, [activeProjectId, isBootstrapped, isSidebarStateRestored, projects]);

  useEffect(() => {
    if (!isSidebarStateRestored) {
      return;
    }

    const projectIds = new Set(projects.map((project) => project.id));
    setExpandedProjectIds((current) => {
      const next = new Set([...current].filter((projectId) => projectIds.has(projectId)));
      return next.size === current.size ? current : next;
    });
  }, [isSidebarStateRestored, projects]);

  async function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog) {
      return;
    }

    setProjectSubmitError(null);

    if (dialog.kind === "create-project") {
      const result = await onCreateProject(dialog.name, dialog.cwd);
      // Failure (or a stale guess about the folder): keep the dialog open so the
      // user can fix the path instead of watching nothing happen.
      if (!result.ok) {
        setProjectSubmitError(result.error ?? "Could not create the project.");
        return;
      }
    }

    if (dialog.kind === "edit-project") {
      await onUpdateProject(dialog.project.id, dialog.name, dialog.cwd);
    }

    setDialog(null);
  }

  async function confirmDialog() {
    if (!dialog) {
      return;
    }

    if (dialog.kind === "remove-project") {
      await onRemoveProject(dialog.project.id);
    }

    if (dialog.kind === "archive-session") {
      // 归档会切换活动会话（归档的就是当前会话时），失败则让全局错误条接住 ——
      // 弹窗此时已经收掉，错误条可见。
      try {
        await onArchiveSession(dialog.projectId, dialog.sessionPath);
      } finally {
        setDialog(null);
      }
      return;
    }

    setDialog(null);
  }

  /** 同一弹窗里的第二个出口：不归档，直接删文件（不可恢复）。 */
  function deleteSessionForever() {
    if (dialog?.kind !== "archive-session") {
      return;
    }
    void onDeleteSession(dialog.projectId, dialog.sessionPath);
    setDialog(null);
  }

  async function commitSessionTitle() {
    if (!editingSession) {
      return;
    }

    const title = editingSession.title.trim();
    if (title) {
      await onUpdateSession(editingSession.projectId, editingSession.sessionPath, title);
    }
    setEditingSession(null);
  }

  function hideHoverCard() {
    window.clearTimeout(hoverShowTimerRef.current);
    window.clearTimeout(hoverHideTimerRef.current);
    setHoverCard(null);
  }

  function placeHoverCard(element: HTMLElement, cardWidth: number, cardHeight: number) {
    const row = element.getBoundingClientRect();
    const sidebar = sidebarRef.current?.getBoundingClientRect();
    return placeSidebarHoverCard(
      { top: row.top, left: row.left, right: row.right },
      {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        sidebarRight: sidebar ? sidebar.right : row.right,
        cardWidth,
        cardHeight,
      },
    );
  }

  function showSessionCard(
    element: HTMLElement,
    session: ProjectSummary["sessions"][number],
    projectName: string,
  ) {
    window.clearTimeout(hoverShowTimerRef.current);
    window.clearTimeout(hoverHideTimerRef.current);
    const position = placeHoverCard(element, SIDEBAR_SESSION_CARD_WIDTH, SIDEBAR_SESSION_CARD_HEIGHT);
    hoverAnchorRef.current = element;
    hoverShowTimerRef.current = window.setTimeout(() => {
      setHoverCard({
        kind: "session",
        ...position,
        title: session.title,
        preview: sidebarSessionPreview(session.title, session.firstMessage),
        project: projectName,
        time: formatSidebarRelativeTime(session.updatedAt),
      });
    }, hoverCardShowDelay);
  }

  function showProjectCard(element: HTMLElement, project: ProjectSummary) {
    window.clearTimeout(hoverShowTimerRef.current);
    window.clearTimeout(hoverHideTimerRef.current);
    const position = placeHoverCard(element, SIDEBAR_PROJECT_CARD_WIDTH, SIDEBAR_PROJECT_CARD_HEIGHT);
    hoverAnchorRef.current = element;
    const delay = hoverCard?.kind === "project" && hoverCard.project.id === project.id ? 0 : hoverCardShowDelay;
    hoverShowTimerRef.current = window.setTimeout(() => {
      setHoverCard({ kind: "project", ...position, project });
    }, delay);
  }

  /** Leaving a row: wait briefly so the pointer can reach an interactive card. */
  function scheduleHideHoverCard() {
    window.clearTimeout(hoverShowTimerRef.current);
    window.clearTimeout(hoverHideTimerRef.current);
    hoverHideTimerRef.current = window.setTimeout(() => setHoverCard(null), hoverCardHideGrace);
  }

  // While a card is open the pointer, not DOM mouseleave, decides whether it stays. The card
  // is `position: fixed` beside the sidebar while the row it describes sits inside it: moving
  // onto the card means crossing a gap that belongs to neither element, and the browser fires
  // the row/aside `mouseleave` in that gap — which used to unmount the card before the pointer
  // could ever reach it. Coordinates survive the gap; `pointerKeepsSidebarCardOpen` also keeps
  // the corridor between the two rects alive so a slow pointer still lands on the card.
  useEffect(() => {
    if (!hoverCard) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      const rects = [
        hoverCardRef.current?.getBoundingClientRect(),
        hoverAnchorRef.current?.getBoundingClientRect(),
      ];
      if (pointerKeepsSidebarCardOpen(event.clientX, event.clientY, rects)) {
        window.clearTimeout(hoverHideTimerRef.current);
        return;
      }
      scheduleHideHoverCard();
    };

    window.addEventListener("pointermove", onPointerMove);
    // Losing the window while the pointer rests on the card fires no mouseleave at all (the
    // session card is pointer-events-none), so the card would otherwise hang around until
    // the pointer moves again.
    window.addEventListener("blur", hideHoverCard);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", hideHoverCard);
    };
  }, [hoverCard]);

  useEffect(() => () => {
    window.clearTimeout(hoverShowTimerRef.current);
    window.clearTimeout(hoverHideTimerRef.current);
  }, []);

  function toggleProject(projectId: string) {
    const isExpanding = !expandedProjectIds.has(projectId);
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (!isExpanding) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
    if (isExpanding) {
      setSessionDisplayLimits((limits) => ({
        ...limits,
        [projectId]: initialProjectSessionLimit,
      }));
    }
  }

  function showMoreSessions(projectId: string) {
    setSessionDisplayLimits((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? initialProjectSessionLimit) + additionalProjectSessionLimit,
    }));
  }

  function handleProjectPointerDown(event: ReactPointerEvent<HTMLButtonElement>, projectId: string) {
    if (event.button !== 0 || sidebarLock.locked) {
      return;
    }

    projectDragRef.current = {
      projectId,
      name: projects.find((project) => project.id === projectId)?.name ?? "Project",
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      dragging: false,
    };
  }

  useEffect(() => {
    async function finishProjectPointerDrag() {
      const drag = projectDragRef.current;
      const dropTarget = projectDropTargetRef.current;
      projectDragRef.current = null;
      projectDropTargetRef.current = null;
      setProjectDropTarget(null);
      setProjectDragPreview(null);

      if (!drag?.dragging) {
        return;
      }

      skipNextProjectClickRef.current = true;
      if (!dropTarget || dropTarget.projectId === drag.projectId) {
        return;
      }

      const projectIds = projects.map((project) => project.id);
      const sourceIndex = projectIds.indexOf(drag.projectId);
      const targetIndex = projectIds.indexOf(dropTarget.projectId);
      if (sourceIndex < 0 || targetIndex < 0) {
        return;
      }

      projectIds.splice(sourceIndex, 1);
      const nextTargetIndex = projectIds.indexOf(dropTarget.projectId);
      projectIds.splice(dropTarget.position === "after" ? nextTargetIndex + 1 : nextTargetIndex, 0, drag.projectId);
      await onReorderProjects(projectIds);
    }

    function handlePointerMove(event: PointerEvent) {
      const drag = projectDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }

      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (!drag.dragging && distance < 6) {
        return;
      }

      drag.dragging = true;
      event.preventDefault();
      setProjectDragPreview({ name: drag.name, x: event.clientX, y: event.clientY });

      const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-project-drop-section]"));
      let closestBoundary: { projectId: string; position: "before" | "after"; distance: number } | null = null;
      for (const section of sections) {
        const targetProjectId = section.dataset.projectDropSection;
        if (!targetProjectId || targetProjectId === drag.projectId) {
          continue;
        }

        const bounds = section.getBoundingClientRect();
        const topDistance = Math.abs(event.clientY - bounds.top);
        const bottomDistance = Math.abs(event.clientY - bounds.bottom);
        const boundary = topDistance <= bottomDistance
          ? { position: "before" as const, distance: topDistance }
          : { position: "after" as const, distance: bottomDistance };
        if (boundary.distance > projectDropBoundarySize || (closestBoundary && boundary.distance >= closestBoundary.distance)) {
          continue;
        }

        closestBoundary = { projectId: targetProjectId, ...boundary };
      }

      if (!closestBoundary) {
        projectDropTargetRef.current = null;
        setProjectDropTarget(null);
        return;
      }

      const nextTarget: { projectId: string; position: "before" | "after" } = {
        projectId: closestBoundary.projectId,
        position: closestBoundary.position,
      };
      projectDropTargetRef.current = nextTarget;
      setProjectDropTarget(nextTarget);
    }

    function handlePointerUp(event: PointerEvent) {
      const drag = projectDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }

      void finishProjectPointerDrag();
    }

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [onReorderProjects, projects]);

  function handleProjectClick(projectId: string) {
    if (skipNextProjectClickRef.current) {
      skipNextProjectClickRef.current = false;
      return;
    }

    toggleProject(projectId);
  }

  function createSessionFromSidebar(projectId: string) {
    // Switch the main area first, then create: while the Global skills & packages
    // page is open the sidebar is the only thing that would otherwise react to the
    // click, so the new conversation would look like it never happened.
    onOpenChat();
    // The server creates the conversation *and selects it*, but a collapsed project
    // would hide the row that shows it: expand synchronously, so by the time the
    // bootstrap lands the new (highlighted) session is already on screen.
    setExpandedProjectIds((current) => expandProjectForNewSession(current, projectId));
    // bootstrap 落地（新会话已被选中）后把焦点交给 composer：点「＋」的人十有八九
    // 接下来就是要打字，焦点留在侧栏按钮上还得再点一次输入框。
    // capabilities 页此时已被 onOpenChat() 切走，会话区不再 inert，focus 能生效。
    void onCreateSession(projectId).then(() => onFocusComposer());
  }

  async function selectSessionFromSidebar(projectId: string, sessionPath: string) {
    // `/api/sessions/select` has no ordering guarantee, so a second switch started
    // while the first is still in flight can be answered by the older payload.
    if (sidebarLock.locked) {
      return;
    }

    // 点已经打开的那一行不是「切换」（selectSession 会提前返回）：这种点击不该把焦点
    // 从用户当前所在的位置抢到 composer。
    const switchesSession = sessionPath !== activeSessionPath;

    // Stamp before the switch renders: every message of the other session is
    // history and must not replay its entrance animation.
    markThreadSwitch();
    const traceId = createId("session-switch");
    reportDiagnostic("client.session_switch.click", {
      traceId,
      projectId,
      sessionPath,
    });
    onOpenChat();
    pendingSwitchSessionPathRef.current = sessionPath;
    setPendingSwitchSessionPath(sessionPath);
    try {
      await onSelectSession(projectId, sessionPath, traceId);
    } finally {
      if (pendingSwitchSessionPathRef.current === sessionPath) {
        pendingSwitchSessionPathRef.current = null;
        setPendingSwitchSessionPath(null);
      }
    }
    // 和侧栏「＋」新建会话一样，切换完成后把焦点交回 composer：点开一段对话十有八九就是
    // 要接着打字，焦点留在侧栏行上还得再点一次输入框。放在 finally 之后，pending 状态先
    // 清掉，composer 才是可输入的那个。
    if (switchesSession) {
      onFocusComposer();
    }
  }

  /** Open "New project" for the folder a sidebar drop carried. */
  function openProjectDialogForDrop(dataTransfer: DataTransfer) {
    const folder = pickDroppedProjectFolder(collectDroppedItems(dataTransfer, window.__PI_DESKTOP_FILES__));
    // A folder is only actionable when we know where it is: the dialog's whole
    // point is not asking the user to pick the folder they just dropped.
    if (!folder?.path) {
      return;
    }

    hideHoverCard();
    setProjectSubmitError(null);
    setDialog({ kind: "create-project", name: folder.name, cwd: folder.path });
  }

  function handleFolderDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!folderDropEnabled || !hasDraggedFiles(event) || sidebarLock.locked) {
      return;
    }
    event.preventDefault();
    projectFolderDragDepthRef.current += 1;
    setIsProjectFolderDragOver(true);
  }

  function handleFolderDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!folderDropEnabled || !hasDraggedFiles(event) || sidebarLock.locked) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleFolderDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!folderDropEnabled || !hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    projectFolderDragDepthRef.current = Math.max(0, projectFolderDragDepthRef.current - 1);
    if (projectFolderDragDepthRef.current === 0) {
      setIsProjectFolderDragOver(false);
    }
  }

  function handleFolderDrop(event: ReactDragEvent<HTMLElement>) {
    // Hosts without the Electron path bridge do not own this drop: leave it to the
    // window guard (which stops navigation) instead of claiming it silently.
    if (!folderDropEnabled || !hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    projectFolderDragDepthRef.current = 0;
    setIsProjectFolderDragOver(false);

    if (sidebarLock.locked) {
      return;
    }
    openProjectDialogForDrop(event.dataTransfer);
  }

  return (
    <aside
      ref={sidebarRef}
      className={cn(
        "project-sidebar-surface relative flex min-h-0 min-w-0 flex-col overflow-hidden",
        // Collapsed visibility is owned by this component rather than by a
        // descendant rule on the shell, so it no longer depends on the shell.
        collapsed && "invisible pointer-events-none",
        "max-[920px]:fixed max-[920px]:top-[var(--titlebar-height)] max-[920px]:bottom-0 max-[920px]:left-0 max-[920px]:z-20 max-[920px]:w-[min(88vw,340px)] max-[920px]:-translate-x-[105%] max-[920px]:shadow-[var(--app-shadow-drawer-right)] max-[920px]:transition-transform",
        isOpen && "max-[920px]:visible max-[920px]:translate-x-0 max-[920px]:pointer-events-auto",
      )}
      aria-label={t("sidebar.projectsAria")}
      onMouseLeave={scheduleHideHoverCard}
      onDragEnter={handleFolderDragEnter}
      onDragOver={handleFolderDragOver}
      onDragLeave={handleFolderDragLeave}
      onDrop={handleFolderDrop}
    >
      {isProjectFolderDragOver ? (
        <div
          className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-[color:var(--app-drop-accent)] bg-background/85 px-4 text-center text-[13px] font-medium text-foreground backdrop-blur-sm"
          aria-hidden="true"
        >
          {t("sidebar.dropFolderToCreateProject")}
        </div>
      ) : null}
      <AutoHideScroll className="flex-1" onScroll={hideHoverCard}>
        {/* Acting on a row must close its preview immediately: after a click the pointer is
            still over the row (so no mouseleave ever fires) and the card would otherwise
            hang there until the pointer moves away. Capturing pointerdown covers every
            control in the list — select, expand, pin, archive, the "…" menu, drag start —
            and deliberately sits on the list, not the aside, so the interactive project
            card (rendered outside this block) keeps working. */}
        <div className="px-2.5 pt-4 pb-3" onPointerDownCapture={hideHoverCard}>
        <section className="mb-3">
          <button
            type="button"
            className={cn(
              "flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13.5px] transition-colors hover:bg-accent",
              activeMainView === "capabilities" && "bg-accent text-accent-foreground",
            )}
            onClick={onOpenCapabilities}
            aria-label={t("sidebar.capabilitiesNav")}
            aria-pressed={activeMainView === "capabilities"}
          >
            <Wrench className="size-[18px] shrink-0 text-muted-foreground" />
            <span className="truncate">{t("sidebar.capabilitiesNav")}</span>
          </button>
        </section>

        {pinnedSessions.length ? (
          <section className="mb-1">
            <button
              className="flex w-fit max-w-full items-center gap-1 px-2 pt-4 pb-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
              type="button"
              onClick={() => setShowPinned((value) => !value)}
            >
              <span>{t("sidebar.pinned")}</span>
              <ChevronRight className={cn("size-3.5 transition-transform", showPinned ? "rotate-90" : "")} />
            </button>
            {showPinned ? (
              <div className="grid gap-0.5">
                {pinnedSessions.map(({ projectId, projectName, session }) => (
                  <SidebarSessionRow
                    key={session.path}
                    projectId={projectId}
                    projectName={projectName}
                    session={session}
                    activeSessionPath={activeSessionPath}
                    isStreaming={streamingSessionPaths.includes(session.path)}
                    isPending={sidebarLock.pendingSessionPath === session.path}
                    editingSession={editingSession}
                    setEditingSession={setEditingSession}
                    commitSessionTitle={commitSessionTitle}
                    onSelectSession={selectSessionFromSidebar}
                    onPinSession={onPinSession}
                    onHoverSession={showSessionCard}
                    onHoverEnd={scheduleHideHoverCard}
                    onArchive={(title) => setDialog({ kind: "archive-session", projectId, sessionPath: session.path, title })}
                  />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        <div className="mt-2 mb-1 flex items-center justify-between gap-2 px-2">
          <span className="text-[12.5px] text-muted-foreground">{t("sidebar.projects")}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setDialog({ kind: "create-project", name: "", cwd: "" })}
            disabled={sidebarLock.locked}
            className={cn("-mr-1 size-7 text-muted-foreground", sidebarLock.lockClass)}
            aria-label={t("sidebar.newProject")}
            title={t("sidebar.newProject")}
          >
            <Plus className="size-[17px]" />
          </Button>
        </div>

        {projects.map((project) => {
          const visibleSessions = project.sessions.filter((session) => !session.pinned);
          const isExpanded = expandedProjectIds.has(project.id);
          const sessionDisplayLimit = sessionDisplayLimits[project.id] ?? initialProjectSessionLimit;
          const displayedSessions = visibleSessions.slice(0, sessionDisplayLimit);
          const hasMoreSessions = displayedSessions.length < visibleSessions.length;
          return (
            <section key={project.id} className="relative mb-0.5" data-project-drop-section={project.id}>
              {projectDropTarget?.projectId === project.id && projectDropTarget.position === "before" ? (
                <div className="pointer-events-none absolute -top-1 left-2 right-2 z-10 h-2" aria-hidden="true">
                  <div className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-[var(--app-drop-accent)]" />
                  <div className="absolute left-0 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[color:var(--app-drop-accent)] bg-background" />
                </div>
              ) : null}
              <div
                className="group relative"
                onMouseEnter={(event) => showProjectCard(event.currentTarget, project)}
                onMouseLeave={scheduleHideHoverCard}
              >
                <button
                  className={cn(
                    "flex h-8 w-full min-w-0 cursor-grab items-center gap-2 rounded-lg py-1 pr-2 pl-2 text-left text-[13.5px] transition-colors group-hover:pr-[54px] group-focus-within:pr-[54px] hover:bg-accent active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-65",
                    // No selected state: a project row is a group header for its sessions, not a
                    // navigable item. Which project is active is already said by the main area.
                    // Pinned rows keep their actions on show (codex-ui `.project-row-wrap.pinned`),
                    // so the label permanently gives up the icon slot instead of shifting on hover.
                    project.pinned && "pr-[54px]",
                    sidebarLock.lockClass,
                  )}
                  type="button"
                  onPointerDown={(event) => handleProjectPointerDown(event, project.id)}
                  onClick={() => handleProjectClick(project.id)}
                  disabled={sidebarLock.locked}
                  aria-expanded={isExpanded}
                  title={project.cwd}
                >
                  {/* Expanded projects switch to the open folder so the state is readable
                      without the chevron codex-ui omits. */}
                  {isExpanded ? (
                    <SidebarFolderOpenIcon size={16} className="shrink-0 text-muted-foreground" />
                  ) : (
                    <SidebarFolderIcon size={16} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{project.name}</span>
                  {project.pinned ? <SidebarPinIcon size={14} className="shrink-0 text-muted-foreground" /> : null}
                </button>
                {/* Row actions are one cluster, not two islands: a 16px glyph inside `icon-sm`'s
                    32px hit area is padded by 8px per side, which pushed the pin/delete pair
                    34px apart. 24px (`size-6`) with no gap between them leaves 4px per side, so
                    the two glyphs sit ~8px apart and read as a single group. */}
                <div className={cn("absolute top-1/2 right-1 flex -translate-y-1/2 items-center", sidebarHoverActionClass, project.pinned && "opacity-100")}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={sidebarLock.locked}
                        className={cn("size-6", sidebarLock.lockClass)}
                        aria-label={t("sidebar.projectMenu")}
                        title={t("sidebar.projectMenu")}
                      >
                        <MoreHorizontal className="size-[18px]" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      {projectPinActionsVisible ? (
                        <DropdownMenuItem onSelect={() => void onPinProject(project.id, !project.pinned)}>
                          <SidebarPinIcon size={16} />
                          {project.pinned ? t("sidebar.unpinProject") : t("sidebar.pinProject")}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem onSelect={() => void onRevealProject(project.id)}>
                        <FolderOpen />
                        {revealLabel}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setDialog({ kind: "edit-project", project, name: project.name, cwd: project.cwd })}>
                        <Settings />
                        {t("sidebar.editProject")}
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ kind: "remove-project", project })}>
                        <Trash2 />
                        {t("dialog.removeAction")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => createSessionFromSidebar(project.id)}
                    disabled={sidebarLock.locked}
                    className={cn("size-6", sidebarLock.lockClass)}
                    aria-label={t("sidebar.newSession")}
                    title={t("sidebar.newSession")}
                  >
                    <SidebarNewSessionIcon size={16} />
                  </Button>
                </div>
              </div>
              {isExpanded ? (
                <div className="grid gap-0.5">
                  {displayedSessions.map((session) => (
                    <SidebarSessionRow
                      key={session.path}
                      projectId={project.id}
                      projectName={project.name}
                      session={session}
                      activeSessionPath={activeSessionPath}
                      isStreaming={streamingSessionPaths.includes(session.path)}
                      isPending={sidebarLock.pendingSessionPath === session.path}
                      editingSession={editingSession}
                      setEditingSession={setEditingSession}
                      commitSessionTitle={commitSessionTitle}
                      onSelectSession={selectSessionFromSidebar}
                      onPinSession={onPinSession}
                      onHoverSession={showSessionCard}
                      onHoverEnd={scheduleHideHoverCard}
                      onArchive={(title) => setDialog({ kind: "archive-session", projectId: project.id, sessionPath: session.path, title })}
                    />
                  ))}
                  {hasMoreSessions ? (
                    <button
                      type="button"
                      className="w-full rounded-lg py-1.5 pr-2 pl-9 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      onClick={() => showMoreSessions(project.id)}
                    >
                      {t("sidebar.showMore")}
                    </button>
                  ) : null}
                  {visibleSessions.length ? null : <p className="py-1 pr-2 pl-9 text-xs text-muted-foreground">{t("sidebar.noSessions")}</p>}
                </div>
              ) : null}
              {projectDropTarget?.projectId === project.id && projectDropTarget.position === "after" ? (
                <div className="pointer-events-none absolute -bottom-1 left-2 right-2 z-10 h-2" aria-hidden="true">
                  <div className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-[var(--app-drop-accent)]" />
                  <div className="absolute left-0 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[color:var(--app-drop-accent)] bg-background" />
                </div>
              ) : null}
            </section>
          );
        })}
        </div>
      </AutoHideScroll>

      {hoverCard ? (
        <div
          ref={hoverCardRef}
          className={cn(
            "fixed z-[60] rounded-xl border border-border bg-popover text-popover-foreground shadow-[var(--app-shadow-popover)]",
            hoverCard.kind === "session" ? "pointer-events-none w-[258px] p-2.5 text-[13px]" : "w-[300px] py-1 text-[13.5px]",
          )}
          style={{ left: hoverCard.x, top: hoverCard.y }}
          data-sidebar-hover-card={hoverCard.kind}
          onMouseEnter={() => window.clearTimeout(hoverHideTimerRef.current)}
          onMouseLeave={scheduleHideHoverCard}
        >
          {hoverCard.kind === "session" ? (
            <div className="flex items-start gap-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <p className="line-clamp-4 leading-[1.5] break-words">{hoverCard.preview}</p>
                <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                  <SidebarFolderIcon size={14} className="shrink-0" />
                  <span className="truncate">{hoverCard.project}</span>
                </span>
              </div>
              {hoverCard.time ? (
                <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-muted-foreground">
                  <SidebarMonitorIcon size={14} />
                  {hoverCard.time}
                </span>
              ) : null}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 py-1.5 pr-2.5 pl-3">
                <SidebarFolderIcon size={16} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-semibold">{hoverCard.project.name}</span>
                {projectPinActionsVisible ? (
                  <button
                    type="button"
                    className={cn(
                      "inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent",
                      hoverCard.project.pinned ? "text-foreground" : "text-muted-foreground",
                    )}
                    title={hoverCard.project.pinned ? "Unpin project" : "Pin project"}
                    aria-label={`${hoverCard.project.pinned ? "Unpin" : "Pin"} project ${hoverCard.project.name}`}
                    onClick={() => void onPinProject(hoverCard.project.id, !hoverCard.project.pinned)}
                  >
                    <SidebarPinIcon size={15} className={cn(hoverCard.project.pinned && "fill-current")} />
                  </button>
                ) : null}
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5">
                <SidebarMessageIcon size={15} className="shrink-0 text-muted-foreground" />
                <span>{formatSidebarSessionCount(hoverCard.project.sessions.length)}</span>
              </div>
              <div className="my-1 h-px bg-border" />
              {hoverCard.project.cwd ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent"
                  title={hoverCard.project.cwd}
                  aria-label={`${revealLabel}: ${hoverCard.project.cwd}`}
                  onClick={() => {
                    const project = hoverCard.project;
                    hideHoverCard();
                    void onRevealProject(project.id);
                  }}
                >
                  <SidebarFolderIcon size={15} className="shrink-0 text-muted-foreground" />
                  <span className="truncate">{hoverCard.project.cwd}</span>
                </button>
              ) : (
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <SidebarFolderIcon size={15} className="shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">No folder</span>
                </div>
              )}
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent"
                onClick={() => {
                  const project = hoverCard.project;
                  hideHoverCard();
                  setDialog({ kind: "edit-project", project, name: project.name, cwd: project.cwd });
                }}
              >
                <Settings className="size-[15px] shrink-0 text-muted-foreground" />
                <span>Edit project</span>
              </button>
            </>
          )}
        </div>
      ) : null}

      {projectDragPreview ? createPortal(
        <div
          className="pointer-events-none fixed z-[100] flex max-w-[min(280px,calc(100vw-24px))] items-center gap-2 rounded-xl border border-border/70 bg-popover/80 px-3.5 py-2 text-sm font-medium text-popover-foreground opacity-90 shadow-[var(--app-shadow-toast)] backdrop-blur-sm"
          style={{ left: projectDragPreview.x, top: projectDragPreview.y, transform: "translate(-50%, -50%)" }}
          aria-hidden="true"
        >
          <SidebarFolderIcon size={18} className="shrink-0" />
          <span className="truncate">{projectDragPreview.name}</span>
        </div>,
        document.body,
      ) : null}

      <footer className="flex flex-none justify-end gap-1 border-t border-border/70 px-3.5 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))]">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? t("titlebar.toLightTheme") : t("titlebar.toDarkTheme")}
          title={theme === "dark" ? t("titlebar.toLightTheme") : t("titlebar.toDarkTheme")}
        >
          {theme === "dark" ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onOpenSettings} aria-label={t("common.openSettings")} title={t("common.openSettings")}>
          <Settings className="size-[18px]" />
        </Button>
      </footer>

      {dialog ? (
        <SidebarDialogView
          dialog={dialog}
          projects={projects}
          submitError={projectSubmitError}
          onChange={setDialog}
          onCancel={() => {
            setDialog(null);
            setProjectSubmitError(null);
          }}
          onSubmit={submitDialog}
          onConfirm={confirmDialog}
          onDeleteForever={deleteSessionForever}
        />
      ) : null}
    </aside>
  );
}

function SidebarSessionRow({
  projectId,
  projectName,
  session,
  activeSessionPath,
  isStreaming,
  isPending = false,
  editingSession,
  setEditingSession,
  commitSessionTitle,
  onSelectSession,
  onPinSession,
  onArchive,
  onHoverSession,
  onHoverEnd,
}: {
  projectId: string;
  projectName?: string;
  session: ProjectSummary["sessions"][number];
  activeSessionPath?: string;
  isStreaming: boolean;
  /** Clicked but not rendered yet: the row carries the loading cue, not the whole list. */
  isPending?: boolean;
  editingSession: { projectId: string; sessionPath: string; title: string } | null;
  setEditingSession: (value: { projectId: string; sessionPath: string; title: string } | null) => void;
  commitSessionTitle: () => Promise<void>;
  onSelectSession: (projectId: string, sessionPath: string, traceId?: string) => Promise<void>;
  onPinSession: (projectId: string, sessionPath: string, pinned: boolean) => Promise<void>;
  onArchive: (title: string) => void;
  /** Hovering the row asks the sidebar to explain the conversation in a side card. */
  onHoverSession: (
    element: HTMLElement,
    session: ProjectSummary["sessions"][number],
    projectName: string,
  ) => void;
  onHoverEnd: () => void;
}) {
  const t = useT();
  const isActive = session.path === activeSessionPath;
  const isEditing = editingSession?.sessionPath === session.path;
  return (
    <div
      className={cn(
        "group relative flex h-8 w-full min-w-0 cursor-pointer items-center rounded-lg text-[13px] transition-colors",
        isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent",
      )}
      onClick={() => void onSelectSession(projectId, session.path)}
      onMouseEnter={(event) => onHoverSession(event.currentTarget, session, projectName ?? "")}
      onMouseLeave={onHoverEnd}
      title={projectName ? `${projectName} / ${session.title}` : session.path}
      role="button"
      tabIndex={0}
      aria-busy={isPending || undefined}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          void onSelectSession(projectId, session.path);
        }
      }}
    >
      {/* Session rows are text-only (codex-ui): the two status cues sit in the indent
          gutter so they never push the title sideways. */}
      {isPending ? (
        <Loader2 className="absolute left-3 size-[15px] animate-spin text-muted-foreground" aria-hidden="true" />
      ) : isStreaming ? (
        <Clock3 className="absolute left-3 size-3.5 animate-pulse text-muted-foreground" aria-label={t("sidebar.generating")} />
      ) : null}
      {isEditing ? (
        <Input
          className="mr-1 ml-9 h-6 min-w-0 flex-1 px-1.5"
          value={editingSession.title}
          autoFocus
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setEditingSession({ ...editingSession, title: event.target.value })}
          onBlur={() => void commitSessionTitle()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitSessionTitle();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setEditingSession(null);
            }
          }}
        />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate py-1 pr-2 pl-9 group-hover:pr-[54px] group-focus-within:pr-[54px]",
            // Pinned session rows (codex-ui `.chat-row-wrap.pinned`) keep their actions visible.
            session.pinned && "pr-[54px]",
          )}
          onDoubleClick={(event) => {
            event.stopPropagation();
            setEditingSession({ projectId, sessionPath: session.path, title: session.title });
          }}
        >
          {session.title}
        </span>
      )}
      <div
        className={cn(
          "absolute top-1/2 right-1 flex -translate-y-1/2 items-center",
          sidebarHoverActionClass,
          session.pinned && "opacity-100",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6"
          onClick={(event) => {
            event.stopPropagation();
            void onPinSession(projectId, session.path, !session.pinned);
          }}
          aria-label={session.pinned ? t("sidebar.unpinSession") : t("sidebar.pinSession")}
          title={session.pinned ? t("sidebar.unpinSession") : t("sidebar.pinSession")}
        >
          <SidebarPinIcon size={16} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6"
          onClick={(event) => {
            event.stopPropagation();
            onArchive(session.title);
          }}
          aria-label={t("sidebar.archiveSession")}
          title={t("sidebar.archiveSession")}
        >
          <SidebarArchiveIcon size={16} />
        </Button>
      </div>
    </div>
  );
}

type SidebarDialog =
  | { kind: "create-project"; name: string; cwd: string }
  | { kind: "edit-project"; project: ProjectSummary; name: string; cwd: string }
  | { kind: "remove-project"; project: ProjectSummary }
  | { kind: "archive-session"; projectId: string; sessionPath: string; title: string };

function SidebarDialogView({
  dialog,
  projects,
  submitError,
  onChange,
  onCancel,
  onSubmit,
  onConfirm,
  onDeleteForever,
}: {
  dialog: SidebarDialog;
  projects: ProjectSummary[];
  submitError?: string | null;
  onChange: (dialog: SidebarDialog | null) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onConfirm: () => void;
  /** 归档/删除弹窗里的「直接删除」。其他 dialog 用不到。 */
  onDeleteForever: () => void;
}) {
  const t = useT();
  const [isChoosingFolder, setIsChoosingFolder] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  async function chooseFolder() {
    if (dialog.kind !== "create-project" && dialog.kind !== "edit-project") {
      return;
    }

    setPickerError(null);
    setIsChoosingFolder(true);
    try {
      const folder = await invoke<string | null>("choose_project_folder", {
        defaultPath: dialog.cwd || undefined,
      });
      if (folder) {
        onChange(projectDialogWithCwd(dialog, folder));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPickerError(message || t("dialog.couldNotChooseFolder"));
    } finally {
      setIsChoosingFolder(false);
    }
  }

  if (dialog.kind === "remove-project" || dialog.kind === "archive-session") {
    return (
      <AlertDialog
        open
        onOpenChange={(next) => {
          if (!next) {
            onCancel();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog.kind === "remove-project" ? t("dialog.removeProjectTitle") : t("dialog.archiveSessionTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog.kind === "remove-project"
                ? t("dialog.removeProjectDesc", { name: dialog.project.name })
                : t("dialog.archiveSessionDesc", { title: dialog.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            {dialog.kind === "archive-session" ? (
              // 两个出口并存：默认归档（可恢复），红色按钮直接删文件（不可恢复）。
              <AlertDialogAction variant="destructive" onClick={onDeleteForever}>
                {t("dialog.deleteSessionForever")}
              </AlertDialogAction>
            ) : null}
            <AlertDialogAction onClick={onConfirm}>
              {dialog.kind === "remove-project" ? t("dialog.removeAction") : t("dialog.archiveAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  const canChooseFolder = isTauriRuntime();
  // Projects are keyed by folder, so an existing folder is not a new project:
  // say which project already owns it and let the user confirm the switch.
  const existingProject =
    dialog.kind === "create-project" ? findProjectByCwd(projects, dialog.cwd) : undefined;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{dialog.kind === "create-project" ? t("dialog.newProjectTitle") : t("dialog.editProjectTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="sidebar-project-name">{t("dialog.nameLabel")}</Label>
            <Input
              id="sidebar-project-name"
              value={dialog.name}
              autoFocus
              onChange={(event) => onChange({ ...dialog, name: event.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sidebar-project-cwd">{t("dialog.folderLabel")}</Label>
            <div className="flex gap-2">
              <Input
                id="sidebar-project-cwd"
                className="min-w-0 flex-1"
                value={dialog.cwd}
                placeholder="/Users/name/Project"
                onChange={(event) => onChange(projectDialogWithCwd(dialog, event.target.value))}
              />
              {canChooseFolder ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void chooseFolder()}
                  disabled={isChoosingFolder}
                  aria-label={t("sidebar.chooseFolder")}
                  title={t("sidebar.chooseFolder")}
                >
                  <FolderOpen />
                  <span>{isChoosingFolder ? t("sidebar.choosing") : t("sidebar.choose")}</span>
                </Button>
              ) : null}
            </div>
          </div>
          {existingProject ? (
            <div
              className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", statusBannerStyles)}
              role="status"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">
                {t("trust.existingProject", { name: existingProject.name, cwd: existingProject.cwd })}
              </span>
            </div>
          ) : null}
          {pickerError ? (
            <p className="text-sm text-destructive" role="status">
              {pickerError}
            </p>
          ) : null}
          {submitError ? (
            <p className="text-sm text-destructive" role="status">
              {submitError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("sidebar.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit">
              {dialog.kind === "edit-project"
                ? t("sidebar.save")
                : existingProject
                  ? t("trust.switchToProject", { name: existingProject.name })
                  : t("sidebar.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function projectDialogWithCwd(dialog: SidebarDialog, cwd: string): SidebarDialog {
  if (dialog.kind === "create-project") {
    const nextName = dialog.name.trim() ? dialog.name : lastPathPart(cwd);
    return { ...dialog, cwd, name: nextName };
  }

  if (dialog.kind === "edit-project") {
    return { ...dialog, cwd };
  }

  return dialog;
}

function AttachmentHoverCard({ hover }: { hover: AttachmentHoverState }) {
  const { attachment, rect } = hover;
  const isImage = attachment.kind === "image";
  const cardWidth = 300;
  const cardHeight = isImage ? 260 : 110;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - cardWidth - 12));
  const canPlaceAbove = rect.top - cardHeight - 18 >= 12;
  const top = canPlaceAbove
    ? rect.top - 10
    : Math.min(window.innerHeight - cardHeight - 12, rect.bottom + 10);

  return (
    <aside
      className={`attachment-hover-card ${isImage ? "is-image" : "is-file"} ${canPlaceAbove ? "place-above" : "place-below"}`}
      style={{ left, top, width: cardWidth }}
      role="tooltip"
    >
      {isImage && attachment.previewUrl ? (
        <img src={attachment.previewUrl} alt={attachment.name} />
      ) : (
        <span className="attachment-hover-file-icon">
          <FileText size={18} />
        </span>
      )}
      <div className="attachment-hover-copy">
        <strong>{attachment.name}</strong>
        <span>{attachment.sourcePath || attachment.name}</span>
        <small>{attachment.mimeType} · {formatFileSize(attachment.size)}</small>
      </div>
    </aside>
  );
}


function ExtensionWidgetStack({
  widgets,
}: {
  widgets: Array<[string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }]>
}) {
  return (
    <div className="grid gap-1.5 px-0.5 pb-2" aria-label="Extension widgets">
      {widgets.map(([key, widget]) => (
        <section
          className="border-l-[3px] border-l-primary bg-muted px-2.5 py-2 text-xs leading-snug whitespace-pre-wrap text-muted-foreground"
          key={key}
        >
          {/* 扩展可能把 `ctx.ui.theme` 的颜色写进 widget 行；这里是纯文本展示，把转义序列去掉。 */}
          {widget.lines.map((line, index) => <div key={`${key}-${index}`}>{stripTerminalSequences(line)}</div>)}
        </section>
      ))}
    </div>
  );
}

function UsagePopover({
  stats,
  contextPercent,
  capabilities,
  thinkingLevel,
  hasThinking,
  isCompacting,
  isStreaming,
  canCompact,
  onCompact,
  onClose,
}: {
  stats: ConversationStats;
  contextPercent: number | null;
  capabilities: CapabilitiesState;
  thinkingLevel: ThinkingLevel;
  hasThinking: boolean;
  isCompacting: boolean;
  isStreaming: boolean;
  canCompact: boolean;
  onCompact: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const tokenUsage = stats.tokenUsage;
  const inputTokens = tokenUsage?.input ?? 0;
  const outputTokens = tokenUsage?.output ?? 0;
  const cacheReadTokens = tokenUsage?.cacheRead ?? 0;
  const cacheWriteTokens = tokenUsage?.cacheWrite ?? 0;
  const cacheTokens = cacheReadTokens + cacheWriteTokens;
  const displayInputTokens = inputTokens + cacheReadTokens;
  const displayOutputTokens = outputTokens + cacheWriteTokens;
  const displayTotalTokens = displayInputTokens + displayOutputTokens;
  const reasoningTokens = tokenUsage?.reasoning ?? 0;
  const estimatedCostUsd = tokenUsage?.estimatedCostUsd;
  const activeSkills = capabilities.skills.filter((item) => item.active);
  const activeToolSkills = activeSkills.filter((item) => item.disableModelInvocation);
  const activeModelSkills = activeSkills.filter((item) => !item.disableModelInvocation);
  const activeMcpServers = (capabilities.mcpServers ?? []).filter((item) => item.active);
  const compactAction = compactActionState({ isStreaming, isCompacting });
  const detailRows = [
    displayInputTokens > 0
      ? {
          label: t("usage.label.input"),
          value: formatTokens(displayInputTokens),
          percent: percentOf(displayInputTokens, displayTotalTokens),
          color: "bg-primary",
        }
      : null,
    displayOutputTokens > 0
      ? {
          label: t("usage.label.output"),
          value: formatTokens(displayOutputTokens),
          percent: percentOf(displayOutputTokens, displayTotalTokens),
          color: "bg-sky-500",
        }
      : null,
    cacheTokens > 0
      ? {
          label: t("usage.label.cache"),
          value: formatCacheDetail(cacheReadTokens, cacheWriteTokens),
          percent: cachePercent(cacheReadTokens, cacheWriteTokens, displayInputTokens),
          color: "bg-amber-500",
        }
      : null,
    hasThinking
      ? {
          label: t("usage.label.thinking", { level: thinkingLevel }),
          value: reasoningTokens > 0 ? formatTokens(reasoningTokens) : t("usage.thinkingEnabled"),
          percent: reasoningTokens > 0 ? percentOf(reasoningTokens, tokenUsage?.output) : null,
          color: "bg-violet-500",
        }
      : null,
    activeToolSkills.length > 0
      ? {
          label: t("usage.label.toolSkills"),
          value: t("usage.itemsCount", { count: activeToolSkills.length }),
          percent: null,
          color: "bg-cyan-500",
        }
      : null,
    (stats.toolCallCount ?? 0) > 0
      ? {
          label: t("usage.label.toolCalls"),
          value: `${t("usage.toolCallsCount", { count: stats.toolCallCount ?? 0 })}${activeMcpServers.length ? t("usage.mcpSuffix", { count: activeMcpServers.length }) : ""}`,
          percent: null,
          color: "bg-orange-500",
        }
      : null,
    activeModelSkills.length > 0
      ? {
          label: t("usage.label.skills"),
          value: t("usage.itemsCount", { count: activeModelSkills.length }),
          percent: null,
          color: "bg-blue-500",
        }
      : null,
  ].filter((row): row is NonNullable<typeof row> => Boolean(row));

  return (
    <section
      className="absolute bottom-[calc(100%+12px)] left-0 z-40 grid w-[min(380px,calc(100vw-28px))] gap-3.5 rounded-xl border bg-popover px-[18px] pt-[17px] pb-4 text-popover-foreground shadow-lg after:absolute after:-bottom-1.5 after:left-3.5 after:size-2.5 after:rotate-45 after:border-r after:border-b after:bg-popover after:content-[''] max-[560px]:fixed max-[560px]:right-3 max-[560px]:bottom-[calc(84px+env(safe-area-inset-bottom))] max-[560px]:left-auto max-[560px]:w-[min(356px,calc(100vw-24px))] max-[560px]:after:hidden"
      role="dialog"
      aria-label={t("usage.title")}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="mb-[3px] text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("usage.badge")}</p>
          <h2 className="text-[1.08rem] font-semibold">{t("usage.title")}</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t("usage.close")}
          title={t("usage.close")}
        >
          <X />
        </Button>
      </header>

      <div className="flex min-w-0 items-baseline gap-2.5">
        <strong className="text-[1.82rem] leading-none">
          {contextPercent == null ? "--" : `${contextPercent.toFixed(1)}%`}
        </strong>
        {/* 单行硬约束：整块 nowrap，token/费用数值再大也不折行；弹层已加宽到 380px 兑付。 */}
        <span className="min-w-0 whitespace-nowrap text-xs leading-snug text-muted-foreground">
          {t("usage.usedOfWindow", { used: formatTokens(stats.contextTokens), total: formatTokens(stats.contextWindow) })}
          {estimatedCostUsd != null ? (
            <>
              {" · "}
              {t("usage.estimatedCost", { cost: formatCny(estimatedCostUsd) })}
            </>
          ) : null}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
        <span className="block h-full rounded-[inherit] bg-primary" style={{ width: `${contextPercent ?? 0}%` }} />
      </div>

      <dl className="grid grid-cols-3 gap-2.5">
        {([
          [t("usage.turns"), stats.turnCount],
          [t("usage.messages"), stats.messageCount],
          [t("usage.compactions"), stats.compactionCount],
        ] as const).map(([label, value]) => (
          <div className="min-w-0" key={label}>
            <dt className="text-[0.72rem] text-muted-foreground">{label}</dt>
            <dd className="mt-[3px] text-sm font-bold">{value}</dd>
          </div>
        ))}
      </dl>

      {detailRows.length ? (
        <div className="grid gap-[11px] border-t pt-0.5">
          <p className="text-[0.72rem] text-muted-foreground">{t("usage.cumulativeHint")}</p>
          {detailRows.map((row) => (
            <div className="grid min-w-0 grid-cols-[9px_minmax(0,1fr)_auto_auto] items-center gap-2" key={row.label}>
              <span className={cn("size-[9px] rounded-full", row.color)} />
              <span className="min-w-0 truncate text-[0.82rem]">{row.label}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{row.value}</span>
              {row.percent != null ? (
                <span className="min-w-[42px] truncate text-right text-xs text-muted-foreground">
                  {row.percent.toFixed(1)}%
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("usage.noBreakdown")}</p>
      )}

      {canCompact ? (
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-[34px] w-full gap-[7px] border-amber-300 bg-amber-50 text-xs font-bold text-amber-900 hover:bg-amber-100 hover:text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60"
          onClick={onCompact}
          disabled={compactAction.disabled}
          aria-label={compactAction.reason === "streaming" ? t("usage.compactDisabledStreamingAria") : undefined}
        >
          <DatabaseZap />
          {compactAction.label}
        </Button>
      ) : null}
    </section>
  );
}

function formatCny(value: number) {
  if (!Number.isFinite(value)) {
    return "--";
  }

  if (value < 0.01) {
    return `¥${value.toFixed(4)}`;
  }

  return `¥${value.toFixed(2)}`;
}

function ExtensionStatusBar({ status }: { status: Record<string, string> }) {
  return (
    <div
      className="pointer-events-none fixed right-[18px] bottom-3.5 z-[25] flex max-w-[min(520px,calc(100vw-36px))] flex-wrap justify-end gap-1.5"
      role="status"
      aria-label="Extension status"
    >
      {Object.entries(status).map(([key, value]) => (
        <Badge key={key} variant="outline" className="bg-background/95 text-[0.72rem]" title={key}>
          {stripTerminalSequences(value)}
        </Badge>
      ))}
    </div>
  );
}

const extensionNotificationStyles: Record<"info" | "warning" | "error", string> = {
  info: "border-l-primary",
  warning: "border-l-amber-500 text-amber-900 dark:text-amber-200",
  error: "border-l-destructive text-destructive",
};

const extensionActionVariants: Record<"primary" | "secondary" | "danger", "default" | "outline" | "destructive"> = {
  primary: "default",
  secondary: "outline",
  danger: "destructive",
};

const extensionNoticeStyles: Record<"info" | "success" | "warning" | "error", string> = {
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
};

const extensionStatusStyles: Record<"ready" | "warning" | "error" | "muted", string> = {
  ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
  error: "bg-destructive/15 text-destructive",
  muted: "",
};

function ExtensionNotifications({
  notifications,
}: {
  notifications: Array<{ id: string; message: string; type: "info" | "warning" | "error" }>
}) {
  return (
    <div
      className="pointer-events-none fixed top-[calc(var(--titlebar-height)+14px)] right-[18px] z-80 grid w-[min(360px,calc(100vw-36px))] gap-2"
      aria-live="polite"
    >
      {notifications.map((notification) => (
        <div
          className={cn(
            "rounded-md border border-l-[3px] bg-background/98 px-3 py-2.5 text-sm leading-snug shadow-lg",
            extensionNotificationStyles[notification.type],
          )}
          key={notification.id}
        >
          <span>{notification.message}</span>
        </div>
      ))}
    </div>
  );
}

function ExtensionWebUi({
  request,
  onRespond,
}: {
  request: Extract<ExtensionUiRequest, { method: "web" }>;
  onRespond: (response: ExtensionUiResponse) => void;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const definition = request.definition ?? {};

  useEffect(() => {
    const next: Record<string, string | boolean> = {};
    const collect = (field: ExtensionWebUiField) => {
      next[field.name] = field.value ?? (field.type === "checkbox" ? false : "");
    };
    definition.fields?.forEach(collect);
    definition.sections?.forEach((section) => {
      section.fields?.forEach(collect);
      section.rows?.forEach((row) => row.fields?.forEach(collect));
    });
    setValues((current) => ({ ...next, ...Object.fromEntries(Object.entries(current).filter(([name]) => name in next)) }));
  }, [definition]);

  function updateValue(name: string, value: string | boolean) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function runAction(action: ExtensionWebUiAction) {
    setBusyAction(action.id);
    Promise.resolve(onRespond({
      id: request.id,
      action: action.id,
      values,
      ...(action.data === undefined ? {} : { data: action.data }),
    })).finally(() => setBusyAction(null));
  }

  function renderField(field: ExtensionWebUiField, keyPrefix: string) {
    const value = values[field.name] ?? field.value ?? (field.type === "checkbox" ? false : "");
    const key = `${keyPrefix}-${field.name}`;
    const disabled = field.disabled || Boolean(busyAction);
    if (field.type === "checkbox") {
      return (
        <div className="flex items-start gap-2.5" key={key}>
          <Checkbox
            id={key}
            className="mt-0.5"
            checked={Boolean(value)}
            disabled={disabled}
            onCheckedChange={(next) => updateValue(field.name, next === true)}
          />
          <Label htmlFor={key} className="grid items-start gap-0.5 leading-normal">
            <span className="font-bold">{field.label}</span>
            {field.description ? (
              <span className="text-xs font-medium text-muted-foreground">{field.description}</span>
            ) : null}
          </Label>
        </div>
      );
    }

    return (
      <div className="grid min-w-0 gap-1.5" key={key}>
        <Label htmlFor={key} className="font-bold">{field.label}</Label>
        {field.type === "textarea" ? (
          <Textarea
            id={key}
            className="min-h-[82px] resize-y"
            value={String(value)}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(event) => updateValue(field.name, event.target.value)}
          />
        ) : field.type === "select" ? (
          <Select
            value={String(value)}
            disabled={disabled}
            onValueChange={(next) => updateValue(field.name, next)}
          >
            <SelectTrigger id={key} className="w-full">
              <SelectValue placeholder={field.placeholder} />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={key}
            type={field.type}
            value={String(value)}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(event) => updateValue(field.name, event.target.value)}
          />
        )}
        {field.description ? (
          <small className="text-xs leading-snug text-muted-foreground">{field.description}</small>
        ) : null}
      </div>
    );
  }

  function renderActions(actions: ExtensionWebUiAction[] | undefined, className?: string) {
    if (!actions?.length) return null;
    return (
      <div className={cn("flex flex-wrap justify-end gap-2", className)}>
        {actions.map((action) => (
          <Button
            key={action.id}
            type="button"
            size="sm"
            variant={extensionActionVariants[action.tone ?? "secondary"]}
            className="font-bold disabled:cursor-wait"
            disabled={Boolean(busyAction)}
            onClick={() => runAction(action)}
          >
            {busyAction === action.id ? t("common.busy") : action.label}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onRespond({ id: request.id, cancelled: true });
        }
      }}
    >
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden sm:max-w-[760px] max-h-[min(760px,calc(100vh-48px))]">
        <DialogHeader>
          <DialogDescription className="text-xs font-medium tracking-wide uppercase">
            Package interface
          </DialogDescription>
          <DialogTitle className="text-[1.08rem]">{definition.title ?? request.title}</DialogTitle>
        </DialogHeader>
        <div className="grid min-h-0 gap-4 overflow-y-auto pr-1">
          {definition.description ? (
            <p className="leading-relaxed text-muted-foreground">{definition.description}</p>
          ) : null}
          {definition.notice ? (
            <p className={cn("rounded-md border px-3 py-2.5 leading-snug", extensionNoticeStyles[definition.notice.tone])}>
              {definition.notice.message}
            </p>
          ) : null}
          {definition.fields?.length ? (
            <div className="grid gap-3">{definition.fields.map((field) => renderField(field, "root"))}</div>
          ) : null}
          {definition.sections?.map((section) => (
            <section className="grid gap-3 border-t pt-4" key={section.id}>
              {section.title ? <h3 className="text-base font-semibold">{section.title}</h3> : null}
              {section.description ? <p className="leading-relaxed text-muted-foreground">{section.description}</p> : null}
              {section.fields?.length ? (
                <div className="grid gap-3">{section.fields.map((field) => renderField(field, section.id))}</div>
              ) : null}
              {section.rows?.length ? (
                <div className="grid gap-2">
                  {section.rows.map((row) => (
                    <div
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3.5 gap-y-2.5 rounded-md border bg-muted/40 p-3"
                      key={row.id}
                    >
                      <div className="grid min-w-0 gap-[3px]">
                        <strong className="break-words">{row.title}</strong>
                        {row.description ? <span className="text-sm leading-snug break-words text-muted-foreground">{row.description}</span> : null}
                        {row.detail ? <small className="text-sm leading-snug break-words text-muted-foreground">{row.detail}</small> : null}
                      </div>
                      {row.status ? (
                        <Badge
                          variant="secondary"
                          className={cn("self-start text-[0.72rem] font-extrabold uppercase", extensionStatusStyles[row.status])}
                        >
                          {row.status}
                        </Badge>
                      ) : null}
                      {row.fields?.length ? (
                        <div className="col-span-full grid gap-3">{row.fields.map((field) => renderField(field, row.id))}</div>
                      ) : null}
                      {renderActions(row.actions, "col-span-full")}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
          {renderActions(definition.actions)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ExtensionUiDialog({
  request,
  onRespond,
}: {
  request: Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
  onRespond: (response: ExtensionUiResponse) => void;
}) {
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [selected, setSelected] = useState(request.method === "select" ? request.options[0] ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setSelected(request.method === "select" ? request.options[0] ?? "" : "");
  }, [request.id]);

  function cancel() {
    onRespond({ id: request.id, cancelled: true });
  }

  function submit() {
    if (request.method === "confirm") {
      onRespond({ id: request.id, confirmed: true });
      return;
    }

    onRespond({ id: request.id, value: request.method === "select" ? selected : value });
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          cancel();
        }
      }}
    >
      <DialogContent className="max-h-[min(86svh,720px)] gap-4 overflow-y-auto">
        <DialogHeader>
          <DialogDescription className="text-xs font-medium tracking-wide uppercase">Pi extension</DialogDescription>
          <DialogTitle className="text-[1.08rem]">{request.title}</DialogTitle>
        </DialogHeader>

        {request.method === "confirm" ? (
          <p className="leading-relaxed whitespace-pre-wrap text-muted-foreground">{request.message}</p>
        ) : null}
        {request.method === "select" ? (
          <div className="grid gap-2" role="listbox" aria-label={request.title}>
            {request.options.map((option) => (
              <Button
                type="button"
                variant="outline"
                role="option"
                aria-selected={selected === option}
                className={cn(
                  "h-auto min-h-[42px] w-full justify-start px-3 py-2 text-left font-normal whitespace-normal",
                  selected === option && "border-primary bg-accent",
                )}
                key={option}
                onClick={() => setSelected(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        ) : null}
        {request.method === "input" ? (
          <Input
            autoFocus
            className="h-[42px]"
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
        ) : null}
        {request.method === "editor" ? (
          <Textarea
            autoFocus
            className="min-h-[180px] resize-y leading-normal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={cancel}>Cancel</Button>
          {request.method === "confirm" ? (
            <>
              <Button type="button" variant="outline" onClick={cancel}>No</Button>
              <Button type="button" onClick={submit}>Yes</Button>
            </>
          ) : (
            <Button type="button" onClick={submit} disabled={request.method === "select" && !selected}>
              Submit
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One collapsible section of the project capabilities panel (Skills / Packages).
 *
 * The header copies the left sidebar's section pattern — a small muted label you can click to fold
 * the section away, and one compact ghost icon button — because the first version put a full-width
 * outline button in a ~330px panel: it read as a page toolbar and wrapped the package chips onto a
 * second line. The count rides on the label so a folded section still says how much is inside.
 */
function CapabilityPanelSection({
  title,
  count,
  collapsed,
  onToggleCollapsed,
  action,
  children,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-2.5">
      <div className="mb-1 flex min-w-0 items-center justify-between gap-1">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-1.5 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")} />
          <span className="truncate">{title}</span>
          <span className="shrink-0 tabular-nums opacity-60">{count}</span>
        </button>
        {action}
      </div>
      {collapsed ? null : <div className="grid gap-0.5 pt-0.5">{children}</div>}
    </section>
  );
}

function SkillList({ skills }: { skills: SkillSummary[] }) {
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(() => new Set());
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [skillContent, setSkillContent] = useState<Record<string, string>>({});
  const [contentError, setContentError] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  function toggleSkill(path: string) {
    setExpandedSkills((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function openSkill(skill: SkillSummary) {
    setSelectedSkill(skill);
    setContentError(null);
    if (skillContent[skill.path]) {
      return;
    }

    setLoadingPath(skill.path);
    try {
      const result = await fetchJson<{ content: string }>(`/api/skills/content?path=${encodeURIComponent(skill.path)}`);
      setSkillContent((current) => ({ ...current, [skill.path]: result.content }));
    } catch (error) {
      setContentError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingPath(null);
    }
  }

  if (!skills.length) {
    return <p className="text-sm text-muted-foreground">No skills loaded</p>;
  }

  return (
    <>
      <div className="grid">
        {skills.map((skill) => {
          const isExpanded = expandedSkills.has(skill.path);
          const needsToggle = skill.description.length > skillDescriptionPreviewLength;
          const description = isExpanded || !needsToggle
            ? skill.description
            : `${skill.description.slice(0, skillDescriptionPreviewLength).trimEnd()}...`;
          return (
            <article
              key={skill.path}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2.5 border-b py-2.5 last:border-b-0"
            >
              <div className="min-w-0">
                <strong className="mb-1 block text-sm">{skill.name}</strong>
                <p className="text-sm leading-snug break-words text-muted-foreground">
                  <span>{description}</span>
                  {needsToggle ? (
                    <Button
                      type="button"
                      variant="link"
                      className="ml-1.5 h-auto p-0 align-baseline text-sm underline underline-offset-2"
                      onClick={() => toggleSkill(skill.path)}
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? "Collapse" : "Expand"}
                    </Button>
                  ) : null}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="mt-0.5"
                onClick={() => void openSkill(skill)}
                aria-label={`Open ${skill.name}`}
                title="Open full skill"
              >
                <BookOpen />
              </Button>
            </article>
          );
        })}
      </div>

      <Dialog
        open={Boolean(selectedSkill)}
        onOpenChange={(next) => {
          if (!next) {
            setSelectedSkill(null);
          }
        }}
      >
        <DialogContent className="h-[min(86svh,760px)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogDescription className="text-xs font-medium tracking-wide uppercase">Skill</DialogDescription>
            <DialogTitle className="text-xl">{selectedSkill?.name}</DialogTitle>
          </DialogHeader>
          <div className="grid min-h-0 gap-3.5 overflow-y-auto pr-1">
            {selectedSkill && loadingPath === selectedSkill.path ? <p className="text-sm text-muted-foreground">Loading skill...</p> : null}
            {contentError ? <p className="text-sm text-destructive" role="status">{contentError}</p> : null}
            {selectedSkill && skillContent[selectedSkill.path] ? <MarkdownContent text={skillContent[selectedSkill.path]} /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function lastPathPart(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "Project";
}

function isTauriRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  const candidate = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(candidate.__TAURI__ || candidate.__TAURI_INTERNALS__);
}

function isMacPlatform() {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.platform);
}

function normalizePercent(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return null;
  }

  return Math.max(0, Math.min(100, value));
}

async function readAttachment(attachment: ComposerAttachment): Promise<PromptAttachmentInput> {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    // Pasting a badge from a sent message keeps only its `sourcePath`; the server
    // reuses the bytes already on disk, same as editing a message does.
    data: attachment.file ? await fileToBase64(attachment.file) : "",
    previewUrl: attachment.previewUrl,
    sourcePath: attachment.sourcePath,
  };
}

function toPromptMessageParts(
  parts: ComposerPart[],
): PromptMessagePartInput[] {
  return parts
    .map((part): PromptMessagePartInput | null => {
      if (part.kind === "text") {
        return part.text ? { kind: "text", text: part.text } : null;
      }
      if (part.kind === "capability") {
        return { kind: "capability", capability: part.capability };
      }
      return { kind: "attachment", attachmentId: part.attachment.id };
    })
    .filter((part): part is PromptMessagePartInput => Boolean(part));
}

function capabilityBadgeKey(capability: Pick<ComposerCapability, "kind" | "id" | "instanceId">) {
  return `${capability.kind}:${capability.id}:${capability.instanceId ?? ""}`;
}

function capabilitySelector(capability: Pick<ComposerCapability, "kind" | "id" | "instanceId">) {
  const base = `[data-capability-id="${escapeCssIdent(capability.id)}"][data-capability-kind="${capability.kind}"]`;
  return capability.instanceId
    ? `${base}[data-capability-instance-id="${escapeCssIdent(capability.instanceId)}"]`
    : base;
}

function createCapabilityInstanceId() {
  return `capability-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isComposerEmpty(editor: HTMLElement) {
  return !editor.querySelector("[data-attachment-id], [data-capability-id]")
    && (editor.textContent ?? "").replaceAll(composerCaretMarker, "").trim().length === 0;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolvePromise(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => rejectPromise(reader.error ?? new Error(`Unable to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function renamePastedImage(file: File, index: number) {
  const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1] || "png";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File([file], `Screenshot-${timestamp}${index ? `-${index + 1}` : ""}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

function createAttachmentId() {
  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function clampPanelWidth(width: number, side: "left" | "right") {
  const minimum = side === "left" ? 220 : 260;
  const maximum = side === "left" ? 420 : 420;
  return Math.round(Math.max(minimum, Math.min(maximum, width)));
}

function hasDraggedFiles(event: ReactDragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function escapeCssIdent(value: string) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
