/**
 * Sidebar hover preview cards + overlay scrollbar, ported from codex-ui.
 *
 * App.tsx is a .tsx file so `node --test` cannot import it; the wiring is asserted from
 * source, scoped to the functions that own it. The geometry and copy themselves are
 * covered by `sidebarHoverPreview.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const autoHideSource = readFileSync(new URL("../src/components/AutoHideScroll.tsx", import.meta.url), "utf8");

/** Source of a top-level `function name(...) { ... }`, delimited at the next flush-left brace. */
function topLevelFunctionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = appSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return appSource.slice(start, end);
}

test("the sidebar scroll region hides the native bar and dismisses cards while scrolling", () => {
  const sidebar = topLevelFunctionSource("ProjectSidebar");

  assert.match(sidebar, /<AutoHideScroll[^>]*className="flex-1"[^>]*onScroll=\{hideHoverCard\}/, "sidebar must use the overlay scroll container");
  assert.match(sidebar, /<\/AutoHideScroll>/, "the sidebar list must be inside the overlay scroll container");
});

test("acting on a row closes its preview immediately", () => {
  const sidebar = topLevelFunctionSource("ProjectSidebar");

  // The pointer is still over the row after a click, so `onMouseLeave` never fires and the
  // card would hang around. Capturing pointerdown on the list makes every action (select a
  // conversation, expand a project, pin, archive, open the "…" menu, start a drag) close it.
  const listStart = sidebar.indexOf("<AutoHideScroll");
  const listEnd = sidebar.indexOf("</AutoHideScroll>");
  assert.notEqual(listStart, -1, "the sidebar list lost its scroll container");
  assert.notEqual(listEnd, -1, "the sidebar list scroll container is not closed");
  const list = sidebar.slice(listStart, listEnd);

  assert.match(list, /onPointerDownCapture=\{hideHoverCard\}/, "pointerdown on a row must dismiss the preview");
  // The capture must not sit on the aside: the project card is interactive and lives outside
  // this block, so clicking its pin / Edit project would otherwise dismiss it mid-interaction.
  assert.doesNotMatch(sidebar.slice(listEnd), /onPointerDownCapture=\{hideHoverCard\}/);
});

test("hovering a project row or a session row opens the matching preview", () => {
  const sidebar = topLevelFunctionSource("ProjectSidebar");

  // Project rows: the wrapper (not the button) is hovered, because the card is anchored
  // to the whole row and leaving it has a grace period.
  assert.match(sidebar, /onMouseEnter=\{\(event\) => showProjectCard\(event\.currentTarget, project\)\}/);
  assert.match(sidebar, /onMouseLeave=\{scheduleHideHoverCard\}/);

  // Both session lists (Pinned and per-project) must opt into the preview.
  assert.equal(
    [...sidebar.matchAll(/onHoverSession=\{showSessionCard\}/g)].length,
    2,
    "both the Pinned list and the project session list must wire the session preview",
  );
  assert.equal(
    [...sidebar.matchAll(/onHoverEnd=\{scheduleHideHoverCard\}/g)].length,
    2,
    "both session lists must wire the hover end",
  );

  const sessionRow = topLevelFunctionSource("SidebarSessionRow");
  assert.match(sessionRow, /onMouseEnter=\{\(event\) => onHoverSession\(event\.currentTarget, session, projectName \?\? ""\)\}/);
  assert.match(sessionRow, /onMouseLeave=\{onHoverEnd\}/);
});

