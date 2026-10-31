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
import { isCustomExtensionUiRequest, isDialogExtensionUiRequest, isWebExtensionUiRequest, normalizePercent, capabilityBadgeKey } from "./AppComposerHelpers";
import type { ComposerPart } from "./AppComposerHelpers";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
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
import { useWorkspaceFiles } from "../features/workspace/useWorkspaceFiles";
import { useWorkspacePanelTabs } from "../features/workspace/useWorkspacePanelTabs";
import { markThreadSwitch } from "../components/assistant-ui/elements/thread.aui";
import type { WorkspaceDiffSource } from "../shared/workspaceDiff";

/**
 * 本段**之后**才声明的名字：只在延迟执行位置（回调/副作用里）用到 —— 类型直接 `Pick`
 * 后段返回类型（精确，不是 any）。它们每次 render 由 `deps` 重新赋值，
 * 所以 `deps.X` 读到的是当前 render 的值（比原来的闭包捕获更难过期）。
 */
type Later =
  Pick<AppForwarded, "createAttachmentBadgeNode" | "createCapabilityBadgeNode" | "hideAttachmentHover" | "readComposerParts" | "syncComposerState">;


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
    composerCapabilityMapRef, composerDraftsRef, composerEditorRef, composerSelectionRef, conversation, createSession, extensionStatusRef,
    initialRightPanelTab,
    leftSidebarCollapsed, leftSidebarWidth, loadPackageCommandArguments, modelConfig, pendingPreviewUrlsRef, projectCommandTerminal, projects,
    replaceBootstrap, reportError, rightPanelCollapsed, rightPanelWidth, scrollStateRef, selectComposerModel, selectSession,
    selectedComposerModel, selectedModel, selectedProvider, setActiveMainView, setAttachments, setBuiltinNotice, setCapabilitiesDialogProjectId, setComposerError,
    setRightPanelCollapsed, setShowCapabilityPicker, setShowExtensionStatus, setShowPanel, setShowUsagePopover, setSidebarFileTreeProjectId, setSlashArgumentArmed, setSlashArgumentItems,
    setSlashCommandContext, setSlashHighlight, setSlashQuery, showExtensionStatus, showUsagePopover, slashCommandContext, state, stats,
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

  /** 上一次真正渲染过的会话：切会话的 layout effect 靠它判断「离开的是谁」。 */
  const previousSessionPathRef = useRef(visibleSessionPath);

  /**
   * 把一份完整草稿（正文 + 附件/技能徽标）重新装回编辑器。
   *
   * 徽标节点不保存 DOM：`innerHTML` 能还原外形却带不回事件监听（悬停预览、× 删除），
   * 所以用工厂重新造节点，并同步填回两张 id → 数据的 Map，否则 `readComposerParts`
   * 会把徽标当成无法识别的节点丢掉。
   */
  function applyComposerDraft(parts: ComposerPart[]) {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    composerAttachmentMapRef.current.clear();
    composerCapabilityMapRef.current.clear();
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (part.kind === "text") {
        if (part.text) {
          fragment.appendChild(document.createTextNode(part.text));
        }
        continue;
      }
      if (part.kind === "attachment") {
        composerAttachmentMapRef.current.set(part.attachment.id, part.attachment);
        if (part.attachment.previewUrl) {
          attachmentPreviewUrlsRef.current.set(part.attachment.id, part.attachment.previewUrl);
        }
        fragment.appendChild(deps.createAttachmentBadgeNode(part.attachment));
        continue;
      }
      // 与 readComposerParts 同口径：编辑器里只还原技能徽标。
      if (part.capability.kind !== "skill") {
        continue;
      }
      composerCapabilityMapRef.current.set(capabilityBadgeKey(part.capability), part.capability);
      fragment.appendChild(deps.createCapabilityBadgeNode(part.capability));
    }

    editor.replaceChildren(fragment);
    composerSelectionRef.current = null;
    deps.hideAttachmentHover();
    deps.syncComposerState();

    // 切回一段会话十有八九是要接着打字：光标放到草稿末尾（外层随后会 focus composer）。
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  // composer 里是 DOM（contentEditable），切会话时不会卸载 —— 不在这里存取的话，
  // A 会话的草稿会原样留在 B 会话的输入框里（用户反馈的「composer 内容是全局的」）。
  // 用 layout effect：新会话的 bootstrap 已经落地但还没绘制，切过去不会闪一下旧文字。
  useLayoutEffect(() => {
    const previous = previousSessionPathRef.current;
    previousSessionPathRef.current = visibleSessionPath;
    if (previous === visibleSessionPath) {
      return;
    }
    // 还没有会话时的输入不算任何会话的草稿：进入第一个会话时原样留着。
    if (previous === "local-bootstrap") {
      return;
    }
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    composerDraftsRef.current.save(previous, deps.readComposerParts(editor));
    applyComposerDraft(composerDraftsRef.current.take(visibleSessionPath) ?? []);

    // 输入面的瞬时状态不属于任何会话：菜单、错误带、/ 参数上下文都收掉。
    setComposerError("");
    setShowCapabilityPicker(false);
    setSlashQuery("");
    setSlashCommandContext(null);
    setSlashArgumentArmed(false);
  }, [visibleSessionPath]);

  // 会话头部右侧的 git 徽标：只读、可失败、非轮询（切项目 / 切会话 / 一轮结束 / 窗口重新聚焦时刷新）。
  // 带上 sessionPath：worktree 会话看到、提交的就是 worktree 自己那份状态。
  const projectGit = useProjectGit({
    projectId: bootstrap.activeProjectId,
    sessionPath: visibleSessionPath,
    isStreaming: state.isStreaming,
    onError: reportError,
  });

  // 右面板的标签页（一个文件一个 tab）+ 每张文件 tab 的改动 / 正文数据。
  // 入口：文件树单击、改动列表单击、git 徽标的文件行、每轮「N 个文件已更改」。
  const panelTabs = useWorkspacePanelTabs({
    projectId: bootstrap.activeProjectId,
    sessionPath: visibleSessionPath,
    isStreaming: state.isStreaming,
    initialToolTabId: initialRightPanelTab,
  });

  // 右面板的文件树（Codex 风格：文件在右边）。入口是「文件」tab。
  const workspaceFiles = useWorkspaceFiles({
    projectId: bootstrap.activeProjectId,
    sessionPath: visibleSessionPath,
    isStreaming: state.isStreaming,
  });

  /**
   * 在右面板里看某个文件的改动。
   *
   * 面板此刻可能是收起的、或者窄屏下抽屉是关着的 —— 那样点一行看起来就像没反应，
   * 所以这里要随手把面板打开（和标题栏那个开关同一套窄屏判断）。
   */
  function openWorkspacePreview(
    path: string,
    source: WorkspaceDiffSource,
    base?: string,
    patch?: string,
  ) {
    if (window.innerWidth <= 920) {
      setShowPanel(true);
    } else {
      setRightPanelCollapsed(false);
    }
    panelTabs.openDiff({ path, source, base, patch });
  }

  /** 在右面板里看某个文件的正文（文件树单击、右键「查看文件内容」）。 */
  function openWorkspaceContent(path: string) {
    if (window.innerWidth <= 920) {
      setShowPanel(true);
    } else {
      setRightPanelCollapsed(false);
    }
    panelTabs.openContent(path);
  }

  /** 文件树 / 改动列表要选中的那一行（上一个打开的文件 tab）；没有打开过文件时是空串。 */
  const activeFileTabPath = panelTabs.activeFilePath;

  // 文件树上的改动标记：porcelain 只含已改动/未跟踪的文件，所以这张表天然很小。
  const changedFilesByPath = useMemo(
    () => new Map((projectGit.info?.files ?? []).map((file) => [file.path, file.status] as const)),
    [projectGit.info],
  );

  /**
   * 让某个项目成为「当前项目」。
   *
   * 文件树在左、文件预览在右，两边都绑在**当前项目**上（服务端跟着选中的会话走）。
   * 所以点别的项目上的图标时先切到它最近的一个会话 —— 否则树和右侧预览会指向两个不同的项目。
   */
  function focusProjectForPanel(projectId: string): boolean {
    if (projectId === bootstrap.activeProjectId) {
      return true;
    }

    const project = projects.find((candidate) => candidate.id === projectId);
    const session = project?.sessions.find((candidate) => !candidate.pinned) ?? project?.sessions[0];
    if (!session) {
      return false;
    }

    setActiveMainView("chat");
    markThreadSwitch();
    void selectSession(projectId, session.path).catch(() => {
      // `selectSession` 内部已把错误写进 state。
    });
    return true;
  }

  /** 项目条目上的「文件」图标：在左侧栏打开这个项目的文件树。 */
  function openProjectFileTree(projectId: string) {
    if (focusProjectForPanel(projectId)) {
      setSidebarFileTreeProjectId(projectId);
    }
  }

  /** 项目条目上的「技能/包」图标：弹出技能、包与 MCP 的管理弹窗。 */
  function openProjectCapabilities(projectId: string) {
    if (focusProjectForPanel(projectId)) {
      setCapabilitiesDialogProjectId(projectId);
    }
  }

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
      // 只记工具 tab：文件 tab 一多，最后停在文件 tab 上就会把「上次的工具视图」冲掉。
      rightPanelTab: panelTabs.activeTab?.kind === "tool" ? panelTabs.activeTab.id : undefined,
    });
  }, [appearance, leftSidebarCollapsed, leftSidebarWidth, panelTabs.activeTab, rightPanelCollapsed, rightPanelWidth, theme]);

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
        // 必须同时读 map：切会话的恢复发生在 layout effect 里，本 commit 的 passive
        // effect 跑的还是旧 `attachments` 闭包 —— 只看 state 会把刚恢复的草稿附件
        // 当成「没人用了」直接 revoke（回归：切回会话后缩略图裂开）。
        ...[...composerAttachmentMapRef.current.values()].map((attachment) => attachment.previewUrl),
        ...conversation.messages.flatMap((message) => message.attachments?.map((attachment) => attachment.previewUrl) ?? []),
        ...pendingPreviewUrlsRef.current,
        // 停在别的会话里的草稿：切回来时徽标还要显示缩略图，URL 不能被回收。
        ...composerDraftsRef.current.previewUrls(),
      ].filter((url): url is string => Boolean(url)),
    );

    for (const [id, url] of attachmentPreviewUrlsRef.current.entries()) {
      if (!referencedUrls.has(url)) {
        URL.revokeObjectURL(url);
        attachmentPreviewUrlsRef.current.delete(id);
      }
    }
  }, [attachments, conversation.messages]);

  // 会话被删除 / 归档后，它的草稿（连同附件的 blob URL）不该继续留在内存里。
  // 只按「服务端还承认的会话」裁剪；项目列表为空时（冷启动/加载中）不裁剪，
  // 否则一次空快照会把所有草稿清掉。
  useEffect(() => {
    const known = new Set<string>();
    for (const project of bootstrap.projects) {
      for (const session of project.sessions) {
        known.add(session.path);
      }
    }
    for (const session of bootstrap.archivedSessions ?? []) {
      known.add(session.path);
    }
    if (bootstrap.activeSessionPath) {
      known.add(bootstrap.activeSessionPath);
    }
    if (conversation.sessionFile) {
      known.add(conversation.sessionFile);
    }
    if (!known.size) {
      return;
    }

    for (const part of composerDraftsRef.current.prune(known)) {
      const url = part.kind === "attachment" ? part.attachment.previewUrl : undefined;
      if (!url) {
        continue;
      }
      const entry = [...attachmentPreviewUrlsRef.current.entries()].find(([, value]) => value === url);
      if (entry) {
        URL.revokeObjectURL(entry[1]);
        attachmentPreviewUrlsRef.current.delete(entry[0]);
      }
    }
  }, [bootstrap.projects, bootstrap.archivedSessions, bootstrap.activeSessionPath, conversation.sessionFile]);

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
    const nextSessionPath = await createSession(projectId);
    if (!nextSessionPath) {
      return;
    }
    // 预填走「会话草稿」而不是 `state.draft`（后者没有消费者）：
    // 切会话的 layout effect 会把这份草稿取出来装进编辑器；如果它已经跑过了
    // （bootstrap 抢在 await 恢复之前提交），这里就直接装。两条路互斥且幂等。
    const promptParts: ComposerPart[] = [{ kind: "text", text: prompt }];
    composerDraftsRef.current.save(nextSessionPath, promptParts);
    if (previousSessionPathRef.current === nextSessionPath) {
      applyComposerDraft(composerDraftsRef.current.take(nextSessionPath) ?? promptParts);
    }
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

  return { activeCustomExtensionUiRequest, activeExtensionUiRequest, activeWebExtensionUiRequest, activeFileTabPath, autoAppliedModelRef, autoResolveConflicts, canQueueFollowUp, canSubmitPrompt, changedFilesByPath, clearBuiltinNotice, compactionNoticeView, composerSessionBusy, contextPercent, extensionAboveWidgets, extensionBelowWidgets, focusComposerQuietly, followLatestScroll, getScrollState, handleComposerModelChange, hasConfiguredModel, openProjectCapabilities, openProjectFileTree, openWorkspaceContent, openWorkspacePreview, panelTabs, projectCommands, projectGit, restoreComposerFocusRing, sessionWorktree, showBuiltinNotice, streamingSessionPaths, visibleSessionPath, workspaceFiles };
}
