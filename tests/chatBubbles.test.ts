import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChatBubbles,
  chatBubbleId,
  claimProvisionalBubble,
  compareBubbleIds,
  countTranscriptTurns,
  createBubbleTracker,
  createProvisionalTurn,
  discardProvisionalTurn,
  bubbleInsertIndex,
  keepAheadOfSnapshot,
  lastConfirmedTurn,
  mergeChatBubbles,
  parseAttachmentContext,
  parseChatBubbleId,
  parseProvisionalBubbleId,
  provisionalBubbleId,
  replaceTurnWithProvisional,
  upsertBubble,
  type TranscriptMessage,
} from "../src/shared/chatBubbles.ts";
import { ATTACHMENT_CONTEXT_START, ATTACHMENT_CONTEXT_END } from "../src/shared/chatBubbles.ts";

import { syncProvisionalQueue } from "../src/shared/chatBubbles.ts";
import type { ChatMessage } from "../src/types";

/**
 * Bubble identity + placement.
 *
 * These are the primitives the client and the server now share. The invariant
 * that matters is a one-liner: *the id the server puts on a stream event is the
 * id the snapshot builder gives the same transcript message.* Everything else
 * in this file is there to keep that statement true.
 */

const text = (value: string) => [{ type: "text", text: value }];

function transcript(): TranscriptMessage[] {
  return [
    { role: "user", content: "第一条", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "想一下" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
      ],
      timestamp: 2,
    },
    { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: text("a.txt"), timestamp: 3 },
    { role: "assistant", content: text("回答一"), timestamp: 4 },
    // 插话：pi 在回合边界把它注入成一条普通 user 消息
    { role: "user", content: "插一句", timestamp: 5 },
    { role: "assistant", content: text("回答二"), timestamp: 6 },
  ];
}

test("一条 user 消息开一个气泡组，其后的 assistant/toolResult 合成一个回答气泡", () => {
  const bubbles = buildChatBubbles(transcript(), { isStreaming: false });

  assert.deepEqual(
    bubbles.map((bubble) => [bubble.id, bubble.role]),
    [
      [chatBubbleId(1, "user"), "user"],
      [chatBubbleId(1, "assistant"), "assistant"],
      [chatBubbleId(2, "user"), "user"],
      [chatBubbleId(2, "assistant"), "assistant"],
    ],
  );

  const first = bubbles[1];
  assert.equal(first.content, "回答一");
  assert.deepEqual(
    first.processBlocks?.map((block) => block.kind),
    ["thinking", "tool"],
  );
  const tool = first.processBlocks?.[1];
  assert.equal(tool?.kind === "tool" && tool.resultText, "a.txt", "toolResult 要回填到发起它的那条工具块");
});

test("bubbleId 只由 transcript 决定，重放快照得到同一批 id", () => {
  const once = buildChatBubbles(transcript(), { isStreaming: false });
  const twice = buildChatBubbles(transcript(), { isStreaming: false });
  assert.deepEqual(once.map((bubble) => bubble.id), twice.map((bubble) => bubble.id));
});

test("流式中用同一套 id 给未完成的回答打标记，而不是造一个额外占位气泡", () => {
  const streaming = buildChatBubbles(transcript().slice(0, 5), { isStreaming: true, now: 99 });
  assert.deepEqual(
    streaming.map((bubble) => [bubble.id, bubble.status]),
    [
      [chatBubbleId(1, "user"), "done"],
      [chatBubbleId(1, "assistant"), "done"],
      [chatBubbleId(2, "user"), "done"],
      [chatBubbleId(2, "assistant"), "streaming"],
    ],
  );
});

test("回合刚开始（还没有回答）时补一个该回合的 streaming 气泡", () => {
  const bubbles = buildChatBubbles(transcript().slice(0, 1), { isStreaming: true, now: 7 });

  assert.deepEqual(
    bubbles.map((bubble) => [bubble.id, bubble.status]),
    [
      [chatBubbleId(1, "user"), "done"],
      [chatBubbleId(1, "assistant"), "streaming"],
    ],
  );
});

