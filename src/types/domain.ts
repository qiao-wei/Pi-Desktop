import type { ProjectCommand } from "../shared/projectCommands.ts";

export type MessageRole = "user" | "assistant" | "system";
export type MessageKind = "text" | "audio";
/** `directory` is a path *reference* to a dropped folder, never bytes — see `src/shared/composerDrop.ts`. */
export type AttachmentKind = "image" | "file" | "directory";
export type SkillId =
  | "small-talk"
  | "gentle-correction"
  | "rephrase-naturally"
  | "roleplay";
export type Tone = "gentle" | "warm" | "encouraging";
export type QuestionStyle = "simple" | "guided" | "open";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  attachments?: ChatAttachment[];
  contentParts?: ChatMessagePart[];
  processBlocks?: MessageProcessBlock[];
  liveBlocks?: MessageLiveBlock[];
  createdAt: number;
  status?: "streaming" | "done";
  /**
   * Rendered from a local submission that the server has not confirmed yet
   * (optimistic prompt or queued 插话). Confirmed bubbles carry the id the
   * server computed for the same transcript position.
   */
  provisional?: boolean;
  /** Id of the client submission this bubble stands for, used to roll it back. */
  clientMessageId?: string;
  /**
   * This provisional user bubble stands for an entry in pi's steering/follow-up
   * queue, so a queue snapshot is authoritative about whether it still exists.
   *
   * An optimistic edit turn is `provisional` too but is *not* a queue entry: the
   * snapshot that reconciles it (the edit's rewind snapshot) must not sweep it
   * away, or its inline badges and text blink out until the run ends. See
   * `syncProvisionalQueue`.
   */
  queued?: boolean;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  previewUrl?: string;
  sourcePath?: string;
}

export type ChatMessagePart =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "attachment";
      attachmentId: string;
    }
  | {
      kind: "capability";
      capability: {
        id: string;
        kind: CapabilityKind;
        name: string;
        description: string;
        active?: boolean;
      };
    };

export type MessageProcessBlock =
  | {
      kind: "thinking";
      text: string;
      /**
       * Identity of the pi thinking block this block mirrors, computed by the
       * server as `assistant-{assistantMessageIndex}-thinking-{contentIndex}`.
       *
       * Without it a second round of thinking had to be recognised by *text* —
       * and the backward scan for "the last thinking block" walks straight over
       * the tool blocks in between, so round 2 appended itself into round 1's
       * panel above the tools. Keyed merges cannot do that.
       */
      streamKey?: string;
      /**
       * `true` while that block is the one still being produced. The reasoning
       * panel used to infer it from position ("last part in the bubble"), which
       * flipped a live thinking block to *complete* the instant a tool block was
       * appended after it — the panel stopped animating mid-thought.
       */
      open?: boolean;
    }
  | {
      kind: "notice";
      text: string;
    }
  | {
      kind: "tool";
      toolCallId: string;
      toolStreamId?: string;
      toolName: string;
      callText: string;
      resultText?: string;
      isError?: boolean;
      status?: "streaming" | "done";
    };

export type MessageLiveBlock =
  | {
      kind: "text";
      text: string;
    }
  | MessageProcessBlock;

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  projectId?: string;
  workingDirectory?: string;
  sessionFile?: string;
}

export interface ConversationStats {
  turnCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  messageCount: number;
  compactionCount: number;
  toolCallCount?: number;
  latestCompactionSummary?: string;
  contextTokens?: number | null;
  contextWindow?: number;
  contextPercent?: number | null;
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning?: number;
    total: number;
    estimatedCostUsd?: number;
  };
  lastMessageAt?: number;
}

/**
 * 扩展面板（`ctx.ui.custom()`）的呈现方式：
 * - `tui`（默认）：原样显示终端文本行，只提供键盘操作。
 * - `webui`：解析同一批文本行，把颜色/字重/链接还原成 DOM 样式，可点的行翻译成同样的按键。
 */
