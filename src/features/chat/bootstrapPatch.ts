import type { BootstrapResponse } from "../../lib/api";
import type { ChatMessage, ChatSession, MessageProcessBlock, ProjectSessionSummary, ProjectSummary } from "../../types";
/* The block algebra moved to `shared/chatProcessBlocks.ts` so the server and the
 * stream projection can use it too; re-exported here for existing call sites. */
export {
  appendLiveTextBlock,
  isToolProcessBlock,
  mergeAssistantProcessBlocks,
  mergeLiveProcessBlocks,
  normalizeMessageProcessBlocks,
  toolProcessBlockKeys,
  toolProcessBlocksMatch,
  upsertLiveToolBlock,
  upsertToolProcessBlock,
} from "../../shared/chatProcessBlocks.ts";

/**
 * Immutable, *structurally shared* updates for the conversation carried inside
 * the bootstrap snapshot.
 *
 * The streaming hot path used to `structuredClone` the whole snapshot per
 * server event and then mutate one message. That made every message object
 * change identity ~60 times per second, which in turn defeated assistant-ui's
 * identity-keyed `WeakMap` message cache and forced a full thread rebuild plus
 * a full relayout for every token.
 *
 * Everything here keeps untouched objects referentially identical: only the
 * conversation/snapshot envelope, the touched message, and the touched block
 * get new identities.
 */

type SnapshotStats = BootstrapResponse["snapshot"]["stats"];

export type PatchResult = {
  bootstrap: BootstrapResponse;
  changed: boolean;
};


export function withConversation(bootstrap: BootstrapResponse, nextConversation: ChatSession): BootstrapResponse {
  if (nextConversation === bootstrap.snapshot.conversation) {
    return bootstrap;
  }
  return {
    ...bootstrap,
    snapshot: {
      ...bootstrap.snapshot,
      conversation: nextConversation,
    },
  };
}

export function withStats(bootstrap: BootstrapResponse, nextStats: SnapshotStats): BootstrapResponse {
  if (nextStats === bootstrap.snapshot.stats) {
    return bootstrap;
  }
  return {
    ...bootstrap,
    snapshot: {
      ...bootstrap.snapshot,
      stats: nextStats,
    },
  };
}

/** The usage fields a `context_usage` stream event is allowed to move. */
export type ContextUsagePatch = Pick<
  SnapshotStats,
  "contextTokens" | "contextWindow" | "contextPercent" | "tokenUsage"
>;

/**
 * Apply one `context_usage` event - the per-message read-out the server pushes at
 * pi's own granularity.
 *
 * `undefined` means the server did not report that field (older bridge, or a
 * model with no known context window), so the previous reading is kept. `null` is
 * a real answer: "not knowable right now", which is exactly what pi reports
 * straight after a compaction and which must not be swallowed.
 */
export function useContextUsage(bootstrap: BootstrapResponse, usage: ContextUsagePatch): PatchResult {
  const stats = bootstrap.snapshot.stats;
  // A fresh object arrives per event, so compare it by value: keeping the old
  // identity is what stops every `message_end` from re-rendering the usage panel.
  const tokenUsage = sameTokenUsage(stats.tokenUsage, usage.tokenUsage) ? stats.tokenUsage : usage.tokenUsage;
  const nextStats: SnapshotStats = {
    ...stats,
    contextTokens: usage.contextTokens === undefined ? stats.contextTokens : usage.contextTokens,
    contextWindow: usage.contextWindow === undefined ? stats.contextWindow : usage.contextWindow,
    contextPercent: usage.contextPercent === undefined ? stats.contextPercent : usage.contextPercent,
    tokenUsage,
  };
  const unchanged = (["contextTokens", "contextWindow", "contextPercent", "tokenUsage"] as const)
    .every((key) => nextStats[key] === stats[key]);
  if (unchanged) {
    return { bootstrap, changed: false };
  }
  return { bootstrap: withStats(bootstrap, nextStats), changed: true };
}

function sameTokenUsage(
  current: SnapshotStats["tokenUsage"],
  next: SnapshotStats["tokenUsage"],
): boolean {
  if (next === undefined || current === undefined) {
    return next === undefined;
  }
  if (current === next) {
    return true;
  }
  const keys = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total", "estimatedCostUsd"] as const;
  return keys.every((key) => current[key] === next[key]);
}

/** Replace the message list, keeping the envelope identities stable when nothing changed. */
export function withMessages(bootstrap: BootstrapResponse, nextMessages: ChatMessage[]): PatchResult {
  const conversation = bootstrap.snapshot.conversation;
  if (nextMessages === conversation.messages) {
    return { bootstrap, changed: false };
  }
  return { bootstrap: withConversation(bootstrap, { ...conversation, messages: nextMessages }), changed: true };
}

/**
 * Map every message through `updater`, but only materialise new objects for
 * messages the updater actually replaced.
 */
export function patchMessages(
  bootstrap: BootstrapResponse,
  updater: (message: ChatMessage, index: number) => ChatMessage,
): PatchResult {
  const messages = bootstrap.snapshot.conversation.messages;
  let changed = false;
  const next = messages.map((message, index) => {
    const updated = updater(message, index);
    if (updated !== message) {
      changed = true;
    }
    return updated;
  });
  if (!changed) {
    return { bootstrap, changed: false };
  }
  return withMessages(bootstrap, next);
}

