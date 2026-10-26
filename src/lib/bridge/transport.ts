/**
 * Boundary `bridge`, renderer side: the transport the whole UI talks to the bridge through.
 *
 * This is the **swap point**. Everything above this module (feature hooks, components, the app
 * shell) is written against `BridgeTransport`; only this file names `fetch`, only this file
 * knows about HTTP status codes, `ETag` revalidation, NDJSON framing and the diagnostics probe.
 * Swapping the transport - a fake in a renderer test, a WebSocket, an entirely different host
 * protocol - is `setBridgeTransport(...)`, with no call-site change.
 *
 * Contract of the operations:
 *
 * - `request<T>` resolves to `null` **only** for `304 Not Modified` ("nothing moved, keep what
 *   you have"); it throws for anything not `ok`, carrying the bridge's own error text.
 * - `lastEtag(path)` exposes the revalidation tag the server handed out for that path, so a
 *   caller can send `If-None-Match` without keeping its own copy of the cache.
 * - `stream<T>` yields one parsed object per NDJSON line, in order, and never throws for a
 *   malformed line (it surfaces as `{ type: "error", message: <raw line> }` so a bad frame
 *   cannot silently truncate a turn).
 * - `fireAndForget` never throws and never rejects: telemetry must not be able to break a turn.
 */

import type { PerfPort } from "../../shared/protocol/perf.ts";
import { activePerfPort } from "../perf-port.ts";

export interface BridgeRequestInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface BridgeStreamOptions {
  signal?: AbortSignal;
}

export interface BridgeTransport {
  /** Base URL the UI is pointed at; part of the transport because a transport may not be HTTP. */
  readonly apiBase: string;

  request<T>(path: string, init?: BridgeRequestInit): Promise<T | null>;

  /** Last `ETag` the bridge sent for `path`, if any. */
  lastEtag(path: string): string | undefined;

  stream<T>(
    path: string,
    body: unknown,
    onEvent: (event: T) => void,
    options?: BridgeStreamOptions,
  ): Promise<void>;

  fireAndForget(path: string, body: unknown): void;
}

/**
 * Perf marks go through the declared `perf` boundary (`src/lib/perf-port.ts`), not through a
 * `globalThis` lookup: the port can be swapped in one place, and a test can install a fake to assert
 * what the request path measures instead of asserting on a global that happens to exist.
 */
function perfProbe(): PerfPort | null {
  return activePerfPort();
}

/**
 * 桥报错统一是 `{"error":"..."}`（或 `message`）。把整串 JSON 直接丢进红框，用户看到的是一堆
 * 引号，看不到到底哪儿不对 —— 先把人话抽出来，抽不到才原文上。
 */
export async function readBridgeErrorMessage(response: {
  status: number;
  statusText: string;
  text(): Promise<string>;
}): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `${response.status} ${response.statusText}`;
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message =
      typeof parsed?.error === "string" && parsed.error.trim()
        ? parsed.error
        : typeof parsed?.message === "string" && parsed.message.trim()
          ? parsed.message
          : "";
    if (message) {
      return message;
    }
  } catch {
    // 不是 JSON（反代 HTML 错误页之类），原文更有用。
  }
  return text;
}

export function createHttpBridgeTransport(apiBase: string): BridgeTransport {
  const etags = new Map<string, string>();

  return {
    apiBase,

    lastEtag(path: string): string | undefined {
      return etags.get(path);
    },

    async request<T>(path: string, init: BridgeRequestInit = {}): Promise<T | null> {
      // Perf marks are opt-in and only the bootstrap path is measured (it used to be a
      // multi-megabyte synchronous parse at startup, see src/lib/perf.ts).
      const probe = path.startsWith("/api/bootstrap") ? perfProbe() : null;
      const started = probe ? performance.now() : 0;

      const headers: Record<string, string> = {};
      // A JSON `Content-Type` is not a CORS-safelisted value, so attaching it to a bodyless
      // GET would make every bootstrap poll pay for a preflight round trip first.
      if (init.body !== undefined) headers["Content-Type"] = "application/json";
      Object.assign(headers, init.headers ?? {});

      // `fetch` is deliberately reached through the global at call time, not captured at module
      // load: tests replace `globalThis.fetch` to drive the error path.
      const response = await fetch(`${apiBase}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        ...(init.body === undefined
          ? {}
          : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      });

      const tag = response.headers.get("etag");
      if (tag) {
        etags.set(path, tag);
      }

      // A 304 carries no body by definition; the caller that asked the conditional question
      // treats `null` as "keep what you already have".
      if (response.status === 304) {
        return null;
      }
      if (!response.ok) {
        throw new Error(await readBridgeErrorMessage(response));
      }
      if (!probe) {
        return (await response.json()) as T;
      }

      // The bootstrap payload is megabytes-sized; `response.json()` hides whether a stall is the
      // transfer or the parse, and both land on the main thread.
      const text = await response.text();
      const netMs = performance.now() - started;
      const parsed = JSON.parse(text) as T;
      probe.mark("bootstrap.fetch", performance.now() - started, {
        netMs,
        parseMs: performance.now() - started - netMs,
        bytes: text.length,
      });
      return parsed;
    },

    async stream<T>(
      path: string,
      body: unknown,
      onEvent: (event: T) => void,
      options: BridgeStreamOptions = {},
    ): Promise<void> {
      const response = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (!response.ok || !response.body) {
        throw new Error(await readBridgeErrorMessage(response));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const emit = (line: string) => {
        try {
          onEvent(JSON.parse(line) as T);
        } catch {
          onEvent({ type: "error", message: line } as T);
        }
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
          if (line) emit(line);
        }
      }

      const tail = buffer.trim();
      if (tail) emit(tail);
    },

    fireAndForget(path: string, body: unknown): void {
      void fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => undefined);
    },
  };
}

let transport: BridgeTransport | null = null;

/** The active transport. Throws rather than inventing one, so a missing install is loud. */
export function getBridgeTransport(): BridgeTransport {
  if (!transport) {
    throw new Error("bridge transport not installed; call setBridgeTransport() before any request");
  }
  return transport;
}

/** Swap point: tests and alternate hosts install their transport here. */
export function setBridgeTransport(next: BridgeTransport | null): void {
  transport = next;
}