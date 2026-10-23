import {
  Activity,
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
  FileUp,
  Folder,
  FolderOpen,
  Mic,
  Moon,
  Minus,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  Plug,
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
  Loader,
  Loader2,
  Sun,
  GitFork,
  X,
} from "lucide-react";
import { hasHostShell, invokeHost, invokeHostQuietly } from "../lib/shell/host.ts";
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
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  type ToolSettingsPayload,
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
import { loadUiPreferences, saveUiPreferences } from "../lib/ui-preferences";
import { resolveAppearance, themes, type ThemeId } from "../themes/index.ts";
import { findProjectByCwd } from "../shared/projectPaths";
import { normalizeProjectCommandTerminal } from "../shared/projectCommandTerminal";
import { collectDroppedItems, pickDroppedProjectFolder, supportsDroppedFolderPaths, type DroppedProjectFolder } from "../shared/droppedProjectFolder";
import { attachmentKindFromMimeType, DIRECTORY_MIME_TYPE } from "../shared/attachmentKind";
import { pickNewFolderDrops, planComposerDrop, type ComposerDropPlan } from "../shared/composerDrop";
import { compactActionState, compactionNotice } from "../shared/compactionNotice";
import {
  BUILTIN_COMMAND_DONE_DISMISS_MS,
  builtinCommandNoticeText,
  type BuiltinCommandPhase,
} from "../shared/builtinCommandNotice";
import { t, setLocale } from "../i18n/index.ts";
import { useT, useLocale } from "../i18n/react";
import { resolveProjectSidebarLock } from "../shared/projectSidebarLock";
import { filterPackageCommands } from "../shared/capabilityCommands";
import { expandProjectForNewSession } from "../shared/sidebarProjectExpansion";
import { platformRevealFolderLabelKey } from "../shared/revealFolderLabel";
import { cachePercent, formatCacheDetail, formatTokens, percentOf } from "./usageFormat";
import { sidebarHoverActionClass } from "../shared/sidebarActionVisibility";
import { worktreeSessionBadgeKind } from "../shared/sessionWorktree";
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
import { ProjectCommandControls } from "../components/ProjectCommandControls";
import { SessionWorktreeBadge } from "../components/SessionWorktreeBadge";
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
import { useProjectCommands } from "../features/chat/useProjectCommands";
import { useSessionWorktree } from "../features/chat/useSessionWorktree";
import {
  selectRestorableQueuedEntries,
  type ClearedComposerQueue,
  type QueuedComposerEntry,
} from "../features/chat/queuedComposerText";
import { ChatThread, type ViewportState } from "../features/chat/ChatThread";
import { GlobalSearchDialog } from "../features/search/GlobalSearchDialog";
import { InTaskSearchBar } from "../features/search/InTaskSearchBar";
import { chatJumpBus } from "../shared/chatJumpBus";
import {
  clampMatchIndex,
  stepMatchIndex,
  type SessionSearchResult,
} from "../shared/sessionSearch";
import {
  SIDEBAR_SESSION_BUSY_ICON_CLASS,
  SIDEBAR_SESSION_BUSY_SLOT_CLASS,
  sidebarSessionBusyIndicator,
  sidebarStreamingSessionPaths,
} from "../features/chat/sidebarStreaming";
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
  findBuiltinCommand,
  findSlashCommand,
  findSlashStart,
  matchSlashCommandArgs,
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
  CapabilityCommandArgument,
  CapabilityKind,
  CapabilityPackage,
  CapabilityPackageResourceDetails,
  CapabilityPackageResourceEntry,
  CapabilityPackageResourceType,
  CapabilityPackageFilePreview,
  CapabilityExtension,
  CapabilityMcpDetail,
  CapabilityMcpExposure,
  CapabilityMcpImportResult,
  CapabilityMcpImportServer,
  CapabilityMcpInspection,
  CapabilityMcpServer,
  CapabilitySkill,
  ChatAttachment,
  ConversationStats,
  CreateProjectResult,
  PersonalizationSettings,
  ProjectSummary,
  SkillSummary,
  ThinkingLevel,
  ToolToggleState,
} from "../types";
import { CAPABILITY_MCP_EXPOSURES, CAPABILITY_PACKAGE_RESOURCE_TYPES } from "../types";
import {
  buildMcpServerPayload,
  recordToRows,
  type McpKeyValueRow,
} from "../shared/mcpForm";
import { TitleBar, TitleBarIconButton, WindowControls, isMacPlatform } from "./TitleBarChrome";
import { ConversationCapabilitiesSettings, SettingsModal, personalizationExtensionUiOptions, personalizationStyleOptions } from "./SettingsDialogs";
import { ExtensionNotifications, ExtensionUiDialog, ExtensionWebUi, ExtensionWidgetStack, extensionActionVariants, extensionNoticeStyles, extensionNotificationStyles, extensionStatusStyles } from "./ExtensionUiSurface";
import { UsagePopover, formatCny } from "./UsagePopover";
import { ProjectSidebar, SidebarDialog, SidebarDialogView, SidebarHoverCardState, SidebarSessionRow, additionalProjectSessionLimit, hasDraggedFiles, hoverCardHideGrace, hoverCardShowDelay, initialProjectSessionLimit, lastPathPart, projectDialogWithCwd, projectDropBoundarySize, projectPinActionsVisible, statusBannerStyles, toolToggleOptions } from "./Sidebar";
import { CAPABILITY_COMMAND_MENU_TOP_INSET, CAPABILITY_COMMAND_SEARCH_THRESHOLD, CapabilityActions, CapabilityCommandMenu, CapabilityDeleteDialog, CapabilityDot, CapabilityItem, CapabilityPanelSection, KeyValueEditor, PackageInstallDialog, SkillImportDialog, SkillList, SlashMenu, skillDescriptionPreviewLength, slashMenuItemKey } from "./CapabilitySurfaces";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { CAPABILITY_RESOURCE_LABEL_KEYS, CAPABILITY_TAB_META, CapabilitiesPage, CapabilityDetailDialog, CapabilityMarketCard, CapabilityMcpCard, CapabilityResourceChips, MCP_EXPOSURE_HINT_KEYS, MCP_EXPOSURE_LABEL_KEYS, MCP_IMPORT_FORMAT_KEYS, McpServerDialog, McpServerEditor, PACKAGE_CATALOG_URL, PackageResourcesDialog, PackageResourcesLoaded, PackageResourcesRequest, capabilityInitial, capabilityLoadClass, capabilityLoadLabel, chooseSkillFolderPath, formatFileSize, loadPackageResourceFile, mcpImportFormatKey } from "./CapabilitiesPage";
import { CapabilitySectionId, ProjectCapabilitiesPanel } from "./ProjectCapabilitiesPanel";
import { ComposerOverflowMenu, ThinkingLevelSelect, thinkingLevelDescription, thinkingLevelLabel, thinkingLevels } from "./ComposerControls";
import { AttachmentHoverCard, AttachmentHoverState, ComposerAttachment, fileToBase64, readAttachment } from "./AttachmentHoverCard";
/* moved to src/app/ComposerControls.tsx */

