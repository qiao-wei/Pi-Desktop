/**
 * The one place that turns the server's NDJSON stream into conversation state.
 *
 * The rule it encodes is deliberately boring: *every* event says which bubble
 * it belongs to (`bubbleId`, computed by the server with the same
 * `chatBubbleId(turn, role)` the snapshot builder uses), and this module only
 * ever addresses bubbles by that id. Nothing is inferred from arrival order,
 * message text, or "the last message in the list".
 *
 * That replaces the previous inline chain in `usePiDesktopApp`, which appended
 * optimistic bubbles to the end of the list and then tried to recognise them
 * again by comparing `user_message_start.content` with the raw input. Because
 * pi expands skill commands and prompt templates before it queues a steering
 * message, that comparison fails for perfectly ordinary 插话, and every
 * downstream guess got worse: the answer of the previous turn leaked into a new
 * bubble, and a pending-steering guard then suppressed snapshot reconciliation
 * until the whole run ended.
 *
 * Events whose bubble cannot be addressed are dropped and counted, never
 * re-homed: showing one bubble late is recoverable, writing into the wrong one
 * is not. `mergeChatBubbles` brings the dropped content back on the next
 * reconcile.
 */

import type { PromptStreamEvent, StreamProcessBlock } from "../lib/api";
import type { ChatMessage, MessageProcessBlock } from "../types";
import {
  chatBubbleId,
  claimProvisionalBubble,
  closeEarlierStreamingAssistants,
  isProvisionalBubble,
  parseChatBubbleId,
  syncProvisionalQueue,
  upsertBubble,
  type ChatBubbleRef,
  type PendingQueueState,
} from "./chatBubbles.ts";
import {
  appendLiveTextBlock,
  appendLiveThinkingBlock,
  appendLiveToolCallArgsText,
  appendToolCallArgsText,
  closeOpenThinkingBlocks,
  mergeAssistantProcessBlocks,
  mergeLiveProcessBlocks,
  upsertLiveToolBlock,
  upsertToolProcessBlock,
} from "./chatProcessBlocks.ts";

export interface ChatStreamView {
  /** Bubbles in transcript order, exactly as the UI renders them. */
  bubbles: ChatMessage[];
  /** Bubble the server is writing right now, or `null` between turns. */
  activeBubbleId: string | null;
  /** Events we could not address; surfaced as a diagnostic, not a guess. */
  droppedEvents: number;
  /** Last pi-queue sequence this view has applied. */
  queueSeq: number;
}

export function createChatStreamView(bubbles: readonly ChatMessage[] = [], queueSeq = 0): ChatStreamView {
  return { bubbles: [...bubbles], activeBubbleId: streamingBubbleId(bubbles), droppedEvents: 0, queueSeq };
}

/** The bubble a running stream writes into, recovered from a snapshot. */
export function streamingBubbleId(bubbles: readonly ChatMessage[]): string | null {
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    const bubble = bubbles[index];
    if (bubble.role === "assistant" && bubble.status === "streaming") {
      return bubble.id;
    }
  }
  return null;
}

/**
 * Apply one stream event. The result is a new view unless the event changed
 * nothing, in which case the incoming object is returned so React keeps the
 * message identities it already has.
 */
export function projectStreamEvent(view: ChatStreamView, event: PromptStreamEvent): ChatStreamView {
  switch (event.type) {
    case "user_message_start":
      return projectUserMessageStart(view, event);
    case "assistant_message_start":
      return projectAssistantMessageStart(view, event);
    case "delta":
      return projectDelta(view, event);
    case "assistant_partial":
      return projectProcessBlocks(view, event);
    case "thinking_delta":
      return projectThinkingDelta(view, event);
    case "tool_call_stream_start":
    case "tool_call_stream_delta":
    case "tool_call_stream_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return projectToolEvent(view, event);
    case "queued":
      return projectQueue(view, event);
    case "context_usage":
      // Usage never addresses a bubble; the hook folds it into `stats`. Dropping
      // it here must not count as an unaddressed event.
      return view;
    case "error":
    case "done":
      // The hook owns run lifecycle; the stream is over either way.
      return view.activeBubbleId === null ? view : { ...view, activeBubbleId: null };
    default:
      return view;
  }
}

