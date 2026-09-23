import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChatBubbles,
  chatBubbleId,
  createBubbleTracker,
  createProvisionalTurn,
  mergeChatBubbles,
  type TranscriptMessage,
} from "../src/shared/chatBubbles.ts";
import {
  createChatStreamView,
  projectStreamEvent,
  type ChatStreamView,
} from "../src/shared/chatStreamProjection.ts";
import type { PromptStreamEvent } from "../src/lib/api";
import type { ChatMessage } from "../src/types";

/**
 * 前后端插入位置一致性契约。
 *
 * 这里把服务端 streamPrompt 的转发顺序模拟一遍（用同一套 createBubbleTracker，
 * 因为服务端就是调它打 bubbleId 的），再把产生的 NDJSON 事件喂给前端投影，
 * 最后要求：前端渲染出来的气泡序列 == 直接用持久化 transcript 跑
 * buildChatBubbles 的结果。等价于「刷新页面看到的顺序，与流式过程中看到的顺序
 * 一模一样」——这正是插话功能原来的三个 bug 的共同根因。
 */

type PiEvent =
  | { kind: "user"; text: string; timestamp: number }
  | { kind: "assistant"; blocks: Record<string, unknown>[]; timestamp: number }
  | { kind: "tool"; toolCallId: string; toolName: string; args: unknown; result: string; timestamp: number };

/** 服务端订阅回调 -> 客户端 NDJSON 事件。 */
function serverEventsFromRun(plan: PiEvent[]): { wire: PromptStreamEvent[]; transcript: TranscriptMessage[] } {
  const tracker = createBubbleTracker(0);
  const wire: PromptStreamEvent[] = [];
  const transcript: TranscriptMessage[] = [];
  const bubbleOf = () => tracker.currentAssistant()?.bubbleId ?? null;

  for (const step of plan) {
    if (step.kind === "user") {
      const ref = tracker.messageStarted("user");
      const message = { role: "user", content: [{ type: "text", text: step.text }], timestamp: step.timestamp };
      transcript.push(message);
      wire.push({ type: "user_message_start", bubbleId: ref?.bubbleId, turn: ref?.turn, content: step.text });
      continue;
    }

    if (step.kind === "assistant") {
      const ref = tracker.messageStarted("assistant");
      const bubbleId = ref?.bubbleId ?? null;
      wire.push({ type: "assistant_message_start", bubbleId, turn: ref?.turn });
      for (const block of step.blocks) {
        if (block.type === "text") {
          wire.push({ type: "delta", bubbleId, delta: String(block.text) });
        }
        if (block.type === "thinking") {
          wire.push({
            type: "assistant_partial",
            bubbleId,
            blocks: [{ type: "thinking", thinking: String(block.thinking) }],
          });
        }
      }
      transcript.push({ role: "assistant", content: step.blocks, timestamp: step.timestamp });
      continue;
    }

    const toolCall = { type: "toolCall", id: step.toolCallId, name: step.toolName, arguments: step.args };
    transcript.push({ role: "assistant", content: [toolCall], timestamp: step.timestamp });
    transcript.push({
      role: "toolResult",
      toolCallId: step.toolCallId,
      toolName: step.toolName,
      content: [{ type: "text", text: step.result }],
      timestamp: step.timestamp + 1,
    });
    wire.push({
      type: "tool_execution_start",
      bubbleId: bubbleOf(),
      toolCallId: step.toolCallId,
      toolName: step.toolName,
      args: step.args,
    });
    wire.push({
      type: "tool_execution_end",
      bubbleId: bubbleOf(),
      toolCallId: step.toolCallId,
      toolName: step.toolName,
      result: step.result,
      isError: false,
    });
  }

  return { wire, transcript };
}

function shape(bubbles: readonly ChatMessage[]) {
  return bubbles.map((bubble) => [bubble.id, bubble.role, bubble.content, (bubble.processBlocks ?? []).length]);
}

