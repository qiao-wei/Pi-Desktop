import type {
  AppSnapshot,
  ArchivedSessionSummary,
  CapabilitiesState,
  ChatMessagePart,
  ConversationStats,
  ExtensionUiMode,
  ModelSummary,
  ProjectSummary,
  SkillSummary,
  ThinkingLevel,
  PersonalizationSettings,
} from "../types";

const DEFAULT_API_BASE = "http://127.0.0.1:6474";

export interface BootstrapResponse {
  snapshot: AppSnapshot;
  projects: ProjectSummary[];
  /** 归档会话（跨项目）；侧栏只展示未归档的会话，归档清单归设置页。 */
  archivedSessions?: ArchivedSessionSummary[];
  activeProjectId: string;
  activeSessionPath?: string;
  availableModels: ModelSummary[];
  skills: SkillSummary[];
  capabilities: CapabilitiesState;
  server: {
    url: string;
    ready: boolean;
  };
  projectTrusted: boolean;
  canPrompt: boolean;
  sessionFile?: string;
  streamingSessionPaths?: string[];
  compactingSessionPaths?: string[];
  pendingExtensionUiRequests?: ExtensionUiRequest[];
  /** pi's queues for the active session: queued 插话 live here, not in the client. */
  pendingQueues?: { steering?: string[]; followUp?: string[]; seq?: number };
  /**
   * Only set by `POST /api/projects`: the folder already belongs to this project,
   * so the bridge selected it instead of creating a new one.
   */
  existingProject?: { id: string; name: string; cwd: string };
  personalization: PersonalizationSettings;
  error?: string;
}

export interface ExtensionWebUiAction {
  id: string;
  label: string;
  tone?: "primary" | "secondary" | "danger";
  data?: unknown;
}

export interface ExtensionWebUiField {
  name: string;
  label: string;
  type: "text" | "password" | "textarea" | "select" | "checkbox";
  value?: string | boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
  disabled?: boolean;
}

export interface ExtensionWebUiRow {
  id: string;
  title: string;
  description?: string;
  detail?: string;
  status?: "ready" | "warning" | "error" | "muted";
  fields?: ExtensionWebUiField[];
  actions?: ExtensionWebUiAction[];
}

export interface ExtensionWebUiSection {
  id: string;
  title?: string;
  description?: string;
  fields?: ExtensionWebUiField[];
  rows?: ExtensionWebUiRow[];
}

export interface ExtensionWebUiDefinition {
  title?: string;
  description?: string;
  notice?: { tone: "info" | "success" | "warning" | "error"; message: string };
  fields?: ExtensionWebUiField[];
  sections?: ExtensionWebUiSection[];
  actions?: ExtensionWebUiAction[];
  overlay?: boolean;
}

export type ExtensionUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setTitle";
      title: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_text";
      text: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "custom";
      title: string;
      lines: string[];
      /** How the host should present these lines; absent means the historical `tui` view. */
      renderMode?: ExtensionUiMode;
      overlay?: boolean;
      closed?: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "web";
      title: string;
      definition: ExtensionWebUiDefinition;
      overlay?: boolean;
      closed?: boolean;
    };

export type ExtensionUiResponse =
  | { id: string; cancelled: true }
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; input: string }
  /**
   * A batch of keystrokes replayed in order. A click on an extension panel has no protocol of its
   * own - the panel contract is keyboard-only - so the host sends the keys a keyboard user would
   * (`down,down,enter`) and the server replays them synchronously before re-rendering.
   */
  | { id: string; inputs: string[] }
  | { id: string; action: string; values?: Record<string, string | boolean>; data?: unknown };

export type StreamProcessBlock =
  | { type: "thinking"; thinking: string; streamKey?: string }
  | { type: "notice"; notice: string }
  | { type: "toolCall"; toolCallId: string; toolName: string; arguments: Record<string, unknown> };

