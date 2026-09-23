/**
 * The sidebar blocks interaction while a bootstrap refetch owns the project list,
 * but "refetch in flight" covers two very different situations:
 *
 * - switching conversation / mutating the list (create, remove, new session, …)
 *   changes what the list shows → the controls should visibly wait;
 * - selecting another conversation only replaces the chat area, the list itself
 *   does not change → dimming every project at once reads as a glitch.
 *
 * So the caller tracks *why* it is busy (via the pending switch target) and this
 * module turns that into the two independent flags the rows need.
 */

export type ProjectSidebarLockInput = {
  /** `state.isBootstrapping`: a full bootstrap response is on its way. */
  isBootstrapping: boolean;
  /** Session the user clicked and that has not been rendered yet, if any. */
  pendingSessionPath: string | null;
};

export type ProjectSidebarLock = {
  /** Ignore sidebar interaction; keeps a single switch in flight (responses may arrive out of order). */
  locked: boolean;
  /** Grey the controls out. False while the only work in flight is a conversation switch. */
  dimmed: boolean;
  /** Row that should show the "switching" spinner, or `null`. */
  pendingSessionPath: string | null;
  /** Tailwind overrides for controls that are locked without dimming. */
  lockClass: string;
};

/**
 * Locked-but-not-dimmed controls keep their normal look, and the pointer says
 * "working" instead of "not allowed".
 */
export const sidebarSwitchLockClass = "disabled:opacity-100 disabled:cursor-progress";

export function resolveProjectSidebarLock({
  isBootstrapping,
  pendingSessionPath,
}: ProjectSidebarLockInput): ProjectSidebarLock {
  const locked = isBootstrapping;
  const activePendingSessionPath = locked && pendingSessionPath ? pendingSessionPath : null;
  const dimmed = locked && !activePendingSessionPath;

  return {
    locked,
    dimmed,
    pendingSessionPath: activePendingSessionPath,
    lockClass: locked && !dimmed ? sidebarSwitchLockClass : "",
  };
}
