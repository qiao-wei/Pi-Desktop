import test from "node:test";
import assert from "node:assert/strict";

import { createStreamCommitBuffer, type StreamCommitBufferDeps } from "../src/features/chat/streamCommitBuffer.ts";
import { buildChatBubbles, chatBubbleId, type ChatMessage } from "../src/shared/chatBubbles.ts";
import {
  createChatStreamView,
  projectStreamEvent,
  type ChatStreamView,
  type PromptStreamEvent,
} from "../src/shared/chatStreamProjection.ts";

/**
 * 流式提交帧预算（照搬 pi TUI 的闸门 1+2）的回归用例。
 *
 * 真实背景：一次抓取到的运行里，provider 成批回包——静默 1.7~2.3 秒，然后 300ms 内
 * 到达 62~89 条 delta。逐条提交就是 60~90 次 setState + 整棵 thread 重建 + 滚动重钉，
 * “憋一下然后一大坨”的观感被这一步放大。合并到每帧一次只改**提交次数**，
 * 不改内容、不改顺序——所以这些用例的主轴是“等价”和“不丢”。
 */

type Harness = {
  commits: string[][];
  projects: number;
  frames: Array<() => void>;
  baseCalls: number;
  push: (type: string, text?: string) => void;
  flush: () => void;
  runFrame: () => void;
};

function harness(coalesced: string[] = ["delta"]): Harness {
  const commits: string[][] = [];
  const frames: Array<() => void> = [];
  let current: string[] = [];
  const h: Harness = {
    commits,
    projects: 0,
    frames,
    baseCalls: 0,
    push: (type, text) => buffer.push({ type, text } as unknown as PromptStreamEvent),
    flush: () => buffer.flush(),
    runFrame: () => frames.shift()?.(),
  };
  const deps = {
    baseView: () => {
      h.baseCalls += 1;
      return current;
    },
    project: (base: string[], event: { type: string; text?: string }) => {
      h.projects += 1;
      if (event.type === "noop") {
        return base;
      }
      return [...base, `${event.type}:${event.text ?? ""}`];
    },
    commit: (view: string[]) => {
      current = view;
      commits.push(view);
    },
    scheduleFrame: (run: () => void) => {
      frames.push(run);
      return frames.length;
    },
    cancelFrame: () => undefined,
    coalescedTypes: new Set(coalesced),
  } as unknown as StreamCommitBufferDeps;
  const buffer = createStreamCommitBuffer(deps);
  return h;
}

test("成批 delta 只提交一次，但内容一条不丢", () => {
  const h = harness();
  for (let i = 0; i < 40; i += 1) {
    h.push("delta", `t${i}`);
  }
  assert.equal(h.commits.length, 0, "还没到帧，不该提交");
  assert.equal(h.frames.length, 1, "40 条事件只排 1 帧");

  h.runFrame();
  assert.equal(h.commits.length, 1, "一帧一次提交");
  assert.equal(h.projects, 40, "每条事件都被投影过");
  assert.equal(h.commits[0].length, 40);
  assert.equal(h.commits[0][39], "delta:t39", "顺序就是到达顺序");
});

test("排队期间后续事件基于 pending 视图，不再读已提交状态（否则丢字）", () => {
  const h = harness();
  h.push("delta", "a");
  h.push("delta", "b");
  h.push("delta", "c");
  assert.equal(h.baseCalls, 1, "只有第一条需要读已提交状态");
  h.runFrame();
  assert.deepEqual(h.commits[0], ["delta:a", "delta:b", "delta:c"]);
});

test("结构事件先冲队列再立即提交，顺序不被重排", () => {
  const h = harness();
  h.push("delta", "a");
  h.push("delta", "b");
  h.push("tool_call_stream_start", "tool");
  assert.deepEqual(
    h.commits.map((c) => c[c.length - 1]),
    ["delta:b", "tool_call_stream_start:tool"],
    "先把 2 条 delta 落地，再提交工具事件",
  );
  assert.equal(h.commits[0].length, 2);
  assert.equal(h.commits[1].length, 3);
});

test("投影认为无变化时不提交、也不排帧", () => {
  const h = harness();
  h.push("delta", "a");
  h.flush();
  h.commits.length = 0;
  h.frames.length = 0;
  h.push("noop", "x");
  assert.equal(h.commits.length, 0, "无关事件不该造成新引用（否则整棵 thread 白重建）");
  assert.equal(h.frames.length, 0);
});

