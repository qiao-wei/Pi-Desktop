import { useLayoutEffect, type RefObject } from "react";

import { perfEnabled, perfSpan } from "../../lib/perf";

/**
 * 一轮结束时的「补一次滚动」：
 *
 * Completed-process grouping changes the DOM structure at the exact moment a run
 * ends. Hold the reader's place through that reflow using the snapshot the
 * throttled persistence already captured, so this stays off the per-token path.
 *
 * 从 `ChatThread.tsx` 搬出来（`max-lines` 棘轮）：那段是自成一体的一个 layout
 * effect，只和视口、流式状态、以及 viewport owner 里的三个 ref 说话。
 */

/** How long the end-of-run reflow lock stays armed. */
const COMPLETION_LOCK_MS = 280;

/**
 * Snapshot of the viewport taken while the run was still streaming. It is
 * refreshed by the throttled persistence pass, so it costs nothing per token.
 */
export type ViewportSnapshot = {
  scrollTop: number;
  wasAtBottom: boolean;
  anchor: Element | null;
  anchorTop: number | null;
  /** The message root the anchor belongs to - the fallback if the block is gone. */
  anchorRoot: Element | null;
  anchorRootTop: number | null;
};

/**
 * How many message roots are inside the viewport container right now. Reported
 * with the entry-restoration and end-of-run lock windows so a long frame can be
 * attributed to the browser laying out a suddenly-larger subtree.
 */
export function viewportRootCount(viewport: HTMLElement): number {
  return perfEnabled ? viewport.querySelectorAll("[data-message-id]").length : 0;
}

export function useCompletionScrollLock({
  viewportRef,
  isStreaming,
  snapshotRef,
  cleanupRef,
  wasStreamingRef,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  isStreaming: boolean;
  snapshotRef: RefObject<ViewportSnapshot | null>;
  cleanupRef: RefObject<(() => void) | null>;
  wasStreamingRef: RefObject<boolean>;
}) {
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const previousSnapshot = snapshotRef.current;
    if (
      !wasStreamingRef.current ||
      isStreaming ||
      !previousSnapshot ||
      previousSnapshot.wasAtBottom
    ) {
      wasStreamingRef.current = isStreaming;
      return;
    }

    cleanupRef.current?.();

    const previousScrollBehavior = viewport.style.scrollBehavior;
    const previousOverflowAnchor = viewport.style.overflowAnchor;
    const previousScrollTo = viewport.scrollTo;
    const previousScrollBy = viewport.scrollBy;
    const anchor = previousSnapshot.anchor;
    const anchorTop = previousSnapshot.anchorTop;
    const anchorRoot = previousSnapshot.anchorRoot;
    const anchorRootTop = previousSnapshot.anchorRootTop;
    /**
     * Push the surviving text back under the reader's eyes.
     *
     * The refined anchor is a paragraph of the answer: when the 过程 group above
     * it releases its height, this delta is exactly that removal, so the visible
     * line does not move. A block that the rewrap destroyed falls back to its
     * message root (coarser, but it is what the previous behaviour had), and only
     * if even that is gone do we restore the absolute offset.
     */
    const holdPosition = () => {
      if (anchor?.isConnected && anchorTop !== null) {
        viewport.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
        return;
      }
      if (anchorRoot?.isConnected && anchorRootTop !== null) {
        viewport.scrollTop += anchorRoot.getBoundingClientRect().top - anchorRootTop;
        return;
      }
      viewport.scrollTop = previousSnapshot.scrollTop;
    };
    let active = true;
    let frame = 0;

    viewport.style.scrollBehavior = "auto";
    viewport.dataset.viewportLocking = "true";
    let lockSpan: ReturnType<typeof perfSpan> | null = perfSpan("viewport.cvLock");
    viewport.style.overflowAnchor = "none";
    viewport.scrollTo = (() => undefined) as typeof viewport.scrollTo;
    viewport.scrollBy = (() => undefined) as typeof viewport.scrollBy;

    const restore = () => {
      if (!active) {
        return;
      }
      holdPosition();
      frame = requestAnimationFrame(restore);
    };
    restore();

    const finish = () => {
      active = false;
      cancelAnimationFrame(frame);
      holdPosition();
      viewport.scrollTo = previousScrollTo;
      viewport.scrollBy = previousScrollBy;
      viewport.style.scrollBehavior = previousScrollBehavior;
      viewport.style.overflowAnchor = previousOverflowAnchor;
      delete viewport.dataset.viewportLocking;
      endLockSpan();
      cleanupRef.current = null;
    };
    const endLockSpan = () => {
      lockSpan?.({ nodes: viewportRootCount(viewport) });
      lockSpan = null;
    };
    const timeoutId = window.setTimeout(finish, COMPLETION_LOCK_MS);
    cleanupRef.current = () => {
      active = false;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeoutId);
      viewport.scrollTo = previousScrollTo;
      viewport.scrollBy = previousScrollBy;
      viewport.style.scrollBehavior = previousScrollBehavior;
      viewport.style.overflowAnchor = previousOverflowAnchor;
      delete viewport.dataset.viewportLocking;
      endLockSpan();
      cleanupRef.current = null;
    };
    wasStreamingRef.current = isStreaming;
  }, [cleanupRef, isStreaming, snapshotRef, viewportRef, wasStreamingRef]);
}
