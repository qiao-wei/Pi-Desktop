/**
 * The tool-call half of the transcript view.
 *
 * A pi transcript stores tool results as `toolResult` messages that carry three
 * things the renderer needs: `content` (already text), `details` (tool-specific,
 * e.g. `edit`'s unified patch) and — on the live wire only — `structuredContent`.
 * Both the persisted-transcript path and the merge path in `chatBubbles` need the
 * same reading of that shape, and it has nothing to do with bubble placement, so
 * it lives here instead of growing the bubble module.
 *
 * The body model itself is derived by {@link deriveToolDisplay}; nothing here
 * parses output text.
 */

import type { MessageProcessBlock } from "../types";
import { messageToText } from "./messageText.ts";
import { deriveToolDisplay, toolDisplayForBlock, type ToolDisplay } from "./toolDisplay.ts";
import { budgetToolResultText, type PayloadCut } from "./toolPayloadBudget.ts";

/**
 * The subset of a transcript message this module reads. Structural rather than
 * imported so `chatBubbles` keeps owning its own `TranscriptMessage` type (and no
 * cycle is created between the two modules).
 */
export interface ToolResultMessageLike {
  toolCallId?: string;
  toolName?: string;
  content?: unknown;
  /** Tool-specific payload; `edit` puts its unified patch here. */
  details?: unknown;
  isError?: boolean;
}

type ToolProcessBlock = Extract<MessageProcessBlock, { kind: "tool" }>;

/** How a persisted tool result reads as text (never `undefined`). */
export function toolResultProcessText(message: ToolResultMessageLike): string {
  return messageToText(message) || "(no output)";
}

/**
 * The persisted result text with the wire budget applied.
 *
 * A transcript from disk can hold whatever an extension tool returned; a snapshot
 * carrying a 20 MB blob would refill the same socket the live stream just drained.
 * The cut is returned alongside so the block can mark itself as shortened.
 */
export function toolResultProcessTextWithCut(message: ToolResultMessageLike): {
  text: string;
  cut: PayloadCut | null;
} {
  const text = toolResultProcessText(message);
  const { text: cut, cut: info } = budgetToolResultText(text);
  return { text: cut, cut: info };
}

/**
 * A tool result with no call before it: the model-visible history starts at the
 * `user` message, so a result whose call scrolled out of the window still has to
 * render as a row. The arguments are gone, hence `(tool call completed)`.
 */
export function toolResultAsProcessBlock(message: ToolResultMessageLike): ToolProcessBlock {
  const toolName = String(message.toolName ?? "tool");
  const result = toolResultProcessTextWithCut(message);
  return {
    kind: "tool",
    toolCallId: String(message.toolCallId ?? ""),
    toolName,
    callText: "(tool call completed)",
    resultText: result.text,
    resultTruncated: result.cut ?? undefined,
    display: toolDisplayForBlock(
      deriveToolDisplay({
        toolName,
        args: undefined,
        result: toolResultEnvelope(message),
        isError: Boolean(message.isError),
      }),
    ),
    status: "done",
    isError: Boolean(message.isError),
  };
}

/**
 * Rebuild the body model for a result that arrives after its call block.
 *
 * The arguments are taken back out of the block's `callText` because a `read`
 * row needs its path to show a file name, and the call's args are the only place
 * the transcript keeps it.
 */
export function toolResultDisplay(
  block: Pick<ToolProcessBlock, "toolName" | "callText">,
  message: ToolResultMessageLike,
): ToolDisplay | undefined {
  return toolDisplayForBlock(
    deriveToolDisplay({
      toolName: block.toolName,
      args: parseToolArgsText(block.callText),
      result: toolResultEnvelope(message),
      isError: Boolean(message.isError),
    }),
  );
}

/**
 * A stored tool result read as the live wire's envelope: `content` + `details`.
 * The `structuredContent` channel does not exist in the transcript, so a bash
 * exit code is live-only; the output itself is still here.
 */
function toolResultEnvelope(message: ToolResultMessageLike): unknown {
  if (message.content === undefined && message.details === undefined) {
    return undefined;
  }
  return { content: message.content, details: message.details };
}

function parseToolArgsText(callText: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(callText);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}