/**
 * What the busy-session watchdog should ask the server for next.
 *
 * Extracted from `usePiDesktopApp` because the whole point of the change is a *decision*
 * that must not regress: it decides whether a tick costs ~1 KB or 0.3-0.9 MB times
 * whatever the conversation has grown to.
 *
 * The rule set, and why each one is there:
 *
 * - We own the run and our stream is delivering  -> `ambient`. The transcript is
 *   already arriving on our SSE stream; the poll only exists to cover what a stream
 *   cannot carry (another window, an extension approval, pi's queues, a stop landing).
 * - We own the run but the stream has been quiet  -> still `ambient`, until
 *   `stallReconcileMs` has passed since the last full snapshot, then `full` once.
 *   Long tool calls are silent by nature - one measured 11.9s - and the previous
 *   behaviour polled *harder* (1s, full body) exactly then, so the quietest moments
 *   paid the most main-thread parsing.
 * - We are not the one streaming, or a stop is landing  -> `full`. Another window's
 *   tokens never reach us, so the transcript itself is the only signal here.
 */

export type PollMode = "ambient" | "full";

export type PollTiming = {
  /** Below this, the stream counts as delivering. */
  idleStreamMs: number;
  /** How often an ambient tick fires. */
  ambientPollMs: number;
  /** How often a full tick fires (the not-the-owner case keeps the old 1s cadence). */
  fullPollMs: number;
  /** Upper bound on how long we may go without reconciling the transcript. */
  stallReconcileMs: number;
};

export const DEFAULT_POLL_TIMING: PollTiming = {
  idleStreamMs: 3000,
  ambientPollMs: 5000,
  fullPollMs: 1000,
  stallReconcileMs: 15000,
};

export type PollModeInput = {
  /** This window started the run, so its SSE stream carries the transcript. */
  ownsStream: boolean;
  /** A stop is in flight; only a full answer can confirm the server caught up. */
  isStopping: boolean;
  /** Now - timestamp of the last stream event we applied. */
  sinceLastStreamEventMs: number;
  /** Now - timestamp of the last full snapshot folded in. */
  sinceFullReconcileMs: number;
};

export function choosePollMode(
  input: PollModeInput,
  timing: PollTiming = DEFAULT_POLL_TIMING,
): PollMode {
  if (!input.ownsStream || input.isStopping) {
    return "full";
  }

  if (input.sinceLastStreamEventMs < timing.idleStreamMs) {
    return "ambient";
  }

  return input.sinceFullReconcileMs >= timing.stallReconcileMs ? "full" : "ambient";
}

export function pollDelayMs(mode: PollMode, timing: PollTiming = DEFAULT_POLL_TIMING): number {
  return mode === "ambient" ? timing.ambientPollMs : timing.fullPollMs;
}
