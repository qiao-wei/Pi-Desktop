/**
 * Turn timing taken from the transcript itself.
 *
 * 「已工作 N 秒」has two possible sources: the runtime's own stream timing (only for a
 * turn this client watched live) and the transcript's entry timestamps (always
 * available, including for a session replayed from disk). This module is the second
 * one — the reason the number survives opening an old conversation.
 *
 * It deliberately returns `undefined` rather than `0` when the entries carry no usable
 * timestamps: "we do not know" and "it took no time" are different claims, and the
 * header has a label for the first one.
 */

import type { ChatMessage } from "../types/domain.ts";

export interface TurnTimestampEntry {
  timestamp?: unknown;
}

/** Wall-clock length of one turn: the prompt's entry to the turn's last entry. */
export function turnDurationOf(entries: readonly TurnTimestampEntry[]): number | undefined {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let measured = 0;
  for (const entry of entries) {
    const timestamp = Number(entry.timestamp ?? Number.NaN);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      continue;
    }
    measured += 1;
    first = Math.min(first, timestamp);
    last = Math.max(last, timestamp);
  }
  // One timestamp is a point, not a span: there is no duration to report yet.
  if (measured < 2) {
    return undefined;
  }
  return Math.max(0, last - first);
}

/**
 * The duration a header should print, in whole seconds.
 *
 * Sub-second turns read as 1 second (`Math.max(1, …)`, same as ZCode's
 * `formatConversationWorkDuration`): "已工作 0 秒" is not a thing a reader can use.
 */
export function turnDurationSeconds(durationMs: number | undefined): number | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
    return undefined;
  }
  return Math.max(1, Math.round(durationMs / 1000));
}
/**
 * Length of a turn this client watched, for the moment it settles.
 *
 * The header prints 「已工作 N 秒」 the instant the run ends, and at that instant the
 * bubble on screen came from the stream — the transcript's own timestamps may not
 * describe that turn yet (pi can still be a few hundred milliseconds behind). The
 * span this client actually watched is a real measurement, so it fills the gap; the
 * transcript takes over on the next snapshot.
 */
export function observedTurnDuration(startedAt: unknown, settledAt: number): number | undefined {
  const started = Number(startedAt);
  if (!Number.isFinite(started) || started <= 0 || !Number.isFinite(settledAt) || settledAt < started) {
    return undefined;
  }
  return settledAt - started;
}

/**
 * Settle one streaming answer: mark it done and keep the span this client watched.
 *
 * Returns `undefined` for anything that is not a streaming answer, so callers can
 * pass the result straight back into a `patchMessages` map.
 */
export function settleStreamingAnswer(
  message: ChatMessage,
  settledAt: number,
): ChatMessage | undefined {
  if (message.role !== "assistant" || message.status !== "streaming") {
    return undefined;
  }
  return {
    ...message,
    status: "done",
    turnDurationMs: message.turnDurationMs ?? observedTurnDuration(message.createdAt, settledAt),
  };
}
