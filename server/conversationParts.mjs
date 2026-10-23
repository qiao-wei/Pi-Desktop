/**
 * 对话部件的归一.
 *
 * 把 pi 的 part 数组收窄成客户端契约的 ChatMessagePart[]。
 *
 * 从 `server/index.mjs` 搬出来的纯函数（只依赖 import 进来的东西，不碰模块状态）——
 * 那个文件曾经 8.7k 行、棘轮不许它再长，所以按「一簇一文件」往外搬。
 */
import { normalizeMessageCapabilityPart } from "./attachmentHelpers.mjs";

/**
 * 返回 `ChatMessagePart[]`：`flatMap` 各分支的字面量必须靠这个注解收窄成 `kind` 联合，
 * 不然 `{ kind: string, text: string }` 这种宽类型对不上客户端的契约。
 *
 * @param {any} parts
 * @param {any} displayInput
 * @param {any[]} attachments
 * @returns {import("../src/types/domain.ts").ChatMessagePart[]}
 */
function normalizeMessageParts(parts, displayInput, attachments) {
  const attachmentIds = new Set(attachments.map((attachment) => attachment.id));
  // 回调单独命名并写清返回类型：`flatMap` 的推断会挑错重载（把 attachment 分支当成 text 分支），
  // 于是检查器在回调里就报「property 'text' is missing」。类型写在回调上，不靠外层强转。
  /** @type {(part: any) => import("../src/types/domain.ts").ChatMessagePart[]} */
  const toPart = (part) => {
    if (part?.kind === "text") {
      const text = String(part.text ?? "");
      return text ? [{ kind: "text", text }] : [];
    }
    if (part?.kind === "attachment") {
      const attachmentId = String(part.attachmentId ?? "");
      return attachmentIds.has(attachmentId) ? [{ kind: "attachment", attachmentId }] : [];
    }
    if (part?.kind === "capability") {
      const capability = normalizeMessageCapabilityPart(part.capability);
      return capability ? [{ kind: "capability", capability }] : [];
    }
    return [];
  };
  /** @type {import("../src/types/domain.ts").ChatMessagePart[]} */
  const normalized = Array.isArray(parts) ? parts.flatMap(toPart) : [];

  if (normalized.length) {
    return normalized;
  }

  return /** @type {import("../src/types/domain.ts").ChatMessagePart[]} */ ([
    ...(displayInput ? [{ kind: "text", text: String(displayInput) }] : []),
    ...attachments.map((attachment) => ({ kind: "attachment", attachmentId: String(attachment.id) })),
  ]);
}

export { normalizeMessageParts };
