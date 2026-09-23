import test from "node:test";
import assert from "node:assert/strict";

import {
  appendLiveTextBlock,
  appendMessages,
  insertMessageAt,
  mergeAssistantProcessBlocks,
  mergeLiveProcessBlocks,
  normalizeMessageProcessBlocks,
  patchMessage,
  patchMessages,
  removeMessageById,
  touchConversation,
  upsertLiveToolBlock,
  upsertToolProcessBlock,
  useContextUsage,
  promoteSessionRow,
  withStats,
} from "../src/features/chat/bootstrapPatch.ts";

/**
 * Regression net for the streaming hot path.
 *
 * The reducer used to `structuredClone` the entire bootstrap snapshot for every
 * streamed token and then mutate one message. These tests pin the two properties
 * the replacement must keep:
 *   1. observable state is identical to the old clone-and-mutate behaviour;
 *   2. objects that did not change keep their identity (that is the whole point).
 *
 * `reference*` below re-implements the old semantics in the obvious
 * clone-then-mutate style, so the comparison is against the contract rather than
 * against the new implementation.
 */

type Block = {
  kind: "thinking" | "notice" | "text";
  text: string;
};

type ToolBlock = {
  kind: "tool";
  toolCallId: string;
  toolStreamId?: string;
  toolName: string;
  callText: string;
  resultText?: string;
  isError?: boolean;
  status?: "streaming" | "done";
};

type AnyBlock = Block | ToolBlock;

type Message = {
  id: string;
  role: "user" | "assistant";
  kind: "text";
  content: string;
  createdAt: number;
  status?: "streaming" | "done";
  processBlocks?: AnyBlock[];
  liveBlocks?: AnyBlock[];
};

type Bootstrap = {
  activeSessionPath: string;
  snapshot: {
    conversation: { sessionFile: string; updatedAt: number; messages: Message[] };
    stats: { messageCount: number; assistantMessageCount: number; userMessageCount: number; turnCount: number; lastMessageAt?: number };
  };
  projects: { id: string; sessions: { path: string }[] }[];
};

