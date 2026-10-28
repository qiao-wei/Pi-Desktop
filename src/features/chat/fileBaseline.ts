/**
 * The file's content *before* a `write` runs — the only way to know how many lines it is
 * about to remove.
 *
 * While a tool call's arguments stream, the row can already show `+N` (the arriving
 * `content`), but `−M` needs the old file. The derivation lives in `src/shared`, which is
 * a pure layer that must not touch I/O (the server imports it too), so the content is
 * handed in: this module is the *renderer's* answer to that question, and it is
 * deliberately a **synchronous read with a background fill** — the derivation stays pure
 * and simply sees `undefined` until the content has arrived, then sees the text.
 *
 * That shape is what makes the number appear at all: the first preview (128 chars in)
 * asks for the baseline, the fetch lands while the rest of `content` streams, and every
 * later preview has it. A `write` that creates a file, or a path outside the project, or
 * a binary/too-large file, yields "no baseline" — and then the row shows only `+N` rather
 * than inventing `−0`.
 */
import {
  normalizeFileContent,
  type WorkspaceFileAvailability,
} from "../../shared/workspaceFiles.ts";

export interface FileBaselineSource {
  projectId: string;
  sessionPath?: string;
  /**
   * How to fetch one file's content. Injected rather than imported so this module stays
   * free of the bridge transport (the renderer passes `fetchJson`; tests pass a stub).
   */
  fetchFile: (path: string) => Promise<unknown>;
}

/** Sync read: the text if it is already known, `undefined` while unknown. */
export type FileBaselineReader = (path: string) => string | undefined;

/** How many files to remember. A turn touches a handful; this is only a bound. */
const MAX_ENTRIES = 24;

interface BaselineEntry {
  /** `null` = known to be unreadable (binary, too large, missing, unreadable). */
  text: string | null;
}

function normalizeKey(path: string): string {
  return path.trim().replace(/^\.\//, "");
}

function sourceKey(source: FileBaselineSource): string {
  return `${source.projectId}\u0000${source.sessionPath ?? ""}`;
}

export function createFileBaselineReader(
  source: FileBaselineSource | (() => FileBaselineSource),
  options: {
    /** Override the source's fetch (tests). */
    read?: (path: string) => Promise<unknown>;
  } = {},
): FileBaselineReader {
  const resolve = typeof source === "function" ? source : () => source;
  const cache = new Map<string, BaselineEntry>();
  // Resolved lazily: the caller's source closure reads app state that may not exist yet
  // when the reader is constructed (React renders the hook before the value it reads).
  let key = "";
  const inFlight = new Set<string>();
  const read = options.read ?? ((path: string) => resolve().fetchFile(path));

  /** A project/session switch makes every remembered file irrelevant (and possibly wrong). */
  function syncSource() {
    const next = sourceKey(resolve());
    if (next === key) {
      return;
    }
    if (key !== "") {
      cache.clear();
      inFlight.clear();
    }
    key = next;
  }

  const remember = (key: string, text: string | null) => {
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(key, { text });
  };

  return (path: string): string | undefined => {
    syncSource();
    const file = normalizeKey(path);
    if (!file) {
      return undefined;
    }
    const cached = cache.get(file);
    if (cached) {
      return cached.text ?? undefined;
    }
    if (inFlight.has(file)) {
      return undefined;
    }
    // The first ask starts the fetch; the answer shows up on a later preview. Never
    // awaited here on purpose: a derivation cannot block on I/O (see the module comment).
    inFlight.add(file);
    void read(file)
      .then((raw) => {
        const parsed = normalizeFileContent(raw);
        const text = parsed?.availability === ("text" satisfies WorkspaceFileAvailability) ? parsed.text : null;
        remember(file, text);
      })
      .catch(() => remember(file, null))
      .finally(() => inFlight.delete(file));
    return undefined;
  };
}