/** Mark every open bubble finished once a run stops (done / error / stop). */
export function finalizeChatStreamView(view: ChatStreamView): ChatStreamView {
  const bubbles = view.bubbles.map((bubble) =>
    bubble.status === "streaming" && !isProvisionalBubble(bubble)
      ? { ...bubble, status: "done" as const }
      : bubble,
  );
  const unchanged = bubbles.every((bubble, index) => bubble === view.bubbles[index]);
  return {
    bubbles: unchanged ? view.bubbles : bubbles,
    activeBubbleId: null,
    droppedEvents: view.droppedEvents,
    queueSeq: view.queueSeq,
  };
}

/**
 * Reconcile the local optimistic 插话 bubbles with pi's queue.
 *
 * Additions only here - see `syncProvisionalQueue` for why a shrink must not
 * delete anything until a snapshot confirms it.
 */
export function projectQueueCounts(
  view: ChatStreamView,
  queues: PendingQueueState,
): ChatStreamView {
  const bubbles = syncProvisionalQueue(view.bubbles, queues, { appliedSeq: view.queueSeq });
  if (bubbles === view.bubbles && queues.seq == null) {
    return view;
  }
  return {
    ...view,
    bubbles,
    queueSeq: Math.max(view.queueSeq, queues.seq ?? view.queueSeq),
  };
}

/* -------------------------------------------------------------------------- */
/* Per-event projections                                                       */
/* -------------------------------------------------------------------------- */

function projectUserMessageStart(view: ChatStreamView, event: PromptStreamEvent): ChatStreamView {
  const ref = bubbleRefOf(event, "user");
  if (!ref) {
    return drop(view, event);
  }

  const claimed = claimProvisionalBubble(view.bubbles, ref, {
    content: event.content ?? "",
    status: "done",
  });
  const bubbles = claimed
    ? claimed.bubbles
    : upsertBubble(view.bubbles, {
        id: ref.bubbleId,
        role: "user",
        kind: "text",
        content: event.content ?? "",
        createdAt: Date.now(),
        status: "done",
      });

  // A user message only appears between turns, so nothing may keep writing into
  // the previous answer from here on - and its loading dot has to go with it.
  return {
    ...view,
    bubbles: closeEarlierStreamingAssistants(bubbles, ref.turn),
    activeBubbleId: null,
  };
}

function projectAssistantMessageStart(view: ChatStreamView, event: PromptStreamEvent): ChatStreamView {
  const ref = bubbleRefOf(event, "assistant");
  if (!ref) {
    return drop(view, event);
  }

  const existing = view.bubbles.find((bubble) => bubble.id === ref.bubbleId);
  // Re-open the bubble this turn owns: an existing one is revived in place, an
  // optimistic placeholder is renamed into its confirmed id, and only if neither
  // matches is a fresh bubble created at the position the id dictates.
  const opened = existing
    ? view.bubbles.map((bubble) =>
        bubble.id === ref.bubbleId
          ? { ...bubble, provisional: false, status: "streaming" as const }
          : bubble,
      )
    : (claimProvisionalBubble(view.bubbles, ref, { status: "streaming" })?.bubbles ??
      upsertBubble(view.bubbles, {
        id: ref.bubbleId,
        role: "assistant",
        kind: "text",
        content: "",
        processBlocks: [],
        createdAt: Date.now(),
        status: "streaming",
      }));

  return {
    ...view,
    bubbles: closeEarlierStreamingAssistants(opened, ref.turn),
    activeBubbleId: ref.bubbleId,
  };
}

