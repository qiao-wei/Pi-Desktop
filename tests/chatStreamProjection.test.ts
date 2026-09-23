import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChatBubbles,
  chatBubbleId,
  createProvisionalTurn,
  mergeChatBubbles,
  provisionalBubbleId,
  type TranscriptMessage,
} from "../src/shared/chatBubbles.ts";
import {
  createChatStreamView,
  finalizeChatStreamView,
  projectQueueCounts,
  projectStreamEvent,
  streamingBubbleId,
  type ChatStreamView,
} from "../src/shared/chatStreamProjection.ts";
import {
  appendToolCallArgsText,
  upsertToolProcessBlock,
} from "../src/shared/chatProcessBlocks.ts";

import type { PromptStreamEvent } from "../src/lib/api";
import type { ChatMessage, MessageProcessBlock } from "../src/types";

/**
 * 插话（steer）显示的回归测试。
 *
 * 三个真实症状各对应一条用例：插错位置、插话气泡后面挂着上一回合的全部过程、
 * 卡死之后整块突然出现。它们都源自同一个错误做法——用到达顺序和文本相等去猜
 * 事件属于哪个气泡。这里断言的是修正后的契约：事件自带 bubbleId，前端只按 id
 * 寻址；认不出来就丢弃并计数，绝不另找一个气泡写进去。
 */

const userBubble = (turn: number, content: string): ChatMessage => ({
  id: chatBubbleId(turn, "user"),
  role: "user",
  kind: "text",
  content,
  createdAt: turn * 10,
  status: "done",
});

const assistantBubble = (
  turn: number,
  patch: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: chatBubbleId(turn, "assistant"),
  role: "assistant",
  kind: "text",
  content: "",
  processBlocks: [],
  createdAt: turn * 10 + 5,
  status: "streaming",
  ...patch,
});

const event = (payload: Partial<PromptStreamEvent> & { type: PromptStreamEvent["type"] }): PromptStreamEvent =>
  payload as PromptStreamEvent;

/** 回合 1 正在写：问题 + 半个回答，用户此时按下了插话。 */
function streamingTurnOne() {
  const bubbles = [
    userBubble(1, "跑个长任务"),
    assistantBubble(1, {
      processBlocks: [
        { kind: "thinking", text: "先看目录" },
        {
          kind: "tool",
          toolCallId: "call-1",
          toolName: "bash",
          callText: '{"command":"ls"}',
          status: "streaming",
        },
      ],
    }),
  ];
  const { bubbles: withProvisional, turn } = createProvisionalTurn(bubbles, {
    clientMessageId: "cm-1",
    content: "顺便加个测试",
  });
  return {
    view: createChatStreamView(withProvisional),
    provisionalUserId: turn.userMessage.id,
  };
}

test("症状②：插话之后回合仍在继续时，过程块只写进当回合的回答", () => {
  const { view, provisionalUserId } = streamingTurnOne();
  const before = view.bubbles.length;

  let next = projectStreamEvent(
    view,
    event({
      type: "tool_execution_end",
      bubbleId: chatBubbleId(1, "assistant"),
      toolCallId: "call-1",
      toolName: "bash",
      result: "a.txt",
    }),
  );
  next = projectStreamEvent(
    next,
    event({ type: "delta", bubbleId: chatBubbleId(1, "assistant"), delta: "还在说第一回合" }),
  );
  next = projectStreamEvent(
    next,
    event({ type: "assistant_partial", bubbleId: chatBubbleId(1, "assistant"), blocks: [{ type: "thinking", thinking: "继续想" }] }),
  );

  assert.equal(next.bubbles.length, before, "不该冒出新气泡");
  const answer = next.bubbles.find((bubble) => bubble.id === chatBubbleId(1, "assistant"))!;
  assert.equal(answer.content, "还在说第一回合");
  assert.equal(answer.processBlocks?.[1].kind === "tool" && answer.processBlocks[1].resultText, "a.txt");
  assert.equal(
    answer.processBlocks?.some((block) => block.kind === "thinking" && block.text === "继续想"),
    true,
  );

  const provisional = next.bubbles.find((bubble) => bubble.id === provisionalUserId)!;
  assert.equal(provisional.content, "顺便加个测试", "排队中的插话不能被写成别人的过程");
  assert.equal(provisional.role, "user");
  assert.equal(provisional.provisional, true);
});

test("症状①：插话被 pi 展开过文本也照样在原位认领，并排在旧回答之后", () => {
  const { view } = streamingTurnOne();

  // pi 注入时文本已经过 skill/模板展开，跟用户输入的原文不一样。
  let next = projectStreamEvent(
    view,
    event({
      type: "user_message_start",
      bubbleId: chatBubbleId(2, "user"),
      turn: 2,
      content: "<skill:测试规范>\n完整提示词……\n</skill:测试规范>\n\n顺便加个测试",
    }),
  );

  const ids = next.bubbles.map((bubble) => bubble.id);
  assert.deepEqual(ids, [
    chatBubbleId(1, "user"),
    chatBubbleId(1, "assistant"),
    chatBubbleId(2, "user"),
  ]);
  const claimed = next.bubbles.at(-1)!;
  assert.equal(claimed.provisional, false);
  assert.equal(claimed.id, chatBubbleId(2, "user"));
  assert.ok(claimed.content.includes("顺便加个测试"), "换成服务端文本，位置不变");
  assert.equal(next.activeBubbleId, null, "回合边界之后旧气泡不能再被写");

  next = projectStreamEvent(next, event({ type: "assistant_message_start", bubbleId: chatBubbleId(2, "assistant"), turn: 2 }));
  next = projectStreamEvent(next, event({ type: "delta", bubbleId: chatBubbleId(2, "assistant"), delta: "第二回合的回答" }));
  assert.deepEqual(
    next.bubbles.map((bubble) => [bubble.id, bubble.content]),
    [
      [chatBubbleId(1, "user"), "跑个长任务"],
      [chatBubbleId(1, "assistant"), ""],
      [chatBubbleId(2, "user"), claimed.content],
      [chatBubbleId(2, "assistant"), "第二回合的回答"],
    ],
  );
});

