/**
 * One session's in-flight stream bookkeeping.
 *
 * It lives in its own module for two reasons: the hook that owns it is under a
 * line ratchet, and these fields are the contract between the stream entry
 * points (`promptFeed`, the poll watchdog) — worth reading without the hook.
 */
import type { StreamCommitBuffer } from "./streamCommitBuffer";

export interface SessionStreamState {
  controller: AbortController | null;
  lifecycleGeneration: number;
  /**
   * Bubble the server is writing right now, kept in sync by the stream
   * projection. It replaces the old `activeAssistantMessageId` +
   * `pendingSteeringMessages` pair, which had to be reconciled by guessing.
   */
  activeBubbleId: string | null;
  /** Stream events we could not address. Reported, never guessed around. */
  droppedEvents: number;
  /** Last pi-queue sequence applied, so a late duplicate cannot resurrect a 插话. */
  queueSeq: number;
  /**
   * 这条会话的流已经接不回来了（`promptFeed` 给了 up）。它决定忙会话看门狗走
   * `full` 还是 `ambient`：我们的流死掉之后，转录只能靠快照追平，`ambient` 永远不会带它。
   */
  streamLost: boolean;
  /**
   * Frame-budgeted commit buffer for this session's stream (see
   * `streamCommitBuffer.ts`). Created on the first event; it is what turns a burst of
   * 60-90 provider deltas into one state commit instead of 60-90 re-renders.
   */
  commitBuffer?: StreamCommitBuffer;
}

export function createSessionStreamState(): SessionStreamState {
  return {
    controller: null,
    lifecycleGeneration: 0,
    activeBubbleId: null,
    droppedEvents: 0,
    queueSeq: 0,
    streamLost: false,
  };
}