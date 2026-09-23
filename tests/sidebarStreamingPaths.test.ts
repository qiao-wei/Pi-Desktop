import test from "node:test";
import assert from "node:assert/strict";

import { sidebarStreamingSessionPaths } from "../src/features/chat/sidebarStreaming.ts";

/**
 * The sidebar clock for the session the user just submitted in.
 *
 * This window's own run is only known locally (`state.isStreaming`); the server list
 * arrives with a snapshot, and while this window owns the stream that snapshot comes at
 * the end of the turn. Without the union the row sits without a clock for the whole
 * answer - the bug reported by the user.
 */

test("this window's own run is added to the server's busy list", () => {
  assert.deepEqual(sidebarStreamingSessionPaths(["/other"], "/mine", true), ["/other", "/mine"]);
});

test("an already-listed session is not duplicated", () => {
  const server = ["/mine", "/other"];
  const result = sidebarStreamingSessionPaths(server, "/mine", true);
  assert.equal(result, server);
  assert.deepEqual(result, ["/mine", "/other"]);
});

test("nothing is claimed while this window is idle", () => {
  const server = ["/other"];
  const result = sidebarStreamingSessionPaths(server, "/mine", false);
  assert.equal(result, server);
});

test("a missing active path or server list stays safe", () => {
  assert.deepEqual(sidebarStreamingSessionPaths(undefined, "/mine", true), ["/mine"]);
  assert.deepEqual(sidebarStreamingSessionPaths(["/other"], undefined, true), ["/other"]);
  assert.deepEqual(sidebarStreamingSessionPaths(undefined, undefined, false), []);
});