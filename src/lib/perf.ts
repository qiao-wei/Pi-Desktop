import { reportDiagnostic } from "./api";

/**
 * Zero-dependency performance probe for the streaming hot path.
 *
 * It only accumulates counters, so the cost of an instrumented call site is
 * two `performance.now()` reads plus a Map lookup. Nothing is allocated per
 * sample, no arrays are kept, and the report is aggregated on a timer.
 *
 * Enable with any of:
 *   - `localStorage.setItem("pi-desktop.perf", "1")`
 *   - url `?perf=1`
 *   - `VITE_PI_DESKTOP_PERF=1` at build time
 * Add `?perf=overlay=1` (or `pi-desktop.perf.overlay=1`) for the on-screen panel.
 * Force off with `?perf=0`.
 */

export type PerfFields = Record<string, number>;

type Counter = {
  count: number;
  ms: number;
  maxMs: number;
  fields: PerfFields;
};

type FrameStats = {
  frames: number;
  longFrames: number; // > 32ms
  hugeFrames: number; // > 100ms
  worstMs: number;
  totalMs: number;
};

/**
 * Long-animation-frame attribution.
 *
 * The rAF gap histogram says *that* a frame took 437ms; it cannot say who held
 * the main thread. `long-animation-frame` entries carry the scripts that ran in
 * that frame, which is the only way to attribute work that lives outside every
 * probe we own (JSON parse of a poll payload, GC, a subtree we never wrapped).
 * Safari ships it behind a recent baseline, so `longtask` is the fallback and
 * both are feature-detected.
 */
type LoafScript = { name: string; ms: number };

const stall = {
  frames: 0,
  totalMs: 0,
  blockingMs: 0,
  worstMs: 0,
  worstScripts: [] as LoafScript[],
  worstRenderMs: 0,
  worstStyleLayoutMs: 0,
  scripts: new Map<string, { count: number; ms: number }>(),
};

function recordLongAnimationFrame(entry: PerformanceEntry) {
  const duration = entry.duration;
  const scripts =
    (entry as unknown as { scripts?: Array<{ name?: string; invoker?: string; duration?: number }> }).scripts ??
    [];
  stall.frames += 1;
  stall.totalMs += duration;
  stall.blockingMs +=
    (entry as unknown as { blockingDuration?: number }).blockingDuration ?? Math.max(0, duration - 32);
  for (const script of scripts) {
    const name = script.name || script.invoker || "unknown";
    const current = stall.scripts.get(name) ?? { count: 0, ms: 0 };
    current.count += 1;
    current.ms += script.duration ?? 0;
    stall.scripts.set(name, current);
  }
  if (duration > stall.worstMs) {
    stall.worstMs = duration;
    stall.worstScripts = scripts
      .map((script) => ({ name: script.name || script.invoker || "unknown", ms: script.duration ?? 0 }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 4);
    const renderStart = (entry as unknown as { renderStart?: number }).renderStart;
    const styleAndLayout = (entry as unknown as { styleAndLayoutStart?: number }).styleAndLayoutStart;
    stall.worstRenderMs = renderStart ? duration - (renderStart - entry.startTime) : 0;
    stall.worstStyleLayoutMs = styleAndLayout ? duration - (styleAndLayout - entry.startTime) : 0;
  }
}

function startStallObserver() {
  if (!perfEnabled || typeof PerformanceObserver === "undefined") {
    return;
  }
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  try {
    if (supported.includes("long-animation-frame")) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) {
            recordLongAnimationFrame(entry);
          }
        }
      }).observe({ type: "long-animation-frame", buffered: true });
    } else if (supported.includes("longtask")) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) {
            perfMark("longtask", entry.duration);
          }
        }
      }).observe({ type: "longtask", buffered: true });
    }
  } catch {
    // Unsupported entry type: the frame histogram above still works.
  }
}

const counters = new Map<string, Counter>();
const frames: FrameStats = { frames: 0, longFrames: 0, hugeFrames: 0, worstMs: 0, totalMs: 0 };

const FLAG_STORAGE_KEY = "pi-desktop.perf";
const OVERLAY_STORAGE_KEY = "pi-desktop.perf.overlay";

