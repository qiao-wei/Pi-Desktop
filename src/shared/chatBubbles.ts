/**
 * The single source of truth for how a pi transcript becomes chat bubbles.
 *
 * Both sides of the wire need this exact same answer:
 * - the server, when it renders a snapshot (`/api/bootstrap`) and when it tags
 *   streaming events with the bubble they belong to;
 * - the client, when it places an optimistic bubble and when it reconciles a
 *   snapshot against what it already rendered.
 *
 * Before this module existed the client *inferred* placement (append to the end
 * of the list, then match delivered events by comparing text). Any inference
 * mistake showed up as a mis-placed bubble, another turn's process blocks
 * leaking into a new bubble, or a stuck session view. Placement is now derived
 * from `bubbleId`, which both sides compute from the same rule:
 *
 *   one user transcript message opens one turn; every assistant/toolResult
 *   message until the next user message belongs to that turn's assistant bubble.
 *
 * So `chatBubbleId(turn, role)` is stable for the whole life of a bubble: the
 * optimistic placeholder, the streaming events, and the final snapshot all
 * address the same object.
 *
 * Pure module: no DOM, no node builtins, safe to import from server and web.
 */

import type {
  ChatAttachment,
  ChatMessage,
  ChatMessagePart,
  MessageProcessBlock,
  MessageRole,
} from "../types";
import {
  toolResultAsProcessBlock,
  toolResultDisplay,
  toolResultProcessTextWithCut,
} from "./chatToolBlocks.ts";
import { messageToText } from "./messageText.ts";
import { turnDurationOf } from "./chatTurnTiming.ts";
import { carryObservedAnswerTiming } from "./thinkingTiming.ts";
import {
  assistantMessageConversationView,
  type AssistantTextArchiveMode,
} from "./assistantMessageView.ts";

export { messageToText };

// 附件元数据解析住在 `attachmentContext.ts`；这里转出以保持既有 import。
export { ATTACHMENT_CONTEXT_END, ATTACHMENT_CONTEXT_START, messageDisplayText, parseAttachmentContext } from "./attachmentContext.ts";
export type { ParsedAttachmentContext } from "./attachmentContext.ts";

import { parseAttachmentContext } from "./attachmentContext.ts";

// 气泡身份与排序住在 `chatBubbleIds.ts`（协议性格式，与渲染无关）；这里转出以保持既有 import。
export {
  bubbleTurnOf,
  chatBubbleId,
  compareBubbleIds,
  parseChatBubbleId,
  parseProvisionalBubbleId,
  provisionalBubbleId,
} from "./chatBubbleIds.ts";
export type { ChatBubbleRef, ChatBubbleRole, ParsedProvisionalBubbleId } from "./chatBubbleIds.ts";

import {
  bubbleTurnOf,
  chatBubbleId,
  compareBubbleIds,
  parseChatBubbleId,
  parseProvisionalBubbleId,
  provisionalBubbleId,
} from "./chatBubbleIds.ts";
import type { ChatBubbleRef } from "./chatBubbleIds.ts";

/* -------------------------------------------------------------------------- */
/* Bubble identity                                                             */
/* -------------------------------------------------------------------------- */

export interface BubbleStats {
  turnCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  messageCount: number;
  lastMessageAt?: number;
}

/**
 * Conversation counters derived from the bubbles themselves. The server derives
 * the same numbers from the transcript, so a client patch and a snapshot agree.
 */
export function countBubbleStats(bubbles: readonly ChatMessage[]): BubbleStats {
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let lastMessageAt: number | undefined;
  for (const bubble of bubbles) {
    if (bubble.role === "user") {
      userMessageCount += 1;
    } else if (bubble.role === "assistant") {
      assistantMessageCount += 1;
    }
    if (lastMessageAt == null || bubble.createdAt > lastMessageAt) {
      lastMessageAt = bubble.createdAt;
    }
  }
  return {
    turnCount: userMessageCount,
    userMessageCount,
    assistantMessageCount,
    messageCount: bubbles.length,
    lastMessageAt,
  };
}

/** Number of user transcript messages, i.e. how many turns already exist. */
export function countTranscriptTurns(messages: readonly { role: MessageRole | string }[]): number {
  let turns = 0;
  for (const message of messages) {
    if (message.role === "user") {
      turns += 1;
    }
  }
  return turns;
}