function makeBootstrap(messageCount: number): Bootstrap {
  const messages: Message[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    const message: Message = {
      id: `msg-${index}`,
      role,
      kind: "text",
      content: `body ${index}`,
      createdAt: 1000 + index,
      status: "done",
    };
    if (role === "assistant") {
      message.processBlocks = [
        { kind: "thinking", text: `think ${index}` },
        {
          kind: "tool",
          toolCallId: `call-${index}`,
          toolName: "bash",
          callText: JSON.stringify({ command: `echo ${index}` }),
          resultText: `out ${index}`,
          status: "done",
        },
      ];
    }
    messages.push(message);
  }

  return {
    activeSessionPath: "/tmp/session.jsonl",
    snapshot: {
      conversation: { sessionFile: "/tmp/session.jsonl", updatedAt: 1000, messages },
      stats: { messageCount: messageCount, assistantMessageCount: messageCount / 2, userMessageCount: messageCount / 2, turnCount: messageCount / 2 },
    },
    projects: [{ id: "p1", sessions: [{ path: "/tmp/session.jsonl" }] }],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/* Reference implementation: exactly what the old reducer did, minus the churn. */

function referenceDelta(bootstrap: Bootstrap, messageId: string, delta: string, now: number): Bootstrap {
  const next = clone(bootstrap);
  const target = next.snapshot.conversation.messages.find((message) => message.id === messageId);
  if (!target || target.role !== "assistant") {
    return bootstrap;
  }
  target.content = `${target.content}${delta}`;
  const blocks = (target.liveBlocks ?? []).slice();
  const last = blocks[blocks.length - 1] as { kind: string; text?: string } | undefined;
  if (last?.kind === "text") {
    blocks[blocks.length - 1] = { kind: "text", text: `${last.text}${delta}` };
  } else {
    blocks.push({ kind: "text", text: delta });
  }
  target.liveBlocks = blocks as Message["liveBlocks"];
  target.status = "streaming";
  next.snapshot.conversation.updatedAt = now;
  return next;
}

function referenceThinking(bootstrap: Bootstrap, messageId: string, thinking: string): Bootstrap {
  const next = clone(bootstrap);
  const target = next.snapshot.conversation.messages.find((message) => message.id === messageId);
  if (!target || target.role !== "assistant") {
    return bootstrap;
  }
  const blocks: AnyBlock[] = (target.processBlocks ?? []).slice();
  const text = thinking.trim();
  if (text) {
    let handled = false;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (block.kind !== "thinking") {
        continue;
      }
      if (block.text === text || block.text.startsWith(text)) {
        handled = true;
      } else if (text.startsWith(block.text)) {
        blocks[index] = { kind: "thinking", text };
        handled = true;
      }
      break;
    }
    if (!handled) {
      blocks.push({ kind: "thinking", text });
    }
  }
  target.processBlocks = blocks;
  return next;
}

function referenceToolUpsert(bootstrap: Bootstrap, block: ToolBlock): Bootstrap {
  const next = clone(bootstrap);
  const target = next.snapshot.conversation.messages[next.snapshot.conversation.messages.length - 1];
  if (!target || target.role !== "assistant") {
    return bootstrap;
  }
  const blocks: AnyBlock[] = (target.processBlocks ?? []).slice();
  const index = blocks.findIndex(
    (item) => item.kind === "tool" && (item.toolCallId === block.toolCallId || (item.toolStreamId && item.toolStreamId === block.toolStreamId)),
  );
  if (index < 0) {
    blocks.push(block);
  } else {
    const prior = blocks[index] as ToolBlock;
    blocks[index] = {
      kind: "tool",
      toolCallId: block.toolCallId || prior.toolCallId,
      toolStreamId: block.toolStreamId ?? prior.toolStreamId,
      toolName: block.toolName || prior.toolName,
      callText: block.callText || prior.callText,
      resultText: block.resultText ?? prior.resultText,
      isError: block.isError ?? prior.isError,
      status: block.status ?? prior.status ?? "streaming",
    };
  }
  target.processBlocks = blocks;
  return next;
}

test("append-assistant-delta matches the old clone-and-mutate result", () => {
  const bootstrap = makeBootstrap(20);
  const streaming: Bootstrap = {
    ...bootstrap,
    snapshot: {
      ...bootstrap.snapshot,
      conversation: {
        ...bootstrap.snapshot.conversation,
        messages: [...bootstrap.snapshot.conversation.messages, { id: "live", role: "assistant", kind: "text", content: "", createdAt: 2000, status: "streaming" }],
      },
    },
  };

  let shared: Bootstrap = streaming;
  let legacy: Bootstrap = streaming;
  for (let token = 0; token < 25; token += 1) {
    shared = patchMessage(shared, "live", (message) => ({
      ...message,
      content: `${message.content}x${token}`,
      liveBlocks: appendLiveTextBlock((message.liveBlocks ?? []) as never, `x${token}`) as never,
      status: "streaming",
    })).bootstrap;
    legacy = referenceDelta(legacy, "live", `x${token}`, 5000);
  }

  assert.deepEqual(
    { ...shared, snapshot: { ...shared.snapshot, conversation: { ...shared.snapshot.conversation, updatedAt: 5000 } } },
    legacy,
    "streamed content and live blocks must be identical to the previous behaviour",
  );
});

test("only the touched message changes identity during a streamed turn", () => {
  const bootstrap = makeBootstrap(60);
  const before = bootstrap.snapshot.conversation.messages;
  let next = bootstrap;
  for (let token = 0; token < 50; token += 1) {
    next = patchMessage(next, "msg-59", (message) => ({ ...message, content: `${message.content}.${token}` })).bootstrap;
  }
  const after = next.snapshot.conversation.messages;

  assert.equal(after.length, before.length);
  assert.notEqual(after[59], before[59]);
  for (let index = 0; index < before.length - 1; index += 1) {
    assert.equal(after[index], before[index], `message ${index} must keep its identity`);
  }
  assert.notEqual(next.snapshot.conversation, bootstrap.snapshot.conversation);
});

test("cumulative thinking payloads are a no-op when unchanged", () => {
  const blocks: any[] = [{ kind: "thinking", text: "planning the answer" }];
  const again = mergeAssistantProcessBlocks(blocks, [{ kind: "thinking", text: "planning the answer" }] as any);
  assert.equal(again, blocks, "an identical cumulative payload must not allocate");

  const grown = mergeAssistantProcessBlocks(blocks, [{ kind: "thinking", text: "planning the answer, in more detail" }] as any);
  assert.notEqual(grown, blocks);
  assert.equal(grown.length, 1);
  assert.equal((grown[0] as Block).text, "planning the answer, in more detail");

  const shorter = mergeAssistantProcessBlocks(grown, [{ kind: "thinking", text: "planning" }] as any);
  assert.equal(shorter, grown, "a prefix of what we already have must not rewrite the block");
});

test("merging keeps untouched tool blocks referentially stable", () => {
  const tool: ToolBlock = { kind: "tool", toolCallId: "c1", toolName: "bash", callText: "{\"a\":1}", resultText: "ok", status: "done" };
  const thinking: Block = { kind: "thinking", text: "step one" };
  const blocks = [thinking, tool] as any[];

  const merged = mergeAssistantProcessBlocks(blocks, [{ kind: "thinking", text: "step one and step two" }] as any);
  assert.notEqual(merged[0], thinking, "the changed thinking block gets a new object");
  assert.equal(merged[1], tool, "the untouched tool block keeps its identity");
});

test("upsertToolProcessBlock matches by toolCallId and by toolStreamId", () => {
  const first: ToolBlock = { kind: "tool", toolCallId: "call-1", toolStreamId: "s1", toolName: "bash", callText: "{\"partial\":1}", status: "streaming" };
  let blocks = upsertToolProcessBlock([first] as any, { ...first, callText: "{\"partial\":12}" } as any) as any as ToolBlock[];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].callText, "{\"partial\":12}");

  // Same stream id, freshly resolved call id -> still one block, ids merged.
  blocks = upsertToolProcessBlock(blocks, { kind: "tool", toolCallId: "call-1", toolStreamId: "s1", toolName: "bash", callText: "", resultText: "done", status: "done" } as any) as any as ToolBlock[];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].resultText, "done");
  assert.equal(blocks[0].status, "done");

  const untouched = upsertToolProcessBlock(blocks, blocks[0] as any) as any as ToolBlock[];
  assert.equal(untouched, blocks, "an identical upsert must return the same array");

  const appended = upsertToolProcessBlock(blocks, { kind: "tool", toolCallId: "call-2", toolName: "read", callText: "{}" } as any) as any as ToolBlock[];
  assert.equal(appended.length, 2);
  assert.equal(appended[0], blocks[0]);
});

