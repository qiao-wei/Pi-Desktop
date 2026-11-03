import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  AmbientBootstrap,
  BootstrapResponse,
  ExtensionUiRequest,
  ExtensionUiResponse,
  PromptAttachmentInput,
  PromptMessagePartInput,
  PromptStreamEvent,
} from "../../lib/api";
import { fetchAmbientBootstrap, fetchBootstrap, postExtensionUiResponse, postJson, reportDiagnostic, streamNdjson } from "../../lib/api";
import { isAbortError } from "../../lib/bridge/transport";
import { isAppWindowFocused, showSystemNotification } from "../../lib/systemNotification";
import { loadUiPreferences } from "../../lib/ui-preferences";
import { t } from "../../i18n";
import { choosePollMode, pollDelayMs } from "./pollMode";
import { createPromptFeed, type FeedLoss, type PromptFeed } from "./promptFeed";
import {
  createDefaultBootstrap,
  createDefaultCapabilities,
  createDefaultConversation,
  createDefaultProject,
  createDefaultSnapshot,
} from "./appDefaults";
import { applyAmbientBootstrap, isBootstrapForSession } from "./ambientState";
import { mergeStreamingBootstrap, prependOlderMessages } from "./bootstrapPatch";
import { ACCEPTED_EVENT_TYPES } from "./acceptedStreamEvents";
import { useFileBaselineReader } from "./useFileBaseline";
import { useOlderMessagePaging } from "./useOlderMessagePaging";
import { createStreamCommitBuffer } from "./streamCommitBuffer";
import { createSessionStreamState, type SessionStreamState } from "./sessionStreamState";
import { createId } from "../../lib/id";
import type { ContextUsagePatch } from "./bootstrapPatch";
import {
  normalizeMessageProcessBlocks,
  settleStreamingMessages,
  upsertLocalFallbackSession,
  promoteSessionRow,
  touchConversation,
  applyContextUsage,
  withMessages,
  withStats,
} from "./bootstrapPatch";
import {
  bubbleTurnOf,
  countBubbleStats,
  createProvisionalTurn,
  discardProvisionalTurn,
  replaceTurnWithProvisional,
} from "../../shared/chatBubbles";
import { compactionOutcome } from "../../shared/compactionNotice";
import { attachmentKindFromMimeType } from "../../shared/attachmentKind";
import { composeTurnNotificationBody, resolveTurnNotificationLabel, shouldNotifyTurnSettled } from "../../shared/turnNotifications";
import { isSessionBusy } from "../../shared/sessionBusy";
import {
  queuedComposerEntriesFromBubbles,
  type ClearedComposerQueue,
} from "./queuedComposerText";
import {
  createChatStreamView,
  finalizeChatStreamView,
  projectStreamEvent,
  type ChatStreamView,
  streamingBubbleId,
} from "../../shared/chatStreamProjection";
import { perfCount, perfMark, perfMeasure } from "../../lib/perf";
import {
  hasCapabilityPart,
  promptFallback,
} from "./promptFallbacks";
import type {
  ChatAttachment,
  ChatMessage,
  CapabilitiesState,
  CapabilityCommandArgument,
  CapabilityKind,
  CapabilityMcpDetail,
  CapabilityMcpImportResult,
  CapabilityMcpInspection,
  CreateProjectResult,
  PersonalizationSettings,
  ThinkingLevel,
  ToolToggleState,
} from "../../types";

interface AppState {
  bootstrap: BootstrapResponse | null;
  draft: string;
  selectedThinkingLevel: ThinkingLevel;
  isBootstrapping: boolean;
  isStreaming: boolean;
  isStopping: boolean;
  isCompacting: boolean;
  /**
   * Last compaction that failed, tagged with the session it happened in: the
   * strip stays up until the user dismisses it, so it must not follow them into
   * another conversation. Cleared when a later compaction succeeds.
   */
  compactionError: { sessionPath: string; message: string } | null;
  error: string | null;
  extensionUiRequests: ExtensionUiRequest[];
  extensionUiStatus: Record<string, string>;
  extensionUiWidgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  extensionUiNotifications: Array<{ id: string; message: string; type: "info" | "warning" | "error" }>;
  extensionTitle?: string;
  extensionEditorText?: string;
}

/** Progress text pi reports for a package install/update (`pi` phase `start` carries the only message). */
type CapabilityProgressReporter = (message: string) => void;

type Action =
  | { type: "bootstrap-start" }
  | { type: "bootstrap-success"; bootstrap: BootstrapResponse }
  | { type: "bootstrap-error"; error: string }
  | { type: "set-draft"; draft: string }
  | { type: "set-thinking-level"; thinkingLevel: ThinkingLevel }
  | { type: "set-streaming"; value: boolean }
  | { type: "set-stopping"; value: boolean }
  | { type: "set-compacting"; value: boolean }
  | { type: "set-compaction-error"; sessionPath: string; message: string | null }
  | { type: "dismiss-compaction-error" }
  | { type: "set-error"; error: string | null }
  | { type: "set-extension-ui-requests"; requests: ExtensionUiRequest[] }
  | {
      type: "set-extension-ui-surface";
      status: Record<string, string>;
      widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
      notifications: Array<{ id: string; message: string; type: "info" | "warning" | "error" }>;
      title?: string;
      editorText?: string;
    }
  | {
      type: "set-bubbles";
      sessionPath: string;
      bubbles: ChatMessage[];
    }
  | {
      type: "set-context-usage";
      sessionPath: string;
      usage: ContextUsagePatch;
    }
  | {
      type: "seed-session-row";
      sessionPath: string;
      userMessage: ChatMessage;
      messageCount: number;
    }
  | {
      /** 提交起跑时把会话立即置顶，不等服务端快照。 */
      type: "promote-session-row";
      sessionPath: string;
      updatedAt?: number;
    }
  | { type: "finish-session-streaming-messages"; sessionPath: string }
  | {
      /** 往窗口前面补一页更早的历史（id 是绝对的，可以直接接在前面）。 */
      type: "prepend-session-messages";
      sessionPath: string;
      messages: ChatMessage[];
      oldestTurn: number;
      hasMoreBefore: boolean;
    }
  | { type: "replace-bootstrap"; bootstrap: BootstrapResponse; sessionPath?: string }
  | { type: "replace-capabilities"; capabilities: CapabilitiesState }
  | { type: "apply-ambient"; ambient: AmbientBootstrap; sessionPath: string };

function normalizeBootstrap(bootstrap: BootstrapResponse): BootstrapResponse {
  return perfMeasure("normalize.bootstrap", () => normalizeBootstrapValue(bootstrap), bootstrapWeight);
}

/** Cheap payload weight probe (length reads only, no serialisation). */
function bootstrapWeight(bootstrap: BootstrapResponse) {
  let chars = 0;
  for (const message of bootstrap.snapshot.conversation.messages) {
    chars += message.content?.length ?? 0;
    for (const block of message.processBlocks ?? []) {
      if (block.kind === "tool") {
        chars += (block.callText?.length ?? 0) + (block.resultText?.length ?? 0);
      } else {
        chars += block.text?.length ?? 0;
      }
    }
  }
  return { messages: bootstrap.snapshot.conversation.messages.length, chars };
}

function normalizeBootstrapValue(bootstrap: BootstrapResponse): BootstrapResponse {
  const defaultSnapshot = createDefaultSnapshot();
  const project = {
    ...defaultSnapshot.project,
    ...bootstrap.snapshot.project,
    sessions: bootstrap.snapshot.project?.sessions ?? [],
  };

  return {
    ...bootstrap,
    snapshot: {
      ...bootstrap.snapshot,
      project,
      conversation: {
        ...createDefaultConversation(),
        ...bootstrap.snapshot.conversation,
        messages: (bootstrap.snapshot.conversation?.messages ?? []).map(normalizeMessageProcessBlocks),
      },
      stats: {
        ...createDefaultSnapshot().stats,
        ...bootstrap.snapshot.stats,
      },
      modelConfig: {
        ...defaultSnapshot.modelConfig,
        ...bootstrap.snapshot.modelConfig,
      },
    },
    projects: (bootstrap.projects ?? []).map((nextProject) => ({
      ...createDefaultProject(),
      ...nextProject,
      sessions: nextProject.sessions ?? [],
    })),
    activeProjectId: bootstrap.activeProjectId ?? project.id,
    activeSessionPath: bootstrap.activeSessionPath ?? bootstrap.snapshot.conversation.sessionFile,
    projectTrusted: bootstrap.projectTrusted ?? false,
    availableModels: bootstrap.availableModels ?? [],
    skills: bootstrap.skills ?? [],
    capabilities: normalizeCapabilities(bootstrap.capabilities),
    streamingSessionPaths: bootstrap.streamingSessionPaths ?? [],
    compactingSessionPaths: bootstrap.compactingSessionPaths ?? [],
    personalization: {
      ...(bootstrap.personalization ?? {}),
      style: bootstrap.personalization?.style ?? "default",
      customInstructions: bootstrap.personalization?.customInstructions ?? "",
      persona: bootstrap.personalization?.persona ?? "",
      extensionUi: bootstrap.personalization?.extensionUi ?? "tui",
    },
  };
}

/**
 * The capability slice on its own. A capability switch never moves the transcript, so
 * `updateCapability` folds a fresh slice back through this without re-normalising - or even
 * re-fetching - the whole conversation.
 */
function normalizeCapabilities(capabilities?: CapabilitiesState | null): CapabilitiesState {
  const defaults = createDefaultCapabilities();
  return {
    ...defaults,
    ...(capabilities ?? {}),
    skills: capabilities?.skills ?? [],
    packages: capabilities?.packages ?? [],
    extensions: capabilities?.extensions ?? [],
    mcpServers: capabilities?.mcpServers ?? [],
    builtinCommands: capabilities?.builtinCommands ?? [],
    session: {
      ...defaults.session,
      ...(capabilities?.session ?? {}),
    },
  };
}

function isActiveSessionStreaming(bootstrap: BootstrapResponse): boolean {
  const sessionPath = bootstrap.activeSessionPath ?? bootstrap.snapshot.conversation.sessionFile;
  return Boolean(sessionPath && bootstrap.streamingSessionPaths?.includes(sessionPath));
}

function isActiveSessionCompacting(bootstrap: BootstrapResponse): boolean {
  const sessionPath = bootstrap.activeSessionPath ?? bootstrap.snapshot.conversation.sessionFile;
  return Boolean(sessionPath && bootstrap.compactingSessionPaths?.includes(sessionPath));
}

