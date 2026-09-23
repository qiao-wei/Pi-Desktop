/**
 * Sidebar action icons (project "…" menu, new session, pin, delete) must be invisible
 * until the pointer hovers the row.
 *
 * Rather than asserting the whole className string in App.tsx (which would freeze
 * implementation details), this pins the two things that actually carry the behaviour:
 * 1. the shared utility itself — hidden by default, revealed by row hover / focus inside
 *    the row / its own dropdown being open, and it survives the merge with the sidebar
 *    button base (`disabled:opacity-50`) and the switch-lock override;
 * 2. that the sidebar rows are wired to it: every action container needs a `group` row
 *    ancestor, and nothing may force the icons visible again for the active row.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sidebarHoverActionClass } from "../src/shared/sidebarActionVisibility.ts";
import { sidebarSwitchLockClass } from "../src/shared/projectSidebarLock.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** Source of a top-level `function name(...) { ... }`, delimited at the next flush-left brace. */
function topLevelFunctionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = appSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return appSource.slice(start, end);
}

test("action icons are hidden by default", () => {
  const utilities = sidebarHoverActionClass.split(/\s+/);

  assert.ok(utilities.includes("opacity-0"), "expected a base opacity-0");
  assert.ok(
    !utilities.some((utility) => !utility.includes(":") && utility.endsWith("opacity-100")),
    "a bare opacity-100 would show the icons all the time",
  );
});

test("row hover, keyboard focus and an open dropdown reveal them", () => {
  assert.match(sidebarHoverActionClass, /(^|\s)group-hover:opacity-100(\s|$)/);
  assert.match(sidebarHoverActionClass, /(^|\s)group-has-\[:focus-visible\]:opacity-100(\s|$)/);
  // Radix moves focus to a portal menu, so no focus-inside-the-row survives that. The class now
  // lives on a wrapper around the trigger, so the open state has to be seen through `:has`.
  assert.match(sidebarHoverActionClass, /(^|\s)group-has-\[\[data-state=open\]\]:opacity-100(\s|$)/);
  assert.match(sidebarHoverActionClass, /(^|\s)data-\[state=open\]:opacity-100(\s|$)/);
  assert.match(sidebarHoverActionClass, /(^|\s)transition-opacity(\s|$)/);
});

test("a mouse click on the row does not pin the icons open", () => {
  // `:focus-within` also matches the *mouse* focus a clicked row keeps, which left the icons
  // visible until the user clicked somewhere else — reveal must key off keyboard focus only.
  assert.doesNotMatch(sidebarHoverActionClass, /group-focus-within:opacity/);
  assert.match(sidebarHoverActionClass, /:focus-visible/);
});

test("hiding does not remove the buttons from layout", () => {
  // opacity keeps the grid slot reserved; display/visibility utilities would reflow the row.
  assert.doesNotMatch(sidebarHoverActionClass, /\b(hidden|invisible|sr-only|display-none)\b/);
});

test("merging with the sidebar button and the switch lock keeps every modifier", async () => {
  const { cn } = await import("../src/lib/utils.ts");

  // `buttonVariants` base utilities that touch opacity; the component itself is .tsx and
  // therefore not importable under `node --test` type stripping.
  const buttonBase = "inline-flex transition-all disabled:pointer-events-none disabled:opacity-50";
  const merged = cn(buttonBase, cn(sidebarHoverActionClass, sidebarSwitchLockClass));

  assert.match(merged, /(^|\s)opacity-0(\s|$)/);
  assert.match(merged, /(^|\s)group-hover:opacity-100(\s|$)/);
  assert.match(merged, /(^|\s)group-has-\[:focus-visible\]:opacity-100(\s|$)/);
  assert.match(merged, /(^|\s)disabled:opacity-100(\s|$)/, "switch lock must not dim the row");
  assert.doesNotMatch(merged, /(^|\s)invisible(\s|$)/);
});