export interface PromptStreamEvent {
  type:
    | "delta"
    | "assistant_partial"
    /** Streamed thinking text, one token at a time (`delta`). */
    | "thinking_delta"
    | "tool_call_stream_start"
    | "tool_call_stream_delta"
    | "tool_call_stream_end"
    | "queued"
    | "user_message_start"
    | "assistant_message_start"
    | "tool_execution_start"
    | "tool_execution_update"
    | "tool_execution_end"
    | "extension_ui_request"
    | "package_progress"
    | "snapshot"
    | "notice"
    | "error"
    | "done"
    | "compaction_start"
    | "compaction_end"
    /**
     * Usage re-read at pi's own granularity: every time a message settles
     * (`message_end`) or the context is rewritten (`compaction_end`). Before this
     * event existed the meter could only move once per run, with the snapshot.
     */
    | "context_usage";
  id?: string;
  method?: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | "custom" | "web";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  /**
   * pi's package-manager progress (`withProgress`): `phase` is pi's event type and `message` is
   * only present on `start`/`error` — `complete` intentionally has none.
   */
  phase?: "start" | "complete" | "error";
  action?: string;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
  lines?: string[];
  definition?: ExtensionWebUiDefinition;
  closed?: boolean;
  overlay?: boolean;
  delta?: string;
  blocks?: StreamProcessBlock[];
  /**
   * Which pi thinking block a `thinking_delta` belongs to
   * (`assistant-{assistantMessageIndex}-thinking-{contentIndex}`). Carried on the
   * delta *and* on the `assistant_partial` blocks so both address the same panel
   * instead of guessing it from text or from list position.
   */
  thinkingStreamKey?: string;
  /** `assistant_partial` at `thinking_end`: close the open thinking panels of this bubble. */
  closeThinking?: boolean;
  toolStreamId?: string;
  contentIndex?: number;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  /**
   * Raw JSON text of a tool call's arguments while it is still being produced.
   * Incremental on purpose: the parsed `args` object only exists at
   * `tool_call_stream_end`, and re-sending the cumulative object per token is what
   * used to make tool arguments appear in 120 ms lumps.
   */
  argsText?: string;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  snapshot?: BootstrapResponse;
  content?: string;
  behavior?: "steer" | "followUp";
  /**
   * Bubble identity for the transcript message an event belongs to, computed by
   * the server with `chatBubbleId(turn, role)` from `shared/chatBubbles.ts`.
   * Every event that can touch the conversation carries it, so the client never
   * has to infer placement.
   */
  bubbleId?: string;
  /** 1-based turn ordinal behind {@link bubbleId}. */
  turn?: number;
  /** pi's authoritative pending steering queue. */
  steering?: string[];
  /** pi's authoritative pending follow-up queue. */
  followUp?: string[];
  /** Monotonic per-session sequence of {@link steering}/{@link followUp}. */
  seq?: number;
  /** `queued` = the stream only acknowledged a queue insert, the run continues. */
  lifecycle?: "queued" | "run";
  reason?: "manual" | "threshold" | "overflow";
  /** `compaction_end`: the run was cancelled (stop pressed / extension refused), not a fault. */
  aborted?: boolean;
  /** `compaction_end`: pi's failure text; only present when the compaction actually failed. */
  errorMessage?: string;
  /** {@link context_usage}: tokens currently in context, `null` = not knowable yet. */
  contextTokens?: number | null;
  /** {@link context_usage}: context window of the model the number is measured against. */
  contextWindow?: number;
  /** {@link context_usage}: 0-100, `null` = unknown (e.g. right after a compaction). */
  contextPercent?: number | null;
  /** {@link context_usage}: cumulative token totals + estimated cost for the usage panel. */
  tokenUsage?: ConversationStats["tokenUsage"];
}

export interface ModelUpdateRequest {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  apiKey?: string;
  sessionPath?: string;
}

export interface ThinkingLevelUpdateRequest {
  thinkingLevel: ThinkingLevel;
  sessionPath?: string;
}

export interface PromptAttachmentInput {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: string;
  previewUrl?: string;
  sourcePath?: string;
}