test("服务端事件打上的 id 与快照生成的 id 完全一致（前后端位置一致的前提）", () => {
  const messages = transcript();
  const tracker = createBubbleTracker(0);
  const started: string[] = [];
  for (const message of messages) {
    const ref = tracker.messageStarted(message.role);
    if (ref && message.role !== "toolResult") {
      started.push(ref.bubbleId);
    }
    if (message.role === "assistant") {
      assert.equal(tracker.currentAssistant()?.bubbleId, ref?.bubbleId, "工具事件必须落在当回合正在写的气泡");
    }
  }

  // 一个回合里可以有多条 assistant 消息，快照只给一个气泡 -> 去重后必须完全一致
  const deduped = started.filter((id, index) => index === 0 || started[index - 1] !== id);
  const snapshotIds = buildChatBubbles(messages, { isStreaming: false }).map((bubble) => bubble.id);
  assert.deepEqual(deduped, snapshotIds);
});

test("countTranscriptTurns 与 stats.turnCount / tracker 起点一致", () => {
  assert.equal(countTranscriptTurns(transcript()), 2);
  const resumed = createBubbleTracker(countTranscriptTurns(transcript().slice(0, 4)));
  assert.equal(resumed.messageStarted("user")?.bubbleId, chatBubbleId(2, "user"));
});

test("compareBubbleIds：同回合内 user 在 assistant 之前，跨回合按 turn", () => {
  assert.ok(compareBubbleIds(chatBubbleId(1, "assistant"), chatBubbleId(2, "user")) < 0);
  assert.ok(compareBubbleIds(chatBubbleId(2, "user"), chatBubbleId(2, "assistant")) < 0);
  assert.equal(compareBubbleIds(chatBubbleId(3, "user"), chatBubbleId(3, "user")), 0);
  // 认不出回合的旧格式 id 一律排到最后，绝不挡住有身份的 bubble
  assert.ok(compareBubbleIds("1725-3", chatBubbleId(2, "user")) > 0);
  assert.ok(compareBubbleIds(chatBubbleId(2, "user"), "1725-3") < 0);
  assert.equal(parseChatBubbleId("msg_deadbeef"), null);

  // provisional 带预测回合时参与排序：确认问题不能落到占位回答上面
  assert.ok(compareBubbleIds(chatBubbleId(1, "user"), provisionalBubbleId("cm", "assistant", 1)) < 0);
  assert.ok(compareBubbleIds(chatBubbleId(2, "user"), provisionalBubbleId("cm", "assistant", 1)) > 0);
  assert.equal(
    compareBubbleIds(provisionalBubbleId("cm", "user", 1), chatBubbleId(1, "user")),
    1,
    "同一槽位：已确认的排在占位之前",
  );
  // 没有预测回合的占位（旧数据）与旧格式一样排在最后，彼此不区分
  assert.equal(compareBubbleIds(provisionalBubbleId("cm", "user"), "1725-3"), 0);
});

test("upsertBubble 按 turn 落位，不追加到末尾", () => {
  const bubbles = buildChatBubbles(transcript(), { isStreaming: false });
  const late = upsertBubble(bubbles, {
    id: chatBubbleId(2, "user"),
    role: "user",
    kind: "text",
    content: "重复的插话事件",
    createdAt: 5,
    status: "done",
  });
  assert.equal(late.length, bubbles.length, "同 id 覆盖而不是新增");
  assert.equal(late.findIndex((bubble) => bubble.id === chatBubbleId(2, "user")), 2);

  const third = upsertBubble(bubbles, {
    id: chatBubbleId(3, "user"),
    role: "user",
    kind: "text",
    content: "第三条",
    createdAt: 8,
    status: "done",
  });
  assert.equal(third[third.length - 1].id, chatBubbleId(3, "user"));
  // 落在「不比它靠后的气泡」之后：t1#assistant 必须在 t1#user 与 t2#user 之间
  const onlyQuestions = bubbles.filter((bubble) => bubble.role === "user");
  assert.equal(onlyQuestions.length, 2);
  assert.equal(bubbleInsertIndex(onlyQuestions, chatBubbleId(1, "assistant")), 1);
  assert.equal(bubbleInsertIndex(onlyQuestions, chatBubbleId(2, "assistant")), 2);
});