test("live blocks only replace the tail text block", () => {
  const tool: ToolBlock = { kind: "tool", toolCallId: "c1", toolName: "bash", callText: "{}", status: "streaming" };
  const blocks = [tool, { kind: "text", text: "he" }] as any[];
  const next = appendLiveTextBlock(blocks as never, "llo") as never as AnyBlock[];

  assert.equal(next[0], tool, "leading tool block must keep its identity");
  assert.notEqual(next[1], blocks[1]);
  assert.equal((next[1] as Block).text, "hello");
  const empty = appendLiveTextBlock(blocks as never, "") as never as AnyBlock[];
  assert.equal(empty.length, blocks.length, "an empty delta must not add a block");
  assert.ok(empty.every((block, index) => block === blocks[index]), "an empty delta must not copy blocks");
});

test("mergeLiveProcessBlocks folds thinking without copying tools", () => {
  const tool: ToolBlock = { kind: "tool", toolCallId: "c1", toolName: "bash", callText: "{}", status: "streaming" };
  const blocks = [tool] as any[];
  const merged = mergeLiveProcessBlocks(blocks as never, [{ kind: "thinking", text: "reasoning" }] as any) as never as AnyBlock[];
  assert.equal(merged.length, 2);
  assert.equal(merged[0], tool);

  const toolAgain = upsertLiveToolBlock(merged as never, { ...tool, callText: "{\"x\":1}" } as any) as never as ToolBlock[];
  assert.equal(toolAgain[0].callText, "{\"x\":1}");
  assert.equal(upsertLiveToolBlock(toolAgain as never, toolAgain[0] as any), toolAgain, "unchanged upsert must be identity preserving");
});