/** Shallow-copy the one message matching `messageId` and hand it to `updater`. */
export function patchMessage(
  bootstrap: BootstrapResponse,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
): PatchResult {
  const messages = bootstrap.snapshot.conversation.messages;
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) {
    return { bootstrap, changed: false };
  }
  const current = messages[index];
  const updated = updater(current);
  if (updated === current) {
    return { bootstrap, changed: false };
  }
  const next = messages.slice();
  next[index] = updated;
  return withMessages(bootstrap, next);
}

export function insertMessageAt(bootstrap: BootstrapResponse, index: number, message: ChatMessage): PatchResult {
  const messages = bootstrap.snapshot.conversation.messages;
  const next = messages.slice();
  next.splice(index, 0, message);
  return withMessages(bootstrap, next);
}

export function appendMessages(bootstrap: BootstrapResponse, messages: ChatMessage[]): PatchResult {
  return withMessages(bootstrap, [...bootstrap.snapshot.conversation.messages, ...messages]);
}

export function removeMessageById(bootstrap: BootstrapResponse, messageId: string): PatchResult {
  const messages = bootstrap.snapshot.conversation.messages;
  const next = messages.filter((message) => message.id !== messageId);
  if (next.length === messages.length) {
    return { bootstrap, changed: false };
  }
  return withMessages(bootstrap, next);
}

/**
 * Move a session to its "just updated" place in the sidebar and bump its `updatedAt`.
 *
 * The order comes from `session_index.updated_at`, which the server only writes when pi
 * persists the user message - so without this a re-submitted conversation keeps its old
 * place until the run's end-of-turn snapshot. Structurally shared on purpose:
 * submitting must not cost a full-bootstrap clone.
 *
 * The clock icon is not handled here: adding the path to `streamingSessionPaths` would
 * start the busy-session watchdog, whose first tick can be a full ~1 MB bootstrap pull
 * exactly while the user waits for the first token (see `pollMode.ts`). The sidebar
 * unions this window's own `isStreaming` in instead (`sidebarStreamingSessionPaths`).
 */
export function promoteSessionRow(
  bootstrap: BootstrapResponse,
  sessionPath: string,
  updatedAt = Date.now(),
): PatchResult {
  const projects = promoteSessionInProjects(bootstrap.projects, sessionPath, updatedAt);
  const snapshotProject = promoteSessionInProjects([bootstrap.snapshot.project], sessionPath, updatedAt)[0];
  if (projects === bootstrap.projects && snapshotProject === bootstrap.snapshot.project) {
    return { bootstrap, changed: false };
  }

  return {
    bootstrap: {
      ...bootstrap,
      projects,
      snapshot: snapshotProject === bootstrap.snapshot.project
        ? bootstrap.snapshot
        : { ...bootstrap.snapshot, project: snapshotProject },
    },
    changed: true,
  };
}

/** Promote the row in every project that holds it, keeping untouched projects by identity. */
function promoteSessionInProjects(
  projects: ProjectSummary[],
  sessionPath: string,
  updatedAt: number,
): ProjectSummary[] {
  let changed = false;
  const next = projects.map((project) => {
    const index = project.sessions.findIndex((session) => session.path === sessionPath);
    if (index < 0) {
      return project;
    }
    const sessions = promoteSession(project.sessions, index, updatedAt);
    if (sessions === project.sessions) {
      return project;
    }
    changed = true;
    return { ...project, sessions };
  });
  return changed ? next : projects;
}

/**
 * Move one row to its "just updated" position. The server orders the sidebar by
 * `pinned DESC, updated_at DESC`, so the promoted row goes after the pinned ones and
 * before the rest - a local bump must not disagree with the next snapshot more than
 * the clock it carries forces it to.
 *
 * Idempotent: a row that is already in place with an equally recent timestamp comes
 * back as the same array, so re-applying the mark cannot churn the sidebar.
 */
function promoteSession(
  sessions: ProjectSessionSummary[],
  index: number,
  updatedAt: number,
): ProjectSessionSummary[] {
  const row = sessions[index];
  const nextUpdatedAt = Math.max(row.updatedAt, updatedAt);
  const rest = sessions.filter((_, candidate) => candidate !== index);
  const firstUnpinned = rest.findIndex((session) => !session.pinned);
  const at = firstUnpinned < 0 ? rest.length : firstUnpinned;
  if (at === index && nextUpdatedAt === row.updatedAt) {
    return sessions;
  }
  return [...rest.slice(0, at), { ...row, updatedAt: nextUpdatedAt }, ...rest.slice(at)];
}

/**
 * Mark a conversation as updated. `updatedAt` lives on the conversation object,
 * so a bump is what makes the messages-array replacement visible to React.
 */
export function touchConversation(bootstrap: BootstrapResponse, updatedAt = Date.now()): BootstrapResponse {
  const conversation = bootstrap.snapshot.conversation;
  if (conversation.updatedAt === updatedAt) {
    return bootstrap;
  }
  return withConversation(bootstrap, { ...conversation, updatedAt });
}

/* -------------------------------------------------------------------------- */
/* Process / live block helpers (identity preserving)                          */
/* -------------------------------------------------------------------------- */