test("claimProvisionalBubble：先精确命中 id，否则按队列顺序认领最早的 provisional", () => {
  const placed = buildChatBubbles(transcript().slice(0, 4), { isStreaming: true });
  const { bubbles, turn } = createProvisionalTurn(placed, {
    clientMessageId: "cm-1",
    content: "插一句",
    withAssistant: false,
  });
  // 预测回合写进 id，两个提交同时在途时认领才不会互相错位
  assert.equal(parseProvisionalBubbleId(turn.userMessage.id)?.clientMessageId, "cm-1");
  assert.equal(parseProvisionalBubbleId(turn.userMessage.id)?.predictedTurn, lastConfirmedTurn(placed) + 1);
  assert.equal(turn.userMessage.id, provisionalBubbleId("cm-1", "user", lastConfirmedTurn(placed) + 1));
  const again = createProvisionalTurn(bubbles, { clientMessageId: "cm-2", content: "再插一句" });
  assert.equal(
    parseProvisionalBubbleId(again.turn.userMessage.id)?.predictedTurn,
    (parseProvisionalBubbleId(turn.userMessage.id)?.predictedTurn ?? 0) + 1,
    "第二个提交预测下一回合，不能和第一个抢同一个槽位",
  );
  assert.equal(turn.assistantMessage, null);
  assert.equal(lastConfirmedTurn(bubbles), 1, "provisional 不计入已确认回合");

  // 文本被 pi 展开过也没关系：认领只看 id 与顺序。
  const claimed = claimProvisionalBubble(bubbles, {
    bubbleId: chatBubbleId(2, "user"),
    turn: 2,
    role: "user",
  });
  assert.ok(claimed?.claimed);
  assert.equal(claimed?.claimed.id, chatBubbleId(2, "user"));
  assert.equal(claimed?.claimed.provisional, false);
  assert.equal(claimed?.bubbles.length, bubbles.length, "换 id 不是新增气泡");
  assert.equal(
    claimed?.bubbles.findIndex((bubble) => bubble.id === chatBubbleId(2, "user")),
    claimed!.bubbles.length - 1,
    "插话排在正在写的回答之后",
  );

  const unclaimed = claimProvisionalBubble(claimed!.bubbles, {
    bubbleId: chatBubbleId(3, "user"),
    turn: 3,
    role: "user",
  });
  assert.equal(unclaimed, null, "没有可认领的 provisional 时交给调用方按 id 新建");
});

test("discardProvisionalTurn 只回滚本次提交的气泡", () => {
  const base = buildChatBubbles(transcript(), { isStreaming: false });
  const { bubbles } = createProvisionalTurn(base, { clientMessageId: "cm-9", content: "会被丢弃" });
  assert.equal(bubbles.length, base.length + 1);
  assert.equal(discardProvisionalTurn(bubbles, "cm-9").length, base.length);
  assert.equal(discardProvisionalTurn(bubbles, "nope"), bubbles);
});

test("mergeChatBubbles：快照为准，但保留未确认的 provisional 与已跑在前面的流", () => {
  const local = buildChatBubbles(transcript(), { isStreaming: true });
  const ahead = local.map((bubble) =>
    bubble.id === chatBubbleId(2, "assistant") ? { ...bubble, content: "回答二（本地已流完一截）" } : bubble,
  );
  // 快照落后一截：还没有把插话的回答持久化
  const snapshot = buildChatBubbles(transcript().slice(0, 5), { isStreaming: true });

  const merged = mergeChatBubbles(ahead, snapshot);
  assert.equal(
    merged.find((bubble) => bubble.id === chatBubbleId(2, "assistant"))?.content,
    "回答二（本地已流完一截）",
    "本地已经流出来的一截不能被落后的快照覆盖掉",
  );

  const settled = mergeChatBubbles(ahead, buildChatBubbles(transcript(), { isStreaming: false }));
  assert.equal(
    settled.find((bubble) => bubble.id === chatBubbleId(2, "assistant"))?.content,
    "回答二",
    "快照已持久化时以快照为准",
  );

  const { bubbles: withProvisional } = createProvisionalTurn(local, {
    clientMessageId: "cm-3",
    content: "排队中的插话",
  });
  const reconciled = mergeChatBubbles(withProvisional, snapshot);
  assert.ok(
    reconciled.some((bubble) => bubble.provisional && bubble.clientMessageId === "cm-3"),
    "对账不能把排队中的插话抹掉（旧实现正是这里要加 hasPendingSteering 封锁）",
  );
});

test("mergeChatBubbles 无变化时保持引用不变（React 结构共享）", () => {
  const snapshot = buildChatBubbles(transcript(), { isStreaming: false });
  const merged = mergeChatBubbles(snapshot, snapshot);
  assert.equal(merged, snapshot);
  assert.equal(merged.every((bubble, i) => bubble === snapshot[i]), true);
});