test("插话两条：流式过程看到的气泡序列与刷新后 snapshot 完全一致", () => {
  const plan: PiEvent[] = [
    { kind: "user", text: "帮我重构 server", timestamp: 1 },
    { kind: "assistant", blocks: [{ type: "thinking", thinking: "先读代码" }], timestamp: 2 },
    { kind: "tool", toolCallId: "c1", toolName: "read", args: { path: "a.ts" }, result: "…", timestamp: 3 },
    // 用户在 c1 之后插了一句，pi 在回合边界注入
    { kind: "user", text: "顺便补测试", timestamp: 4 },
    { kind: "assistant", blocks: [{ type: "text", text: "好，一起补" }], timestamp: 5 },
    { kind: "tool", toolCallId: "c2", toolName: "edit", args: { path: "a.ts" }, result: "ok", timestamp: 6 },
    { kind: "user", text: "改完记得跑 build", timestamp: 7 },
    { kind: "assistant", blocks: [{ type: "text", text: "已跑，通过" }], timestamp: 8 },
  ];
  const { wire, transcript } = serverEventsFromRun(plan);

  // 前端：第一次提交先放 provisional 气泡
  let view: ChatStreamView = createChatStreamView([]);
  view = {
    ...view,
    ...createProvisionalTurn(view.bubbles, {
      clientMessageId: "cm-1",
      content: "帮我重构 server",
      withAssistant: true,
    }),
  };

  let delivered = 0;
  for (const event of wire) {
    if (event.type === "user_message_start") {
      delivered += 1;
      // 每次投递一条插话时，用户那边已经先看到了 provisional 气泡
      if (delivered > 1) {
        view = {
          ...view,
          ...createProvisionalTurn(view.bubbles, {
            clientMessageId: `cm-${delivered}`,
            content: event.content ?? "",
            withAssistant: false,
          }),
        };
      }
    }
    view = projectStreamEvent(view, event);
  }

  const authoritative = buildChatBubbles(transcript, { isStreaming: false });

  // ① 位置契约：流式过程中看到的气泡序列，与刷新后按 transcript 重算的结果
  //    在 id / 角色 / 顺序上必须逐个相同。
  assert.equal(view.droppedEvents, 0, "所有事件都应该被精确寻址");
  assert.deepEqual(
    view.bubbles.map((bubble) => [bubble.id, bubble.role]),
    authoritative.map((bubble) => [bubble.id, bubble.role]),
  );
  assert.deepEqual(
    view.bubbles.map((bubble) => bubble.id),
    [
      chatBubbleId(1, "user"),
      chatBubbleId(1, "assistant"),
      chatBubbleId(2, "user"),
      chatBubbleId(2, "assistant"),
      chatBubbleId(3, "user"),
      chatBubbleId(3, "assistant"),
    ],
  );
  assert.equal(view.bubbles.some((bubble) => bubble.provisional), false, "不该残留 provisional");

  // ② 收尾契约：回合结束后用快照对账，内容以持久化 transcript 为准
  //    （中途叙述在工具之后会被降级成过程，这条规则两边共用同一个函数），
  //    且不留任何本地多出来的气泡。
  const settled = mergeChatBubbles(view.bubbles, authoritative);
  assert.deepEqual(shape(settled), shape(authoritative));

  // ③ 流式过程中每条回答的内容都写在自己气泡里：插话不吞掉上一回合的过程
  assert.equal(view.bubbles[0].content, "帮我重构 server");
  assert.equal(
    view.bubbles[1].processBlocks?.some((block) => block.kind === "tool" && block.toolCallId === "c1"),
    true,
  );
  assert.equal(
    view.bubbles[3].processBlocks?.some((block) => block.kind === "tool" && block.toolCallId === "c2"),
    true,
  );
  assert.equal(
    view.bubbles[1].processBlocks?.some((block) => block.kind === "tool" && block.toolCallId === "c2"),
    false,
    "第二回合的工具不能出现在第一回合的回答里",
  );
});

test("两条插话同时排队时按 pi 的 FIFO 顺序在原位认领", () => {
  const base = buildChatBubbles(
    [
      { role: "user", content: "问题", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "在写" }], timestamp: 2 },
    ],
    { isStreaming: true },
  );
  let view = createChatStreamView(base);
  for (const [index, text] of ["第一条", "第二条"].entries()) {
    view = {
      ...view,
      ...createProvisionalTurn(view.bubbles, { clientMessageId: `cm-${index}`, content: text }),
    };
  }
  assert.equal(view.bubbles.filter((bubble) => bubble.provisional).length, 2);

  // pi 一次只投递一条，且顺序与入队一致（one-at-a-time）
  const first = projectStreamEvent(
    view,
    { type: "user_message_start", bubbleId: chatBubbleId(2, "user"), turn: 2, content: "第一条（服务端展开后）" },
  );
  const second = projectStreamEvent(
    first,
    { type: "user_message_start", bubbleId: chatBubbleId(3, "user"), turn: 3, content: "第二条（服务端展开后）" },
  );

  assert.deepEqual(
    second.bubbles.map((bubble) => [bubble.id, bubble.content]),
    [
      [chatBubbleId(1, "user"), "问题"],
      [chatBubbleId(1, "assistant"), "在写"],
      [chatBubbleId(2, "user"), "第一条（服务端展开后）"],
      [chatBubbleId(3, "user"), "第二条（服务端展开后）"],
    ],
  );
});