export type PromptMessagePartInput = ChatMessagePart;

/**
 * 地址优先级只有一套：宿主注入值 > 构建/开发时烘进的环境值 > 默认端口。
 * 环境值在 dev 里是 `scripts/dev.mjs` 把桥公告的实际地址递过来的通道 —— 丢用它，一旦 6474 被
 * 别的进程占着（比如同时在跑正式版），窗口就会打到那个不相干的桥上，表现为“切会话奇慢”而不是报错。
 */
export function pickApiBase({
  injected = "",
  env = "",
  fallback = DEFAULT_API_BASE,
}: {
  injected?: string;
  env?: string;
  fallback?: string;
} = {}) {
  return normalizeBase(injected) || normalizeBase(env) || normalizeBase(fallback);
}

function normalizeBase(value: string) {
  return value.trim().replace(/\/$/, "");
}

function injectedApiBase() {
  // `typeof` first: a bare `window?.x` still throws when the global does not exist at all
  // (node --test, and anything that imports this module outside a browser).
  if (typeof window === "undefined") return "";
  return String((window as { __PI_DESKTOP_API_BASE__?: unknown }).__PI_DESKTOP_API_BASE__ ?? "");
}

function envApiBase() {
  return envFlag("VITE_PI_DESKTOP_API_BASE") ?? "";
}

function envApiBaseLegacy() {
  return envFlag("VITE_ENGBUDDY_API_BASE") ?? "";
}

// 基地址在模块加载时定一次，之后当常量用：宿主必须在开窗前就把地址定下来 ——
// Electron 用 preload 的 additionalArguments，Tauri 用 initialization_script，两者都在页面脚本
// 之前执行；vite dev 则由 dev.mjs 烘进 import.meta.env。所以这里不需要（也不允许）
// 每个请求重新解析或轮询等注入：晚到的注入用不上，那就把宿主侧改成“先定地址再开窗”。
const API_BASE = pickApiBase({
  injected: injectedApiBase(),
  env: envApiBase() || envApiBaseLegacy(),
});

export function getApiBase() {
  return API_BASE;
}

/**
 * `import.meta.env` only exists under Vite; `node --test` type-strips the module and
 * leaves it undefined, so go through this helper (and `process.env` as the Node
 * fallback) instead of touching `import.meta.env` directly.
 */
function envFlag(name: string): string | undefined {
  try {
    const value = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
    if (value !== undefined) {
      return value;
    }
  } catch {
    // not running under a bundler that understands import.meta.env
  }
  try {
    return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  } catch {
    return undefined;
  }
}

