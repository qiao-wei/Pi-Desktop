/**
 * Message editor parts: the DOM walk and the pure part list it produces.
 *
 * The walk is structural (plain node-shaped objects), so it runs under Node's
 * test runner without a DOM - same trick as `readTriggerText` in slashMenu.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CARET_MARKER,
  compactEditorParts,
  editorAttachments,
  editorText,
  normalizeEditorParts,
  readEditorParts,
  toPromptMessageParts,
  toAttachmentInputs,
  type EditorCapability,
  type EditorDomNode,
  type EditorPart,
} from "../src/features/chat/editorParts.ts";

const CARET = CARET_MARKER;

function textNode(value: string): EditorDomNode {
  return { nodeType: 3, textContent: value };
}

function element(
  nodeName: string,
  children: EditorDomNode[] = [],
  dataset: Record<string, string | undefined> = {},
): EditorDomNode {
  return { nodeType: 1, nodeName, childNodes: children, dataset };
}

const attachment = {
  id: "a1",
  name: "shot.png",
  mimeType: "image/png",
  size: 1234,
  kind: "image" as const,
  sourcePath: "/tmp/shot.png",
};

const capability: EditorCapability = {
  id: "skill-1",
  kind: "skill",
  name: "browser-skill",
  description: "Browser automation",
  instanceId: "inst-1",
};

function walk(root: EditorDomNode, attachments = new Map([["a1", attachment]])) {
  return readEditorParts(root, attachments, new Map([[`skill:skill-1:inst-1`, capability]]));
}

test("text parts keep newlines, strip caret markers", () => {
  const parts = walk(element("DIV", [textNode(`hello${CARET}\nworld`)]));
  assert.deepEqual(parts, [{ kind: "text", text: "hello\nworld" }]);
});

test("<br> and block boundaries become newlines (compressed to at most two)", () => {
  const parts = walk(
    element("DIV", [
      element("DIV", [textNode("para one")]),
      element("DIV", [textNode("para two")]),
      element("BR"),
      element("BR"),
      element("BR"),
      textNode("end"),
    ]),
  );
  assert.equal(editorText(parts), "para one\npara two\n\nend");
});

test("attachment badges resolve through the id map and land in order", () => {
  const parts = walk(element("DIV", [textNode("look"), element("SPAN", [], { attachmentId: "a1" })]));
  assert.deepEqual(parts, [
    { kind: "text", text: "look" },
    { kind: "attachment", attachment },
  ]);
  assert.deepEqual(editorAttachments(parts), [attachment]);
  assert.deepEqual(toPromptMessageParts(parts), [
    { kind: "text", text: "look" },
    { kind: "attachment", attachmentId: "a1" },
  ]);
});

test("skill badges resolve by id + instanceId and drop their instanceId on submit", () => {
  const parts = walk(
    element("DIV", [
      element("SPAN", [], {
        capabilityId: "skill-1",
        capabilityKind: "skill",
        capabilityInstanceId: "inst-1",
      }),
      textNode("go"),
    ]),
  );
  assert.deepEqual(parts, [
    { kind: "capability", capability },
    { kind: "text", text: "go" },
  ]);
  const submitted = toPromptMessageParts(parts);
  assert.deepEqual(submitted, [
    {
      kind: "capability",
      capability: {
        id: "skill-1",
        kind: "skill",
        name: "browser-skill",
        description: "Browser automation",
        active: undefined,
      },
    },
    { kind: "text", text: "go" },
  ]);
  assert.equal("instanceId" in (submitted[0] as { capability: object }).capability, false);
});

test("badges the map no longer knows are skipped (removed attachment never resurrects)", () => {
  const parts = walk(element("DIV", [element("SPAN", [], { attachmentId: "gone" }), textNode("x")]));
  assert.deepEqual(parts, [{ kind: "text", text: "x" }]);
});

test("compactEditorParts merges adjacent text runs only", () => {
  const parts = compactEditorParts([
    { kind: "text", text: "a" },
    { kind: "text", text: "b" },
    { kind: "attachment", attachment },
    { kind: "text", text: "c" },
    { kind: "text", text: "d" },
  ]);
  assert.deepEqual(parts, [
    { kind: "text", text: "ab" },
    { kind: "attachment", attachment },
    { kind: "text", text: "cd" },
  ]);
});

test("normalizeEditorParts drops empty text and trailing whitespace", () => {
  const parts: EditorPart[] = [
    { kind: "text", text: "" },
    { kind: "attachment", attachment },
    { kind: "text", text: "tail\n\n\n\n" },
  ];
  assert.deepEqual(normalizeEditorParts(parts), [
    { kind: "attachment", attachment },
    { kind: "text", text: "tail" },
  ]);
});

test("toAttachmentInputs reuses sourcePath for kept attachments (no FileReader)", async () => {
  const inputs = await toAttachmentInputs([attachment], () => undefined);
  assert.deepEqual(inputs, [
    {
      id: "a1",
      name: "shot.png",
      mimeType: "image/png",
      size: 1234,
      data: "",
      previewUrl: undefined,
      sourcePath: "/tmp/shot.png",
    },
  ]);
});