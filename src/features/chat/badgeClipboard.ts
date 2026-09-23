/**
 * Inline badge ↔ clipboard.
 *
 * A copied badge (composer or sent message) must paste back as a badge, not as
 * the file/skill name. The identity travels in `data-*` attributes on the badge
 * element itself — the browser serialises the selected DOM into `text/html`, so
 * selection-copy keeps working without intercepting the copy event. The message
 * Copy button builds the same shape by hand from its parts.
 *
 * The paste sanitiser turns those attributes into positional placeholders, and
 * the editors resolve their placeholder into a real badge with the data here.
 */
import type { CapabilityKind, ChatAttachment, ChatMessagePart } from "../../types";

/** Placeholder element the paste sanitiser emits for a badge it recognised. */
export const PASTE_BADGE_ATTRIBUTE = "data-tender-paste-badge";

export interface ClipboardAttachmentBadge {
  kind: "attachment";
  attachment: ChatAttachment;
}

export interface ClipboardCapabilityBadge {
  kind: "capability";
  capability: { id: string; kind: CapabilityKind; name: string; description: string };
}

export type ClipboardBadge = ClipboardAttachmentBadge | ClipboardCapabilityBadge;

function badgeAttributes(entry: Record<string, string | undefined>): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(entry)) {
    if (value != null && value !== "") {
      attributes[name] = value;
    }
  }
  return attributes;
}

/** `data-*` props a badge element carries for the clipboard. */
export function attachmentBadgeAttributes(attachment: ChatAttachment): Record<string, string> {
  return badgeAttributes({
    "data-attachment-id": attachment.id,
    "data-attachment-name": attachment.name,
    "data-attachment-mime-type": attachment.mimeType,
    "data-attachment-size": String(attachment.size),
    "data-attachment-kind": attachment.kind,
    "data-attachment-preview-url": attachment.previewUrl,
    "data-attachment-source-path": attachment.sourcePath,
  });
}

export function capabilityBadgeAttributes(capability: {
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
}): Record<string, string> {
  return badgeAttributes({
    "data-capability-id": capability.id,
    "data-capability-kind": capability.kind,
    "data-capability-name": capability.name,
    "data-capability-description": capability.description,
  });
}

/** Imperative composer badges carry the same identity as the rendered ones. */
export function applyAttachmentBadgeAttributes(node: HTMLElement, attachment: ChatAttachment): void {
  for (const [name, value] of Object.entries(attachmentBadgeAttributes(attachment))) {
    node.setAttribute(name, value);
  }
}

export function applyCapabilityBadgeAttributes(
  node: HTMLElement,
  capability: { id: string; kind: CapabilityKind; name: string; description: string },
): void {
  for (const [name, value] of Object.entries(capabilityBadgeAttributes(capability))) {
    node.setAttribute(name, value);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function badgeSpanHtml(attributes: Record<string, string>, innerHtml: string): string {
  const serialized = Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeHtml(value).replaceAll('"', "&quot;")}"`)
    .join(" ");
  return `<span class="attachment-badge" ${serialized}>${innerHtml}</span>`;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

/**
 * `text/html` the message Copy button writes: badge identity plus the same text
 * the inline bubble shows. Pasting into our composer restores the badges;
 * pasting anywhere else still yields readable text.
 */
export function userMessageClipboardHtml(
  parts: ChatMessagePart[],
  attachments: ChatAttachment[],
): string {
  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  return parts
    .map((part) => {
      if (part.kind === "text") {
        return escapeHtml(part.text).replaceAll("\n", "<br>");
      }
      if (part.kind === "capability") {
        return badgeSpanHtml(
          capabilityBadgeAttributes(part.capability),
          `<strong>${escapeHtml(part.capability.name)}</strong><small>Skill</small>`,
        );
      }
      const attachment = attachmentById.get(part.attachmentId);
      return attachment
        ? badgeSpanHtml(
            attachmentBadgeAttributes(attachment),
            `<strong>${escapeHtml(attachment.name)}</strong><small>${escapeHtml(formatFileSize(attachment.size))}</small>`,
          )
        : "";
    })
    .join("");
}

function stringValue(value: string | undefined): string {
  return typeof value === "string" ? value : "";
}

/**
 * Writes plain text plus badge-aware HTML. Falls back to text-only when the
 * rich clipboard API is unavailable (or refused).
 */
export async function writeClipboardRichText(text: string, html: string): Promise<void> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard && html && typeof ClipboardItem !== "undefined") {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      // Fall through to the plain-text path.
    }
  }
  await clipboard?.writeText(text);
}

/**
 * Reads a badge descriptor off a parsed clipboard element (or any node-shaped
 * fixture). Returns null for everything that is not a badge.
 */
export function readBadgeDescriptor(node: {
  dataset?: Record<string, string | undefined> | null;
}): ClipboardBadge | null {
  const dataset = node.dataset;
  if (!dataset) {
    return null;
  }

  if (dataset.attachmentId) {
    return {
      kind: "attachment",
      attachment: {
        id: dataset.attachmentId,
        name: stringValue(dataset.attachmentName) || "Attachment",
        mimeType: stringValue(dataset.attachmentMimeType) || "application/octet-stream",
        size: Number(dataset.attachmentSize ?? 0) || 0,
        kind: dataset.attachmentKind === "image" ? "image" : "file",
        previewUrl: stringValue(dataset.attachmentPreviewUrl) || undefined,
        sourcePath: stringValue(dataset.attachmentSourcePath) || undefined,
      },
    };
  }

  if (dataset.capabilityId && dataset.capabilityKind === "skill") {
    return {
      kind: "capability",
      capability: {
        id: dataset.capabilityId,
        kind: "skill",
        name: stringValue(dataset.capabilityName) || dataset.capabilityId,
        description: stringValue(dataset.capabilityDescription),
      },
    };
  }

  return null;
}

/**
 * Swaps the paste sanitiser's badge placeholders for real badge nodes and the
 * zero-width caret marker that keeps arrow / Backspace behaviour intact.
 * Unresolvable badges are dropped instead of leaking their names as text.
 */
export function replacePasteBadgePlaceholders(
  root: ParentNode,
  badges: ClipboardBadge[],
  create: (badge: ClipboardBadge) => Node | null,
  caretMarker: string,
): void {
  const placeholders = Array.from(root.querySelectorAll(`[${PASTE_BADGE_ATTRIBUTE}]`));
  for (const placeholder of placeholders) {
    const index = Number((placeholder as HTMLElement).dataset?.tenderPasteBadge);
    const badge = Number.isFinite(index) ? badges[index] : undefined;
    const node = badge ? create(badge) : null;
    const parent = placeholder.parentNode;
    if (!parent) {
      continue;
    }
    if (!node) {
      parent.removeChild(placeholder);
      continue;
    }
    parent.replaceChild(node, placeholder);
    if (caretMarker) {
      parent.insertBefore(document.createTextNode(caretMarker), node.nextSibling);
    }
  }
}