function readFlag(key: string, urlValue: string | null): string | null {
  if (urlValue != null) {
    return urlValue;
  }
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function envPerfFlag(): string | null {
  // Keep an explicit "0": it is the documented way to switch the probes off,
  // and dev auto-enables them otherwise.
  return import.meta.env.VITE_PI_DESKTOP_PERF ?? null;
}

function resolveEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const url = new URL(window.location.href);
  const fromUrl = readFlag(FLAG_STORAGE_KEY, url.searchParams.get("perf"));
  if (fromUrl === "0" || envPerfFlag() === "0") {
    return false;
  }
  if (fromUrl === "1" || fromUrl === "overlay") {
    return true;
  }
  // A Tauri window always loads the fixed devUrl/bundled URL, so a query string
  // is not available there: `VITE_PI_DESKTOP_PERF=1|overlay` or the localStorage
  // flag are the supported switches.
  //
  // Deliberately *not* auto-enabled in dev any more: a plain `npm run tauri:dev`
  // used to carry every counter, the React Profiler and the rAF loop while
  // reporting nothing (the diagnostics env vars were absent), which made it
  // impossible to tell app stutter from probe overhead. Plain runs are now a
  // true zero-instrumentation baseline.
  if (envPerfFlag()) {
    return true;
  }
  return readFlag(FLAG_STORAGE_KEY, null) === "1";
}

export const perfEnabled = resolveEnabled();

