import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildChatBubbles, countTranscriptTurns, createBubbleTracker } from "../src/shared/chatBubbles.ts";
import {
  COMPACT_LABEL_COMPACTING_KEY,
  COMPACT_LABEL_IDLE_KEY,
  compactActionState,
  COMPACTION_RUNNING_TEXT_KEY,
  compactionFailureReason,
  compactionNotice,
  compactionOutcome,
} from "../src/shared/compactionNotice.ts";
import { t } from "../src/i18n/index.ts";
import { displayTranscript, isDisplayMessage } from "../server/sessionTranscript.mjs";

/* -------------------------------------------------------------------------- */
/* Fixtures: one session, seen before and after a compaction folded turns 1-2  */
/* -------------------------------------------------------------------------- */

const user = (text: string, timestamp: number) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const assistant = (text: string, timestamp: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  timestamp,
});

const FIRST_QUESTION = user("第一个问题", 1_000);
const FIRST_ANSWER = assistant("第一个回答", 2_000);
const SECOND_QUESTION = user("第二个问题", 3_000);
const SECOND_ANSWER = assistant("第二个回答", 4_000);
const THIRD_QUESTION = user("第三个问题", 5_000);
/** Still being streamed: it is in `state.messages` but not in the file yet. */
const THIRD_ANSWER = assistant("第三个回答", 6_000);

/** pi's persisted `compaction` entry, as written by `appendCompaction()`. */
const COMPACTION = {
  type: "compaction",
  id: "cmp1",
  parentId: "e5",
  timestamp: "2026-09-08T09:00:00.000Z",
  summary: "用户问了两个问题，模型各答了一次。",
  firstKeptEntryId: "e5",
  tokensBefore: 45_000,
};

/** What pi hands the model after a compaction: the summary stands in for turns 1-2. */
const COMPACTION_SUMMARY_MESSAGE = {
  role: "compactionSummary",
  summary: COMPACTION.summary,
  tokensBefore: COMPACTION.tokensBefore,
  timestamp: Date.parse(COMPACTION.timestamp),
};

const messageEntry = (id: string, message: Record<string, unknown>) => ({ type: "message", id, parentId: null, message });

const PERSISTED_BEFORE = [
  messageEntry("e1", FIRST_QUESTION),
  messageEntry("e2", FIRST_ANSWER),
  messageEntry("e3", SECOND_QUESTION),
  messageEntry("e4", SECOND_ANSWER),
  messageEntry("e5", THIRD_QUESTION),
];

const PERSISTED_AFTER = [...PERSISTED_BEFORE.slice(0, 4), COMPACTION, messageEntry("e5", THIRD_QUESTION)];

const session = (branch: readonly unknown[], stateMessages: readonly unknown[]) => ({
  sessionManager: { getBranch: () => branch },
  state: { messages: stateMessages },
});

const BEFORE = session(PERSISTED_BEFORE, [...PERSISTED_BEFORE.map((entry) => entry.message), THIRD_ANSWER]);
const AFTER = session(PERSISTED_AFTER, [
  COMPACTION_SUMMARY_MESSAGE,
  THIRD_QUESTION,
  THIRD_ANSWER,
]);

const bubblesOf = (transcript: readonly unknown[]) =>
  buildChatBubbles(transcript as never, { isStreaming: false });

const textOf = (bubble: { content: unknown }) => String(bubble.content);

/* -------------------------------------------------------------------------- */
/* The render source is the whole branch, not the model's context             */
/* -------------------------------------------------------------------------- */

test("a compacted session still renders every turn", () => {
  assert.deepEqual(
    displayTranscript(AFTER).map((message: { content: { text: string }[] }) => message.content[0].text),
    ["第一个问题", "第一个回答", "第二个问题", "第二个回答", "第三个问题", "第三个回答"],
  );
});

test("the in-flight answer is appended once, never duplicated", () => {
  // `state.messages` holds the very object pi will persist at `message_end`, so
  // identity - not text comparison - is what separates history from the live tail.
  const transcript = displayTranscript(session(PERSISTED_AFTER, [THIRD_QUESTION, THIRD_ANSWER]));
  assert.deepEqual(
    transcript.map((message: { content: { text: string }[] }) => message.content[0].text),
    ["第一个问题", "第一个回答", "第二个问题", "第二个回答", "第三个问题", "第三个回答"],
  );
  assert.equal(
    transcript.filter((message: unknown) => message === THIRD_ANSWER).length,
    1,
  );
});