function projectDelta(view: ChatStreamView, event: PromptStreamEvent): ChatStreamView {
  if (!event.delta) {
    return view;
  }
  const target = resolveTarget(view, event);
  if (!target) {
    return drop(view, event);
  }

  return rememberTarget(
    {
      ...view,
      bubbles: patchBubble(view.bubbles, target, emptyAssistantBubble, (bubble) => ({
        ...bubble,
        content: `${bubble.content}${event.delta ?? ""}`,
        liveBlocks: appendLiveTextBlock(bubble.liveBlocks ?? [], event.delta ?? ""),
        status: "streaming",
      })),
    },
    event,
  );
}

function projectProcessBlocks(view: ChatStreamView, event: PromptStreamEvent): ChatStreamView {
  const blocks = (event.blocks ?? []).map(normalizeProcessBlock).filter(Boolean) as MessageProcessBlock[];
  if (!blocks.length) {
    // A `thinking_end` snapshot can come out empty (a whitespace-only block).
    // Nothing to merge, but the panel still has to settle.
    return event.closeThinking ? closeOpenThinkingPanels(view, event) : view;
  }
  const target = resolveTarget(view, event);
  if (!target) {
    return drop(view, event);
  }

  return rememberTarget(
    {
      ...view,
      bubbles: patchBubble(view.bubbles, target, emptyAssistantBubble, (bubble) => {
        const processBlocks = mergeAssistantProcessBlocks(bubble.processBlocks ?? [], blocks);
        // Only a closing snapshot carries authoritative thinking text. The live
        // panel is delta-driven, and an opening snapshot can race ahead of those
        // deltas (see `assistantThinkingBlocks`) - merging its text in would seed
        // the block with content the deltas then append again, duplicating the
        // first chunk. Notices have no delta stream, so they always merge.
        const liveSnapshot = event.closeThinking
          ? blocks
          : blocks.filter((block) => block.kind !== "thinking");
        let liveBlocks = mergeLiveProcessBlocks(bubble.liveBlocks ?? [], liveSnapshot);
        // `thinking_end` is the only thing that settles a reasoning panel now: the
        // panel used to settle itself as soon as anything was appended after it.
        if (event.closeThinking) {
          liveBlocks = closeOpenThinkingBlocks(liveBlocks);
        }
        if (processBlocks === bubble.processBlocks && liveBlocks === bubble.liveBlocks) {
          return bubble;
        }
        return { ...bubble, processBlocks, liveBlocks };
      }),
    },
    event,
  );
}

function projectToolEvent(view: ChatStreamView, event: PromptStreamEvent): ChatStreamView {
  const target = resolveTarget(view, event);
  if (!target) {
    return drop(view, event);
  }
  const block = toToolProcessBlock(event);
  const streamedArgs = event.type === "tool_call_stream_delta" && typeof event.argsText === "string" && event.argsText !== "";

  return rememberTarget(
    {
      ...view,
      bubbles: patchBubble(view.bubbles, target, emptyAssistantBubble, (bubble) => {
        // Incremental arguments are appended as text so the typewriter advances per
        // token; the parsed `args` only exists at `tool_call_stream_end`, which
        // replaces the text with pretty-printed JSON.
        const processBlocks = streamedArgs
          ? appendToolCallArgsText(bubble.processBlocks ?? [], toolBlockOf(block), event.argsText ?? "")
          : upsertToolProcessBlock(bubble.processBlocks ?? [], block);
        const liveBlocks = streamedArgs
          ? appendLiveToolCallArgsText(bubble.liveBlocks ?? [], toolBlockOf(block), event.argsText ?? "")
          : upsertLiveToolBlock(bubble.liveBlocks ?? [], block);
        if (processBlocks === bubble.processBlocks && liveBlocks === bubble.liveBlocks) {
          return bubble;
        }
        return { ...bubble, processBlocks, liveBlocks };
      }),
    },
    event,
  );
}