test("keepAheadOfSnapshot 只对未完成的 assistant 生效，done 一律以快照为准", () => {
  const local: ChatMessage = {
    id: chatBubbleId(1, "assistant"),
    role: "assistant",
    kind: "text",
    content: "本地更长的一截",
    processBlocks: [],
    createdAt: 2,
    status: "streaming",
  };
  const incoming: ChatMessage = { ...local, content: "快照", status: "streaming" };
  assert.equal(keepAheadOfSnapshot(incoming, local).content, "本地更长的一截");
  assert.equal(keepAheadOfSnapshot({ ...incoming, status: "done" }, local).content, "快照");
  assert.equal(keepAheadOfSnapshot({ ...incoming, role: "user" }, { ...local, role: "user" }).content, "快照");
});

test("附件上下文仍然能还原成用户看到的原文（steer 认领不依赖它，但展示依赖）", () => {
  const payload = {
    displayInput: "看下这个文件",
    attachments: [{ id: "a1", name: "a.txt", mimeType: "text/plain", size: 3, kind: "file" }],
    messageParts: [{ kind: "text", text: "看下这个文件" }],
  };
  const wrapped = [
    "看下这个文件",
    "",
    "Attached files are available at these local paths. Inspect them with the appropriate tools when needed:",
    "- a.txt: /tmp/a.txt",
    "",
    ATTACHMENT_CONTEXT_START,
    JSON.stringify(payload),
    ATTACHMENT_CONTEXT_END,
  ].join("\n");

  const parsed = parseAttachmentContext(wrapped);
  assert.equal(parsed.text, "看下这个文件");
  assert.equal(parsed.attachments.length, 1);

  const bubbles = buildChatBubbles([{ role: "user", content: wrapped, timestamp: 1 }], {
    isStreaming: false,
  });
  assert.equal(bubbles[0].content, "看下这个文件");
  assert.equal(bubbles[0].attachments?.[0]?.name, "a.txt");
});

test("快照对账是完整同步：停止清空队列后不留幽灵气泡", () => {
  const base = buildChatBubbles(transcript().slice(0, 4), { isStreaming: true });
  // 只有「插话」类占位是把 pi 队列当权威的（`queued`）；直提交/编辑占位不是队列条目。
  const queued = createProvisionalTurn(base, {
    clientMessageId: "cm-q",
    content: "排队中的插话",
    queued: true,
  }).bubbles;
  assert.equal(queued.filter((bubble) => bubble.provisional).length, 1);

  // 快照 + 空队列（/api/stop 的返回就是这个形状）
  const synced = syncProvisionalQueue(queued, { steering: [], followUp: [] }, { allowDrop: true });
  assert.equal(synced.filter((bubble) => bubble.provisional).length, 0);
  assert.equal(synced.length, base.length, "幽灵被清掉，正式气泡一个不动");

  const merged = mergeChatBubbles(queued, base, { pendingQueues: { steering: [], followUp: [] } });
  assert.equal(merged.filter((bubble) => bubble.provisional).length, 0);
});

test("编辑重发的回退快照不能把乐观气泡当插话清掉（inline badge 会消失）", () => {
  // 第 1 轮带一个附件徽标；编辑它 → 乐观替换该轮 → 服务端回退快照（该轮已消失、队列为空）。
  const attachment = { id: "att1", name: "a.png", mimeType: "image/png", size: 10, kind: "image" as const };
  const parts = [{ kind: "text" as const, text: "hello" }, { kind: "attachment" as const, attachmentId: "att1" }];
  const base = buildChatBubbles(
    [
      {
        role: "user",
        timestamp: 1,
        content:
          `hello\n\n${ATTACHMENT_CONTEXT_START}\n` +
          JSON.stringify({ displayInput: "hello", attachments: [attachment], messageParts: parts }) +
          `\n${ATTACHMENT_CONTEXT_END}`,
      },
      { role: "assistant", content: text("hi"), timestamp: 2 },
    ],
    { isStreaming: false },
  );

  const optimistic = replaceTurnWithProvisional(base, {
    turn: 1,
    clientMessageId: "cm-edit",
    content: "edited",
    attachments: [attachment],
    contentParts: [{ kind: "text", text: "edited" }, { kind: "attachment", attachmentId: "att1" }],
  });

  // 回退快照：第 1 轮被 navigatTree 移出分支，队列为空。
  const merged = mergeChatBubbles(optimistic, buildChatBubbles([], { isStreaming: false }), {
    pendingQueues: { steering: [], followUp: [] },
  });
  const edited = merged.find((bubble) => bubble.provisional && bubble.role === "user");
  assert.ok(edited, "乐观编辑气泡必须活过回退快照（旧实现被当插话删掉）");
  assert.equal(edited.content, "edited");
  assert.deepEqual(edited.contentParts, [{ kind: "text", text: "edited" }, { kind: "attachment", attachmentId: "att1" }]);

  // 随后的 user_message_start 原地认领它，附件徽标与文本都必须还在。
  const claimed = claimProvisionalBubble(merged, { bubbleId: chatBubbleId(1, "user"), turn: 1, role: "user" }, {
    content: "edited",
  });
  assert.ok(claimed);
  const bubble = claimed.bubbles.find((candidate) => candidate.id === chatBubbleId(1, "user"))!;
  assert.deepEqual(bubble.contentParts, [{ kind: "text", text: "edited" }, { kind: "attachment", attachmentId: "att1" }]);
  assert.equal(bubble.queued, undefined, "编辑气泡不是插话");
});

