/**
 * Reasoning timing that only this client can know.
 *
 * A thought's duration is not in the transcript: pi stores one timestamp per
 * message, not per content block, so a session replayed from disk has no way to say
 * how long a thought took. The only honest source is the client that watched the
 * deltas: it stamps `startedAt` on the first one and `endedAt` when the block closes
 * (`chatProcessBlocks.ts`), and those two numbers ride on the block from then on.
 *
 * That leaves one hole this module fills: the post-turn snapshot *rebuilds* the block
 * from the transcript, so the numbers would be dropped the moment the turn settles —
 * which is exactly when the row starts showing them. `carryObservedThinkingTiming`
 * copies what we observed onto the rebuilt block (matched by stream key, or by text
 * when unkeyed), and leaves the snapshot's content untouched.
 */

import type { ChatMessage, MessageLiveBlock, MessageProcessBlock } from "../types";

type ThinkingBlock = Extract<MessageProcessBlock, { kind: "thinking" }>;
/** Either block shape: the live list and the settled list carry the same fields. */
type ThinkingSource = Extract<MessageLiveBlock, { kind: "thinking" }> | ThinkingBlock;

/** Whether this block carries a complete observation (both ends seen). */
export function hasObservedThinkingTiming(block: ThinkingSource): boolean {
  return (
    block.startedAt !== undefined &&
    block.endedAt !== undefined &&
    block.endedAt >= block.startedAt
  );
}

/** Whole seconds a thought took, or `undefined` when it was not observed. */
export function observedThinkingSeconds(block: ThinkingSource): number | undefined {
  if (!hasObservedThinkingTiming(block)) {
    return undefined;
  }
  const elapsed = (block.endedAt as number) - (block.startedAt as number);
  return Math.max(1, Math.round(elapsed / 1000));
}

function sameThought(observed: ThinkingSource, incoming: ThinkingSource): boolean {
  if (observed.streamKey && incoming.streamKey) {
    return observed.streamKey === incoming.streamKey;
  }
  return observed.text.trim() === incoming.text.trim();
}

/**
 * Copy observed timing from `local` (what we streamed) onto `incoming` (the
 * transcript's rebuild of the same turn).
 *
 * Returns `incoming` unchanged (same array identity) when there is nothing to copy,
 * so a snapshot that is already complete stays cheap to reconcile.
 */
export function carryObservedThinkingTiming(
  local: readonly (MessageProcessBlock | MessageLiveBlock)[] | undefined,
  incoming: readonly MessageProcessBlock[] | undefined,
): readonly MessageProcessBlock[] | undefined {
  if (!local?.length || !incoming?.length) {
    return incoming;
  }
  let changed = false;
  const next = incoming.map((block) => {
    if (block.kind !== "thinking" || hasObservedThinkingTiming(block)) {
      return block;
    }
    const observed = local.find(
      (candidate): candidate is ThinkingSource =>
        candidate.kind === "thinking" && sameThought(candidate, block),
    );
    if (!observed || !hasObservedThinkingTiming(observed)) {
      return block;
    }
    changed = true;
    return { ...block, startedAt: observed.startedAt, endedAt: observed.endedAt };
  });
  return changed ? next : incoming;
}
/**
 * Keep the facts only this client could observe when the snapshot rebuilds a finished
 * answer (the transcript carries content, never timing).
 *
 * Returns `incoming` itself when there is nothing to add, so a snapshot that already
 * says everything stays byte-identical.
 */
export function carryObservedAnswerTiming(incoming: ChatMessage, local: ChatMessage): ChatMessage {
  // What we streamed lives in `liveBlocks` (deltas stamp the clock there); the
  // settled list mirrors the same thought without timing.
  const observed = [...(local.liveBlocks ?? []), ...(local.processBlocks ?? [])];
  const processBlocks = carryObservedThinkingTiming(observed, incoming.processBlocks) as
    | MessageProcessBlock[]
    | undefined;
  const turnDurationMs = incoming.turnDurationMs ?? local.turnDurationMs;
  if (processBlocks === incoming.processBlocks && turnDurationMs === incoming.turnDurationMs) {
    return incoming;
  }
  return { ...incoming, processBlocks, turnDurationMs };
}
