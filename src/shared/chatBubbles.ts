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

/* -------------------------------------------------------------------------- */
/* Bubble identity                                                             */
/* -------------------------------------------------------------------------- */

export type ChatBubbleRole = "user" | "assistant";

export interface ChatBubbleRef {
  /** Stable identity, shared by server and client. */
  bubbleId: string;
  /** 1-based ordinal of the user message that opened this bubble. */
  turn: number;
  role: ChatBubbleRole;
}

/**
 * Ids are namespaced with `t<turn>#` so they can never collide with the legacy
 * `${timestamp}-${index}` ids (or with locally generated `msg_…` ids) that may
 * still be on screen from an older server build.
 */
export function chatBubbleId(turn: number, role: ChatBubbleRole): string {
  return `t${turn}#${role}`;
}

export function parseChatBubbleId(id: string | undefined): ChatBubbleRef | null {
  const match = /^t(\d+)#(user|assistant)$/u.exec(id ?? "");
  if (!match) {
    return null;
  }
  return { bubbleId: id as string, turn: Number(match[1]), role: match[2] as ChatBubbleRole };
}

/** Turn ordinal of the bubble a message belongs to, or `null` for foreign ids. */
export function bubbleTurnOf(id: string | undefined): number | null {
  return parseChatBubbleId(id)?.turn ?? null;
}

/**
 * Ordering key: bubbles sort by turn, and inside a turn the user message comes
 * before the assistant answer. This is what makes placement authoritative
 * instead of "whatever order the events happened to arrive in".
 *
 * Provisional bubbles take part with the turn they predicted, so confirming a
 * message cannot drop it *above* the placeholder answer that is still waiting
 * for its own turn (that is what used to draw the loading dot before the
 * question instead of after it). Within one slot a confirmed bubble sorts
 * before a guess at the same slot; ids we cannot parse at all stay last.
 */
export function compareBubbleIds(a: string | undefined, b: string | undefined): number {
  const left = bubbleOrder(a);
  const right = bubbleOrder(b);
  if (left.turn !== right.turn) {
    return left.turn < right.turn ? -1 : 1;
  }
  if (left.roleRank !== right.roleRank) {
    return left.roleRank - right.roleRank;
  }
  return left.confirmed - right.confirmed;
}

const UNPLACED_TURN = Number.POSITIVE_INFINITY;

interface BubbleOrder {
  turn: number;
  roleRank: number;
  /** 0 = the server placed it, 1 = still an optimistic guess. */
  confirmed: number;
}

function bubbleOrder(id: string | undefined): BubbleOrder {
  const settled = parseChatBubbleId(id);
  if (settled) {
    return { turn: settled.turn, roleRank: settled.role === "user" ? 0 : 1, confirmed: 0 };
  }
  const guess = parseProvisionalBubbleId(id ?? "");
  if (guess && guess.predictedTurn != null) {
    return { turn: guess.predictedTurn, roleRank: guess.role === "user" ? 0 : 1, confirmed: 1 };
  }
  return { turn: UNPLACED_TURN, roleRank: 0, confirmed: 1 };
}

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

export const ATTACHMENT_CONTEXT_START = "<pi_desktop_attachments>";
export const ATTACHMENT_CONTEXT_END = "</pi_desktop_attachments>";

export interface ParsedAttachmentContext {
  text: string;
  attachments: ChatAttachment[];
  messageParts: ChatMessagePart[];
}

export interface TranscriptMessage {
  role: MessageRole | string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface BuildChatBubblesOptions {
  isStreaming: boolean;
  /** Stamp for the synthetic streaming placeholder. */
  now?: number;
  /** Server supplies the fetchable attachment view; defaults to passing metadata through. */
  toAttachment?: (attachment: ChatAttachment) => ChatAttachment;
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
  let turn = 0;

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
              existing.resultText = toolResultProcessText(toolResult);
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
            existing.resultText = toolResultProcessText(message);
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
        status: "done",
      });
    }

    pendingTurn = [];
  };

  for (const message of messages) {
    if (message.role === "user") {
      flushTurn();
      turn += 1;
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

export function messageToText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      const typed = block as { type?: string; text?: string };
      if (typed.type === "text") return typed.text ?? "";
      if (typed.type === "image") return "[image]";
      return "";
    })
    .join("")
    .trim();
}

export function messageDisplayText(message: { content?: unknown }): string {
  return parseAttachmentContext(messageToText(message)).text;
}

export function parseAttachmentContext(text: string): ParsedAttachmentContext {
  const start = text.lastIndexOf(ATTACHMENT_CONTEXT_START);
  const end = text.lastIndexOf(ATTACHMENT_CONTEXT_END);
  if (start < 0 || end < start) {
    return { text, attachments: [], messageParts: [] };
  }

  try {
    const metadata = JSON.parse(text.slice(start + ATTACHMENT_CONTEXT_START.length, end).trim());
    return {
      text: String(metadata?.displayInput ?? text.slice(0, start)),
      attachments: Array.isArray(metadata?.attachments) ? metadata.attachments : [],
      messageParts: Array.isArray(metadata?.messageParts) ? metadata.messageParts : [],
    };
  } catch {
    return { text: text.slice(0, start), attachments: [], messageParts: [] };
  }
}

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