test("症状③：快照落后于本地时，对账照常推进且保留排队中的插话", () => {
  const { view } = streamingTurnOne();
  // 本地已经把第一回合说完了，服务端快照还停在更早的一刻
  const snapshot: TranscriptMessage[] = [
    { role: "user", content: "跑个长任务", timestamp: 10 },
    { role: "assistant", content: [{ type: "thinking", thinking: "先看目录" }], timestamp: 15 },
  ];
  const incoming = buildChatBubbles(snapshot, { isStreaming: true, toAttachment: (a) => a });

  const merged = mergeChatBubbles(view.bubbles, incoming);
  const pendingSteer = view.bubbles.find((bubble) => bubble.provisional && bubble.role === "user")!;
  assert.deepEqual(
    merged.map((bubble) => bubble.id),
    [
      chatBubbleId(1, "user"),
      chatBubbleId(1, "assistant"),
      pendingSteer.id,
    ],
    "旧实现会因为 hasPendingSteering 直接跳过对账，这里必须照样合并",
  );
  assert.equal(
    merged.find((bubble) => bubble.id === chatBubbleId(1, "assistant"))?.content,
    "",
  );

  // 插话投递之后，快照里出现它的正式气泡：provisional 让位，不留两份
  const delivered: TranscriptMessage[] = [
    ...snapshot,
    { role: "assistant", content: [{ type: "text", text: "还在说第一回合" }], timestamp: 16 },
    { role: "user", content: "顺便加个测试", timestamp: 20 },
    { role: "assistant", content: [{ type: "text", text: "第二回合的回答" }], timestamp: 21 },
  ];
  let next = projectStreamEvent(
    { ...view, activeBubbleId: chatBubbleId(1, "assistant") },
    event({ type: "delta", bubbleId: chatBubbleId(1, "assistant"), delta: "还在说第一回合" }),
  );
  next = projectStreamEvent(
    next,
    event({ type: "user_message_start", bubbleId: chatBubbleId(2, "user"), turn: 2, content: "顺便加个测试" }),
  );
  const settled = mergeChatBubbles(next.bubbles, buildChatBubbles(delivered, { isStreaming: true }));
  assert.deepEqual(
    settled.map((bubble) => [bubble.id, bubble.status]),
    [
      [chatBubbleId(1, "user"), "done"],
      [chatBubbleId(1, "assistant"), "done"],
      [chatBubbleId(2, "user"), "done"],
      [chatBubbleId(2, "assistant"), "streaming"],
    ],
  );
});

test("queue_update 只做加法：投递前一瞬的收缩不能把气泡删掉", () => {
  const base = [userBubble(1, "问题"), assistantBubble(1)];
  const first = createProvisionalTurn(base, { clientMessageId: "cm-a", content: "插话 A" }).bubbles;
  const view = createChatStreamView(first);

  // pi 在发出这条 user 消息之前就先把它移出队列，所以这里会先到一个变短的队列
  const shrunk = projectQueueCounts(view, { steering: [], followUp: [] });
  assert.equal(shrunk.bubbles.length, view.bubbles.length, "不能因为收缩就丢气泡");
  assert.equal(shrunk.bubbles.at(-1)?.provisional, true);
});

test("别的窗口入队时，队列补上缺失的插话气泡", () => {
  const view = createChatStreamView([userBubble(1, "问题"), assistantBubble(1)]);
  const synced = projectQueueCounts(view, { steering: ["另一条插话"], followUp: [] });
  const added = synced.bubbles.at(-1)!;
  assert.equal(added.provisional, true);
  assert.equal(added.content, "另一条插话");
  assert.equal(synced.bubbles.filter((bubble) => bubble.provisional).length, 1);
  // 服务端一旦把它投递出来，user_message_start 会在原位认领
  const claimed = projectStreamEvent(
    synced,
    event({ type: "user_message_start", bubbleId: chatBubbleId(2, "user"), turn: 2, content: "另一条插话" }),
  );
  assert.equal(claimed.bubbles.at(-1)?.provisional, false);
  assert.equal(claimed.bubbles.at(-1)?.id, chatBubbleId(2, "user"));
});

test("迟到的重复 queued 快照不会复活已投递的插话", () => {
  const base = [userBubble(1, "问题"), assistantBubble(1)];
  let view = createChatStreamView(base);

  // 入队：seq 1，队列里一条
  view = projectStreamEvent(view, event({ type: "queued", behavior: "steer", steering: ["插话"], seq: 1 }));
  assert.equal(view.bubbles.filter((bubble) => bubble.provisional).length, 1);

  // pi 投递前先移出队列（seq 2），随后 user_message_start 在原位认领
  view = projectStreamEvent(view, event({ type: "queued", behavior: "steer", steering: [], seq: 2 }));
  view = projectStreamEvent(
    view,
    event({ type: "user_message_start", bubbleId: chatBubbleId(2, "user"), turn: 2, content: "插话" }),
  );
  assert.equal(view.bubbles.filter((bubble) => bubble.provisional).length, 0);

  // 另一个在途请求的 ack 现在才到：seq 更旧，必须被忽略，否则会冒出一个幽灵
  const late = projectStreamEvent(view, event({ type: "queued", behavior: "steer", steering: ["插话"], seq: 1 }));
  assert.equal(late.bubbles.length, view.bubbles.length, "陈旧队列快照不能新增气泡");
  assert.equal(late.bubbles.filter((bubble) => bubble.provisional).length, 0);
});

test("提交后问题确认时不会插到占位回答上面（加载圆点不能跑到问题前面）", () => {
  const view = createChatStreamView([]);
  const placed = createProvisionalTurn(view.bubbles, {
    clientMessageId: "cm-1",
    content: "说一个字：好",
    withAssistant: true,
  });
  const claimed = projectStreamEvent(
    { ...view, bubbles: placed.bubbles },
    event({ type: "user_message_start", bubbleId: chatBubbleId(1, "user"), turn: 1, content: "说一个字：好" }),
  );
  assert.deepEqual(
    claimed.bubbles.map((bubble) => bubble.id),
    [chatBubbleId(1, "user"), provisionalBubbleId("cm-1", "assistant", 1)],
  );
  // 占位回答仍是唯一"在跑"的气泡
  assert.equal(streamingBubbleId(claimed.bubbles), provisionalBubbleId("cm-1", "assistant", 1));

  const started = projectStreamEvent(
    claimed,
    event({ type: "assistant_message_start", bubbleId: chatBubbleId(1, "assistant"), turn: 1 }),
  );
  assert.deepEqual(
    started.bubbles.map((bubble) => bubble.id),
    [chatBubbleId(1, "user"), chatBubbleId(1, "assistant")],
  );
  assert.equal(streamingBubbleId(started.bubbles), chatBubbleId(1, "assistant"));
});

