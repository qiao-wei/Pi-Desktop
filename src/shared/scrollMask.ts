/**
 * Vertical scroll affordances for a fixed-height text viewport: the "is the reader at
 * the bottom" test that decides whether new text may keep pulling the viewport down,
 * and the fading edge that says "there is more above / below".
 *
 * Pure geometry so it can be tested without a layout: ZCode's reasoning body
 * (`packages/ui/src/mentions/components/scrollMask.ts`) works the same way, and its
 * constants are the ones used here.
 */

import type { CSSProperties } from "react";

/** How close to the bottom still counts as "at the bottom". */
export const SCROLL_BOTTOM_LOCK_PX = 4;
const MASK_EDGE_PX = 24;
const MASK_THRESHOLD_PX = 1;

export interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface ScrollMaskState {
  showTop: boolean;
  showBottom: boolean;
}

export const EMPTY_SCROLL_MASK_STATE: ScrollMaskState = {
  showTop: false,
  showBottom: false,
};

/** Distance from the bottom of the scrollable content, never negative. */
export function scrollBottomDistance({ clientHeight, scrollHeight, scrollTop }: ScrollMetrics): number {
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

/**
 * Whether the viewport is parked at the end of the content.
 *
 * This is the *only* thing that may stop auto-follow: a reader who scrolled up is
 * reading, and yanking them back to the newest token is the bug this guards against.
 */
export function isScrolledToBottom(metrics: ScrollMetrics): boolean {
  return scrollBottomDistance(metrics) <= SCROLL_BOTTOM_LOCK_PX;
}

/** Which fading edges the viewport needs right now. */
export function scrollMaskState({
  clientHeight,
  scrollHeight,
  scrollTop,
}: ScrollMetrics): ScrollMaskState {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (maxScrollTop <= MASK_THRESHOLD_PX) {
    return EMPTY_SCROLL_MASK_STATE;
  }
  return {
    showTop: scrollTop > MASK_THRESHOLD_PX,
    showBottom: scrollTop < maxScrollTop - MASK_THRESHOLD_PX,
  };
}

/** The mask image for those edges, or `undefined` when nothing is clipped. */
export function scrollMaskStyle({ showBottom, showTop }: ScrollMaskState): CSSProperties | undefined {
  if (!showTop && !showBottom) {
    return undefined;
  }
  const topStop = showTop
    ? `transparent 0px, black ${MASK_EDGE_PX}px`
    : `black 0px, black ${MASK_EDGE_PX}px`;
  const bottomStop = showBottom
    ? `black calc(100% - ${MASK_EDGE_PX}px), transparent 100%`
    : `black calc(100% - ${MASK_EDGE_PX}px), black 100%`;
  const maskImage = `linear-gradient(to bottom, ${topStop}, ${bottomStop})`;
  return {
    WebkitMaskImage: maskImage,
    maskImage,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
  };
}