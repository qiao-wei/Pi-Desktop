/**
 * 「这个附件是什么」只有一个来源：MIME。
 *
 * 图片是 `image/*`，目录是 `inode/directory`（shared-mime-info 给目录登记的标准类型，
 * 也是我们给拖进来的文件夹自报的类型）。客户端在几处把 MIME 翻译成 `AttachmentKind`
 * （编辑器徽标、乐观气泡、剪贴板回环），全走这里，别再各写一遍 startsWith("image/")。
 *
 * 服务端（`server/index.mjs`）是脚本、import 不了这个模块，它在 `persistPromptAttachments`
 * 里按同一个字符串判断目录 —— 改这里的常量要一起改那边。
 */
import type { AttachmentKind } from "../types";

export const DIRECTORY_MIME_TYPE = "inode/directory";

export function attachmentKindFromMimeType(mimeType: string | undefined): AttachmentKind {
  const value = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
  if (value === DIRECTORY_MIME_TYPE) {
    return "directory";
  }
  return value.startsWith("image/") ? "image" : "file";
}

export function isDirectoryAttachment(attachment: { mimeType?: string } | undefined): boolean {
  return attachmentKindFromMimeType(attachment?.mimeType) === "directory";
}