/**
 * Streamed thinking, one token at a time. Everything else about a thinking block -
 * its place in the persisted list, the collapsed panel - is handled by the
 * `assistant_partial` the server sends once the block closes (`thinking_end`).
 */
function projectThinkingDelta(view: ChatStreamView, event: PromptStreamEvent): ChatStreamView {
  if (!event.delta) {
    return view;
  }
  const target = resolveTarget(view, event);
  if (!target) {
    return drop(view, event);
  }

  return rememberTarget(
    {
      ...view,
      bubbles: patchBubble(view.bubbles, target, emptyAssistantBubble, (bubble) => {
        const liveBlocks = appendLiveThinkingBlock(
          bubble.liveBlocks ?? [],
          event.delta ?? "",
          event.thinkingStreamKey,
        );
        if (liveBlocks === bubble.liveBlocks) {
          return bubble;
        }
        return { ...bubble, liveBlocks, status: "streaming" };
      }),
    },
    event,
  );
}

/**
 * Settle every still-open reasoning panel of the bubble an event addresses.
 *
 * The panel's "still thinking" flag is data (`open`), so `thinking_end` has to
 * clear it even when the closing snapshot carries no text at all.
 */
function closeOpenThinkingPanels(view: ChatStreamView, event: PromptStreamEvent): ChatStreamView {
  const target = resolveTarget(view, event);
  if (!target) {
    return drop(view, event);
  }

  let changed = false;
  const bubbles = view.bubbles.map((bubble) => {
    if (bubble.id !== target) {
      return bubble;
    }
    const liveBlocks = closeOpenThinkingBlocks(bubble.liveBlocks ?? []);
    if (liveBlocks === bubble.liveBlocks) {
      return bubble;
    }
    changed = true;
    return { ...bubble, liveBlocks };
  });

  return changed ? { ...view, bubbles } : view;
}

function toolBlockOf(block: MessageProcessBlock): Extract<MessageProcessBlock, { kind: "tool" }> {
  return block.kind === "tool" ? block : { kind: "tool", toolCallId: "", toolName: "tool", callText: "", status: "streaming" };
}

