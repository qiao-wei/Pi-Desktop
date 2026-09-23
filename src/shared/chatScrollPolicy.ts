/**
 * Scroll-restoration policy, kept free of DOM so it can be tested.
 *
 * Two rules live here. Both exist because switching sessions re-measures a
 * thread whose height is still changing: rows mount a commit after the container
 * and markdown settles over the next few frames, so the bottom of the list moves
 * by a pixel or two per frame while the real geometry replaces the empty one.
 *
 * - {@link nextScrollTarget} absorbs that micro-drift instead of chasing it:
 *   writing the viewport every frame is the jitter readers see.
 * - {@link nextStableFrames} ends the restore window as soon as the layout has
 *   settled, so a short thread does not spend three quarters of a second in the
 *   forced-layout "loading" state.
 */

/** Anything smaller than this is layout noise, not a position the reader lost. */
export const SCROLL_DEADBAND_PX = 2;

/** How many consecutive unchanged frames count as "the layout has settled". */
export const SETTLED_FRAMES = 4;

/**
 * The scroll offset to write, or `null` to leave the viewport alone.
 *
 * `target` is where the reader should end up; it is clamped into the
 * scrollable range first, because the range itself is what is still moving.
 */
export function nextScrollTarget(
  current: number,
  target: number,
  maxScrollTop: number,
  deadband: number = SCROLL_DEADBAND_PX,
): number | null {
  const upper = Math.max(0, maxScrollTop);
  const clamped = Math.max(0, Math.min(target, upper));
  return Math.abs(clamped - current) > deadband ? clamped : null;
}

/**
 * Count of consecutive frames during which the scrollable height did not move
 * by more than `tolerance`. Reset on any real growth (a streamed token, an
 * image that finished loading), which is exactly when the window must stay open.
 */
export function nextStableFrames(
  previousMax: number | null,
  currentMax: number,
  frames: number,
  tolerance = 1,
): number {
  if (previousMax !== null && Math.abs(currentMax - previousMax) <= tolerance) {
    return frames + 1;
  }
  return 1;
}

/** Whether the restore window has watched the layout sit still long enough. */
export function isLayoutSettled(stableFrames: number): boolean {
  return stableFrames >= SETTLED_FRAMES;
}

/**
 * How far to move the viewport so a reflow leaves the reading line where it was.
 *
 * `anchorTopNow` is the anchor's current distance from the viewport top and
 * `anchorTopBefore` the same number measured in the old layout. A window resize
 * (double-clicking the title bar, a maximise animation) reflows the thread: the
 * browser clamps `scrollTop` while the scrollport grows and rewrap moves every
 * block, so the raw offset stops meaning "the line I was reading". Writing this
 * delta back each frame is what keeps that line still.
 *
 * Returns `null` when there is nothing to correct - no anchor, or the drift is
 * inside the layout-noise deadband.
 */
export function anchorScrollCorrection(
  anchorTopNow: number | null,
  anchorTopBefore: number | null,
  deadband: number = SCROLL_DEADBAND_PX,
): number | null {
  if (anchorTopNow === null || anchorTopBefore === null) {
    return null;
  }
  const delta = anchorTopNow - anchorTopBefore;
  return Math.abs(delta) > deadband ? delta : null;
}

/** How far above the end of the thread still counts as "at the end". */
export const BOTTOM_TOLERANCE_PX = 4;

/** A block that merely brushes the edge of the band is not what is being read. */
export const ANCHOR_EDGE_PX = 2;

/**
 * A candidate top-level block of a bubble, in document order.
 *
 * `hasDisclosure` marks anything that contains (or is) a thinking panel, a tool
 * card or the 过程 group - blocks whose height the run settles by collapsing
 * them. They make bad anchors: the whole point of the completion lock is to keep
 * the *surviving* text where the reader left it.
 */
export type AnchorCandidate = {
  top: number;
  bottom: number;
  hasDisclosure: boolean;
};

