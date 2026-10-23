/**
 * 侧栏（项目/会话列表与项目对话框）.
 *
 * 项目侧栏、会话行、悬停卡、项目增删改对话框，以及它们用到的常量。
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import { markThreadSwitch } from "../components/assistant-ui/elements/thread.aui";
import { AutoHideScroll } from "../components/AutoHideScroll";
import { SidebarArchiveIcon, SidebarFolderIcon, SidebarFolderOpenIcon, SidebarMessageIcon, SidebarMonitorIcon, SidebarNewSessionIcon, SidebarPinIcon } from "../components/sidebarIcons";
import { SIDEBAR_SESSION_BUSY_ICON_CLASS, SIDEBAR_SESSION_BUSY_SLOT_CLASS, sidebarSessionBusyIndicator } from "../features/chat/sidebarStreaming";

import { useT } from "../i18n/react";
import { reportDiagnostic } from "../lib/api";
import { createId } from "../lib/id";

import { loadUiPreferences, saveUiPreferences } from "../lib/ui-preferences";
import { collectDroppedItems, pickDroppedProjectFolder, supportsDroppedFolderPaths } from "../shared/droppedProjectFolder";

import { resolveProjectSidebarLock } from "../shared/projectSidebarLock";
import { platformRevealFolderLabelKey } from "../shared/revealFolderLabel";
import { worktreeSessionBadgeKind } from "../shared/sessionWorktree";
import { sidebarHoverActionClass } from "../shared/sidebarActionVisibility";
import { SIDEBAR_PROJECT_CARD_HEIGHT, SIDEBAR_PROJECT_CARD_WIDTH, SIDEBAR_SESSION_CARD_HEIGHT, SIDEBAR_SESSION_CARD_WIDTH, formatSidebarRelativeTime, formatSidebarSessionCount, placeSidebarHoverCard, pointerKeepsSidebarCardOpen, sidebarSessionPreview } from "../shared/sidebarHoverPreview";
import { expandProjectForNewSession } from "../shared/sidebarProjectExpansion";
import type { CreateProjectResult, ProjectSummary, ToolToggleState } from "../types";

import { Button } from "@/components/ui/button";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";


import { cn } from "@/lib/utils";
import { ChevronRight, FolderOpen, GitFork, Loader, Moon, MoreHorizontal, Plus, Settings, Sun, Trash2, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { SidebarDialog, SidebarDialogView, lastPathPart, projectDialogWithCwd, statusBannerStyles, toolToggleOptions } from "./SidebarDialogs";

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
  onSaveToolSettings,
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
  /** 工具开关（codemode）：写的是 pi 自己的 `defaultTools`，见 server/toolSettings.mjs。 */
  onSaveToolSettings: (input: { scope: "user" | "project"; state: ToolToggleState; projectId?: string }) => Promise<unknown>;
  onPinProject: (projectId: string, pinned: boolean) => Promise<void>;
  onReorderProjects: (projectIds: string[]) => Promise<void>;
  onRemoveProject: (projectId: string) => Promise<void>;
  onRevealProject: (projectId: string) => Promise<void>;
  onCreateSession: (projectId?: string, name?: string, options?: { worktree?: boolean }) => Promise<void>;
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
      // 项目自身的字段已经存好了；codemode 是另一份文件（`.pi/settings.json`），
      // 只在真改过时才写，失败就把弹窗留着把服务端的原话显示出来（例如项目没被信任）。
      if (dialog.codemode !== (dialog.project.codemode ?? "inherit")) {
        try {
          await onSaveToolSettings({
            scope: "project",
            projectId: dialog.project.id,
            state: dialog.codemode,
          });
        } catch (error) {
          setProjectSubmitError(error instanceof Error ? error.message : String(error));
          return;
        }
      }
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

  function createSessionFromSidebar(projectId: string, options?: { worktree?: boolean }) {
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
    void onCreateSession(projectId, undefined, options).then(() => onFocusComposer());
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
                    onArchive={(title) => setDialog({ kind: "archive-session", projectId, sessionPath: session.path, title, inWorktree: Boolean(session.inWorktree) })}
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
                      {/* worktree 会话的发现入口。worktree 必须在建会话之前定下来（cwd 就是
                          那时写进会话头的），所以它属于「新建」而不是可以在 composer 里后补的开关；
                          放在这里是为了让「＋」保持一次点击。 */}
                      <DropdownMenuItem onSelect={() => createSessionFromSidebar(project.id, { worktree: true })}>
                        <GitFork size={16} />
                        {t("sidebar.newSessionInWorktree")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void onRevealProject(project.id)}>
                        <FolderOpen />
                        {revealLabel}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setDialog({
                        kind: "edit-project",
                        project,
                        name: project.name,
                        cwd: project.cwd,
                        codemode: project.codemode ?? "inherit",
                      })}>
                        <Settings />
                        {t("sidebar.editProject")}
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ kind: "remove-project", project })}>
                        <Trash2 />
                        {t("dialog.removeAction")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {/* 一次点击就建普通会话（原来的手感）。worktree 是「这条会话跑在隔离检出里」，
                      必须在建会话之前定下来（会话文件头里的 cwd 就是那时写进去的），所以不放在
                      composer 里做事后开关：按住 ⌥/Alt 点击走 worktree，另一个发现入口在项目 ⋯ 菜单里。 */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={sidebarLock.locked}
                    className={cn("size-6", sidebarLock.lockClass)}
                    aria-label={t("sidebar.newSession")}
                    title={t("sidebar.newSessionHint")}
                    onClick={(event) => createSessionFromSidebar(project.id, event.altKey ? { worktree: true } : undefined)}
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
                      onArchive={(title) => setDialog({ kind: "archive-session", projectId: project.id, sessionPath: session.path, title, inWorktree: Boolean(session.inWorktree) })}
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
                  setDialog({
                    kind: "edit-project",
                    project,
                    name: project.name,
                    cwd: project.cwd,
                    codemode: project.codemode ?? "inherit",
                  });
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
/* moved to src/app/SidebarDialogs.tsx */

/* moved to src/app/SidebarDialogs.tsx */


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
  const busyIndicator = sidebarSessionBusyIndicator(isPending, isStreaming);
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
          gutter so they never push the title sideways. The cue itself is ZCode's task-list
          slot (a `Loader` that really spins, spun on this HTML wrapper rather than on the
          SVG) - see `sidebarStreaming.ts` for why the animation may not move onto the icon. */}
      {busyIndicator === "none" ? null : (
        <span className={SIDEBAR_SESSION_BUSY_SLOT_CLASS}>
          <Loader
            className={SIDEBAR_SESSION_BUSY_ICON_CLASS}
            aria-hidden={busyIndicator === "pending" ? "true" : undefined}
            aria-label={busyIndicator === "streaming" ? t("sidebar.generating") : undefined}
          />
        </span>
      )}
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
            "flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 pl-9 group-hover:pr-[54px] group-focus-within:pr-[54px]",
            // Pinned session rows (codex-ui `.chat-row-wrap.pinned`) keep their actions visible.
            session.pinned && "pr-[54px]",
          )}
          onDoubleClick={(event) => {
            event.stopPropagation();
            setEditingSession({ projectId, sessionPath: session.path, title: session.title });
          }}
        >
          <span className="min-w-0 flex-1 truncate">{session.title}</span>
          {/* A chat started in a managed worktree gets a small fork glyph after the title,
              so the isolated-checkout rows are tellable at a glance without opening each one.
              It sits before the hover-action padding, so it never slides under the buttons. */}
          {worktreeSessionBadgeKind(session) === "worktree" ? (
            <span
              className="inline-flex shrink-0 items-center"
              role="img"
              aria-label={t("worktree.badge")}
              title={t("worktree.badge")}
            >
              <GitFork className="size-3 text-muted-foreground" />
            </span>
          ) : null}
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