function overlayRequested(): boolean {
  const url = new URL(window.location.href);
  if (url.searchParams.get("perf") === "overlay" || envPerfFlag() === "overlay") {
    return true;
  }
  try {
    return globalThis.localStorage?.getItem(OVERLAY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function consoleRequested(): boolean {
  try {
    return globalThis.localStorage?.getItem("pi-desktop.perf.console") === "1";
  } catch {
    return false;
  }
}

/** Record one sample. Safe to call when disabled (it becomes a no-op). */
export function perfMark(name: string, ms: number, fields?: PerfFields) {
  if (!perfEnabled) {
    return;
  }
  let counter = counters.get(name);
  if (!counter) {
    counter = { count: 0, ms: 0, maxMs: 0, fields: {} };
    counters.set(name, counter);
  }
  counter.count += 1;
  counter.ms += ms;
  if (ms > counter.maxMs) {
    counter.maxMs = ms;
  }
  if (fields) {
    for (const key of Object.keys(fields)) {
      counter.fields[key] = (counter.fields[key] ?? 0) + fields[key];
    }
  }
}

/** Count an occurrence without timing it. */
export function perfCount(name: string, fields?: PerfFields) {
  perfMark(name, 0, fields);
}

/** Wrap a synchronous block and time it. */
export function perfMeasure<T>(name: string, run: () => T, fields?: (result: T) => PerfFields | undefined): T {
  if (!perfEnabled) {
    return run();
  }
  const started = performance.now();
  const result = run();
  const extra = fields?.(result);
  perfMark(name, performance.now() - started, extra);
  return result;
}

/**
 * Begin/end pair for sites where the work is not a single call expression.
 * The returned stop function is idempotent-ish: it just records one sample.
 */
export function perfSpan(name: string): (fields?: PerfFields) => void {
  if (!perfEnabled) {
    return () => undefined;
  }
  const started = performance.now();
  return (fields?: PerfFields) => {
    perfMark(name, performance.now() - started, fields);
  };
}

export type PerfSnapshot = {
  windowMs: number;
  frames: FrameStats & { avgMs: number; fps: number };
  stalls: {
    frames: number;
    totalMs: number;
    blockingMs: number;
    worstMs: number;
    worstRenderMs: number;
    worstStyleLayoutMs: number;
    worstScripts: LoafScript[];
    topScripts: Array<{ name: string; count: number; ms: number }>;
  };
  counters: Array<{ name: string; count: number; ms: number; avgMs: number; maxMs: number; fields: PerfFields }>;
};

let windowStartedAt = performance.now();

export function perfReset() {
  counters.clear();
  frames.frames = 0;
  frames.longFrames = 0;
  frames.hugeFrames = 0;
  frames.worstMs = 0;
  frames.totalMs = 0;
  stall.frames = 0;
  stall.totalMs = 0;
  stall.blockingMs = 0;
  stall.worstMs = 0;
  stall.worstScripts = [];
  stall.worstRenderMs = 0;
  stall.worstStyleLayoutMs = 0;
  stall.scripts.clear();
  windowStartedAt = performance.now();
}

export function perfSnapshot(): PerfSnapshot {
  const windowMs = Math.max(1, performance.now() - windowStartedAt);
  const list = [...counters.entries()]
    .map(([name, counter]) => ({
      name,
      count: counter.count,
      ms: round(counter.ms),
      avgMs: round(counter.count ? counter.ms / counter.count : 0),
      maxMs: round(counter.maxMs),
      fields: mapFields(counter.fields),
    }))
    .sort((a, b) => b.ms - a.ms);

  return {
    windowMs: round(windowMs),
    frames: {
      ...frames,
      frames: frames.frames,
      avgMs: round(frames.frames ? frames.totalMs / frames.frames : 0),
      fps: round(frames.frames ? (frames.frames / windowMs) * 1000 : 0),
    },
    stalls: {
      frames: stall.frames,
      totalMs: round(stall.totalMs),
      blockingMs: round(stall.blockingMs),
      worstMs: round(stall.worstMs),
      worstRenderMs: round(stall.worstRenderMs),
      worstStyleLayoutMs: round(stall.worstStyleLayoutMs),
      worstScripts: stall.worstScripts.map((script) => ({ name: script.name, ms: round(script.ms) })),
      topScripts: [...stall.scripts.entries()]
        .map(([name, value]) => ({ name, count: value.count, ms: round(value.ms) }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5),
    },
    counters: list,
  };
}

function mapFields(source: PerfFields): PerfFields {
  const out: PerfFields = {};
  for (const key of Object.keys(source)) {
    out[key] = round(source[key]);
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

let frameLoopStarted = false;

function startFrameLoop() {
  if (frameLoopStarted || !perfEnabled || typeof window === "undefined") {
    return;
  }
  frameLoopStarted = true;
  let previous = performance.now();
  const tick = (now: number) => {
    const delta = now - previous;
    previous = now;
    // A frame gap larger than this means the main thread was busy (or the tab
    // was hidden). Ignore the huge gaps produced by backgrounding.
    if (delta < 2000) {
      frames.frames += 1;
      frames.totalMs += delta;
      if (delta > frames.worstMs) {
        frames.worstMs = delta;
      }
      if (delta > 32) {
        frames.longFrames += 1;
      }
      if (delta > 100) {
        frames.hugeFrames += 1;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let overlayEl: HTMLElement | null = null;

function renderOverlay(snapshot: PerfSnapshot) {
  if (!overlayEl || !overlayEl.isConnected) {
    return;
  }
  const lines = snapshot.counters.slice(0, 8).map((row) => {
    const perSecond = round((row.count / snapshot.windowMs) * 1000);
    const extras = Object.keys(row.fields)
      .map((key) => `${key}=${round(row.fields[key] / Math.max(1, row.count))}`)
      .join(" ");
    return `${row.name} · ${row.count}次/${perSecond}/s · ${row.avgMs}ms(峰值${row.maxMs}) ${extras}`;
  });
  const stallLine =
    snapshot.stalls.worstMs > 0
      ? `stall ${snapshot.stalls.frames}x 最坏 ${snapshot.stalls.worstMs}ms ← ${
          snapshot.stalls.worstScripts.map((script) => `${script.name}(${script.ms}ms)`).join(", ") || "无脚本归因"
        }`
      : "";
  overlayEl.textContent = [
    `perf: ${snapshot.frames.fps}fps · 长帧>${32}ms ${snapshot.frames.longFrames} · 最坏 ${snapshot.frames.worstMs}ms`,
    stallLine,
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}

let reporterStarted = false;

/** Flush an aggregated report every `intervalMs`. Cheap; call once at boot. */
export function perfStartReporter(intervalMs = 2000) {
  if (!perfEnabled || typeof window === "undefined" || reporterStarted) {
    return;
  }
  reporterStarted = true;
  perfExposeGlobal();
  startFrameLoop();
  startStallObserver();
  if (overlayRequested()) {
    overlayEl = document.createElement("div");
    overlayEl.setAttribute("data-perf-overlay", "");
    overlayEl.style.cssText = [
      "position:fixed",
      "right:8px",
      "bottom:8px",
      "z-index:2147483647",
      "max-width:52vw",
      "padding:8px 10px",
      "font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace",
      "white-space:pre",
      "color:#22312b",
      "background:rgba(255,255,255,.92)",
      "border:1px solid #d8d0c3",
      "border-radius:8px",
      "box-shadow:0 5px 18px rgba(18,22,20,.12)",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(overlayEl);
  }
  window.setInterval(() => {
    const snapshot = perfSnapshot();
    if (snapshot.counters.length === 0 && snapshot.frames.frames === 0) {
      return;
    }
    renderOverlay(snapshot);
    // The snapshot is already plain rounded numbers; a JSON round-trip here was
    // pure overhead, and keeping object references alive every 2s in WebKit is
    // the least clean part of the probe. Console output is opt-in.
    if (consoleRequested()) {
      console.info("[pi-desktop-perf]", snapshot);
    }
    const stop = perfSpan("perf.flush");
    reportDiagnostic("client.perf.summary", snapshot as unknown as Record<string, unknown>);
    stop();
    perfReset();
  }, intervalMs);
}

/** Devtools handle: `__piDesktopPerf.dump()`, `.reset()`, `.top()`. */
export function perfExposeGlobal() {
  if (typeof window === "undefined") {
    return;
  }
  const handle = { enabled: perfEnabled, mark: perfMark };
  globalThis.__piDesktopPerf = handle;
  Object.assign(handle, {
    enabled: perfEnabled,
    snapshot: perfSnapshot,
    reset: perfReset,
    dump: () => {
      const snapshot = perfSnapshot();
      console.table(snapshot.counters);
      console.info("[pi-desktop-perf] frames", snapshot.frames);
      return snapshot;
    },
  });
}