function clientErrorDetails(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "bootstrap-start":
      return { ...state, isBootstrapping: true, error: null };
    case "bootstrap-success": {
      const bootstrap = normalizeBootstrap(action.bootstrap);
      return {
        ...state,
        bootstrap,
        selectedThinkingLevel: bootstrap.snapshot.modelConfig.thinkingLevel,
        isBootstrapping: false,
        isStreaming: isActiveSessionStreaming(bootstrap),
        isCompacting: isActiveSessionCompacting(bootstrap),
        error: bootstrap.error ?? null,
        extensionUiRequests: bootstrap.pendingExtensionUiRequests ?? [],
    };
    }
    case "bootstrap-error":
      return { ...state, isBootstrapping: false, error: action.error };
    case "set-draft":
      return { ...state, draft: action.draft };
    case "set-thinking-level":
      return { ...state, selectedThinkingLevel: action.thinkingLevel };
    case "set-streaming":
      return { ...state, isStreaming: action.value };
    case "set-stopping":
      return { ...state, isStopping: action.value };
    case "set-compacting":
      return { ...state, isCompacting: action.value };
    case "set-compaction-error":
      return {
        ...state,
        compactionError: action.message
          ? { sessionPath: action.sessionPath, message: action.message }
          : state.compactionError?.sessionPath === action.sessionPath
            ? null
            : state.compactionError,
      };
    case "dismiss-compaction-error":
      return { ...state, compactionError: null };
    case "set-error":
      return { ...state, error: action.error };
    case "set-extension-ui-requests":
      return { ...state, extensionUiRequests: action.requests };
    case "set-extension-ui-surface":
      return {
        ...state,
        extensionUiStatus: action.status,
        extensionUiWidgets: action.widgets,
        extensionUiNotifications: action.notifications,
        extensionTitle: action.title,
        extensionEditorText: action.editorText,
      };
    case "set-context-usage": {
      if (!state.bootstrap || !isBootstrapForSession(state.bootstrap, action.sessionPath)) {
        return state;
      }
      const patched = applyContextUsage(state.bootstrap, action.usage);
      return patched.changed ? { ...state, bootstrap: patched.bootstrap } : state;
    }
    case "set-bubbles": {
      if (!state.bootstrap || !isBootstrapForSession(state.bootstrap, action.sessionPath)) {
        return state;
      }
      const patched = withMessages(state.bootstrap, action.bubbles);
      if (!patched.changed) {
        return state;
      }
      // Conversation counters are derived from the bubbles themselves, so an
      // optimistic patch and the next snapshot can never disagree.
      const bootstrap = withStats(patched.bootstrap, {
        ...patched.bootstrap.snapshot.stats,
        ...countBubbleStats(action.bubbles),
      });
      return { ...state, bootstrap: touchConversation(bootstrap) };
    }
    case "seed-session-row": {
      if (!state.bootstrap || !isBootstrapForSession(state.bootstrap, action.sessionPath)) {
        return state;
      }
      if (state.bootstrap.snapshot.stats.userMessageCount > 0) {
        return state;
      }

      // The first message of a brand new session also has to materialise the
      // local fallback session row, which mutates projects/snapshot in place.
      // That path is once per session and the conversation is empty, so a deep
      // copy is fine there; everything else stays structurally shared.
      const bootstrap = structuredCloneBootstrap(state.bootstrap);
      upsertLocalFallbackSession(bootstrap, action.sessionPath, action.userMessage, action.messageCount);
      return { ...state, bootstrap };
    }
    case "promote-session-row": {
      if (!state.bootstrap || !isBootstrapForSession(state.bootstrap, action.sessionPath)) {
        return state;
      }
      const patched = promoteSessionRow(state.bootstrap, action.sessionPath, action.updatedAt);
      return patched.changed ? { ...state, bootstrap: patched.bootstrap } : state;
    }
    case "finish-session-streaming-messages": {
      if (!state.bootstrap || !isBootstrapForSession(state.bootstrap, action.sessionPath)) {
        return state;
      }

      const patched = settleStreamingMessages(state.bootstrap);
      if (!patched.changed) {
        return state;
      }
      return { ...state, bootstrap: touchConversation(patched.bootstrap) };
    }
    case "prepend-session-messages": {
      if (!state.bootstrap || !isBootstrapForSession(state.bootstrap, action.sessionPath)) {
        return state;
      }
      const next = prependOlderMessages(state.bootstrap, action);
      return next === state.bootstrap ? state : { ...state, bootstrap: next };
    }
    case "replace-bootstrap": {
      if (action.sessionPath && state.bootstrap && !isBootstrapForSession(state.bootstrap, action.sessionPath)) {
        return state;
      }
      const normalizedBootstrap = normalizeBootstrap(action.bootstrap);
      const mergeWith = action.sessionPath && state.bootstrap;
      // 计数留在调用侧：bootstrapPatch 是纯数据变换，不引入 perf（会拖进整个 app 图）。
      if (mergeWith) perfCount("merge.streamingBootstrap");
      const bootstrap = mergeWith
        ? mergeStreamingBootstrap(mergeWith, normalizedBootstrap, action.sessionPath!)
        : normalizedBootstrap;
      return {
        ...state,
        bootstrap,
        selectedThinkingLevel: bootstrap.snapshot.modelConfig.thinkingLevel,
        isBootstrapping: false,
        isStreaming: isActiveSessionStreaming(bootstrap),
        isCompacting: isActiveSessionCompacting(bootstrap),
        error: null,
        extensionUiRequests: bootstrap.pendingExtensionUiRequests ?? [],
      };
    }
    case "apply-ambient": {
      // The transcript is deliberately untouched: this window's own stream is what
      // carries it. Only what the stream cannot carry gets folded in - which sessions
      // are still busy, whether prompting is allowed again, the queue sequence floor.
      //
      // Removing a 插话 the server dropped still belongs to the full reconcile
      // (`mergeStreamingBootstrap` is the one place allowed to do that), and every
      // situation where that matters forces a full poll: a stop sets `isStopping`, and
      // the run consuming its own queue tells us about it on the stream.
      const bootstrap = applyAmbientBootstrap(state.bootstrap, action.ambient, action.sessionPath);
      if (!bootstrap) {
        return state;
      }

      return {
        ...state,
        bootstrap,
        isStreaming: isActiveSessionStreaming(bootstrap),
        isCompacting: isActiveSessionCompacting(bootstrap),
      };
    }
    case "replace-capabilities": {
      if (!state.bootstrap) {
        return state;
      }
      // Only the capability slice moves; conversation, projects and model config stay structurally shared.
      return {
        ...state,
        bootstrap: { ...state.bootstrap, capabilities: normalizeCapabilities(action.capabilities) },
      };
    }
    default:
      return state;
  }
}

function structuredCloneBootstrap(bootstrap: BootstrapResponse): BootstrapResponse {
  const started = performance.now();
  const copy = structuredClone(bootstrap);
  perfMark("clone.bootstrap", performance.now() - started);
  return copy;
}

function createInitialState(): AppState {
    return {
      bootstrap: null,
    draft: "",
    selectedThinkingLevel: "low",
    isBootstrapping: false,
    isStreaming: false,
    isStopping: false,
      isCompacting: false,
      compactionError: null,
      error: null,
      extensionUiRequests: [],
      extensionUiStatus: {},
      extensionUiWidgets: {},
      extensionUiNotifications: [],
    };
  }