export function reportDiagnostic(event: string, details: Record<string, unknown> = {}) {
  // Diagnostic reporting is disabled unless explicitly enabled by the server.
  if (envFlag("VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED") !== "1") {
    return;
  }

  const payload = { event, details };
  // No per-event console output: the webview console retains every payload
  // object, and the server already writes the same records to the log file.
  // Opt in with `localStorage.setItem("pi-desktop.diag.console", "1")`.
  if (diagnosticConsoleEnabled()) {
    console.warn("[pi-desktop-diagnostic]", payload);
  }
  void fetch(`${API_BASE}/api/diagnostic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

function diagnosticConsoleEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem("pi-desktop.diag.console") === "1";
  } catch {
    return false;
  }
}

/** Last `ETag` seen per path, so a caller can revalidate without a second round trip. */
const lastEtagByPath = new Map<string, string>();

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  // Reached through the global handle: `perf.ts` imports this module, so a
  // static import here would be a cycle.
  const perf = path.startsWith("/api/bootstrap") ? globalThis.__piDesktopPerf : undefined;
  const probe = perf?.enabled ? perf : null;
  const started = probe ? performance.now() : 0;
  const base = API_BASE;
  // A JSON `Content-Type` is not a CORS-safelisted value, so attaching it to a bodyless
  // GET would make every bootstrap poll pay for a preflight round trip first.
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const tag = response.headers.get("etag");
  if (tag) {
    lastEtagByPath.set(path, tag);
  }

  // A 304 carries no body by definition; the caller that asked the conditional
  // question (`fetchBootstrap`) treats `null` as "keep what you already have".
  if (response.status === 304) {
    return null as T;
  }

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  if (!probe) {
    return (await response.json()) as T;
  }

  // The bootstrap payload is megabytes-sized; `response.json()` hides whether a
  // stall is the transfer or the parse, and both land on the main thread.
  const text = await response.text();
  const netMs = performance.now() - started;
  const parsed = JSON.parse(text) as T;
  probe.mark("bootstrap.fetch", performance.now() - started, {
    netMs,
    parseMs: performance.now() - started - netMs,
    bytes: text.length,
  });
  return parsed;
}

/**
 * `GET /api/bootstrap` for the places that poll it. The payload carries the whole
 * conversation (hundreds of KB to ~1 MB), and the client used to parse, normalise and
 * merge that every tick even when a quiet tool phase had changed nothing (~19 ms/s of
 * main thread, measured). Revalidating against the server's content tag makes an
 * unchanged answer an empty 304; `null` means "nothing moved, keep what you have".
 *
 * Pass `force` where a body is genuinely needed - first load, or a caller that reads
 * fields off the result.
 */
// Overloaded so a forced call is never treated as "maybe unchanged": without a tag
// to revalidate there is no 304 to answer with.
export async function fetchBootstrap(options: { force: true }): Promise<BootstrapResponse>;
export async function fetchBootstrap(options?: { force?: boolean }): Promise<BootstrapResponse | null>;
export async function fetchBootstrap(options: { force?: boolean } = {}): Promise<BootstrapResponse | null> {
  const etag = !options.force ? lastEtagByPath.get("/api/bootstrap") : undefined;
  const next = await fetchJson<BootstrapResponse | null>("/api/bootstrap", {
    headers: etag ? { "If-None-Match": etag } : {},
  });
  return next;
}

/**
 * `GET /api/bootstrap?view=ambient`: the snapshot minus the conversation.
 *
 * Everything here moves without the transcript moving, and none of it is carried by
 * a window's own SSE stream - pi's queues, extension approval prompts, which sessions
 * are busy, whether a stop landed. Cost is O(1) in conversation size, which is what
 * lets a watchdog ask for it every few seconds while a run is going.
 */
export interface AmbientBootstrap {
  ambient: true;
  activeSessionPath?: string;
  sessionFile?: string;
  canPrompt: boolean;
  projectTrusted: boolean;
  streamingSessionPaths?: string[];
  compactingSessionPaths?: string[];
  pendingExtensionUiRequests?: ExtensionUiRequest[];
  pendingQueues?: { steering?: string[]; followUp?: string[]; seq?: number };
}

export async function fetchAmbientBootstrap(): Promise<AmbientBootstrap> {
  // No revalidation tag: the answer is small and legitimately changes every tick.
  return fetchJson<AmbientBootstrap>("/api/bootstrap?view=ambient");
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function postExtensionUiResponse<T>(body: ExtensionUiResponse): Promise<T> {
  return postJson<T>("/api/extension-ui/response", body);
}

export async function streamNdjson(
  path: string,
  body: unknown,
  onEvent: (event: PromptStreamEvent) => void,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const response = await fetch(`${getApiBase()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(await readError(response));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (!line) {
        continue;
      }

      try {
        onEvent(JSON.parse(line) as PromptStreamEvent);
      } catch {
        onEvent({ type: "error", message: line });
      }
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      onEvent(JSON.parse(tail) as PromptStreamEvent);
    } catch {
      onEvent({ type: "error", message: tail });
    }
  }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `${response.status} ${response.statusText}`;
  }
  // 桥报错统一是 `{"error":"..."}`（或 `message`）。把整串 JSON 直接丢进红框，
  // 用户看到的是一堆引号，看不到到底哪儿不对 —— 先把人话抽出来，抽不到才原文上。
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message = typeof parsed?.error === "string" && parsed.error.trim()
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