test("cards use the shared placement helper and are positioned fixed", () => {
  const sidebar = topLevelFunctionSource("ProjectSidebar");

  assert.match(sidebar, /placeSidebarHoverCard\(/, "cards must reuse the tested placement helper");
  assert.match(sidebar, /style=\{\{ left: hoverCard\.x, top: hoverCard\.y \}\}/, "cards must be placed from the computed state");
  // The card sits outside the scrolling list, so it cannot be clipped by it.
  assert.match(sidebar, /"fixed z-\[60\]/, "the hover card must be position:fixed");
});

test("the project card can be hovered, the session card cannot", () => {
  const sidebar = topLevelFunctionSource("ProjectSidebar");

  assert.match(sidebar, /onMouseEnter=\{\(\) => window\.clearTimeout\(hoverHideTimerRef\.current\)\}/);
  assert.match(sidebar, /onMouseLeave=\{scheduleHideHoverCard\}/);
  assert.match(sidebar, /pointer-events-none w-\[258px\]/, "the session card must not swallow the pointer");
});

test("the pointer can cross the gap onto the card without the card unmounting", () => {
  const sidebar = topLevelFunctionSource("ProjectSidebar");

  // Regression: the card is fixed-positioned beside the sidebar while the row sits inside it,
  // so moving onto the card crosses a gap that belongs to neither element. The aside used to
  // unmount the card on `mouseleave` the instant the pointer entered that gap, which made both
  // cards unreachable; retention has to come from pointer coordinates instead.
  assert.doesNotMatch(
    sidebar,
    /onMouseLeave=\{hideHoverCard\}/,
    "leaving the sidebar while crossing onto a card must not kill the card instantly",
  );
  assert.match(sidebar, /pointerKeepsSidebarCardOpen\(/, "card retention must use the tested geometry helper");
  assert.match(sidebar, /hoverAnchorRef\.current = element;/, "the row that opened the card has to be remembered");
  assert.match(sidebar, /ref=\{hoverCardRef\}/, "the open card has to be measurable");
  assert.match(
    sidebar,
    /window\.addEventListener\("pointermove", onPointerMove\)/,
    "the pointer must be tracked while a card is open",
  );

  // The tracker itself has to cancel a pending hide when the pointer is on the card or the
  // corridor — otherwise it would just re-arm the same 200ms timer forever.
  const tracker = sidebar.slice(
    sidebar.indexOf("const onPointerMove"),
    sidebar.indexOf('window.addEventListener("blur"'),
  );
  assert.match(tracker, /pointerKeepsSidebarCardOpen\(event\.clientX, event\.clientY, rects\)/);
  assert.match(tracker, /window\.clearTimeout\(hoverHideTimerRef\.current\)/);
  assert.match(tracker, /scheduleHideHoverCard\(\)/);

  // Both session lists and the project row hand the same retention a live anchor: each row
  // preview must remember its element, or the walk from that row onto its card stays broken.
  assert.equal(
    [...sidebar.matchAll(/hoverAnchorRef\.current = element;/g)].length,
    2,
    "showSessionCard and showProjectCard must both record the anchor",
  );
});

test("the project card's folder path opens the folder", () => {
  const sidebar = topLevelFunctionSource("ProjectSidebar");
  const card = sidebar.slice(
    sidebar.indexOf("{hoverCard.project.cwd ? ("),
    sidebar.lastIndexOf("Edit project"),
  );
  // Scoped to the path button itself: slicing to `Edit project` above would also swallow the
  // Edit-project button's own `hideHoverCard()`, so removing the path's one would go unnoticed.
  const pathButton = card.slice(card.indexOf("<button"), card.indexOf("No folder"));

  assert.match(pathButton, /<button/, "the path must be clickable, not a plain row");
  assert.match(pathButton, /title=\{hoverCard\.project\.cwd\}/, "the button still shows the full path on hover");
  // Clicking navigates away from the card, so it has to close first (same as Edit project) —
  // leaving the card open over the revealed folder is exactly the stuck-card bug.
  assert.match(
    pathButton,
    /hideHoverCard\(\);[\s\S]*void onRevealProject\(project\.id\)/,
    "the path click must close the card and then reveal the folder",
  );
  // Projects with no folder still render a row (just not a button): dropping the line would
  // change the card's height/rhythm.
  assert.match(card, /No folder/);

  // Reveal is a bridge-side action (`open` / `explorer.exe`), not a Tauri-only one: the
  // sidebar menu must not gate it behind `isTauriRuntime`, which is false on Electron and web.
  assert.doesNotMatch(sidebar, /showReveal/);
  assert.match(sidebar, /<DropdownMenuItem onSelect=\{\(\) => void onRevealProject\(project\.id\)\}>/);
});

test("project pin actions are hidden behind the feature flag", () => {
  // Temporarily hidden: `pinned` is persisted but never read (projects are not reordered by it),
  // so both entry points stay behind one flag until a pin actually changes the sidebar order.
  assert.match(appSource, /const projectPinActionsVisible: boolean = false;/);

  const sidebar = topLevelFunctionSource("ProjectSidebar");
  assert.equal(
    [...sidebar.matchAll(/projectPinActionsVisible \? \(/g)].length,
    2,
    "the \"…\" menu item and the project hover-card button must both be guarded",
  );
  assert.equal(
    [...sidebar.matchAll(/onPinProject\(/g)].length,
    2,
    "both guarded blocks must still contain their pin action",
  );
});

test("the overlay thumb fades in while scrolling and out after it stops", () => {
  assert.match(autoHideSource, /thumb\.classList\.add\("is-visible"\)/);
  assert.match(autoHideSource, /thumb\.classList\.remove\("is-visible"\)/);
  assert.match(autoHideSource, /window\.setTimeout\(/, "the thumb must fade out on a timer");
  assert.match(autoHideSource, /new ResizeObserver/, "the thumb must repaint when the list resizes");

  // Chrome does not reliably repaint a class-toggled ::-webkit-scrollbar, so the native
  // bar has to be gone entirely and the thumb drawn as an overlay.
  assert.match(stylesSource, /\.autohide-box::\-webkit-scrollbar\s*\{[^}]*width: 0;/);
  assert.match(stylesSource, /\.autohide-box\s*\{[^}]*scrollbar-width: none;/);
  assert.match(stylesSource, /\.autohide-thumb\s*\{[^}]*opacity: 0;/);
  assert.match(stylesSource, /\.autohide-thumb\.is-visible\s*\{[^}]*opacity: 1;/);
});