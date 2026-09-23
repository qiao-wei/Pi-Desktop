/**
 * Regression test for "每次提交会话时，自动到底部".
 *
 * The symptom: after wheeling up to re-read history, sending a new message left
 * the viewport where it was - the user's own bubble and the whole reply were
 * written below the fold. Submitting *did* record the intent to follow; the intent
 * just lived in a per-session record that `ChatThread`'s viewport owner reads once
 * when the session is entered and never re-reads until the next switch.
 *
 * The fix is a live signal (`chatScrollBus`). These cover the routing rules that
 * make the signal trustworthy, then assert both ends are actually wired: the
 * composer emits, the viewport owner consumes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createScrollToBottomBus, type ScrollToBottomRequest } from "../src/shared/chatScrollBus.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const chatThreadSource = readFileSync(
  new URL("../src/features/chat/ChatThread.tsx", import.meta.url),
  "utf8",
);

function collect(listener: (request: ScrollToBottomRequest) => void) {
  const seen: ScrollToBottomRequest[] = [];
  return {
    seen,
    listener: (request: ScrollToBottomRequest) => {
      seen.push(request);
      listener?.(request);
    },
  };
}

test("a request is delivered to the live owner with its reason", () => {
  const bus = createScrollToBottomBus();
  const { seen, listener } = collect(() => {});
  bus.subscribe("/proj/s1.jsonl", listener);

  assert.equal(bus.request("/proj/s1.jsonl", "submit"), 1);
  assert.deepEqual(seen, [{ sessionPath: "/proj/s1.jsonl", reason: "submit" }]);
});

test("owners of another session never see the request", () => {
  const bus = createScrollToBottomBus();
  const mine = collect(() => {});
  const theirs = collect(() => {});
  bus.subscribe("/proj/s1.jsonl", mine.listener);
  bus.subscribe("/proj/s2.jsonl", theirs.listener);

  assert.equal(bus.request("/proj/s1.jsonl", "submit"), 1);
  assert.equal(mine.seen.length, 1);
  assert.equal(theirs.seen.length, 0);
});

test("every owner of the session is served", () => {
  const bus = createScrollToBottomBus();
  const first = collect(() => {});
  const second = collect(() => {});
  bus.subscribe("/proj/s1.jsonl", first.listener);
  bus.subscribe("/proj/s1.jsonl", second.listener);

  assert.equal(bus.request("/proj/s1.jsonl", "submit"), 2);
  assert.equal(first.seen.length, 1);
  assert.equal(second.seen.length, 1);
});

test("a request made while the thread is unmounted is delivered on mount, once", () => {
  const bus = createScrollToBottomBus();
  // No subscriber yet: the submit happened during a session switch, or in a view
  // that does not render the thread.
  assert.equal(bus.request("/proj/s1.jsonl", "submit"), 0);
  assert.equal(bus.hasSubscriber("/proj/s1.jsonl"), false);

  const first = collect(() => {});
  const second = collect(() => {});
  const unsubscribe = bus.subscribe("/proj/s1.jsonl", first.listener);
  assert.equal(first.seen.length, 1);
  assert.equal(first.seen[0]?.reason, "submit");

  // Parked requests do not replay forever.
  bus.subscribe("/proj/s1.jsonl", second.listener);
  assert.equal(second.seen.length, 0);

  unsubscribe();
  assert.equal(bus.hasSubscriber("/proj/s1.jsonl"), true);
  assert.equal(bus.request("/proj/s1.jsonl", "submit"), 1);
});

test("only the newest parked request survives", () => {
  const bus = createScrollToBottomBus();
  bus.request("/proj/s1.jsonl", "submit");
  bus.request("/proj/s1.jsonl", "retry");

  const { seen, listener } = collect(() => {});
  bus.subscribe("/proj/s1.jsonl", listener);
  assert.deepEqual(
    seen.map((request) => request.reason),
    ["retry"],
  );
});

test("unsubscribing stops delivery and reports the session as unowned", () => {
  const bus = createScrollToBottomBus();
  const { seen, listener } = collect(() => {});
  const unsubscribe = bus.subscribe("/proj/s1.jsonl", listener);

  unsubscribe();
  assert.equal(bus.hasSubscriber("/proj/s1.jsonl"), false);
  assert.equal(bus.request("/proj/s1.jsonl", "submit"), 0);
  assert.equal(seen.length, 0);
  // Double unsubscribe must not throw.
  unsubscribe();
});

test("the composer asks the live owner, not just the saved record", () => {
  const follow = appSource.match(/function followLatestScroll\(sessionPath: string\) \{[\s\S]*?\n  \}/);
  assert.ok(follow, "followLatestScroll is still there");
  assert.match(follow[0], /scrollStateRef\.current\.set\(sessionPath,\s*\{[\s\S]*?shouldFollow: true/);
  assert.match(follow[0], /chatScrollToBottomBus\.request\(sessionPath, "submit"\)/);
  // The request has to happen where the record was already being flipped: on submit.
  const submit = appSource.slice(appSource.indexOf("async function handleSubmit"));
  assert.match(submit.slice(0, submit.indexOf("submitTurn(")), /followLatestScroll\(visibleSessionPath\)/);
  assert.equal(appSource.match(/submitTurn\(/g)?.length, 1, "one submit path, so one pin path");
});

test("the viewport owner consumes the request and re-pins", () => {
  const handler = chatThreadSource.match(/const pinToBottom = \(reason: string\) => \{[\s\S]*?\n    \};/);
  assert.ok(handler, "pinToBottom exists inside the viewport effect");
  const body = handler[0];
  // Every source of the follow decision has to move: the entry snapshot the
  // restore loop re-applies, the effect-local flag, and the ref the per-frame
  // streaming pump reads.
  assert.match(body, /savedState\.shouldFollow = true/);
  assert.match(body, /currentShouldFollow = true/);
  assert.match(body, /followRef\.current = true/);
  assert.match(body, /scrollToBottom\(\)/);
  assert.match(body, /requestAnimationFrame\(bottomTail\)/);
  assert.match(body, /persist\(true\)/);

  assert.match(
    chatThreadSource,
    /chatScrollToBottomBus\.subscribe\(sessionPath,\s*\(request\) => \{[\s\S]*?pinToBottom\(request\.reason\)/,
  );
  assert.match(chatThreadSource, /const unsubscribePinToBottom = chatScrollToBottomBus\.subscribe/);
  assert.match(chatThreadSource, /\n      unsubscribePinToBottom\(\);/, "the effect unsubscribes");
});
