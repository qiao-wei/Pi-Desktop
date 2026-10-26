import { GitFork, Loader } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { SidebarArchiveIcon, SidebarPinIcon } from "../components/sidebarIcons";
import { SIDEBAR_SESSION_BUSY_ICON_CLASS, SIDEBAR_SESSION_BUSY_SLOT_CLASS, sidebarSessionBusyIndicator } from "../features/chat/sidebarStreaming";
import { useT } from "../i18n/react";
import { worktreeSessionBadgeKind } from "../shared/sessionWorktree";
import { sidebarHoverActionClass } from "../shared/sidebarActionVisibility";
import type { ProjectSummary } from "../types";

/**
 * 一条会话行（标题、进行中指示、worktree 徽标、置顶/归档动作、重命名输入框）。
 *
 * 从 `src/app/Sidebar.tsx` 搬出来的自包含一簇：那个文件被 `max-lines` 棘轮冻着，而这一簇
 * 是纯展示（数据与动作全走 props）。纯搬家，行为一字未改。
 */
export function SidebarSessionRow({
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
