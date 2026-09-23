import type { ChatMessage, MessageLiveBlock, MessageProcessBlock } from "../types";

/**
 * The process-block algebra behind a streaming assistant bubble: thinking text,
 * interim "notice" text and tool blocks, merged without ever rebuilding blocks
 * that did not change.
 *
 * The server repeats the *cumulative* payload on every coalesced tick, so these
 * merges are the reason a repeated event stays a no-op instead of turning into a
 * new object identity per token (which previously rebuilt the whole thread).
 *
 * Lives next to `chatBubbles.ts` because the transcript -> bubble builder and
 * the stream projection both need exactly one copy of these rules.
 */

function sameBlocks(a: MessageProcessBlock, b: MessageProcessBlock): boolean {
  if (a === b) {
    return true;
  }
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "tool" && b.kind === "tool") {
    return (
      a.toolCallId === b.toolCallId &&
      a.toolStreamId === b.toolStreamId &&
      a.toolName === b.toolName &&
      a.callText === b.callText &&
      a.resultText === b.resultText &&
      a.isError === b.isError &&
      a.status === b.status
    );
  }
  if (a.kind === "thinking" && b.kind === "thinking") {
    return a.text === b.text && a.streamKey === b.streamKey && a.open === b.open;
  }
  return (a as { text: string }).text === (b as { text: string }).text;
}

export function isToolProcessBlock(block: MessageProcessBlock): block is Extract<MessageProcessBlock, { kind: "tool" }> {
  return block.kind === "tool";
}

export function toolProcessBlockKeys(block: Extract<MessageProcessBlock, { kind: "tool" }>): string[] {
  return [
    block.toolCallId ? `id:${block.toolCallId}` : "",
    block.toolStreamId ? `stream:${block.toolStreamId}` : "",
  ].filter(Boolean);
}

export function toolProcessBlocksMatch(
  first: Extract<MessageProcessBlock, { kind: "tool" }>,
  second: Extract<MessageProcessBlock, { kind: "tool" }>,
): boolean {
  const firstKeys = new Set(toolProcessBlockKeys(first));
  return toolProcessBlockKeys(second).some((key) => firstKeys.has(key));
}

/**
 * A tool block whose call id never arrived: it exists only as a stream slot, so
 * a later event that finally names the call has to *bind* into it rather than
 * open a second card for the same call.
 */
function isPendingToolBlock(
  block: MessageProcessBlock | MessageLiveBlock,
  toolName: string,
): block is Extract<MessageProcessBlock, { kind: "tool" }> {
  return (
    block.kind === "tool" &&
    !block.toolCallId &&
    (block.toolName === toolName || !toolName || block.toolName === "tool")
  );
}

/**
 * Index of the placeholder a call id should be bound to. FIFO on purpose: pi
 * executes the tool calls of a message in transcript order, so the first
 * still-anonymous card is the one this execution belongs to.
 */
export function findPendingToolBlockIndex(
  blocks: readonly (MessageProcessBlock | MessageLiveBlock)[],
  toolName: string,
): number {
  if (!toolName) {
    return -1;
  }
  for (let index = 0; index < blocks.length; index += 1) {
    if (isPendingToolBlock(blocks[index], toolName)) {
      return index;
    }
  }
  return -1;
}

/**
 * Fold a cumulative thinking payload into the existing block list. Returns the
 * same array identity when nothing actually moved, so that a repeated
 * "same thinking" event costs nothing downstream.
 */
