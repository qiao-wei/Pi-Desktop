/**
 * Collapse-gate policy: when is it safe to release a disclosure's height?
 *
 * Auto-collapse is the whole point of the process group (a settled turn should
 * read as an answer, not as a transcript), but releasing hundreds of pixels of
 * height *inside* the reader's viewport moves the text they were looking at -
 * which is exactly what a reader who scrolled up during a run notices the moment
 * a thinking panel or a tool call settles. Nothing else covers that: the
 * completion lock in `ChatThread` only runs in the commit that *ends* the run, and
 * pinning the message root cannot see a panel collapsing inside the root anyway.
 *
 * So the decision is made from geometry alone and lives here, free of the DOM:
 * collapse only where nobody can see it happen.
 *
 * - Below the fold: the removed height is under the viewport, the visible band
 *   is untouched.
 * - Anywhere, while pinned at the end: the browser clamps `scrollTop` to the
 *   shortened range and the newest line stays put.
 * - Anything else (the block overlaps the viewport, or it sits above a reader
 *   who is holding a mid-thread position): hold the height until they scroll
 *   somewhere it is safe to release.
 *
 * `collapseKeepsHeight` never writes to the scroll container - that is the
 * point. Deferring the commit is what lets this stay entirely read-only, so it
 * cannot fight the viewport owner, the entry restore window, or a flick that is
 * still being committed on the compositor.
 */

/** Matches the "at the end" tolerance the thread viewport uses. */
export const COLLAPSE_GATE_TOLERANCE_PX = 4;

/** Everything the gate needs to know, in viewport coordinates. */
export type CollapseGateGeometry = {
  /** Top edge of the disclosure being collapsed (trigger included). */
  blockTop: number;
  /** Bottom edge of the same element. */
  blockBottom: number;
  /** Visible band of the scroll container it lives in. */
  containerTop: number;
  containerBottom: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** Distance still remaining between the container and its end. */
export function distanceToBottom(
  geometry: Pick<CollapseGateGeometry, "scrollTop" | "scrollHeight" | "clientHeight">,
): number {
  return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
}

/**
 * Can this disclosure release its height right now without the reader seeing
 * anything move?
 *
 * The reader's contract differs by where they are holding the thread:
 *
 * - Pinned at the end (following the run): always yes. `scrollTop` clamps to the
 *   shortened range, so the newest line - the one they are watching - stays put
 *   and the run tidies itself up the moment it settles, exactly as it did before
 *   this gate existed.
 * - Elsewhere (they scrolled up to read something), the removed height has to be
 *   out of the visible band: only wholly below the fold leaves their text alone.
 *   Above the fold the removal drags their line up; overlapping it moves it at
 *   all. Both wait for a scroll that makes the collapse invisible.
 */
export function canCommitCollapse(
  geometry: CollapseGateGeometry,
  tolerance = COLLAPSE_GATE_TOLERANCE_PX,
): boolean {
  // Following the tail: nothing they are reading is held at a fixed offset, so
  // the collapse is a tidy-up rather than a jump (and the clamping case the
  // below-the-fold rule below would otherwise special-case).
  if (distanceToBottom(geometry) <= tolerance) {
    return true;
  }
  // Wholly below the fold: nothing above it shifts, whoever is reading.
  if (geometry.blockTop >= geometry.containerBottom - tolerance) {
    return true;
  }
  // Anything else - overlapping the viewport, or above a reader parked
  // mid-thread: hold the height until they scroll somewhere it is safe to release.
  return false;
}

/**
 * Should the gate keep a disclosure whose intent is already closed?
 * The inverse of {@link canCommitCollapse}, named for how the caller uses it.
 */
export function shouldHoldCollapsed(
  geometry: CollapseGateGeometry,
  tolerance = COLLAPSE_GATE_TOLERANCE_PX,
): boolean {
  return !canCommitCollapse(geometry, tolerance);
}

/**
 * The whole decision a deferred-collapse hook has to make, without React or the
 * DOM: render what the state machine wants, or keep the current (taller) layout?
 *
 * `geometry` is measured from the DOM *before* the commit that would shrink it -
 * judging the shrunken box instead classifies the collapse by where the block
 * ended up rather than where the reader was looking at it. `null` means there is
 * nothing to judge yet (the ref has not attached, or the block is detached or
 * outside every scroll container), which holds: the caller re-judges in a layout
 * effect as soon as the block has geometry, so a block that turns out to be
 * safely off screen still collapses before it ever paints.
 */
export function shouldHoldDisclosure(input: {
  /** What the disclosure wants to render (running → open, settled → closed). */
  desiredOpen: boolean;
  /** The reader toggled it by hand; their choice outranks the auto-collapse. */
  manual?: boolean;
  geometry: CollapseGateGeometry | null;
  tolerance?: number;
}): boolean {
  if (input.desiredOpen || input.manual) {
    return false;
  }
  if (input.geometry === null) {
    return true;
  }
  return shouldHoldCollapsed(input.geometry, input.tolerance);
}
