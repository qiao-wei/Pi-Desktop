/**
 * Opening a project folder from the bridge.
 *
 * Regression this pins: `open` works fine from an interactive shell, but the bridge is a
 * background process, so macOS creates the Finder window *without* bringing Finder forward —
 * the window lands behind the app and the click reads as "nothing happened". The macOS plan
 * therefore has to end with an explicit Finder `activate`, and that step must stay optional
 * (a machine without automation permission still gets the folder window).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { revealFolder, revealFolderCommands } from "../server/revealFolder.mjs";

/** Fake child_process.spawn: records the calls and reports the given exit code. */
function fakeSpawn(calls, exitCodes = {}, errorFor = () => false) {
  return (command, args) => {
    const child = new EventEmitter();
    calls.push({ command, args });
    setImmediate(() => {
      if (errorFor(command)) {
        child.emit("error", new Error(`spawn ${command} ENOENT`));
        return;
      }
      child.emit("exit", exitCodes[command] ?? 0);
    });
    return child;
  };
}

test("macOS opens the folder and then brings Finder forward", () => {
  const steps = revealFolderCommands("/tmp/project", "darwin");

  assert.deepEqual(steps[0], { command: "open", args: ["/tmp/project"] });
  // Without this step the window opens behind the app (see the module comment).
  assert.deepEqual(steps[1], {
    command: "osascript",
    args: ["-e", 'tell application "Finder" to activate'],
    optional: true,
  });
});

test("Windows and Linux have a single opener step", () => {
  assert.deepEqual(revealFolderCommands("C:\\work", "win32"), [{ command: "explorer.exe", args: ["C:\\work"] }]);
  assert.deepEqual(revealFolderCommands("/work", "linux"), [{ command: "xdg-open", args: ["/work"] }]);
});

test("revealFolder runs the plan in order", async () => {
  const calls = [];
  await revealFolder("/tmp/project", { spawnImpl: fakeSpawn(calls), platform: "darwin" });

  assert.deepEqual(calls, [
    { command: "open", args: ["/tmp/project"] },
    { command: "osascript", args: ["-e", 'tell application "Finder" to activate'] },
  ]);
});

test("a failing activate step still counts as a successful reveal", async () => {
  const calls = [];
  await revealFolder("/tmp/project", {
    spawnImpl: fakeSpawn(calls, { osascript: 1 }),
    platform: "darwin",
  });

  assert.equal(calls.length, 2, "the folder was already opened; the activation failure is swallowed");
});

test("an AppleScript that cannot even spawn still leaves the folder open", async () => {
  const calls = [];
  await revealFolder("/tmp/project", {
    spawnImpl: fakeSpawn(calls, {}, (command) => command === "osascript"),
    platform: "darwin",
  });

  assert.equal(calls.length, 2);
});

test("a failing opener rejects and does not try to activate Finder", async () => {
  const calls = [];
  await assert.rejects(
    () => revealFolder("/tmp/project", { spawnImpl: fakeSpawn(calls, { open: 1 }), platform: "darwin" }),
    /Failed to run open/,
  );
  assert.deepEqual(calls, [{ command: "open", args: ["/tmp/project"] }]);
});