/* moved to src/app/CapabilitySurfaces.tsx */

const maxAttachmentCount = 10;
const maxAttachmentSize = 25 * 1024 * 1024;
const maxAttachmentTotalSize = 50 * 1024 * 1024;
/* moved to src/app/Sidebar.tsx */

/* moved to src/app/Sidebar.tsx */

/* moved to src/app/Sidebar.tsx */

const composerCaretMarker = "\u200b";
/* moved to src/app/Sidebar.tsx */

const statusBannerButtonStyles =
  "text-amber-900 hover:bg-amber-100 hover:text-amber-900 dark:text-amber-200 dark:hover:bg-amber-900/40";
/* moved to src/app/AttachmentHoverCard.tsx */


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
/* moved to src/app/AttachmentHoverCard.tsx */


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
  // 参数候选是异步拿的：context 每变一次（换了命令 / 参数前缀）就重新问服务端，
  // 旧请求的返回靠 cancelled 丢弃，避免慢响应盖掉新前缀的结果。
  useEffect(() => {
    if (!slashCommandContext) {
      setSlashArgumentItems([]);
      return;
    }
    let cancelled = false;
    // 每个键都会改前缀，防抖一下再问服务端（TUI 的 autocomplete 同样防抖）。
    const timer = setTimeout(() => {
      void loadPackageCommandArguments(slashCommandContext.packageId, slashCommandContext.name, slashCommandContext.prefix)
        .then((items) => {
          if (cancelled) {
            return;
          }
          setSlashArgumentItems(items);
          setSlashHighlight(0);
          setSlashArgumentArmed(false);
          setShowCapabilityPicker(items.length > 0);
        })
        .catch(() => {
          if (!cancelled) {
            setSlashArgumentItems([]);
          }
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slashCommandContext, loadPackageCommandArguments]);

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

  // 会话头部右侧的 git 徽标：只读、可失败、非轮询（切项目 / 切会话 / 一轮结束 / 窗口重新聚焦时刷新）。
  // 带上 sessionPath：worktree 会话看到、提交的就是 worktree 自己那份状态。
  const projectGit = useProjectGit({
    projectId: bootstrap.activeProjectId,
    sessionPath: visibleSessionPath,
    isStreaming: state.isStreaming,
    onError: reportError,
  });

  // 会话头部「运行」按钮左边的命令列表：同样按项目取（存在 projects.json），探测和运行都
  // 落在会话自己的工作区上。
  const projectCommands = useProjectCommands({
    projectId: bootstrap.activeProjectId,
    sessionPath: visibleSessionPath,
    runTarget: projectCommandTerminal,
    onError: reportError,
  });

  // worktree 徽标：同样按会话取（worktree 是会话级的，不是项目级的）。
  const sessionWorktree = useSessionWorktree({
    projectId: bootstrap.activeProjectId,
    sessionPath: visibleSessionPath,
    isStreaming: state.isStreaming,
    onError: reportError,
    onBootstrap: replaceBootstrap,
  });
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
    if (!showExtensionStatus) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!extensionStatusRef.current?.contains(event.target as Node)) {
        setShowExtensionStatus(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowExtensionStatus(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showExtensionStatus]);

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

  /**
   * 「自动解决冲突」：把冲突清单/内容拼成的 prompt 拿回来，在**当前项目**新建一个会话，
   * 填进 composer 并聚焦。到这里为止只准备，用户看完自己点提交，agent 才动手。
   */
  async function autoResolveConflicts() {
    const prompt = await projectGit.conflictPrompt();
    if (!prompt) {
      return;
    }
    const projectId = bootstrap.activeProjectId;
    if (!projectId) {
      return;
    }
    await createSession(projectId);
    setDraft(prompt);
    focusComposerQuietly();
  }

  /**
   * 内置命令状态带：`running` 留到出结果，`done` 停留 BUILTIN_COMMAND_DONE_DISMISS_MS 后自己走。
   * 同一时刻只留一条，新的一条进来先收掉旧的定时器。
   */
  function clearBuiltinNotice() {
    if (builtinNoticeTimerRef.current != null) {
      window.clearTimeout(builtinNoticeTimerRef.current);
      builtinNoticeTimerRef.current = null;
    }
    setBuiltinNotice(null);
  }

  function showBuiltinNotice(name: string, phase: BuiltinCommandPhase) {
    clearBuiltinNotice();
    setBuiltinNotice({ tone: phase, text: builtinCommandNoticeText(name, phase) });
    if (phase === "done") {
      builtinNoticeTimerRef.current = window.setTimeout(() => {
        builtinNoticeTimerRef.current = null;
        setBuiltinNotice(null);
      }, BUILTIN_COMMAND_DONE_DISMISS_MS);
    }
  }

  // 卸载时收掉定时器，免得「已完成」那条在组件没了之后才 setState。
  useEffect(() => () => {
    if (builtinNoticeTimerRef.current != null) {
      window.clearTimeout(builtinNoticeTimerRef.current);
      builtinNoticeTimerRef.current = null;
    }
  }, []);

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

    // TUI 语义：提交的如果是已加载的包命令（`/name [args]`）或 Pi Desktop 实现了的内置命令
    // （目前 `/reload`），执行动作而不是当问题发给模型。只认精确命中的；未知的 `/xxx` 仍走
    // 聊天（服务端 expandPromptTemplates:false），所以「问题里以 / 开头」不会再触发意外命令。
    const submittedCommand = matchSlashCommandArgs(orderedText);
    const builtinCommand = submittedCommand ? findBuiltinCommand(capabilities, submittedCommand.name) : null;
    const slashCommand = submittedCommand && !builtinCommand
      ? findSlashCommand(capabilities, submittedCommand.name)
      : null;
    if (
      (slashCommand || builtinCommand)
      && !state.isBootstrapping
      && orderedAttachments.length === 0
      && !orderedParts.some((part) => part.kind === "capability")
    ) {
      setComposerError("");
      clearComposer();
      const dispatchCommand = slashCommand
        ? runPackageCommand(slashCommand.packageId, slashCommand.name, submittedCommand?.prefix ?? "")
        : runBuiltinCommand(builtinCommand!.name, submittedCommand?.prefix ?? "");
      if (builtinCommand) {
        showBuiltinNotice(builtinCommand.name, "running");
      }
      void dispatchCommand.then(
        () => {
          if (builtinCommand) {
            showBuiltinNotice(builtinCommand.name, "done");
          }
        },
        (error) => {
          // 失败让给 composer 错误带（忙/带参数/未知命令 都比状态带具体）。
          if (builtinCommand) {
            clearBuiltinNotice();
          }
          setComposerError(error instanceof Error ? error.message : String(error));
        },
      );
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
      const payload = await Promise.all(
        orderedAttachments.map((attachment) =>
          // FileReader 对目录、以及拖进来之后又被移走的文件，只给平台原文一句
          // （"A requested file or directory could not be found at the time an operation
          // was processed."）—— 指名道姓地报是哪一条读不出来，否则用户无从下手。
          readAttachment(attachment).catch(() => {
            throw new Error(t("composer.error.attachmentUnreadable", { name: attachment.name }));
          }),
        ),
      );
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

  /**
   * 一次 drop 的落地：目录（宿主给了绝对路径）成引用徽标，文件读字节，读不到的当场说。
   *
   * 拒绝必须是可见的：静默吞掉会让用户以为拖进去了，直到提交才发现少东西。一条 drop 只能
   * 显示一条消息，优先级是「完全没接住」>「装不下」>「这条读不出来」。
   */
  function applyComposerDrop(plan: ComposerDropPlan) {
    const fileError = addFiles(plan.files);
    const folderError = addFolderAttachments(plan.folders);
    const refusedError = plan.refusedFolders.length
      ? t("composer.error.folderNotAttachable", { name: plan.refusedFolders[0] })
      : "";
    setComposerError(refusedError || folderError || fileError);
  }

  /**
   * 目录附件只带 `sourcePath`（绝对路径），不带字节也没有 `file`。服务端照 MIME 认出它，
   * 把路径原样交给模型，不复制、不计大小。同一个目录拖两次只留一个徽标。
   */
  function addFolderAttachments(folders: readonly DroppedProjectFolder[]): string {
    const existingPaths = [...composerAttachmentMapRef.current.values()]
      .filter((attachment) => attachment.kind === "directory")
      .map((attachment) => attachment.sourcePath)
      .filter((path): path is string => Boolean(path));
    const { folders: picked, overflow } = pickNewFolderDrops(
      folders,
      existingPaths,
      Math.max(0, maxAttachmentCount - composerAttachmentMapRef.current.size),
    );

    if (picked.length) {
      insertAttachmentsAtCursor(
        picked.map((folder) => ({
          id: createAttachmentId(),
          name: folder.name,
          mimeType: DIRECTORY_MIME_TYPE,
          size: 0,
          kind: "directory" as const,
          sourcePath: folder.path,
        })),
      );
    }

    return overflow ? t("composer.error.tooManyAttachments", { count: maxAttachmentCount }) : "";
  }

  /** Returns the message to show, or "" when nothing went wrong. */
  function addFiles(fileList: FileList | File[]): string {
    const incoming = Array.from(fileList);
    if (!incoming.length) {
      return "";
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

      const kind = attachmentKindFromMimeType(file.type);
      const isImage = kind === "image";
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      const id = createAttachmentId();
      next.push({
        id,
        name: file.name || (isImage ? "Screenshot.png" : "Untitled file"),
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind,
        previewUrl,
        file,
      });
      totalSize += file.size;
    }

    if (next.length) {
      insertAttachmentsAtCursor(next);
    }
    return errorMessage;
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
      setComposerError(addFiles(images.map((file, index) => renamePastedImage(file, index))));
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
        setSlashCommandContext(null);
        setSlashArgumentArmed(false);
        return;
      }

      if (slashItems.length) {
        const argumentMenu = slashItems[0]?.kind === "argument";
        if (event.key === "ArrowDown") {
          event.preventDefault();
          // 参数菜单默认没有“选中项”（回车=提交）；第一次 ↓ 才落到第一项。
          if (argumentMenu && !slashArgumentArmed) {
            setSlashHighlight(0);
          } else {
            setSlashHighlight((current) => moveHighlight(current, 1, slashItems.length));
          }
          setSlashArgumentArmed(true);
          return;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          if (argumentMenu && !slashArgumentArmed) {
            setSlashHighlight(slashItems.length - 1);
          } else {
            setSlashHighlight((current) => moveHighlight(current, -1, slashItems.length));
          }
          setSlashArgumentArmed(true);
          return;
        }

        // Tab 把选中的项落进编辑器；对命令就是补 `/name `，不执行。
        if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          const item = slashItems[activeSlashIndex];
          if (item) {
            selectSlashItem(item);
          }
          return;
        }

        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          const item = slashItems[activeSlashIndex];
          // 参数默认不一定必选：参数菜单刚弹出、用户没动过选择时，回车直接提交命令。
          // 动过 ↑↓ 或用鼠标点过某一项（`slashArgumentArmed`）才把回车当成「选这一项」。
          if (item?.kind === "argument" && !slashArgumentArmed) {
            event.preventDefault();
            setShowCapabilityPicker(false);
            setSlashCommandContext(null);
            event.currentTarget.closest("form")?.requestSubmit();
            return;
          }
          event.preventDefault();
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
    // 判目录只认 Entries API，而它和 File 句柄都只在 drop 回调的同步段里有效：先把这一拖
    // 读成 facts，再决定哪些是目录引用、哪些走字节。
    applyComposerDrop(planComposerDrop(collectDroppedItems(event.dataTransfer, window.__PI_DESKTOP_FILES__)));
  }

  function handleComposerInput() {
    rememberComposerSelection();
    syncComposerState();
    const editor = composerEditorRef.current;
    // textContent 会把徽章内部文字（图标/名字/×）算进去，导致徽章后打 / 看似词中；
    // 触发检测只看真实文本节点。
    const triggerText = editor ? readTriggerText(editor) : "";
    const query = matchSlashTrigger(triggerText);
    if (query != null) {
      // 命令名 / 技能补全。
      setSlashCommandContext(null);
      if (!showCapabilityPicker) {
        setSlashHighlight(0);
        setShowCapabilityPicker(true);
      }
      if (query !== slashQuery) {
        setSlashQuery(query);
        setSlashHighlight(0);
      }
      return;
    }

    // 已过命令名阶段：`/command args` 时接着补参数（TUI 的 getArgumentCompletions）。
    const commandArgs = editor ? matchSlashCommandArgs(triggerText) : null;
    const command = commandArgs ? findSlashCommand(capabilities, commandArgs.name) : null;
    if (commandArgs && command?.hasArgumentCompletions) {
      const changed = slashCommandContext?.packageId !== command.packageId
        || slashCommandContext.name !== command.name
        || slashCommandContext.prefix !== commandArgs.prefix;
      if (changed) {
        setSlashQuery("");
        setSlashCommandContext({ packageId: command.packageId, name: command.name, prefix: commandArgs.prefix });
        setSlashHighlight(0);
        setSlashArgumentArmed(false);
        // 新前缀的候选还没到，先收起，等 effect 拿到后自己打开。
        setShowCapabilityPicker(false);
      }
      return;
    }

    setSlashCommandContext(null);
    setSlashArgumentArmed(false);
    if (showCapabilityPicker) {
      setShowCapabilityPicker(false);
    }
    if (slashQuery) {
      setSlashQuery("");
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
  // 退回内容按本地排队气泡里的 parts 重建（徽标仍是徽标）；只有本地没有对应气泡时才
  // 退化成服务端原文。
  function restoreQueuedComposerMessages(cleared: ClearedComposerQueue) {
    const entries = selectRestorableQueuedEntries(cleared.entries ?? [], cleared);
    if (!entries.length) {
      return;
    }
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }
    composerSelectionRef.current = null;
    const fragment = document.createDocumentFragment();
    entries.forEach((entry, index) => {
      if (index > 0) {
        fragment.appendChild(document.createTextNode("\n\n"));
      }
      appendQueuedComposerEntry(fragment, entry);
    });
    if (!isComposerEmpty(editor)) {
      // 排队内容整体在前，编辑器已有内容在后（对齐 TUI）。
      fragment.appendChild(document.createTextNode("\n\n"));
    }
    editor.insertBefore(fragment, editor.firstChild);
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

  /** 把一条本地排队消息写回编辑器：文本进文本节点，附件/技能还原成真的徽标。 */
  function appendQueuedComposerEntry(container: Node, entry: QueuedComposerEntry) {
    const parts = entry.parts?.length
      ? entry.parts
      : [{ kind: "text" as const, text: entry.text }];
    for (const part of parts) {
      if (part.kind === "text") {
        if (part.text) {
          container.appendChild(document.createTextNode(part.text));
        }
        continue;
      }
      if (part.kind === "attachment") {
        const attachment = entry.attachments?.find((candidate) => candidate.id === part.attachmentId);
        if (!attachment || composerAttachmentMapRef.current.size >= maxAttachmentCount) {
          continue;
        }
        const composerAttachment: ComposerAttachment = { ...attachment };
        composerAttachmentMapRef.current.set(composerAttachment.id, composerAttachment);
        if (composerAttachment.previewUrl) {
          attachmentPreviewUrlsRef.current.set(composerAttachment.id, composerAttachment.previewUrl);
        }
        container.appendChild(createAttachmentBadgeNode(composerAttachment));
        continue;
      }
      if (part.capability.kind !== "skill") {
        // 编辑器目前只还原技能徽标（与 readComposerParts 的口径一致）。
        continue;
      }
      const capability: ComposerCapability = {
        id: part.capability.id,
        kind: "skill",
        name: part.capability.name,
        description: part.capability.description,
        active: true,
        instanceId: createCapabilityInstanceId(),
      };
      composerCapabilityMapRef.current.set(capabilityBadgeKey(capability), capability);
      container.appendChild(createCapabilityBadgeNode(capability));
    }
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

  /**
   * TUI 的补全：把选中的 /命令 落成普通文本（`/name `），不执行，
   * 光标停在后面等用户填参数；命令注册了参数补全时顺手把参数/实例菜单切上来。
   */
  function insertCommandAtCursor(item: Extract<SlashMenuItem, { kind: "command" }>, options?: { atEnd?: boolean; trailingSpace?: boolean }) {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    // 能力卡点进来的先只放 `/name`（trailingSpace=false）：空格让用户自己敲，
    // 敲下去的那一刻 handleComposerInput 才把参数/实例列表拉出来。
    const trailingSpace = options?.trailingSpace ?? true;

    const selection = window.getSelection();
    if (!options?.atEnd) {
      rememberComposerSelection();
    }
    // 从能力卡点 action 时焦点在按钮上，composer 里记的选区可能已经过时：一律追加到末尾。
    let range = options?.atEnd ? null : composerSelectionRef.current?.cloneRange();
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

    // composer 里已有其它文本时，避免接成 `note/mcp`：前面不是空白就补一个空格。
    const beforeText = range.startContainer.nodeType === Node.TEXT_NODE
      ? (range.startContainer.textContent ?? "").slice(0, range.startOffset)
      : (range.startContainer.textContent ?? "");
    const separator = beforeText.length > 0 && !/\s$/u.test(beforeText) ? " " : "";
    const commandNode = document.createTextNode(`${separator}/${item.name}${trailingSpace ? " " : ""}`);
    range.insertNode(commandNode);
    range.setStart(commandNode, commandNode.textContent?.length ?? 0);
    range.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    composerSelectionRef.current = range.cloneRange();
    syncComposerState();

    if (trailingSpace && item.hasArgumentCompletions) {
      setSlashQuery("");
      setSlashHighlight(0);
      setSlashArgumentArmed(false);
      setSlashCommandContext({ packageId: item.packageId, name: item.name, prefix: "" });
    } else if (!trailingSpace) {
      setSlashCommandContext(null);
      setSlashArgumentArmed(false);
      setShowCapabilityPicker(false);
    }
  }

  /**
   * 应用一条参数候选：用候选值替换命令后已输入的整段参数（同 pi TUI 的
   * applyCompletion 参数分支），末尾补一个空格，并自动拉下一级候选
   * （如 `/mcp disable ` → server 实例列表）；没有下一级就收菜单，等回车提交。
   */
  function applyArgumentCompletion(item: Extract<SlashMenuItem, { kind: "argument" }>) {
    const editor = composerEditorRef.current;
    const context = slashCommandContext;
    if (!editor || !context) {
      return;
    }

    const selection = window.getSelection();
    rememberComposerSelection();
    let range = composerSelectionRef.current?.cloneRange();
    if (!range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    const container = range.startContainer;
    if (container.nodeType === Node.TEXT_NODE) {
      const text = container.textContent ?? "";
      const before = text.slice(0, range.startOffset);
      const commandStart = before.lastIndexOf(`/${context.name}`);
      if (commandStart !== -1) {
        // 末尾留一个空格：pi 的参数补全靠这个空格区分下一级 token（`/mcp disable `
        // 才能拿到 server 实例列表），同时交给下面的 effect 自动拉下一级候选。
        const trailing = /\s$/u.test(item.value) ? "" : " ";
        const replacement = `/${context.name} ${item.value}${trailing}`;
        container.textContent = `${text.slice(0, commandStart)}${replacement}${text.slice(range.startOffset)}`;
        range.setStart(container, commandStart + replacement.length);
        range.collapse(true);
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        composerSelectionRef.current = range.cloneRange();
      }
    }

    // 先把菜单收起来（旧候选会闪），再把 context 设成刚填入的值 + 空格：
    // 若该命令还有下一级（如实例列表），effect 会拉到候选后自动重新展开；没有就保持收起。
    setShowCapabilityPicker(false);
    setSlashArgumentItems([]);
    setSlashQuery("");
    setComposerError("");
    setSlashArgumentArmed(false);
    setSlashCommandContext({ packageId: context.packageId, name: context.name, prefix: `${item.value} ` });
    syncComposerState();
  }

  /**
   * 菜单项的落点（Tab / Enter / 鼠标点选都一样）：
   * - skill → 插能力徽章
   * - command → 只把 `/name ` 写进 composer（**不执行**）
   * - argument → 应用参数候选
   * 执行只发生在表单提交（handleSubmit）——命令文本写完后回车才跑。
   */
  function selectSlashItem(item: SlashMenuItem) {
    setShowCapabilityPicker(false);
    setSlashQuery("");
    setSlashArgumentArmed(false);
    if (item.kind === "skill") {
      setSlashCommandContext(null);
      insertCapabilityAtCursor({ kind: "skill", id: item.id, name: item.name, description: item.description, active: true });
      return;
    }
    if (item.kind === "argument") {
      applyArgumentCompletion(item);
      return;
    }
    if (item.kind === "builtin") {
      insertBuiltinCommandAtCursor(item);
      return;
    }
    insertCommandAtCursor(item);
  }

  /**
   * 内置命令（目前 `/reload`）复用包命令的插入落点，但没有包、也没有参数补全：
   * 只填 `/name`，不弹参数菜单；回车提交时由 `handleSubmit` 派发给 /api/builtin-command。
   */
  function insertBuiltinCommandAtCursor(item: Extract<SlashMenuItem, { kind: "builtin" }>) {
    insertCommandAtCursor(
      {
        kind: "command",
        packageId: "",
        packageName: "",
        name: item.name,
        description: item.description,
        hasArgumentCompletions: false,
      },
      { trailingSpace: false },
    );
  }

  /**
   * Packages 页 / 项目能力面板里点 action（不直接执行）：
   * 把 `/command ` 填进当前对话的 composer，有参数补全的会自动弹参数/实例列表，
   * 和斜杠菜单选中是同一条落点；执行仍然只在回车提交时发生。
   */
  function insertPackageCommandIntoComposer(packageId: string, commandName: string) {
    const pkg = capabilities.packages.find((candidate) => candidate.id === packageId);
    const command = pkg?.commands.find((candidate) => candidate.name === commandName);
    if (!pkg || !command) {
      return;
    }
    setActiveMainView("chat");
    insertCommandAtCursor(
      {
        kind: "command",
        packageId: pkg.id,
        packageName: pkg.name,
        name: command.name,
        description: command.description ?? pkg.description,
        hasArgumentCompletions: Boolean(command.hasArgumentCompletions),
      },
      { atEnd: true, trailingSpace: false },
    );
    // 关面板 / 切视图都可能顺手改焦点（Radix 会把焦点还给按钮）：下一帧确认光标回 composer。
    requestAnimationFrame(() => {
      const editor = composerEditorRef.current;
      if (editor && !editor.contains(document.activeElement)) {
        editor.focus({ preventScroll: true });
      }
    });
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
      icon.innerHTML = attachment.kind === "directory"
        ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`
        : `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg>`;
      badge.appendChild(icon);
    }

    const copy = document.createElement("span");
    copy.className = "attachment-badge-copy";
    const title = document.createElement("strong");
    title.title = attachment.name;
    title.textContent = attachment.name;
    const size = document.createElement("small");
    size.textContent = attachment.kind === "directory"
      ? t("composer.attachment.folder")
      : formatFileSize(attachment.size);
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

  const closeInTaskSearch = useCallback(() => {
    setInTaskSearch({ open: false, query: "", activeIndex: 0 });
    setInTaskMatchCount(0);
  }, []);

  const openInTaskSearch = useCallback(() => {
    setInTaskSearch((state) => (state.open ? state : { open: true, query: "", activeIndex: 0 }));
    setInTaskMatchCount(0);
  }, []);

  const handleInTaskSearchQueryChange = useCallback((query: string) => {
    setInTaskSearch((state) => ({ ...state, open: true, query, activeIndex: 0 }));
  }, []);

  const handleInTaskSearchCount = useCallback((count: number) => {
    setInTaskMatchCount(count);
    setInTaskSearch((state) =>
      state.open ? { ...state, activeIndex: clampMatchIndex(state.activeIndex, count) } : state,
    );
  }, []);

  const stepInTaskSearch = useCallback(
    (direction: 1 | -1) => {
      setInTaskSearch((state) =>
        state.open ? { ...state, activeIndex: stepMatchIndex(state.activeIndex, inTaskMatchCount, direction) } : state,
      );
    },
    [inTaskMatchCount],
  );

  // 切会话就收起会话内搜索：高亮属于上一条会话的 DOM，留着只会让人以为新会话也搜过了。
  useEffect(() => {
    closeInTaskSearch();
  }, [visibleSessionPath, closeInTaskSearch]);

  // 全局 ⌘K（Ctrl+K）/ ⌘F（Ctrl+F）。捕获阶段拦住 ⌘F，否则浏览器/Electron 会先开
  // 原生「在页面中查找」。
  useEffect(() => {
    function handleSearchShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setGlobalSearchOpen((open) => !open);
        return;
      }
      if (key === "f") {
        event.preventDefault();
        setGlobalSearchOpen(false);
        openInTaskSearch();
      }
    }

    window.addEventListener("keydown", handleSearchShortcut, true);
    return () => window.removeEventListener("keydown", handleSearchShortcut, true);
  }, [openInTaskSearch]);

  async function handleGlobalSearchSelect(result: SessionSearchResult) {
    // 结果可能在「全局技能与扩展」页上被点中，先切回会话视图，否则切了会话也看不见。
    setActiveMainView("chat");
    // 目标会话的消息全是历史，不该重放进入动画（和侧栏切会话同一处理）。
    markThreadSwitch();
    try {
      await selectSession(result.projectId, result.sessionPath);
    } catch {
      // `selectSession` 内部已把错误写进 state，这里不再重复报错。
      return;
    }
    if (!result.messageId) {
      return;
    }
    // 切会话是异步的，目标线程此刻可能还没挂载；总线会把请求暂存到它订阅为止，
    // 挂载后视口 owner 会滚到这条消息并闪一下。
    chatJumpBus.request(result.sessionPath, result.messageId, "global-search");
  }

  // The context panel lists what *this conversation* pulls in, so the full-width
  // Global skills & packages page has no right panel next to it.
  const showContextPanel = activeMainView === "chat";

  return (
    <div
      className="app-shell-surface flex h-dvh max-h-dvh min-h-0 flex-col overflow-hidden rounded-[var(--window-radius)] border"
      style={
        {
          // 列宽挂在 shell（而不是 .app-main）上：标题栏要按侧栏宽度决定自己哪一段透明
          // —— codex 主题下侧栏通高、上沿没有横向分界（见 styles.css 的 codex chrome）。
          "--left-sidebar-width": leftSidebarCollapsed ? "0px" : `${leftSidebarWidth}px`,
          "--right-panel-width": rightPanelCollapsed || !showContextPanel ? "0px" : `${rightPanelWidth}px`,
        } as CSSProperties
      }
    >
      <TitleBar
        title={stripTerminalSequences(state.extensionTitle ?? "").trim() || conversation.title}
        leftSidebarCollapsed={leftSidebarCollapsed}
        rightPanelCollapsed={rightPanelCollapsed}
        showContextPanel={showContextPanel}
        onToggleLeft={toggleLeftPanel}
        onToggleRight={toggleRightPanel}
        onOpenSearch={() => setGlobalSearchOpen(true)}
      />
      <main
        className="app-main grid h-[calc(100dvh-var(--titlebar-height))] max-h-[calc(100dvh-var(--titlebar-height))] min-h-0 grid-cols-[var(--left-sidebar-width)_3px_minmax(0,1fr)_3px_var(--right-panel-width)] overflow-hidden max-[920px]:grid-cols-[minmax(0,1fr)]"
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
          onSaveToolSettings={(input) => saveToolSettings(input)}
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
          className="conversation-column relative h-full min-h-0 min-w-0 overflow-hidden"
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
            <SessionWorktreeBadge
              info={sessionWorktree.info}
              isCreatingBranch={sessionWorktree.isCreatingBranch}
              isRemoving={sessionWorktree.isRemoving}
              isStreaming={state.isStreaming}
              onRefresh={() => void sessionWorktree.refresh()}
              onReveal={() => void sessionWorktree.revealWorktree()}
              onCreateBranch={sessionWorktree.createBranch}
              onRemove={sessionWorktree.removeWorktree}
            />
            <ProjectCommandControls
              commands={projectCommands.commands}
              selectedCommandId={projectCommands.selectedCommandId}
              candidates={projectCommands.candidates}
              isDetecting={projectCommands.isDetecting}
              isRunning={projectCommands.isRunning}
              isLoading={projectCommands.isLoading}
              error={projectCommands.error}
              loadError={projectCommands.loadError}
              onRun={() => void projectCommands.run()}
              runTarget={projectCommandTerminal}
              onRunTargetChange={handleProjectCommandTerminalChange}
              lastRun={projectCommands.lastRun}
              runs={projectCommands.runs}
              isStoppingRun={projectCommands.isStoppingRun}
              onStopRun={(runId) => void projectCommands.stopRun(runId)}
              onDismissRun={projectCommands.clearLastRun}
              onRevealLog={revealRunLog}
              onSelect={(id) => void projectCommands.selectCommand(id)}
              onRemove={(id) => void projectCommands.removeCommand(id)}
              onUpdate={(id, patch) => void projectCommands.updateCommand(id, patch)}
              onAddManual={(draft) => void projectCommands.addManualCommand(draft)}
              onDetect={() => void projectCommands.detect()}
              onAdd={(candidate) => void projectCommands.addCommand(candidate)}
            />
            <GitStatusBadge
              info={projectGit.info}
              isInitializing={projectGit.isInitializing}
              isRefreshing={projectGit.isRefreshing}
              switchingTo={projectGit.switchingTo}
              isCreatingBranch={projectGit.isCreatingBranch}
              isRenamingBranch={projectGit.isRenamingBranch}
              deletingBranch={projectGit.deletingBranch}
              isCommitting={projectGit.isCommitting}
              isGeneratingMessage={projectGit.isGeneratingMessage}
              isPushing={projectGit.isPushing}
              isPulling={projectGit.isPulling}
              isMergingBranch={projectGit.isMergingBranch}
              isStreaming={state.isStreaming}
              error={projectGit.error}
              notice={projectGit.notice}
              onInit={() => void projectGit.initRepo()}
              onRefresh={() => void projectGit.refresh()}
              onSwitchBranch={projectGit.switchBranch}
              onCreateBranch={projectGit.createBranch}
              onRenameBranch={projectGit.renameBranch}
              onDeleteBranch={projectGit.deleteBranch}
              onCommit={projectGit.commitChanges}
              onPush={projectGit.pushBranch}
              onPull={projectGit.pullBranch}
              onMergeBranch={projectGit.mergeBranch}
              onOpenDiff={projectGit.openDiff}
              onOpenFile={projectGit.openFile}
              onAutoResolveConflicts={autoResolveConflicts}
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

        <div className="conversation-thread-area relative flex min-h-0 flex-1 flex-col">
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
            searchQuery={inTaskSearch.open ? inTaskSearch.query : ""}
            searchActiveIndex={inTaskSearch.activeIndex}
            onSearchCountChange={handleInTaskSearchCount}
          />
          {inTaskSearch.open ? (
            <InTaskSearchBar
              query={inTaskSearch.query}
              count={inTaskMatchCount}
              activeIndex={inTaskSearch.activeIndex}
              onQueryChange={handleInTaskSearchQueryChange}
              onStep={stepInTaskSearch}
              onClose={closeInTaskSearch}
            />
          ) : null}
        </div>

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
          ) : builtinNotice ? (
            <div className="compaction-notice" data-tone={builtinNotice.tone} role="status">
              {builtinNotice.tone === "running" ? <Loader2 className="compaction-notice-spin" /> : null}
              <span className="compaction-notice-text">{builtinNotice.text}</span>
            </div>
          ) : null}
          {extensionAboveWidgets.length ? (
            <ExtensionWidgetStack
              widgets={extensionAboveWidgets}
              collapsible
              collapsed={extensionWidgetsCollapsed}
              onToggle={toggleExtensionWidgets}
            />
          ) : null}
          <input
            ref={fileInputRef}
            className="composer-file-input"
            type="file"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              if (event.target.files) {
                setComposerError(addFiles(event.target.files));
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
                {Object.keys(state.extensionUiStatus).length ? (
                  <div className="extension-status-anchor" ref={extensionStatusRef}>
                    <button
                      className={`composer-tool-button extension-status-trigger ${showExtensionStatus ? "is-open" : ""}`}
                      type="button"
                      onClick={() => setShowExtensionStatus((value) => !value)}
                      aria-expanded={showExtensionStatus}
                      aria-label={t("extensionStatus.open")}
                      title={t("extensionStatus.open")}
                    >
                      <Activity size={15} />
                    </button>
                    {showExtensionStatus ? <ExtensionStatusBar status={state.extensionUiStatus} /> : null}
                  </div>
                ) : null}
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
              highlightIndex={visibleSlashHighlight}
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
              onInsertPackageCommand={insertPackageCommandIntoComposer}
              onSaveMcpServer={saveMcpServer}
              onInspectMcpServer={inspectMcpServer}
              onReadMcpServer={readMcpServerDetail}
              onParseMcpImport={parseMcpImport}
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
          onInsertPackageCommand={insertPackageCommandIntoComposer}
          onSaveMcpServer={saveMcpServer}
          onInspectMcpServer={inspectMcpServer}
          onReadMcpServer={readMcpServerDetail}
          onParseMcpImport={parseMcpImport}
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
          toolSettings={bootstrap.toolSettings}
          onSaveToolSettings={(input) => saveToolSettings(input)}
          appearance={appearance}
          onAppearanceChange={setAppearance}
          archivedSessions={bootstrap.archivedSessions ?? []}
          onUnarchiveSession={unarchiveSession}
          onDeleteArchivedSession={deleteArchivedSession}
          onDeleteAllArchivedSessions={deleteAllArchivedSessions}
        />
        <GlobalSearchDialog
          open={globalSearchOpen}
          onOpenChange={setGlobalSearchOpen}
          onSelect={(result) => void handleGlobalSearchSelect(result)}
        />
      </main>
    </div>
  );
}
/* moved to src/app/AttachmentHoverCard.tsx */

/* moved to src/app/UsagePopover.tsx */

/* moved to src/app/UsagePopover.tsx */


/** 扩展状态列表（`ctx.ui.setStatus`）：渲染在模型选择左边的浮动层里。 */
function ExtensionStatusBar({ status }: { status: Record<string, string> }) {
  return (
    <section className="extension-status-popover" role="dialog" aria-label={t("extensionStatus.title")}>
      <p className="extension-status-title">{t("extensionStatus.title")}</p>
      {Object.entries(status).map(([key, value]) => (
        <div className="extension-status-row" key={key} title={key}>
          {stripTerminalSequences(value)}
        </div>
      ))}
    </section>
  );
}
/* moved to src/app/CapabilitySurfaces.tsx */

/* moved to src/app/CapabilitySurfaces.tsx */

/* moved to src/app/Sidebar.tsx */

/* moved to src/app/TitleBarChrome.tsx */


function normalizePercent(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return null;
  }

  return Math.max(0, Math.min(100, value));
}
/* moved to src/app/AttachmentHoverCard.tsx */


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
/* moved to src/app/AttachmentHoverCard.tsx */


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
/* moved to src/app/Sidebar.tsx */


function escapeCssIdent(value: string) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}
/* moved to src/app/CapabilitiesPage.tsx */

