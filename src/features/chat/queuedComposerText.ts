/**
 * 与 pi TUI 的 `restoreQueuedMessagesToEditor` 对齐的纯函数（interactive-mode.js:3503）：
 * 中断时把未消费的 steering / follow-up 消息退回编辑器。
 *
 * 顺序口径与 TUI 一致：
 * - 队列内先全部 steering，再全部 follow-up，条目之间用空行连接；
 * - 排队内容整体在前，编辑器已有内容在后。
 *
 * 服务端 `clearQueue()` 交回的是 pi 队列里存的**原文**。带内联徽标的消息，pi 收到的是
 * 客户端发去的完整 input（正文 + 附件/技能元数据块），所以原文里会夹着文件名、磁盘路径和
 * 一段 JSON。徽标要还原成徽标，就得靠客户端本地留着的 parts；这里的纯函数负责在
 * 「本地排队气泡」与「服务端 clearQueue 原文」之间做取舍。
 */
import type { ChatAttachment, ChatMessage, ChatMessagePart } from "../../types";

export interface QueuedComposerMessages {
  steering: readonly string[];
  followUp: readonly string[];
}

/** 客户端本地保留的一条排队消息：原文 + 能还原徽标的 parts/附件。 */
export interface QueuedComposerEntry {
  /** 用户当时提交的展示文本（不含附件/技能元数据块）。 */
  text: string;
  /** 原始提交的 parts；徽标/附件靠它还原，缺失时退化成纯文本。 */
  parts?: readonly ChatMessagePart[];
  /** parts 里 attachment 引用对应的附件对象。 */
  attachments?: readonly ChatAttachment[];
}

/**
 * `stopTurn` 交给 UI 的退回数据：服务端原文 + 客户端本地排队条目。
 *
 * `entries` 只包含**本地**提交的插话气泡（老 → 新）；`steering` / `followUp`
 * 是 pi 队列的权威原文，两者数量不一致时用原文兜底。
 */
export interface ClearedComposerQueue extends QueuedComposerMessages {
  entries: QueuedComposerEntry[];
}

/** 本地渲染的排队气泡（`provisional && queued`）按显示顺序转成退回条目。 */
export function queuedComposerEntriesFromBubbles(
  bubbles: readonly ChatMessage[],
): QueuedComposerEntry[] {
  return bubbles
    .filter((bubble) => bubble.provisional === true && bubble.queued === true && bubble.role === "user")
    .map((bubble) => ({
      text: bubble.content,
      parts: bubble.contentParts ?? [],
      attachments: bubble.attachments ?? [],
    }));
}

function nonEmpty(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

/**
 * 决定停止后往编辑器里退回什么。
 *
 * pi 的队列是 FIFO，所以「还在队列里」的永远是本地条目的**尾部**；本地比服务端多时，
 * 丢掉最老的（它们已被消费，只是确认事件还没到），避免把已发出的消息又插回输入框。
 * 本地比服务端少时（别的客户端/TUI 排的队），缺的那几条只能按原文退成纯文本。
 */
export function selectRestorableQueuedEntries(
  local: readonly QueuedComposerEntry[],
  cleared: QueuedComposerMessages,
): QueuedComposerEntry[] {
  const steering = nonEmpty(cleared.steering);
  const followUp = nonEmpty(cleared.followUp);
  const clearedCount = steering.length + followUp.length;
  if (clearedCount === 0) {
    return [];
  }
  if (local.length >= clearedCount) {
    return local.slice(local.length - clearedCount);
  }
  const missing = clearedCount - local.length;
  const fallback = [...steering, ...followUp]
    .slice(0, missing)
    .map((text): QueuedComposerEntry => ({ text, parts: [] }));
  return [...fallback, ...local];
}