export function mergeAssistantProcessBlocks(
  existingBlocks: MessageProcessBlock[],
  incomingBlocks: MessageProcessBlock[],
): MessageProcessBlock[] {
  if (!incomingBlocks.length) {
    return existingBlocks;
  }

  const merged = existingBlocks.slice();
  let changed = false;
  const write = (index: number, block: MessageProcessBlock) => {
    if (sameBlocks(merged[index], block)) {
      return;
    }
    merged[index] = block;
    changed = true;
  };

  const existingToolIndex = new Map<string, number>();
  merged.forEach((block, index) => {
    if (!isToolProcessBlock(block)) {
      return;
    }
    for (const key of toolProcessBlockKeys(block)) {
      existingToolIndex.set(key, index);
    }
  });

  for (const block of incomingBlocks) {
    if (block.kind === "thinking") {
      if (mergeThinkingProcessBlock(merged, block, write)) {
        changed = true;
      }
      continue;
    }

    if (block.kind === "notice") {
      if (mergeNoticeProcessBlock(merged, block.text, write)) {
        changed = true;
      }
      continue;
    }

    const matchingIndex = toolProcessBlockKeys(block)
      .map((key) => existingToolIndex.get(key))
      .find((index): index is number => index != null);

    if (matchingIndex == null) {
      merged.push({
        kind: "tool",
        toolCallId: block.toolCallId,
        toolStreamId: block.toolStreamId,
        toolName: block.toolName || "tool",
        callText: block.callText || "",
        resultText: block.resultText,
        isError: block.isError,
        status: block.status ?? "streaming",
      });
      for (const key of toolProcessBlockKeys(merged[merged.length - 1] as Extract<MessageProcessBlock, { kind: "tool" }>)) {
        existingToolIndex.set(key, merged.length - 1);
      }
      changed = true;
      continue;
    }

    const prior = merged[matchingIndex];
    if (!isToolProcessBlock(prior)) {
      continue;
    }

    write(matchingIndex, {
      kind: "tool",
      toolCallId: block.toolCallId || prior.toolCallId,
      toolStreamId: block.toolStreamId ?? prior.toolStreamId,
      toolName: block.toolName || prior.toolName,
      callText: block.callText || prior.callText,
      resultText: block.resultText ?? prior.resultText,
      isError: block.isError ?? prior.isError,
      status: block.status ?? prior.status ?? "streaming",
    });
    for (const key of toolProcessBlockKeys(merged[matchingIndex] as Extract<MessageProcessBlock, { kind: "tool" }>)) {
      existingToolIndex.set(key, matchingIndex);
    }
  }

  if (!changed) {
    return existingBlocks;
  }
  // Pushing a block that was already in normalised form still allocated a new
  // array. Collapse that case back onto the original identity so a repeated
  // event costs nothing downstream.
  if (sameBlockList(existingBlocks, merged)) {
    return existingBlocks;
  }
  return merged;
}

function sameBlockList(a: MessageProcessBlock[], b: MessageProcessBlock[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((block, index) => sameBlocks(block, b[index]));
}

/**
 * Cumulative thinking payloads: a longer incoming text appends, an equal or
 * shorter one is a no-op. `write` keeps untouched blocks referentially stable.
 *
 * A keyed block only ever merges into the block with the same key. The text
 * heuristic below is the fallback for blocks the server never keyed (persisted
 * transcripts, older builds) - it has to stay a fallback, because "the last
 * thinking block" is found by scanning *past* the tool blocks in between, which
 * is what used to pour round 2's thinking into round 1's panel above the tools.
 */
function mergeThinkingProcessBlock(
  blocks: MessageProcessBlock[],
  incoming: Extract<MessageProcessBlock, { kind: "thinking" }>,
  write: (index: number, block: MessageProcessBlock) => void,
): boolean {
  const text = incoming.text.trim();
  if (!text) {
    return false;
  }

  if (incoming.streamKey) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (block.kind !== "thinking" || block.streamKey !== incoming.streamKey) {
        continue;
      }
      if (block.text === text || block.text.startsWith(text)) {
        return false;
      }
      write(index, { kind: "thinking", text, streamKey: block.streamKey });
      return true;
    }
    blocks.push({ kind: "thinking", text, streamKey: incoming.streamKey });
    return true;
  }

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind !== "thinking") {
      continue;
    }
    if (block.text === text || block.text.startsWith(text)) {
      return false;
    }
    if (text.startsWith(block.text)) {
      write(index, { kind: "thinking", text });
      return true;
    }
  }

  blocks.push({ kind: "thinking", text });
  return true;
}

function mergeNoticeProcessBlock(
  blocks: MessageProcessBlock[],
  textValue: string,
  write: (index: number, block: MessageProcessBlock) => void,
): boolean {
  const text = textValue.trim();
  if (!text) {
    return false;
  }

  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock?.kind === "notice") {
    if (lastBlock.text === text || lastBlock.text.startsWith(text)) {
      return false;
    }
    if (text.startsWith(lastBlock.text)) {
      write(blocks.length - 1, { kind: "notice", text });
      return true;
    }
  }

  blocks.push({ kind: "notice", text });
  return true;
}

/**
 * Close only the open thinking blocks that sit *before* `index`.
 *
 * A tool block active at `index` proves every thinking round above it is over
 * (the model had finished thinking when it started calling this tool), but it
 * says nothing about a later round that may legitimately still be streaming
 * below it - interleaved thinking while an earlier tool keeps executing. Only
 * closing what is above is what keeps that later round's panel alive.
 *
 * Identity-preserving like `closeOpenThinkingBlocks`: nothing open above
 * returns the input array untouched, so the per-token tool path stays cheap.
 */