test("steer 排队期间圆点留在上一回合，插话被投递后才跟到新回合", () => {
  const base = [userBubble(1, "问题"), assistantBubble(1, { status: "streaming" })];
  let view = createChatStreamView(base);
  const steer = createProvisionalTurn(view.bubbles, { clientMessageId: "cm-s", content: "插一句" });
  view = { ...view, bubbles: steer.bubbles };
  assert.equal(streamingBubbleId(view.bubbles), chatBubbleId(1, "assistant"), "圆点还在上一回合");

  // pi 是在上一回合（含工具）跑完之后才投递插话的，所以这一刻上一回合就收尾：
  // 圆点不会同时亮两个，也不会留在插话前面。
  view = projectStreamEvent(
    view,
    event({ type: "user_message_start", bubbleId: chatBubbleId(2, "user"), turn: 2, content: "插一句" }),
  );
  assert.equal(streamingBubbleId(view.bubbles), null);
  assert.equal(view.bubbles.find((bubble) => bubble.id === chatBubbleId(1, "assistant"))?.status, "done");

  view = projectStreamEvent(
    view,
    event({ type: "assistant_message_start", bubbleId: chatBubbleId(2, "assistant"), turn: 2 }),
  );
  assert.equal(streamingBubbleId(view.bubbles), chatBubbleId(2, "assistant"));
  assert.equal(
    view.bubbles.find((bubble) => bubble.id === chatBubbleId(1, "assistant"))?.status,
    "done",
    "上一回合收尾，不留第二个圆点",
  );
});

test("认不出归属的事件被计数丢弃，不会污染任何气泡", () => {
  // 已知当前在写哪个气泡时，未带 id 的旧事件仍可安全落地（向后兼容）
  const { view } = streamingTurnOne();
  const tolerated = projectStreamEvent(view, event({ type: "delta", delta: "旧服务端的一截" }));
  assert.equal(tolerated.activeBubbleId, chatBubbleId(1, "assistant"));
  assert.equal(tolerated.bubbles.find((b) => b.id === chatBubbleId(1, "assistant"))?.content, "旧服务端的一截");
  assert.equal(tolerated.droppedEvents, 0);

  // 回合边界之后没有 active 气泡：宁可不显示，也不猜一个气泡写进去
  const idle: ChatStreamView = { ...tolerated, activeBubbleId: null };
  const dropped = projectStreamEvent(idle, event({ type: "delta", delta: "来路不明的一截" }));
  assert.equal(dropped.droppedEvents, 1);
  assert.equal(dropped.bubbles, idle.bubbles, "丢弃时不产生新引用");
  const unknownBubble = projectStreamEvent(idle, event({ type: "assistant_message_start" }));
  assert.equal(unknownBubble.droppedEvents, 1);
});

test("delta 先于 assistant_message_start 到达时按 id 建气泡并落在对的位置", () => {
  const view = createChatStreamView([userBubble(1, "问题"), userBubble(2, "插话")]);
  const next = projectStreamEvent(
    view,
    event({ type: "delta", bubbleId: chatBubbleId(1, "assistant"), delta: "答一" }),
  );
  assert.deepEqual(
    next.bubbles.map((bubble) => bubble.id),
    [chatBubbleId(1, "user"), chatBubbleId(1, "assistant"), chatBubbleId(2, "user")],
  );
  assert.equal(next.activeBubbleId, chatBubbleId(1, "assistant"));
});

test("重复的 cumulative partial 不产生新引用（流式热路径）", () => {
  const view = createChatStreamView([userBubble(1, "问题"), assistantBubble(1)]);
  const blocks = [{ type: "thinking" as const, thinking: "同一段思考" }];
  const once = projectStreamEvent(view, event({ type: "assistant_partial", bubbleId: chatBubbleId(1, "assistant"), blocks }));
  const twice = projectStreamEvent(once, event({ type: "assistant_partial", bubbleId: chatBubbleId(1, "assistant"), blocks }));
  assert.equal(twice.bubbles, once.bubbles);
  assert.equal(twice.bubbles[1], once.bubbles[1]);
});

test("finalizeChatStreamView 收尾：本地气泡不再挂着 streaming", () => {
  const { view } = streamingTurnOne();
  const finalized = finalizeChatStreamView(view);
  assert.equal(finalized.activeBubbleId, null);
  assert.equal(
    finalized.bubbles.find((bubble) => bubble.id === chatBubbleId(1, "assistant"))?.status,
    "done",
  );
  assert.equal(
    finalized.bubbles.find((bubble) => bubble.provisional)?.status,
    "done",
    "provisional 的占位回答不由 finalize 处理，等确认或回滚",
  );
});

test("插话起新回合（服务端当时没在流式）时也能正常渲染", () => {
  // 客户端以为是 steer，服务端其实开了新回合：事件仍带 id，投影不关心是谁发起的
  let view = createChatStreamView([userBubble(1, "问题"), assistantBubble(1, { content: "答一", status: "done" })]);
  view = projectStreamEvent(
    view,
    event({ type: "user_message_start", bubbleId: chatBubbleId(2, "user"), turn: 2, content: "第二条" }),
  );
  view = projectStreamEvent(view, event({ type: "assistant_message_start", bubbleId: chatBubbleId(2, "assistant"), turn: 2 }));
  view = projectStreamEvent(view, event({ type: "delta", bubbleId: chatBubbleId(2, "assistant"), delta: "答二" }));
  assert.deepEqual(
    view.bubbles.map((bubble) => [bubble.id, bubble.content]),
    [
      [chatBubbleId(1, "user"), "问题"],
      [chatBubbleId(1, "assistant"), "答一"],
      [chatBubbleId(2, "user"), "第二条"],
      [chatBubbleId(2, "assistant"), "答二"],
    ],
  );
  assert.equal(view.droppedEvents, 0);
});

/* -------------------------------------------------------------------------- */
/* 逐 token 增量：思考文本与工具参数                                             */
/* -------------------------------------------------------------------------- */