test("finish-session-streaming-messages only touches streaming assistants", () => {
  const bootstrap = makeBootstrap(10);
  const withLive: Bootstrap = {
    ...bootstrap,
    snapshot: {
      ...bootstrap.snapshot,
      conversation: {
        ...bootstrap.snapshot.conversation,
        messages: [
          ...bootstrap.snapshot.conversation.messages,
          { id: "live", role: "assistant", kind: "text", content: "", createdAt: 3000, status: "streaming" },
        ],
      },
    },
  };

  const result = patchMessages(withLive, (message) =>
    message.role === "assistant" && message.status === "streaming" ? { ...message, status: "done" } : message,
  );
  assert.equal(result.changed, true);
  const messages = result.bootstrap.snapshot.conversation.messages;
  assert.equal(messages[messages.length - 1].status, "done");
  assert.equal(messages[1], withLive.snapshot.conversation.messages[1]);

  const nothing = patchMessages(result.bootstrap, (message) =>
    message.role === "assistant" && message.status === "streaming" ? { ...message, status: "done" } : message,
  );
  assert.equal(nothing.changed, false, "a second finish pass must not churn the state");
});

test("structural helpers report no change for missing targets", () => {
  const bootstrap = makeBootstrap(4);
  assert.equal(patchMessage(bootstrap, "nope", (message) => ({ ...message, content: "x" })).changed, false);
  assert.equal(removeMessageById(bootstrap, "nope").changed, false);
  assert.equal(touchConversation(bootstrap, bootstrap.snapshot.conversation.updatedAt), bootstrap);
});

test("insert / append / remove keep the untouched prefix stable", () => {
  const bootstrap = makeBootstrap(6);
  const inserted = insertMessageAt(bootstrap, 3, { id: "new", role: "assistant", kind: "text", content: "", createdAt: 4000, status: "streaming" });
  assert.deepEqual(
    inserted.bootstrap.snapshot.conversation.messages.map((message) => message.id),
    ["msg-0", "msg-1", "msg-2", "new", "msg-3", "msg-4", "msg-5"],
  );
  assert.equal(inserted.bootstrap.snapshot.conversation.messages[0], bootstrap.snapshot.conversation.messages[0]);

  const appended = appendMessages(bootstrap, [{ id: "tail", role: "user", kind: "text", content: "hi", createdAt: 5000, status: "done" }]);
  assert.equal(appended.bootstrap.snapshot.conversation.messages.length, 7);
  assert.equal(removed(appended.bootstrap).bootstrap.snapshot.conversation.messages.length, 6);

  const stats = withStats(bootstrap, { ...bootstrap.snapshot.stats, messageCount: 99 });
  assert.equal(stats.snapshot.stats.messageCount, 99);
  assert.equal(stats.snapshot.conversation, bootstrap.snapshot.conversation, "stats-only updates must not rebuild the conversation");
  assert.equal(withStats(bootstrap, bootstrap.snapshot.stats), bootstrap);
});

function removed(bootstrap: Bootstrap) {
  return removeMessageById(bootstrap, "tail");
}

test("normalizeMessageProcessBlocks is a no-op for already normalized messages", () => {
  const bootstrap = makeBootstrap(2);
  const assistant = bootstrap.snapshot.conversation.messages[1];
  assert.equal(normalizeMessageProcessBlocks(assistant as never), assistant, "an unchanged message must keep its identity");

  const dirty = { ...assistant, processBlocks: [{ kind: "thinking", text: "  padded  " }, ...(assistant.processBlocks ?? [])] };
  const normalized = normalizeMessageProcessBlocks(dirty as never) as Message;
  assert.equal((normalized.processBlocks?.[0] as Block).text, "padded");
  assert.equal(normalizeMessageProcessBlocks(normalized as never), normalized, "normalising twice must be stable");
});

