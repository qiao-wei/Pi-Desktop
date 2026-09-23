/**
 * The transcript the *UI* renders.
 *
 * `session.state.messages` is what the model gets: pi rebuilds it from
 * `buildContextEntries()`, which replaces everything before a compaction's
 * `firstKeptEntryId` with the summary. That is the right thing to send to the
 * provider and the wrong thing to draw: compacting would silently delete turns
 * the user had in front of them.
 *
 * The session file is append-only, so the folded messages are still there. This
 * reads them back off the current branch and appends whatever the running agent
 * has in state but has not persisted yet (the answer being streamed right now).
 *
 * Consequence worth remembering: turn ordinals (and therefore bubble ids) are
 * counted over the *whole* branch, so they never shift when a compaction lands.
 * Everything that keys off bubble identity - merge, optimistic 插话, scroll
 * anchor - depends on that staying true. Use this function everywhere a turn
 * count is seeded from a transcript.
 */

/** Roles that become conversation. `custom` / `bashExecution` / summaries do not. */
const DISPLAY_ROLES = new Set(["user", "assistant", "toolResult"]);

export function isDisplayMessage(message) {
  return Boolean(message) && DISPLAY_ROLES.has(message.role);
}

/**
 * @param session pi AgentSession (needs `sessionManager.getBranch()` + `state.messages`)
 * @returns message objects of the whole current branch, oldest first.
 */
export function displayTranscript(session) {
  const live = Array.isArray(session?.state?.messages) ? session.state.messages : [];
  const branch = readBranch(session);
  if (!branch) {
    // No session manager (unit tests, exotic runtimes): fall back to the model view.
    return live.filter(isDisplayMessage);
  }

  const persisted = [];
  const seen = new Set();
  for (const entry of branch) {
    if (entry?.type !== "message" || !isDisplayMessage(entry.message)) {
      continue;
    }
    persisted.push(entry.message);
    seen.add(entry.message);
  }

  // pi keeps the message objects in `state.messages` identical to the ones it
  // persisted, so identity - not text comparison - decides what is still in
  // flight. Anything unmatched is the live tail and goes after the history.
  const inFlight = live.filter((message) => isDisplayMessage(message) && !seen.has(message));
  return inFlight.length ? [...persisted, ...inFlight] : persisted;
}

function readBranch(session) {
  const manager = session?.sessionManager;
  if (typeof manager?.getBranch === "function") {
    return manager.getBranch() ?? [];
  }
  if (typeof manager?.getEntries === "function") {
    return manager.getEntries() ?? [];
  }
  return null;
}
