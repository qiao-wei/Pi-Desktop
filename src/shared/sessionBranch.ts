/**
 * Branch lookups shared by the bridge.
 *
 * pi sessions are append-only: `navigateTree` only moves the leaf pointer, it
 * never removes entries. That is why an edit (rewind + resend) can keep the
 * abandoned turn's token/cost usage in `getSessionStats()` (which aggregates
 * every entry) while the transcript the UI renders (`getBranch()`) stops showing
 * it. This module turns a UI bubble ordinal into the session entry to rewind to.
 */

export interface BranchEntryLike {
  type?: string;
  id?: string;
  message?: { role?: string } | null;
}

/**
 * Entry id of the Nth user message (1-based, the same ordinal `chatBubbleId`
 * uses) on the given branch, or null when the branch has fewer turns.
 */
export function userMessageEntryIdForTurn(entries: readonly BranchEntryLike[], turn: number): string | null {
  if (!Number.isInteger(turn) || turn < 1) {
    return null;
  }

  let seen = 0;
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "user" || !entry.id) {
      continue;
    }
    seen += 1;
    if (seen === turn) {
      return entry.id;
    }
  }

  return null;
}