test("reference thinking/tool semantics agree across a long random turn", () => {
  let shared = makeBootstrap(4);
  let legacy = makeBootstrap(4);
  shared = insertMessageAt(shared, 4, { id: "live", role: "assistant", kind: "text", content: "", createdAt: 9000, status: "streaming" }).bootstrap;
  legacy = clone(shared);

  let thinking = "";
  for (let step = 0; step < 400; step += 1) {
    const roll = step % 4;
    if (roll === 0) {
      thinking += `s${step} `;
      shared = patchMessage(shared, "live", (message) => {
        const processBlocks = mergeAssistantProcessBlocks(message.processBlocks ?? [], [{ kind: "thinking", text: thinking }] as any) as any;
        return { ...message, processBlocks };
      }).bootstrap;
      legacy = referenceThinking(legacy, "live", thinking);
    } else if (roll === 1) {
      shared = patchMessage(shared, "live", (message) => ({
        ...message,
        content: `${message.content}tok${step}`,
        liveBlocks: appendLiveTextBlock((message.liveBlocks ?? []) as never, `tok${step}`) as never,
      })).bootstrap;
      legacy = referenceDelta(legacy, "live", `tok${step}`, 9001);
    } else if (roll === 2) {
      const block: ToolBlock = { kind: "tool", toolCallId: `c${step % 5}`, toolName: "bash", callText: `{"i":${step}}`, status: "streaming" };
      shared = patchMessage(shared, "live", (message) => ({
        ...message,
        processBlocks: upsertToolProcessBlock(message.processBlocks ?? [], block as any) as any,
      })).bootstrap;
      legacy = referenceToolUpsert(legacy, block);
    } else {
      // A repeated cumulative payload (what the server does until the throttle
      // lets it through) must be observably inert and must not churn identity.
      const before = shared.snapshot.conversation.messages;
      shared = patchMessage(shared, "live", (message) => {
        const processBlocks = mergeAssistantProcessBlocks(message.processBlocks ?? [], [{ kind: "thinking", text: thinking }] as any) as any;
        const liveBlocks = mergeLiveProcessBlocks((message.liveBlocks ?? []) as never, processBlocks as never) as never;
        return { ...message, processBlocks, liveBlocks };
      }).bootstrap;
      const after = shared.snapshot.conversation.messages;
      for (let index = 0; index < before.length - 1; index += 1) {
        assert.equal(after[index], before[index]);
      }
    }
  }

  // `liveBlocks` is the renderer-facing projection; it is covered by its own
  // unit tests above and the reference implementation deliberately does not
  // model it, so compare the authoritative fields only.
  const strip = (bootstrap: Bootstrap) => {
    const copy = clone(bootstrap);
    copy.snapshot.conversation.updatedAt = 0;
    for (const message of copy.snapshot.conversation.messages) {
      delete (message as { liveBlocks?: unknown }).liveBlocks;
    }
    return copy;
  };
  assert.deepEqual(strip(shared), strip(legacy));
  assert.equal(shared.snapshot.conversation.messages.length, legacy.snapshot.conversation.messages.length);
});

/* -------------------------------------------------------------------------- */
/* `context_usage` events: the meter has to follow pi's own granularity        */
/* -------------------------------------------------------------------------- */

const usageStats = (over: Record<string, unknown> = {}) => ({
  contextTokens: 4_000,
  contextWindow: 200_000,
  contextPercent: 2,
  tokenUsage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
  ...over,
});

const withUsage = (over: Record<string, unknown> = {}) => {
  const bootstrap = makeBootstrap(4);
  return {
    ...bootstrap,
    snapshot: { ...bootstrap.snapshot, stats: { ...bootstrap.snapshot.stats, ...usageStats(over) } },
  } as never;
};

test("context_usage moves only the usage fields and keeps the conversation identity", () => {
  const bootstrap = withUsage();
  const before = bootstrap.snapshot.conversation;
  const { bootstrap: next, changed } = useContextUsage(bootstrap, {
    contextTokens: 9_000,
    contextWindow: 200_000,
    contextPercent: 4.5,
    tokenUsage: { input: 8_000, output: 900, cacheRead: 100, cacheWrite: 200, total: 9_200 },
  } as never);

  assert.equal(changed, true);
  assert.deepEqual(next.snapshot.stats.contextTokens, 9_000);
  assert.equal(next.snapshot.stats.contextPercent, 4.5);
  assert.equal(next.snapshot.stats.tokenUsage.input, 8_000);
  // The thread is memoised on message identity - a usage patch must not disturb it.
  assert.equal(next.snapshot.conversation, before);
});

test("a null reading is an answer: pi reports null right after a compaction", () => {
  const bootstrap = withUsage();
  const { bootstrap: next, changed } = useContextUsage(bootstrap, { contextTokens: null, contextPercent: null } as never);

  assert.equal(changed, true);
  assert.equal(next.snapshot.stats.contextPercent, null);
  assert.equal(next.snapshot.stats.contextTokens, null);
  // Fields the server omitted keep their previous value instead of being blanked.
  assert.equal(next.snapshot.stats.contextWindow, 200_000);
  assert.equal(next.snapshot.stats.tokenUsage.total, 150);
});

