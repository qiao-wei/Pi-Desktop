/**
 * 与 pi TUI 的 `restoreQueuedMessagesToEditor` 对齐的纯函数（interactive-mode.js:3503）：
 * 中断时把未消费的 steering / follow-up 消息拼回编辑器文本。
 *
 * 顺序口径与 TUI 一致：
 * - 队列内先全部 steering，再全部 follow-up，条目之间用空行连接；
 * - 排队文本整体在前，编辑器已有文本在后（`[queuedText, currentText].filter(t => t.trim()).join("\n\n")`）。
 */

export interface QueuedComposerMessages {
  steering: readonly string[];
  followUp: readonly string[];
}

/** 把服务端 /api/stop 返回的 clearedQueue 拼成一段编辑器文本；空队列返回空串。 */
export function combineQueuedComposerText(
  steering: readonly string[],
  followUp: readonly string[],
): string {
  return [...steering, ...followUp]
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** 排队文本与编辑器已有文本合并：排队在前，已有在后，任何一段为空白则跳过。 */
export function mergeQueuedWithCurrentText(queuedText: string, currentText: string): string {
  return [queuedText, currentText]
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}
