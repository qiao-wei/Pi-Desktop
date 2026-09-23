import type { ChatStreamView } from "../../shared/chatStreamProjection";
import type { PromptStreamEvent } from "../../lib/api";

/**
 * Frame-budgeted commit for the streaming hot path - the one mechanism worth
 * copying from pi's TUI.
 *
 * pi coalesces at two levels (`pi-tui/dist/tui.js`): `requestRender()` sets a single
 * dirty flag (`if (this.renderRequested) return`), and `MIN_RENDER_INTERVAL_MS = 16`
 * caps the render at 60fps regardless of how many events arrived; latency-sensitive
 * input preempts the throttled frame via `requestImmediateRender()`.
 *
 * Pi Desktop needs the same thing for a different reason: a captured run showed the
 * provider delivering thinking tokens in bursts - ~2s of silence, then 62-89 deltas
 * inside 300ms. Applying those one-by-one means up to 89 state commits, 89 rebuilds
 * of the whole bubble list, and 89 thread re-renders with scroll re-pinning, which is
 * where the "stall, then everything at once" feeling gets amplified. Buffering them
 * into one commit per frame changes the *number of renders*, never the content and
 * never the order: unlike the 120ms coalescer that was removed from the server, this
 * one does not hold text back - the next frame is at most 16ms away.
 *
 * The invariant that makes this safe: while a view is pending, later events project
 * onto *that pending view*. Reading committed state would silently drop everything
 * queued, so `currentBubbles()` in `usePiDesktopApp` flushes first.
 */

/** Only per-token churn waits for the next frame. Everything else commits at once. */
const COALESCED_EVENT_TYPES: ReadonlySet<PromptStreamEvent["type"]> = new Set<PromptStreamEvent["type"]>([
  "delta",
  "thinking_delta",
  "tool_call_stream_delta",
  "tool_execution_update",
]);

/** Matches `TuiBase.MIN_RENDER_INTERVAL_MS`; also the fallback timer when rAF is absent. */
export const MIN_COMMIT_INTERVAL_MS = 16;

export type StreamCommitBuffer = {
  /** Project one event, committing now or at the next frame depending on its kind. */
  push: (event: PromptStreamEvent) => void;
  /** Commit anything queued. Idempotent, and safe to call from inside a commit. */
  flush: () => void;
  /** Whether a projected view is waiting for its frame. */
  hasPending: () => boolean;
};

export type StreamCommitBufferDeps = {
  /**
   * View derived from committed state, or `null` when this session has nothing to
   * write to yet (unknown/closed session) - in which case the event is dropped, the
   * same way the un-buffered path dropped it.
   */
  baseView: () => ChatStreamView | null;
  /** Project a single event. Must return `view` unchanged when it is a no-op. */
  project: (view: ChatStreamView, event: PromptStreamEvent) => ChatStreamView;
  /** Publish a view. Called at most once per frame, and never with a stale view. */
  commit: (view: ChatStreamView) => void;
  /** Injectable clock, so the frame budget is testable. */
  scheduleFrame?: (run: () => void) => number;
  cancelFrame?: (id: number) => void;
  coalescedTypes?: ReadonlySet<PromptStreamEvent["type"]>;
};

function defaultScheduleFrame(run: () => void): number {
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  if (raf) {
    return raf(() => run());
  }
  // Background tabs pause rAF; a timer keeps the view honest when it does.
  return setTimeout(run, MIN_COMMIT_INTERVAL_MS) as unknown as number;
}

export function createStreamCommitBuffer(deps: StreamCommitBufferDeps): StreamCommitBuffer {
  const types = deps.coalescedTypes ?? COALESCED_EVENT_TYPES;
  const cancelFrame = deps.cancelFrame ?? ((id: number) => clearTimeout(id));
  const scheduleFrame = deps.scheduleFrame ?? defaultScheduleFrame;

  let pendingView: ChatStreamView | null = null;
  let frameId = 0;

  const claimPending = (): ChatStreamView | null => {
    const view = pendingView;
    pendingView = null;
    return view;
  };

  const deliver = () => {
    frameId = 0;
    const view = claimPending();
    if (view) {
      deps.commit(view);
    }
  };

  return {
    push(event) {
      if (!types.has(event.type)) {
        // Structural or terminal event: land the queue first, then apply it on top,
        // so ordering between queued deltas and this event is never reordered.
        const queued = claimPending();
        if (frameId) {
          cancelFrame(frameId);
        }
        if (queued) {
          deps.commit(queued);
        }

        const base = deps.baseView();
        if (!base) {
          return;
        }

        const next = deps.project(base, event);
        if (next === base) {
          // The projection moved nothing: committing anyway would hand React a fresh
          // array identity and rebuild the whole thread for an event that changed no
          // content (an unaddressable event, a duplicate snapshot).
          return;
        }

        deps.commit(next);
        return;
      }

      const base = pendingView ?? deps.baseView();
      if (!base) {
        return;
      }

      const next = deps.project(base, event);
      if (next === base) {
        // Nothing moved; do not schedule a frame for it.
        return;
      }

      pendingView = next;
      if (!frameId) {
        frameId = scheduleFrame(deliver);
      }
    },
    flush() {
      if (frameId) {
        cancelFrame(frameId);
      }
      const queued = claimPending();
      if (queued) {
        deps.commit(queued);
      }
    },
    hasPending() {
      return pendingView !== null;
    },
  };
}
