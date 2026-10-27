/**
 * Conversation state → assistant-ui message parts.
 *
 * Split out of `ChatThread` (which is at its size ceiling) and pure on purpose:
 * this is the only place that decides what a `MessageLiveBlock` / 
 * `MessageProcessBlock` looks like to the message renderer, and it is worth being
 * able to read (and test) that mapping without the thread's runtime wiring around
 * it.
 */

import type { ThreadAssistantMessagePart } from "@assistant-ui/react";

import type { ChatMessage, MessageLiveBlock, MessageProcessBlock } from "@/types";

export function toAssistantUiParts(
  block: MessageLiveBlock | MessageProcessBlock,
  isStreaming: boolean,
  partIndex: number,
  isLiveTail: boolean,
): ThreadAssistantMessagePart[] {
  if (block.kind === "text") {
    return [
      {
        type: "text",
        text: block.text,
        // The markdown renderer reads this two ways: `running` opts out of
        // `defer` (a live block must land with the rest of the turn), and it is
        // also what draws the streaming caret via
        // `@assistant-ui/react-markdown/styles/dot.css`. Only the tail block may
        // claim it — anything a tool/thinking part follows is settled, and
        // marking it `running` for the whole turn left its caret on screen.
        status: isLiveTail ? { type: "running" } : { type: "complete" },
      },
    ];
  }

  if (block.kind === "thinking") {
    return [
      {
        type: "reasoning",
        text: block.text,
        status:
          // Explicitly flagged while streaming: `open` is set by the thinking
          // deltas and cleared by `thinking_end`, the synthetic settle, a new
          // streamKey, a text delta, or any tool-block activity. Only the
          // explicit flag may claim "still outputting": blocks without one
          // (persisted transcripts, snapshot rebuilds, unkeyed merges) are by
          // definition settled history. The old last-part heuristic marked
          // exactly those as running - a false「工具卡都出来了，上面的 thinking
          // 还在输出」whenever the last block happened to be a settled panel.
          isStreaming && block.open === true ? { type: "running" } : { type: "complete" },
      },
    ];
  }

  // Notices are narrative text emitted between process parts. Keep them as
  // ordinary assistant text so a collapsed process group still retains and
  // displays the interleaved explanation instead of hiding it in reasoning.
  if (block.kind === "notice") {
    return [{ type: "text", text: block.text }];
  }

  // assistant-ui infers a tool's status from result presence
  // (auto-status: `result === undefined` => still running). Feeding the
  // in-flight partial output into `result` therefore made every tool look
  // finished the moment its first output chunk arrived: the loading shimmer
  // disappeared and the card collapsed early, so a long run showed nothing and
  // then dumped the whole output at the end. Partial output travels in its own
  // field instead, and `result` only appears once the tool truly settled.
  const toolSettled = block.status === "done" || !isStreaming;
  return [
    {
      type: "tool-call",
      toolCallId: block.toolCallId || block.toolStreamId || `tool-${block.toolName}-${partIndex}`,
      toolName: block.toolName || "tool",
      args: parseToolArgs(block.callText),
      argsText: block.callText,
      // Preserve completion even when the tool returned no output. Some tools
      // never send a final result after streaming their output, so the bubble
      // finishing also settles the card.
      result: toolSettled ? block.resultText : undefined,
      partialResult: block.resultText,
      isError: block.isError,
      // The body model the projection derived from pi's result envelope: the row
      // renders a diff / terminal / parameters+result from this, never by parsing
      // `resultText`. See `src/shared/toolDisplay.ts`.
      display: block.display,
    } as unknown as ThreadAssistantMessagePart,
  ];
}

export function userMessageText(message: ChatMessage) {
  if (!message.contentParts?.length) {
    return message.content;
  }

  const attachments = new Map((message.attachments ?? []).map((attachment) => [attachment.id, attachment]));
  return message.contentParts
    .map((part) => {
      if (part.kind === "text") return part.text;
      if (part.kind === "capability") return `[${part.capability.name}]`;
      return attachments.get(part.attachmentId)?.name ?? "[Attachment]";
    })
    .join("");
}

function parseToolArgs(argsText: string) {
  try {
    const value = JSON.parse(argsText);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}