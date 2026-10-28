/**
 * The empty-state shapes the app renders before (or without) a bridge snapshot.
 *
 * Extracted from `usePiDesktopApp` so the hook keeps only behaviour: these are pure
 * constructors, and `normalizeBootstrap` leans on them to fill in whatever an older or
 * partial bridge payload omits. Every `Date.now()` is taken once per call, so a
 * double-invoked reducer cannot produce two different timestamps.
 */

import type { BootstrapResponse } from "../../lib/api";
import { createId } from "../../lib/id";
import type {
  AppSnapshot,
  CapabilitiesState,
  ChatSession,
  ProjectSummary,
} from "../../types";

export function createDefaultConversation(): ChatSession {
  const now = Date.now();
  return {
    id: "local-bootstrap",
    title: "English practice",
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: createId("msg"),
        role: "assistant",
        kind: "text",
        content:
          "I am ready. Send a message and I will keep this as one continuous conversation, with gentle correction and long-context summaries when needed.",
        createdAt: now,
        status: "done",
      },
    ],
  };
}

export function createDefaultProject(): ProjectSummary {
  const now = Date.now();
  return {
    id: "local-project",
    name: "Code",
    cwd: "",
    createdAt: now,
    updatedAt: now,
    sessions: [],
    pinned: false,
    sessionPins: {},
  };
}

export function createDefaultSnapshot(): AppSnapshot {
  return {
    conversation: createDefaultConversation(),
    project: createDefaultProject(),
    modelConfig: {
      provider: "",
      model: "",
      thinkingLevel: "low",
      defaultThinkingLevel: "low",
      agentUrl: "",
      apiKeyConfigured: false,
    },
    stats: {
      turnCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 1,
      messageCount: 1,
      compactionCount: 0,
      latestCompactionSummary: "",
      contextTokens: null,
      contextWindow: undefined,
      contextPercent: null,
    },
  };
}

export function createDefaultBootstrap(): BootstrapResponse {
  const snapshot = createDefaultSnapshot();
  return {
    snapshot,
    projects: [snapshot.project],
    activeProjectId: snapshot.project.id,
    activeSessionPath: snapshot.conversation.sessionFile,
    projectTrusted: false,
    availableModels: [],
    skills: [],
    capabilities: createDefaultCapabilities(),
    server: {
      url: "",
      ready: false,
    },
    canPrompt: false,
    personalization: {
      style: "default",
      customInstructions: "",
      persona: "",
      extensionUi: "tui",
    },
  };
}

export function createDefaultCapabilities(): CapabilitiesState {
  return {
    skills: [],
    packages: [],
    extensions: [],
    mcpServers: [],
    builtinCommands: [],
    session: {
      version: 3,
      skills: [],
      enabledSkills: [],
      disabledSkills: [],
      packages: [],
      enabledPackages: [],
      disabledPackages: [],
      extensions: [],
      enabledExtensions: [],
      disabledExtensions: [],
      updatedAt: Date.now(),
    },
  };
}