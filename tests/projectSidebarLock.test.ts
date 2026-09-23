import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveProjectSidebarLock,
  sidebarSwitchLockClass,
} from "../src/shared/projectSidebarLock.ts";

test("idle: sidebar is interactive and not dimmed", () => {
  assert.deepEqual(
    resolveProjectSidebarLock({ isBootstrapping: false, pendingSessionPath: null }),
    { locked: false, dimmed: false, pendingSessionPath: null, lockClass: "" },
  );
});

test("conversation switch: interactions stay locked but the list is not greyed out", () => {
  const lock = resolveProjectSidebarLock({
    isBootstrapping: true,
    pendingSessionPath: "/sessions/a.jsonl",
  });

  assert.equal(lock.locked, true);
  assert.equal(lock.dimmed, false);
  assert.equal(lock.pendingSessionPath, "/sessions/a.jsonl");
  assert.equal(lock.lockClass, sidebarSwitchLockClass);
});

test("list mutation (no pending switch): keeps the previous dimmed busy look", () => {
  const lock = resolveProjectSidebarLock({ isBootstrapping: true, pendingSessionPath: null });

  assert.equal(lock.locked, true);
  assert.equal(lock.dimmed, true);
  assert.equal(lock.lockClass, "");
});

test("initial bootstrap behaves like a mutation", () => {
  const lock = resolveProjectSidebarLock({ isBootstrapping: true, pendingSessionPath: "" });

  assert.equal(lock.dimmed, true);
  assert.equal(lock.pendingSessionPath, null);
});

test("a stale pending target is dropped once the refetch finished", () => {
  const lock = resolveProjectSidebarLock({
    isBootstrapping: false,
    pendingSessionPath: "/sessions/a.jsonl",
  });

  assert.equal(lock.locked, false);
  assert.equal(lock.pendingSessionPath, null);
  assert.equal(lock.dimmed, false);
});

test("switch lock class overrides the disabled dimming utilities", async () => {
  const { cn } = await import("../src/lib/utils.ts");

  const merged = cn(
    "disabled:pointer-events-none disabled:opacity-50",
    sidebarSwitchLockClass,
  );

  assert.match(merged, /disabled:opacity-100/);
  assert.doesNotMatch(merged, /disabled:opacity-50/);
  assert.match(merged, /disabled:cursor-progress/);
});
