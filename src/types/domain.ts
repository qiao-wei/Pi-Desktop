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
}

/**
 * 一条已归档的会话。归档后它不再出现在项目的 `sessions` 里，只经
 * `BootstrapResponse.archivedSessions` 发给设置页的「归档聊天」，所以额外带上项目身份。
 */
export interface ArchivedSessionSummary extends ProjectSessionSummary {
  projectId: string;
  projectName?: string;
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
  sessions: ProjectSessionSummary[];
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

export type CapabilityKind = "skill" | "package" | "extension";
export type CapabilitySkillSource = "builtin" | "agent" | "project";

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

export interface CapabilityMcpServer {
  id: string;
  kind: "mcp";
  name: string;
  description: string;
  transport: "stdio" | "sse" | "http";
  defaultEnabled: boolean;
  active: boolean;
  pinned: boolean;
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
  session: CapabilitySessionSelection;
}

export interface AppSnapshot {
  conversation: ChatSession;
  project: ProjectSummary;
  modelConfig: ModelConfig;
  stats: ConversationStats;
  capabilities?: CapabilitiesState;
}
