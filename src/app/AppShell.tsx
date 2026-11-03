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

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FilesPane } from "../features/workspace/FilesPane";
import { EmbeddedBrowserPane } from "../features/browser/EmbeddedBrowserPane";
import { GitPane } from "../features/workspace/GitPane";
import { LauncherPane } from "../features/workspace/LauncherPane";
import { PreviewPane } from "../features/workspace/PreviewPane";
import { EMPTY_RIGHT_PANEL_VIEW_ID, RightPanel } from "../features/workspace/RightPanel";
import { contentSubject, diffSubject } from "../shared/workspacePreview";

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
    activeCustomExtensionUiRequest, activeExtensionUiRequest, activeFileTabPath, activeMainView, activeProject, activeWebExtensionUiRequest,
    appearance, archiveSession, attachmentHover, bootstrap, capabilities, capabilitiesDialogProjectId, changedFilesByPath, confirmTurnAction, conversation, createProject, createSession,
    customModels, customUiCancelVersion, deleteAllArchivedSessions, deleteArchivedSession, deleteCapabilityItem, deleteSession,
    focusComposerQuietly, globalSearchOpen, handleGlobalSearchSelect,
    handlePanelResize, handlePanelResizeEnd, handlePanelResizeStart, importSkill, insertPackageCommandIntoComposer, inspectMcpServer, installPackage, leftSidebarCollapsed, leftSidebarWidth, openProjectCapabilities, openProjectFileTree, openWorkspaceContent, openWorkspacePreview, panelTabs, parseMcpImport, pendingTurnAction,
    pinProject, pinSession, projectGit, projects,
    readMcpServerDetail, refreshAvailableModels, removeProject, reorderProjects,
    resizingSide, respondExtensionUi, revealProject, rightPanelCollapsed,
    rightPanelWidth, saveMcpServer, savePersonalization, saveToolSettings, selectSession,
    setActiveMainView, setAppearance,
    setCapabilitiesDialogProjectId, setCapabilityDefault, setCapabilityPinned, setCustomUiCancelVersion, setGlobalSearchOpen, setLeftSidebarCollapsed,
    setPendingTurnAction, setRightPanelCollapsed, setShowLeftPanel, setShowPanel, setShowSettings, setSidebarFileTreeProjectId,
    setTheme, showContextPanel,
    showLeftPanel, showPanel, showSettings, sidebarFileTreeProjectId, state, streamingSessionPaths, t, theme, toggleLeftPanel, toggleRightPanel, unarchiveSession, updatePackage, updateProject, updateSession, visibleSessionPath, workspaceFiles,
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
          fileTreeProjectId={sidebarFileTreeProjectId}
          onCloseFileTree={() => setSidebarFileTreeProjectId("")}
          onOpenProjectFileTree={openProjectFileTree}
          onOpenProjectCapabilities={openProjectCapabilities}
          fileTreeView={
            <FilesPane
              files={workspaceFiles}
              changedFiles={changedFilesByPath}
              activePath={activeFileTabPath}
              onOpenContent={openWorkspaceContent}
              // 树上的右键「看改动」用默认来源（未暂存）：要按分组选来源得去「改动」tab。
              onOpenDiff={(path) => openWorkspacePreview(path, "unstaged")}
              onOpenInIde={(path) => void projectGit.openFile(path)}
            />
          }
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
        {/* 右侧面板的壳（视图 strip / 滚动区 / 窄屏浮层定位）在 RightPanel 里。
            内容仍然在这里组：能力面板的 call site 必须留在本文件 ——
            `capabilityPanelParity.test.ts` 就靠它的 props 接线核对两个宿主是否一致。 */}
        <RightPanel
          collapsed={rightPanelCollapsed}
          narrowOpen={showPanel}
          tabs={panelTabs.tabs}
          activeTabId={panelTabs.activeTabId}
          onSelectTab={panelTabs.activateTab}
          onCloseTab={panelTabs.closeTab}
          onCloseOtherTabs={panelTabs.closeOtherTabs}
          onCloseAllTabs={panelTabs.closeAllTabs}
          onOpenToolTab={panelTabs.openToolTab}
          recentClosedTabs={panelTabs.recentClosedTabs}
          onReopenClosedTab={panelTabs.reopenClosedTab}
          onMoveTab={panelTabs.moveTab}
          views={{
            // 内置浏览器：能力由宿主声明（Electron = 有，Tauri/Web = 没有），面板自己负责说明。
            browser: <EmbeddedBrowserPane />,
            // 完整的改动 review 面（按来源切）；提交这种写操作仍在 git 徽标里。
            git: (
              <GitPane
                info={projectGit.info}
                projectId={bootstrap.activeProjectId}
                sessionPath={visibleSessionPath}
                isRefreshing={projectGit.isRefreshing}
                activePath={activeFileTabPath}
                themeMode={theme}
                onRefresh={() => void projectGit.refresh()}
                onOpenDiff={(path, source, base) => openWorkspacePreview(path, source, base)}
                onOpenContent={openWorkspaceContent}
                onOpenInIde={(path) => void projectGit.openFile(path)}
              />
            ),
            // 一张 tab 都没有时的空状态（`+` 下拉能开的东西列一遍）。
            [EMPTY_RIGHT_PANEL_VIEW_ID]: <LauncherPane onChooseTool={panelTabs.openToolTab} />,
            // 一个文件一张 tab：点树 / 改动列表 / 每轮清单里的文件都会新开（同一个文件同一个模式
            // 则复用，见 `openPanelTab`）。每张 tab 自带 loading / 失败态，互不影响。
            ...Object.fromEntries(
              panelTabs.tabs.flatMap((tab) => {
                if (tab.kind !== "file") {
                  return [];
                }
                const data = panelTabs.dataByTabId[tab.id];
                const preview = (
                  <PreviewPane
                    subject={
                      tab.mode === "diff"
                        ? diffSubject({
                            path: tab.path,
                            source: tab.source ?? "unstaged",
                            base: tab.base,
                            // 补丁来自这一轮的工具结果，不是现读的 git（见 RightPanelFileTab.patch）。
                            origin: typeof tab.patch === "string" ? "turn" : "git",
                          })
                        : contentSubject(tab.path)
                    }
                    diff={data?.diff ?? null}
                    content={data?.content ?? null}
                    isLoading={data?.isLoading ?? true}
                    error={data?.error ?? ""}
                    themeMode={theme}
                    onClose={() => panelTabs.closeTab(tab.id)}
                    onRetry={() => panelTabs.reloadTab(tab.id)}
                    onOpenInIde={() => void projectGit.openFile(tab.path)}
                  />
                );
                // 元素先落到一个命名变量再进数组：`Object.fromEntries` 的条目键就是 React key，
                // 直接写成数组字面量会让 lint 的 `jsx-key` 误报（它只看到「数组里的元素」）。
                return [[tab.id, preview]];
              }),
            ),
          }}
        />
          </>
        ) : null}

        {/* 项目条目上的「技能/包」图标开的就是这个弹窗（ZCode 把 workspace 的 skills/packages
            收在这一层，不再是右面板的一张 tab）。内容仍是同一个 `ProjectCapabilitiesPanel`：
            和「全局技能与扩展」页共用一套对话框，不许在弹窗里再抄一份（见 capabilityPanelParity）。 */}
        <Dialog
          open={Boolean(capabilitiesDialogProjectId)}
          onOpenChange={(next) => {
            if (!next) {
              setCapabilitiesDialogProjectId("");
            }
          }}
        >
          <DialogContent
            className="grid h-[min(82svh,720px)] w-[min(94vw,780px)] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden border-border bg-[var(--app-content-surface)] p-0 sm:max-w-none"
          >
            <DialogHeader className="border-b border-border px-5 py-3.5 text-left">
              <DialogTitle>{t("sidebar.capabilitiesDialog.title")}</DialogTitle>
              <DialogDescription>{t("sidebar.capabilitiesDialog.hint")}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto px-5 py-3">
              <ProjectCapabilitiesPanel
                capabilities={capabilities}
                projectName={projects.find((project) => project.id === capabilitiesDialogProjectId)?.name ?? activeProject.name}
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
            </div>
          </DialogContent>
        </Dialog>


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
