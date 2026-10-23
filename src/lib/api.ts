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
  ToolToggleState,
} from "../types";

/**
 * 边界 `bridge` 的渲染进程侧：这里只保留**类型**与薄封装，真正的传输在
 * `src/lib/bridge/transport.ts`（换实现 = 换 transport，调用点不动）。
 */
import {
  createHttpBridgeTransport,
  getBridgeTransport,
  setBridgeTransport,
} from "./bridge/transport.ts";
import { protocolMismatch } from "../shared/protocol/version.ts";
import { getStoragePort } from "./storage.ts";
import type { BridgeHandshake } from "../shared/protocol/bridgeEndpoints.ts";

const DEFAULT_API_BASE = "http://127.0.0.1:6474";

export interface ToolSettingsPayload {
  /** 项目未被信任时 pi 不读它的 `.pi`，项目层等于没设。 */
  projectTrusted: boolean;
  global: boolean;
  project: ToolToggleState;
  effective: boolean;
  tools: string[];
  activeTools: string[];
  globalPath?: string;
  projectPath?: string;
  agentDir?: string;
}

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
  /** 工具开关（codemode）现状：写的是 pi 自己的 defaultTools，见 server/toolSettings.mjs。 */
  toolSettings?: ToolSettingsPayload;
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
  /**
   * 边界 `bridge` 的版本声明（见 `src/shared/protocol/version.ts`）。渲染进程在接管任何状态
   * 之前先比对它：不一致就报错，而不是让被改名/删掉的字段以 `undefined` 的形式静默穿过 UI。
   */
  protocolVersion?: number;
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

// 默认传输在这里装配一次。测试或别的宿主想换实现，调 setBridgeTransport() 就行，
// 上层（features/components/app）不认识 HTTP，只认识 BridgeTransport。
setBridgeTransport(createHttpBridgeTransport(API_BASE));

export function getApiBase() {
  return getBridgeTransport().apiBase;
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
  // 遥测走 transport 的 fire-and-forget：它不会抛，也不会因为桥不在而拖垮一轮对话。
  try {
    getBridgeTransport().fireAndForget("/api/diagnostic", payload);
  } catch {
    // transport 未安装（例如纯模块单测）：诊断不该成为失败原因。
  }
}

function diagnosticConsoleEnabled(): boolean {
  try {
    return getStoragePort().read("pi-desktop.diag.console") === "1";
  } catch {
    return false;
  }
}

/**
 * Thin wrapper over the transport. Kept because ~40 call sites already speak this shape; the
 * HTTP details (status codes, ETag, NDJSON framing, the perf probe) live in the transport.
 */
export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await getBridgeTransport().request<T>(path, {
    method: init?.method,
    body: init?.body,
    headers: init?.headers as Record<string, string> | undefined,
    signal: init?.signal ?? undefined,
  })) as T;
}

/**
 * 边界 `bridge` 的握手闸门：拿到的快照自称哪个协议版本。
 *
 * 只在携带版本号的响应上调用（bootstrap / ambient）。不一致就**抛**，而不是继续用一份
 * 字段对不上的快照 —— 这才是那个字段存在的意义（见 `src/shared/protocol/version.ts`）。
 */
function assertProtocolVersion(response: { protocolVersion?: number } | null, path: string): number | undefined {
  if (!response) {
    return undefined;
  }
  const mismatch = protocolMismatch(response.protocolVersion);
  if (mismatch) {
    throw new Error(`${mismatch.message} (path: ${path})`);
  }
  return response.protocolVersion;
}

/**
 * 最便宜的一条握手：`GET /api/protocol` 不构建快照（bootstrap 是几百 KB 到 1 MB），
 * 所以在把那一大坨传过来之前就能知道对面对不对版。结果按 transport 实例缓存：
 * 同一个桥只问一次；换 transport（测试/别的宿主）会重新问。
 */
let probedTransport: unknown = null;
let probedVersion: number | undefined;

export async function probeBridgeProtocol(): Promise<BridgeHandshake> {
  const transport = getBridgeTransport();
  const handshake = await transport.request<BridgeHandshake>("/api/protocol");
  probedVersion = assertProtocolVersion(handshake, "/api/protocol");
  probedTransport = transport;
  return handshake as BridgeHandshake;
}

/** 首次握手（只走一次）：换过 transport 或还没问过时问一次。 */
async function ensureProtocolProbe(): Promise<void> {
  const transport = getBridgeTransport();
  if (transport === probedTransport) {
    return;
  }
  probedTransport = transport;
  await probeBridgeProtocol();
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
  // 先握手再搬大包：协议不对版时，不必先传完 MB 级快照再报错。
  await ensureProtocolProbe();
  const transport = getBridgeTransport();
  const etag = !options.force ? transport.lastEtag("/api/bootstrap") : undefined;
  const next = await transport.request<BootstrapResponse>("/api/bootstrap", {
    headers: etag ? { "If-None-Match": etag } : {},
  });
  assertProtocolVersion(next, "/api/bootstrap");
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
  const next = await fetchJson<AmbientBootstrap & { protocolVersion?: number }>(
    "/api/bootstrap?view=ambient",
  );
  assertProtocolVersion(next, "/api/bootstrap?view=ambient");
  return next;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  // `body` stays an object: serialisation is the transport's job, so a non-HTTP transport
  // (or a mock) never has to parse a string it did not create.
  return fetchJson<T>(path, { method: "POST", body: body as BodyInit });
}

export async function postExtensionUiResponse<T>(body: ExtensionUiResponse): Promise<T> {
  return postJson<T>("/api/extension-ui/response", body);
}

export async function streamNdjson<T = PromptStreamEvent>(
  path: string,
  body: unknown,
  onEvent: (event: T) => void,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  return getBridgeTransport().stream<T>(path, body, onEvent, { signal: options.signal });
}