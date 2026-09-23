/**
 * Parts model shared by the message editor.
 *
 * The editor's contentEditable DOM is the source of truth while editing; these
 * pure helpers turn the DOM walk into the same compacted, newline-normalised
 * part list the composer submits (and the payload the edit endpoint accepts), so
 * the behaviour is testable without a browser.
 */
import type { ChatAttachment, ChatMessagePart } from "../../types";
import type { PromptAttachmentInput, PromptMessagePartInput } from "../../lib/api";
import { COMPOSER_BLOCK_TAGS } from "./pasteSanitize.ts";

/** Zero-width marker the editor parks after a badge so the caret can sit there. */
export const CARET_MARKER = "\u200b";

export interface EditorCapability {
  id: string;
  kind: "skill";
  name: string;
  description: string;
  active?: boolean;
  instanceId?: string;
}

export type EditorPart =
  | { kind: "text"; text: string }
  | { kind: "attachment"; attachment: ChatAttachment }
  | { kind: "capability"; capability: EditorCapability };

/** Merge adjacent text parts (a badge between two runs keeps them apart). */
export function compactEditorParts(parts: EditorPart[]): EditorPart[] {
  const compacted: EditorPart[] = [];
  for (const part of parts) {
    const previous = compacted.at(-1);
    if (part.kind === "text" && previous?.kind === "text") {
      previous.text += part.text;
    } else {
      compacted.push(part);
    }
  }
  return compacted;
}

/**
 * Submit-time text normalisation: 3+ newlines collapse to two (block boundaries
 * accumulate one each) and a trailing newline is dropped.
 */
export function normalizeEditorParts(parts: EditorPart[]): EditorPart[] {
  return parts
    .map((part, index): EditorPart | null => {
      if (part.kind !== "text") {
        return part;
      }
      let text = part.text.replace(/\n{3,}/g, "\n\n");
      if (index === parts.length - 1) {
        text = text.replace(/\s+$/u, "");
      }
      return text ? { ...part, text } : null;
    })
    .filter((part): part is EditorPart => part !== null);
}

export function editorText(parts: EditorPart[]): string {
  return parts
    .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

export function editorAttachments(parts: EditorPart[]): ChatAttachment[] {
  return parts
    .filter((part): part is { kind: "attachment"; attachment: ChatAttachment } => part.kind === "attachment")
    .map((part) => part.attachment);
}

export function toPromptMessageParts(parts: EditorPart[]): PromptMessagePartInput[] {
  return parts
    .map((part): ChatMessagePart | null => {
      if (part.kind === "text") {
        return part.text ? { kind: "text", text: part.text } : null;
      }
      if (part.kind === "capability") {
        const { id, kind, name, description, active } = part.capability;
        return { kind: "capability", capability: { id, kind, name, description, active } };
      }
      return { kind: "attachment", attachmentId: part.attachment.id };
    })
    .filter((part): part is ChatMessagePart => Boolean(part));
}

/**
 * Attachment inputs for the edit request.
 *
 * Attachments the client already has bytes for (`file`) are base64-encoded; the
 * ones kept from the original message carry their `sourcePath` and let the
 * server reuse the bytes already on disk instead of round-tripping them.
 */
export async function toAttachmentInputs(
  attachments: ChatAttachment[],
  fileFor: (attachment: ChatAttachment) => File | undefined,
): Promise<PromptAttachmentInput[]> {
  return Promise.all(
    attachments.map(async (attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      data: fileFor(attachment) ? await fileToBase64(fileFor(attachment)!) : "",
      previewUrl: attachment.previewUrl,
      sourcePath: attachment.sourcePath,
    })),
  );
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolvePromise(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => rejectPromise(reader.error ?? new Error(`Unable to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** Key under which a skill badge resolves its capability (id + instance). */
export function capabilityKey(id: string | undefined, instanceId: string | undefined) {
  return `skill:${id ?? ""}:${instanceId ?? ""}`;
}

/**
 * Structural node shape (not `Node`) so the walk is testable without a browser -
 * same trick as `readTriggerText` in slashMenu.ts.
 */
export interface EditorDomNode {
  nodeType: number;
  nodeName?: string;
  textContent?: string | null;
  childNodes?: ArrayLike<EditorDomNode>;
  dataset?: Record<string, string | undefined>;
}

/**
 * DOM walk producing the same part list the composer submits: text (caret
 * markers stripped, `<br>`/block boundaries become newlines), attachment badges
 * resolved through `attachmentById`, skill badges through `capabilityByKey`.
 */
export function readEditorParts(
  root: EditorDomNode,
  attachmentById: Map<string, ChatAttachment>,
  capabilityByKey: Map<string, EditorCapability>,
): EditorPart[] {
  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;
  const parts: EditorPart[] = [];

  const walk = (node: EditorDomNode) => {
    const children = node.childNodes;
    for (let index = 0; index < (children?.length ?? 0); index += 1) {
      const child = children![index];
      if (child.nodeType === TEXT_NODE) {
        const text = (child.textContent ?? "").replaceAll(CARET_MARKER, "");
        if (text) {
          parts.push({ kind: "text", text });
        }
        continue;
      }

      if (child.nodeType !== ELEMENT_NODE) {
        continue;
      }

      if (child.dataset?.attachmentId) {
        const attachment = attachmentById.get(child.dataset.attachmentId);
        if (attachment) {
          parts.push({ kind: "attachment", attachment });
        }
        continue;
      }
      if (child.dataset?.capabilityId) {
        const key = capabilityKey(child.dataset.capabilityId, child.dataset.capabilityInstanceId);
        const capability = capabilityByKey.get(key);
        if (capability) {
          parts.push({ kind: "capability", capability });
        }
        continue;
      }

      walk(child);
      const tagName = (child.nodeName ?? "").toUpperCase();
      if (tagName === "BR" || COMPOSER_BLOCK_TAGS.has(tagName)) {
        parts.push({ kind: "text", text: "\n" });
      }
    }
  };

  walk(root);
  return normalizeEditorParts(compactEditorParts(parts));
}