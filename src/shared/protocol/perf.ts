/**
 * Boundary `perf`: the perf probe as a declared protocol instead of a global.
 *
 * What this replaces: `api.ts` looked up `globalThis.__piDesktopPerf` (typed by a `declare var` in
 * `src/vite-env.d.ts`) and called `.mark()` if it happened to be enabled. That worked, but it was an
 * **undeclared** seam: nothing said what a probe is, nothing could install a different one, and the
 * only reason it was a global at all was to dodge an import cycle (`perf.ts` imports `api.ts` for
 * `reportDiagnostic`, so `api.ts` could not import `perf.ts` back).
 *
 * The cycle is dodged properly now: this type lives in the protocol layer, the installed probe lives
 * in `src/lib/perf-port.ts` (which imports nothing but this file), so
 * `transport/perf → perf-port → protocol` and the cycle is gone.
 *
 * Semantics kept exactly as before: the probe is **opt-in**. A port whose `enabled` is false is
 * never asked to mark anything, so the production hot path pays one property read.
 */

export interface PerfPort {
  /** Whether the user turned measuring on (`?perf=1`, `VITE_PI_DESKTOP_PERF=1`, or the devtools switch). */
  readonly enabled: boolean;
  /**
   * Record one measurement. Must never throw: telemetry cannot be allowed to break a turn.
   * `detail` is whatever the caller measured (counts, bytes, levels) - flat numbers in practice.
   */
  mark(name: string, durationMs: number, detail?: Record<string, unknown>): void;
}