const additionalProjectSessionLimit = 10;

function hasDraggedFiles(event: ReactDragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/** Grace period for moving from a row onto its interactive project card. */
const hoverCardHideGrace = 200;

/** Show the hover card only after the pointer settles on a row. */
const hoverCardShowDelay = 300;

const initialProjectSessionLimit = 5;
/* moved to src/app/SidebarDialogs.tsx */

/* moved to src/app/SidebarDialogs.tsx */


const projectDropBoundarySize = 12;

/**
 * Temporarily hidden: pinning a project persists `pinned` but nothing reads it yet (projects are
 * not reordered by it, and the row badge is the only visible change), so the menu item and the
 * hover-card button promise an effect they do not have. Flip to `true` to bring both back once
 * project pinning actually changes the sidebar order.
 */
const projectPinActionsVisible: boolean = false;
/* moved to src/app/SidebarDialogs.tsx */

/* moved to src/app/SidebarDialogs.tsx */


export {
  ProjectSidebar,
  SidebarDialogView,
  SidebarSessionRow,
  additionalProjectSessionLimit,
  hasDraggedFiles,
  hoverCardHideGrace,
  hoverCardShowDelay,
  initialProjectSessionLimit,
  lastPathPart,
  projectDialogWithCwd,
  projectDropBoundarySize,
  projectPinActionsVisible,
  statusBannerStyles,
  toolToggleOptions,
};
// 纯类型 + 只在簇内用到的常量：类型要 `export type`（isolatedModules 要求），常量不必往外露。
export type { SidebarDialog, SidebarHoverCardState };
