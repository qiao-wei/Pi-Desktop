/**
 * 附件与消息部件的纯函数.
 *
 * 附件上下文编码、MIME 推断、名字清洗、能力部件归一。
 *
 * 从 `server/index.mjs` 搬出来的纯函数（只依赖 import 进来的东西，不碰模块状态）——
 * 那个文件曾经 8.7k 行、棘轮不许它再长，所以按「一簇一文件」往外搬。
 */
import { ATTACHMENT_CONTEXT_END, ATTACHMENT_CONTEXT_START } from "../src/shared/chatBubbles.ts";
import { extname, join } from "node:path";

function appendAttachmentContext(input, displayInput, attachments, messageParts = []) {
  const hasCapabilityParts = messageParts.some((part) => part?.kind === "capability");
  if (!attachments.length && !hasCapabilityParts) {
    return input;
  }

  const metadata = {
    displayInput,
    attachments: attachments.map(({ id, name, mimeType, size, kind, path }) => ({
      id,
      name,
      mimeType,
      size,
      kind,
      path,
    })),
    messageParts,
  };

  return [
    input,
    "",
    ...(attachments.length
      ? [
          "Attached files and folders are available at these local paths. Inspect them with the appropriate tools when needed:",
          ...attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`),
          "",
        ]
      : []),
    ATTACHMENT_CONTEXT_START,
    JSON.stringify(metadata),
    ATTACHMENT_CONTEXT_END,
  ].join("\n");
}

function normalizeMessageCapabilityPart(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = String(source.id ?? "").trim();
  /** @type {"mcp" | "skill" | ""} */
  const kind = source.kind === "mcp" ? "mcp" : source.kind === "skill" ? "skill" : "";
  if (!id || !kind) {
    return null;
  }

  return {
    id,
    kind,
    name: String(source.name ?? id).trim() || id,
    description: String(source.description ?? "").trim(),
    active: source.active === undefined ? undefined : Boolean(source.active),
  };
}

function inferAttachmentMimeType(path) {
  const mimeTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
  };
  return mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function sanitizeAttachmentName(name) {
  return name
    .normalize("NFKC")
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "attachment";
}

export { appendAttachmentContext, normalizeMessageCapabilityPart, inferAttachmentMimeType, sanitizeAttachmentName };