/**
 * 服务端一度把这两类事件压成"每 120ms 一份累计快照"，代价是用户看到的
 * reasoning 变成"卡一下吐一坨"、工具参数的打字机动画彻底看不见。
 * 现在的契约：pi 的增量 delta 直接逐 token 下发，thinking 的累计快照只在
 * `thinking_end` 出现（`tool_call_stream_end` 等同理）——开场时 `partial` 还在被
 * provider 就地改写，那份正文属于还没发出去的 delta。
 */
test("thinking_delta 逐 token 追加到 liveBlocks，首条 delta 就开块", () => {
  let view = createChatStreamView([userBubble(1, "问题")]);
  view = projectStreamEvent(view, event({ type: "assistant_message_start", bubbleId: chatBubbleId(1, "assistant"), turn: 1 }));

  const before = view.bubbles[1];
  view = projectStreamEvent(view, event({ type: "thinking_delta", bubbleId: chatBubbleId(1, "assistant"), delta: "先" }));
  view = projectStreamEvent(view, event({ type: "thinking_delta", bubbleId: chatBubbleId(1, "assistant"), delta: "想一想" }));
  const after = view.bubbles[1];

  assert.deepEqual(
    after.liveBlocks,
    // `open` 是显式的“这一块还在想”标记（不再靠“是不是最后一块”反推）
    [{ kind: "thinking", text: "先想一想", open: true }],
    "两次 delta 合成同一条思考块",
  );
  assert.deepEqual(after.processBlocks, before.processBlocks, "逐 token 不动持久化列表（累计快照负责）");
  assert.equal(after.status, "streaming");

  // 空 delta 必须保持身份，否则每帧都在重建整棵 thread
  const same = projectStreamEvent(view, event({ type: "thinking_delta", bubbleId: chatBubbleId(1, "assistant"), delta: "" }));
  assert.equal(same.bubbles[1], after, "空 delta 不产生新对象");
});

test("thinking 的累计快照只在收尾时定稿：开场快照不得给 live 播种正文", () => {
  let view = createChatStreamView([userBubble(1, "问题")]);
  view = projectStreamEvent(view, event({ type: "assistant_message_start", bubbleId: chatBubbleId(1, "assistant"), turn: 1 }));
  view = projectStreamEvent(
    view,
    event({ type: "assistant_partial", bubbleId: chatBubbleId(1, "assistant"), blocks: [{ type: "thinking", thinking: "先" }] }),
  );

  // 开场快照不带 closeThinking：它的正文是从未来借的，live 列表只认 delta。
  assert.deepEqual(view.bubbles[1].liveBlocks, [], "开场快照不再提前播种推理正文");

  view = projectStreamEvent(view, event({ type: "thinking_delta", bubbleId: chatBubbleId(1, "assistant"), delta: "想一想" }));
  view = projectStreamEvent(
    view,
    event({
      type: "assistant_partial",
      bubbleId: chatBubbleId(1, "assistant"),
      closeThinking: true,
      blocks: [{ type: "thinking", thinking: "先想一想" }],
    }),
  );

  const bubble = view.bubbles[1];
  assert.equal((bubble.processBlocks?.[0] as { text?: string })?.text, "先想一想", "持久化块由累计快照定稿");
  assert.deepEqual(
    bubble.liveBlocks?.slice(-1),
    // 没有 streamKey 的快照（旧服务端）走“文本前缀”兼容路径，那一支本来就不写 `open`，
    // 渲染时退回位置判断；带 key 的新链路会显式落 `open: false`（见下面那条用例）。
    [{ kind: "thinking", text: "先想一想" }],
    "live 块收敛到同一文本，不重复拼接",
  );
});

/* -------------------------------------------------------------------------- */
/* 推理与工具交替：身份不能靠“最后一块同类型的”猜                              */
/* -------------------------------------------------------------------------- */

/**
 * 一回合一次提问只有一个气泡（`chatBubbles.ts` 的 turn 规则），所以第 2、3 轮
 * 的 thinking 全部写回同一个气泡的 liveBlocks。旧实现用“从后往前找同类块 + 文本
 * 前缀”认定它们是同一块，于是新一轮的思考被并进上一轮那块（它在 tool 上面），
 * 用户看到的就是“推理卡住 → 上面的 tool 在动 → tool 完事后又在同一个推理框里继续想”。
 * 现在的契约：thinking 带 streamKey，认 key 不认文本。
 */
test("两轮 thinking 文本相同时也各开各的块，不会被并进 tool 上面那一块", () => {
  let view = createChatStreamView([userBubble(1, "问题")]);
  view = projectStreamEvent(view, event({ type: "assistant_message_start", bubbleId: chatBubbleId(1, "assistant"), turn: 1 }));
  view = projectStreamEvent(
    view,
    event({
      type: "thinking_delta",
      bubbleId: chatBubbleId(1, "assistant"),
      thinkingStreamKey: "assistant-0-thinking-0",
      delta: "我想",
    }),
  );
  view = projectStreamEvent(
    view,
    event({
      type: "tool_call_stream_start",
      bubbleId: chatBubbleId(1, "assistant"),
      toolStreamId: "assistant-0-tool-content-1",
      toolName: "bash",
      args: {},
    }),
  );
  // 第二轮 thinking 的收尾累计快照：文本跟第一轮一模一样。
  // （开场快照不再带正文，见 `assistantThinkingBlocks` 的注释，所以这里用 closeThinking。）
  view = projectStreamEvent(
    view,
    event({
      type: "assistant_partial",
      bubbleId: chatBubbleId(1, "assistant"),
      closeThinking: true,
      blocks: [{ type: "thinking", thinking: "我想", streamKey: "assistant-1-thinking-0" }],
    }),
  );

  const blocks = view.bubbles[1].liveBlocks ?? [];
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["thinking", "tool", "thinking"],
    "新一轮 thinking 开在 tool 下面，不并进上面那块",
  );
  assert.equal((blocks[0] as { streamKey?: string }).streamKey, "assistant-0-thinking-0");
  assert.equal((blocks[2] as { streamKey?: string }).streamKey, "assistant-1-thinking-0");
  assert.equal((blocks[0] as { open?: boolean }).open, false, "开 tool 时上一轮 thinking 已经关段");
  assert.equal((blocks[2] as { open?: boolean }).open, undefined, "没收到 delta 前不会自己亮 spinner");

  // 同 key 的后续 delta / 快照仍然写回同一块，不会一人一块。
  view = projectStreamEvent(
    view,
    event({
      type: "thinking_delta",
      bubbleId: chatBubbleId(1, "assistant"),
      thinkingStreamKey: "assistant-1-thinking-0",
      delta: "继续",
    }),
  );
  const after = view.bubbles[1].liveBlocks ?? [];
  assert.equal(after.length, 3, "同 key 的 delta 不开新块");
  assert.deepEqual(
    after[2],
    { kind: "thinking", text: "我想继续", streamKey: "assistant-1-thinking-0", open: true },
    "同 key 的 delta 追到本块并亮 spinner",
  );

  // thinking_end 的快照负责关段：从此面板不再“在 thinking”
  view = projectStreamEvent(
    view,
    event({
      type: "assistant_partial",
      bubbleId: chatBubbleId(1, "assistant"),
      closeThinking: true,
      blocks: [{ type: "thinking", thinking: "我想继续", streamKey: "assistant-1-thinking-0" }],
    }),
  );
  assert.equal((view.bubbles[1].liveBlocks?.[2] as { open?: boolean }).open, false, "thinking_end 关段");
});