export interface BubbleTracker {
  /** Tell the tracker a transcript message started; returns its bubble. */
  messageStarted(role: MessageRole | string): ChatBubbleRef | null;
  /** Bubble that in-flight text/tool/process events belong to. */
  currentAssistant(): ChatBubbleRef | null;
  /** Bubble the next user message will open (used to pre-plan optimistic ids). */
  nextTurn(): number;
}

/**
 * Streaming counterpart of {@link buildChatBubbles}: walks the same transcript
 * the loop is producing and keeps the turn counter, so events tagged here get
 * byte-identical ids to the snapshot built afterwards.
 */
export function createBubbleTracker(initialTurns = 0): BubbleTracker {
  let turn = initialTurns;
  let assistantTurn: number | null = null;

  return {
    messageStarted(role) {
      if (role === "user") {
        turn += 1;
        assistantTurn = null;
        return { bubbleId: chatBubbleId(turn, "user"), turn, role: "user" };
      }
      if (role === "assistant") {
        // A steer can be injected after the assistant bubble of the turn was
        // already closed; the next assistant message then still belongs to the
        // turn opened by the most recent user message.
        assistantTurn = turn;
        return { bubbleId: chatBubbleId(turn, "assistant"), turn, role: "assistant" };
      }
      // toolResult and friends keep flowing into the open assistant bubble.
      return assistantTurn === null ? null : { bubbleId: chatBubbleId(assistantTurn, "assistant"), turn: assistantTurn, role: "assistant" };
    },
    currentAssistant() {
      if (assistantTurn === null) {
        return null;
      }
      return { bubbleId: chatBubbleId(assistantTurn, "assistant"), turn: assistantTurn, role: "assistant" };
    },
    nextTurn() {
      return turn + 1;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Transcript -> bubbles                                                       */
/* -------------------------------------------------------------------------- */

export interface TranscriptMessage {
  role: MessageRole | string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /**
   * pi's tool-specific payload (`edit` puts its unified patch here). The server
   * forwards transcript messages untouched, so it is on the wire even though the
   * renderer used to ignore it. `structuredContent` (live events only) is not
   * part of the stored message.
   */
  details?: unknown;
}

export interface BuildChatBubblesOptions {
  isStreaming: boolean;
  /** Stamp for the synthetic streaming placeholder. */
  now?: number;
  /** Server supplies the fetchable attachment view; defaults to passing metadata through. */
  toAttachment?: (attachment: ChatAttachment) => ChatAttachment;
  /**
   * Turn number of the message *before* `messages[0]`, so a **window** of the
   * transcript keeps the same bubble ids as the whole thing.
   *
   * 这是窗口化历史的前提：气泡身份是 `t{turn}#role`，如果从中间截一段就从 1 重新编号，
   * 客户端会认为"整段历史被换掉了"（全部 remount、滚动位置丢失），而且正在流的那条事件
   * 会落到错的气泡上。所以窗口只截内容，编号仍按整份转录数。
   */
  turnOffset?: number;
}

/**
 * Group a pi transcript into the bubbles the UI renders.
 *
 * `id` comes from {@link chatBubbleId}, so the same transcript always yields the
 * same ids no matter how the client got here.
 */
export function buildChatBubbles(
  messages: readonly TranscriptMessage[],
  options: BuildChatBubblesOptions,
): ChatMessage[] {
  const bubbles: ChatMessage[] = [];
  const toAttachment = options.toAttachment ?? ((attachment: ChatAttachment) => attachment);
  let pendingTurn: TranscriptMessage[] = [];
  /** The question's timestamp: `pendingTurn` starts only *after* it. */
  let turnStartedAt = 0;
  let turn = options.turnOffset ?? 0;

  const flushTurn = () => {
    if (!pendingTurn.length) {
      return;
    }

    const turnNumber = turn;
    const assistantMessages = pendingTurn.filter((message) => message.role === "assistant");
    if (assistantMessages.length) {
      const processBlocks: MessageProcessBlock[] = [];
      const toolBlocks = new Map<string, Extract<MessageProcessBlock, { kind: "tool" }>>();
      let finalContent = "";
      let createdAt = Number(pendingTurn[0].timestamp ?? 0);
      const lastToolEventIndex = findLastToolEventIndex(pendingTurn);

      for (let index = 0; index < pendingTurn.length; index += 1) {
        const message = pendingTurn[index];

        if (message.role === "assistant") {
          createdAt = Math.min(createdAt, Number(message.timestamp ?? createdAt));
          const view = assistantMessageConversationView(
            message.content,
            assistantTextArchiveMode(message, index, lastToolEventIndex),
          );
          for (const block of view.processBlocks) {
            processBlocks.push(block);
            if (block.kind === "tool") {
              toolBlocks.set(block.toolCallId, block);
            }
          }

          if (view.text) {
            finalContent = view.text;
          }

          let lookahead = index + 1;
          while (lookahead < pendingTurn.length && pendingTurn[lookahead].role === "toolResult") {
            const toolResult = pendingTurn[lookahead];
            const existing = toolResult.toolCallId ? toolBlocks.get(toolResult.toolCallId) : undefined;
            if (existing) {
              const result = toolResultProcessTextWithCut(toolResult);
              existing.resultText = result.text;
              existing.resultTruncated = result.cut ?? undefined;
              existing.display = toolResultDisplay(existing, toolResult);
              existing.status = "done";
              existing.isError = Boolean(toolResult.isError);
            } else {
              const block = toolResultAsProcessBlock(toolResult);
              processBlocks.push(block);
              toolBlocks.set(block.toolCallId, block);
            }
            lookahead += 1;
          }

          index = lookahead - 1;
          continue;
        }

        if (message.role === "toolResult") {
          const existing = message.toolCallId ? toolBlocks.get(message.toolCallId) : undefined;
          if (existing) {
            const result = toolResultProcessTextWithCut(message);
            existing.resultText = result.text;
            existing.resultTruncated = result.cut ?? undefined;
            existing.display = toolResultDisplay(existing, message);
            existing.status = "done";
            existing.isError = Boolean(message.isError);
          } else {
            const block = toolResultAsProcessBlock(message);
            processBlocks.push(block);
            toolBlocks.set(block.toolCallId, block);
          }
        }
      }

      bubbles.push({
        id: chatBubbleId(turnNumber, "assistant"),
        role: "assistant",
        kind: "text",
        content: finalContent,
        processBlocks,
        createdAt,
        // The question is not in `pendingTurn`, so it is prepended here — otherwise a
        // turn with a single answer entry measures one point and has no duration.
        turnDurationMs: turnDurationOf([{ timestamp: turnStartedAt }, ...pendingTurn]),
        status: "done",
      });
    }

    pendingTurn = [];
  };

  for (const message of messages) {
    if (message.role === "user") {
      flushTurn();
      turn += 1;
      turnStartedAt = Number(message.timestamp ?? 0);
      const parsed = parseAttachmentContext(messageToText(message));
      bubbles.push({
        id: chatBubbleId(turn, "user"),
        role: "user",
        kind: "text",
        content: parsed.text,
        attachments: parsed.attachments.map(toAttachment),
        contentParts: parsed.messageParts,
        createdAt: Number(message.timestamp ?? 0),
        status: "done",
      });
      continue;
    }

    pendingTurn.push(message);
  }

  flushTurn();

  if (options.isStreaming && bubbles.length) {
    // The run is still going, so the newest turn's answer is incomplete. Tag it
    // `streaming` in place - and when only the question has landed yet, open the
    // answer bubble of *that* turn - so the stream and the snapshot address the
    // same object instead of racing two placeholders.
    const lastBubble = bubbles[bubbles.length - 1];
    const openTurn = parseChatBubbleId(lastBubble.id)?.turn;
    if (openTurn == null) {
      return bubbles;
    }
    if (lastBubble.role === "user") {
      bubbles[bubbles.length - 1] = lastBubble;
      bubbles.push({
        id: chatBubbleId(openTurn, "assistant"),
        role: "assistant",
        kind: "text",
        content: "",
        processBlocks: [],
        createdAt: options.now ?? lastBubble.createdAt,
        status: "streaming",
      });
    } else {
      bubbles[bubbles.length - 1] = { ...lastBubble, status: "streaming" };
    }
  }

  return bubbles;
}

/* -------------------------------------------------------------------------- */
/* Assistant message shaping (moved out of the server, unchanged semantics)     */
/* -------------------------------------------------------------------------- */

function findLastToolEventIndex(messages: readonly TranscriptMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "toolResult" || (message.role === "assistant" && assistantHasToolCall(message))) {
      return index;
    }
  }
  return -1;
}

function assistantTextArchiveMode(
  message: TranscriptMessage,
  index: number,
  lastToolEventIndex: number,
): AssistantTextArchiveMode {
  if (lastToolEventIndex < 0) {
    return "final";
  }
  if (index < lastToolEventIndex) {
    return "process";
  }
  if (index === lastToolEventIndex && assistantHasToolCall(message)) {
    return "split-at-last-tool";
  }
  return "final";
}

function assistantHasToolCall(message: TranscriptMessage | undefined): boolean {
  const content = message?.content;
  return Array.isArray(content) && content.some((block) => block?.type === "toolCall");
}

/* -------------------------------------------------------------------------- */
/* Placement: "where does this bubble go", derived from its id only            */
/* -------------------------------------------------------------------------- */

/** Id of a bubble that only exists locally until the server confirms it. */
/** A provisional bubble waiting for the server to confirm turn {@link turn}. */
export function isProvisionalForTurn(bubble: ChatMessage, turn: number): boolean {
  const parsed = bubble.provisional ? parseProvisionalBubbleId(bubble.id) : null;
  return Boolean(parsed?.predictedTurn === turn);
}

export interface ProvisionalTurn {
  /** The optimistic question bubble, in its provisional identity. */
  userMessage: ChatMessage;
  /** Placeholder answer, only for a submission that starts a run right now. */
  assistantMessage: ChatMessage | null;
}

export interface CreateProvisionalTurnOptions {
  clientMessageId: string;
  /** Text the user submitted (already rendered, without attachment metadata). */
  content: string;
  attachments?: ChatAttachment[];
  contentParts?: ChatMessagePart[];
  /** Also place the assistant bubble, for a submission that starts a run now. */
  withAssistant?: boolean;
  /**
   * This submission is a 插话: its bubble mirrors an entry in pi's queue, so
   * {@link syncProvisionalQueue} may drop it when the queue no longer holds it.
   * A direct submission (prompt / edit) leaves this unset and survives a queue
   * sync.
   */
  queued?: boolean;
  /**
   * Turn ordinal to predict instead of the next free one. An edit re-sends an
   * existing turn, so it must guess that same ordinal - `nextTurnEstimate` would
   * guess one past the end of the list.
   */
  predictedTurn?: number;
  now?: number;
}

/**
 * Place the bubbles of a submission the server has not acknowledged yet.
 *
 * They carry `provisional` plus the `clientMessageId` that lets the caller roll
 * them back, and they keep a `prov:` id until a server event confirms the turn
 * ordinal — a wrong guess can then never silently write into a real bubble.
 */
export function createProvisionalTurn(
  bubbles: readonly ChatMessage[],
  options: CreateProvisionalTurnOptions,
): { bubbles: ChatMessage[]; turn: ProvisionalTurn } {
  const now = options.now ?? Date.now();
  const predictedTurn = options.predictedTurn ?? nextTurnEstimate(bubbles);
  const userBubble: ChatMessage = {
    id: provisionalBubbleId(options.clientMessageId, "user", predictedTurn),
    role: "user",
    kind: "text",
    content: options.content,
    attachments: options.attachments,
    contentParts: options.contentParts,
    createdAt: now,
    status: "done",
    provisional: true,
    clientMessageId: options.clientMessageId,
    ...(options.queued ? { queued: true } : {}),
  };
  const answerBubble: ChatMessage | null = options.withAssistant
    ? {
        id: provisionalBubbleId(options.clientMessageId, "assistant", predictedTurn),
        role: "assistant",
        kind: "text",
        content: "",
        processBlocks: [],
        createdAt: now,
        status: "streaming",
        provisional: true,
        clientMessageId: options.clientMessageId,
      }
    : null;

  // Provisional bubbles sort last: by definition they are the newest turns.
  const next = [...bubbles, ...(answerBubble ? [userBubble, answerBubble] : [userBubble])];
  return { bubbles: next, turn: { userMessage: userBubble, assistantMessage: answerBubble } };
}

/**
 * Re-send an existing turn optimistically: the edited turn and everything after
 * it are replaced by a provisional copy of that same turn.
 *
 * This mirrors what the server does (`navigateTree` moves the leaf to turn N-1,
 * so turn N and later are gone from the branch) and it is what makes an edit feel
 * like a composer submit: the new text and the streaming placeholder are on screen
 * before the first byte comes back. The rewind snapshot agrees with it, and the
 * stream's `tN#...` events claim the placeholders.
 */
export function replaceTurnWithProvisional(
  bubbles: readonly ChatMessage[],
  options: CreateProvisionalTurnOptions & { turn: number },
): ChatMessage[] {
  const kept = bubbles.filter((bubble) => {
    const turn = bubbleTurnOf(bubble.id);
    if (turn != null) {
      return turn < options.turn;
    }
    // A provisional bubble has no turn in its id until it is claimed, and a
    // submission always targets the tail, so every one of them is newer.
    return !bubble.provisional;
  });
  const { bubbles: next } = createProvisionalTurn(kept, {
    ...options,
    predictedTurn: options.turn,
    withAssistant: options.withAssistant ?? true,
  });
  return next;
}

/** Everything of a submission that the UI still shows locally. */
export function provisionalBubblesOf(bubbles: readonly ChatMessage[], clientMessageId: string): ChatMessage[] {
  return bubbles.filter((bubble) => bubble.clientMessageId === clientMessageId);
}

export function isProvisionalBubble(bubble: ChatMessage | undefined): boolean {
  return bubble?.provisional === true;
}

/**
 * Turn the next submission will get. Provisional user bubbles are counted too:
 * a run plus a queued 插话 are two turns apart even while neither is confirmed,
 * and if both guessed the same number the second one's confirm event would be
 * free to rename the first one's placeholder.
 */
export function nextTurnEstimate(bubbles: readonly ChatMessage[]): number {
  const provisionalUsers = bubbles.filter(
    (bubble) => bubble.provisional && bubble.role === "user",
  ).length;
  return lastConfirmedTurn(bubbles) + provisionalUsers + 1;
}

/** Highest turn the server has already placed in this list. */
export function lastConfirmedTurn(bubbles: readonly ChatMessage[]): number {
  let turn = 0;
  for (const bubble of bubbles) {
    const parsed = parseChatBubbleId(bubble.id);
    if (parsed && !bubble.provisional) {
      turn = Math.max(turn, parsed.turn);
    }
  }
  return turn;
}

/**
 * Index a bubble belongs at: just before the first bubble that sorts after it.
 * Legacy ids with no turn in them never block an insert, so confirmed bubbles
 * always win the position the transcript says they have.
 */
export function bubbleInsertIndex(bubbles: readonly ChatMessage[], bubbleId: string): number {
  for (let index = 0; index < bubbles.length; index += 1) {
    if (compareBubbleIds(bubbles[index].id, bubbleId) > 0) {
      return index;
    }
  }
  return bubbles.length;
}

/**
 * Finish every answer that a *newer* turn has already left behind.
 *
 * Only one bubble may be "正在生成" at a time: once the server opens turn N, the
 * answer of turn N-1 is over even if its `done` event is still in flight. Without
 * this, a queued 插话 that starts answering leaves the previous answer's loading
 * dot burning next to its own.
 */
export function closeEarlierStreamingAssistants(
  bubbles: readonly ChatMessage[],
  turn: number,
): ChatMessage[] {
  let changed = false;
  const next = bubbles.map((bubble) => {
    if (bubble.role !== "assistant" || bubble.status !== "streaming") {
      return bubble;
    }
    const parsed = parseChatBubbleId(bubble.id);
    const bubbleTurn = parsed?.turn ?? parseProvisionalBubbleId(bubble.id)?.predictedTurn;
    if (bubbleTurn == null || bubbleTurn >= turn) {
      return bubble;
    }
    changed = true;
    return { ...bubble, status: "done" as const };
  });
  return changed ? next : (bubbles as ChatMessage[]);
}

/**
 * Remove provisional bubbles whose slot a confirmed bubble already filled.
 *
 * A snapshot can contain a turn the client has an optimistic placeholder for,
 * and matching by id alone would keep both side by side - the placeholder never
 * gets an event of its own again, so it would sit there as a duplicate answer.
 */
export function sweepSettledProvisionals(bubbles: readonly ChatMessage[]): ChatMessage[] {
  const settledSlots = new Set<string>();
  for (const bubble of bubbles) {
    if (!bubble.provisional) {
      const parsed = parseChatBubbleId(bubble.id);
      if (parsed) {
        settledSlots.add(`${bubble.role}:${parsed.turn}`);
      }
    }
  }
  if (!settledSlots.size) {
    return bubbles as ChatMessage[];
  }
  const kept = bubbles.filter((bubble) => {
    if (!bubble.provisional) {
      return true;
    }
    const predicted = parseProvisionalBubbleId(bubble.id)?.predictedTurn;
    return predicted == null || !settledSlots.has(`${bubble.role}:${predicted}`);
  });
  return kept.length === bubbles.length ? (bubbles as ChatMessage[]) : kept;
}

/** Insert or replace by id, keeping the list in transcript order. */
export function upsertBubble(
  bubbles: readonly ChatMessage[],
  bubble: ChatMessage,
  combine: (incoming: ChatMessage, local: ChatMessage) => ChatMessage = (incoming) => incoming,
): ChatMessage[] {
  const existingIndex = bubbles.findIndex((candidate) => candidate.id === bubble.id);
  if (existingIndex >= 0) {
    const existing = bubbles[existingIndex];
    const resolved = combine(bubble, existing);
    if (resolved === existing) {
      // Nothing changed: hand back the caller's array so React can bail out.
      return bubbles as ChatMessage[];
    }
    const next = [...bubbles];
    next[existingIndex] = resolved;
    return next;
  }

  // A confirmed bubble settles its slot, so any provisional still guessing at
  // the same turn is redundant by definition - drop it instead of letting it
  // linger as a placeholder the server has already answered.
  const settled = parseChatBubbleId(bubble.id);
  const source =
    settled && !bubble.provisional
      ? bubbles.filter(
          (candidate) =>
            !(
              candidate.provisional &&
              candidate.role === bubble.role &&
              isProvisionalForTurn(candidate, settled.turn)
            ),
        )
      : bubbles;

  const insertAt = bubbleInsertIndex(source, bubble.id);
  return [...source.slice(0, insertAt), bubble, ...source.slice(insertAt)];
}

/**
 * Turn the bubble the server just announced into the bubble the user already
 * sees. Prefers an exact id match (the usual case, because the client predicts
 * `chatBubbleId(nextTurn, role)`), and falls back to claiming the oldest
 * provisional bubble of the same role, which mirrors pi draining its steering
 * queue one at a time and in order.
 *
 * Returns `null` when nothing can be claimed, so the caller knows to create the
 * bubble from the event instead of renaming a guess.
 */
export function claimProvisionalBubble(
  bubbles: readonly ChatMessage[],
  ref: ChatBubbleRef,
  patch: Partial<ChatMessage> = {},
): { bubbles: ChatMessage[]; claimed: ChatMessage } | null {
  const exactIndex = bubbles.findIndex(
    (bubble) => bubble.id === ref.bubbleId && bubble.role === ref.role,
  );
  if (exactIndex >= 0) {
    const claimed = { ...bubbles[exactIndex], ...patch, id: ref.bubbleId, provisional: false };
    const next = [...bubbles];
    next[exactIndex] = claimed;
    return { bubbles: next, claimed };
  }

  const candidates = bubbles
    .map((bubble, index) => ({ bubble, index }))
    .filter(({ bubble }) => isProvisionalBubble(bubble) && bubble.role === ref.role);
  // The provisional that predicted this exact turn wins. Otherwise take the
  // oldest guess that is not newer than it - pi drains its queue one at a time,
  // so an earlier guess is the one being confirmed, while a later guess belongs
  // to another submission that must not be renamed into this slot.
  const match =
    candidates.find(({ bubble }) => isProvisionalForTurn(bubble, ref.turn)) ??
    candidates.find(({ bubble }) => {
      const predicted = parseProvisionalBubbleId(bubble.id)?.predictedTurn;
      return predicted == null || predicted <= ref.turn;
    });
  if (!match) {
    return null;
  }
  const claimIndex = match.index;

  const claimed: ChatMessage = {
    ...bubbles[claimIndex],
    ...patch,
    id: ref.bubbleId,
    provisional: false,
  };
  const withoutClaimed = [...bubbles.slice(0, claimIndex), ...bubbles.slice(claimIndex + 1)];
  const insertAt = bubbleInsertIndex(withoutClaimed, ref.bubbleId);
  const next = [
    ...withoutClaimed.slice(0, insertAt),
    claimed,
    ...withoutClaimed.slice(insertAt),
  ];
  return { bubbles: next, claimed };
}

export interface PendingQueueState {
  steering?: string[];
  followUp?: string[];
  /**
   * Monotonic per-session sequence of the queue snapshot. A `queued` event that
   * is older than what the client already applied must be ignored: pi emits one
   * queue_update per mutation and the ack write repeats it, so without the
   * sequence a late duplicate would resurrect a 插话 that was already delivered.
   */
  seq?: number;
}

/**
 * Bring the local 插话 bubbles in line with pi's queue.
 *
 * pi owns the queue, so it decides *how many* queued instructions there are and
 * what text they hold. `allowDrop` separates the two moments we care about:
 *
 * - a `queue_update` only ever adds: pi removes an entry the instant before it
 *   emits that message, so dropping on shrink would blink the bubble away one
 *   event before it gets confirmed;
 * - a snapshot / stop response is a full sync: anything the queue no longer
 *   holds was cleared by a stop (or delivered elsewhere) and must not linger as
 *   a ghost of a message the model never received.
 *
 * Only `queued` provisional bubbles are pi's queue: a direct submission (prompt
 * or edit) is provisional too, but a snapshot must never sweep it away before
 * the stream confirms it. That was the "badge disappears right after an edit"
 * bug - the edit's rewind snapshot arrived with an empty queue and deleted the
 * optimistic turn, so the following `user_message_start` rebuilt the bubble from
 * text alone.
 */
export function syncProvisionalQueue(
  bubbles: readonly ChatMessage[],
  queues: PendingQueueState,
  options: { allowDrop?: boolean; now?: number; appliedSeq?: number } = {},
): ChatMessage[] {
  if (
    !options.allowDrop &&
    queues.seq != null &&
    options.appliedSeq != null &&
    queues.seq <= options.appliedSeq
  ) {
    // Stale queue snapshot.
    return bubbles as ChatMessage[];
  }
  const queued = [...(queues.steering ?? []), ...(queues.followUp ?? [])];
  let next = bubbles as ChatMessage[];

  const provisional = next.filter(
    (bubble) => isProvisionalBubble(bubble) && bubble.role === "user" && bubble.queued === true,
  );
  if (options.allowDrop && provisional.length > queued.length) {
    const surplus = new Set(provisional.slice(0, provisional.length - queued.length).map((bubble) => bubble.id));
    next = next.filter((bubble) => !surplus.has(bubble.id));
  }

  const missing = queued.length - provisional.length;
  if (missing <= 0) {
    return next;
  }

  const now = options.now ?? Date.now();
  const baseTurn = nextTurnEstimate(next) - 1;
  const additions = queued.slice(queued.length - missing).map((text, index): ChatMessage => {
    const clientMessageId = `queue:${now}:${index}`;
    return {
      id: provisionalBubbleId(clientMessageId, "user", baseTurn + 1 + index),
      role: "user",
      kind: "text",
      content: text,
      createdAt: now,
      status: "done",
      provisional: true,
      clientMessageId,
      queued: true,
    };
  });
  return [...next, ...additions];
}

/** Drop the optimistic bubbles of a submission that never made it to the model. */
export function discardProvisionalTurn(
  bubbles: readonly ChatMessage[],
  clientMessageId: string,
): ChatMessage[] {
  if (!bubbles.some((bubble) => bubble.clientMessageId === clientMessageId)) {
    // Nothing to roll back: keep the caller's identity so React can skip.
    return bubbles as ChatMessage[];
  }
  return bubbles.filter((bubble) => bubble.clientMessageId !== clientMessageId);
}

export interface MergeChatBubblesOptions {
  /**
   * `incoming` 是一段尾部窗口时传入。**没有它，窗口滑动就等于删历史**：
   * 合并的默认规则是"本地有、快照没有 = 已被取代"，而窗口外的气泡服务端根本没发。
   */
  window?: { hasMoreBefore?: boolean; oldestTurn?: number };
  /**
   * How to reconcile the snapshot bubble with the local bubble of the same id.
   * Defaults to {@link keepAheadOfSnapshot}, which lets a stream that ran ahead
   * of the snapshot survive a reconcile.
   */
  combine?: (incoming: ChatMessage, local: ChatMessage) => ChatMessage;
  /** pi's queue, when the snapshot carries it: makes the sync authoritative. */
  pendingQueues?: PendingQueueState;
  now?: number;
}

/**
 * Reconcile a snapshot into what is already rendered.
 *
 * This replaces the old "refuse to reconcile while a 插话 is pending" gate: a
 * snapshot is always applied, and local-only work (provisional bubbles plus an
 * answer that is still streaming) is re-attached instead of being thrown away.
 * That is what removes both the blank-then-pop appearance and the mis-placed
 * steering bubble.
 */
export function mergeChatBubbles(
  local: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
  options: MergeChatBubblesOptions = {},
): ChatMessage[] {
  const combine = options.combine ?? keepAheadOfSnapshot;
  const incomingIds = new Set(incoming.map((bubble) => bubble.id));
  let merged = [...incoming];

  for (let index = 0; index < incoming.length; index += 1) {
    const next = incoming[index];
    const previous = local.find((candidate) => candidate.id === next.id);
    if (previous) {
      merged[index] = combine(next, previous);
    }
  }

  const windowStartTurn = options.window?.hasMoreBefore ? options.window.oldestTurn : undefined;

  for (const bubble of local) {
    if (incomingIds.has(bubble.id)) {
      continue;
    }
    // 窗口外的历史：服务端这次压根没发，不是"被删了"。保留它（含已落定的气泡），
    // 否则每收到一次快照，用户辛苦翻出来的旧历史就会消失，滚动位置也跟着跳。
    const turn = bubbleTurnOf(bubble.id);
    if (windowStartTurn != null && turn != null && turn < windowStartTurn) {
      merged = upsertBubble(merged, bubble, combine);
      continue;
    }
    // Anything else is superseded by the transcript; only work that has not
    // landed there yet may stay, and it stays in transcript order.
    if (!isProvisionalBubble(bubble) && bubble.status !== "streaming") {
      continue;
    }
    merged = upsertBubble(merged, bubble, combine);
  }

  // Locals that the snapshot has already answered are placeholders, not news.
  merged = sweepSettledProvisionals(merged);

  if (options.pendingQueues) {
    merged = syncProvisionalQueue(merged, options.pendingQueues, {
      allowDrop: true,
      now: options.now,
    });
  }

  return sameBubbleList(local, merged) ? (local as ChatMessage[]) : merged;
}

/**
 * Default conflict rule: the snapshot is the truth about *structure*, the stream
 * may be ahead about *content* of the bubble it is currently writing.
 */
export function keepAheadOfSnapshot(incoming: ChatMessage, local: ChatMessage): ChatMessage {
  if (incoming.role !== "assistant" || local.role !== "assistant") {
    return incoming;
  }
  if (incoming.status === "done") {
    // The snapshot is the truth about content, but not about timing.
    return carryObservedAnswerTiming(incoming, local);
  }
  if (local.content.length <= incoming.content.length && !(local.processBlocks?.length ?? 0)) {
    return incoming;
  }
  return {
    ...incoming,
    content: local.content.length > incoming.content.length ? local.content : incoming.content,
    processBlocks: local.processBlocks?.length
      ? (local.processBlocks as MessageProcessBlock[])
      : incoming.processBlocks,
    liveBlocks: local.liveBlocks ?? incoming.liveBlocks,
    status: local.status === "streaming" ? "streaming" : incoming.status,
    // A snapshot taken right after the run can still describe the *question* only, so
    // keep the span we watched: otherwise the newest turn is the one without a time.
    turnDurationMs: incoming.turnDurationMs ?? local.turnDurationMs,
  };
}

function sameBubbleList(left: readonly ChatMessage[], right: readonly ChatMessage[]): boolean {
  return left.length === right.length && left.every((bubble, index) => bubble === right[index]);
}

/**
 * Thinking blocks of a streaming assistant message, in wire format.
 *
 * `streamKeyOf` is called with pi's own *content* index, so the key survives
 * interleaved text/tool blocks and matches the key on the `thinking_delta`
 * events of the same block. The original index is preserved (not the ordinal
 * among thinking blocks) for exactly that reason.
 *
 * Only ever call this on a *closing* snapshot: `partial` is mutated in place by
 * the provider, so text read at any earlier edge is a torn view of deltas that
 * have not been sent yet.
 */
export function assistantThinkingBlocks(
  content: readonly { type?: string; thinking?: string }[],
  streamKeyOf?: (contentIndex: number) => string,
): { type: "thinking"; thinking: string; streamKey?: string }[] {
  return content.flatMap((block, contentIndex) =>
    block?.type === "thinking"
      ? [
          {
            type: "thinking" as const,
            thinking: block.thinking ?? "",
            ...(streamKeyOf ? { streamKey: streamKeyOf(contentIndex) } : {}),
          },
        ]
      : [],
  );
}

