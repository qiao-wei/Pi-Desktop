/**
 * Bubble ordinal -> session entry lookup used by edit/rewind.
 *
 * pi's session file is append-only, so the lookup must count user message
 * *entries on the current branch* exactly the way `chatBubbleId` numbers them
 * (`t1#user` is the first user message) and never touch non-message entries.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { userMessageEntryIdForTurn, type BranchEntryLike } from "../src/shared/sessionBranch.ts";

const branch: BranchEntryLike[] = [
  { type: "session", id: "header" },
  { type: "message", id: "u1", message: { role: "user" } },
  { type: "message", id: "a1", message: { role: "assistant" } },
  { type: "message", id: "t1", message: { role: "toolResult" } },
  { type: "compaction", id: "c1" },
  { type: "message", id: "u2", message: { role: "user" } },
  { type: "message", id: "a2", message: { role: "assistant" } },
  { type: "custom_message", id: "cm1", message: { role: "user" } },
  { type: "message", id: "u3", message: { role: "user" } },
];

test("turn ordinals are 1-based user-message ordinals", () => {
  assert.equal(userMessageEntryIdForTurn(branch, 1), "u1");
  assert.equal(userMessageEntryIdForTurn(branch, 2), "u2");
  assert.equal(userMessageEntryIdForTurn(branch, 3), "u3");
});

test("only message entries count, and a custom_message never shifts an ordinal", () => {
  // u3 stays the third turn even though a `custom_message` sits before it.
  assert.equal(userMessageEntryIdForTurn(branch, 3), "u3");
  assert.equal(userMessageEntryIdForTurn(branch, 4), null);
});

test("out-of-range and invalid turns resolve to null", () => {
  assert.equal(userMessageEntryIdForTurn(branch, 0), null);
  assert.equal(userMessageEntryIdForTurn(branch, -1), null);
  assert.equal(userMessageEntryIdForTurn(branch, 1.5), null);
  assert.equal(userMessageEntryIdForTurn([], 1), null);
});

test("entries without ids are ignored (never rewind to undefined)", () => {
  const entries: BranchEntryLike[] = [
    { type: "message", message: { role: "user" } },
    { type: "message", id: "real", message: { role: "user" } },
  ];
  assert.equal(userMessageEntryIdForTurn(entries, 1), "real");
});