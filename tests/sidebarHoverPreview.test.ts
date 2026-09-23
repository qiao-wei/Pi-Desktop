/**
 * Unit tests for the sidebar hover-preview helpers ported from codex-ui.
 *
 * These two rules carry real behaviour — a card that overlaps the sidebar or runs off
 * screen is unusable, and a wrong relative time is a lie — so they live in a pure module
 * and are tested directly instead of through App.tsx (a .tsx file `node --test` cannot import).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SIDEBAR_PROJECT_CARD_HEIGHT,
  SIDEBAR_PROJECT_CARD_WIDTH,
  SIDEBAR_SESSION_CARD_HEIGHT,
  SIDEBAR_SESSION_CARD_WIDTH,
  formatSidebarRelativeTime,
  formatSidebarSessionCount,
  placeSidebarHoverCard,
  pointerKeepsSidebarCardOpen,
  sidebarSessionPreview,
} from "../src/shared/sidebarHoverPreview.ts";

const sessionBounds = {
  viewportWidth: 1400,
  viewportHeight: 900,
  sidebarRight: 300,
  cardWidth: SIDEBAR_SESSION_CARD_WIDTH,
  cardHeight: SIDEBAR_SESSION_CARD_HEIGHT,
};

test("card opens just outside the sidebar, level with the row", () => {
  const placement = placeSidebarHoverCard({ top: 100, left: 200, right: 300 }, sessionBounds);

  assert.equal(placement.side, "right");
  assert.equal(placement.x, 308);
  assert.equal(placement.y, 100 - 4);
});

test("card never overlaps the sidebar even when the row is narrower", () => {
  const placement = placeSidebarHoverCard({ top: 100, left: 12, right: 60 }, sessionBounds);

  // 60 + 8 = 68 would sit on top of the list; the sidebar's right edge wins.
  assert.equal(placement.x, 308);
});

test("card flips to the row's left when the right side would run off screen", () => {
  const placement = placeSidebarHoverCard(
    { top: 100, left: 1000, right: 1100 },
    { ...sessionBounds, viewportWidth: 1200, sidebarRight: 1100 },
  );

  assert.equal(placement.side, "left");
  assert.equal(placement.x, 1000 - 8 - SIDEBAR_SESSION_CARD_WIDTH);
  assert.ok(placement.x + SIDEBAR_SESSION_CARD_WIDTH <= 1000 - 8);
});

test("card is clamped to the viewport top and bottom", () => {
  assert.equal(placeSidebarHoverCard({ top: 2, left: 200, right: 300 }, sessionBounds).y, 8);

  const bottom = placeSidebarHoverCard({ top: 890, left: 200, right: 300 }, sessionBounds);
  assert.equal(bottom.y, 900 - SIDEBAR_SESSION_CARD_HEIGHT - 8);
});

test("wider project card uses its own width and flips earlier", () => {
  const bounds = {
    viewportWidth: 900,
    viewportHeight: 700,
    sidebarRight: 300,
    cardWidth: SIDEBAR_PROJECT_CARD_WIDTH,
    cardHeight: SIDEBAR_PROJECT_CARD_HEIGHT,
  };

  // 300 + 8 + 300 = 608 < 892, still fits on the right.
  assert.equal(placeSidebarHoverCard({ top: 200, left: 100, right: 300 }, bounds).side, "right");

  // A row whose right edge is at 700 would push the 300px card past 892.
  const flipped = placeSidebarHoverCard({ top: 200, left: 640, right: 700 }, bounds);
  assert.equal(flipped.side, "left");
  assert.equal(flipped.x, 640 - 8 - SIDEBAR_PROJECT_CARD_WIDTH);
});

test("relative time is compact and monotonic", () => {
  const now = 1_700_000_000_000;
  const at = (ms: number) => formatSidebarRelativeTime(now - ms, now);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  assert.equal(at(0), "now");
  assert.equal(at(30_000), "now");
  assert.equal(at(5 * minute), "5m");
  assert.equal(at(59 * minute), "59m");
  assert.equal(at(hour), "1h");
  assert.equal(at(23 * hour), "23h");
  assert.equal(at(day), "1d");
  assert.equal(at(6 * day), "6d");
  assert.equal(at(10 * day), "1w");
  assert.equal(at(45 * day), "1mo");
  assert.equal(at(400 * day), "1y");
});

test("relative time is empty for missing or future timestamps", () => {
  const now = 1_700_000_000_000;

  assert.equal(formatSidebarRelativeTime(0, now), "");
  assert.equal(formatSidebarRelativeTime(Number.NaN, now), "");
  assert.equal(formatSidebarRelativeTime(now + 60_000, now), "now");
});

test("session count pluralises", () => {
  assert.equal(formatSidebarSessionCount(0), "0 sessions");
  assert.equal(formatSidebarSessionCount(1), "1 session");
  assert.equal(formatSidebarSessionCount(4), "4 sessions");
  assert.equal(formatSidebarSessionCount(Number.NaN), "0 sessions");
});

test("session preview prefers the first message and falls back to the title", () => {
  assert.equal(sidebarSessionPreview("Refactor auth", "  please rewrite the login flow "), "please rewrite the login flow");
  assert.equal(sidebarSessionPreview("Refactor auth", "   "), "Refactor auth");
  assert.equal(sidebarSessionPreview("Refactor auth"), "Refactor auth");
});

// The sidebar row (left, inside the sidebar) and its fixed card (right, beside it) with the
// real 8px gap: the pointer crossing that gap is over neither of them.
const hoverRow = { top: 100, left: 11, right: 271, bottom: 132 };
const hoverCard = { top: 96, left: 289, right: 547, bottom: 260 };

test("the pointer keeps the card open on the card, on the row, and in the gap between them", () => {
  assert.equal(pointerKeepsSidebarCardOpen(400, 180, [hoverCard, hoverRow]), true, "on the card");
  assert.equal(pointerKeepsSidebarCardOpen(140, 116, [hoverCard, hoverRow]), true, "on the row");
  assert.equal(pointerKeepsSidebarCardOpen(280, 116, [hoverCard, hoverRow]), true, "in the gap");
  // Vertically level with neither band: the corridor must not become an infinite runway.
  assert.equal(pointerKeepsSidebarCardOpen(280, 600, [hoverCard, hoverRow]), false, "below both");
  assert.equal(pointerKeepsSidebarCardOpen(700, 116, [hoverCard, hoverRow]), false, "past the card");
});

test("the pointer keeps the card open when it works the flipped (left) placement", () => {
  const flippedCard = { top: 96, left: 8, right: 266, bottom: 260 };
  const flippedRow = { top: 100, left: 289, right: 549, bottom: 132 };

  assert.equal(pointerKeepsSidebarCardOpen(280, 116, [flippedCard, flippedRow]), true, "gap on the left");
  assert.equal(pointerKeepsSidebarCardOpen(500, 116, [flippedCard, flippedRow]), true, "on the flipped row");
  assert.equal(pointerKeepsSidebarCardOpen(400, 600, [flippedCard, flippedRow]), false, "below both");
});

test("missing rects never keep a card open", () => {
  assert.equal(pointerKeepsSidebarCardOpen(140, 116, []), false);
  assert.equal(pointerKeepsSidebarCardOpen(140, 116, [null, undefined]), false);
  assert.equal(pointerKeepsSidebarCardOpen(140, 116, [hoverRow, undefined]), true, "one live rect is enough");
});