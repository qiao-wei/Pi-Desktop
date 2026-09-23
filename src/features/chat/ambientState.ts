import type { AmbientBootstrap, BootstrapResponse } from "../../lib/api";

/**
 * Folding an *ambient* server answer into client state.
 *
 * The ambient answer (`GET /api/bootstrap?view=ambient`) is the snapshot minus the
 * conversation. It exists so the busy-session watchdog can keep asking questions
 * without paying a transcript-sized answer every time - see `pollMode.ts` for when it
 * is used, and `docs/plan.md` for why the periodic full pull was the wrong trade.
 *
 * The one invariant worth pinning in a test: **the message array must come back by
 * identity**. A new array - even with identical content - is a new React reference,
 * which rebuilds every bubble and re-renders the whole thread. A poll that costs a
 * full re-render every 5 seconds is indistinguishable to the user from a stutter, and
 * it scales with context size, which is the thing being fixed.
 *
 * Kept free of runtime imports so it can be exercised without a bundler.
 */

/** Which session a bootstrap answers for; older payloads only carry the file. */
export function bootstrapSessionPath(bootstrap: BootstrapResponse): string | undefined {
  return bootstrap.activeSessionPath ?? bootstrap.snapshot?.conversation?.sessionFile;
}

export function isBootstrapForSession(bootstrap: BootstrapResponse, sessionPath: string): boolean {
  return bootstrapSessionPath(bootstrap) === sessionPath;
}

/**
 * Apply `ambient` onto `current`, or `null` when the answer belongs to another session
 * (an in-flight poll that came back after a session switch - it must not land).
 *
 * `snapshot` is carried over untouched, by reference.
 */
export function applyAmbientBootstrap(
  current: BootstrapResponse | null | undefined,
  ambient: AmbientBootstrap,
  sessionPath: string,
): BootstrapResponse | null {
  if (!current || !isBootstrapForSession(current, sessionPath)) {
    return null;
  }

  return {
    ...current,
    canPrompt: ambient.canPrompt,
    projectTrusted: ambient.projectTrusted,
    streamingSessionPaths: ambient.streamingSessionPaths ?? [],
    compactingSessionPaths: ambient.compactingSessionPaths ?? [],
    // An ambient answer is a floor, never a rewrite: the queue contents themselves
    // belong to the stream and to the full reconcile, which is the only place allowed
    // to drop a 插话 the server cleared.
    pendingQueues: ambient.pendingQueues ?? current.pendingQueues,
  };
}