test("project rows and session rows both use the shared rule with a group ancestor", () => {
  assert.match(appSource, /sidebarHoverActionClass/);

  // Project row: the wrapper owns `group` + `relative`; the actions sit in ONE hover-only
  // wrapper pinned to the row's right edge, so the label only gives up space on hover.
  const projectRow = topLevelFunctionSource("ProjectSidebar");
  assert.match(projectRow, /className="group relative"/, "project row lost its `group` hover ancestor");
  assert.equal(
    [...projectRow.matchAll(/sidebarHoverActionClass/g)].length,
    1,
    "the project actions should be hidden by a single wrapper",
  );
  assert.match(
    projectRow,
    /cn\("absolute top-1\/2 right-1 flex -translate-y-1\/2 items-center", sidebarHoverActionClass/,
    "project actions must be an absolutely positioned overlay",
  );
  assert.match(projectRow, /group-hover:pr-\[54px\]/, "only the hovered project row should make room");
  // Pinned rows are the exception: their actions stay out (codex-ui `.project-row-wrap.pinned`).
  assert.match(projectRow, /project\.pinned && "pr-\[54px\]"/);
  assert.match(projectRow, /project\.pinned && "opacity-100"/);

  // Session row: the icon wrapper is the single thing that decides visibility, so an
  // "always show it for the active conversation" override would defeat the whole rule.
  const sessionRow = topLevelFunctionSource("SidebarSessionRow");
  assert.match(sessionRow, /"group relative flex h-8/);
  assert.equal([...sessionRow.matchAll(/sidebarHoverActionClass/g)].length, 1);
  assert.match(sessionRow, /group-hover:pr-\[54px\]/, "only the hovered session row should make room");
  assert.match(sessionRow, /session\.pinned && "pr-\[54px\]"/);
  assert.match(sessionRow, /session\.pinned && "opacity-100"/);
  assert.doesNotMatch(sessionRow, /isActive && "opacity-100"/);
});

test("sidebar row action clusters stay compact", () => {
  // A 16px glyph inside `icon-sm`'s 32px hit area carries 8px of padding per side, which pushed
  // the pin/delete (and …/new-session) pair 34px apart — two islands instead of one cluster, the
  // same complaint the capability cards got. 24px (`size-6`) in a gap-less row leaves 4px per
  // side, so the glyphs read as ~8px apart; the hit area is still comfortably above the
  // considered minimum for a row action and matches the hover card's own pin button.
  const projectRow = topLevelFunctionSource("ProjectSidebar");
  assert.equal(
    [...projectRow.matchAll(/className=\{cn\("size-6", sidebarLock\.lockClass\)\}/g)].length,
    2,
    "the project menu + new-session buttons must share the compact 24px size",
  );
  assert.doesNotMatch(
    projectRow,
    /items-center gap-[^"\s]*, sidebarHoverActionClass/,
    "a gap utility would re-open the cluster the smaller buttons just closed",
  );

  const sessionRow = topLevelFunctionSource("SidebarSessionRow");
  assert.equal(
    [...sessionRow.matchAll(/size="icon-sm"\n\s+className="size-6"/g)].length,
    2,
    "the session pin + delete buttons must share the compact 24px size",
  );
  assert.doesNotMatch(
    sessionRow,
    /size="icon-sm"\n\s+(?!className="size-6")(?:onClick|aria-label)/,
    "a session row action button was left at the 32px default",
  );
});

test("the visibility rule never shares an element with a disabled-opacity override", () => {
  // Regression: the project "…" / new-session buttons carried `sidebarHoverActionClass`
  // (opacity-0) *and* the sidebar lock override `disabled:opacity-100` (plus the button base's
  // `disabled:opacity-50`). `.foo:disabled` outranks the bare `.opacity-0` selector, so
  // every conversation switch — which locks the sidebar while the bootstrap refetch runs —
  // flashed those icons into view. The rule must live on a wrapper whose own opacity is never
  // touched by a disabled state.
  const violations: string[] = [];
  for (const [, call] of appSource.matchAll(/cn\(([^)]*sidebarHoverActionClass[^)]*)\)/g)) {
    if (/disabled:opacity|lockClass/.test(call)) violations.push(call.trim());
  }
  assert.deepEqual(violations, [], "sidebarHoverActionClass must not merge with disabled-opacity classes");

  // Buttons that get disabled during a switch may only take the lock class, never the rule.
  const projectRow = topLevelFunctionSource("ProjectSidebar");
  const ruleLines = projectRow.split("\n").filter((line) => line.includes("sidebarHoverActionClass"));
  assert.equal(ruleLines.length, 1, "the project row should use the rule exactly once");
  assert.ok(
    !ruleLines[0].includes("<Button"),
    "the rule must live on the actions wrapper, never on a Button (disabled opacity would defeat it)",
  );
});