test("repeating the same reading does not churn the stats object", () => {
  const bootstrap = withUsage();
  const usage = {
    contextTokens: 4_000,
    contextWindow: 200_000,
    contextPercent: 2,
    // A fresh object per event, so equality has to be by value.
    tokenUsage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
  };

  const first = useContextUsage(bootstrap, usage as never);
  assert.equal(first.changed, false);
  assert.equal(first.bootstrap, bootstrap);

  const empty = useContextUsage(bootstrap, {} as never);
  assert.equal(empty.changed, false);
});

/* -------------------------------------------------------------------------- */
/* promoteSessionRow: the sidebar must react to a submit, not to the turn end   */
/* -------------------------------------------------------------------------- */

function sessionRow(path: string, updatedAt: number, pinned = false) {
  return { path, id: path, title: path, cwd: "/tmp", createdAt: updatedAt, updatedAt, messageCount: 2, firstMessage: "", pinned };
}

function makeSidebarBootstrap() {
  const project = {
    id: "p1",
    name: "Project",
    cwd: "/tmp",
    createdAt: 1,
    updatedAt: 1,
    sessions: [sessionRow("/a", 3000), sessionRow("/b", 2000), sessionRow("/c", 1000)],
  };
  return {
    activeSessionPath: "/c",
    streamingSessionPaths: [],
    compactingSessionPaths: [],
    projects: [project],
    snapshot: {
      project: { ...project, sessions: [...project.sessions] },
      conversation: { sessionFile: "/c", updatedAt: 1000, messages: [] },
      stats: {},
    },
  } as never;
}

test("a submit promotes its session row in the sidebar", () => {
  const bootstrap = makeSidebarBootstrap();
  const { bootstrap: next, changed } = promoteSessionRow(bootstrap, "/c", 9999);

  assert.equal(changed, true);
  assert.deepEqual(next.projects[0].sessions.map((session) => session.path), ["/c", "/a", "/b"]);
  assert.equal(next.projects[0].sessions[0].updatedAt, 9999);
  // The snapshot's project copy has to move too: it is the fallback the sidebar reads.
  assert.deepEqual(next.snapshot.project.sessions.map((session) => session.path), ["/c", "/a", "/b"]);
  // Other projects keep their identity, and the transcript is untouched.
  assert.equal(next.snapshot.conversation, bootstrap.snapshot.conversation);
  // The clock is NOT driven from here: the busy watchdog must not start on submit.
  assert.equal(next.streamingSessionPaths, bootstrap.streamingSessionPaths);
});

test("an older timestamp cannot make the row look stale", () => {
  const bootstrap = makeSidebarBootstrap();
  const { bootstrap: next } = promoteSessionRow(bootstrap, "/a", 1);
  assert.equal(next.projects[0].sessions[0].path, "/a");
  assert.equal(next.projects[0].sessions[0].updatedAt, 3000);
});

test("pinned rows keep the sidebar's pinned-first order", () => {
  const bootstrap = makeSidebarBootstrap();
  bootstrap.projects[0].sessions = [sessionRow("/pin", 10, true), sessionRow("/a", 3000), sessionRow("/c", 1000)];
  bootstrap.snapshot.project.sessions = [...bootstrap.projects[0].sessions];

  const { bootstrap: next } = promoteSessionRow(bootstrap, "/c", 4000);
  assert.deepEqual(next.projects[0].sessions.map((session) => session.path), ["/pin", "/c", "/a"]);
  // Pinned rows are filtered out before the list is sliced, so the promoted row is the
  // first thing the user sees among the unpinned ones.
  assert.deepEqual(
    next.projects[0].sessions.filter((session) => !session.pinned).map((session) => session.path),
    ["/c", "/a"],
  );
});

test("repeating the promotion does not churn identities", () => {
  const bootstrap = makeSidebarBootstrap();
  const first = promoteSessionRow(bootstrap, "/c", 4000);
  // The reducer runs twice per dispatch (cache + visible state) with one payload, so the
  // same timestamp must be a no-op the second time.
  const second = promoteSessionRow(first.bootstrap, "/c", 4000);

  assert.equal(second.bootstrap, first.bootstrap);
  assert.equal(second.changed, false);
});

test("a session missing from the project list changes nothing", () => {
  const bootstrap = makeSidebarBootstrap();
  const { bootstrap: next, changed } = promoteSessionRow(bootstrap, "/new", 4000);

  assert.equal(changed, false);
  assert.equal(next, bootstrap);
});