export type ExtensionUiMode = "tui" | "webui";

export interface PersonalizationSettings {
  style: string;
  customInstructions: string;
  persona: string;
  extensionUi: ExtensionUiMode;
}

export interface ProjectSessionSummary {
  path: string;
  id: string;
  name?: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  firstMessage: string;
  pinned?: boolean;
  /** 这条会话建在应用托管的 Git worktree 里（侧栏会话行末尾显示一枚 worktree 徽标）。 */
  inWorktree?: boolean;
}

/**
 * 一条已归档的会话。归档后它不再出现在项目的 `sessions` 里，只经
 * `BootstrapResponse.archivedSessions` 发给设置页的「归档聊天」，所以额外带上项目身份。
 */
export interface ArchivedSessionSummary extends ProjectSessionSummary {
  projectId: string;
  projectName?: string;
}

/**
 * 一条会话的托管 worktree 状态（会话头部那枚 Worktree 徽标的载荷）。
 * `isWorktree: false` 表示这条会话跑在项目主检出里，UI 不显示徽标。
 */
export interface SessionWorktreeInfo {
  isWorktree: boolean;
  path?: string;
  displayName?: string;
  /** worktree 目录是否还在（被外部删掉时 false）。 */
  exists?: boolean;
  /** 在 worktree 里新建的分支名；空串 = 还是 detached HEAD。 */
  branch?: string;
  detached?: boolean;
  changes?: { changed: number; untracked: number; ignored: number };
}

export interface ProjectSummary {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  sessionPins?: Record<string, boolean>;
  lastSessionPath?: string;
  /** 会话头部「运行」按钮左边那串可运行命令（存在 projects.json 里）。 */
  commands?: ProjectCommand[];
  /** 下拉里当前选中的命令 id；不在 `commands` 里时视为第一条。 */
  selectedCommandId?: string;
  /** 这个项目自己的 codemode 开关（读 `.pi/settings.json`，不落 projects.json）。 */
  codemode?: ToolToggleState;
  sessions: ProjectSessionSummary[];
}

/** 项目层的三态：没在这一层设过 = 继承全局。 */
export type ToolToggleState = "inherit" | "on" | "off";

/**
 * 「工具开关」现状。写的就是 pi 自己的 `defaultTools`（全局 + 项目 `.pi/settings.json`），
 * 和终端 TUI 同一个键——见 server/toolSettings.mjs。
 */
export interface ToolSettings {
  globalPath: string;
  projectPath: string;
  /** 项目未被信任时 pi 不读它的 `.pi`，项目层等于没设。 */
  projectTrusted: boolean;
  /** 全局那一层开没开。 */
  global: boolean;
  /** 当前项目那一层：inherit / on / off。 */
  project: ToolToggleState;
  /** 合并两层之后，pi 会不会把 codemode 交给模型。 */
  effective: boolean;
  tools: string[];
  /** 当前会话**实际**激活的工具；MCP 会自动加回 codemode，所以不一定等于 effective。 */
  activeTools: string[];
}

/**
 * Outcome of "新建项目", so the dialog can tell "created" apart from "that folder
 * was already a project, we opened it" and keep itself open on failure.
 */
export interface CreateProjectResult {
  ok: boolean;
  /** The folder already belongs to this project; the bridge selected it. */
  existingProject?: { id: string; name: string; cwd: string };
  error?: string;
}

export type TurnPolicy = {
  activeSkill: SkillId;
  tone: Tone;
  shouldCorrect: boolean;
  correctionBudget: 0 | 1 | 2;
  difficultyDelta: -1 | 0 | 1;
  questionStyle: QuestionStyle;
  avoid: string[];
  nextMove: string;
};

export interface SkillResult {
  reply: string;
  correction?: string[];
  topicHint?: string;
}