test("没有可读状态（未知/已关会话）时不提交", () => {
  const commits: string[][] = [];
  const buffer = createStreamCommitBuffer({
    baseView: () => null,
    project: (base: string[]) => [...base, "x"],
    commit: (view: string[]) => commits.push(view),
    scheduleFrame: () => 1,
    cancelFrame: () => undefined,
    coalescedTypes: new Set(["delta"]),
  } as unknown as StreamCommitBufferDeps);
  buffer.push({ type: "delta" } as unknown as PromptStreamEvent);
  buffer.push({ type: "assistant_message_start" } as unknown as PromptStreamEvent);
  buffer.flush();
  assert.deepEqual(commits, []);
});

test("flush 幂等：重复调用只提交一次", () => {
  const h = harness();
  h.push("delta", "a");
  h.flush();
  h.flush();
  h.runFrame();
  assert.equal(h.commits.length, 1);
});

/* -------------------------------------------------------------------------- */
/* 与真投影的等价性：合帧不能改变结果                                            */
/* -------------------------------------------------------------------------- */

test("用真的 projectStreamEvent：合帧提交与逐条立即提交结果完全相同", () => {
  const seed = buildChatBubbles(
    [{ id: "u1", role: "user", content: "看看目录", createdAt: 1, kind: "text", status: "done" } as unknown as ChatMessage],
    1,
  );
  const bubbleId = chatBubbleId(1, "assistant");
  const events: PromptStreamEvent[] = [];
  events.push({ type: "assistant_message_start", bubbleId } as unknown as PromptStreamEvent);
  for (const d of ["我", "来", "看", "看", "目", "录"]) {
    events.push({ type: "thinking_delta", bubbleId, thinkingStreamKey: "assistant-0-thinking-0", delta: d } as unknown as PromptStreamEvent);
  }
  events.push({ type: "tool_call_stream_start", bubbleId, toolStreamId: "assistant-0-tool-content-1", toolName: "bash", args: {} } as unknown as PromptStreamEvent);
  for (const d of ['{"comma', 'nd":"ls"}']) {
    events.push({ type: "tool_call_stream_delta", bubbleId, toolStreamId: "assistant-0-tool-content-1", toolName: "bash", argsText: d } as unknown as PromptStreamEvent);
  }
  events.push({ type: "assistant_partial", bubbleId, closeThinking: true, blocks: [{ type: "thinking", thinking: "我来看看目录", streamKey: "assistant-0-thinking-0" }] } as unknown as PromptStreamEvent);
  for (const d of ["好", "的"]) {
    events.push({ type: "delta", bubbleId, delta: d } as unknown as PromptStreamEvent);
  }

  // 基线：逐条立即提交
  let direct: ChatStreamView = createChatStreamView(seed);
  for (const event of events) {
    direct = projectStreamEvent(direct, event);
    direct = createChatStreamView(direct.bubbles, direct.queueSeq);
  }

  // 合帧：每条事件后都“忘掉”上一帧的提交，逼 buffer 走 pending 路径
  let committed = createChatStreamView(seed);
  let pending: ChatStreamView | null = null;
  let commits = 0;
  const buffer = createStreamCommitBuffer({
    baseView: () => committed,
    project: (view, event) => projectStreamEvent(view, event),
    commit: (view) => {
      commits += 1;
      committed = view;
      pending = null;
    },
    scheduleFrame: (run) => {
      pending = pending ?? null;
      queueMicrotask(run);
      return 1;
    },
    cancelFrame: () => undefined,
  });
  for (const event of events) {
    buffer.push(event);
  }
  buffer.flush();

  assert.equal(commits < events.length, true, "提交次数必须明显少于事件数");
  // 气泡创建时刻是 `Date.now()`，两边差 1ms 属正常，不比时间戳。
  const withoutCreatedAt = (bubbles: ChatMessage[]) =>
    bubbles.map((bubble) => ({ ...bubble, createdAt: 0 }));
  assert.deepEqual(
    withoutCreatedAt(committed.bubbles),
    withoutCreatedAt(direct.bubbles),
    "合并帧不得改变任何一个字",
  );
});