test("两次提交同时在途时，确认事件按预测回合认领，不留下孤立占位", () => {
  const placed = buildChatBubbles(transcript().slice(0, 2), { isStreaming: true });
  const first = createProvisionalTurn(placed, {
    clientMessageId: "cm-a",
    content: "再来一题",
    withAssistant: true,
  });
  const second = createProvisionalTurn(first.bubbles, {
    clientMessageId: "cm-b",
    content: "插一句",
    withAssistant: false,
  });

  let bubbles = claimProvisionalBubble(
    second.bubbles,
    { bubbleId: chatBubbleId(2, "user"), turn: 2, role: "user" },
    { content: "再来一题" },
  )!.bubbles;
  bubbles = claimProvisionalBubble(
    bubbles,
    { bubbleId: chatBubbleId(2, "assistant"), turn: 2, role: "assistant" },
    { status: "streaming" },
  )!.bubbles;

  // 只剩 B 那条排队中的插话：A 的占位已经被 t2 确认事件吸收
  assert.equal(bubbles.filter((bubble) => bubble.provisional).length, 1);
  assert.equal(bubbles.find((bubble) => bubble.provisional)?.content, "插一句");

  const steer = claimProvisionalBubble(
    bubbles,
    { bubbleId: chatBubbleId(3, "user"), turn: 3, role: "user" },
    { content: "插一句" },
  )!.bubbles;
  assert.equal(steer.filter((bubble) => bubble.provisional).length, 0);
  assert.deepEqual(
    steer.map((bubble) => bubble.id),
    [
      chatBubbleId(1, "user"),
      chatBubbleId(1, "assistant"),
      chatBubbleId(2, "user"),
      chatBubbleId(2, "assistant"),
      chatBubbleId(3, "user"),
    ],
  );
});

test("upsertBubble 写入已确认回合时，同回合的过期占位一并清掉", () => {
  const placed = buildChatBubbles(transcript().slice(0, 2), { isStreaming: true });
  const optimistic = createProvisionalTurn(placed, {
    clientMessageId: "cm-x",
    content: "下一题",
    withAssistant: true,
  });
  // 服务端直接给出确认气泡（没有走认领：例如从另一个窗口发起的运行）
  const settled = upsertBubble(optimistic.bubbles, {
    id: chatBubbleId(2, "assistant"),
    role: "assistant",
    kind: "text",
    content: "答案",
    processBlocks: [],
    createdAt: 20,
    status: "streaming",
  } as ChatMessage);

  assert.equal(settled.filter((bubble) => bubble.provisional).length, 1, "只保留尚未确认的用户气泡");
  assert.equal(settled.filter((bubble) => bubble.role === "assistant" && bubble.provisional).length, 0);
  assert.deepEqual(
    settled.map((bubble) => bubble.id),
    [
      chatBubbleId(1, "user"),
      chatBubbleId(1, "assistant"),
      optimistic.turn.userMessage.id,
      chatBubbleId(2, "assistant"),
    ],
  );
});

test("mergeChatBubbles 不会让已确认回合的占位气泡变成重复回答", () => {
  const placed = buildChatBubbles(transcript().slice(0, 2), { isStreaming: true });
  const optimistic = createProvisionalTurn(placed, {
    clientMessageId: "cm-a",
    content: "下一题",
    withAssistant: true,
  });
  // 快照里 t2 已经写好，本地还留着 t2 的占位
  const incoming = buildChatBubbles(transcript().slice(0, 6), { isStreaming: false });
  const merged = mergeChatBubbles(optimistic.bubbles, incoming);

  assert.equal(merged.filter((bubble) => bubble.provisional).length, 0);
  assert.deepEqual(
    merged.map((bubble) => bubble.id),
    incoming.map((bubble) => bubble.id),
  );
});