/**
 * 工具卡片的身份：stream  slot（assistant-N-tool-content-J）和 call id 是两个不同的东西。
 * 旧实现把 toolStreamId 拿来冒名顶替缺失的 toolCallId，导致真正带 id 的执行事件
 * 既匹配不上已流式创建的卡、也不能“认领”它——于是在底部另开一张卡，
 * 表现为“卡一下，然后下面的工具一次性全都出现”。
 */
test("执行事件带 call id、流式卡没 id 时绑定到原卡而不是再开一张", () => {
  let view = createChatStreamView([userBubble(1, "问题")]);
  view = projectStreamEvent(view, event({ type: "assistant_message_start", bubbleId: chatBubbleId(1, "assistant"), turn: 1 }));
  // 流式阶段 partial 里还取不到 id（provider 先开块后补 id）：只有 slot。
  view = projectStreamEvent(
    view,
    event({
      type: "tool_call_stream_start",
      bubbleId: chatBubbleId(1, "assistant"),
      toolStreamId: "assistant-0-tool-content-0",
      toolName: "bash",
      args: {},
    }),
  );
  view = projectStreamEvent(
    view,
    event({
      type: "tool_call_stream_delta",
      bubbleId: chatBubbleId(1, "assistant"),
      toolStreamId: "assistant-0-tool-content-0",
      argsText: '{"command":"ls -la"}',
    }),
  );
  // 执行事件拿不到 streamId（id 从未在流式阶段出现过），只带真 id。
  view = projectStreamEvent(
    view,
    event({
      type: "tool_execution_start",
      bubbleId: chatBubbleId(1, "assistant"),
      toolCallId: "call-9",
      toolName: "bash",
      args: { command: "ls -la" },
    }),
  );

  const blocks = view.bubbles[1].processBlocks ?? [];
  assert.equal(blocks.length, 1, "同一调用只应该有一张卡");
  assert.equal((blocks[0] as { toolCallId?: string }).toolCallId, "call-9", "真 id 绑回原卡");
  assert.equal((blocks[0] as { toolStreamId?: string }).toolStreamId, "assistant-0-tool-content-0");
  assert.equal((blocks[0] as { status?: string }).status, "streaming", "刚开始执行不算完成");

  // 后续输出用真 id 寻址，写的还是同一张卡
  view = projectStreamEvent(
    view,
    event({
      type: "tool_execution_update",
      bubbleId: chatBubbleId(1, "assistant"),
      toolCallId: "call-9",
      toolName: "bash",
      partialResult: "total 8",
    }),
  );
  const settled = view.bubbles[1].processBlocks ?? [];
  assert.equal(settled.length, 1);
  assert.equal((settled[0] as { resultText?: string }).resultText, "total 8");
});

test("tool_call_stream_delta 按 argsText 逐 token 追加，end 用解析后的 args 覆盖", () => {
  const stream = "assistant-0-tool-content-1";
  let view = createChatStreamView([userBubble(1, "问题")]);
  view = projectStreamEvent(view, event({ type: "assistant_message_start", bubbleId: chatBubbleId(1, "assistant"), turn: 1 }));
  view = projectStreamEvent(
    view,
    event({ type: "tool_call_stream_start", bubbleId: chatBubbleId(1, "assistant"), toolStreamId: stream, toolName: "bash", args: {} }),
  );
  view = projectStreamEvent(
    view,
    event({ type: "tool_call_stream_delta", bubbleId: chatBubbleId(1, "assistant"), toolStreamId: stream, argsText: '{"command":"ls ' }),
  );
  view = projectStreamEvent(
    view,
    event({ type: "tool_call_stream_delta", bubbleId: chatBubbleId(1, "assistant"), toolStreamId: stream, argsText: '-la"}' }),
  );

  const streaming = view.bubbles[1].processBlocks?.[0] as { callText?: string; status?: string };
  assert.equal(streaming.callText, '{"command":"ls -la"}', "参数文本逐步拼出来，打字机才有东西可演");
  assert.equal(streaming.status, "streaming");

  view = projectStreamEvent(
    view,
    event({
      type: "tool_call_stream_end",
      bubbleId: chatBubbleId(1, "assistant"),
      toolStreamId: stream,
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls -la" },
    }),
  );
  const done = view.bubbles[1].processBlocks?.[0] as { callText?: string; toolCallId?: string };
  assert.equal(done.toolCallId, "call-1");
  assert.match(done.callText ?? "", /"command":\s*"ls -la"/, "end 用解析后的对象做美化 JSON");
});

test("两个工具并行时 argsText 各写各的块，不串台", () => {
  let view = createChatStreamView([userBubble(1, "问题")]);
  view = projectStreamEvent(view, event({ type: "assistant_message_start", bubbleId: chatBubbleId(1, "assistant"), turn: 1 }));
  for (const id of ["s-A", "s-B"]) {
    view = projectStreamEvent(
      view,
      event({ type: "tool_call_stream_start", bubbleId: chatBubbleId(1, "assistant"), toolStreamId: id, toolName: id, args: {} }),
    );
  }
  view = projectStreamEvent(
    view,
    event({ type: "tool_call_stream_delta", bubbleId: chatBubbleId(1, "assistant"), toolStreamId: "s-A", argsText: "A1" }),
  );
  view = projectStreamEvent(
    view,
    event({ type: "tool_call_stream_delta", bubbleId: chatBubbleId(1, "assistant"), toolStreamId: "s-B", argsText: "B1" }),
  );
  view = projectStreamEvent(
    view,
    event({ type: "tool_call_stream_delta", bubbleId: chatBubbleId(1, "assistant"), toolStreamId: "s-A", argsText: "A2" }),
  );

  assert.deepEqual(
    view.bubbles[1].processBlocks?.map((block) => [block.toolName, (block as { callText?: string }).callText]),
    [
      ["s-A", "A1A2"],
      ["s-B", "B1"],
    ],
  );
});