export interface TutorTurnContext {
  input: string;
  policy: TurnPolicy;
  recentMessages: ChatMessage[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelConfig {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  defaultThinkingLevel: ThinkingLevel;
  agentUrl: string;
  apiKeyConfigured?: boolean;
}

export interface ModelSummary {
  provider: string;
  model: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
  /** 复用 pi 的 getSupportedThinkingLevels：该模型真实支持的思考档位，菜单按它渲染。 */
  supportedThinkingLevels?: ThinkingLevel[];
  supportsImages?: boolean;
  available?: boolean;
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  disableModelInvocation: boolean;
}

export type CapabilityKind = "skill" | "package" | "extension" | "mcp";
export type CapabilitySkillSource = "builtin" | "piAgent" | "agents" | "project";

export interface CapabilitySkill {
  id: string;
  kind: "skill";
  name: string;
  description: string;
  path: string;
  source: CapabilitySkillSource;
  disableModelInvocation: boolean;
  defaultEnabled: boolean;
  pinned: boolean;
  active: boolean;
  readonly: boolean;
}

export type CapabilityPackageScope = "user" | "project";

/**
 * pi resolves a package into these four resource types (package.json `pi` manifest, or the
 * `extensions/ · skills/ · prompts/ · themes/` directory convention). Pi Desktop used to read
 * only `extensions` out of that result.
 */
export const CAPABILITY_PACKAGE_RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;
export type CapabilityPackageResourceType = (typeof CAPABILITY_PACKAGE_RESOURCE_TYPES)[number];

/** One resolved entry. `enabled` mirrors pi: a filtered settings entry switches it off. */
export interface CapabilityPackageResourceEntry {
  path: string;
  /** Path relative to the package root when the entry lives inside it, else the raw path. */
  relativePath: string;
  enabled: boolean;
}

export type CapabilityPackageResourceDetails = Record<CapabilityPackageResourceType, CapabilityPackageResourceEntry[]>;

/** Read-only preview of one resolved package file (`POST /api/capabilities/package/file`). */
export interface CapabilityPackageFilePreview {
  type: CapabilityPackageResourceType;
  enabled: boolean;
  bytes: number;
  /** A directory entry pi resolved (a manifest can point at one) — nothing to preview. */
  directory: boolean;
  content: string;
  /** NUL byte found in the head: refused rather than dumped into the viewer. */
  binary: boolean;
  /** Only the first slice is here; `bytes` is the real size. */
  truncated: boolean;
}

export interface CapabilityCommand {
  name: string;
  description?: string;
  /** pi 侧该命令注册了 getArgumentCompletions（TUI 参数补全）。 */
  hasArgumentCompletions?: boolean;
}

/** 一条包命令的参数补全候选（pi AutocompleteItem 的精简透传）。 */
export interface CapabilityCommandArgument {
  value: string;
  label: string;
  description?: string;
}

export interface CapabilityPackage {
  id: string;
  kind: "package";
  name: string;
  description: string;
  source: string;
  scope: CapabilityPackageScope;
  installedPath?: string;
  filtered: boolean;
  autoload: boolean;
  defaultEnabled: boolean;
  active: boolean;
  /** "loaded" | "failed" | "missing" | "disabled" | "not-installed" | "unknown". */
  loadStatus: string;
  /** Raw messages pi reported for this package's extensions. */
  loadErrors: string[];
  loadedTools: string[];
  /** How many extensions/skills/prompts/themes pi resolved for this package. */
  resources?: Record<CapabilityPackageResourceType, number>;
  pinned: boolean;
  commands: CapabilityCommand[];
}

export type CapabilityExtensionSource = "agent" | "project" | "settings";

export interface CapabilityExtension {
  id: string;
  kind: "extension";
  name: string;
  description: string;
  path: string;
  source: CapabilityExtensionSource;
  defaultEnabled: boolean;
  active: boolean;
  loaded?: boolean;
  pinned: boolean;
  readonly: boolean;
}

/**
 * pi 内置斜杠命令中 Pi Desktop 真能执行的那几条（目前 `/reload`）。服务端只下发实现了的，
 * 前端遇到就把 `/name` 当作命令提交，不走模型。
 */
export interface BuiltinCommand {
  name: string;
  description: string;
}

/** pi 内置 MCP 的 exposure。`codemode` 是 pi 的默认：工具只对脚本可见。 */
export const CAPABILITY_MCP_EXPOSURES = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"] as const;
export type CapabilityMcpExposure = (typeof CAPABILITY_MCP_EXPOSURES)[number];

/** 会话里 pi 真正注册的 MCP 工具（来自 `getAllTools` 的命名空间分组）。 */
export interface CapabilityMcpTool {
  name: string;
  description: string;
  /** 把服务器级/单工具覆盖算完后的最终 exposure。 */
  exposure: CapabilityMcpExposure;
  /** pi 注册时实际用的 exposure；与 `exposure` 不同说明有单工具覆盖。 */
  declaredExposure: CapabilityMcpExposure;
}

export interface CapabilityMcpServer {
  id: string;
  kind: "mcp";
  name: string;
  description: string;
  transport: "stdio" | "http";
  /** 与 packages 对齐：agent 目录的 mcp.json 是 "user"，项目 .pi/mcp.json 是 "project"。 */
  scope: "user" | "project";
  /** 定义它的 mcp.json 路径。 */
  source: string;
  exposure: CapabilityMcpExposure;
  enabled: boolean;
  defaultEnabled: boolean;
  /** 同名时项目条目覆盖了全局条目。 */
  overridesGlobal: boolean;
  active: boolean;
  toolCount: number;
  tools: CapabilityMcpTool[];
  pinned: boolean;
}

/** `POST /api/capabilities/mcp/read` 的返回：编辑器要回填的原始字段（含 env/headers）。 */
export interface CapabilityMcpDetail {
  id: string;
  name: string;
  scope: "user" | "project";
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  hasOAuth: boolean;
  exposure: CapabilityMcpExposure;
  toolExposure: Record<string, string>;
  enabled: boolean;
  timeout?: number;
  description: string;
  pinned: boolean;
}

/** `POST /api/capabilities/mcp/inspect` 的返回：显式连一次服务器拿到的工具与错误。 */
export interface CapabilityMcpInspection {
  id: string;
  name: string;
  status: "ready" | "error";
  tools: { name: string; title: string; description: string; exposure: CapabilityMcpExposure }[];
  error: string;
}

/** 导入解析出的一个服务器：给表单回填的字段 + pi 认识但不翻译的 extras。 */
export interface CapabilityMcpImportServer {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  exposure: CapabilityMcpExposure;
  toolExposure: Record<string, string>;
  enabled: boolean;
  timeout?: number;
  hasOAuth: boolean;
  description: string;
  /** 表单不翻译、保存时随 `extras` 写回的原字段（`oauth` / `auth` ...）。 */
  extras: Record<string, unknown>;
  warnings: string[];
}

/** `POST /api/capabilities/mcp/import` 的返回：只解析，不落盘。 */
export interface CapabilityMcpImportResult {
  format: string | null;
  servers: CapabilityMcpImportServer[];
  errors: string[];
  warnings: string[];
}

export interface CapabilitySessionSelection {
  version: number;
  skills: string[];
  enabledSkills?: string[];
  disabledSkills?: string[];
  packages?: string[];
  enabledPackages?: string[];
  disabledPackages?: string[];
  extensions?: string[];
  enabledExtensions?: string[];
  disabledExtensions?: string[];
  updatedAt: number;
}

export interface CapabilitiesState {
  skills: CapabilitySkill[];
  packages: CapabilityPackage[];
  extensions: CapabilityExtension[];
  mcpServers?: CapabilityMcpServer[];
  builtinCommands?: BuiltinCommand[];
  session: CapabilitySessionSelection;
}

export interface AppSnapshot {
  conversation: ChatSession;
  project: ProjectSummary;
  modelConfig: ModelConfig;
  stats: ConversationStats;
  capabilities?: CapabilitiesState;
}
