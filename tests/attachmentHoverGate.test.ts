/**
 * Composer attachment hover gate.
 *
 * Regression: pasting a screenshot with the pointer already sitting over the composer
 * made the fresh badge pop its hover preview instantly, because Chrome re-dispatches
 * `mouseenter` for elements that appear under a stationary cursor. The gate must swallow
 * that synthetic hover and only reopen on a real pointer move (if still over the badge).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createAttachmentHoverGate } from "../src/shared/attachmentHoverGate.ts";

test("hover is allowed before anything is inserted", () => {
  const gate = createAttachmentHoverGate();
  assert.equal(gate.isSuppressed(), false);
  assert.equal(gate.releaseOnPointerMove(), false);
});

test("an insert suppresses hover until the next pointer move", () => {
  const gate = createAttachmentHoverGate();
  gate.suppress();

  // No move yet: the synthetic mouseenter under the cursor must be ignored.
  assert.equal(gate.isSuppressed(), true);
  // The first move releases the gate exactly once...
  assert.equal(gate.releaseOnPointerMove(), true);
  assert.equal(gate.isSuppressed(), false);
  // ...so later moves do not keep re-opening the card.
  assert.equal(gate.releaseOnPointerMove(), false);
});

test("a second insert re-arms the gate after it was released", () => {
  const gate = createAttachmentHoverGate();
  gate.suppress();
  assert.equal(gate.releaseOnPointerMove(), true);

  gate.suppress();
  assert.equal(gate.isSuppressed(), true);
  assert.equal(gate.releaseOnPointerMove(), true);
});

test("independent gates do not share state", () => {
  const first = createAttachmentHoverGate();
  const second = createAttachmentHoverGate();
  first.suppress();
  assert.equal(first.isSuppressed(), true);
  assert.equal(second.isSuppressed(), false);
});

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** Source of a top-level `function name(...) { ... }`, delimited at the next flush-left brace. */
function topLevelFunctionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = appSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return appSource.slice(start, end);
}

test("inserting attachments hides the old card and arms the gate", () => {
  const insert = topLevelFunctionSource("insertAttachmentsAtCursor");
  assert.match(insert, /hideAttachmentHover\(\)/, "a stale preview must be closed on insert");
  assert.match(insert, /attachmentHoverGateRef\.current\.suppress\(\)/, "insert must arm the hover gate");
});

test("badge mouseenter respects the gate", () => {
  const badge = topLevelFunctionSource("createAttachmentBadgeNode");
  const enter = badge.slice(badge.indexOf("addEventListener(\"mouseenter\""));
  assert.match(enter, /attachmentHoverGateRef\.current\.isSuppressed\(\)/, "mouseenter must check the gate");
  assert.match(enter, /showAttachmentHover\(attachment, badge\)/, "mouseenter still opens the preview normally");
});

test("the first pointermove after an insert re-checks what is under the pointer", () => {
  const start = appSource.indexOf("handleAttachmentHoverPointerMove");
  assert.notEqual(start, -1, "the pointermove re-check is gone from App.tsx");
  const body = appSource.slice(start, start + 900);

  assert.match(body, /releaseOnPointerMove\(\)/, "the move must release the gate");
  assert.match(body, /closest\?\.\("\.attachment-badge"\)/, "the move must look for the badge under the pointer");
  assert.match(body, /composerAttachmentMapRef\.current\.get\(attachmentId\)/, "the badge id must resolve to an attachment");
  assert.match(body, /showAttachmentHover\(attachment, badge\)/, "still hovering a badge must open its preview");
  assert.match(appSource, /window\.addEventListener\("pointermove", handleAttachmentHoverPointerMove\)/);
});