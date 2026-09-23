/**
 * Which sessions the sidebar should draw as busy.
 *
 * `bootstrap.streamingSessionPaths` is the server's list (read off the live runtimes),
 * and it is the authority for every run this window does not own. But this window's own
 * run only reaches `state.isStreaming`: the server list is refreshed by a snapshot, and
 * while this window owns the stream the next snapshot only arrives when the turn ends.
 * Without the union below the clock never appears for the session the user just
 * submitted in - the one row they are actually looking at.
 *
 * Deliberately *not* written into the bootstrap itself: adding the path there would
 * start the busy-session watchdog, whose first tick can be a full ~1 MB bootstrap pull
 * exactly while the user waits for the first token (see `pollMode.ts`).
 *
 * Kept free of runtime imports so it can be exercised without a bundler.
 */
export function sidebarStreamingSessionPaths(
  serverPaths: string[] | undefined,
  activeSessionPath: string | undefined,
  isStreamingLocally: boolean,
): string[] {
  const paths = serverPaths ?? [];
  if (!isStreamingLocally || !activeSessionPath || paths.includes(activeSessionPath)) {
    // Identity matters: this feeds a sidebar that must not re-render per token.
    return paths;
  }
  return [...paths, activeSessionPath];
}