test("context_usage 事件不寻址气泡，也不算寻址失败", () => {
  const view = createChatStreamView([userBubble(1, "问题"), assistantBubble(1, { status: "streaming" })]);

  const next = projectStreamEvent(view, {
    type: "context_usage",
    contextTokens: 12_345,
    contextWindow: 200_000,
    contextPercent: 6.2,
  } as PromptStreamEvent);

  assert.equal(next, view);
  assert.equal(next.droppedEvents, 0);
  assert.equal(next.activeBubbleId, chatBubbleId(1, "assistant"));
});

/* -------------------------------------------------------------------------- */
/* 推理面板首块重复（真机埋点定位）                                              */
/* -------------------------------------------------------------------------- */

/** live 列表里的推理正文，按出现顺序。 */
const liveThinking = (message: ChatMessage): string[] =>
  (message.liveBlocks ?? []).flatMap((block) => (block.kind === "thinking" ? [block.text] : []));

const thinkingStreamKey = "assistant-0-thinking-0";
const snapshotBlocks = (text: string) => [
  { type: "thinking" as const, thinking: text, streamKey: thinkingStreamKey },
];

test("开场快照的抢跑正文不写进 live 推理块：delta 才是唯一来源", () => {
  let view = createChatStreamView([userBubble(1, "问题"), assistantBubble(1)]);
  const feed = (payload: Partial<PromptStreamEvent> & { type: PromptStreamEvent["type"] }) => {
    view = projectStreamEvent(
      view,
      event({ bubbleId: chatBubbleId(1, "assistant"), ...payload } as PromptStreamEvent),
    );
    return view.bubbles[1];
  };

  // pi 的 `partial` 是就地改写的活对象：`thinking_start` 那一刻读到的正文，
  // 其实来自还没发出去的 delta。旧实现在这里就把块播种成正文，随后同一批 delta
  // 再 append 一遍 → 「the the book」。
  const opened = feed({ type: "assistant_partial", closeThinking: false, blocks: snapshotBlocks("The user hasn") });
  assert.deepEqual(liveThinking(opened), [], "开场快照不得提前落地推理正文");

  feed({ type: "thinking_delta", thinkingStreamKey, delta: "The" });
  const streamed = feed({ type: "thinking_delta", thinkingStreamKey, delta: " user hasn" });
  assert.deepEqual(liveThinking(streamed), ["The user hasn"], "正文只能由 delta 拼出来");

  const closed = feed({
    type: "assistant_partial",
    closeThinking: true,
    blocks: snapshotBlocks("The user hasn't asked anything"),
  });
  assert.deepEqual(liveThinking(closed), ["The user hasn't asked anything"], "收尾快照才是权威正文");
  assert.equal(
    closed.liveBlocks?.filter((block) => block.kind === "thinking").length,
    1,
    "全程只应有一个推理块",
  );
  assert.equal(
    closed.liveBlocks?.find((block) => block.kind === "thinking" && block.open === true),
    undefined,
    "收尾之后面板要落定",
  );
});

test("非收尾快照照样合并 notice：被挡住的只有 thinking 正文", () => {
  let view = createChatStreamView([userBubble(1, "问题"), assistantBubble(1)]);

  view = projectStreamEvent(
    view,
    event({
      type: "assistant_partial",
      bubbleId: chatBubbleId(1, "assistant"),
      closeThinking: false,
      blocks: [{ type: "notice" as const, notice: "已在后台压缩上下文" }],
    }),
  );

  const liveBlocks = view.bubbles[1].liveBlocks ?? [];
  assert.deepEqual(
    liveBlocks.flatMap((block) => (block.kind === "notice" ? [block.text] : [])),
    ["已在后台压缩上下文"],
    "notice 没有 delta 流，任何快照都得立刻落地，否则永远不出现",
  );
});

/**
 * 不带正文的“合成关圈”：服务端适配器 A 方案依赖的客户端契约。
 *
 * `openai-completions` 一类 provider 要把所有块结束事件压到整条 message 收尾才
 * 补发（真机实测：最后一个 delta 之后 0.4~4.1 秒），而 pi 的内容块是顺序流的：
 * 下一个块（正文 / 工具调用 / 新一轮思考）一开始，就证明上一块思考已经结束。
 * 所以服务端会在那个时刻发一条 **只带 streamKey、正文为空**的 `assistant_partial`。
 * 它必须只清 `open`，不得碰到已经逐 token 流出来的正文。
 */
test("文本为空的收尾快照只清 open，不碰已流出的正文，且幂等", () => {
  let view = createChatStreamView([userBubble(1, "问题")]);
  const feed = (payload: Partial<PromptStreamEvent> & { type: PromptStreamEvent["type"] }) => {
    view = projectStreamEvent(
      view,
      event({ bubbleId: chatBubbleId(1, "assistant"), ...payload } as PromptStreamEvent),
    );
    return view.bubbles[1];
  };
  const key = "assistant-0-thinking-0";
  const openThinking = () =>
    (view.bubbles[1].liveBlocks ?? []).filter((block) => block.kind === "thinking" && block.open === true);
  const textlessClose = () =>
    feed({
      type: "assistant_partial",
      closeThinking: true,
      blocks: [{ type: "thinking", thinking: "", streamKey: key }],
    });

  feed({ type: "assistant_message_start", turn: 1 });
  feed({ type: "thinking_delta", thinkingStreamKey: key, delta: "让我看看" });
  feed({ type: "thinking_delta", thinkingStreamKey: key, delta: "目录" });
  assert.equal(openThinking().length, 1, "思考中：面板保持 running");

  const settled = textlessClose();
  assert.deepEqual(
    settled.liveBlocks,
    [{ kind: "thinking", text: "让我看看目录", streamKey: key, open: false }],
    "关圈只改状态，正文一个字不能动",
  );

  const repeated = textlessClose();
  assert.equal(repeated, settled, "重复关圈必须保持气泡引用不变（否则每帧重建整棵 thread）");

  // provider 迟到的真收尾：全量正文仍然可以覆盖（delta 丢包时靠它纠正）
  const final = feed({
    type: "assistant_partial",
    closeThinking: true,
    blocks: [{ type: "thinking", thinking: "让我看看目录结构", streamKey: key }],
  });
  assert.equal(
    (final.liveBlocks?.[0] as { text?: string }).text,
    "让我看看目录结构",
    "迟到的权威正文照常覆盖",
  );

  // 关圈不影响后续轮次：新一轮思考照常另开一块，仍在思考中
  feed({ type: "thinking_delta", thinkingStreamKey: "assistant-1-thinking-0", delta: "再看一下" });
  assert.equal(openThinking().length, 1, "新一轮思考自己开面板");
  assert.deepEqual(
    (view.bubbles[1].liveBlocks ?? []).map((block) => block.kind),
    ["thinking", "thinking"],
    "两轮思考各自独立",
  );
});

