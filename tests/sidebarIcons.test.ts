/**
 * Sidebar icons must be codex-ui's drawings, not lookalikes from another icon family.
 *
 * The user called out the pin / new-session / archive glyphs specifically: lucide's Pin has a
 * rounded head, "new session" was a bare pencil, and its archive differs from codex-ui's
 * lidded box. So the paths are copied verbatim into `src/components/sidebarIcons.tsx` and the
 * sidebar must import from there.
 *
 * The expanded-project folder is a deliberate improvement over codex-ui (which keeps the same
 * folder icon for both states): collapsed stays codex-ui's `Folder`, expanded switches to the
 * open variant so the state is readable without a chevron.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const iconSource = readFileSync(new URL("../src/components/sidebarIcons.tsx", import.meta.url), "utf8");

/** Source of a top-level `function name(...) { ... }`, delimited at the next flush-left brace. */
function topLevelFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return source.slice(start, end);
}

test("codex-ui's pin / compose / archive paths are copied verbatim", () => {
  // Pin: straight stem + flat-top pushpin body.
  assert.match(iconSource, /d="M12 17v5"/);
  assert.match(iconSource, /d="M9 10\.8a2 2 0 0 1-1\.1 1\.8l-1\.8\.9A2 2 0 0 0 5 15\.2V16a1 1 0 0 0 1 1h12/);

  // Compose (new session): square with a pen, not a bare pencil.
  assert.match(iconSource, /d="M20 12\.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6\.5"/);
  assert.match(iconSource, /d="M17\.5 3\.5a2\.1 2\.1 0 0 1 3 3L12 15l-3\.5 1 1-3\.5Z"/);

  // Archive: lidded box with the handle dash.
  assert.match(iconSource, /<rect x="3" y="4" width="18" height="4\.5" rx="1\.5" \/>/);
  assert.match(iconSource, /d="M10 12\.5h4"/);

  // codex-ui's 24px grid and 1.7 stroke (lucide defaults look heavier).
  assert.match(iconSource, /viewBox="0 0 24 24"/);
  assert.match(iconSource, /strokeWidth=\{1\.7\}/);
});

test("the sidebar imports the codex-ui icon set instead of lucide lookalikes", () => {
  const sidebar = topLevelFunctionSource(appSource, "ProjectSidebar");
  const sessionRow = topLevelFunctionSource(appSource, "SidebarSessionRow");

  assert.match(appSource, /from "\.\.\/components\/sidebarIcons"/);

  // Project row: folder pair, pin indicator, new-session action.
  assert.match(sidebar, /<SidebarFolderIcon/);
  assert.match(sidebar, /<SidebarFolderOpenIcon/);
  assert.match(sidebar, /<SidebarNewSessionIcon/);
  assert.match(sidebar, /<SidebarPinIcon/);

  // Session row: pin + archive.
  assert.match(sessionRow, /<SidebarPinIcon/);
  assert.match(sessionRow, /<SidebarArchiveIcon/);

  // No lucide stand-ins left in these two functions.
  assert.doesNotMatch(sidebar, /<Pencil\b/);
  assert.doesNotMatch(sessionRow, /<Archive\b/);
  assert.doesNotMatch(sessionRow, /<Pencil\b/);
});

test("an expanded project switches to the open folder icon", () => {
  const sidebar = topLevelFunctionSource(appSource, "ProjectSidebar");
  const rowStart = sidebar.indexOf('"group relative"');
  assert.notEqual(rowStart, -1, "project row markup changed");
  const row = sidebar.slice(rowStart, sidebar.indexOf("</section>", rowStart));

  assert.match(row, /aria-expanded=\{isExpanded\}/);
  assert.match(row, /isExpanded \? \(\s*<SidebarFolderOpenIcon/, "expanded projects must show the open folder");
  assert.match(row, /\) : \(\s*<SidebarFolderIcon/, "collapsed projects keep the closed folder");
});

test("project rows have no selected state", () => {
  const sidebar = topLevelFunctionSource(appSource, "ProjectSidebar");
  assert.doesNotMatch(sidebar, /isActiveProject/, "the project row must not read the active project");

  const rowStart = sidebar.indexOf('"group relative"');
  const row = sidebar.slice(rowStart, sidebar.indexOf("</section>", rowStart));
  // Hover is the only background change; no persistent active highlight, no active text colour.
  assert.match(row, /hover:bg-accent/);
  assert.doesNotMatch(row, /text-accent-foreground/);
  assert.doesNotMatch(row, /(^|["\s])bg-accent(["'\s]|$)/);
});