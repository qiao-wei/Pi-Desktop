import type {
  CSSProperties,
} from "react";

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

import { AttachmentHoverCard } from "./AttachmentHoverCard";


import { CapabilitiesPage } from "./CapabilitiesPage";
import { ProjectCapabilitiesPanel } from "./ProjectCapabilitiesPanel";




import { SettingsModal } from "./SettingsDialogs";
import { ExtensionCustomUiPanel } from "../components/ExtensionCustomUiPanel";
import { ExtensionNotifications, ExtensionUiDialog, ExtensionWebUi } from "./ExtensionUiSurface";

import { GlobalSearchDialog } from "../features/search/GlobalSearchDialog";

import { PanelResizeHandle } from "./PanelResizeHandle";

import { ProjectSidebar } from "./Sidebar";

import { TitleBar } from "./TitleBarChrome";

import { cn } from "@/lib/utils";

import { stripTerminalSequences } from "../shared/terminalText.ts";
import type { AppModel } from "./useAppModel";
import { ComposerRegion } from "./ComposerRegion";

/**
 * App 的视图（原 App() 返回的 JSX）
 *
 * 巨型 `App()` 拆三层的第二层：纯视图，状态与回调都从 `view` 上取。
 * 必须是**模块级**组件 —— 定义在 App 内部会每次 render 换类型 → 整棵子树卸载重挂。
 *
 * 由 `.scratch/split-app-files.mjs` 从 `src/app/App.tsx` 机械搬出。
 */

export function AppShell({ view }: { view: AppModel }) {
  // 视图里照旧用裸名字（JSX 一个字都不用改）：从 model 上解构出来。
  // 好处：拆分对 625 行 JSX 是「纯搬家」，diff 干净、结构断言不会因为前缀而假红。
  const {
    activeCustomExtensionUiRequest, activeExtensionUiRequest, activeMainView, activeProject, activeWebExtensionUiRequest,
    appearance, archiveSession, attachmentHover, bootstrap, capabilities, confirmTurnAction, conversation, createProject, createSession,
    customModels, customUiCancelVersion, deleteAllArchivedSessions, deleteArchivedSession, deleteCapabilityItem, deleteSession,
    focusComposerQuietly, globalSearchOpen, handleGlobalSearchSelect,
    handlePanelResize, handlePanelResizeEnd, handlePanelResizeStart, importSkill, insertPackageCommandIntoComposer, inspectMcpServer, installPackage, leftSidebarCollapsed, leftSidebarWidth, parseMcpImport, pendingTurnAction,
    pinProject, pinSession, projects,
    readMcpServerDetail, refreshAvailableModels, removeProject, reorderProjects,
    resizingSide, respondExtensionUi, revealProject, rightPanelCollapsed,
    rightPanelWidth, saveMcpServer, savePersonalization, saveToolSettings, selectSession,
    setActiveMainView, setAppearance,
    setCapabilityDefault, setCapabilityPinned, setCustomUiCancelVersion, setGlobalSearchOpen, setLeftSidebarCollapsed,
    setPendingTurnAction, setRightPanelCollapsed, setShowLeftPanel, setShowPanel, setShowSettings,
    setTheme, showContextPanel,
    showLeftPanel, showPanel, showSettings, state, streamingSessionPaths, t, theme, toggleLeftPanel, toggleRightPanel, unarchiveSession, updatePackage, updateProject, updateSession,
  } = view;
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
        <ComposerRegion view={view} />
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
