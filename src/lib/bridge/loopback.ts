/**
 * Boundary `bridge`, **second** implementation: in-process, no HTTP, no `fetch`, no TCP.
 *
 * Why a second implementation exists in the repo rather than in a test file: a protocol is only
 * proven by having two interchangeable implementations of it, and the interesting thing to prove here
 * is on the *upper* side - that `src/lib/api.ts` (and everything above it) never assumed HTTP. So this
 * module is a real `BridgeTransport` that speaks the same semantics as the HTTP one - JSON bodies,
 * `304 → null`, ETag revalidation, NDJSON framing with a malformed line surfacing as an error event -
 * and a test swaps it in and runs the real upper layer against it.
 *
 * The renderer half is here; the "bridge half" is injected as `dispatch`, because *that* is the part a
 * host owns:
 *
 *     // a MessagePort host (nothing about HTTP remains in the picture)
 *     const transport = createLoopbackBridgeTransport({
 *       apiBase: "loopback:",
 *       dispatch: async (message) => {
 *         port.postMessage(message);
 *         return await nextReply(port);
 *       },
 *     });
 *
 * `BridgeDispatch` deliberately takes a *serializable message* rather than a path string: over a
 * channel the request has to survive structured cloning, and keeping that boundary explicit here is
 * what stops the upper layer from relying on things only a local function call could do (functions in
 * the body, request objects, streaming the other way).
 */

import type { BridgeRequestInit, BridgeStreamOptions, BridgeTransport } from "./transport.ts";

/** One request as it crosses the channel. Plain JSON by construction (`JSON.parse` round trip). */
export interface BridgeRequestMessage {
  readonly path: string;
  readonly method: string;
  readonly body?: string;
  readonly headers: Record<string, string>;
  /** Conditional request: the caller's last known tag, when it has one. */
  readonly ifNoneMatch?: string;
}

/** One response as it comes back. `body` may be an async iterable of NDJSON chunks. */
export interface BridgeResponseMessage {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | AsyncIterable<string>;
}

/** The other half of the bridge. Implemented by a host (or a fixture in tests). */
export type BridgeDispatch = (message: BridgeRequestMessage) => Promise<BridgeResponseMessage>;

export interface LoopbackTransportOptions {
  readonly dispatch: BridgeDispatch;
  /** Reported to callers as `apiBase`; a channel has no host name, so `loopback:` by default. */
  readonly apiBase?: string;
}

/** Error text extraction that does not depend on a `Response` object. */
function messageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const text = parsed.error ?? parsed.message;
    if (typeof text === "string" && text) return text;
  } catch {
    // not JSON: fall through to the raw text, which is what an error banner should show
  }
  return body || "bridge request failed";
}

export function createLoopbackBridgeTransport(options: LoopbackTransportOptions): BridgeTransport {
  const { dispatch } = options;
  const apiBase = options.apiBase ?? "loopback:";
  const etags = new Map<string, string>();

  /**
   * Send one request, returning status/headers/body. Everything above stays identical to HTTP.
   *
   * Conditional requests are the **caller's** decision, exactly like over HTTP: `lastEtag()` is how a
   * caller reads the stored tag and `fetchBootstrap` decides when to send it (it must be able to say
   * "give me the body anyway" with `force`). An earlier version of this file attached the stored tag
   * automatically - and `force: true` started returning 304/null, i.e. the second implementation
   * disagreed with the first on a case that matters. That is what having two implementations buys.
   */
  async function send(path: string, init: BridgeRequestInit): Promise<BridgeResponseMessage> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    Object.assign(headers, init.headers ?? {});
    const ifNoneMatch = headers["If-None-Match"];

    return dispatch({
      path,
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      // A channel carries strings: the body is serialized here, exactly once, like HTTP would.
      ...(init.body === undefined
        ? {}
        : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
      headers,
      ...(ifNoneMatch ? { ifNoneMatch } : {}),
    });
  }

  async function readText(response: BridgeResponseMessage): Promise<string> {
    if (response.body === undefined) return "";
    if (typeof response.body === "string") return response.body;
    let text = "";
    for await (const chunk of response.body) text += chunk;
    return text;
  }

  return {
    apiBase,

    lastEtag(path: string): string | undefined {
      return etags.get(path);
    },

    async request<T>(path: string, init: BridgeRequestInit = {}): Promise<T | null> {
      const response = await send(path, init);
      const tag = response.headers?.etag ?? response.headers?.ETag;
      if (tag) etags.set(path, tag);
      if (response.status === 304) return null;
      const text = await readText(response);
      if (response.status < 200 || response.status >= 300) throw new Error(messageFromBody(text));
      if (!text) return null;
      return JSON.parse(text) as T;
    },

    async stream<T>(
      path: string,
      body: unknown,
      onEvent: (event: T) => void,
      streamOptions: BridgeStreamOptions = {},
    ): Promise<void> {
      void streamOptions.signal; // aborting a channel is the dispatch half's business
      const response = await send(path, { method: "POST", body });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(messageFromBody(await readText(response)));
      }

      // Same framing rules as the HTTP transport: newline-delimited, a malformed line becomes an
      // error event instead of truncating the turn silently, and a trailing partial line counts.
      const decoder = new TextDecoder();
      let buffer = "";
      const emit = (line: string) => {
        try {
          onEvent(JSON.parse(line) as T);
        } catch {
          onEvent({ type: "error", message: line } as T);
        }
      };

      const consume = (value: Uint8Array | string) => {
        buffer += typeof value === "string" ? value : decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
          if (line) emit(line);
        }
      };

      if (response.body === undefined) return;
      if (typeof response.body === "string") {
        consume(response.body);
      } else {
        for await (const chunk of response.body) consume(chunk);
      }

      const tail = buffer.trim();
      if (tail) emit(tail);
    },

    fireAndForget(path: string, body: unknown): void {
      void send(path, { method: "POST", body }).catch(() => undefined);
    },
  };
}