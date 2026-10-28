/**
 * 工具卡片的**身份**：哪个 block 是同一张卡、哪张卡还在等自己的 call id。
 *
 * 抽出来的原因很实际：`chatProcessBlocks.ts` 是合并算法，身份判定是它的输入；
 * 两者混在一个文件里时，每次加一条身份规则都要动那个已顶到行数上限的文件。
 * 这里只 `import type`，所以不会和合并模块成环。
 */

import type { MessageLiveBlock, MessageProcessBlock } from "../types";

type ToolBlock = Extract<MessageProcessBlock, { kind: "tool" }>;

/** 「裁掉多少」是比较字段：对象身份不稳定，数值稳定。 */
export function samePayloadCut(
  a: { bytes: number; lines: number } | undefined,
  b: { bytes: number; lines: number } | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return a.bytes === b.bytes && a.lines === b.lines;
}

export function isToolProcessBlock(block: MessageProcessBlock): block is ToolBlock {
  return block.kind === "tool";
}

/** 一张卡的两个身份键：真正的 call id，以及流里的槽位 id。 */
export function toolProcessBlockKeys(block: ToolBlock): string[] {
  return [
    block.toolCallId ? `id:${block.toolCallId}` : "",
    block.toolStreamId ? `stream:${block.toolStreamId}` : "",
  ].filter(Boolean);
}

export function toolProcessBlocksMatch(first: ToolBlock, second: ToolBlock): boolean {
  const firstKeys = new Set(toolProcessBlockKeys(first));
  return toolProcessBlockKeys(second).some((key) => firstKeys.has(key));
}

/**
 * A tool block whose call id never arrived: it exists only as a stream slot, so
 * a later event that finally names the call has to *bind* into it rather than
 * open a second card for the same call.
 */
function isPendingToolBlock(
  block: MessageProcessBlock | MessageLiveBlock,
  toolName: string,
): block is ToolBlock {
  return (
    block.kind === "tool" &&
    !block.toolCallId &&
    (block.toolName === toolName || !toolName || block.toolName === "tool")
  );
}

/**
 * Index of the placeholder a call id should be bound to. FIFO on purpose: pi
 * executes the tool calls of a message in transcript order, so the first
 * still-anonymous card is the one this execution belongs to.
 */
export function findPendingToolBlockIndex(
  blocks: readonly (MessageProcessBlock | MessageLiveBlock)[],
  toolName: string,
): number {
  if (!toolName) {
    return -1;
  }
  for (let index = 0; index < blocks.length; index += 1) {
    if (isPendingToolBlock(blocks[index], toolName)) {
      return index;
    }
  }
  return -1;
}

/** 最近一张与 `probe` 同身份的卡片（后写的那张赢）。 */
export function findToolBlockIndex<T extends MessageProcessBlock | MessageLiveBlock>(
  blocks: readonly T[],
  probe: ToolBlock,
): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const item = blocks[index];
    if (item.kind === "tool" && toolProcessBlocksMatch(item, probe)) {
      return index;
    }
  }
  return -1;
}