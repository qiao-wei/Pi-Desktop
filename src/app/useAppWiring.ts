import type { useAppCore } from "./useAppCore";
import type { AppForwarded } from "./appForwarded";
import type {
  SyntheticEvent as ReactSyntheticEvent,
} from "react";
import {
  BUILTIN_COMMAND_DONE_DISMISS_MS,
  builtinCommandNoticeText,
  type BuiltinCommandPhase,
} from "../shared/builtinCommandNotice";
import {
  sidebarStreamingSessionPaths,
} from "../features/chat/sidebarStreaming";
import { isCustomExtensionUiRequest, isDialogExtensionUiRequest, isWebExtensionUiRequest, normalizePercent } from "./AppComposerHelpers";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { modelKey } from "../features/models/customModelForm";
import { chatScrollToBottomBus } from "../shared/chatScrollBus";
import { compactionNotice } from "../shared/compactionNotice";
import { saveUiPreferences } from "../lib/ui-preferences";
import { sessionControlsDisabled } from "../shared/sessionBusy";
import { stripTerminalSequences } from "../shared/terminalText.ts";
import { syncShellAppearance } from "../lib/shell-appearance";
import { useProjectCommands } from "../features/chat/useProjectCommands";
import { useProjectGit } from "../features/chat/useProjectGit";
import { useSessionWorktree } from "../features/chat/useSessionWorktree";

/**
 * 本段**之后**才声明的名字：只在延迟执行位置（回调/副作用里）用到 —— 类型直接 `Pick`
 * 后段返回类型（精确，不是 any）。它们每次 render 由 `deps` 重新赋值，
 * 所以 `deps.X` 读到的是当前 render 的值（比原来的闭包捕获更难过期）。
 */
type Later =
  Pick<AppForwarded, "syncComposerState">;


/**
 * 订阅与副作用：模型/项目/git/扩展 UI/滚动/焦点/通知
 *
 * `useAppModel()` 顺序切出的第 2 段（原 body 语句 70–105，407–781 行）。
 *   · 本段**之前**声明的名字：从共享 `deps` 解构（拿到的是真值本身，闭包身份不变）。
 *   · 本段**之后**才声明的名字：就地写成 `deps.X`（只在延迟执行位置出现；读的是当前 render 的值）。
 * 段内语句一字未改 —— 正确性靠这一点，也靠 `tests/appModelSplit.test.ts` 的顺序与字段校验。
 *
 * 由 `.scratch/split-hook-segments.mjs` 机械搬出。
 */
export function useAppWiring(deps: ReturnType<typeof useAppCore> & Later) {
  // 前面几段已经写进 deps 的值。
  const {
    appearance, attachmentPreviewUrlsRef, attachments, bootstrap, builtinNoticeTimerRef, composerAttachmentMapRef,
    composerCapabilityMapRef, composerEditorRef, composerSelectionRef, conversation, createSession, extensionStatusRef,
    leftSidebarCollapsed, leftSidebarWidth, loadPackageCommandArguments, modelConfig, pendingPreviewUrlsRef, projectCommandTerminal,
    replaceBootstrap, reportError, rightPanelCollapsed, rightPanelWidth, scrollStateRef, selectComposerModel,
    selectedComposerModel, selectedModel, selectedProvider, setAttachments, setBuiltinNotice, setComposerError,
    setDraft, setShowCapabilityPicker, setShowExtensionStatus, setShowUsagePopover, setSlashArgumentArmed, setSlashArgumentItems,
    setSlashHighlight, showExtensionStatus, showUsagePopover, slashCommandContext, state, stats,
    theme, usagePopoverRef,
  } = deps;

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
    deps.syncComposerState();
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

  return { activeCustomExtensionUiRequest, activeExtensionUiRequest, activeWebExtensionUiRequest, autoAppliedModelRef, autoResolveConflicts, canQueueFollowUp, canSubmitPrompt, clearBuiltinNotice, compactionNoticeView, composerSessionBusy, contextPercent, extensionAboveWidgets, extensionBelowWidgets, focusComposerQuietly, followLatestScroll, getScrollState, handleComposerModelChange, hasConfiguredModel, projectCommands, projectGit, restoreComposerFocusRing, sessionWorktree, showBuiltinNotice, streamingSessionPaths, visibleSessionPath };
}
