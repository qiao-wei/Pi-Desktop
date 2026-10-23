/**
 * The installed `PerfPort` (boundary `perf`).
 *
 * A separate module for one reason only: the import graph. `src/lib/perf.ts` imports
 * `src/lib/api.ts` for `reportDiagnostic`, so `api.ts` (and `bridge/transport.ts`) cannot import
 * `perf.ts` back - that would be a module cycle, and `module-cycle` in the architecture checker
 * fails the build on one. This file imports nothing but the protocol type, so both sides can use it.
 *
 * The default is `null` (no probe): measuring is opt-in, exactly like before, when the only way to
 * reach a probe was `globalThis.__piDesktopPerf`.
 */

import type { PerfPort } from "../shared/protocol/perf.ts";

let port: PerfPort | null = null;

/** The installed probe, or null when nothing is measuring. */
export function getPerfPort(): PerfPort | null {
  return port;
}

/**
 * Install a probe (the real one from `src/lib/perf.ts`, or a test double).
 * `setPerfPort(null)` removes it - that is what the tests that care about the hot path do.
 */
export function setPerfPort(next: PerfPort | null): void {
  port = next;
}

/** Helper for callers that only want to mark when measuring: returns the port or null. */
export function activePerfPort(): PerfPort | null {
  return port?.enabled ? port : null;
}