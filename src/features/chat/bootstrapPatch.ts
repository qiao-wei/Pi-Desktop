import type { BootstrapResponse } from "../../lib/api";
import type { ChatMessage, ChatSession, ProjectSessionSummary, ProjectSummary } from "../../types";
import { deriveSessionTitle } from "../../shared/sessionTitle.ts";
import { mergeChatBubbles } from "../../shared/chatBubbles.ts";
import { isBootstrapForSession } from "./ambientState.ts";

import { settleStreamingAnswer } from "../../shared/chatTurnTiming.ts";
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
export function applyContextUsage(bootstrap: BootstrapResponse, usage: ContextUsagePatch): PatchResult {
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

/**
 * Materialise the session row of a brand-new session, locally.
 *
 * The first message of a fresh session must show up in the sidebar before the server
 * has a transcript to list; this rewrites the project's (and, when it is the active
 * one, the snapshot's) session list in place. Moved here from `usePiDesktopApp` because
 * it mutates a bootstrap and nothing else.
 */
export function upsertLocalFallbackSession(bootstrap: BootstrapResponse, sessionPath: string, userMessage: ChatMessage, messageCount: number) {
  const projectId = bootstrap.activeProjectId || bootstrap.snapshot.conversation.projectId || bootstrap.snapshot.project.id;
  const title = deriveSessionTitle({ text: userMessage.content, attachments: userMessage.attachments }) || "New session";
  const session = {
    path: sessionPath,
    id: sessionPath.split(/[\\/]/u).pop()?.replace(/\.[^.]+$/u, "") || bootstrap.snapshot.conversation.id,
    title,
    cwd: bootstrap.snapshot.conversation.workingDirectory || bootstrap.snapshot.project.cwd,
    createdAt: bootstrap.snapshot.conversation.createdAt,
    updatedAt: userMessage.createdAt,
    messageCount,
    firstMessage: userMessage.content,
    pinned: false,
  };

  bootstrap.projects = bootstrap.projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }

    const existing = project.sessions.find((candidate) => candidate.path === sessionPath);
    const nextSession = existing
      ? {
          ...existing,
          title: existing.title === "New session" || existing.title === "no messages" || existing.messageCount <= 0 ? title : existing.title,
          updatedAt: userMessage.createdAt,
          messageCount: Math.max(existing.messageCount, messageCount),
          firstMessage: existing.firstMessage || userMessage.content,
        }
      : session;

    return {
      ...project,
      sessions: existing
        ? project.sessions.map((candidate) => candidate.path === sessionPath ? nextSession : candidate)
        : [session, ...project.sessions],
    };
  });

  if (bootstrap.snapshot.project.id === projectId) {
    const existing = bootstrap.snapshot.project.sessions.find((candidate) => candidate.path === sessionPath);
    const nextSession = existing
      ? {
          ...existing,
          title: existing.title === "New session" || existing.title === "no messages" || existing.messageCount <= 0 ? title : existing.title,
          updatedAt: userMessage.createdAt,
          messageCount: Math.max(existing.messageCount, messageCount),
          firstMessage: existing.firstMessage || userMessage.content,
        }
      : session;
    bootstrap.snapshot.project = {
      ...bootstrap.snapshot.project,
      sessions: existing
        ? bootstrap.snapshot.project.sessions.map((candidate) => candidate.path === sessionPath ? nextSession : candidate)
        : [session, ...bootstrap.snapshot.project.sessions],
    };
  }

  if (
    bootstrap.snapshot.conversation.sessionFile === sessionPath &&
    (!bootstrap.snapshot.conversation.title || bootstrap.snapshot.conversation.title === "New session")
  ) {
    bootstrap.snapshot.conversation.title = title;
  }
}

/**
 * Mark every streaming answer done, keeping the durations this client observed.
 *
 * The transcript's own timestamps may not describe these turns yet, and an unknown
 * duration prints a different header than a known one — so the observed span is
 * carried here rather than dropped.
 */
export function settleStreamingMessages(
  bootstrap: BootstrapResponse,
  settledAt: number = Date.now(),
): PatchResult {
  return patchMessages(bootstrap, (message) => settleStreamingAnswer(message, settledAt) ?? message);
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

/**
 * 流里的全量快照与本地状态的合并。
 *
 * 两个不可省的细节：
 * - `pendingQueues`：快照带着 pi 的队列，所以这是唯一允许**移除**一条已不在队列里的
 *   插话的地方（用户按了停止）。
 * - `window`：快照只带尾部窗口，窗口之前的气泡这次没发——不告诉 `mergeChatBubbles`
 *   就会被当成"已删除"，用户翻出来的历史每收一次快照就消失一次。
 */
export function mergeStreamingBootstrap(
  current: BootstrapResponse,
  next: BootstrapResponse,
  sessionPath: string,
): BootstrapResponse {
  if (!isBootstrapForSession(current, sessionPath) || !isBootstrapForSession(next, sessionPath)) {
    return next;
  }

  const merged = mergeChatBubbles(
    current.snapshot.conversation.messages,
    next.snapshot.conversation.messages,
    {
      pendingQueues: next.pendingQueues,
      window: {
        hasMoreBefore: next.snapshot.conversation.hasMoreBefore,
        oldestTurn: next.snapshot.conversation.oldestTurn,
      },
    },
  );
  if (merged === next.snapshot.conversation.messages) {
    return next;
  }
  return withConversation(next, { ...next.snapshot.conversation, messages: merged });
}

/**
 * 往窗口**前面**接一页更早的历史。
 *
 * 气泡 id 是绝对的（`turnOffset` 保住了编号），所以直接接在前面即可。重复 id 以列表里
 * 已有的为准：分页边界可能重叠，而新取到的那页是更早的、不可能比本地更新。
 */
export function prependOlderMessages(
  bootstrap: BootstrapResponse,
  page: { messages: ChatMessage[]; oldestTurn: number; hasMoreBefore: boolean },
): BootstrapResponse {
  const conversation = bootstrap.snapshot.conversation;
  const known = new Set(conversation.messages.map((bubble) => bubble.id));
  const older = page.messages.filter((bubble) => !known.has(bubble.id));
  if (
    !older.length &&
    conversation.oldestTurn === page.oldestTurn &&
    conversation.hasMoreBefore === page.hasMoreBefore
  ) {
    return bootstrap;
  }
  return withConversation(bootstrap, {
    ...conversation,
    messages: [...older, ...conversation.messages],
    oldestTurn: page.oldestTurn,
    hasMoreBefore: page.hasMoreBefore,
  });
}