function closeOpenThinkingBefore<T extends MessageProcessBlock | MessageLiveBlock>(
  blocks: readonly T[],
  index: number,
): T[] {
  let changed = false;
  const next = blocks.map((block, position) => {
    if (position >= index) {
      return block;
    }
    if (block.kind === "thinking" && (block as { open?: boolean }).open) {
      changed = true;
      return { ...block, open: false } as T;
    }
    return block;
  });
  return changed ? next : (blocks as T[]);
}

/**
 * Insert or update a tool block, preserving array identity when nothing moved.
 *
 * Three rules that the old per-list copies got wrong:
 * - a stream that never revealed its call id leaves a *placeholder* card; the
 *   event that finally names the call binds into it instead of opening a second
 *   card for the same tool call (that duplicate is what read as "nothing
 *   happened, then every tool appeared at once");
 * - opening a tool block closes the thinking panel above it: the round of
 *   thinking is over the moment the model starts calling something;
 * - *updating* an existing tool block also closes the thinking panels above it.
 *   The append branch used to be the only closer, so a lost settle event left a
 *   panel above the tool spinning forever while the tool below streamed its
 *   output - the "工具卡都出来了，上面的 thinking 还在输出" report. Tool
 *   activity is itself proof the thinking ended; the client must not depend on
 *   any single server event arriving to settle a panel.
 */
export function upsertToolProcessBlock(
  existingBlocks: MessageProcessBlock[],
  block: MessageProcessBlock,
): MessageProcessBlock[] {
  return upsertToolBlock(existingBlocks, block);
}

function upsertToolBlock<T extends MessageProcessBlock | MessageLiveBlock>(
  existingBlocks: readonly T[],
  block: MessageProcessBlock,
): T[] {
  if (block.kind !== "tool") {
    return existingBlocks as T[];
  }
  const hasKeyMatch = (existingBlocks as readonly MessageProcessBlock[]).some(
    (item) => item.kind === "tool" && toolProcessBlocksMatch(item, block),
  );
  const pendingIndex = hasKeyMatch ? -1 : findPendingToolBlockIndex(existingBlocks, block.toolName);

  let matched = false;
  let firstMatchedIndex = -1;
  let changed = false;
  const next = existingBlocks.map((item, index) => {
    if (item.kind !== "tool") {
      return item;
    }
    if (!toolProcessBlocksMatch(item as Extract<MessageProcessBlock, { kind: "tool" }>, block) && index !== pendingIndex) {
      return item;
    }
    matched = true;
    if (firstMatchedIndex < 0) {
      firstMatchedIndex = index;
    }
    const prior = item as Extract<MessageProcessBlock, { kind: "tool" }>;
    const updated = {
      kind: "tool",
      toolCallId: block.toolCallId || prior.toolCallId,
      toolStreamId: block.toolStreamId ?? prior.toolStreamId,
      toolName: block.toolName || prior.toolName,
      callText: block.callText || prior.callText,
      resultText: block.resultText ?? prior.resultText,
      isError: block.isError ?? prior.isError,
      status: block.status ?? prior.status,
    } as unknown as T;
    if (sameBlocks(item as MessageProcessBlock, updated as unknown as MessageProcessBlock)) {
      return item;
    }
    changed = true;
    return updated;
  });

  if (matched) {
    // Updating an existing card still proves the thinking above it ended - see
    // the third rule in the doc comment. Identity-preserving when nothing was
    // open, so a repeated event with settled thinking stays a no-op.
    return closeOpenThinkingBefore(changed ? next : (existingBlocks as T[]), firstMatchedIndex);
  }

  return [...closeOpenThinkingBlocks(existingBlocks), { ...block } as unknown as T];
}

/**
 * Mark every still-open thinking block as finished. Identity-preserving: a list
 * with nothing open comes back unchanged, so the per-token path stays cheap.
 */
export function closeOpenThinkingBlocks<T extends MessageLiveBlock | MessageProcessBlock>(
  blocks: readonly T[],
): T[] {
  if (!blocks.some((block) => block.kind === "thinking" && (block as { open?: boolean }).open)) {
    return blocks as T[];
  }
  return blocks.map((block) =>
    block.kind === "thinking" && (block as { open?: boolean }).open
      ? ({ ...block, open: false } as T)
      : block,
  );
}

/**
 * The block a streamed thinking delta belongs to.
 *
 * pi keeps exactly one thinking block per assistant message, so an interleaved
 * provider reuses one key for the whole thought. A server that grew a `#n`
 * suffix for "the next piece" (an experiment that fabricated the splits this
 * matcher exists to undo) must still land on the same block, so keys compare by
 * their base: `assistant-0-thinking-0#2` is `assistant-0-thinking-0`.
 */
