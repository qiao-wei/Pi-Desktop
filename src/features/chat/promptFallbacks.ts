/**
 * 空消息的兜底提示词：只挂了附件或只挂了技能徽标时，替用户写一句话给模型。
 *
 * **这两句话服务端有一份镜像**（`server/index.mjs` 的 `attachmentOnlyPrompt` /
 * `capabilityOnlyPrompt`）。渲染进程先把结果填进请求的 `input`，服务端只在 `input` 为空时
 * 才自己补 —— 两边不一致就会出现「气泡里是 A、提示词里是 B」。所以
 * `tests/promptFallbacksParity.test.ts` 会逐字对照两边的模板。
 *
 * 技能那句等价于 TUI 的 `/skill:<name>`（无参数）：
 * - manual-only 技能的正文由 `server/manualSkillPrompt.mjs` 顶在消息最前面；
 * - 已使能的技能由模型自己从 `<available_skills>` 里读。
 */
import type { ChatAttachment, ChatMessagePart } from "../../types";

export function attachmentOnlyPrompt(attachments: readonly ChatAttachment[]): string {
  if (attachments.length === 1) {
    return `Please review the attached ${attachments[0].kind === "directory" ? "folder" : "file"}: ${attachments[0].name}`;
  }
  return `Please review these ${attachments.length} attached files.`;
}

export function capabilityOnlyPrompt(parts: readonly ChatMessagePart[]): string {
  const names = parts
    .filter((part) => part.kind === "capability")
    .map((part) => part.capability?.name?.trim() ?? "")
    .filter((name) => name.length > 0);
  return names.length
    ? `Please use the attached skill: ${names.join(", ")}`
    : "Please use the attached capability.";
}

/** 只挂徽标、没有文字也是一次合法提交（TUI 的 `/skill:name` 无参数形态）。 */
export function hasCapabilityPart(parts: readonly { kind: string }[]): boolean {
  return parts.some((part) => part.kind === "capability");
}

/** 有文字用文字；没有文字就按「附件优先、其次技能徽标」的顺序补一句。 */
export function promptFallback(text: string, attachments: readonly ChatAttachment[], parts: readonly ChatMessagePart[]): string {
  if (text) {
    return text;
  }
  return attachments.length ? attachmentOnlyPrompt(attachments) : capabilityOnlyPrompt(parts);
}