/**
 * Conversation header: one compact row — folder button (opens the project folder),
 * project name, conversation title.
 *
 * App.tsx is a .tsx file so `node --test` cannot import it; the wiring is asserted from
 * source, scoped to the `<header className="conversation-header">` block so a sidebar
 * "…" menu elsewhere in the file cannot satisfy these assertions.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { revealFolderLabelKey } from "../src/shared/revealFolderLabel.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** The chat header markup only — headers elsewhere in App.tsx must not count. */
function conversationHeaderSource(): string {
  const start = appSource.indexOf('<header className="conversation-header');
  assert.notEqual(start, -1, "the conversation header is gone from App.tsx");
  const end = appSource.indexOf("</header>", start);
  assert.notEqual(end, -1, "the conversation header body could not be delimited");
  return appSource.slice(start, end);
}

test("the header shows the project name and the conversation title on one row", () => {
  const header = conversationHeaderSource();

  assert.match(header, /\{activeProject\.name\}/, "the project name must stay in the header");
  assert.match(header, /\{conversation\.title\}/, "the conversation title must stay in the header");
  // One row means one `<h1>`; the old stacked layout also had a `<p>` project label above it.
  assert.equal(header.match(/<h1\b/g)?.length, 1, "expected exactly one title line");
  assert.ok(!/<p\b/.test(header), "the separate project-label paragraph must be gone");
});

test("the header's icon button opens the project folder instead of a three-dot menu", () => {
  const header = conversationHeaderSource();

  assert.match(header, /revealProject\(activeProject\.id\)/, "the folder button must reveal the project folder");
  assert.match(header, /title=\{`\$\{t\(platformRevealFolderLabelKey\(\)\)\}: \$\{activeProject\.cwd\}`\}/, "the tooltip carries the folder path the old third line showed");
  assert.ok(!/MoreHorizontal/.test(header), "the header must not keep a three-dot menu");
  assert.ok(!/DropdownMenu/.test(header), "the header must not keep a dropdown");
});

test("项目名和标题共用一套字号/字重/颜色（大小粗细不能分家）", () => {
  const header = conversationHeaderSource();
  const nameClass = /<span className="([^"]*)">\s*\{activeProject\.name\}/.exec(header)?.[1];
  const titleClass = /<h1[\s\S]*?className="([^"]*)"/.exec(header)?.[1];

  assert.ok(nameClass, "the project-name span could not be located");
  assert.ok(titleClass, "the conversation-title h1 could not be located");

  for (const className of [nameClass, titleClass]) {
    assert.ok(className.includes("text-[0.86rem]"), `expected the shared size in "${className}"`);
    assert.ok(className.includes("font-medium"), `expected the shared weight in "${className}"`);
    assert.ok(className.includes("text-foreground"), `expected the shared color in "${className}"`);
    assert.ok(!/font-(bold|semibold|extrabold)/.test(className), `the title must not be bolder than the project name: "${className}"`);
  }
});

test("the reveal wording follows the platform", () => {
  assert.equal(revealFolderLabelKey("Win32"), "sidebar.revealInExplorer");
  assert.equal(revealFolderLabelKey("Windows"), "sidebar.revealInExplorer");
  assert.equal(revealFolderLabelKey("MacIntel"), "sidebar.revealInFinder");
  assert.equal(revealFolderLabelKey("Linux x86_64"), "sidebar.revealInFinder");
  assert.equal(revealFolderLabelKey(""), "sidebar.revealInFinder");
  assert.equal(revealFolderLabelKey(undefined), "sidebar.revealInFinder");
  assert.equal(revealFolderLabelKey(null), "sidebar.revealInFinder");
});