test("summaries, custom messages and bookkeeping entries are not conversation", () => {
  const branch = [
    messageEntry("e1", FIRST_QUESTION),
    { type: "model_change", id: "m1", parentId: "e1" },
    { type: "thinking_level_change", id: "t1", parentId: "m1" },
    { type: "custom_message", id: "c1", parentId: "t1", customType: "x", content: [] },
    { type: "branch_summary", id: "b1", parentId: "c1", summary: "s" },
    messageEntry("e2", { role: "bashExecution", content: "ls", timestamp: 2_000 }),
    messageEntry("e3", FIRST_ANSWER),
    COMPACTION,
  ];
  const transcript = displayTranscript(session(branch, []));
  assert.deepEqual(
    transcript.map((message: { role: string }) => message.role),
    ["user", "assistant"],
  );
  assert.equal(isDisplayMessage({ role: "compactionSummary" }), false);
  assert.equal(isDisplayMessage(null), false);
});

test("without a session manager the model view is used, minus non-conversation roles", () => {
  const transcript = displayTranscript({
    state: { messages: [FIRST_QUESTION, COMPACTION_SUMMARY_MESSAGE, FIRST_ANSWER] },
  });
  assert.deepEqual(
    transcript.map((message: { role: string }) => message.role),
    ["user", "assistant"],
  );
});

/* -------------------------------------------------------------------------- */
/* Bubble identity must not move when a compaction lands                      */
/* -------------------------------------------------------------------------- */

test("bubble ids are identical before and after a compaction", () => {
  const before = bubblesOf(displayTranscript(BEFORE)).map((bubble) => bubble.id);
  const after = bubblesOf(displayTranscript(AFTER)).map((bubble) => bubble.id);

  assert.deepEqual(after, before);
  assert.deepEqual(after, ["t1#user", "t1#assistant", "t2#user", "t2#assistant", "t3#user", "t3#assistant"]);
});

test("rendering the model's context instead would renumber the surviving turns", () => {
  // Guard for the exact regression this change exists to fix: the folded view
  // still draws one question and one answer, but `t1#user` is now a *different*
  // question, so every bubble on screen changes identity mid-run.
  const folded = bubblesOf([COMPACTION_SUMMARY_MESSAGE, THIRD_QUESTION, THIRD_ANSWER]);
  assert.deepEqual(folded.map((bubble) => bubble.id), ["t1#user", "t1#assistant"]);
  assert.equal(textOf(folded[0]), "第三个问题");

  const rendered = bubblesOf(displayTranscript(AFTER));
  assert.equal(textOf(rendered.find((bubble) => bubble.id === "t1#user")), "第一个问题");
});

test("a turn opened after a compaction does not collide with restored history", () => {
  // The stream names its bubbles with this tracker, so it has to count turns the
  // same way the snapshot does - over the whole branch.
  const transcript = displayTranscript(session(PERSISTED_AFTER, [COMPACTION_SUMMARY_MESSAGE, THIRD_QUESTION]));
  const tracker = createBubbleTracker(countTranscriptTurns(transcript as never));
  const existing = new Set(bubblesOf(transcript).map((bubble) => bubble.id));

  assert.equal(tracker.messageStarted("user")?.bubbleId, "t4#user");
  assert.equal(existing.has("t4#user"), false);
  assert.equal(tracker.currentAssistant(), null);
  assert.equal(tracker.messageStarted("assistant")?.bubbleId, "t4#assistant");
});

/* -------------------------------------------------------------------------- */
/* The composer strip                                                         */
/* -------------------------------------------------------------------------- */

test("only a running compaction and a failed one are said out loud", () => {
  assert.deepEqual(compactionNotice({ isCompacting: true, compactionError: null }), {
    tone: "running",
    text: t(COMPACTION_RUNNING_TEXT_KEY),
  });
  assert.deepEqual(compactionNotice({ isCompacting: false, compactionError: null }), null);
  assert.equal(
    compactionNotice({ isCompacting: false, compactionError: "boom" })?.text,
    t("compaction.failed", { reason: "boom" }),
  );
});

test("a failure outranks a retry in flight", () => {
  // While a retry runs, the previous failure is still true information.
  assert.equal(compactionNotice({ isCompacting: true, compactionError: "boom" })?.tone, "failed");
});

test("pi's own prefix is trimmed but the reason survives", () => {
  assert.equal(compactionFailureReason("Auto-compaction failed: 429 too many requests"), "429 too many requests");
  assert.equal(compactionFailureReason("Compaction failed: aborted by user"), "aborted by user");
  assert.equal(compactionFailureReason("Context overflow recovery failed: no model"), "no model");
  assert.equal(compactionFailureReason("   "), t("compaction.unknownError"));
  assert.equal(compactionFailureReason(null), t("compaction.unknownError"));
  assert.equal(compactionFailureReason("something odd"), "something odd");
});