function thinkingStreamBaseKey(streamKey: string): string {
  return streamKey.replace(/#\d+$/, "");
}

function thinkingLiveBlockIndexOf(blocks: readonly MessageLiveBlock[], streamKey: string): number {
  const base = thinkingStreamBaseKey(streamKey);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const item = blocks[index];
    if (item.kind === "thinking" && item.streamKey && thinkingStreamBaseKey(item.streamKey) === base) {
      return index;
    }
  }
  return -1;
}

/**
 * Append streamed thinking text, opening the block on the first delta.
 *
 * The live list is the only thing a delta touches: the authoritative cumulative
 * block arrives once, with the `assistant_partial` that closes it (`thinking_end`)
 * - so per-token work never has to rebuild the persisted list twice. An opening
 * snapshot is deliberately not merged into this list: see `projectProcessBlocks`.
 *
 * `streamKey` is what keeps two thinking rounds apart: a delta whose key matches
 * no live block opens a *new* block (and closes the previous one) instead of
 * continuing the panel that sits above the tools.
 */
export function appendLiveThinkingBlock(
  blocks: MessageLiveBlock[],
  delta: string,
  streamKey?: string,
): MessageLiveBlock[] {
  if (!delta) {
    return blocks;
  }

  if (streamKey) {
    const matchIndex = thinkingLiveBlockIndexOf(blocks, streamKey);
    if (matchIndex >= 0) {
      const block = blocks[matchIndex] as Extract<MessageLiveBlock, { kind: "thinking" }>;
      // A delta for a key we already hold is always *more of that same thought*,
      // even when text or a tool call was appended after it in the meantime: pi
      // keeps exactly one thinking block per assistant message, so a provider that
      // interleaves reasoning with content reuses one key for the whole thought.
      //
      // Opening a fresh block at the end for such a delta (the previous rule)
      // invented a split the transcript does not have - the round showed up as two
      // panels while the sentence around it broke into "改动" / panel / "齐了…", and
      // a reload (which renders the persisted message) showed it whole again. Write
      // the text back where it belongs instead. `open` follows the block's own
      // flag: `false` means a text/tool block deliberately settled this panel, and
      // re-lighting it would put a "still thinking" panel back above the tool card
      // that closed it (the original report). `undefined` only means "no delta has
      // arrived yet" (a panel seeded by a snapshot), and a delta really is the
      // panel starting to stream, so that one lights up.
      const next = blocks.slice();
      next[matchIndex] = {
        kind: "thinking",
        text: `${block.text}${delta}`,
        streamKey: block.streamKey,
        open: block.open !== false,
      };
      return next;
    }
    return [
      ...closeOpenThinkingBlocks(blocks),
      { kind: "thinking", text: delta, streamKey, open: true },
    ];
  }

  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock?.kind === "thinking") {
    const next = blocks.slice();
    next[next.length - 1] = { kind: "thinking", text: `${lastBlock.text}${delta}`, open: true };
    return next;
  }

  return [...closeOpenThinkingBlocks(blocks), { kind: "thinking", text: delta, open: true }];
}

/** The block a streamed tool-call argument belongs to: last match wins. */
function findToolBlockIndex<T extends MessageProcessBlock | MessageLiveBlock>(
  blocks: readonly T[],
  probe: Extract<MessageProcessBlock, { kind: "tool" }>,
): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const item = blocks[index];
    if (item.kind === "tool" && toolProcessBlocksMatch(item, probe)) {
      return index;
    }
  }
  return -1;
}

function appendToolArgsText<T extends MessageProcessBlock | MessageLiveBlock>(
  blocks: readonly T[],
  probe: Extract<MessageProcessBlock, { kind: "tool" }>,
  delta: string,
): T[] {
  if (!delta) {
    return blocks as T[];
  }

  let index = findToolBlockIndex(blocks, probe);
  if (index < 0) {
    // The delta outran its `tool_call_stream_start`, or that start never revealed
    // a call id: bind onto the placeholder card so the typewriter has somewhere
    // to go, and only as a last resort open a block of its own.
    index = findPendingToolBlockIndex(blocks, probe.toolName);
  }
  if (index < 0) {
    return [...closeOpenThinkingBlocks(blocks), { ...probe, callText: delta } as T];
  }

  const current = blocks[index] as Extract<MessageProcessBlock, { kind: "tool" }>;
  const next = blocks.slice() as T[];
  next[index] = {
    ...current,
    toolCallId: current.toolCallId || probe.toolCallId,
    callText: `${current.callText}${delta}`,
    status: "streaming",
  } as T;
  // Argument tokens on an existing card are tool activity too: close the
  // thinking panels above it (never the ones below - see closeOpenThinkingBefore).
  return closeOpenThinkingBefore(next, index);
}

