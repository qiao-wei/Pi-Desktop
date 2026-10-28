/**
 * 一条 assistant 消息的 `content` 数组 → 最终正文 + 过程块。
 *
 * 从 `chatBubbles.ts` 抽出来：气泡模块只管"放在哪"，这里只管"一条消息长什么样"。
 * 两条路径（磁盘转录、服务端快照）都经由它，因此预算（`toolPayloadBudget`）也只在
 * 这里做一次——否则同一份正文会在两个入口裁出两种结果。
 */

import type { MessageProcessBlock } from "../types";
import { callToolDisplay } from "./toolDisplay.ts";
import { budgetToolArgs } from "./toolPayloadBudget.ts";

export type AssistantTextArchiveMode = "final" | "process" | "split-at-last-tool";

export function assistantMessageConversationView(
  content: unknown,
  textArchiveMode: AssistantTextArchiveMode = "final",
): { text: string; processBlocks: MessageProcessBlock[] } {
  if (!Array.isArray(content)) {
    return {
      text: typeof content === "string" ? content.trim() : "",
      processBlocks: [],
    };
  }

  const processBlocks: MessageProcessBlock[] = [];
  const blocks = content as {
    type?: string;
    thinking?: string;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  }[];
  const lastToolBlockIndex =
    textArchiveMode === "split-at-last-tool" ? lastToolCallBlockIndex(blocks) : -1;
  let finalText = "";

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block?.type === "thinking" && block.thinking?.trim()) {
      processBlocks.push({ kind: "thinking", text: block.thinking.trim() });
      continue;
    }

    if (block?.type === "toolCall") {
      const toolName = String(block.name ?? "tool");
      processBlocks.push({
        kind: "tool",
        toolCallId: String(block.id ?? ""),
        toolName,
        // 正文可能是一整份文件：上线前先裁，`__omitted` 记下裁掉多少行/字节。
        callText: JSON.stringify(budgetToolArgs(block.arguments ?? {}), null, 2),
        display: callToolDisplay(toolName, block.arguments),
      });
      continue;
    }

    const text = assistantContentBlockText(block);
    if (!text) {
      continue;
    }

    if (shouldArchiveAssistantText(textArchiveMode, index, lastToolBlockIndex)) {
      pushNoticeProcessBlock(processBlocks, text);
    } else {
      finalText += text;
    }
  }

  return { text: finalText.trim(), processBlocks };
}

function lastToolCallBlockIndex(blocks: readonly { type?: string }[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.type === "toolCall") {
      return index;
    }
  }
  return -1;
}

function shouldArchiveAssistantText(
  mode: AssistantTextArchiveMode,
  blockIndex: number,
  lastToolBlockIndex: number,
): boolean {
  if (mode === "process") {
    return true;
  }
  if (mode === "split-at-last-tool") {
    return lastToolBlockIndex >= 0 && blockIndex < lastToolBlockIndex;
  }
  return false;
}

export function pushNoticeProcessBlock(
  processBlocks: MessageProcessBlock[],
  textValue: string,
): void {
  const text = textValue.trim();
  if (!text) {
    return;
  }

  const previous = processBlocks.at(-1);
  if (previous?.kind === "notice") {
    previous.text = `${previous.text}\n\n${text}`;
    return;
  }

  processBlocks.push({ kind: "notice", text });
}

function assistantContentBlockText(block: { type?: string; text?: string } | undefined): string {
  if (block?.type === "text") {
    return block.text ?? "";
  }
  if (block?.type === "image") {
    return "[image]";
  }
  return "";
}


