import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chatBubbleId, createProvisionalTurn, mergeChatBubbles } from "../src/shared/chatBubbles.ts";
import {
  createChatStreamView,
  finalizeChatStreamView,
  projectStreamEvent,
  type ChatStreamView,
} from "../src/shared/chatStreamProjection.ts";

import type { PromptStreamEvent } from "../src/lib/api";
import type { ChatMessage } from "../src/types";

/**
 * Replay of a real captured run.
 *
 * `tests/fixtures/steerRun.json` was recorded against the actual Pi Desktop server
 * and a real pi session: one prompt that performs two tool rounds, plus a 插话
 * queued during the first round and injected by pi at the turn boundary. The
 * fixture is the server's own NDJSON output, so this test fails if the wire
 * protocol and the client projection ever stop agreeing on where a bubble goes
 * - the class of bug that produced mis-placed 插话, another turn's process
 * blocks leaking into a new bubble, and views frozen until the run ended.
 */

interface Fixture {
  promptTurn: number;
  promptText: string;
  events: PromptStreamEvent[];
  steerAckEvents: PromptStreamEvent[];
  pendingQueues: { steering?: string[]; followUp?: string[]; seq?: number };
  snapshot: ChatMessage[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "steerRun.json"), "utf8"),
) as Fixture;

/** Replay the captured stream the way the UI does: submit optimistically, then project every event. */
function replay(): { view: ChatStreamView; settled: ChatMessage[] } {
  const turn = fixture.promptTurn;
  const thisRun = new Set([
    chatBubbleId(turn, "user"),
    chatBubbleId(turn, "assistant"),
    chatBubbleId(turn + 1, "user"),
    chatBubbleId(turn + 1, "assistant"),
  ]);
  // Earlier turns are already on screen (freshly loaded session).
  const prior = fixture.snapshot.filter((bubble) => !thisRun.has(bubble.id));

  let view: ChatStreamView = createChatStreamView(prior, fixture.pendingQueues.seq ?? 0);
  view = {
    ...view,
    ...createProvisionalTurn(view.bubbles, {
      clientMessageId: "cm-prompt",
      content: fixture.promptText,
      withAssistant: true,
    }),
  };

  let ackInjected = false;
  for (const event of fixture.events) {
    view = projectStreamEvent(view, event);
    if (!ackInjected && event.type === "queued") {
      ackInjected = true;
      // steer 请求自己的流：只回队列状态与 ack，之后不再收事件
      for (const ack of fixture.steerAckEvents) {
        view = projectStreamEvent(view, ack);
      }
    }
  }
  const settled = mergeChatBubbles(finalizeChatStreamView(view).bubbles, fixture.snapshot, {
    pendingQueues: fixture.pendingQueues,
  });
  return { view: finalizeChatStreamView(view), settled };
}

const identity = (list: readonly ChatMessage[]) => list.map((bubble) => [bubble.id, bubble.role]);
const toolIds = (list: readonly ChatMessage[], bubbleId: string) =>
  (list.find((bubble) => bubble.id === bubbleId)?.processBlocks ?? [])
    .filter((block) => block.kind === "tool")
    .map((block) => (block.kind === "tool" ? block.toolCallId : ""));

test("真实事件流回放：前端气泡顺序与服务端快照逐个相同", () => {
  const { view } = replay();
  assert.equal(view.droppedEvents, 0, "真实流里的每个事件都应该被精确寻址");
  assert.deepEqual(identity(view.bubbles), identity(fixture.snapshot));
});

test("真实事件流回放：插话的回答是自己的气泡，且没吞掉上一回合的工具", () => {
  const { settled } = replay();
  const turn = fixture.promptTurn;
  const promptTools = toolIds(settled, chatBubbleId(turn, "assistant"));
  const steerTools = toolIds(settled, chatBubbleId(turn + 1, "assistant"));

  assert.ok(promptTools.length >= 2, "原回合的两次工具调用都留在原气泡里");
  assert.deepEqual(
    steerTools.filter((id) => promptTools.includes(id)),
    [],
    "上一回合的工具不能出现在插话的回答里",
  );
  assert.equal(
    settled.find((bubble) => bubble.id === chatBubbleId(turn + 1, "user"))?.content,
    "插一句：最后额外输出 C",
  );
});

test("真实事件流回放：对账后既不残留 provisional 也不多出气泡", () => {
  const { view, settled } = replay();
  assert.equal(view.bubbles.some((bubble) => bubble.provisional), false);
  assert.equal(settled.length, fixture.snapshot.length);
  assert.deepEqual(identity(settled), identity(fixture.snapshot));
});

test("重复投递 steer 的 ack 队列不会造出幽灵气泡", () => {
  const { view } = replay();
  let next = view;
  for (const ack of fixture.steerAckEvents) {
    next = projectStreamEvent(next, ack);
  }
  assert.deepEqual(identity(next.bubbles), identity(view.bubbles));
});