function projectQueue(view: ChatStreamView, event: PromptStreamEvent): ChatStreamView {
  return projectQueueCounts(view, event);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Bubble an event writes into. The server always names it; `activeBubbleId` is
 * only a fallback for events that were already in flight when the server tagged
 * a bubble differently (retry, compaction, an older server build).
 */
function resolveTarget(view: ChatStreamView, event: PromptStreamEvent): string | null {
  // The server names the bubble for every event; `activeBubbleId` only covers
  // events that were already in flight before this client learned the name.
  const named = parseChatBubbleId(event.bubbleId);
  return named?.bubbleId ?? view.activeBubbleId;
}

function bubbleRefOf(event: PromptStreamEvent, role: "user" | "assistant"): ChatBubbleRef | null {
  const ref = parseChatBubbleId(event.bubbleId);
  if (!ref || ref.role !== role) {
    return null;
  }
  if (event.turn != null && event.turn !== ref.turn) {
    return null;
  }
  return ref;
}

/**
 * Patch the bubble `bubbleId`, creating it from `create` when the stream jumped
 * ahead of any `*_message_start` we could confirm (a run may open with a tool
 * event). `bubbleId` is always server-authored, so creating here cannot put a
 * bubble in the wrong place: `upsertBubble` sorts by the turn inside the id.
 */
function patchBubble(
  bubbles: readonly ChatMessage[],
  bubbleId: string,
  create: (bubbleId: string) => ChatMessage | null,
  patch: (bubble: ChatMessage) => ChatMessage,
): ChatMessage[] {
  let list = bubbles as ChatMessage[];
  let index = list.findIndex((bubble) => bubble.id === bubbleId);

  if (index < 0) {
    // A stream may name a bubble without the `*_message_start` having reached us
    // (retry, older server). Claim the provisional placeholder first so the
    // answer the user is already looking at is the one that fills in.
    const ref = parseChatBubbleId(bubbleId);
    const claimed = ref ? claimProvisionalBubble(list, ref) : null;
    if (claimed) {
      list = claimed.bubbles;
      index = list.findIndex((bubble) => bubble.id === bubbleId);
    }
  }

  if (index < 0) {
    const created = create(bubbleId);
    return created ? upsertBubble(list, patch(created)) : list;
  }

  const current = list[index];
  const updated = patch(current);
  if (updated === current) {
    return list;
  }
  const next = [...list];
  next[index] = updated;
  return next;
}

function emptyAssistantBubble(bubbleId: string): ChatMessage | null {
  const ref = parseChatBubbleId(bubbleId);
  if (!ref || ref.role !== "assistant") {
    return null;
  }
  return {
    id: bubbleId,
    role: "assistant",
    kind: "text",
    content: "",
    processBlocks: [],
    createdAt: Date.now(),
    status: "streaming",
  };
}

/**
 * An event that names its bubble also teaches the view which bubble is live, so
 * a stream that started without an `assistant_message_start` (older server, or
 * an event that raced ahead of it) still keeps writing to one place.
 */
function rememberTarget(view: ChatStreamView, event: PromptStreamEvent): ChatStreamView {
  const named = parseChatBubbleId(event.bubbleId);
  if (!named || named.bubbleId === view.activeBubbleId || named.role !== "assistant") {
    return view;
  }
  return { ...view, activeBubbleId: named.bubbleId };
}

function drop(view: ChatStreamView, event: PromptStreamEvent): ChatStreamView {
  // Counted, not guessed: the next reconcile gets the real content from the
  // transcript. `bubbles` keeps its identity so the thread does not re-render.
  return { ...view, droppedEvents: view.droppedEvents + 1 };
}

function toToolProcessBlock(event: PromptStreamEvent): MessageProcessBlock {
  const done = event.type === "tool_execution_end";
  return {
    kind: "tool",
    // Deliberately *not* `|| event.toolStreamId`: a stream slot and a call id are
    // different identities, and faking one with the other makes the event that
    // finally carries the real id miss this block and open a duplicate card.
    toolCallId: event.toolCallId || "",
    toolStreamId: event.toolStreamId,
    toolName: event.toolName ?? "tool",
    callText: stringifyToolArgs(event.args),
    resultText:
      event.result === undefined
        ? event.partialResult === undefined
          ? undefined
          : stringifyValue(event.partialResult)
        : stringifyValue(event.result),
    status: done ? "done" : "streaming",
    isError: done ? event.isError : undefined,
  };
}

/** Wire block -> stored block (the wire keeps pi's `type` discriminant). */
export function normalizeProcessBlock(block: StreamProcessBlock | null | undefined): MessageProcessBlock | null {
  if (!block) {
    return null;
  }
  if (block.type === "thinking") {
    const text = block.thinking.trim();
    return text ? { kind: "thinking", text, streamKey: block.streamKey } : null;
  }
  if (block.type === "notice") {
    const text = block.notice.trim();
    return text ? { kind: "notice", text } : null;
  }
  return {
    kind: "tool",
    toolCallId: block.toolCallId,
    toolName: block.toolName || "tool",
    callText: stringifyToolArgs(block.arguments),
    status: "streaming",
  };
}

/**
 * Pretty-printed arguments, or nothing at all while the call has none yet.
 *
 * `tool_call_stream_start` carries an empty object, and `"{}"` in front of the
 * streamed argument text is visible garbage: the incremental deltas append after it.
 */
export function stringifyToolArgs(value: unknown): string {
  if (value == null || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)) {
    return "";
  }
  return stringifyValue(value);
}

export function stringifyValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/** Re-exported so callers can build ids for optimistic turns. */
export { chatBubbleId };