/**
 * 「工具卡都出来了，上面的 thinking 还在输出」的三个数据层根源，各自的契约。
 *
 * 它们的共同点：面板的“还在输出”是数据（thinking 块的 `open` 标记），只要任何
 * 一条路径能让工具卡存在时 `open` 仍是 true，用户就会看到上面那块还在打字。
 * 修复后客户端必须自愈，不依赖任何单个服务端事件不丢。
 */

/** 块序列签名：R*=还在输出的推理 R=已完成推理 T=工具卡 X=文本 N=notice。 */
const shapeOf = (blocks: readonly MessageProcessBlock[]): string =>
  blocks
    .map((block) =>
      block.kind === "thinking"
        ? block.open === true
          ? "R*"
          : "R"
        : block.kind === "tool"
          ? "T"
          : block.kind === "notice"
            ? "N"
            : "X",
    )
    .join("");
const liveShape = (message: ChatMessage): string => shapeOf(message.liveBlocks ?? []);

function streamFixture(turn: number) {
  let view = createChatStreamView([userBubble(turn, "问题")]);
  const feed = (payload: Partial<PromptStreamEvent> & { type: PromptStreamEvent["type"] }) => {
    view = projectStreamEvent(
      view,
      event({ bubbleId: chatBubbleId(turn, "assistant"), ...payload } as PromptStreamEvent),
    );
    return view.bubbles[1];
  };
  feed({ type: "assistant_message_start", turn });
  return { feed, message: () => view.bubbles[1], view: () => view };
}

test("同 key 的迟到 delta 并回原块，但不重新点亮：不得另造第二块", () => {
  const { feed, message } = streamFixture(1);
  const key = "assistant-0-thinking-0";

  feed({ type: "thinking_delta", thinkingStreamKey: key, delta: "第一轮思考" });
  feed({ type: "tool_call_stream_start", toolStreamId: "s1", toolCallId: "call1", toolName: "read", args: {} });
  feed({ type: "tool_execution_end", toolCallId: "call1", toolStreamId: "s1", toolName: "read", result: "ok" });
  assert.equal(liveShape(message()), "RT", "工具卡出现时上面的思考已落定");

  // pi 每条 assistant 消息只有一个 thinking 块，交错 provider 会在正文/工具之后继续
  // 往同一个 key 上发 delta。它属于**同一段**思考，所以要并回原块——“末尾另开一块”
  // 会把一段思考劈成两个面板，并把夹在中间的正文劈成两句（真机上就是
  // 「改动 / 面板 / 齐了…」，而重载后渲染权威 transcript 又是整句）。
  feed({ type: "thinking_delta", thinkingStreamKey: key, delta: "的后半句" });
  assert.equal(liveShape(message()), "RT", "并回原块：不新增面板，也不重新点亮工具卡上面那块");
  assert.deepEqual(
    (message().liveBlocks ?? []).map((block) => (block.kind === "thinking" ? block.text : null)),
    ["第一轮思考的后半句", null],
    "迟到 delta 落在原块正文末尾，且不把 open 打开回 true",
  );

  // 收尾快照按 key 合并：同一块只留一份正文，既不重复也不丢
  feed({ type: "assistant_partial", closeThinking: true, blocks: [{ type: "thinking", thinking: "第一轮思考的后半句", streamKey: key }] });
  assert.equal(liveShape(message()), "RT");
  assert.deepEqual(
    (message().liveBlocks ?? []).filter((block) => block.kind === "thinking").map((block) => block.text),
    ["第一轮思考的后半句"],
    "同一块只有一份正文",
  );
});

/**
 * 真机症状（2026-09-17 晚，deepseek-v4.1-flash 实测）：一句话被拆成两半，中间夹着
 * 回流的思考面板 —— “改动” / 面板“3 attempts).” / “齐了，重跑…”。而权威 transcript
 * 里那条消息只有一块 thinking + 一块 text，所以这个形状完全是投影造出来的。
 */
test("交错思考不得把正文劈成两句：thinking → text → 迟到 thinking → text", () => {
  const { feed, message } = streamFixture(1);
  const key = "assistant-0-thinking-0";
  const thinkingTexts = () =>
    (message().liveBlocks ?? []).filter((block) => block.kind === "thinking").map((block) => block.text);
  const textTexts = () =>
    (message().liveBlocks ?? []).filter((block) => block.kind === "text").map((block) => block.text);

  feed({ type: "thinking_delta", thinkingStreamKey: key, delta: "All 9 pass. Let me run dom9.py again (3 " });
  feed({ type: "delta", delta: "改动" });
  // provider 交错：正文开始之后 reasoning 又回来了（同一块、同一 key）
  feed({ type: "thinking_delta", thinkingStreamKey: key, delta: "attempts)." });
  feed({ type: "delta", delta: "齐了，重跑 DOM 探针（3 轮真实工具调用）。" });
  feed({ type: "tool_call_stream_start", toolStreamId: "s1", toolCallId: "call1", toolName: "bash", args: {} });

  assert.equal(liveShape(message()), "RXT", "一块思考 + 一句正文 + 一张工具卡，中间不得再插一块思考");
  assert.deepEqual(thinkingTexts(), ["All 9 pass. Let me run dom9.py again (3 attempts)."], "回流思考合回原块");
  assert.deepEqual(
    textTexts(),
    ["改动齐了，重跑 DOM 探针（3 轮真实工具调用）。"],
    "正文必须是一整句（中间插进一块思考就会把它劈成两句）",
  );

  // 收尾：pi 的权威形状就是一块 thinking + 一句 text
  feed({ type: "assistant_partial", closeThinking: true, blocks: [{ type: "thinking", thinking: "All 9 pass. Let me run dom9.py again (3 attempts).", streamKey: key }] });
  assert.equal(liveShape(message()), "RXT");
  assert.deepEqual(thinkingTexts(), ["All 9 pass. Let me run dom9.py again (3 attempts)."]);
  assert.deepEqual(textTexts(), ["改动齐了，重跑 DOM 探针（3 轮真实工具调用）。"]);
});

