/**
 * Geometry and copy for the sidebar's hover preview cards (ported from codex-ui's
 * `.chat-tip` / `.project-tip`).
 *
 * The two rules that are easy to get wrong — which side the card opens on, and how
 * long "how long ago" is worded — live here instead of inside `App.tsx` so they can be
 * unit tested without a DOM.
 */

/** Session card ("description" tip): narrower, non-interactive. */
export const SIDEBAR_SESSION_CARD_WIDTH = 258;
export const SIDEBAR_SESSION_CARD_HEIGHT = 136;
/** Project card: roomier and interactive (pin toggle / Edit project). */
export const SIDEBAR_PROJECT_CARD_WIDTH = 300;
export const SIDEBAR_PROJECT_CARD_HEIGHT = 168;

/** Distance between the row and its card. */
export const SIDEBAR_CARD_GAP = 8;
/** Minimum distance the card keeps from the viewport edges. */
export const SIDEBAR_CARD_MARGIN = 8;
/** Slack around the card/row while the pointer decides whether the card stays. */
export const SIDEBAR_CARD_HOVER_SLACK = 4;
/** Slack above the row: the card sits slightly higher than the row it describes. */
const SIDEBAR_CARD_ROW_OFFSET = 4;

export type SidebarHoverCardAnchor = {
  top: number;
  left: number;
  right: number;
};

export type SidebarHoverCardBounds = {
  viewportWidth: number;
  viewportHeight: number;
  /** Right edge of the sidebar itself: the card must clear the list it describes. */
  sidebarRight: number;
  cardWidth: number;
  cardHeight: number;
};

export type SidebarHoverCardPlacement = {
  x: number;
  y: number;
  /** Which side of the sidebar the card ended up on, after the viewport flip. */
  side: "right" | "left";
};

/**
 * Places a fixed-position card next to a sidebar row:
 * opens to the right of the sidebar, flips to the row's left when the right side would
 * run off screen, and is clamped to the viewport on both axes.
 */
export function placeSidebarHoverCard(
  anchor: SidebarHoverCardAnchor,
  bounds: SidebarHoverCardBounds,
): SidebarHoverCardPlacement {
  let side: SidebarHoverCardPlacement["side"] = "right";
  let x = Math.max(anchor.right + SIDEBAR_CARD_GAP, bounds.sidebarRight + SIDEBAR_CARD_GAP);
  if (x + bounds.cardWidth > bounds.viewportWidth - SIDEBAR_CARD_MARGIN) {
    side = "left";
    x = Math.max(SIDEBAR_CARD_MARGIN, anchor.left - SIDEBAR_CARD_GAP - bounds.cardWidth);
  }

  const y = Math.max(
    SIDEBAR_CARD_MARGIN,
    Math.min(
      anchor.top - SIDEBAR_CARD_ROW_OFFSET,
      bounds.viewportHeight - bounds.cardHeight - SIDEBAR_CARD_MARGIN,
    ),
  );

  return { x: Math.round(x), y: Math.round(y), side };
}

/** Viewport rect of anything that should keep an open card alive. */
export type SidebarHoverRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
};

function pointInSidebarRect(x: number, y: number, rect: SidebarHoverRect, slack: number): boolean {
  return (
    x >= rect.left - slack &&
    x <= rect.right + slack &&
    y >= rect.top - slack &&
    y <= rect.bottom + slack
  );
}

/**
 * Horizontal/vertical corridor between two rects — the gap between the sidebar row and its
 * card (`SIDEBAR_CARD_GAP` wide). The pointer crosses it on the way to the card, and during
 * that crossing it is over neither the row nor the card, so the corridor has to count as
 * "still on the card" or the card vanishes before it can be reached.
 */
function sidebarHoverBridge(a: SidebarHoverRect, b: SidebarHoverRect): SidebarHoverRect {
  return {
    left: Math.min(a.right, b.right),
    right: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

/**
 * While a card is open, the pointer decides whether it stays: the card is rendered beside
 * the sidebar (`position: fixed`, outside the scrolling list) and the row that opened it is
 * inside it, so the pointer has to cross a gap between the two. DOM containment cannot
 * answer "is the pointer still on the card" — `mouseleave` fires the instant the pointer
 * crosses that gap, which is the bug this exists to avoid. Coordinates can.
 *
 * `rects` is normally `[cardRect, rowRect]`; any pair also contributes its bridge corridor.
 */
export function pointerKeepsSidebarCardOpen(
  x: number,
  y: number,
  rects: ReadonlyArray<SidebarHoverRect | null | undefined>,
  slack = SIDEBAR_CARD_HOVER_SLACK,
): boolean {
  const live = rects.filter((rect): rect is SidebarHoverRect => Boolean(rect));

  for (const rect of live) {
    if (pointInSidebarRect(x, y, rect, slack)) {
      return true;
    }
  }

  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      if (pointInSidebarRect(x, y, sidebarHoverBridge(live[i], live[j]), slack)) {
        return true;
      }
    }
  }

  return false;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Compact "how long ago" for the session card: `now`, `5m`, `3h`, `2d`, `1w`, `3mo`.
 * Future or missing timestamps collapse to `""` so the card omits the row instead of
 * claiming a negative age.
 */
export function formatSidebarRelativeTime(updatedAt: number, now = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return "";
  }

  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < MINUTE) {
    return "now";
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h`;
  }
  if (elapsed < WEEK) {
    return `${Math.floor(elapsed / DAY)}d`;
  }
  if (elapsed < MONTH) {
    return `${Math.floor(elapsed / WEEK)}w`;
  }
  if (elapsed < YEAR) {
    return `${Math.floor(elapsed / MONTH)}mo`;
  }
  return `${Math.floor(elapsed / YEAR)}y`;
}

/** Project card line: `1 session` / `4 sessions`. */
export function formatSidebarSessionCount(count: number): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `${safe} ${safe === 1 ? "session" : "sessions"}`;
}

/**
 * The card body is a single clamped paragraph; prefer the first user message (what the
 * conversation is actually about) and fall back to the title.
 */
export function sidebarSessionPreview(title: string, firstMessage?: string): string {
  const preview = firstMessage?.trim();
  if (preview) {
    return preview;
  }
  return title.trim();
}