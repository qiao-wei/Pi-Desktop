/**
 * Inline badge clipboard round-trip.
 *
 * Copying a badge must paste back as a badge. Identity travels in `data-*`
 * attributes because the browser serialises the selected DOM into `text/html`;
 * the paste sanitiser turns recognised badges into positional placeholders and
 * the editors resolve them with `readBadgeDescriptor`. These tests cover the
 * pure half (encoding, descriptor reading, placeholder positions).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PASTE_BADGE_ATTRIBUTE,
  attachmentBadgeAttributes,
  capabilityBadgeAttributes,
  readBadgeDescriptor,
  userMessageClipboardHtml,
} from "../src/features/chat/badgeClipboard.ts";
import { htmlToSanitizedMarkup, type SanitizeNode } from "../src/features/chat/pasteSanitize.ts";
import type { ChatAttachment, ChatMessagePart } from "../src/types/domain.ts";

const app = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const editBox = readFileSync(new URL("../src/features/chat/MessageEditBox.tsx", import.meta.url), "utf8");
const thread = readFileSync(
  new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url),
  "utf8",
);

function el(
  name: string,
  children: SanitizeNode[] = [],
  options: { text?: string; dataset?: Record<string, string | undefined> } = {},
): SanitizeNode {
  return { nodeName: name, childNodes: children, textContent: options.text, dataset: options.dataset };
}

const text = (value: string): SanitizeNode => ({ nodeName: "#text", textContent: value });

const attachment: ChatAttachment = {
  id: "a1",
  name: "shot.png",
  mimeType: "image/png",
  size: 2048,
  kind: "image",
  previewUrl: "/api/attachments?path=/tmp/shot.png",
  sourcePath: "/tmp/shot.png",
};

const capability = {
  id: "skill-1",
  kind: "skill" as const,
  name: "browser-skill",
  description: "Browser automation",
};

/** Mirrors what the browser does to `data-*` attributes when parsing HTML. */
function datasetOf(attributes: Record<string, string>): Record<string, string | undefined> {
  const dataset: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(attributes)) {
    const camel = name
      .replace(/^data-/, "")
      .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    dataset[camel] = value;
  }
  return dataset;
}

test("attachment badge attributes round-trip through readBadgeDescriptor", () => {
  const attributes = attachmentBadgeAttributes(attachment);
  assert.equal(attributes["data-attachment-id"], "a1");
  assert.equal(attributes["data-attachment-kind"], "image");
  assert.equal(attributes["data-attachment-source-path"], "/tmp/shot.png");

  const descriptor = readBadgeDescriptor({ dataset: datasetOf(attributes) });
  assert.deepEqual(descriptor, { kind: "attachment", attachment });
});

test("capability badge attributes round-trip, non-skill kinds are ignored", () => {
  const descriptor = readBadgeDescriptor({ dataset: datasetOf(capabilityBadgeAttributes(capability)) });
  assert.deepEqual(descriptor, { kind: "capability", capability });

  const packageBadge = readBadgeDescriptor({
    dataset: {
      capabilityId: "pkg-1",
      capabilityKind: "package",
      capabilityName: "pkg",
      capabilityDescription: "",
    },
  });
  assert.equal(packageBadge, null);
});

test("readBadgeDescriptor: plain elements and missing datasets are not badges", () => {
  assert.equal(readBadgeDescriptor({ dataset: undefined }), null);
  assert.equal(readBadgeDescriptor({ dataset: {} }), null);
  assert.equal(readBadgeDescriptor({}), null);
});

test("sanitiser emits a positional placeholder and collects badges when asked", () => {
  const badges: import("../src/features/chat/badgeClipboard.ts").ClipboardBadge[] = [];
  const markup = htmlToSanitizedMarkup(
    el("BODY", [
      el("DIV", [text("see "), el("SPAN", [], { dataset: datasetOf(attachmentBadgeAttributes(attachment)) })]),
      text(" and "),
      el("SPAN", [], { dataset: datasetOf(capabilityBadgeAttributes(capability)) }),
    ]),
    { badges },
  );

  assert.equal(
    markup,
    `see <span ${PASTE_BADGE_ATTRIBUTE}="0"></span><br> and <span ${PASTE_BADGE_ATTRIBUTE}="1"></span>`,
  );
  assert.deepEqual(badges, [
    { kind: "attachment", attachment },
    { kind: "capability", capability },
  ]);
});

test("without the badges option a badge still sanitises to its text (no regression)", () => {
  const markup = htmlToSanitizedMarkup(
    el("BODY", [
      el("SPAN", [], { dataset: datasetOf(attachmentBadgeAttributes(attachment)) }),
    ]),
  );
  assert.equal(markup, "");
});

test("userMessageClipboardHtml serialises parts with badge identity", () => {
  const parts: ChatMessagePart[] = [
    { kind: "text", text: "line1\nline2" },
    { kind: "attachment", attachmentId: "a1" },
    { kind: "capability", capability },
  ];
  const html = userMessageClipboardHtml(parts, [attachment]);
  assert.match(html, /^line1<br>line2<span class="attachment-badge" data-attachment-id="a1"/);
  assert.match(html, /data-attachment-source-path="\/tmp\/shot\.png"/);
  assert.match(html, /data-capability-id="skill-1"/);
  assert.match(html, /data-capability-kind="skill"/);
  // 外部应用（或纯文本读取）仍要看到名字与大小，而不是空 span。
  assert.match(html, /<strong>shot\.png<\/strong><small>2 KB<\/small>/);
  assert.match(html, /<strong>browser-skill<\/strong>/);
});

test("userMessageClipboardHtml drops attachments it cannot resolve", () => {
  const html = userMessageClipboardHtml([{ kind: "attachment", attachmentId: "missing" }], []);
  assert.equal(html, "");
});

/* ------------------------------------------------- wiring (structural) */

test("composer and edit-box badges carry the clipboard identity", () => {
  assert.match(app, /applyAttachmentBadgeAttributes\(badge, attachment\)/);
  assert.match(app, /applyCapabilityBadgeAttributes\(badge, capability\)/);
  assert.match(editBox, /applyAttachmentBadgeAttributes\(badge, attachment\)/);
  assert.match(editBox, /applyCapabilityBadgeAttributes\(badge, capability\)/);
});

test("sent-message badges render the same identity into the DOM", () => {
  assert.match(thread, /\{\.\.\.attachmentBadgeAttributes\(attachment\)\}/);
  assert.match(thread, /\{\.\.\.capabilityBadgeAttributes\(capability\)\}/);
});

test("both editors rebuild pasted placeholders instead of leaking names", () => {
  assert.match(app, /replacePasteBadgePlaceholders\(fragment, badges, createPastedBadge, composerCaretMarker\)/);
  assert.match(editBox, /replacePasteBadgePlaceholders\(fragment, badges, createPastedBadge, CARET_MARKER\)/);
  // A badge pasted from a sent message has no File; the server reuses sourcePath.
  assert.match(app, /data: attachment\.file \? await fileToBase64\(attachment\.file\) : ""/);
});