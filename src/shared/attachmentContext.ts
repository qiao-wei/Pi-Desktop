/**
 * 用户消息里的附件元数据。
 *
 * 提交时正文末尾会附一段 `<pi_desktop_attachments>…</pi_desktop_attachments>`，里面是
 * 展示用的正文（`displayInput`）与附件的结构化信息。转录里存的是**带这段元数据的原文**，
 * 气泡要的是去掉元数据之后的部分——所以解析必须两边一致（服务端建快照、客户端建标题）。
 *
 * 单独成模块是为了让 `chatBubbles.ts` 只负责"转录 → 气泡"，不兼管传输格式。
 */
import { messageToText } from "./messageText.ts";
import type { ChatAttachment, ChatMessagePart } from "../types/domain.ts";

export const ATTACHMENT_CONTEXT_START = "<pi_desktop_attachments>";
export const ATTACHMENT_CONTEXT_END = "</pi_desktop_attachments>";

export interface ParsedAttachmentContext {
  text: string;
  attachments: ChatAttachment[];
  messageParts: ChatMessagePart[];
}

export function messageDisplayText(message: { content?: unknown }): string {
  return parseAttachmentContext(messageToText(message)).text;
}

export function parseAttachmentContext(text: string): ParsedAttachmentContext {
  const start = text.lastIndexOf(ATTACHMENT_CONTEXT_START);
  const end = text.lastIndexOf(ATTACHMENT_CONTEXT_END);
  if (start < 0 || end < start) {
    return { text, attachments: [], messageParts: [] };
  }

  try {
    const metadata = JSON.parse(text.slice(start + ATTACHMENT_CONTEXT_START.length, end).trim());
    return {
      text: String(metadata?.displayInput ?? text.slice(0, start)),
      attachments: Array.isArray(metadata?.attachments) ? metadata.attachments : [],
      messageParts: Array.isArray(metadata?.messageParts) ? metadata.messageParts : [],
    };
  } catch {
    return { text: text.slice(0, start), attachments: [], messageParts: [] };
  }
}