test("丢掉一个 thinking delta 时，收尾快照把原块补齐（不新增面板）", () => {
  const { feed, message } = streamFixture(1);
  const key = "assistant-0-thinking-0";

  feed({ type: "thinking_delta", thinkingStreamKey: key, delta: "我先想" });
  feed({ type: "delta", delta: "正文" });
  feed({ type: "thinking_delta", thinkingStreamKey: key, delta: "再" });
  feed({ type: "assistant_partial", closeThinking: true, blocks: [{ type: "thinking", thinking: "我先想再想想", streamKey: key }] });

  assert.equal(liveShape(message()), "RX");
  assert.deepEqual(
    (message().liveBlocks ?? []).filter((block) => block.kind === "thinking").map((block) => block.text),
    ["我先想再想想"],
    "收尾正文是权威全量，直接补齐同一块",
  );
});

test("旧服务端按段发的 `#n` key 也并回同一块（升级窗口内的兼容）", () => {
  const { feed, message } = streamFixture(1);
  const key = "assistant-0-thinking-0";
  const thinkingTexts = () =>
    (message().liveBlocks ?? []).filter((block) => block.kind === "thinking").map((block) => block.text);

  feed({ type: "thinking_delta", thinkingStreamKey: key, delta: "我先想" });
  feed({ type: "tool_call_stream_start", toolStreamId: "s1", toolCallId: "call1", toolName: "read", args: {} });
  feed({ type: "thinking_delta", thinkingStreamKey: `${key}#2`, delta: "再想想" });

  assert.equal(liveShape(message()), "RT", "`#2` 属于同一块：不得在工具卡下面另开面板");
  assert.deepEqual(thinkingTexts(), ["我先想再想想"]);

  // 按段发的收尾快照把尾段单独发过来：不能把已经完整的块缩成尾段
  feed({
    type: "assistant_partial",
    closeThinking: true,
    blocks: [
      { type: "thinking", thinking: "我先想", streamKey: key },
      { type: "thinking", thinking: "再想想", streamKey: `${key}#2` },
    ],
  });
  assert.equal(liveShape(message()), "RT");
  assert.deepEqual(thinkingTexts(), ["我先想再想想"], "尾段快照不得把块缩水");
});

test("已存在工具块的活动也关闭它上面的思考面板（settle 丢失时的客户端自愈）", () => {
  // 健康流式里 append 分支已经关圈，这个形状只能由“合成 settle 丢失 + key 碰撞”
  // 之类的事件缺口造成；直接按块代数构造，锁住 matched 分支的关闭行为。
  const openAbove: MessageProcessBlock = { kind: "thinking", text: "想想", open: true };
  const tool: MessageProcessBlock = {
    kind: "tool", toolCallId: "call1", toolName: "bash", callText: "", status: "streaming",
  };
  const probe: MessageProcessBlock = { kind: "tool", toolCallId: "call1", toolName: "bash", callText: "", status: "streaming" };

  // 参数 typewriter 命中已有块（appendToolCallArgsText 的 matched 分支）
  const afterArgs = appendToolCallArgsText([openAbove, tool], probe, "ls -l");
  assert.equal(shapeOf(afterArgs), "RT", "参数流必须关掉工具卡上面的 open 面板");

  // 执行事件命中已有块（upsertToolProcessBlock 的 matched 分支）——
  // 用全新的 open 列表，不依赖 args 路径先关过圈
  const afterExec = upsertToolProcessBlock([{ kind: "thinking", text: "想想", open: true }, tool], {
    kind: "tool", toolCallId: "call1", toolName: "bash", callText: "ls -l", resultText: "out", status: "done",
  });
  assert.equal(shapeOf(afterExec), "RT", "执行事件同样要关掉上面的 open 面板");

  // 反向保证：matched 分支只关上面的，不碰下面的并发思考（S4）
  const concurrent: MessageProcessBlock = { kind: "thinking", text: "第二轮还在想", open: true };
  const afterLate = upsertToolProcessBlock([tool, concurrent], {
    kind: "tool", toolCallId: "call1", toolName: "bash", callText: "ls -l", resultText: "out", status: "done",
  });
  assert.equal(shapeOf(afterLate), "TR*", "迟到的工具事件不得误伤下方仍在输出的思考");
});

test("工具块活动只关它上面的思考：下方并发思考的流式面板不受影响", () => {
  const { feed, message } = streamFixture(1);

  // 第一轮：思考 → 工具1 开始执行
  feed({ type: "thinking_delta", thinkingStreamKey: "assistant-0-thinking-0", delta: "第一轮" });
  feed({ type: "tool_call_stream_start", toolStreamId: "s1", toolCallId: "call1", toolName: "bash", args: {} });
  feed({ type: "tool_execution_start", toolCallId: "call1", toolStreamId: "s1", toolName: "bash" });

  // 第二轮思考在工具1仍在执行时开始（交错思考）：面板在工具卡下面，还在输出
  feed({ type: "assistant_message_start", turn: 1 });
  feed({ type: "thinking_delta", thinkingStreamKey: "assistant-1-thinking-0", delta: "第二轮还在想" });
  assert.equal(liveShape(message()), "RTR*", "下方并发思考的流式面板必须保持 running");

  // 工具1 的迟到执行事件命中已有块：只允许关它上面的（没有），不得碰下方那块
  feed({ type: "tool_execution_update", toolCallId: "call1", toolStreamId: "s1", toolName: "bash", partialResult: "chunk" });
  assert.equal(liveShape(message()), "RTR*", "迟到的工具事件不得误伤下方仍在输出的思考");
});