export function usePiDesktopApp() {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const activeSessionPathRef = useRef<string | undefined>(undefined);
  const streamStatesRef = useRef(new Map<string, SessionStreamState>());
  const sessionBootstrapsRef = useRef(new Map<string, BootstrapResponse>());
  const extensionUiRequestsRef = useRef<ExtensionUiRequest[]>([]);
  const extensionUiStatusRef = useRef<Record<string, string>>({});
  const extensionUiWidgetsRef = useRef<AppState["extensionUiWidgets"]>({});
  const extensionUiNotificationsRef = useRef<AppState["extensionUiNotifications"]>([]);
  const extensionUiNotificationTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const extensionTitleRef = useRef<string | undefined>(undefined);
  const extensionEditorTextRef = useRef<string | undefined>(undefined);
  const stopRequestIdRef = useRef(0);
  // Wall-clock time of the last event that arrived on this client's own stream.
  // Used to decide how eagerly the busy-session poll has to run.
  const lastStreamEventAtRef = useRef(0);
  /** When we last folded in a full snapshot; the ambient watchdog counts from here. */
  const lastFullReconcileAtRef = useRef(0);
  /** 已提醒过的轮次（sessionPath → lifecycleGeneration）：保证一轮只响一次系统通知。 */
  const notifiedTurnsRef = useRef(new Map<string, number>());

  const bootstrap = state.bootstrap ?? createDefaultBootstrap();
  /**
   * 「写入前这个文件是什么」：只给 `write` 行算「删了几行」。同步读 + 后台补（派生不能等 I/O）。
   * 必须建在 `bootstrap` **之后**：闭包里读它是惰性的，但编译器仍然把它算成初始化期读取。
   */
  const readFileBaseline = useFileBaselineReader(() => ({
    projectId: bootstrap.activeProjectId || bootstrap.snapshot.conversation.projectId || bootstrap.snapshot.project.id,
    sessionPath: bootstrap.activeSessionPath ?? undefined,
  }));
  const conversation = bootstrap.snapshot.conversation;
  const stats = bootstrap.snapshot.stats;
  const modelConfig = bootstrap.snapshot.modelConfig;
  const availableModels = bootstrap.availableModels;
  const skills = bootstrap.skills;
  const capabilities = bootstrap.capabilities;
  const projects = bootstrap.projects;
  const activeProject = projects.find((project) => project.id === bootstrap.activeProjectId) ?? bootstrap.snapshot.project;

  function syncExtensionUiState() {
    dispatch({
      type: "set-extension-ui-surface",
      status: { ...extensionUiStatusRef.current },
      widgets: { ...extensionUiWidgetsRef.current },
      notifications: [...extensionUiNotificationsRef.current],
      title: extensionTitleRef.current,
      editorText: extensionEditorTextRef.current,
    });
  }

  function resetExtensionUiSurface() {
    for (const timer of extensionUiNotificationTimersRef.current.values()) {
      clearTimeout(timer);
    }
    extensionUiNotificationTimersRef.current.clear();
    extensionUiStatusRef.current = {};
    extensionUiWidgetsRef.current = {};
    extensionUiNotificationsRef.current = [];
    extensionTitleRef.current = undefined;
    extensionEditorTextRef.current = undefined;
    dispatch({
      type: "set-extension-ui-surface",
      status: {},
      widgets: {},
      notifications: [],
      title: undefined,
      editorText: undefined,
    });
  }

  function applyExtensionUiRequest(request: ExtensionUiRequest) {
    if (request.method === "custom" || request.method === "web") {
      if (request.closed) {
        extensionUiRequestsRef.current = extensionUiRequestsRef.current.filter((existing) => existing.id !== request.id);
      } else {
        const existingIndex = extensionUiRequestsRef.current.findIndex((existing) => existing.id === request.id);
        if (existingIndex >= 0) {
          extensionUiRequestsRef.current = extensionUiRequestsRef.current.map((existing, index) =>
            index === existingIndex ? request : existing,
          );
        } else {
          extensionUiRequestsRef.current = [...extensionUiRequestsRef.current, request];
        }
      }
      dispatch({ type: "set-extension-ui-requests", requests: [...extensionUiRequestsRef.current] });
      return;
    }

    if (request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor") {
      if (!extensionUiRequestsRef.current.some((existing) => existing.id === request.id)) {
        extensionUiRequestsRef.current = [...extensionUiRequestsRef.current, request];
        dispatch({ type: "set-extension-ui-requests", requests: [...extensionUiRequestsRef.current] });
      }
      return;
    }

    if (request.method === "notify") {
      const notifications = [
        ...extensionUiNotificationsRef.current,
        {
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        },
      ].slice(-4);
      const retainedIds = new Set(notifications.map((notification) => notification.id));
      for (const [id, timer] of extensionUiNotificationTimersRef.current) {
        if (!retainedIds.has(id) || id === request.id) {
          clearTimeout(timer);
          extensionUiNotificationTimersRef.current.delete(id);
        }
      }
      extensionUiNotificationsRef.current = notifications;
      extensionUiNotificationTimersRef.current.set(request.id, setTimeout(() => {
        extensionUiNotificationTimersRef.current.delete(request.id);
        extensionUiNotificationsRef.current = extensionUiNotificationsRef.current.filter(
          (notification) => notification.id !== request.id,
        );
        syncExtensionUiState();
      }, 10_000));
    } else if (request.method === "setStatus") {
      const next = { ...extensionUiStatusRef.current };
      if (request.statusText) {
        next[request.statusKey] = request.statusText;
      } else {
        delete next[request.statusKey];
      }
      extensionUiStatusRef.current = next;
    } else if (request.method === "setWidget") {
      const next = { ...extensionUiWidgetsRef.current };
      if (request.widgetLines?.length) {
        next[request.widgetKey] = {
          lines: request.widgetLines,
          placement: request.widgetPlacement ?? "aboveEditor",
        };
      } else {
        delete next[request.widgetKey];
      }
      extensionUiWidgetsRef.current = next;
    } else if (request.method === "setTitle") {
      extensionTitleRef.current = request.title;
    } else if (request.method === "set_editor_text") {
      extensionEditorTextRef.current = request.text;
    }
    syncExtensionUiState();
  }

  function syncPendingExtensionUiRequests(requests: ExtensionUiRequest[] | undefined) {
    extensionUiRequestsRef.current = requests ?? [];
    dispatch({ type: "set-extension-ui-requests", requests: [...extensionUiRequestsRef.current] });
  }

  useEffect(() => {
    activeSessionPathRef.current = bootstrap.activeSessionPath ?? conversation.sessionFile;
  }, [bootstrap.activeSessionPath, conversation.sessionFile]);

  useEffect(() => () => {
    for (const timer of extensionUiNotificationTimersRef.current.values()) {
      clearTimeout(timer);
    }
    extensionUiNotificationTimersRef.current.clear();
  }, []);

  function getSessionStreamState(sessionPath: string): SessionStreamState {
    const existing = streamStatesRef.current.get(sessionPath);
    if (existing) {
      return existing;
    }

    const next = createSessionStreamState();
    streamStatesRef.current.set(sessionPath, next);
    return next;
  }

  function finishLocalStreamingTurn(sessionPath: string, streamState: SessionStreamState) {
    const bubbles = currentBubbles(sessionPath);
    streamState.activeBubbleId = null;
    if (!bubbles) {
      return;
    }

    const finalized = finalizeChatStreamView({
      bubbles,
      activeBubbleId: null,
      droppedEvents: streamState.droppedEvents,
      queueSeq: streamState.queueSeq,
    });
    streamState.droppedEvents = finalized.droppedEvents;
    if (finalized.bubbles !== bubbles) {
      applySessionAction({ type: "set-bubbles", sessionPath, bubbles: finalized.bubbles });
    }
  }

  async function refreshSessionUntilIdle(sessionPath: string, expectedGeneration?: number) {
    const streamState = getSessionStreamState(sessionPath);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (expectedGeneration !== undefined && streamState.lifecycleGeneration !== expectedGeneration) {
        reportDiagnostic("client.stop_poll.cancelled", {
          sessionPath,
          attempt,
          expectedGeneration,
          actualGeneration: streamState.lifecycleGeneration,
        });
        return false;
      }

      try {
        // Forced: this loop has to read `streamingSessionPaths` to decide whether the
        // stop landed, so a "nothing changed" answer is not usable here.
        const next = await fetchBootstrap({ force: true });
        if (expectedGeneration !== undefined && streamState.lifecycleGeneration !== expectedGeneration) {
          reportDiagnostic("client.stop_poll.cancelled", {
            sessionPath,
            attempt,
            expectedGeneration,
            actualGeneration: streamState.lifecycleGeneration,
            phase: "after_bootstrap",
          });
          return false;
        }
        const isBusy = Boolean(
          next.streamingSessionPaths?.includes(sessionPath) ||
          next.compactingSessionPaths?.includes(sessionPath),
        );
        if (!isBusy) {
          if (activeSessionPathRef.current === sessionPath) {
            replaceBootstrap(next, sessionPath);
          }
          return true;
        }
        reportDiagnostic("client.stop_poll.busy", {
          sessionPath,
          attempt,
          streaming: next.streamingSessionPaths?.includes(sessionPath) ?? false,
          compacting: next.compactingSessionPaths?.includes(sessionPath) ?? false,
        });
      } catch (error) {
        reportDiagnostic("client.stop_poll.error", {
          sessionPath,
          attempt,
          ...clientErrorDetails(error),
        });
        // Keep the local stopped state; the regular bootstrap retry handles server outages.
      }

      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }

    reportDiagnostic("client.stop_poll.timeout", { sessionPath, attempts: 8 });
    return false;
  }

  /**
   * 一条 prompt 流坏了之后的**唯一去处**：先续订同一条 run（`promptFeed`），续不上才用
   * 一次强制 bootstrap 追平。
   *
   * 这里故意**不落定这一轮**：桥上的 run 可能还在跑，落定就意味着停止按钮消失、还发一条假的
   * 「已完成」提醒。只有快照明确说它已经不在跑了，才收尾。
   */
  async function reconcileLostFeed(
    sessionPath: string,
    streamState: SessionStreamState,
    loss: FeedLoss,
    /** 丢的是不是**这一轮**的流。插话的流是并行的第二条，它死了不代表主场没收看。 */
    ownsTurn = true,
  ) {
    if (ownsTurn) {
      // 我们的流已经没有了：看门狗必须改走 `full`，否则它会以为转录还在自己手里。
      streamState.streamLost = true;
    }
    reportDiagnostic("client.prompt_feed.lost", {
      sessionPath,
      reason: loss.reason,
      runId: loss.runId,
      lastSeq: loss.lastSeq,
      bridgeMessage: loss.message,
    });

    let latest: BootstrapResponse | null = null;
    try {
      latest = await fetchBootstrap({ force: true });
    } catch (error) {
      reportDiagnostic("client.prompt_feed.reconcile_error", {
        sessionPath,
        ...clientErrorDetails(error),
      });
    }
    if (!latest || activeSessionPathRef.current !== sessionPath) {
      if (activeSessionPathRef.current === sessionPath) {
        dispatch({ type: "set-error", error: t("chat.stream.lostUnreachable") });
      }
      return;
    }

    const busy = Boolean(
      latest.streamingSessionPaths?.includes(sessionPath) ||
      latest.compactingSessionPaths?.includes(sessionPath),
    );
    if (!busy) {
      finishLocalStreamingTurn(sessionPath, streamState);
    }
    // 快照是权威的：转录、忙闲、错误横幅都在这里对齐（所以文案得在它之后发）。
    replaceBootstrap(latest, sessionPath);
    if (!busy) {
      notifyTurnSettled(sessionPath, null);
    }
    dispatch({ type: "set-error", error: t(busy ? "chat.stream.lostBusy" : "chat.stream.lostDone") });
  }

  /**
   * 三个提交路径（新会话、插话、编辑重发）共用的 feed：只差「谁能中止它」和「这一轮还算不算数」。
   */
  function openPromptFeed(options: {
    sessionPath: string;
    streamState: SessionStreamState;
    isCurrent: () => boolean;
    ownerSignal: () => AbortSignal | null;
    apply: (event: PromptStreamEvent) => void;
    /** 这条流是否就是「这一轮」的流。插话那条是并行的，见 `reconcileLostFeed`。 */
    ownsTurn?: boolean;
  }): PromptFeed {
    return createPromptFeed({
      sessionPath: options.sessionPath,
      stream: streamNdjson,
      isCurrent: options.isCurrent,
      ownerSignal: options.ownerSignal,
      apply: options.apply,
      onRepair: ({ attempt, fromSeq }) =>
        reportDiagnostic("client.prompt_feed.repair", {
          sessionPath: options.sessionPath,
          attempt,
          fromSeq,
        }),
      onLost: (loss) =>
        void reconcileLostFeed(options.sessionPath, options.streamState, loss, options.ownsTurn ?? true),
    });
  }

  function rememberBootstrapSession(next: BootstrapResponse): BootstrapResponse {
    const normalized = normalizeBootstrap(next);
    const sessionPath = normalized.activeSessionPath ?? normalized.snapshot.conversation.sessionFile;
    // A full snapshot is the reconcile point the ambient watchdog counts from.
    lastFullReconcileAtRef.current = Date.now();
    const cached = sessionPath ? sessionBootstrapsRef.current.get(sessionPath) : undefined;
    const merged = cached && sessionPath ? mergeStreamingBootstrap(cached, normalized, sessionPath) : normalized;
    if (sessionPath) {
      sessionBootstrapsRef.current.set(sessionPath, merged);
      const streamState = getSessionStreamState(sessionPath);
      streamState.activeBubbleId = streamingBubbleId(merged.snapshot.conversation.messages);
      // A snapshot is fetched fresh, so its sequence is a floor for the queue
      // events we accept from here on.
      streamState.queueSeq = Math.max(streamState.queueSeq, normalized.pendingQueues?.seq ?? 0);
    }
    return merged;
  }

  const { loadOlderMessages, loadingOlderMessages } = useOlderMessagePaging(bootstrap, {
    dispatchPage: dispatch,
    reportError: (message: string) => dispatch({ type: "set-error", error: message }),
  });

  function replaceBootstrap(next: BootstrapResponse, sessionPath?: string) {
    const nextSessionPath = sessionPath ?? next.activeSessionPath ?? next.snapshot.conversation.sessionFile;
    if (activeSessionPathRef.current && nextSessionPath && activeSessionPathRef.current !== nextSessionPath) {
      resetExtensionUiSurface();
    }
    syncPendingExtensionUiRequests(next.pendingExtensionUiRequests);
    dispatch({ type: "replace-bootstrap", bootstrap: rememberBootstrapSession(next), sessionPath });
  }

  /**
   * 一轮 prompt 落定时发系统提醒。
   *
   * `done`、`error`、以及「流直接抛异常」的 catch 三条路都会叫它：服务端在
   * `finalAgentError` 时先写 `error` 再写 `done`，硬异常时只写 `error`，所以去重不靠调用方，
   * 靠「sessionPath + lifecycleGeneration」这份已提醒表（每次提交前 generation 都会 +1，
   * 所以下一轮该响还是会响）。
   *
   * 用户自己按停止不算「完成」：`stopTurn` 先把 generation 抬过，事件在各自的 handler 开头
   * 就早退了，这里根本不会被调到。
   */
  function notifyTurnSettled(sessionPath: string, errorMessage: string | null) {
    const generation = getSessionStreamState(sessionPath).lifecycleGeneration;
    if (notifiedTurnsRef.current.get(sessionPath) === generation) {
      return;
    }
    notifiedTurnsRef.current.set(sessionPath, generation);

    // 开关是现读的：设置页改完立刻生效，不需要把偏好穿进 hook 的依赖链。
    const enabled = loadUiPreferences().notifyOnTurnComplete === true;
    if (!shouldNotifyTurnSettled({ enabled, windowFocused: isAppWindowFocused() })) {
      return;
    }

    // 同步缓存比闭包里的 `bootstrap` 新：`done` 之前的 snapshot 事件已经把「首轮之后
    // 生成的新会话标题」写进来了，所以这里拿到的是最新标题。
    const cached = sessionBootstrapsRef.current.get(sessionPath);
    const label = resolveTurnNotificationLabel({
      sessionPath,
      conversation: cached?.snapshot.conversation ?? conversation,
      sessions: cached?.snapshot.project?.sessions,
    });

    void showSystemNotification({
      title: errorMessage ? t("notification.turnFailed.title") : t("notification.turnComplete.title"),
      body: composeTurnNotificationBody(
        label,
        errorMessage ? t("notification.turnFailed.body") : t("notification.turnComplete.body"),
      ),
    }).then((result) => {
      // macOS 未签名的开发版只会静默失败，所以「以为发了」要留痕。
      if (!result.delivered) {
        reportDiagnostic("client.turn_notification.skipped", {
          sessionPath,
          reason: result.reason ?? "unknown",
        });
      }
    });
  }

  /**
   * Fold in an ambient answer: the busy flags, the approval prompts, the queue
   * sequence floor - and nothing that needs the transcript. Because no conversation
   * is transferred, this costs the same on a 40 KB session and a 4 MB one.
   */
  function acceptAmbientBootstrap(ambient: AmbientBootstrap, sessionPath: string) {
    syncPendingExtensionUiRequests(ambient.pendingExtensionUiRequests);
    const streamState = getSessionStreamState(sessionPath);
    // Still a floor for accepting queue events: a 插话 the server already dropped
    // must not be resurrected by a late `queued` event.
    streamState.queueSeq = Math.max(streamState.queueSeq, ambient.pendingQueues?.seq ?? 0);
    dispatch({ type: "apply-ambient", ambient, sessionPath });
  }

  const handleExtensionUiStreamEvent = useCallback((event: PromptStreamEvent) => {
    if (event.type !== "extension_ui_request" || !event.id || !event.method) {
      return;
    }

    applyExtensionUiRequest(event as ExtensionUiRequest);
  }, []);

  const respondExtensionUi = useCallback(async (response: ExtensionUiResponse) => {
    await postExtensionUiResponse(response);
    // `input`/`inputs`/`action` keep the panel open: the server re-renders it and streams the
    // updated `extension_ui_request` back, so dropping it here would close the panel mid-edit.
    if ("input" in response || "inputs" in response || "action" in response) {
      return;
    }
    extensionUiRequestsRef.current = extensionUiRequestsRef.current.filter((request) => request.id !== response.id);
    dispatch({ type: "set-extension-ui-requests", requests: [...extensionUiRequestsRef.current] });
  }, []);

  function applySessionAction(action: Extract<Action, { sessionPath: string }>) {
    const started = performance.now();
    const visible = activeSessionPathRef.current === action.sessionPath;
    if (!sessionBootstrapsRef.current.has(action.sessionPath) && visible && state.bootstrap) {
      // The session on screen is tracked in React state; mirror it once so the
      // synchronous cache is never a step behind the visible list.
      sessionBootstrapsRef.current.set(action.sessionPath, state.bootstrap);
    }
    const cached = sessionBootstrapsRef.current.get(action.sessionPath);
    if (cached) {
      const nextState = reducer(
        {
          ...createInitialState(),
          bootstrap: cached,
        },
        action,
      );
      if (nextState.bootstrap) {
        sessionBootstrapsRef.current.set(action.sessionPath, nextState.bootstrap);
      }
    }
    // The reducer no longer deep-copies the snapshot, so running it a second
    // time for the visible session is an O(1) patch. Kept as-is on purpose: it
    // preserves the existing "cache entry and visible state may diverge" rules.
    dispatch(action);
    perfMark("action.session", performance.now() - started, { events: 1 });
    perfCount(`action.session.${action.type}`);
  }

  function ensureSessionCache(sessionPath: string) {
    if (!sessionBootstrapsRef.current.has(sessionPath) && isBootstrapForSession(bootstrap, sessionPath)) {
      sessionBootstrapsRef.current.set(sessionPath, bootstrap);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempt = 0;

    async function loadBootstrap() {
      attempt += 1;
      const currentAttempt = attempt;
      dispatch({ type: "bootstrap-start" });
      reportDiagnostic("client.bootstrap.start", { attempt: currentAttempt });
      try {
        // Forced: the first payload of a session must arrive, whatever tag we remember.
        const next = await fetchBootstrap({ force: true });
        const remembered = rememberBootstrapSession(next);
        if (cancelled) {
          return;
        }
        syncPendingExtensionUiRequests(remembered.pendingExtensionUiRequests);
        dispatch({ type: "bootstrap-success", bootstrap: remembered });
        reportDiagnostic("client.bootstrap.success", {
          attempt: currentAttempt,
          activeSessionPath: remembered.activeSessionPath,
          streamingSessionCount: remembered.streamingSessionPaths?.length ?? 0,
          compactingSessionCount: remembered.compactingSessionPaths?.length ?? 0,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        reportDiagnostic("client.bootstrap.error", {
          attempt: currentAttempt,
          ...clientErrorDetails(error),
        });
        dispatch({ type: "bootstrap-error", error: message });
        retryTimer = window.setTimeout(() => {
          void loadBootstrap();
        }, 1000);
      }
    }

    void loadBootstrap();

    return () => {
      cancelled = true;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  useEffect(() => {
    const hasBusySessions = Boolean(
      (bootstrap.streamingSessionPaths?.length ?? 0) || (bootstrap.compactingSessionPaths?.length ?? 0),
    );
    if (!hasBusySessions) {
      return;
    }

    const poll = async () => {
      const requestedSessionPath = activeSessionPathRef.current;
      if (!requestedSessionPath) {
        return;
      }
      try {
        const mode = currentPollMode();
        perfCount(mode === "ambient" ? "poll.ambient" : "poll.full");
        if (mode === "ambient") {
          const ambient = await fetchAmbientBootstrap();
          if (cancelled || activeSessionPathRef.current !== requestedSessionPath) {
            return;
          }

          acceptAmbientBootstrap(ambient, requestedSessionPath);
          // No stop settle here: `choosePollMode` only returns "ambient" when a stop
          // is *not* in flight, so the branch could never have run.
          return;
        }

        // Conditional: while a run is quiet (a long tool call) nothing in this payload
        // moves, and re-parsing ~1 MB per tick is a main-thread stall the user sees as
        // stutter. `null` means "unchanged - keep rendering what we have".
        const next = await fetchBootstrap();
        if (!next) {
          return;
        }
        if (!cancelled && next.activeSessionPath === requestedSessionPath && activeSessionPathRef.current === requestedSessionPath) {
          const confirmedSessionPath = requestedSessionPath;
          syncPendingExtensionUiRequests(next.pendingExtensionUiRequests);
          {
            // A 插话 never blocks reconciliation any more: `mergeChatBubbles`
            // keeps the unconfirmed bubble while the snapshot moves forward.
            replaceBootstrap(next, confirmedSessionPath);
            if (
              state.isStopping &&
              !next.streamingSessionPaths?.includes(confirmedSessionPath) &&
              !next.compactingSessionPaths?.includes(confirmedSessionPath)
            ) {
              dispatch({ type: "set-stopping", value: false });
            }
          }
        }
      } catch (error) {
        reportDiagnostic("client.busy_poll.error", {
          sessionPath: requestedSessionPath,
          ...clientErrorDetails(error),
        });
        // The regular bootstrap retry handles unavailable servers.
      }
    };

    /**
     * What this tick must ask for. See `pollMode.ts` for why the previous shape of
     * this decision was inverted (a healthy stream got 5s ticks and a quiet one got a
     * 1s full pull, so the longest tool calls paid the most MB-sized parses).
     */
    function currentPollMode(): "ambient" | "full" {
      const sessionPath = activeSessionPathRef.current;
      const streamState = sessionPath ? streamStatesRef.current.get(sessionPath) : undefined;
      return choosePollMode({
        // 我们的流已经接不回来（见 promptFeed）→ 转录只能靠 full 快照追平，ambient 不带它。
        ownsStream: Boolean(streamState?.controller) && !streamState?.streamLost,
        isStopping: state.isStopping,
        sinceLastStreamEventMs: Date.now() - lastStreamEventAtRef.current,
        sinceFullReconcileMs: Date.now() - lastFullReconcileAtRef.current,
      });
    }

    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      const delay = pollDelayMs(currentPollMode());
      perfCount("poll.schedule", { delayMs: delay });
      timer = window.setTimeout(() => {
        void poll().finally(() => {
          if (!cancelled) {
            schedule();
          }
        });
      }, delay);
    };

    perfCount("poll.bootstrap.start");
    schedule();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bootstrap.compactingSessionPaths?.join("|"), bootstrap.streamingSessionPaths?.join("|"), state.isStopping]);

  useEffect(() => {
    if (!state.isStopping) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const sessionPath = activeSessionPathRef.current;
      if (!sessionPath) {
        return;
      }

      try {
        const next = await fetchBootstrap();
        if (!next) {
          // Unchanged means still busy: stay locked and ask again on the next tick.
          return;
        }
        const isBusy = Boolean(
          next.streamingSessionPaths?.includes(sessionPath) ||
          next.compactingSessionPaths?.includes(sessionPath),
        );
        if (!cancelled && activeSessionPathRef.current === sessionPath && !isBusy) {
          replaceBootstrap(next, sessionPath);
          dispatch({ type: "set-stopping", value: false });
        }
      } catch (error) {
        reportDiagnostic("client.stopping_poll.error", {
          sessionPath,
          ...clientErrorDetails(error),
        });
        // Keep the composer locked until the server confirms that the session is idle.
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state.isStopping]);

  /**
   * Bubbles of a session as the UI currently knows them. Prefers the rendered
   * state so a patch never silently reverts an already visible change.
   */
  /**
   * The bubble list as of *now*, not as of the last render.
   *
   * Stream events and optimistic placements happen in bursts inside event
   * handlers, where `state` is still the snapshot React rendered with. Reading
   * that here would hand two consecutive updates the same stale list and let
   * the second one erase the first - which is how a 插话 used to wipe the turn
   * that was still streaming. `sessionBootstrapsRef` is written synchronously
   * by {@link applySessionAction}, so it is the authoritative mirror.
   */
  function committedBubbles(sessionPath: string): ChatMessage[] | null {
    const mirrored = sessionBootstrapsRef.current.get(sessionPath)?.snapshot.conversation.messages;
    if (mirrored) {
      return mirrored;
    }
    if (state.bootstrap && isBootstrapForSession(state.bootstrap, sessionPath)) {
      return state.bootstrap.snapshot.conversation.messages;
    }
    return null;
  }

  /**
   * Bubbles as of *now*, including whatever the frame budget is still holding.
   *
   * Anything that reads the transcript must go through here: a pending view carries
   * deltas that committed state does not have yet, so reading the committed list
   * would let the next commit overwrite them - the one way this buffering could lose
   * text, which is why it is a flush rather than a preference.
   */
  function currentBubbles(sessionPath: string): ChatMessage[] | null {
    streamStatesRef.current.get(sessionPath)?.commitBuffer?.flush();
    return committedBubbles(sessionPath);
  }

  /**
   * Feed one stream event through the shared projection. All bubble placement
   * happens there: events carry the id the server computed from the transcript,
   * so nothing here has to infer which answer a delta or a tool belongs to.
   *
   * Per-token events are buffered and committed once per frame; anything structural
   * or terminal flushes the queue first and commits immediately, so a 插话, a tool
   * card, or the end of the run is never a frame behind what is already on screen.
   */
  function applyStreamEvent(sessionPath: string, streamState: SessionStreamState, event: PromptStreamEvent) {
    let buffer = streamState.commitBuffer;
    if (!buffer) {
      buffer = streamState.commitBuffer = createStreamCommitBuffer({
        baseView: () => {
          const bubbles = committedBubbles(sessionPath);
          return bubbles ? createChatStreamView(bubbles, streamState.queueSeq) : null;
        },
        project: (view, streamEvent) => projectStreamedEvent(sessionPath, streamState, view, streamEvent),
        commit: (view) => {
          // 计数器无条件同步：`bubbles` 未变但 `queueSeq`/寻址可能已经前进。
          streamState.activeBubbleId = view.activeBubbleId;
          streamState.queueSeq = view.queueSeq;
          const committed = committedBubbles(sessionPath);
          if (committed && view.bubbles === committed) {
            // The projection decided nothing moved - do not hand React a fresh array
            // identity and rebuild the whole thread for nothing.
            return;
          }

          applySessionAction({ type: "set-bubbles", sessionPath, bubbles: view.bubbles });
        },
      });
    }

    buffer.push(event);
  }

  /**
   * Project one event and do the per-event accounting. The unaddressed-event report
   * has to fire here rather than at commit time: a commit can stand for dozens of
   * events, and the name of the event that was actually lost is the useful part.
   */
  function projectStreamedEvent(
    sessionPath: string,
    streamState: SessionStreamState,
    view: ChatStreamView,
    event: PromptStreamEvent,
  ): ChatStreamView {
    const next = projectStreamEvent(view, event, { readBaseline: readFileBaseline });
    if (next.droppedEvents !== streamState.droppedEvents) {
      perfCount("stream.eventDropped");
      if (next.droppedEvents === 1 || next.droppedEvents % 20 === 0) {
        reportDiagnostic("client.stream_event.unaddressed", {
          sessionPath,
          eventType: event.type,
          bubbleId: event.bubbleId ?? null,
          droppedEvents: next.droppedEvents,
        });
      }
    }

    streamState.droppedEvents = next.droppedEvents;
    return next;
  }

  /** Put a submission on screen before the server has acknowledged it. */
  function placeOptimisticTurn(
    sessionPath: string,
    options: {
      clientMessageId: string;
      content: string;
      attachments: ChatAttachment[];
      contentParts: PromptMessagePartInput[];
      /** Only a submission that starts a run needs the placeholder answer. */
      withAssistant: boolean;
      /** Steering 插话: a queue snapshot is authoritative about this bubble. */
      queued?: boolean;
    },
  ) {
    const bubbles = currentBubbles(sessionPath) ?? [];
    const optimistic = createProvisionalTurn(bubbles, {
      clientMessageId: options.clientMessageId,
      content: options.content,
      attachments: options.attachments,
      contentParts: options.contentParts,
      withAssistant: options.withAssistant,
      queued: options.queued,
    });
    if (options.withAssistant) {
      applySessionAction({
        type: "seed-session-row",
        sessionPath,
        userMessage: optimistic.turn.userMessage,
        messageCount: 2,
      });
      // 这一轮真正起跑：本地先把会话置顶（时钟由 sidebarStreamingSessionPaths 合入）。
      applySessionAction({
        type: "promote-session-row",
        sessionPath,
        updatedAt: optimistic.turn.userMessage.createdAt,
      });
    }
    applySessionAction({ type: "set-bubbles", sessionPath, bubbles: optimistic.bubbles });
  }

  /** Take back an optimistic submission the server never accepted. */
  function rollbackOptimisticTurn(sessionPath: string, clientMessageId: string) {
    const bubbles = currentBubbles(sessionPath);
    if (!bubbles) {
      return;
    }
    const next = discardProvisionalTurn(bubbles, clientMessageId);
    if (next !== bubbles) {
      applySessionAction({ type: "set-bubbles", sessionPath, bubbles: next });
    }
  }

  /**
   * Optimistic edit: put the re-sent turn on screen right away (new text + a
   * streaming placeholder), exactly like the composer does for a new turn. The
   * server's rewind snapshot then confirms the same shape, and the stream's
   * `tN#...` events claim these bubbles.
   */
  function placeOptimisticEditTurn(
    sessionPath: string,
    options: {
      clientMessageId: string;
      targetMessageId: string;
      content: string;
      attachments: ChatAttachment[];
      contentParts: PromptMessagePartInput[];
    },
  ) {
    const turn = bubbleTurnOf(options.targetMessageId);
    if (!turn) {
      return;
    }
    const bubbles = currentBubbles(sessionPath) ?? [];
    // 编辑重发同样起跑一轮：会话必须立即置顶并亮时钟。时间戳在函数里取一次，
    // 否则 reducer 被跑两遍（缓存 + dispatch）会拿到两个不同的 Date.now()。
    applySessionAction({ type: "promote-session-row", sessionPath, updatedAt: Date.now() });
    applySessionAction({
      type: "set-bubbles",
      sessionPath,
      bubbles: replaceTurnWithProvisional(bubbles, {
        turn,
        clientMessageId: options.clientMessageId,
        content: options.content,
        attachments: options.attachments,
        contentParts: options.contentParts,
      }),
    });
  }

  const submitTurn = useCallback(
    async (
      rawInput: string,
      attachmentInputs: PromptAttachmentInput[] = [],
      messageParts: PromptMessagePartInput[] = [],
    ): Promise<boolean> => {
      const displayInput = rawInput;
      const attachments = attachmentInputs.map(toChatAttachment);
      const contentParts = normalizeMessageParts(messageParts, displayInput, attachments);
      // 只挂了技能徽标也算一次提交；input 必须是服务端会算出的同一句话。
      const capabilityPart = hasCapabilityPart(contentParts);
      const input = promptFallback(displayInput, attachments, contentParts);
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      if (
        (!displayInput.trim() && !attachments.length && !capabilityPart) ||
        !sessionPath ||
        state.isBootstrapping ||
        state.isStopping
      ) {
        return false;
      }
      ensureSessionCache(sessionPath);
      const streamState = getSessionStreamState(sessionPath);
      const requestGeneration = streamState.lifecycleGeneration;
      let promptBootstrap = state.bootstrap ?? bootstrap;
      let serverIsStreaming = state.isStreaming && !state.isStopping;
      if (serverIsStreaming || !promptBootstrap.canPrompt) {
        try {
          if (streamState.controller) {
            // We own this run, so the transcript is already in our hands - only the
            // flags need confirming against the server. This call used to pull the
            // whole conversation (measured 609 KB, seen 1.8 MB) and synchronously
            // parse + normalise + merge it at the exact moment the user is waiting for
            // the first token.
            const ambient = await fetchAmbientBootstrap();
            if (streamState.lifecycleGeneration !== requestGeneration) {
              return false;
            }

            if (ambient.activeSessionPath === sessionPath) {
              acceptAmbientBootstrap(ambient, sessionPath);
              promptBootstrap = { ...promptBootstrap, canPrompt: ambient.canPrompt };
              serverIsStreaming = Boolean(ambient.streamingSessionPaths?.includes(sessionPath));
            }
          } else {
            // Somebody else is streaming: their tokens never reach us, so the only way
            // to see that run is the transcript itself.
            const refreshed = await fetchBootstrap({ force: true });
            if (streamState.lifecycleGeneration !== requestGeneration) {
              return false;
            }
            const refreshedSessionPath = refreshed.activeSessionPath ?? refreshed.snapshot.conversation.sessionFile;
            if (refreshedSessionPath === sessionPath) {
              promptBootstrap = refreshed;
              serverIsStreaming = Boolean(refreshed.streamingSessionPaths?.includes(sessionPath));
              if (activeSessionPathRef.current === sessionPath) {
                replaceBootstrap(refreshed, sessionPath);
              }
            }
          }
        } catch (error) {
          reportDiagnostic("client.prompt_bootstrap.error", {
            sessionPath,
            ...clientErrorDetails(error),
          });
          // Fall back to the last known local state; the prompt request will report a real error.
        }
      }
      if (streamState.lifecycleGeneration !== requestGeneration) {
        return false;
      }
      const clientMessageId = createId("turn");
      const queueSteering = serverIsStreaming && !state.isStopping;
      if (!queueSteering && !promptBootstrap.canPrompt) {
        return false;
      }
      const promptBody = {
        input,
        displayInput,
        attachments: attachmentInputs,
        messageParts: contentParts,
        sessionPath,
        clientMessageId,
      };

      dispatch({ type: "set-draft", draft: "" });

      // The submission goes on screen as a provisional bubble. Its final
      // identity - and therefore its position - comes from the server event that
      // claims it, never from where the list happened to end.
      placeOptimisticTurn(sessionPath, {
        clientMessageId,
        content: displayInput,
        attachments,
        contentParts,
        withAssistant: !queueSteering,
        queued: queueSteering,
      });
      dispatch({ type: "set-error", error: null });

      const outcome = { accepted: false, streamError: null as string | null };

      /**
       * The single event handler for both submission modes. A steer request only
       * acknowledges the queue insert and ends early (`lifecycle: "queued"`);
       * everything else about it is the same stream as any other prompt, because
       * the events name their own bubble.
       */
      /**
       * 一帧落到 app 状态上的全部工作。**坏掉的 feed 走不到这里**：入口
       * `handlePromptEvent` 先让 `promptFeed` 决定「续订还是追平」。
       */
      const applyPromptEvent = (event: PromptStreamEvent, generation: number) => {
        lastStreamEventAtRef.current = Date.now();
        perfCount("event.stream", { events: 1 });
        handleExtensionUiStreamEvent(event);
        if (ACCEPTED_EVENT_TYPES.has(event.type)) {
          outcome.accepted = true;
        }

        applyStreamEvent(sessionPath, streamState, event);

        const isVisible = activeSessionPathRef.current === sessionPath;
        if (event.type === "context_usage") {
          // pi's own granularity: the numbers can only move when a message settles,
          // so the ring follows the transcript instead of waiting for the snapshot.
          applySessionAction({
            type: "set-context-usage",
            sessionPath,
            usage: {
              contextTokens: event.contextTokens,
              contextWindow: event.contextWindow,
              contextPercent: event.contextPercent,
              tokenUsage: event.tokenUsage,
            },
          });
        }
        if (event.type === "notice" && isVisible) {
          dispatch({ type: "set-error", error: event.message ?? null });
        }
        if (isVisible && event.type === "compaction_start") {
          dispatch({ type: "set-compacting", value: true });
        }
        if (isVisible && event.type === "compaction_end") {
          dispatch({ type: "set-compacting", value: false });
        }
        if (event.type === "compaction_end") {
          // Recorded even for a background session: the strip must still be there
          // when the user switches back.
          const outcome = compactionOutcome(event);
          if (outcome === "failed" && event.errorMessage) {
            dispatch({ type: "set-compaction-error", sessionPath, message: event.errorMessage });
          } else if (outcome === "succeeded") {
            dispatch({ type: "set-compaction-error", sessionPath, message: null });
          }
        }

        if (event.type === "error") {
          outcome.streamError = event.message ?? "Unknown streaming error";
          if (queueSteering && !outcome.accepted) {
            // pi refused the insert (compaction in flight, extension command, ...):
            // pull the bubble back so no ghost of an unsent message stays behind.
            rollbackOptimisticTurn(sessionPath, clientMessageId);
          }
          finishLocalStreamingTurn(sessionPath, streamState);
          if (!queueSteering) {
            // 插话被服务端拒绝不是「任务失败」，别用系统横幅打扰用户。
            notifyTurnSettled(sessionPath, outcome.streamError);
          }
          if (isVisible) {
            dispatch({ type: "set-error", error: outcome.streamError });
            dispatch({ type: "set-streaming", value: false });
            dispatch({ type: "set-compacting", value: false });
          }
        }

        if (event.type === "snapshot") {
          if (event.snapshot) {
            // Always safe to reconcile now: mergeChatBubbles keeps the bubbles this
            // client is still waiting for, so pending 插话 no longer need a gate.
            replaceBootstrap(event.snapshot, sessionPath);
          } else if (event.snapshotOmitted) {
            // 整份快照超限被明确省略：**不要**拿它去 reconcile（那不是"空对话"）。
            // 流里的增量已经把这轮写进气泡了，`done` 之后的 bootstrap 才是追平点。
            perfCount("stream.snapshotOmitted");
          }
        }

        if (event.type === "done") {
          if (event.lifecycle === "queued") {
            // Queue acknowledgement only - the run this 插话 joins is still going.
            if (isVisible) {
              dispatch({ type: "set-draft", draft: "" });
            }
            return;
          }
          finishLocalStreamingTurn(sessionPath, streamState);
          notifyTurnSettled(sessionPath, outcome.streamError);
          if (isVisible) {
            dispatch({ type: "set-streaming", value: false });
            dispatch({ type: "set-draft", draft: "" });
            void fetchBootstrap()
              .then((latest) => {
                if (!latest) {
                  return;
                }
                if (activeSessionPathRef.current === sessionPath && streamState.lifecycleGeneration === generation) {
                  replaceBootstrap(latest, sessionPath);
                  if (outcome.streamError) {
                    dispatch({ type: "set-error", error: outcome.streamError });
                  }
                }
              })
              .catch((error) => {
                reportDiagnostic("client.prompt_completion_bootstrap.error", {
                  sessionPath,
                  ...clientErrorDetails(error),
                });
                // The completed stream already contains the visible result.
              });
          }
        }
      };

      /**
       * 所有帧的入口：失效的帧直接丢掉，坏掉的 feed 交给 `promptFeed` 续订。传输故障不能
       * 当成「这一轮失败」——桥上的 run 可能还在跑，落定它会让停止按钮消失、还谎报完成。
       */
      const handlePromptEvent = (
        event: PromptStreamEvent,
        generation: number,
        controller: AbortController | null,
        feed: PromptFeed,
      ) => {
        if (streamState.lifecycleGeneration !== generation) {
          return;
        }
        if (controller && streamState.controller !== controller) {
          return;
        }
        feed.accept(event);
      };

      if (queueSteering) {
        // 插话没人能中止（控制权在启动这一轮的那个请求），所以没有 owner signal。
        const steerFeed = openPromptFeed({
          sessionPath,
          streamState,
          isCurrent: () => streamState.lifecycleGeneration === requestGeneration,
          ownerSignal: () => null,
          apply: (event) => applyPromptEvent(event, requestGeneration),
          ownsTurn: false,
        });
        try {
          await streamNdjson(
            "/api/prompt",
            { ...promptBody, streamingBehavior: "steer" },
            (event) => handlePromptEvent(event, requestGeneration, null, steerFeed),
          );
          return true;
        } catch (error) {
          reportDiagnostic("client.prompt_steering.error", {
            sessionPath,
            clientMessageId,
            requestAccepted: outcome.accepted,
            ...clientErrorDetails(error),
          });
          if (!outcome.accepted) {
            rollbackOptimisticTurn(sessionPath, clientMessageId);
          }
          if (
            streamState.lifecycleGeneration === requestGeneration &&
            activeSessionPathRef.current === sessionPath
          ) {
            dispatch({
              type: "set-error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return outcome.accepted;
        }
      }

      const controller = new AbortController();
      streamState.lifecycleGeneration += 1;
      const activeGeneration = streamState.lifecycleGeneration;
      streamState.controller = controller;
      streamState.streamLost = false;
      const feed = openPromptFeed({
        sessionPath,
        streamState,
        isCurrent: () =>
          streamState.lifecycleGeneration === activeGeneration && streamState.controller === controller,
        ownerSignal: () => controller.signal,
        apply: (event) => applyPromptEvent(event, activeGeneration),
      });
      dispatch({ type: "set-streaming", value: true });

      try {
        await streamNdjson(
          "/api/prompt",
          promptBody,
          (event) => handlePromptEvent(event, activeGeneration, controller, feed),
          { signal: controller.signal },
        );
      } catch (error) {
        const isCurrentStream =
          streamState.controller === controller && streamState.lifecycleGeneration === activeGeneration;
        if (isAbortError(error)) {
          reportDiagnostic("client.prompt_stream.aborted", {
            sessionPath,
            isCurrentStream,
            requestAccepted: outcome.accepted,
            lifecycleGeneration: streamState.lifecycleGeneration,
            activeGeneration,
            ...clientErrorDetails(error),
          });
          if (!isCurrentStream) {
            return outcome.accepted;
          }
          finishLocalStreamingTurn(sessionPath, streamState);
          if (activeSessionPathRef.current === sessionPath) {
            dispatch({ type: "set-streaming", value: false });
            dispatch({ type: "set-compacting", value: false });
            dispatch({ type: "set-stopping", value: true });
          }
          const stopped = await refreshSessionUntilIdle(sessionPath, activeGeneration);
          if (stopped && activeSessionPathRef.current === sessionPath && streamState.lifecycleGeneration === activeGeneration) {
            dispatch({ type: "set-stopping", value: false });
          }
          return outcome.accepted;
        }

        if (!isCurrentStream) {
          reportDiagnostic("client.prompt_stream.stale_error", {
            sessionPath,
            requestAccepted: outcome.accepted,
            lifecycleGeneration: streamState.lifecycleGeneration,
            activeGeneration,
            ...clientErrorDetails(error),
          });
          return outcome.accepted;
        }
        const message = error instanceof Error ? error.message : String(error);
        reportDiagnostic("client.prompt_stream.error", {
          sessionPath,
          requestAccepted: outcome.accepted,
          lifecycleGeneration: streamState.lifecycleGeneration,
          activeGeneration,
          ...clientErrorDetails(error),
        });
        if (!outcome.accepted) {
          rollbackOptimisticTurn(sessionPath, clientMessageId);
        }
        finishLocalStreamingTurn(sessionPath, streamState);
        // 服务端抛异常时只会写 `error`、不会写 `done`，所以这条也要提醒（去重在函数里）。
        notifyTurnSettled(sessionPath, message);
        if (activeSessionPathRef.current === sessionPath) {
          dispatch({ type: "set-error", error: message });
          dispatch({ type: "set-streaming", value: false });
          dispatch({ type: "set-compacting", value: false });
          dispatch({ type: "set-stopping", value: true });
        }
        const stopped = await refreshSessionUntilIdle(sessionPath, activeGeneration);
        if (stopped && activeSessionPathRef.current === sessionPath && streamState.lifecycleGeneration === activeGeneration) {
          dispatch({ type: "set-stopping", value: false });
        }
        return outcome.accepted;
      } finally {
        if (streamState.controller === controller) {
          streamState.controller = null;
        }
      }
      return true;
    },
    [bootstrap.activeSessionPath, conversation.sessionFile, handleExtensionUiStreamEvent, state.bootstrap?.canPrompt, state.isBootstrapping, state.isStopping, state.isStreaming],
  );

  /**
   * 编辑用户消息并重发。
   *
   * 服务端先把 pi 的分支 leaf 退回该轮之前（`navigateTree`，append-only，旧条目还在
   * 会话文件里），再用新内容正常 prompt；所以被放弃那轮的 token/费用仍然累计在
   * `getSessionStats()` 里，用量面板只增不减。
   *
   * 这里不做乐观占位：服务端会把回退后的权威快照作为流的第一帧事件推过来，先纠正
   * transcript（以及后续事件要寻址的 turn ordinal），新的回答才开始写。
   */
  const submitEdit = useCallback(
    async (
      targetMessageId: string,
      rawInput: string,
      attachmentInputs: PromptAttachmentInput[] = [],
      messageParts: PromptMessagePartInput[] = [],
    ): Promise<boolean> => {
      const displayInput = rawInput;
      const attachments = attachmentInputs.map(toChatAttachment);
      const contentParts = normalizeMessageParts(messageParts, displayInput, attachments);
      const capabilityPart = hasCapabilityPart(contentParts);
      const input = promptFallback(displayInput, attachments, contentParts);
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      if (
        (!displayInput.trim() && !attachments.length && !capabilityPart) ||
        !sessionPath ||
        state.isBootstrapping ||
        state.isStopping ||
        state.isStreaming ||
        !bootstrap.canPrompt
      ) {
        return false;
      }

      const streamState = getSessionStreamState(sessionPath);
      const controller = new AbortController();
      streamState.lifecycleGeneration += 1;
      const activeGeneration = streamState.lifecycleGeneration;
      streamState.controller = controller;
      streamState.streamLost = false;
      dispatch({ type: "set-error", error: null });
      dispatch({ type: "set-streaming", value: true });

      const outcome = { accepted: false, streamError: null as string | null };
      const clientMessageId = createId("turn");
      // Same feel as a composer submit: the edited turn is replaced on screen now,
      // long before the first byte of the new answer comes back.
      placeOptimisticEditTurn(sessionPath, {
        clientMessageId,
        targetMessageId,
        content: displayInput,
        attachments,
        contentParts,
      });

      /** 一帧落到 app 状态上的工作（同 `applyPromptEvent`：坏 feed 进不来）。 */
      const applyEditEvent = (event: PromptStreamEvent) => {
        lastStreamEventAtRef.current = Date.now();
        handleExtensionUiStreamEvent(event);
        if (ACCEPTED_EVENT_TYPES.has(event.type)) {
          outcome.accepted = true;
        }

        applyStreamEvent(sessionPath, streamState, event);

        const isVisible = activeSessionPathRef.current === sessionPath;
        if (event.type === "context_usage") {
          applySessionAction({
            type: "set-context-usage",
            sessionPath,
            usage: {
              contextTokens: event.contextTokens,
              contextWindow: event.contextWindow,
              contextPercent: event.contextPercent,
              tokenUsage: event.tokenUsage,
            },
          });
        }
        if (event.type === "snapshot" && event.snapshot) {
          replaceBootstrap(event.snapshot, sessionPath);
        }
        if (event.type === "error") {
          outcome.streamError = event.message ?? "Unknown streaming error";
        }
        if (event.type === "done") {
          if (event.lifecycle === "queued") {
            return;
          }
          finishLocalStreamingTurn(sessionPath, streamState);
          notifyTurnSettled(sessionPath, outcome.streamError);
          if (isVisible) {
            dispatch({ type: "set-streaming", value: false });
          }
          void fetchBootstrap()
            .then((latest) => {
              if (!latest) {
                return;
              }
              if (activeSessionPathRef.current === sessionPath && streamState.lifecycleGeneration === activeGeneration) {
                replaceBootstrap(latest, sessionPath);
                if (outcome.streamError) {
                  dispatch({ type: "set-error", error: outcome.streamError });
                }
              }
            })
            .catch(() => undefined);
        }
      };

      const editFeed = openPromptFeed({
        sessionPath,
        streamState,
        isCurrent: () =>
          streamState.lifecycleGeneration === activeGeneration && streamState.controller === controller,
        ownerSignal: () => controller.signal,
        apply: applyEditEvent,
      });
      const handleEditEvent = (event: PromptStreamEvent) => {
        if (streamState.lifecycleGeneration !== activeGeneration || streamState.controller !== controller) {
          return;
        }
        editFeed.accept(event);
      };

      try {
        await streamNdjson(
          "/api/messages/edit",
          {
            input,
            displayInput,
            attachments: attachmentInputs,
            messageParts: contentParts,
            sessionPath,
            targetMessageId,
            clientMessageId,
          },
          handleEditEvent,
          { signal: controller.signal },
        );
        return true;
      } catch (error) {
        const isCurrentStream =
          streamState.controller === controller && streamState.lifecycleGeneration === activeGeneration;
        if (!isCurrentStream) {
          return outcome.accepted;
        }
        finishLocalStreamingTurn(sessionPath, streamState);
        if (!outcome.accepted) {
          // Nothing claimed the optimistic turn, so it must not linger next to the
          // transcript the server is about to hand us.
          rollbackOptimisticTurn(sessionPath, clientMessageId);
        }
        if (isAbortError(error)) {
          reportDiagnostic("client.edit_stream.aborted", {
            sessionPath,
            requestAccepted: outcome.accepted,
            ...clientErrorDetails(error),
          });
          if (activeSessionPathRef.current === sessionPath) {
            dispatch({ type: "set-streaming", value: false });
            dispatch({ type: "set-stopping", value: true });
          }
          const stopped = await refreshSessionUntilIdle(sessionPath, activeGeneration);
          if (stopped && activeSessionPathRef.current === sessionPath && streamState.lifecycleGeneration === activeGeneration) {
            dispatch({ type: "set-stopping", value: false });
          }
          return outcome.accepted;
        }

        const message = error instanceof Error ? error.message : String(error);
        reportDiagnostic("client.edit_stream.error", {
          sessionPath,
          requestAccepted: outcome.accepted,
          ...clientErrorDetails(error),
        });
        notifyTurnSettled(sessionPath, message);
        if (activeSessionPathRef.current === sessionPath) {
          dispatch({ type: "set-error", error: message });
          dispatch({ type: "set-streaming", value: false });
        }
        // 失败时分支可能已经退回了：以服务端为准刷新 transcript。
        void fetchBootstrap()
          .then((latest) => {
            if (latest && activeSessionPathRef.current === sessionPath) {
              replaceBootstrap(latest, sessionPath);
            }
          })
          .catch(() => undefined);
        return outcome.accepted;
      } finally {
        if (streamState.controller === controller) {
          streamState.controller = null;
        }
      }
    },
    [bootstrap.activeSessionPath, bootstrap.canPrompt, conversation.sessionFile, handleExtensionUiStreamEvent, state.isBootstrapping, state.isStopping, state.isStreaming],
  );

  // onClearedQueue：/api/stop 响应一到就回调（不等 idle 轮询），把服务端 clearQueue()
  // 取出的未消费 steering / follow-up 原文交还给调用方，用于按 pi TUI 行为退回编辑器。
  // 带内联徽标的消息，pi 队列里的原文夹着附件路径/元数据块，所以一并把本地排队气泡的
  // parts 交出去 —— 编辑器才能按原样还原徽标，而不是把元数据块当文本贴回去。
  // （不用 useCallback：回调参数无法进 deps 数组作用域，且 stopTurn 无 effect/memo 依赖）
  async function stopTurn(onClearedQueue?: (cleared: ClearedComposerQueue) => void) {
    if (state.isStopping || (!state.isStreaming && !state.isCompacting)) {
      return;
    }
    const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
    if (!sessionPath) {
      return;
    }
    const streamState = getSessionStreamState(sessionPath);
    // 停止前先抓本地排队气泡：/api/stop 的响应会把它们从 UI 上清掉，之后再取就晚了。
    const queuedEntries = queuedComposerEntriesFromBubbles(currentBubbles(sessionPath) ?? []);
    streamState.lifecycleGeneration += 1;
    const stopRequestId = ++stopRequestIdRef.current;
    reportDiagnostic("client.stop.start", {
      sessionPath,
      stopRequestId,
      lifecycleGeneration: streamState.lifecycleGeneration,
      wasStreaming: state.isStreaming,
      wasCompacting: state.isCompacting,
    });

    if (activeSessionPathRef.current === sessionPath) {
      dispatch({ type: "set-stopping", value: true });
    }

    streamState.controller?.abort();
    streamState.controller = null;
    finishLocalStreamingTurn(sessionPath, streamState);
    dispatch({ type: "set-streaming", value: false });
    dispatch({ type: "set-compacting", value: false });

    let stopConfirmed = false;
    try {
      const next = await postJson<{
        snapshot: BootstrapResponse;
        clearedQueue?: { steering?: string[]; followUp?: string[] };
      }>("/api/stop", {
        sessionPath,
        clearQueues: true,
      });
      onClearedQueue?.({
        steering: next.clearedQueue?.steering ?? [],
        followUp: next.clearedQueue?.followUp ?? [],
        entries: queuedEntries,
      });
      if (activeSessionPathRef.current === sessionPath) {
        replaceBootstrap(next.snapshot, sessionPath);
      }
      const stopped = await refreshSessionUntilIdle(sessionPath, streamState.lifecycleGeneration);
      stopConfirmed = stopped;
      reportDiagnostic("client.stop.success", { sessionPath, stopRequestId, stopConfirmed });
      if (stopped && stopRequestId === stopRequestIdRef.current && activeSessionPathRef.current === sessionPath) {
        dispatch({ type: "set-stopping", value: false });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportDiagnostic("client.stop.error", {
        sessionPath,
        stopRequestId,
        ...clientErrorDetails(error),
      });
      if (activeSessionPathRef.current === sessionPath) {
        dispatch({ type: "set-error", error: message });
      }
      stopConfirmed = await refreshSessionUntilIdle(sessionPath, streamState.lifecycleGeneration);
    } finally {
      reportDiagnostic("client.stop.finally", { sessionPath, stopRequestId, stopConfirmed });
      if (stopConfirmed && stopRequestId === stopRequestIdRef.current && activeSessionPathRef.current === sessionPath) {
        dispatch({ type: "set-stopping", value: false });
      }
    }
  }

  // 服务端 isSessionBusy() 的客户端同口径快照：三个「会打到 pi 运行态」的桥调用共用。
  const sessionBusyNow = useCallback(() => isSessionBusy({
    isStreaming: state.isStreaming,
    isCompacting: state.isCompacting,
    isStopping: state.isStopping,
    pendingQueues: bootstrap.pendingQueues,
  }), [bootstrap.pendingQueues, state.isCompacting, state.isStreaming, state.isStopping]);

  /**
   * 输入框旁切换模型。
   *
   * 作用范围是「这条会话 + 以后新建的任务」：桥里的 `session.setModel()` 会把这次选择写进
   * pi 的全局默认模型，所以“记住”不需要客户端另存一份；反过来，已经开着的其他会话各自用手
   * 里那条（会话文件里存着自己的 `model_change`，重开时 pi 会按它恢复）。
   */
  const selectComposerModel = useCallback(
    async (provider: string, model: string) => {
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      if (!sessionPath) {
        return;
      }
      // 与服务端 `setModelConfiguration` 的 isSessionBusy() 对齐：点了停止仍在 abort、
      // pi 队列里还压着插话/跟进时，服务端会拒绝换模型。
      if (sessionBusyNow()) {
        return;
      }

      try {
        const next = await postJson<BootstrapResponse>("/api/model", {
          provider,
          model,
          thinkingLevel: state.selectedThinkingLevel,
          sessionPath,
        });
        if (activeSessionPathRef.current === sessionPath) {
          replaceBootstrap(next, sessionPath);
        }
      } catch (error) {
        dispatch({ type: "set-error", error: error instanceof Error ? error.message : String(error) });
      }
    },
    [bootstrap.activeSessionPath, conversation.sessionFile, sessionBusyNow, state.selectedThinkingLevel],
  );

  /** 自定义模型改了之后重新拉一次可用模型列表（bootstrap 里带着 `availableModels`）。 */
  const refreshAvailableModels = useCallback(async () => {
    const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
    try {
      const next = await fetchBootstrap({ force: true });
      if (next && activeSessionPathRef.current === sessionPath) {
        replaceBootstrap(next, sessionPath);
      }
    } catch {
      // 下一次轮询会补上，不在这里抢一份错误提示。
    }
  }, [bootstrap.activeSessionPath, conversation.sessionFile]);

  const savePersonalization = useCallback(async (settings: PersonalizationSettings) => {
    try {
      const next = await postJson<BootstrapResponse>("/api/personalization", settings);
      replaceBootstrap(next, activeSessionPathRef.current ?? undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "set-error", error: message });
    }
  }, []);

  const updateSessionThinkingLevel = useCallback(
    async (thinkingLevel: ThinkingLevel) => {
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      // 与服务端 `setSessionThinkingLevel` 的 isSessionBusy() 对齐。控件本身已经按同一
      // 口径禁用；这里是防「禁用态落地前点进来」的竞态。
      if (sessionBusyNow()) {
        return;
      }
      dispatch({ type: "set-thinking-level", thinkingLevel });
      // 新会话的思考等级由服务端在同一个请求里写进全局设置，客户端不再另存一份。
      if (!sessionPath) {
        return;
      }

      try {
        const next = await postJson<BootstrapResponse>("/api/thinking-level", {
          thinkingLevel,
          sessionPath,
        });
        if (activeSessionPathRef.current === sessionPath) {
          replaceBootstrap(next, sessionPath);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: "set-error", error: message });
      }
    },
    [bootstrap.activeSessionPath, conversation.sessionFile, sessionBusyNow],
  );

  const compactContext = useCallback(
    async (instructions?: string) => {
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      // Compaction rewrites the transcript the running prompt is still appending
      // to, so a streaming turn must finish first. The button mirrors this and
      // the bridge rejects it too; this guard covers queued clicks and races.
      if (state.isCompacting || state.isStreaming || !sessionPath) {
        return;
      }

      dispatch({ type: "set-compacting", value: true });
      try {
        const next = await postJson<{ snapshot: BootstrapResponse }>("/api/compact", {
          instructions,
          sessionPath,
        });
        if (activeSessionPathRef.current === sessionPath) {
          replaceBootstrap(next.snapshot, sessionPath);
        }
        dispatch({ type: "set-compaction-error", sessionPath, message: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The strip above the composer owns compaction news, including this:
        // the generic banner up top would be dismissed by any unrelated fix.
        dispatch({ type: "set-compaction-error", sessionPath, message });
      } finally {
        dispatch({ type: "set-compacting", value: false });
      }
    },
    [bootstrap.activeSessionPath, conversation.sessionFile, state.isCompacting, state.isStreaming],
  );

  const createProject = useCallback(
    async (name: string, cwd: string): Promise<CreateProjectResult> => {
      const normalizedCwd = cwd.trim();
      if (!normalizedCwd) {
        const message = "Project folder is required.";
        dispatch({ type: "set-error", error: message });
        return { ok: false, error: message };
      }

      dispatch({ type: "bootstrap-start" });
      try {
        const next = await postJson<BootstrapResponse>("/api/projects", {
          name: name.trim() || undefined,
          cwd: normalizedCwd,
        });
        activeSessionPathRef.current = next.activeSessionPath;
        replaceBootstrap(next);
        dispatch({ type: "set-draft", draft: "" });
        return { ok: true, existingProject: next.existingProject };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: "bootstrap-error", error: message });
        return { ok: false, error: message };
      }
    },
    // `replaceBootstrap` only reads refs + dispatch, so the callback stays stable
    // (the sidebar hands it straight to a memo-less dialog prop).
    [],
  );

  const updateProject = useCallback(async (projectId: string, name: string, cwd: string) => {
    if (!projectId) {
      return;
    }

    dispatch({ type: "bootstrap-start" });
    try {
      const next = await postJson<BootstrapResponse>("/api/projects/update", {
        projectId,
        name: name.trim() || undefined,
        cwd: cwd.trim() || undefined,
      });
      activeSessionPathRef.current = next.activeSessionPath;
      replaceBootstrap(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "bootstrap-error", error: message });
    }
  }, []);

  const pinProject = useCallback(async (projectId: string, pinned: boolean) => {
    if (!projectId) {
      return;
    }

    try {
      const next = await postJson<BootstrapResponse>("/api/projects/pin", { projectId, pinned });
      replaceBootstrap(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "set-error", error: message });
    }
  }, []);

  const reorderProjects = useCallback(async (projectIds: string[]) => {
    if (!projectIds.length) {
      return;
    }

    try {
      const next = await postJson<BootstrapResponse>("/api/projects/reorder", { projectIds });
      replaceBootstrap(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "set-error", error: message });
    }
  }, []);

  const removeProject = useCallback(async (projectId: string) => {
    if (!projectId) {
      return;
    }

    dispatch({ type: "bootstrap-start" });
    try {
      const next = await postJson<BootstrapResponse>("/api/projects/remove", { projectId });
      activeSessionPathRef.current = next.activeSessionPath;
      replaceBootstrap(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "bootstrap-error", error: message });
    }
  }, []);

  const revealProject = useCallback(async (projectId: string) => {
    if (!projectId) {
      return;
    }

    try {
      const next = await postJson<BootstrapResponse>("/api/projects/reveal", { projectId });
      replaceBootstrap(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "set-error", error: message });
    }
  }, []);

  const selectProject = useCallback(
    async (projectId: string) => {
      if (!projectId || projectId === bootstrap.activeProjectId) {
        return;
      }

      dispatch({ type: "bootstrap-start" });
      try {
        const next = await postJson<BootstrapResponse>("/api/projects/select", { projectId });
        activeSessionPathRef.current = next.activeSessionPath;
        if (next.activeSessionPath) {
          getSessionStreamState(next.activeSessionPath).activeBubbleId = streamingBubbleId(
            next.snapshot.conversation.messages,
          );
        }
        replaceBootstrap(next);
        dispatch({ type: "set-draft", draft: "" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: "bootstrap-error", error: message });
      }
    },
    [bootstrap.activeProjectId],
  );

  const trustProject = useCallback(
    async (projectId = bootstrap.activeProjectId) => {
      if (!projectId) {
        return;
      }

      dispatch({ type: "bootstrap-start" });
      try {
        const next = await postJson<BootstrapResponse>("/api/projects/trust", { projectId });
        activeSessionPathRef.current = next.activeSessionPath;
        replaceBootstrap(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: "bootstrap-error", error: message });
      }
    },
    [bootstrap.activeProjectId],
  );

  const createSession = useCallback(
    async (projectId = bootstrap.activeProjectId, name?: string, options?: { worktree?: boolean }): Promise<string | undefined> => {
      if (!projectId) {
        return;
      }

      dispatch({ type: "bootstrap-start" });
      try {
        const next = await postJson<BootstrapResponse>("/api/sessions", {
          projectId,
          name: name?.trim() || undefined,
          // 会话级选择：这条会话建在托管 worktree 里（基于当前 HEAD 的 detached 检出）。
          worktree: options?.worktree ? { enabled: true } : undefined,
        });
        activeSessionPathRef.current = next.activeSessionPath;
        replaceBootstrap(next);
        return next.activeSessionPath;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: "bootstrap-error", error: message });
      }
    },
    [bootstrap.activeProjectId],
  );

  const updateSession = useCallback(async (projectId: string, sessionPath: string, name: string) => {
    if (!projectId || !sessionPath) {
      return;
    }

    try {
      const next = await postJson<BootstrapResponse>("/api/sessions/update", {
        projectId,
        sessionPath,
        name: name.trim(),
      });
      replaceBootstrap(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "set-error", error: message });
    }
  }, []);

  const pinSession = useCallback(async (projectId: string, sessionPath: string, pinned: boolean) => {
    if (!projectId || !sessionPath) {
      return;
    }

    try {
      const next = await postJson<BootstrapResponse>("/api/sessions/pin", { projectId, sessionPath, pinned });
      replaceBootstrap(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "set-error", error: message });
    }
  }, []);

  const deleteSession = useCallback(async (projectId: string, sessionPath: string) => {
    if (!projectId || !sessionPath) {
      return;
    }

    dispatch({ type: "bootstrap-start" });
    try {
      const next = await postJson<BootstrapResponse>("/api/sessions/delete", { projectId, sessionPath });
      activeSessionPathRef.current = next.activeSessionPath;
      replaceBootstrap(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "bootstrap-error", error: message });
    }
  }, []);

  /**
   * 归档会话的增删改共用一条通路：都是 POST 一个会话变更接口，然后用返回的完整快照
   * 覆盖状态（归档会顺手切走活动会话，所以 activeSessionPath 必须一起更新）。
   *
   * 与 `deleteSession` 只把失败写成全局错误条不同，这些操作主要发生在设置弹层里 ——
   * 全局错误条在模态背后看不见，所以失败要抛给调用方，让归档页就地显示。
   */
  const mutateSessionState = useCallback(async (path: string, body: Record<string, unknown>) => {
    dispatch({ type: "bootstrap-start" });
    try {
      const next = await postJson<BootstrapResponse>(path, body);
      activeSessionPathRef.current = next.activeSessionPath;
      replaceBootstrap(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "bootstrap-error", error: message });
      throw error;
    }
  }, []);

  const archiveSession = useCallback(
    (projectId: string, sessionPath: string) => {
      if (!projectId || !sessionPath) {
        return Promise.resolve();
      }
      return mutateSessionState("/api/sessions/archive", { projectId, sessionPath, archived: true });
    },
    [mutateSessionState],
  );

  const unarchiveSession = useCallback(
    (projectId: string, sessionPath: string) => {
      if (!projectId || !sessionPath) {
        return Promise.resolve();
      }
      return mutateSessionState("/api/sessions/archive", { projectId, sessionPath, archived: false });
    },
    [mutateSessionState],
  );

  const deleteArchivedSession = useCallback(
    (projectId: string, sessionPath: string) => mutateSessionState("/api/sessions/delete", { projectId, sessionPath }),
    [mutateSessionState],
  );

  const deleteAllArchivedSessions = useCallback(
    (projectId?: string) => mutateSessionState("/api/sessions/delete-archived", projectId ? { projectId } : {}),
    [mutateSessionState],
  );

  const selectSession = useCallback(
    async (projectId: string, sessionPath: string, traceIdFromSidebar?: string) => {
      if (!projectId || !sessionPath || sessionPath === bootstrap.activeSessionPath) {
        return;
      }

      const startedAt = performance.now();
      const traceId = traceIdFromSidebar ?? createId("session-switch");
      reportDiagnostic("client.session_switch.request_start", {
        traceId,
        projectId,
        sessionPath,
        elapsedMs: performance.now() - startedAt,
      });
      reportDiagnostic("client.session_switch.start", {
        traceId,
        projectId,
        sessionPath,
        startedAt,
      });
      dispatch({ type: "bootstrap-start" });
      try {
        const next = await postJson<BootstrapResponse>("/api/sessions/select", { projectId, sessionPath, traceId });
        reportDiagnostic("client.session_switch.response", {
          traceId,
          projectId,
          sessionPath,
          elapsedMs: performance.now() - startedAt,
          messageCount: next.snapshot?.conversation?.messages?.length ?? 0,
        });
        getSessionStreamState(sessionPath).activeBubbleId = streamingBubbleId(
          next.snapshot.conversation.messages,
        );
        activeSessionPathRef.current = next.activeSessionPath;
        replaceBootstrap(next);
        dispatch({ type: "set-draft", draft: "" });
        reportDiagnostic("client.session_switch.state_replaced", {
          traceId,
          projectId,
          sessionPath,
          elapsedMs: performance.now() - startedAt,
        });
      } catch (error) {
        reportDiagnostic("client.session_switch.error", {
          traceId,
          projectId,
          sessionPath,
          elapsedMs: performance.now() - startedAt,
          ...clientErrorDetails(error),
        });
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: "bootstrap-error", error: message });
      }
    },
    [bootstrap.activeSessionPath],
  );

  const updateCapability = useCallback(
    async (path: string, body: unknown) => {
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      const result = await postJson<Partial<BootstrapResponse> & { capabilities?: CapabilitiesState }>(
        path,
        { ...((body && typeof body === "object") ? body : {}), sessionPath },
      );
      // The server answers a capability switch with the capability slice (a package/extension
      // change may still answer with a whole bootstrap). Folding that slice back avoids
      // shipping, parsing and normalising the entire conversation for a switch that never
      // touched it - which used to be a second full `/api/bootstrap` on every toggle.
      if (result && typeof result === "object" && "snapshot" in result && result.snapshot) {
        // 服务端两种形状都出现过：整份 bootstrap 就在顶层（`/api/projects`），以及包一层
        // `{ snapshot: <整份 bootstrap> }`（`/api/compact`、skills/import、`/api/builtin-command`）。
        // 按 `snapshot` 里有没有 `conversation` 判定，绝不能把嵌套的那层当 AppSnapshot ——
        // 那会让 normalizeBootstrap 在 `snapshot.conversation.sessionFile` 上崩。
        const answered = result.snapshot as unknown as { conversation?: unknown };
        const bootstrap = (answered.conversation ? result : result.snapshot) as unknown as BootstrapResponse;
        if (activeSessionPathRef.current === sessionPath) {
          replaceBootstrap(bootstrap, sessionPath);
        }
        return result;
      }
      if (result?.capabilities) {
        dispatch({ type: "replace-capabilities", capabilities: result.capabilities });
        return result;
      }
      // Unknown response shape (e.g. an older server): keep the full reconcile as a fallback.
      const next = await fetchBootstrap({ force: true });
      if (activeSessionPathRef.current === sessionPath) {
        replaceBootstrap(next, sessionPath);
      }
      return next;
    },
    [bootstrap.activeSessionPath, conversation.sessionFile],
  );

  const setCapabilityDefault = useCallback(
    (kind: CapabilityKind, id: string, enabled: boolean) =>
      updateCapability("/api/capabilities/default", { kind, id, enabled }),
    [updateCapability],
  );

  const setCapabilityPinned = useCallback(
    (kind: CapabilityKind, id: string, pinned: boolean) =>
      updateCapability("/api/capabilities/pin", { kind, id, pinned }),
    [updateCapability],
  );

  const setSessionSkill = useCallback(
    (id: string, enabled: boolean) => {
      // 服务端 `setSessionSkillCapability` 忙时会拒；控件侧已按同一口径跳过
      // （composer 的 `sessionRuntimeLocked`），这里防「禁用态落地前点进来」的竞态。
      if (sessionBusyNow()) {
        return Promise.resolve(null);
      }
      return updateCapability("/api/capabilities/session/skill", { id, enabled });
    },
    [sessionBusyNow, updateCapability],
  );

  const setSessionPackage = useCallback(
    (id: string, enabled: boolean) =>
      updateCapability("/api/capabilities/session/package", { id, enabled }),
    [updateCapability],
  );

  const setSessionExtension = useCallback(
    (id: string, enabled: boolean) =>
      updateCapability("/api/capabilities/session/extension", { id, enabled }),
    [updateCapability],
  );

  /**
   * Install and update are NDJSON streams, not plain POSTs: pi reports its own progress through
   * `setProgressCallback` and the server forwards each event here, so the panel can show what npm
   * is doing instead of an opaque spinner. The final `snapshot` event carries the new state; the
   * server already reloaded the open runtimes before emitting it.
   */
  const streamCapabilityOperation = useCallback(
    async (path: string, body: Record<string, unknown>, onProgress?: CapabilityProgressReporter) => {
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      let latest: BootstrapResponse | undefined;
      let failure = "";

      await streamNdjson(path, { ...body, sessionPath }, (event) => {
        if (event.type === "package_progress") {
          onProgress?.(event.message ?? "");
          return;
        }

        if (event.type === "snapshot" && event.snapshot) {
          latest = event.snapshot;
          if (activeSessionPathRef.current === sessionPath) {
            replaceBootstrap(event.snapshot, sessionPath);
          }
          return;
        }

        if (event.type === "error" || event.type === "transport_error") {
          failure = event.message ?? "Package operation failed";
        }
      });

      if (failure) {
        throw new Error(failure);
      }
      return latest;
    },
    [bootstrap.activeSessionPath, conversation.sessionFile],
  );

  const installPackage = useCallback(
    (source: string, scope: "user" | "project" = "user", autoload = true, onProgress?: CapabilityProgressReporter) =>
      streamCapabilityOperation("/api/capabilities/package/install", { source, scope, autoload }, onProgress),
    [streamCapabilityOperation],
  );

  const removePackage = useCallback(
    (source: string, scope: "user" | "project" = "user") =>
      updateCapability("/api/capabilities/package/remove", { source, scope }),
    [updateCapability],
  );

  const updatePackage = useCallback(
    (source?: string, onProgress?: CapabilityProgressReporter) =>
      streamCapabilityOperation("/api/capabilities/package/update", source ? { source } : {}, onProgress),
    [streamCapabilityOperation],
  );

  const runPackageCommand = useCallback(
    async (packageId: string, command: string, args = "") => {
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      let latest: BootstrapResponse | undefined;
      let commandError = "";

      await streamNdjson("/api/capabilities/package/command", {
        packageId,
        command,
        args,
        sessionPath,
      }, (event) => {
        if (event.type === "extension_ui_request") {
          applyExtensionUiRequest(event as ExtensionUiRequest);
          return;
        }

        if (event.type === "snapshot" && event.snapshot) {
          latest = event.snapshot;
          if (activeSessionPathRef.current === sessionPath) {
            replaceBootstrap(event.snapshot, sessionPath);
          }
          return;
        }

        if (event.type === "error" || event.type === "transport_error") {
          commandError = event.message ?? `/${command} 执行失败`;
        }
      });

      if (commandError) {
        throw new Error(commandError);
      }
      return latest;
    },
    [bootstrap.activeSessionPath, conversation.sessionFile],
  );

  /**
   * 包命令的参数补全候选。命令没注册 getArgumentCompletions 时服务端返回空列表，
   * 这里原样透传（返回 [] 而不是抛错），composer 静默收菜单。
   */
  const loadPackageCommandArguments = useCallback(
    async (packageId: string, command: string, prefix: string): Promise<CapabilityCommandArgument[]> => {
      // 和 runPackageCommand 一样带上会话路径：候选必须来自会执行这条命令的那个
      // runtime，多会话打开时不能落到别的会话的包上。
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      const response = await postJson<{ items?: CapabilityCommandArgument[] }>(
        "/api/capabilities/package/command/arguments",
        { packageId, command, prefix, sessionPath },
      );
      return Array.isArray(response?.items) ? response.items : [];
    },
    [bootstrap.activeSessionPath, conversation.sessionFile],
  );

  /**
   * pi 内置命令（目前只有 `/reload`）。走和 capability 变更同一条 POST + 整包对账路径：
   * 服务端重载后回整份 snapshot，这里 replaceBootstrap，工具/提示词/能力列表一起刷新。
   */
  const runBuiltinCommand = useCallback(
    (command: string, args = "") => updateCapability("/api/builtin-command", { command, args }),
    [updateCapability],
  );

  const addExtension = useCallback(
    (path: string, scope: "user" | "project" = "user") =>
      updateCapability("/api/capabilities/extension/add", { path, scope }),
    [updateCapability],
  );

  const removeExtension = useCallback(
    (id: string) => updateCapability("/api/capabilities/extension/remove", { id }),
    [updateCapability],
  );

  const deleteSkill = useCallback(
    (id: string) => updateCapability("/api/capabilities/skills/delete", { id }),
    [updateCapability],
  );

  /**
   * MCP 服务器的新增/编辑走 `/api/capabilities/mcp/save`（写 pi 的 mcp.json），
   * 删除走 `mcp/remove`。两者都回整份 capabilities，和别的能力开关走同一条对账路径。
   */
  const saveMcpServer = useCallback(
    (server: Record<string, unknown>) => updateCapability("/api/capabilities/mcp/save", server),
    [updateCapability],
  );

  const removeMcpServer = useCallback(
    (id: string) => updateCapability("/api/capabilities/mcp/remove", { id }),
    [updateCapability],
  );

  /**
   * 「测试连接」：服务端会真的连一次服务器并列出工具，把错误原文带回来。
   * 返回形状不是 capabilities，所以不走 updateCapability（那会把整份 bootstrap 拉回来）。
   */
  const inspectMcpServer = useCallback(
    async (id: string): Promise<CapabilityMcpInspection> => {
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      const result = await postJson<{ inspection?: CapabilityMcpInspection }>(
        "/api/capabilities/mcp/inspect",
        { id, sessionPath },
      );
      if (!result?.inspection) {
        throw new Error("MCP inspection failed");
      }
      return result.inspection;
    },
    [bootstrap.activeSessionPath, conversation.sessionFile],
  );

  /** 编辑弹窗打开时才拉原始字段（env / headers 可能带密钥，不放进能力清单）。 */
  const readMcpServerDetail = useCallback(
    async (id: string): Promise<CapabilityMcpDetail> => {
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      const result = await postJson<{ detail?: CapabilityMcpDetail }>(
        "/api/capabilities/mcp/read",
        { id, sessionPath },
      );
      if (!result?.detail) {
        throw new Error("MCP server not found");
      }
      return result.detail;
    },
    [bootstrap.activeSessionPath, conversation.sessionFile],
  );

  /**
   * 导入 MCP 配置：`/api/capabilities/mcp/import` 只解析，返回表单字段 + extras。
   * 真正的落盘仍走 `saveMcpServer`，所以这里不进 updateCapability（没有能力清单要刷新）。
   */
  const parseMcpImport = useCallback(
    async (text: string, defaultName?: string): Promise<CapabilityMcpImportResult> => {
      const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
      const result = await postJson<{ import?: CapabilityMcpImportResult }>(
        "/api/capabilities/mcp/import",
        { text, defaultName, sessionPath },
      );
      if (!result?.import) {
        throw new Error("MCP import parse failed");
      }
      return result.import;
    },
    [bootstrap.activeSessionPath, conversation.sessionFile],
  );

  const importSkill = useCallback(
    (sourcePath: string, scope: "user" | "project" = "project") =>
      updateCapability("/api/capabilities/skills/import", { sourcePath, scope }),
    [updateCapability],
  );

  /**
   * 「工具开关」（codemode）：写的是 pi 自己的 `defaultTools` —— 全局 `settings.json`
   * 或项目 `.pi/settings.json`，和终端 TUI 同一个键，所以两边不会不一致。
   * 服务端写完回整份 bootstrap：开关变了，项目清单里每个项目的三态也变了。
   */
  const saveToolSettings = useCallback(
    (input: { scope: "user" | "project"; state: ToolToggleState; projectId?: string }) =>
      updateCapability("/api/tools/settings", input),
    [updateCapability],
  );

  const setDraft = useCallback((draft: string) => dispatch({ type: "set-draft", draft }), []);
  const dismissError = useCallback(() => dispatch({ type: "set-error", error: null }), []);
  /** 给会话头部这类非 reducer 内部的地方用的错误上报口（如 git 初始化失败）。 */
  const reportError = useCallback((message: string) => dispatch({ type: "set-error", error: message }), []);
  /** Only ever called on a strip the user can see, so the session tag needs no argument. */
  const dismissCompactionNotice = useCallback(() => dispatch({ type: "dismiss-compaction-error" }), []);

  return {
    state,
    bootstrap,
    conversation,
    stats,
    modelConfig,
    capabilities,
    availableModels,
    skills,
    projects,
    activeProject,
    submitTurn,
    submitEdit,
    stopTurn,
    selectComposerModel,
    refreshAvailableModels,
    savePersonalization,
    updateSessionThinkingLevel,
    compactContext,
    createProject,
    updateProject,
    pinProject,
    reorderProjects,
    removeProject,
    revealProject,
    selectProject,
    trustProject,
    createSession,
    updateSession,
    pinSession,
    deleteSession,
    archiveSession,
    unarchiveSession,
    deleteArchivedSession,
    deleteAllArchivedSessions,
    selectSession,
    setDraft,
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
    addExtension,
    removeExtension,
    deleteSkill,
    saveMcpServer,
    removeMcpServer,
    inspectMcpServer,
    readMcpServerDetail,
    parseMcpImport,
    importSkill,
    saveToolSettings,
    respondExtensionUi,
    dismissError,
    reportError,
    dismissCompactionNotice,
    replaceBootstrap,
    loadOlderMessages,
    loadingOlderMessages,
  };
}



function toChatAttachment(attachment: PromptAttachmentInput): ChatAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachmentKindFromMimeType(attachment.mimeType),
    previewUrl: attachment.previewUrl,
    sourcePath: attachment.sourcePath,
  };
}

function normalizeMessageParts(
  messageParts: PromptMessagePartInput[],
  displayInput: string,
  attachments: ChatAttachment[],
): PromptMessagePartInput[] {
  const attachmentIds = new Set(attachments.map((attachment) => attachment.id));
  const parts = messageParts.filter((part) => {
    if (part.kind === "text") {
      return Boolean(part.text);
    }
    if (part.kind === "attachment") {
      return attachmentIds.has(part.attachmentId);
    }
    if (part.kind === "capability") {
      return Boolean(part.capability?.id && part.capability.kind);
    }
    return false;
  });

  if (parts.length) {
    return parts;
  }

  return [
    ...(displayInput ? [{ kind: "text" as const, text: displayInput }] : []),
    ...attachments.map((attachment) => ({ kind: "attachment" as const, attachmentId: attachment.id })),
  ];
}