/** Append streamed tool-argument JSON text to the persisted block list. */
export function appendToolCallArgsText(
  blocks: MessageProcessBlock[],
  probe: Extract<MessageProcessBlock, { kind: "tool" }>,
  delta: string,
): MessageProcessBlock[] {
  return appendToolArgsText(blocks, probe, delta);
}

/** Same, for the live list the streaming bubble renders. */
export function appendLiveToolCallArgsText(
  blocks: MessageLiveBlock[],
  probe: Extract<MessageProcessBlock, { kind: "tool" }>,
  delta: string,
): MessageLiveBlock[] {
  return appendToolArgsText(blocks, probe, delta);
}

/** Append a text delta to the live block list, copying only the tail block. */
export function appendLiveTextBlock(blocks: MessageLiveBlock[], delta: string): MessageLiveBlock[] {
  if (!delta) {
    return blocks;
  }

  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock?.kind === "text") {
    const next = blocks.slice();
    next[next.length - 1] = { kind: "text", text: `${lastBlock.text}${delta}` };
    return next;
  }

  // An answer block ends whatever thinking was still on screen.
  return [...closeOpenThinkingBlocks(blocks), { kind: "text", text: delta }];
}

export function mergeLiveProcessBlocks(
  blocks: MessageLiveBlock[],
  incomingBlocks: MessageProcessBlock[],
): MessageLiveBlock[] {
  // No leading slice(): a repeated cumulative payload has to come back out of
  // here with the *same* array identity, or every tick re-renders the thread.
  return incomingBlocks.reduce<MessageLiveBlock[]>((next, block) => {
    if (block.kind === "tool") {
      return upsertLiveToolBlock(next, block);
    }
    return mergeLiveTextualProcessBlock(next, block);
  }, blocks);
}

/**
 * Fold a cumulative `assistant_partial` snapshot into the live list.
 *
 * Keyed thinking merges by identity; unkeyed thinking falls back to the text
 * prefix rule (see `mergeThinkingProcessBlock` for why that fallback is only
 * safe for blocks nobody keyed).
 */
function mergeLiveTextualProcessBlock(
  blocks: MessageLiveBlock[],
  block: Extract<MessageProcessBlock, { kind: "thinking" | "notice" }>,
): MessageLiveBlock[] {
  const text = block.text.trim();
  if (!text) {
    return blocks;
  }

  if (block.kind === "thinking" && block.streamKey) {
    const matchIndex = thinkingLiveBlockIndexOf(blocks, block.streamKey);

    if (matchIndex < 0) {
      return [...blocks, { kind: "thinking", text, streamKey: block.streamKey }];
    }
    const item = blocks[matchIndex] as Extract<MessageLiveBlock, { kind: "thinking" }>;
    // Prefix: a cumulative snapshot we already streamed past. Suffix: the tail of
    // a block a `#n`-splitting server publishes as its own slice - the live block
    // already holds that text at its end, so writing it would *shrink* the panel to
    // the tail (which is worse than the split it came with).
    if (item.text === text || item.text.startsWith(text) || item.text.endsWith(text)) {
      return blocks;
    }
    const next = [...blocks];
    next[matchIndex] = { kind: "thinking", text, streamKey: item.streamKey, open: item.open };
    return next;
  }

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const item = blocks[index];
    if (item.kind !== block.kind) {
      continue;
    }
    if (item.text === text || item.text.startsWith(text)) {
      return blocks;
    }
    if (text.startsWith(item.text)) {
      const next = [...blocks];
      next[index] = { kind: block.kind, text };
      return next;
    }
  }

  return [...blocks, { kind: block.kind, text }];
}

export function upsertLiveToolBlock(blocks: MessageLiveBlock[], block: MessageProcessBlock): MessageLiveBlock[] {
  return upsertToolBlock(blocks, block);
}

/** Identity-preserving counterpart of `normalizeMessageProcessBlocks`. */
export function normalizeMessageProcessBlocks(message: ChatMessage): ChatMessage {
  const blocks = message.processBlocks;
  if (!blocks?.length) {
    return message;
  }
  const normalized = mergeAssistantProcessBlocks([], blocks);
  if (sameBlockList(blocks, normalized)) {
    return message;
  }
  return { ...message, processBlocks: normalized };
}
