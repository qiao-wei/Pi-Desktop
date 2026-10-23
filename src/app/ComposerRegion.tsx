import type { AppModel } from "./useAppModel";
import type {
  CSSProperties,
} from "react";
import {
  Activity,
  FolderOpen,
  Mic,
  Plus,
  Send,
  Settings,
  Square,
  Loader2,
  X,
} from "lucide-react";
import {
  skillCommandsDisabled,
} from "../features/chat/slashMenu";
import { Button } from "@/components/ui/button";
import { SlashMenu } from "./CapabilitySurfaces";
import { ChatThread } from "../features/chat/ChatThread";
import { ExtensionStatusBar } from "./AppComposerHelpers";
import { ComposerModelSelect } from "../features/models/ComposerModelSelect";
import { ComposerOverflowMenu, ThinkingLevelSelect } from "./ComposerControls";
import { ExtensionWidgetStack } from "./ExtensionUiSurface";
import { GitStatusBadge } from "../components/GitStatusBadge";
import { InTaskSearchBar } from "../features/search/InTaskSearchBar";
import { ProjectCommandControls } from "../components/ProjectCommandControls";
import { hasDraggedFiles, statusBannerStyles } from "./Sidebar";
import { SessionWorktreeBadge } from "../components/SessionWorktreeBadge";
import { UsagePopover } from "./UsagePopover";
import { cn } from "@/lib/utils";
import { platformRevealFolderLabelKey } from "../shared/revealFolderLabel";

/**
 * App 视图里的 `<section>` 区域（原先长在 `AppShell` 里）。
 *
 * 拆出来的原因很直接：`AppShell.tsx` 超了 700 行上限，而 JSX 的边界天然适合按区域切。
 * 取法与 `.scratch/split-app.mjs` 一致 —— **JSX 一个字不改**，需要的 model 字段在这里解构：
 * 于是 props 只有一个 `view`，调用处不用摆 100 多个 prop。
 *
 * 由 `.scratch/extract-jsx-region.mjs` 机械搬出。
 */
const statusBannerButtonStyles =
  "text-amber-900 hover:bg-amber-100 hover:text-amber-900 dark:text-amber-200 dark:hover:bg-amber-900/40";

export function ComposerRegion({ view }: { view: AppModel }) {
  const {
    activeMainView, activeModelThinkingLevels, activeProject, addFiles, attachments, autoResolveConflicts,
    availableModels, bootstrap, builtinNotice, cancelEditMessage, capabilities, closeInTaskSearch,
    compactContext, compactionNoticeView, composerCapabilityCount, composerEditorRef, composerError, composerSessionBusy,
    composerText, contextPercent, conversation, customModels, dismissCompactionNotice, dismissError,
    editingMessageId, extensionAboveWidgets, extensionBelowWidgets, extensionStatusRef, extensionWidgetsCollapsed, failedEditText,
    fileInputRef, handleComposerInput, handleComposerKeyDown, handleComposerModelChange, handleDragEnter, handleDragLeave,
    handleDrop, handleInTaskSearchCount, handleInTaskSearchQueryChange, handlePaste, handleProjectCommandTerminalChange, handleStopTurn,
    handleSubmit, hideAttachmentHover, inTaskMatchCount, inTaskSearch, isDraggingFiles, isPreparingAttachments,
    modelConfig, modelSupportsThinking, projectCommandTerminal, projectCommands, projectGit, refreshMessage,
    rememberComposerSelection, restoreComposerFocusRing, revealProject, revealRunLog, scrollStateRef, selectSlashItem,
    selectedModel, selectedProvider, sessionWorktree, setComposerError, setShowExtensionStatus, setShowSettings,
    setShowUsagePopover, setSlashHighlight, showAttachmentHover, showCapabilityPicker, showExtensionStatus, showUsagePopover,
    slashItems, startEditMessage, state, stats, stepInTaskSearch, submitEditMessage,
    t, toggleExtensionWidgets, trustProject, updateSessionThinkingLevel, usagePopoverRef, visibleSessionPath,
    visibleSlashHighlight,
  } = view;

  return <section
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
                  disabled={(!composerText.trim() && attachments.length === 0 && composerCapabilityCount === 0) || isPreparingAttachments || state.isStopping}
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
              skillCommandsHidden={skillCommandsDisabled(capabilities)}
            />
          ) : null}
          {extensionBelowWidgets.length ? <ExtensionWidgetStack widgets={extensionBelowWidgets} /> : null}
        </form>
        </section>;
}