test("a cancelled compaction is never reported as a failure", () => {
  assert.equal(compactionOutcome({ aborted: true }), "cancelled");
  assert.equal(compactionOutcome({ aborted: false, errorMessage: "Auto-compaction failed: x" }), "failed");
  assert.equal(compactionOutcome({ aborted: false }), "succeeded");
  // An empty error string is pi's "nothing to report", not a fault.
  assert.equal(compactionOutcome({ aborted: false, errorMessage: "" }), "succeeded");
});

/* -------------------------------------------------------------------------- */
/* The manual "compact now" button                                            */
/* -------------------------------------------------------------------------- */

test("manual compaction is offered when the session is idle", () => {
  assert.deepEqual(compactActionState({ isStreaming: false, isCompacting: false }), {
    disabled: false,
    label: t(COMPACT_LABEL_IDLE_KEY),
    reason: null,
  });
});

test("a streaming answer greys the button out and says why", () => {
  const action = compactActionState({ isStreaming: true, isCompacting: false });
  assert.equal(action.disabled, true);
  assert.equal(action.reason, "streaming");
  // The reason has to be readable: a disabled button swallows hover tooltips.
  assert.notEqual(action.label, t("compaction.label.idle"));
});

test("an in-flight compaction outranks the streaming hint", () => {
  // pi auto-compacts mid-answer, so both flags are true; "compacting" is the
  // more specific news and must not be masked by the generic wait message.
  const action = compactActionState({ isStreaming: true, isCompacting: true });
  assert.equal(action.disabled, true);
  assert.equal(action.reason, "compacting");
  assert.equal(action.label, t(COMPACT_LABEL_COMPACTING_KEY));
});

test("the popover is told about streaming, like the thinking select beside it", () => {
  // Both sit in the same toolbar and both touch session state; compact was the
  // one left clickable.
  const source = readFileSync(join(import.meta.dirname, "../src/app/App.tsx"), "utf8");
  // 2026-09-17：思考/模型控件不再手写 isStreaming||isCompacting，改用与桥
  // `isSessionBusy()` 对齐的 composerSessionBusy（含 isStopping 与 pi 队列）。
  assert.match(source, /<ThinkingLevelSelect[\s\S]{0,300}disabled=\{composerSessionBusy\}/);
  assert.match(source, /isStreaming=\{state\.isStreaming\}[\s\S]{0,200}canCompact=/);
});

test("button, caller and bridge all refuse a compaction while streaming", () => {
  const app = readFileSync(join(import.meta.dirname, "../src/app/App.tsx"), "utf8");
  const hook = readFileSync(join(import.meta.dirname, "../src/features/chat/usePiDesktopApp.ts"), "utf8");
  const server = readFileSync(join(import.meta.dirname, "../server/index.mjs"), "utf8");

  // UI: actually disabled, not just restyled.
  assert.match(app, /const compactAction = compactActionState\(\{ isStreaming, isCompacting \}\)/);
  assert.match(app, /disabled=\{compactAction\.disabled\}/);

  // Client: a click queued before the state landed cannot sneak past the button.
  assert.match(hook, /if \(state\.isCompacting \|\| state\.isStreaming \|\| !sessionPath\)/);

  // Bridge: a second window or a stale tab still gets a no.
  assert.match(server, /"\/api\/compact"[\s\S]{0,400}session\.isStreaming \|\| targetRuntime\.session\.isCompacting/);
});

/* -------------------------------------------------------------------------- */
/* Wiring guards                                                            */
/* -------------------------------------------------------------------------- */

test("the server reads the transcript from the branch, not from the model's context", () => {
  const source = readFileSync(join(import.meta.dirname, "../server/index.mjs"), "utf8");
  // `state.messages` is still right for diagnostics; the places that draw or
  // number conversation must not use it.
  assert.equal(source.includes("buildChatBubbles(displayTranscript("), true);
  assert.equal(source.includes("countTranscriptTurns(displayTranscript("), true);
  assert.equal(/buildChatBubbles\((\w+)\.session\.state\.messages/.test(source), false);
  assert.equal(source.includes("countTranscriptTurns(activeSession.state.messages)"), false);
});

test("compaction_end carries the fields the strip needs", () => {
  const source = readFileSync(join(import.meta.dirname, "../server/index.mjs"), "utf8");
  assert.match(source, /type: "compaction_end"[\s\S]{0,240}aborted: event\.aborted === true/);
  assert.match(source, /type: "compaction_end"[\s\S]{0,360}errorMessage/);
});