type AssistantTextArchiveMode = "final" | "process" | "split-at-last-tool";

function assistantHasToolCall(message: TranscriptMessage | undefined): boolean {
  return (
    Array.isArray(message?.content) &&
    (message?.content as { type?: string }[]).some((block) => block?.type === "toolCall")
  );
}

export function assistantMessageConversationView(
  content: unknown,
  textArchiveMode: AssistantTextArchiveMode = "final",
): { text: string; processBlocks: MessageProcessBlock[] } {
  if (!Array.isArray(content)) {
    return {
      text: typeof content === "string" ? content.trim() : "",
      processBlocks: [],
    };
  }

  const processBlocks: MessageProcessBlock[] = [];
  const blocks = content as {
    type?: string;
    thinking?: string;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  }[];
  const lastToolBlockIndex =
    textArchiveMode === "split-at-last-tool" ? lastToolCallBlockIndex(blocks) : -1;
  let finalText = "";

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block?.type === "thinking" && block.thinking?.trim()) {
      processBlocks.push({ kind: "thinking", text: block.thinking.trim() });
      continue;
    }

    if (block?.type === "toolCall") {
      processBlocks.push({
        kind: "tool",
        toolCallId: String(block.id ?? ""),
        toolName: String(block.name ?? "tool"),
        callText: JSON.stringify(block.arguments ?? {}, null, 2),
      });
      continue;
    }

    const text = assistantContentBlockText(block);
    if (!text) {
      continue;
    }

    if (shouldArchiveAssistantText(textArchiveMode, index, lastToolBlockIndex)) {
      pushNoticeProcessBlock(processBlocks, text);
    } else {
      finalText += text;
    }
  }

  return { text: finalText.trim(), processBlocks };
}

function lastToolCallBlockIndex(blocks: readonly { type?: string }[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.type === "toolCall") {
      return index;
    }
  }
  return -1;
}

function shouldArchiveAssistantText(
  mode: AssistantTextArchiveMode,
  blockIndex: number,
  lastToolBlockIndex: number,
): boolean {
  if (mode === "process") {
    return true;
  }
  if (mode === "split-at-last-tool") {
    return lastToolBlockIndex >= 0 && blockIndex < lastToolBlockIndex;
  }
  return false;
}

export function pushNoticeProcessBlock(
  processBlocks: MessageProcessBlock[],
  textValue: string,
): void {
  const text = textValue.trim();
  if (!text) {
    return;
  }

  const previous = processBlocks.at(-1);
  if (previous?.kind === "notice") {
    previous.text = `${previous.text}\n\n${text}`;
    return;
  }

  processBlocks.push({ kind: "notice", text });
}

function assistantContentBlockText(block: { type?: string; text?: string } | undefined): string {
  if (block?.type === "text") {
    return block.text ?? "";
  }
  if (block?.type === "image") {
    return "[image]";
  }
  return "";
}

function toolResultAsProcessBlock(message: TranscriptMessage): Extract<MessageProcessBlock, { kind: "tool" }> {
  return {
    kind: "tool",
    toolCallId: String(message.toolCallId ?? ""),
    toolName: String(message.toolName ?? "tool"),
    callText: "(tool call completed)",
    resultText: toolResultProcessText(message),
    status: "done",
    isError: Boolean(message.isError),
  };
}

function toolResultProcessText(message: TranscriptMessage): string {
  return messageToText(message) || "(no output)";
}

/* -------------------------------------------------------------------------- */
/* Placement: "where does this bubble go", derived from its id only            */
/* -------------------------------------------------------------------------- */

/** Id of a bubble that only exists locally until the server confirms it. */
/**
 * Identity of an optimistic bubble.
 *
 * It carries the turn the client *predicted* for this submission, so a server
 * event can find its own slot instead of grabbing whatever provisional happens
 * to be oldest. Two submissions in flight (a run plus a queued 插话) otherwise
 * cross claims and leave an orphan placeholder behind.
 */
export function provisionalBubbleId(
  clientMessageId: string,
  role: ChatBubbleRole,
  predictedTurn?: number,
): string {
  const turn = predictedTurn == null ? "" : `t${predictedTurn}:`;
  return `prov:${role}:${turn}${clientMessageId}`;
}

const PROVISIONAL_ID = /^prov:(user|assistant):(?:t(\d+):)?(.*)$/;

export interface ParsedProvisionalBubbleId {
  role: ChatBubbleRole;
  /** Turn the client guessed when it drew the bubble, or `null` if unknown. */
  predictedTurn: number | null;
  clientMessageId: string;
}

export function parseProvisionalBubbleId(id: string): ParsedProvisionalBubbleId | null {
  const match = PROVISIONAL_ID.exec(id);
  if (!match) {
    return null;
  }
  return {
    role: match[1] as ChatBubbleRole,
    predictedTurn: match[2] ? Number(match[2]) : null,
    clientMessageId: match[3],
  };
}

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

  for (const bubble of local) {
    if (incomingIds.has(bubble.id)) {
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
    return incoming;
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