test("replaceTurnWithProvisional 原地重发该回合：保留之前的、丢掉它和它之后的，并放上新内容", () => {
  const bubbles: ChatMessage[] = [
    { id: chatBubbleId(1, "user"), role: "user", kind: "text", content: "one", createdAt: 1, status: "done" },
    { id: chatBubbleId(1, "assistant"), role: "assistant", kind: "text", content: "a1", createdAt: 2, status: "done" },
    { id: chatBubbleId(2, "user"), role: "user", kind: "text", content: "two", createdAt: 3, status: "done" },
    { id: chatBubbleId(2, "assistant"), role: "assistant", kind: "text", content: "a2", createdAt: 4, status: "done" },
    { id: chatBubbleId(3, "user"), role: "user", kind: "text", content: "three", createdAt: 5, status: "done" },
    { id: chatBubbleId(3, "assistant"), role: "assistant", kind: "text", content: "a3", createdAt: 6, status: "done" },
  ];

  const next = replaceTurnWithProvisional(bubbles, {
    turn: 2,
    clientMessageId: "c1",
    content: "two edited",
  });

  assert.deepEqual(next.map((bubble) => bubble.id), [
    chatBubbleId(1, "user"),
    chatBubbleId(1, "assistant"),
    provisionalBubbleId("c1", "user", 2),
    provisionalBubbleId("c1", "assistant", 2),
  ]);
  const user = next[2];
  assert.equal(user.content, "two edited");
  assert.equal(user.provisional, true);
  assert.equal(user.clientMessageId, "c1");
  assert.equal(next[3].status, "streaming", "需要占位回答，否则没有生成中的圆点");
});

test("重发的占位回合会被服务端的 tN#... 事件原地认领（不会变成追加的一轮）", () => {
  const bubbles: ChatMessage[] = [
    { id: chatBubbleId(1, "user"), role: "user", kind: "text", content: "one", createdAt: 1, status: "done" },
    { id: chatBubbleId(1, "assistant"), role: "assistant", kind: "text", content: "a1", createdAt: 2, status: "done" },
    { id: chatBubbleId(2, "user"), role: "user", kind: "text", content: "two", createdAt: 3, status: "done" },
    { id: chatBubbleId(2, "assistant"), role: "assistant", kind: "text", content: "a2", createdAt: 4, status: "done" },
  ];
  const optimistic = replaceTurnWithProvisional(bubbles, {
    turn: 2,
    clientMessageId: "c1",
    content: "two edited",
  });

  // 服务端回退后先推快照（该回合不在里面），占位必须活下来。
  const afterSnapshot = mergeChatBubbles(optimistic, bubbles.slice(0, 2));
  assert.equal(afterSnapshot.length, 4, "占位回合在快照对账后仍在");

  const claimed = claimProvisionalBubble(
    afterSnapshot,
    { bubbleId: chatBubbleId(2, "user"), role: "user", turn: 2 },
    {},
  );
  assert.ok(claimed);
  assert.deepEqual(claimed.bubbles.map((bubble) => bubble.id), [
    chatBubbleId(1, "user"),
    chatBubbleId(1, "assistant"),
    chatBubbleId(2, "user"),
    provisionalBubbleId("c1", "assistant", 2),
  ]);
  assert.equal(claimed.bubbles[2].content, "two edited");
  assert.equal(claimed.bubbles[2].provisional, false);
});

test("replaceTurnWithProvisional 顺手丢掉别的提交留下的、更靠后的占位", () => {
  const bubbles: ChatMessage[] = [
    { id: chatBubbleId(1, "user"), role: "user", kind: "text", content: "one", createdAt: 1, status: "done" },
    { id: chatBubbleId(1, "assistant"), role: "assistant", kind: "text", content: "a1", createdAt: 2, status: "done" },
    { id: provisionalBubbleId("stale", "user", 2), role: "user", kind: "text", content: "queued", createdAt: 3, status: "done", provisional: true, clientMessageId: "stale" },
  ];
  const next = replaceTurnWithProvisional(bubbles, { turn: 2, clientMessageId: "c1", content: "edited" });
  assert.equal(next.some((bubble) => bubble.clientMessageId === "stale"), false, "过期占位必须被丢掉");
  assert.deepEqual(next.map((bubble) => bubble.id), [
    chatBubbleId(1, "user"),
    chatBubbleId(1, "assistant"),
    provisionalBubbleId("c1", "user", 2),
    provisionalBubbleId("c1", "assistant", 2),
  ]);
});