/**
 * The block the completion lock should pin the reading position to.
 *
 * The message root is too coarse: the 过程 group collapses *inside* a bubble, so
 * the root's top edge does not move while every paragraph under it does (and the
 * root stays connected, so the lock would happily pin the wrong number). The
 * cheapest claim that survives that reflow is the topmost block of the bubble
 * which is still on screen and is not itself collapsible - the answer text. Its
 * top is exactly what the collapse drags away, so writing it back is what keeps
 * the reader's line still.
 *
 * Returns the index into `candidates`, or `null` when the visible band holds no
 * such block (the reader is looking at a card, or at the gap between bubbles) and
 * the caller should fall back to the message root.
 */
export function pickAnchorBlock(
  candidates: readonly AnchorCandidate[],
  band: { top: number; bottom: number },
  edgePx = ANCHOR_EDGE_PX,
): number | null {
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (candidate.hasDisclosure) {
      continue;
    }
    if (candidate.bottom > band.top + edgePx && candidate.top < band.bottom - edgePx) {
      return index;
    }
  }
  return null;
}

/**
 * Is the reader still at the end of the thread, i.e. still following the run?
 *
 * Returns `null` when the geometry cannot answer yet: right after a session
 * switch the previous thread is unmounted and the new one is not laid out, so
 * the scroller is empty (`maxScrollTop` 0, or a few pixels of estimated height).
 * Reading that as "not at the end" would cancel the follow the reader asked for
 * by leaving the session at its bottom, and the next visit would land at some
 * stale offset instead.
 */
export function followingFromGeometry(input: {
  scrollTop: number;
  maxScrollTop: number;
  hasContent: boolean;
  tolerancePx?: number;
}): boolean | null {
  const { scrollTop, maxScrollTop, hasContent, tolerancePx = BOTTOM_TOLERANCE_PX } = input;
  if (!hasContent || maxScrollTop <= 1) {
    return null;
  }
  return maxScrollTop - scrollTop <= tolerancePx;
}

/**
 * Resolve the raw geometry verdict into the follow flag to store.
 *
 * Geometry alone lies in one direction: while the thread is being laid out (or a
 * run keeps appending), the goalposts move without any scroll, so a reader who
 * never left the bottom reads as "not at the end" (observed: a saved bottom
 * position stopped 523px short because a later auto-persist dropped the follow).
 * A reader who *is* following therefore keeps following through that - but only
 * while the thread is actually growing and only when they have not touched it
 * recently. Without the growth gate the flag becomes sticky for good, and any
 * non-wheel scroll to the middle of the thread (dragging the scrollbar, clicking
 * the track) spends the rest of the session one layout change away from being
 * yanked back to the bottom. The grace window has to outlast the trailing
 * persist (400ms > the 200ms debounce), otherwise the write that lands right
 * after a wheel burst would look like "no user input" and pin the reader down.
 */
export function resolveFollowing(input: {
  derived: boolean | null;
  following: boolean;
  grew: boolean;
  userInputAgeMs: number;
  graceMs: number;
}): boolean | null {
  const { derived, following, grew, userInputAgeMs, graceMs } = input;
  if (derived === null) {
    return null;
  }
  if (derived) {
    return true;
  }
  if (!following) {
    return false;
  }
  return grew && userInputAgeMs > graceMs;
}

/**
 * Should the entry window (the "don't touch my position, I'm still laying this
 * thread out" lock) close?
 *
 * Two separate clocks, because a session switch produces two separate commits:
 * ours paints the container, and assistant-ui mounts the message rows a tick
 * *later*. Closing as soon as the height stops moving therefore ends the window
 * while the thread is still the near-empty frame readers see on a switch, because
 * the rows have not been laid out yet. So the window is only considered after
 * `rowsMountedAt`, and the row-less case is bounded by a grace cap.
 */
export function shouldCloseEntryWindow(input: {
  now: number;
  openedAt: number;
  rowsMountedAt: number | null;
  stableFrames: number;
  minOpenMs: number;
  windowMs: number;
  rowsGraceMs: number;
}): boolean {
  const { now, openedAt, rowsMountedAt, stableFrames, minOpenMs, windowMs, rowsGraceMs } = input;
  if (rowsMountedAt === null) {
    return now >= openedAt + windowMs + rowsGraceMs;
  }
  const settled = isLayoutSettled(stableFrames) && now - rowsMountedAt >= minOpenMs;
  return settled || now >= rowsMountedAt + windowMs;
}
