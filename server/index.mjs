import http from "node:http";
import { EventEmitter } from "node:events";
import { appendFileSync, chmodSync, closeSync, cpSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { appendFile as appendFileAsync } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { agentRuntimePathDirs, mergePath } from "./agentEnv.mjs";
import { removeBundledShims, runtimeShimSpecs } from "./agentShimFiles.mjs";
import { createAgentShims } from "./agentShims.mjs";
import { capabilityReloadPlan, reloadRuntimeSkills, sameCapabilityIds } from "./capabilityReload.mjs";
import { canonicalPath, extensionCapabilityId, isPathInside, isSkillPathUnderRoots } from "./capabilityPathIdentity.mjs";
import { applySkillSelection, createSkillSelectionPolicy, replaceSkillSelectionPolicy, skillEnabledBySelection } from "./capabilitySkillSelection.mjs";
import { describeLoadStatus, isUnhealthyLoadStatus, summarizePackageHealth } from "./capabilityHealth.mjs";
import { absolutizeInstalledUserPackage, installTargetPath, packageSourceForPi } from "./capabilityPackageSource.mjs";
import { emptyPackageResources, findPackageResourceEntry, MAX_RESOURCE_PREVIEW_BYTES, packageProgressEvent, packageResourceDetails, resourcePreview, summarizePackageResources } from "./capabilityPackageResources.mjs";
import { openSqliteDatabase } from "./sqlite.mjs";
import { ensureSessionArchiveColumn, listArchivedSessionRows, listProjectSessionRows } from "./sessionArchive.mjs";
import { revealFolder } from "./revealFolder.mjs";
import { commitGitChanges, createGitBranch, initGitRepo, readCommitDiff, readGitInfo, renameGitBranch, switchGitBranch } from "./gitInfo.mjs";
import {
  createManagedWorktree,
  isManagedWorktreePath,
  linkProjectPiIntoWorktree,
  listManagedWorktrees,
  managedWorktreeId,
  readWorktreeChanges,
  removeManagedWorktree,
  worktreeDisplayName,
  worktreeRootFor,
} from "./gitWorktree.mjs";
import { resolveSessionWorkspaceCwd } from "./sessionWorkspace.mjs";
import { openGitFileDiff } from "./openDiff.mjs";
import { buildCommitMessagePrompt, normalizeGeneratedCommitMessage } from "./commitMessage.mjs";
import { oneShotModelError, oneShotThinkingEffort } from "./oneShotModel.mjs";
import {
  applyModelToSession,
  composerDefaultModelReference,
  isFreshSession,
  MODEL_APPLY_REASONS,
  normalizeComposerDefaults,
  silenceGlobalModelWrites,
  THINKING_LEVELS,
} from "./sessionModelPolicy.mjs";
import { StringEnum, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  DefaultPackageManager,
  main as runPiCli,
  ProjectTrustStore,
  ModelRuntime,
  SettingsManager,
  SessionManager,
  withFileMutationQueue,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  ATTACHMENT_CONTEXT_END,
  ATTACHMENT_CONTEXT_START,
  assistantThinkingBlocks,
  buildChatBubbles,
  chatBubbleId,
  countTranscriptTurns,
  createBubbleTracker,
  messageDisplayText,
  messageToText,
  parseAttachmentContext,
  parseChatBubbleId,
} from "../src/shared/chatBubbles.ts";
import { userMessageEntryIdForTurn } from "../src/shared/sessionBranch.ts";
import { deriveSessionTitle, sessionTitleMaxWords } from "../src/shared/sessionTitle.ts";
import { findProjectByFolder } from "./projectFolders.mjs";
import {
  catalogSeedFromModel,
  chatCompletionsUrl,
  listingPlan,
  prettifyModelId,
  describeConnectionFailure,
  findCustomModel,
  isProbablyKeyValue,
  listCustomModels,
  modelsListUrl,
  mergeListingRows,
  normalizeBaseUrl,
  requestModelListing,
  resolveListingApiKey,
  updateProviderSettings,
  normalizeCustomModelInput,
  normalizeCustomModelInputs,
  normalizeProviderCatalog,
  parseModelIds,
  parseModelsConfig,
  removeCustomModel,
  resolveProviderTarget,
  upsertCustomModel,
  upsertCustomModels,
} from "./customModels.mjs";
import { displayTranscript } from "./sessionTranscript.mjs";
import { corsHeaders, respondToPreflight, setCors } from "./cors.mjs";
import { parseByteRange, resolveLocalMediaPath } from "./localMedia.mjs";
import {
  bridgeUrlAnnouncement,
  bridgeUrlFor,
  isPortExplicit,
  preferredPort,
  shouldRetryWithEphemeralPort,
} from "./bridgeListen.mjs";
import { resolveProjectTrusted } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/project-trust.js";

const host = process.env.PI_DESKTOP_HOST ?? process.env.ENGBUDDY_HOST ?? "127.0.0.1";
// The bridge owns its port: prefer 6474, take any free one when that is taken. Hosts discover the
// result on stdout instead of each inventing their own port policy.
const requestedPort = preferredPort(process.env);
const portWasRequested = isPortExplicit(process.env);
let port = requestedPort;
const appCwd = process.cwd();
const serverDir = dirname(fileURLToPath(import.meta.url));
const bundledSkillsDir = process.env.PI_DESKTOP_APP_SKILLS_DIR?.trim();
const appSkillsDir = bundledSkillsDir && existsSync(bundledSkillsDir)
  ? bundledSkillsDir
  : existsSync(join(serverDir, "..", "skills"))
  ? join(serverDir, "..", "skills")
  : join(appCwd, "skills");
const appPackagesDir = process.env.PI_DESKTOP_APP_PACKAGES_DIR?.trim()
  || (existsSync(join(serverDir, "..", "packages")) ? join(serverDir, "..", "packages") : join(appCwd, "packages"));
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

// pi 的交互模式组件在无头宿主里也会碰模块级 theme 代理：/end-review 的总结加载器
// （BorderedLoader 构造函数 → keyHint → theme.fg）一碰就抛
// "Theme not initialized. Call initTheme() first."。TUI 启动时会 initTheme()，
// 桥是无头宿主，必须自己补上；enableWatcher 关掉（没有终端可监听背景色）。
try {
  initTheme(SettingsManager.create(appCwd, agentDir, { projectTrusted: false }).getTheme(), false);
} catch {
  initTheme(undefined, false);
}
const agentBinDir = join(agentDir, "bin");
const agentPythonBaseDir = join(agentDir, "python");
const agentPythonCacheDir = join(agentPythonBaseDir, "cache");
const agentNodeBaseDir = join(agentDir, "node");
const agentNodeCacheDir = join(agentDir, "npm-cache");
const agentNodeConfigFile = join(agentNodeBaseDir, "npmrc");

// The `~/.pi/agent/bin` launchers, written on every start (see agentShims.mjs).
const agentShims = createAgentShims({
  agentPythonBaseDir,
  agentPythonCacheDir,
  agentNodeBaseDir,
  agentNodeCacheDir,
  agentNodeConfigFile,
});
const agentSkillsDir = join(agentDir, "skills");
const agentSessionsDir = join(agentDir, "sessions");
const projectsFile = join(agentDir, "projects.json");
const sessionsDatabaseFile = join(agentDir, "sessions.sqlite");
const sessionsDatabaseVersion = 1;
const personalizationFile = join(agentDir, "personalization.json");
const capabilitiesFile = join(agentDir, "capabilities.json");
const authFile = join(agentDir, "auth.json");
// pi 自己的自定义模型文件：桥里的 modelRuntime 和命令行 pi 读同一份，Pi Desktop 的设置页只是它的编辑器。
const modelsJsonFile = join(agentDir, "models.json");
const projectSessionRoot = agentSessionsDir;
// 托管 worktree 的根目录：`~/.pi/agent/worktrees`。只有落在这个目录下的 cwd 才被当成
// 应用自己建的 worktree（见 `isManagedWorktreePath`），用户手写的 worktree 不受影响。
const worktreesRoot = worktreeRootFor(agentDir);
const projectAttachmentRoot = join(agentDir, "attachments");
const diagnosticLogFile = process.env.PI_DESKTOP_DIAGNOSTIC_LOG?.trim() || join(agentDir, "pi-desktop-runtime.ndjson");
// Diagnostic logging is opt-in so normal runs stay quiet.
const diagnosticsEnabled = process.env.PI_DESKTOP_DIAGNOSTICS_ENABLED === "1";
let apiBase = bridgeUrlFor(host, port);
const piDesktopCapabilitiesCustomType = "pi-desktop.capabilities";
const capabilitiesConfigVersion = 2;
const capabilitiesDefaultsFile = process.env.PI_DESKTOP_CAPABILITIES_DEFAULTS_FILE?.trim()
  || join(serverDir, "..", "capabilities.defaults.json");
const maxAttachmentCount = 10;
const maxAttachmentBytes = 25 * 1024 * 1024;
const maxAttachmentTotalBytes = 50 * 1024 * 1024;
// 目录附件的类型。客户端拖进文件夹时带的就是它（
// 见 `src/shared/attachmentKind.ts`），两边要一起改。
const directoryMimeType = "inode/directory";
const generatedTitleMaxChars = 16;
const piCliFlag = "--pi-cli";
const http429StatusPatterns = [
  /^\s*(?:http\s*)?429\b/i,
  /\bhttp(?:\/\d+(?:\.\d+)?)?\s+429\b/i,
  /\bstatus(?:\s+code)?\s*[:=]?\s*429\b/i,
  /["']status["']\s*:\s*429\b/i,
];

// npm and pip install into the agent directory (the launchers below force that
// prefix). Without their output directories on PATH an install succeeds and the
// app still cannot call the tool, which looks exactly like "not installed". This
// is the one place both shells (Electron, Tauri) and `npm run dev` share, so the
// rule lives here rather than being duplicated per shell.
function applyAgentRuntimePath() {
  const runtimeDirs = agentRuntimePathDirs({
    agentDir,
    bundledNodeBin: process.env.PI_DESKTOP_BUNDLED_NODE_BIN?.trim() || undefined,
    platform: process.platform,
  });
  // Anything we spawn (npm, pip, MCP servers, skill scripts) inherits this. Without it a stray
  // `python -c import ...` writes __pycache__ into the read-only app bundle, baking this
  // machine's paths into a shipped tree.
  process.env.PYTHONPYCACHEPREFIX = join(agentPythonCacheDir, "pycache");
  const usable = [];
  for (const dir of runtimeDirs) {
    try {
      mkdirSync(dir, { recursive: true });
      usable.push(dir);
    } catch {
      // A directory that cannot be created holds nothing either; the launchers
      // report a missing bundled runtime themselves.
    }
  }
  process.env.PATH = mergePath(usable, process.env.PATH, process.platform);
  if (diagnosticsEnabled) {
    // `ps -E` only ever shows the environment a process was exec'd with, never a
    // later mutation, so the assembled PATH has to be reported by the process
    // itself for it to be checkable on a user's machine.
    console.log(`[pi-desktop:diag] runtime PATH=${process.env.PATH ?? ""}`);
  }
}

// The pi CLI is where tools and skills actually run, and this branch exits before
// everything else, so the runtime PATH has to be assembled above it.
applyAgentRuntimePath();

const piCliArgs = process.argv.slice(2).filter((arg) => arg !== piCliFlag);
if (process.argv.includes(piCliFlag)) {
  process.env.PI_CODING_AGENT = "true";
  process.env.AI_AGENT = "pi";
  await runPiCli(piCliArgs);
  process.exit(process.exitCode ?? 0);
}

mkdirSync(agentDir, { recursive: true });
mkdirSync(agentBinDir, { recursive: true });
mkdirSync(agentPythonBaseDir, { recursive: true });
mkdirSync(agentPythonCacheDir, { recursive: true });
mkdirSync(agentNodeBaseDir, { recursive: true });
mkdirSync(agentNodeCacheDir, { recursive: true });
mkdirSync(agentSkillsDir, { recursive: true });

mkdirSync(projectSessionRoot, { recursive: true });
mkdirSync(projectAttachmentRoot, { recursive: true });

const diagnosticLines = [];
let diagnosticFlushTimer = null;
let diagnosticWriting = false;
// Terminal I/O per line was the expensive half of the old implementation: this
// process also forwards streamed tokens, so `console.warn` on every event and a
// synchronous append on the hot path added jitter that the probes then measured
// as client-side stutter.
const diagnosticToStderr = process.env.PI_DESKTOP_DIAGNOSTICS_STDERR === "1";
const DIAGNOSTIC_FLUSH_MS = 250;

function flushDiagnosticsSync() {
  if (diagnosticLines.length === 0) {
    return;
  }
  try {
    appendFileSync(diagnosticLogFile, `${diagnosticLines.join("\n")}\n`, "utf8");
    diagnosticLines.length = 0;
  } catch (error) {
    console.error(`[pi-desktop-diagnostic] failed to write ${diagnosticLogFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scheduleDiagnosticFlush() {
  if (diagnosticFlushTimer !== null) {
    return;
  }
  diagnosticFlushTimer = setTimeout(() => {
    diagnosticFlushTimer = null;
    void flushDiagnostics();
  }, DIAGNOSTIC_FLUSH_MS);
  diagnosticFlushTimer?.unref?.();
}

async function flushDiagnostics() {
  if (diagnosticWriting || diagnosticLines.length === 0) {
    return;
  }
  diagnosticWriting = true;
  const batch = `${diagnosticLines.splice(0).join("\n")}\n`;
  try {
    await appendFileAsync(diagnosticLogFile, batch, "utf8");
  } catch (error) {
    console.error(`[pi-desktop-diagnostic] failed to write ${diagnosticLogFile}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    diagnosticWriting = false;
    if (diagnosticLines.length > 0) {
      scheduleDiagnosticFlush();
    }
  }
}

function diagnosticLog(event, fields = {}) {
  if (!diagnosticsEnabled) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    event,
    ...sanitizeDiagnosticDetails(fields),
  };
  const line = JSON.stringify(entry);
  diagnosticLines.push(line);
  scheduleDiagnosticFlush();
  if (diagnosticToStderr) {
    console.warn(`[pi-desktop-diagnostic] ${line}`);
  }
}

function errorDetails(error) {
  return {
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack : undefined,
  };
}

function sessionDetails(targetRuntime) {
  const session = targetRuntime?.session;
  if (!session) {
    return {};
  }

  return {
    sessionPath: session.sessionFile,
    sessionId: session.sessionId,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    isIdle: session.isIdle,
    isRetrying: session.isRetrying,
    autoRetryEnabled: session.autoRetryEnabled,
    pendingMessageCount: session.pendingMessageCount,
    retryAttempt: session.retryAttempt,
    messageCount: Array.isArray(session.state?.messages) ? session.state.messages.length : undefined,
  };
}

function sanitizeDiagnosticDetails(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) {
    return value === undefined ? undefined : value;
  }
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeDiagnosticDetails(item, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (/api.?key|authorization|token|secret|password|attachment.?data|prompt/i.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = sanitizeDiagnosticDetails(item, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

process.on("uncaughtException", (error) => {
  diagnosticLog("process.uncaught_exception", errorDetails(error));
  console.error(error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  diagnosticLog("process.unhandled_rejection", errorDetails(reason));
});

process.on("exit", (code) => {
  diagnosticLog("process.exit", { code });
  // Buffered lines must not be lost on shutdown.
  flushDiagnosticsSync();
});

diagnosticLog("server.start", { apiBase, diagnosticLogFile, cwd: appCwd });

// See server/agentShimFiles.mjs: the writer and the cleaner share one name list on purpose.
// This has to be declared before the bootstrap below runs: those functions are called at module
// top level, so a `const` sitting after it is in its temporal dead zone and throws.
const RUNTIME_SHIM_SPECS = runtimeShimSpecs();

// Writing the launchers must never take the bridge down: without them skills lose
// node/python, but a window that cannot reach the API is a worse failure, and an
// uncaught throw here used to be silent.
try {
  if (runtimeMode()) {
    // Slim packaging: the machine's own node/python/npm/pip are what skills must reach, so the
    // launchers we wrote in a previous, bundled installation have to go. Leaving them behind is
    // worse than never writing them: `~/.pi/agent/bin` is first on PATH, so a launcher pointing
    // at a `node-runtime` this build no longer ships shadows the user's own node with exit 127.
    ensurePiShim();
    removeBundledShims({
      dir: agentBinDir,
      readFileSync,
      readlinkSync,
      rmSync,
      join,
      warn: (message) => console.error(`[pi-desktop] ${message}`),
    });
  } else {
    ensureBundledPythonShims();
  }
} catch (error) {
  console.error(
    `[pi-desktop] could not refresh ${agentBinDir} launchers: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** True when this install relies on the host's node/python instead of shipped runtimes. */
function runtimeMode() {
  return process.env.PI_DESKTOP_RUNTIME_MODE?.trim().toLowerCase() === "system";
}

function ensureBundledPythonShims() {
  const bundledPythonBin = process.env.PI_DESKTOP_BUNDLED_PYTHON_BIN?.trim();
  ensurePiShim();
  ensureBundledNodeShims();

  if (!bundledPythonBin || !existsSync(bundledPythonBin)) {
    return;
  }
  const bundledPythonHome = process.env.PI_DESKTOP_BUNDLED_PYTHON_HOME?.trim();

  const shimSpecs = RUNTIME_SHIM_SPECS.filter((shim) => shim.family === "python");

  for (const shim of shimSpecs) {
    const shimPath = join(agentBinDir, shim.name);
    if (process.platform === "win32") {
      writeFileSync(shimPath, agentShims.renderWindowsShim(bundledPythonBin, shim.kind, bundledPythonHome), "utf-8");
    } else {
      writeFileSync(shimPath, agentShims.renderPosixShim(bundledPythonBin, shim.kind, bundledPythonHome), {
        encoding: "utf-8",
        mode: 0o755,
      });
    }
  }
}

function ensureBundledNodeShims() {
  const bundledNodeBin = process.env.PI_DESKTOP_BUNDLED_NODE_BIN?.trim();
  const bundledNpmCli = process.env.PI_DESKTOP_BUNDLED_NPM_CLI?.trim();
  if (!bundledNodeBin || !bundledNpmCli || !existsSync(bundledNodeBin) || !existsSync(bundledNpmCli)) {
    return;
  }

  const shimSpecs = RUNTIME_SHIM_SPECS.filter((shim) => shim.family === "node");

  for (const shim of shimSpecs) {
    const shimPath = join(agentBinDir, shim.name);
    if (process.platform === "win32") {
      writeFileSync(shimPath, agentShims.renderWindowsNodeShim(bundledNodeBin, bundledNpmCli, shim.kind), "utf-8");
    } else {
      writeFileSync(shimPath, agentShims.renderPosixNodeShim(bundledNodeBin, bundledNpmCli, shim.kind), {
        encoding: "utf-8",
        mode: 0o755,
      });
    }
  }
}

function ensurePiShim() {
  const shimPath = join(agentBinDir, process.platform === "win32" ? "pi.cmd" : "pi");
  if (process.platform === "win32") {
    writeFileSync(shimPath, agentShims.renderWindowsPiShim(), "utf-8");
  } else {
    writeFileSync(shimPath, agentShims.renderPiShim(), {
      encoding: "utf-8",
      mode: 0o755,
    });
  }
}

function getPiCliArgs(args) {
  if (!args.includes(piCliFlag)) {
    return undefined;
  }

  return args.filter((arg) => arg !== piCliFlag);
}

// Headless stand-in for pi's Theme. Extensions receive this wherever the TUI would hand
// them a real theme (ctx.ui.custom factory args, ctx.ui.theme) and render plain text, so
// every color/weight helper just returns its input. Every Theme method must exist: a
// missing one (e.g. `bold`) throws inside the extension's factory synchronously, which
// finishes the custom dialog as `closed` before the frontend ever sees it — the command
// then fails silently (pi catches command errors and only reports them to error
// listeners). That is exactly how clicking /review used to do nothing.
const headlessUiTheme = {
  fg: (_name, text) => text,
  bg: (_name, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  inverse: (text) => text,
  strikethrough: (text) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => (str) => str,
  getBashModeBorderColor: () => (str) => str,
};

/**
 * The accent colour a panel draws its selected row with. `readRowTargets` in
 * `src/shared/terminalText.ts` reads it back to tell a cursor row from an idle expanded row
 * (both draw `▾`); `tests/extensionUiMode.test.ts` keeps the two sides in sync.
 */
const extensionUiAnsiAccent = "96";

/**
 * How extension panels (`ctx.ui.custom()`) are presented in the window; the reading side of this
 * contract lives in `src/shared/terminalText.ts`, the setting in 设置 → 个性化.
 */
const extensionUiModes = ["tui", "webui"];
const defaultExtensionUiMode = "tui";

/** ANSI codes for the colour roles extensions ask for. Unknown roles fall back to the default colour. */
const extensionUiAnsiFgCodes = {
  accent: extensionUiAnsiAccent,
  success: "92",
  error: "91",
  warning: "93",
  border: "90",
  borderAccent: extensionUiAnsiAccent,
  borderMuted: "90",
  muted: "90",
  dim: "90",
  text: "39",
  toolOutput: "37",
  toolDiffAdded: "92",
  toolDiffRemoved: "91",
  toolDiffContext: "90",
};
const extensionUiAnsiBgCodes = {
  selectedBg: "106",
  searchMatchBg: "103",
  userMessageBg: "100",
  customMessageBg: "100",
  toolPendingBg: "100",
  toolSuccessBg: "102",
  toolErrorBg: "101",
};

/**
 * The colour-preserving sibling of `headlessUiTheme`.
 *
 * `tui` presentation wants plain text (the host strips escapes anyway), but `webui`
 * presentation renders the panel in the window, where colour is what turns a wall of
 * monospace into a readable list. This theme emits real SGR sequences instead of inventing a
 * bespoke marker format: the renderer parses them with the same rules a terminal would
 * (`parseTerminalLines`), and any extension that draws with a real theme keeps working.
 */
const ansiUiTheme = {
  fg: (name, text) => `\u001b[${extensionUiAnsiFgCodes[name] ?? "39"}m${text}\u001b[39m`,
  bg: (name, text) => `\u001b[${extensionUiAnsiBgCodes[name] ?? "49"}m${text}\u001b[49m`,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
  italic: (text) => `\u001b[3m${text}\u001b[23m`,
  underline: (text) => `\u001b[4m${text}\u001b[24m`,
  inverse: (text) => `\u001b[7m${text}\u001b[27m`,
  strikethrough: (text) => `\u001b[9m${text}\u001b[29m`,
  getFgAnsi: (name) => `\u001b[${extensionUiAnsiFgCodes[name] ?? "39"}m`,
  getBgAnsi: (name) => `\u001b[${extensionUiAnsiBgCodes[name] ?? "49"}m`,
  getColorMode: () => "ansi16",
  getThinkingBorderColor: () => (str) => ansiUiTheme.fg("muted", str),
  getBashModeBorderColor: () => (str) => ansiUiTheme.fg("accent", str),
};

/** The personalization choice, resolved per call so switching it applies to the next panel. */
function extensionUiRenderMode() {
  return normalizeExtensionUiMode(personalization?.extensionUi);
}

function normalizeExtensionUiMode(value) {
  const mode = String(value ?? "").trim();
  return extensionUiModes.includes(mode) ? mode : defaultExtensionUiMode;
}

/** `webui` needs colours; `tui` keeps the historical plain-text output. */
function activeUiTheme() {
  return extensionUiRenderMode() === "webui" ? ansiUiTheme : headlessUiTheme;
}

/**
 * Turns an extension-UI response into the key sequences to replay.
 *
 * A single keystroke arrives as `input` (the original protocol). A click on a rendered panel -
 * which the panel contract cannot express as anything but keystrokes - arrives as `inputs`, a
 * batch like `[down, down, enter]`.
 */
function readKeyResponse(response) {
  if (Array.isArray(response?.inputs)) {
    const keys = response.inputs.filter((key) => typeof key === "string" && key.length > 0);
    return keys.length > 0 ? keys : undefined;
  }
  return typeof response?.input === "string" ? [response.input] : undefined;
}

function createExtensionUiBridge() {
  const listeners = new Set();
  const pendingRequests = new Map();
  const queuedEvents = [];
  const customViewportWidth = 88;

  function renderCustomRequest(request, component) {
    request.lines = component?.render?.(customViewportWidth)?.map((line) => String(line)) ?? [];
    emit(request);
  }

  function emit(event) {
    if (listeners.size === 0) {
      queuedEvents.push(event);
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    if (queuedEvents.length > 0) {
      for (const event of queuedEvents.splice(0, queuedEvents.length)) {
        listener(event);
      }
    }

    return () => {
      listeners.delete(listener);
    };
  }

  function request(method, payload, options = {}) {
    const id = randomUUID();
    const requestPayload = {
      type: "extension_ui_request",
      id,
      method,
      ...payload,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    };

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { request: requestPayload, resolve, reject });
      emit(requestPayload);
    });
  }

  async function respond(response) {
    const pending = pendingRequests.get(String(response?.id ?? ""));
    if (!pending) {
      return false;
    }

    if (pending.custom) {
      if (response?.cancelled) {
        pending.custom.finish({ cancelled: true });
        return true;
      }
      const keys = readKeyResponse(response);
      if (!keys) {
        return false;
      }
      try {
        // Replayed in order because a click is a synthetic "move the cursor there, then activate"
        // - a component may also close itself mid-sequence (enter on a terminal action), so stop
        // writing to it the moment it finishes.
        for (const data of keys) {
          pending.custom.component?.handleInput?.(data);
          if (pendingRequests.get(String(response.id)) !== pending) break;
        }
        if (pendingRequests.get(String(response.id)) === pending) {
          renderCustomRequest(pending.request, pending.custom.component);
        }
      } catch (error) {
        pending.custom.finish(undefined, error);
      }
      return true;
    }

    if (pending.web) {
      if (response?.cancelled) {
        pending.web.finish({ cancelled: true });
        return true;
      }
      if (typeof response?.action !== "string") {
        return false;
      }
      try {
        await pending.web.onAction?.({
          action: response.action,
          values: response.values && typeof response.values === "object" && !Array.isArray(response.values)
            ? response.values
            : {},
          data: response.data,
        }, pending.web.controller);
        if (pendingRequests.get(String(response.id)) === pending && !pending.web.onAction) {
          pending.web.finish({ action: response.action, values: response.values ?? {}, data: response.data });
        }
      } catch (error) {
        pending.web.controller.update({
          notice: {
            tone: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return true;
    }

    pendingRequests.delete(String(response.id));
    pending.resolve(response);
    return true;
  }

  function pendingRequestSnapshot() {
    return [...pendingRequests.values()].map((entry) => entry.request);
  }

  function clearPendingRequests() {
    for (const pending of pendingRequests.values()) {
      if (pending.custom) {
        pending.custom.finish({ cancelled: true });
      } else if (pending.web) {
        pending.web.finish({ cancelled: true });
      } else {
        pending.resolve({ cancelled: true });
      }
    }
    pendingRequests.clear();
    queuedEvents.length = 0;
  }

  function createUiContext() {
    return {
      select: async (title, options, opts) => {
        const response = await request("select", { title, options }, opts);
        if (response?.cancelled) {
          return undefined;
        }
        return typeof response?.value === "string" ? response.value : undefined;
      },
      confirm: async (title, message, opts) => {
        const response = await request("confirm", { title, message }, opts);
        if (response?.cancelled) {
          return false;
        }
        return Boolean(response?.confirmed);
      },
      input: async (title, placeholder, opts) => {
        const response = await request("input", { title, placeholder }, opts);
        if (response?.cancelled) {
          return undefined;
        }
        return typeof response?.value === "string" ? response.value : undefined;
      },
      notify: (message, type = "info") => {
        emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: type });
      },
      onTerminalInput: () => () => {},
      setStatus: (statusKey, statusText) => {
        emit({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey, statusText });
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (widgetKey, content, options) => {
        if (!Array.isArray(content)) {
          return;
        }
        emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey,
          widgetLines: content,
          widgetPlacement: options?.placement ?? "aboveEditor",
        });
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        emit({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
      },
      pasteToEditor: () => {},
      setEditorText: (text) => {
        emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text });
      },
      getEditorText: () => "",
      editor: async (title, prefill) => {
        const response = await request("editor", { title, prefill });
        if (response?.cancelled) {
          return undefined;
        }
        return typeof response?.value === "string" ? response.value : undefined;
      },
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return activeUiTheme();
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "UI not available" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      web: async (definition, onAction) => {
        const id = randomUUID();
        const requestPayload = {
          type: "extension_ui_request",
          id,
          method: "web",
          title: String(definition?.title ?? "Package interface"),
          definition: definition && typeof definition === "object" ? definition : {},
          overlay: definition?.overlay !== false,
        };

        return new Promise((resolve, reject) => {
          let finished = false;
          const finish = (value, error) => {
            if (finished) return;
            finished = true;
            pendingRequests.delete(id);
            emit({ ...pending.request, closed: true });
            if (error) reject(error);
            else resolve(value);
          };
          const controller = {
            update: (patch) => {
              if (finished || pendingRequests.get(id) !== pending) return;
              const currentDefinition = pending.request.definition ?? {};
              pending.request = {
                ...pending.request,
                definition: {
                  ...currentDefinition,
                  ...(patch && typeof patch === "object" ? patch : {}),
                },
              };
              emit(pending.request);
            },
            close: (value) => finish(value),
          };
          const pending = {
            request: requestPayload,
            resolve,
            reject,
            web: {
              onAction: typeof onAction === "function" ? onAction : undefined,
              controller,
              finish,
            },
          };
          pendingRequests.set(id, pending);
          emit(requestPayload);
        });
      },
      custom: async (factory, options) => {
        const id = randomUUID();
        // The mode is read here, not at bind time, so toggling it in 设置 → 个性化 applies to the
        // next panel without reloading the session.
        const renderMode = extensionUiRenderMode();
        const requestPayload = {
          type: "extension_ui_request",
          id,
          method: "custom",
          title: options?.title ?? "Pi extension",
          lines: [],
          renderMode,
          overlay: options?.overlay !== false,
        };

        return new Promise((resolve, reject) => {
          let finished = false;
          const pending = {
            request: requestPayload,
            resolve,
            reject,
            custom: {
              component: null,
              finish: (value, error) => {
                if (finished) return;
                finished = true;
                pendingRequests.delete(id);
                pending.custom.component?.dispose?.();
                emit({ ...requestPayload, closed: true, lines: [] });
                if (error) reject(error);
                else resolve(value);
              },
            },
          };
          pendingRequests.set(id, pending);

          const fakeTui = {
            requestRender: () => {
              if (!finished && pending.custom.component) {
                renderCustomRequest(requestPayload, pending.custom.component);
              }
            },
          };
          const fakeKeybindings = {
            matches: (data, key) => {
              if (key === "tui.select.up") return matchesKey(data, "up");
              if (key === "tui.select.down") return matchesKey(data, "down");
              if (key === "tui.select.confirm") return matchesKey(data, "enter");
              return false;
            },
            getUserBindings: () => ({}),
          };

          Promise.resolve()
            .then(() => factory(fakeTui, activeUiTheme(), fakeKeybindings, (value) => pending.custom.finish(value)))
            .then((component) => {
              if (finished) {
                component?.dispose?.();
                return;
              }
              pending.custom.component = component;
              renderCustomRequest(requestPayload, component);
            })
            .catch((error) => pending.custom.finish(undefined, error));
        });
      },
    };
  }

  function createProjectTrustContext(cwd, { hasUI = true } = {}) {
    return {
      cwd,
      mode: "rpc",
      hasUI,
      ui: {
        select: createUiContext().select,
        confirm: createUiContext().confirm,
        input: createUiContext().input,
        notify: createUiContext().notify,
      },
    };
  }

  return {
    emit,
    subscribe,
    respond,
    clearPendingRequests,
    getPendingRequests: pendingRequestSnapshot,
    createUiContext,
    createProjectTrustContext,
  };
}

function createPiDesktopCommandContextActions(runtimeRef) {
  return {
    getSystemPromptOptions: () => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        return { cwd: appCwd };
      }

      return {
        cwd: runtime.cwd,
        contextFiles: runtime.session.resourceLoader.getAgentsFiles().agentsFiles,
        skills: runtime.session.resourceLoader.getSkills().skills,
      };
    },
    waitForIdle: async () => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        return;
      }
      await runtime.session.waitForIdle();
    },
    newSession: async (options) => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        throw new Error("Runtime is not ready.");
      }
      return runtime.newSession(options);
    },
    fork: async (entryId, options) => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        throw new Error("Runtime is not ready.");
      }
      return runtime.fork(entryId, options);
    },
    navigateTree: async (targetId, options) => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        throw new Error("Runtime is not ready.");
      }
      return runtime.session.navigateTree(targetId, options);
    },
    switchSession: async (sessionPath, options) => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        throw new Error("Runtime is not ready.");
      }
      return runtime.switchSession(sessionPath, options);
    },
    reload: async () => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        throw new Error("Runtime is not ready.");
      }
      await runtime.session.reload();
    },
  };
}

async function resolveProjectTrustForRuntime({ cwd, settingsManager, trustStore, projectTrustContext, extensionsResult }) {
  return resolveProjectTrusted({
    cwd,
    trustStore,
    defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
    extensionsResult,
    // Runtime creation can happen before the bootstrap response is available.
    // Keep trust resolution non-interactive here; the HTTP endpoint below handles
    // an explicit trust decision and reloads the open runtimes afterwards.
    projectTrustContext: {
      ...projectTrustContext,
      hasUI: false,
      ui: {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        notify: () => {},
      },
    },
    onExtensionError: (message) => {
      console.error(message);
    },
  });
}

async function bindPiDesktopSessionExtensions(session, runtimeRef, uiBridge) {
  await session.bindExtensions({
    uiContext: uiBridge.createUiContext(),
    // "tui" on purpose, not "rpc". pi-core's contract is that `ctx.ui.custom()` only
    // behaves in "tui" mode; in plain "rpc" it is a headless stub. This host is not
    // headless - createExtensionUiBridge implements custom() for real (it renders the
    // TUI component to lines and forwards keystrokes), so extensions that guard
    // terminal-only overlays with `ctx.mode === "tui"` (pi-mcp-adapter >= 2.27.0's
    // canRenderPanel) would otherwise silently fall back to a text notification.
    mode: "tui",
    commandContextActions: createPiDesktopCommandContextActions(runtimeRef),
    abortHandler: () => {
      void abortSession(session, { reason: "extension_abort_handler" }).catch(() => undefined);
    },
    shutdownHandler: () => {
      session.dispose();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Extension error: ${message}`);
    },
  });
}

const hostSystemPrompt = [
  "When the conversation gets long, preserve useful facts in a compact summary and keep going naturally.",
  "Skills listed in <available_skills> are already loaded and ready to use. When a task matches a loaded skill, read that skill's SKILL.md and follow it directly.",
  "Do not call install_skill to activate, enable, reload, or verify an already loaded skill. Use install_skill only when the user explicitly asks to install, add, copy, register, or update skill files.",
  "For ordinary tasks such as searching the web, browsing pages, writing content, or analyzing files, never call install_skill just because a relevant skill name or skill path appears in context.",
  "Do not mention internal implementation details unless the user asks.",
].join("\n");

const personalizationStyles = {
  default: "Do not use a preset response style. Adapt naturally to the user's request.",
  professional: "Use a professional, rigorous, and reliable tone. Prioritize clarity and accuracy.",
  friendly: "Use a warm, friendly, approachable tone that offers calm encouragement.",
  concise: "Be direct and concise. Lead with the answer and avoid unnecessary detail.",
  imaginative: "Use an imaginative, lively style and apt analogies when they improve understanding.",
  efficient: "Use the fewest words needed while preserving the important information.",
  sharp: "Use a witty, sharp tone when appropriate, but never insult or harm anyone.",
  socratic: "Guide reasoning with useful questions that help the user reach conclusions.",
};

const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
  allowModelNetwork: false,
});

let personalization = loadPersonalization();
let projects = loadProjects();
let activeProjectId = readActiveProjectId(projects);
const sessionStore = await createSessionStore(projects);
let runtime = await createRuntime(activeProject());
const openRuntimes = new Map([[sessionRuntimeKey(runtime.session.sessionFile), runtime]]);
updateSessionStoreFromRuntime(runtime);
const activePackageCommands = new Map();
const sessionAbortPromises = new WeakMap();
let skillReloadQueue = Promise.resolve();
const server = http.createServer(async (req, res) => {
  setCors(res);

  if (respondToPreflight(req, res)) {
    return;
  }

  const url = new URL(req.url ?? "/", apiBase);
  const requestId = randomUUID();
  const clientTraceId = String(req.headers["x-pi-desktop-trace-id"] ?? "").trim() || undefined;
  const requestStartedAt = Date.now();
  const shouldTraceRequest = url.pathname === "/api/bootstrap" || url.pathname === "/api/stop" || url.pathname === "/api/prompt" || url.pathname === "/api/sessions/select";

  if (shouldTraceRequest) {
    diagnosticLog("http.request.start", {
      requestId,
      clientTraceId,
      method: req.method,
      path: url.pathname,
    });
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      // `?view=ambient` is the watchdog shape: everything that moves independently of
      // the transcript, and none of the transcript. See `buildAmbientSnapshot`.
undefined
      if (url.searchParams.get("view") === "ambient") {
        sendJson(res, 200, buildAmbientSnapshot(runtime));
        return;
      }
      diagnosticLog("bootstrap.start", { requestId, sessionPath: runtime.session.sessionFile, ...sessionDetails(runtime) });
      const snapshot = await refreshSnapshot();
      diagnosticLog("bootstrap.success", {
        requestId,
        durationMs: Date.now() - requestStartedAt,
        ...sessionDetails(runtime),
        streamingSessionPaths: snapshot.streamingSessionPaths,
        compactingSessionPaths: snapshot.compactingSessionPaths,
      });
      sendBootstrapJson(res, req, snapshot);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/diagnostic") {
      const body = await readJson(req);
      diagnosticLog("client.report", {
        requestId,
        clientEvent: String(body?.event ?? "unknown").slice(0, 120),
        details: sanitizeDiagnosticDetails(body?.details),
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      sendJson(res, 200, {
        availableModels: listAvailableModels(),
        providerIds: modelRuntime.getRegisteredProviderIds(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/capabilities") {
      sendJson(res, 200, await buildCapabilitiesSnapshot(runtime));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/default") {
      const body = await readJson(req);
      const result = await setDefaultCapability(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/pin") {
      const body = await readJson(req);
      const result = await setCapabilityPinned(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/session/skill") {
      const body = await readJson(req);
      const result = await setSessionSkillCapability(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/session/package") {
      const body = await readJson(req);
      const result = await setSessionPackageCapability(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/session/extension") {
      const body = await readJson(req);
      const result = await setSessionExtensionCapability(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/skills/import") {
      const body = await readJson(req);
      const result = await importSkillFromCapabilityPage(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/skills/delete") {
      const body = await readJson(req);
      const result = await deleteSkillFromCapabilityPage(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/install") {
      await streamCapabilityPackageAction(req, res, (body, onProgress) => installCapabilityPackage(body, onProgress));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/remove") {
      const body = await readJson(req);
      const result = await removeCapabilityPackage(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/update") {
      await streamCapabilityPackageAction(req, res, (body, onProgress) => updateCapabilityPackage(body, onProgress));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/resources") {
      const body = await readJson(req);
      const result = await readCapabilityPackageResources(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/file") {
      const body = await readJson(req);
      const result = await readCapabilityPackageFile(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/command") {
      await streamCapabilityPackageCommand(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/extension/add") {
      const body = await readJson(req);
      const result = await addCapabilityExtension(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capabilities/extension/remove") {
      const body = await readJson(req);
      const result = await removeCapabilityExtension(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/skills/content") {
      const result = readSkillContent(String(url.searchParams.get("path") ?? ""));
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/attachments") {
      sendAttachment(res, String(url.searchParams.get("path") ?? ""));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/local-media") {
      sendLocalMedia(res, String(url.searchParams.get("path") ?? ""), req.headers.range);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/skills/reload") {
      const result = await reloadPiDesktopSkills({ scope: "all" });
      sendJson(res, 200, {
        ...result,
        snapshot: await refreshSnapshot(),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/extension-ui/response") {
      const body = await readJson(req);
      const result = await respondToExtensionUiRequest(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/custom-models") {
      sendJson(res, 200, customModelsPayload());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/custom-models") {
      const body = await readJson(req);
      sendJson(res, 200, await saveCustomModel(body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/custom-models/remove") {
      const body = await readJson(req);
      sendJson(res, 200, await deleteCustomModel(body));
      return;
    }

    // 手改过 models.json 之后不用重启：重读文件 + 让 pi 的 runtime 整批重算 provider，
    // 再把新列表发回去（只读文件不管 runtime 的话，列表里的上下文/最大输出/cost 还是旧值）。
    if (req.method === "POST" && url.pathname === "/api/custom-models/reload") {
      await readJson(req);
      // 不列 provider = 全量重建：手删掉的供应商也能从 runtime 里清出去。
      await reloadCustomModelProviders([]);
      repairDefaultModelAfterRemoval();
      sendJson(res, 200, { ...customModelsPayload(), availableModels: listAvailableModels() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/model-providers") {
      sendJson(res, 200, { providers: modelProviderCatalog() });
      return;
    }

    // GET /api/model-providers/:id → 单个 provider 带本地模型列表（不联网）
    if (req.method === "GET" && url.pathname.startsWith("/api/model-providers/")) {
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length === 3) {
        const providerId = decodeURIComponent(pathParts[2]);
        const row = providerCatalogRow(providerId);
        if (!row) {
          sendJson(res, 404, { error: "Provider not found." });
          return;
        }
        sendJson(res, 200, row);
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/model-providers/discover") {
      const body = await readJson(req);
      sendJson(res, 200, await discoverProviderModels(body));
      return;
    }

    // POST /api/model-providers/:id/verify-key → 验证 API key 是否有效
    if (req.method === "POST" && url.pathname.endsWith("/verify-key")) {
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length === 4 && pathParts[1] === "model-providers" && pathParts[3] === "verify-key") {
        const providerId = decodeURIComponent(pathParts[2]);
        const body = await readJson(req);
        // 留空 = 验已存的那份（“我存的还能用吗”），填了 = 验新填的。
        const apiKey = resolveListingApiKey({ apiKey: body?.apiKey, storedKey: readStoredApiKey(providerId) });
        if (!apiKey) {
          sendJson(res, 200, { ok: false, error: "Enter an API key first." });
          return;
        }
        const row = providerCatalogRow(providerId);
        if (!row) {
          sendJson(res, 200, { ok: false, error: "Unknown provider." });
          return;
        }
        const api = row.api || row.models?.[0]?.api || "openai-completions";
        // 没端点可探（Bedrock / Vertex 这类）就别假装在验 key，说清楚它靠 pi 自己的凭证。
        if (!String(row.baseUrl ?? "").trim()) {
          sendJson(res, 200, {
            ok: false,
            api,
            models: [],
            error: "This provider is built into pi and has no endpoint to check a key against \u2014 pi signs its requests itself.",
          });
          return;
        }
        const result = await requestModelListing({ api, baseUrl: row.baseUrl, apiKey });
        sendJson(res, 200, result);
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/model-providers/update") {
      const body = await readJson(req);
      sendJson(res, 200, await updateProvider(body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/custom-models/key") {
      const body = await readJson(req);
      sendJson(res, 200, await saveProviderApiKey(body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/custom-models/test") {
      const body = await readJson(req);
      sendJson(res, 200, await testCustomModelConnection(body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/model") {
      const body = await readJson(req);
      const result = await setModelConfiguration(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/personalization") {
      const body = await readJson(req);
      const result = await setPersonalization(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thinking-level") {
      const body = await readJson(req);
      const result = await setSessionThinkingLevel(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/projects") {
      const body = await readJson(req);
      const result = await createProject(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/projects/select") {
      const body = await readJson(req);
      const result = await selectProject(String(body?.projectId ?? ""));
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/projects/trust") {
      const body = await readJson(req);
      const result = await trustProject(String(body?.projectId ?? activeProjectId));
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/projects/update") {
      const body = await readJson(req);
      const result = await updateProject(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/projects/reorder") {
      const body = await readJson(req);
      const result = await reorderProjects(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/projects/pin") {
      const body = await readJson(req);
      const result = await pinProject(String(body?.projectId ?? ""), Boolean(body?.pinned));
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/projects/remove") {
      const body = await readJson(req);
      const result = await removeProject(String(body?.projectId ?? ""));
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/projects/reveal") {
      const body = await readJson(req);
      const result = await revealProject(String(body?.projectId ?? ""));
      sendJson(res, 200, result);
      return;
    }

    // 会话头部右侧的 git 徽标：只读，`projectId` 由服务端自己的项目表解析成 cwd
    // （渲染层拿不到、也不该传任意路径）。带 `sessionPath` 时读的是会话自己的 workspace ——
    // worktree 会话的徽标必须显示 worktree 的头部状态，而不是主检出。
    if (req.method === "GET" && url.pathname === "/api/projects/git") {
      const project = findProject(String(url.searchParams.get("projectId") ?? ""));
      const sessionPath = String(url.searchParams.get("sessionPath") ?? "").trim();
      sendJson(res, 200, await readGitInfo(requestWorkspaceCwd(project, { sessionPath })));
      return;
    }

    // 「项目还没有仓库」时那个初始化按钮：只在用户点击时到达的写操作。
    if (req.method === "POST" && url.pathname === "/api/projects/git/init") {
      const body = await readJson(req);
      const project = findProject(String(body?.projectId ?? ""));
      await initGitRepo(project.cwd);
      sendJson(res, 200, await readGitInfo(project.cwd));
      return;
    }

    // 弹层里点某个分支 → 切过去（写操作）。目标分支必须是本地分支列表里的名字，
    // 由 `switchGitBranch` 自己再校验一次。带 `sessionPath` 时在会话的 worktree 里切。
    if (req.method === "POST" && url.pathname === "/api/projects/git/switch") {
      const body = await readJson(req);
      const project = findProject(String(body?.projectId ?? ""));
      const cwd = requestWorkspaceCwd(project, body);
      await switchGitBranch(cwd, String(body?.branch ?? ""));
      sendJson(res, 200, await readGitInfo(cwd));
      return;
    }

    // 「从当前分支新建分支」：名字由 UI 给（起点固定是当前 HEAD，不是参数）。名字要过
    // `createGitBranch` 的安全校验与重名校验，之后再回一份新的 git 信息。
    if (req.method === "POST" && url.pathname === "/api/projects/git/create-branch") {
      const body = await readJson(req);
      const project = findProject(String(body?.projectId ?? ""));
      const cwd = requestWorkspaceCwd(project, body);
      await createGitBranch(cwd, String(body?.name ?? ""));
      sendJson(res, 200, await readGitInfo(cwd));
      return;
    }

    // 「给当前分支改名」：只收一个新名字（旧名字就是 HEAD 所在的分支，不进参数）。名字要过
    // `renameGitBranch` 的安全校验与重名校验，之后再回一份新的 git 信息。
    if (req.method === "POST" && url.pathname === "/api/projects/git/rename-branch") {
      const body = await readJson(req);
      const project = findProject(String(body?.projectId ?? ""));
      await renameGitBranch(project.cwd, String(body?.name ?? ""));
      sendJson(res, 200, await readGitInfo(project.cwd));
      return;
    }

    // 提交（写操作）：信息 + 勾选的文件路径由 UI 给，路径必须在刚刚的 status 里存在。
    if (req.method === "POST" && url.pathname === "/api/projects/git/commit") {
      const body = await readJson(req);
      const project = findProject(String(body?.projectId ?? ""));
      const cwd = requestWorkspaceCwd(project, body);
      await commitGitChanges(cwd, { message: body?.message, paths: body?.paths });
      sendJson(res, 200, await readGitInfo(cwd));
      return;
    }

    // 「双击改动文件 → 用宿主机的 IDE 看 diff」。只读：不动工作区，只往 tmpdir 写两侧的
    // 临时文件（左侧是 HEAD 的旧内容）；路径必须在刚刚的 status 里存在。
    if (req.method === "POST" && url.pathname === "/api/projects/git/open-diff") {
      const body = await readJson(req);
      const project = findProject(String(body?.projectId ?? ""));
      sendJson(res, 200, await openGitFileDiff(project.cwd, String(body?.path ?? "")));
      return;
    }

    // 「智能生成提交信息」：用**当前会话的模型**看一遍选中改动的 diff，只返回文本。
    // 不落盘、不提交 —— 生成的内容先进输入框，用户改完再点提交。
    if (req.method === "POST" && url.pathname === "/api/projects/git/commit-message") {
      const body = await readJson(req);
      const project = findProject(String(body?.projectId ?? ""));
      const cwd = requestWorkspaceCwd(project, body);
      const context = await readCommitDiff(cwd, body?.paths);
      const model = getRuntimeForRequest(body).session.model;
      if (!isUsableModel(model)) {
        throw new Error("请先选择 provider 和 model。");
      }
      if (!modelRuntime.hasConfiguredAuth(model.provider)) {
        throw new Error(`请先配置 ${model.provider} 的 API key。`);
      }

      const { systemPrompt, userText } = buildCommitMessagePrompt({ locale: body?.locale, context });
      const response = await modelRuntime.complete(
        model,
        {
          systemPrompt,
          messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
        },
        // maxTokens 留出思考模型的 reasoning 消耗；「始终思考」型模型必须显式给档位，
        // 否则 pi-ai 发 enable_thinking:false 会被端点 400（见 server/oneShotModel.mjs）。
        { maxTokens: 1024, cacheRetention: "none", sessionId: randomUUID(), reasoningEffort: oneShotThinkingEffort(model) },
      );
      const oneShotError = oneShotModelError(response);
      if (oneShotError) {
        throw new Error(oneShotError);
      }
      const message = normalizeGeneratedCommitMessage(assistantContentText(response));
      if (!message) {
        throw new Error(
          response.stopReason === "length"
            ? "模型在输出预算内没有给出提交信息，请重试。"
            : "模型没有返回可用的提交信息，请重试。",
        );
      }

      sendJson(res, 200, { message, model: `${model.provider}/${model.id}` });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson(req);
      const result = await createProjectSession(String(body?.projectId ?? activeProjectId), body?.name, body?.worktree);
      sendJson(res, 200, result);
      return;
    }

    // worktree 徽标的数据源（只读）。不在托管 worktree 里就回 `{ isWorktree: false }`。
    if (req.method === "GET" && url.pathname === "/api/sessions/worktree") {
      const project = findProject(String(url.searchParams.get("projectId") ?? ""));
      sendJson(res, 200, await readSessionWorktreeInfo(project, String(url.searchParams.get("sessionPath") ?? "")));
      return;
    }

    // 「在这里新建分支」：把 worktree 里 detached HEAD 上的提交落到一条真分支上，
    // 之后就算 worktree 被删，提交也不会变成孤儿。
    if (req.method === "POST" && url.pathname === "/api/sessions/worktree/branch") {
      const body = await readJson(req);
      const project = findProject(String(body?.projectId ?? ""));
      const sessionPath = String(body?.sessionPath ?? "");
      const cwd = requireSessionWorktreeCwd(project, sessionPath);
      await createGitBranch(cwd, String(body?.name ?? ""));
      sendJson(res, 200, await readSessionWorktreeInfo(project, sessionPath));
      return;
    }

    // 删除 worktree 并把会话退回主检出（写操作）。返回一份完整 bootstrap，客户端整体替换。
    if (req.method === "POST" && url.pathname === "/api/sessions/worktree/remove") {
      const body = await readJson(req);
      const project = findProject(String(body?.projectId ?? ""));
      sendJson(res, 200, await removeSessionWorktree(project, String(body?.sessionPath ?? ""), body?.force));
      return;
    }

    // 「在访达中显示 worktree」：路径由服务端从会话解析，和项目的 reveal 一样不接受
    // 渲染层传任意路径。
    if (req.method === "POST" && url.pathname === "/api/sessions/worktree/reveal") {
      const body = await readJson(req);
      const project = findProject(String(body?.projectId ?? ""));
      await revealFolder(requireSessionWorktreeCwd(project, String(body?.sessionPath ?? "")));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions/select") {
      const body = await readJson(req);
      const traceId = String(body?.traceId ?? clientTraceId ?? "").trim() || undefined;
      const result = await selectProjectSession(String(body?.projectId ?? activeProjectId), String(body?.sessionPath ?? ""), requestId, traceId);
      diagnosticLog("session.select.response", {
        requestId,
        clientTraceId: traceId,
        durationMs: Date.now() - requestStartedAt,
        sessionPath: result.activeSessionPath,
        messageCount: result.snapshot?.conversation?.messages?.length,
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions/update") {
      const body = await readJson(req);
      const result = await updateProjectSession(String(body?.projectId ?? activeProjectId), String(body?.sessionPath ?? ""), body?.name);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions/pin") {
      const body = await readJson(req);
      const result = await pinProjectSession(String(body?.projectId ?? activeProjectId), String(body?.sessionPath ?? ""), Boolean(body?.pinned));
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions/archive") {
      const body = await readJson(req);
      const result = await archiveProjectSession(
        String(body?.projectId ?? activeProjectId),
        String(body?.sessionPath ?? ""),
        body?.archived !== false,
      );
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions/delete") {
      const body = await readJson(req);
      const result = await deleteProjectSession(String(body?.projectId ?? activeProjectId), String(body?.sessionPath ?? ""));
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions/delete-archived") {
      const body = await readJson(req);
      const result = await deleteArchivedSessions(body?.projectId ? String(body.projectId) : "");
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/compact") {
      const body = await readJson(req);
      const targetRuntime = getRuntimeForRequest(body);
      if (targetRuntime.session.isStreaming || targetRuntime.session.isCompacting) {
        throw new Error("Stop the running response before compacting context.");
      }
      const result = await targetRuntime.session.compact(body?.instructions?.trim() || undefined);
      sendJson(res, 200, {
        result,
        snapshot: await buildSnapshot(targetRuntime),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stop") {
      const body = await readJson(req);
      const targetRuntime = getRuntimeForRequest(body);
      const result = await stopSession(targetRuntime, {
        clearQueues: body?.clearQueues !== false,
        requestId,
      });
      diagnosticLog("http.request.success", {
        requestId,
        path: url.pathname,
        durationMs: Date.now() - requestStartedAt,
        ...sessionDetails(targetRuntime),
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/prompt") {
      await streamPrompt(req, res, requestId);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/messages/edit") {
      // 编辑重发 = 先把 pi 的分支 leaf 退回该轮之前（`navigateTree`，append-only，
      // 旧条目留在会话文件里所以用量累计不受影响），再用新内容正常 prompt。
      const body = await readJson(req);
      const ref = parseChatBubbleId(String(body?.targetMessageId ?? ""));
      if (!ref || ref.role !== "user") {
        throw new Error("targetMessageId must be a user bubble id like t3#user.");
      }
      await streamPrompt(req, res, requestId, { body, rewindTurn: ref.turn });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (shouldTraceRequest) {
      diagnosticLog("http.request.error", {
        requestId,
        method: req.method,
        path: url.pathname,
        durationMs: Date.now() - requestStartedAt,
        ...errorDetails(error),
      });
    }
    if (!res.headersSent) {
      sendJson(res, 500, { error: message, requestId: shouldTraceRequest ? requestId : undefined });
      return;
    }
    res.write(`${JSON.stringify({ type: "error", message })}\n`);
    res.end();
  }
});

function startListening(listenPort) {
  server.listen(listenPort, host, () => {
    // The OS-assigned port is only known after binding; everything downstream (URLs handed to the
    // renderer, attachment links, WebSocket origins) reads apiBase, so it must say the truth.
    const bound = server.address();
    port = typeof bound === "object" && bound ? bound.port : listenPort;
    apiBase = bridgeUrlFor(host, port);
    diagnosticLog("server.listening", { apiBase, port });
    console.log(`Pi Desktop bridge running at ${apiBase}`);
    console.log(bridgeUrlAnnouncement(apiBase));
  });
}

server.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  diagnosticLog("server.listen.error", { ...errorDetails(error), port });
  if (shouldRetryWithEphemeralPort(error, portWasRequested)) {
    console.error(`Pi Desktop bridge: port ${port} is in use; listening on any free port instead`);
    startListening(0);
    return;
  }
  console.error(`Pi Desktop bridge failed to listen on ${apiBase}: ${message}`);
  process.exit(1);
});

startListening(requestedPort);

process.on("SIGINT", () => {
  diagnosticLog("process.signal", { signal: "SIGINT" });
  sessionStore.close();
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  diagnosticLog("process.signal", { signal: "SIGTERM" });
  sessionStore.close();
  server.close(() => process.exit(0));
});

async function createRuntime(project, sessionPath, trace = {}) {
  const startedAt = Date.now();
  mkdirSync(getProjectSessionDir(project), { recursive: true });

  const settingsManager = SettingsManager.create(project.cwd, agentDir, { projectTrusted: false });
  ensureBuiltinPackages(settingsManager);
  // pi compacts once `context > contextWindow - reserveTokens`, and keeps
  // `keepRecentTokens` of the tail. The overrides exist so "watch a compaction
  // happen" is a launch flag instead of an edit to this file - raise
  // reserveTokens to trigger it earlier. Never shrink the model's
  // contextWindow for that: pi floors max_tokens at 1 once the window is full
  // and the answer comes back as a single word.
  settingsManager.applyOverrides({
    compaction: {
      enabled: true,
      reserveTokens: Number(process.env.PI_DESKTOP_COMPACTION_RESERVE_TOKENS ?? 2200),
      keepRecentTokens: Number(process.env.PI_DESKTOP_COMPACTION_KEEP_RECENT_TOKENS ?? 1400),
    },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
  });

  let sessionManager = sessionPath
    ? SessionManager.open(sessionPath, getProjectSessionDir(project))
    : SessionManager.continueRecent(project.cwd, getProjectSessionDir(project));
  // 会话头里的 cwd 已经不在了（worktree 被移除、目录被外部删掉）：pi 的 runtime 会拿
  // `sessionManager.getCwd()` 断言目录存在，不存在就抛 "Stored session working directory
  // does not exist"，于是移除 worktree 后立刻重开这条会话就失败。这里用解析出的 workspace
  // （规则见 sessionWorkspace.mjs，已退回项目目录）把会话重开一次，让它看到一个真实目录。
  // worktree 还在时 workspace 就是 worktree 路径、与会话头一致，行为不变，所以只在
  // 真的失效时才重开。
  if (sessionPath && !existsSync(sessionManager.getCwd())) {
    sessionManager = SessionManager.open(
      sessionPath,
      getProjectSessionDir(project),
      sessionWorkspaceCwd(project, sessionManager),
    );
  }
  // 会话自己的工作目录：托管 worktree 会话跑在 worktree 里，其余一律是项目目录。
  // SettingsManager / 能力清单（package、skill 目录）仍然锚在项目根 —— 那是仓库级配置，
  // 不属于某一个 worktree（Codex 的 linked worktree 也是回主检出读项目配置）。
  const workspaceCwd = sessionWorkspaceCwd(project, sessionManager);
  // worktree 会话靠一条 `<worktree>/.pi` 软链看项目的 skills / extensions / 包配置。建 worktree
  // 时会链好，这里再幂等保一次：项目 `.pi` 是 worktree 建完才出现的、软链被别的东西删过、
  // 或者 worktree 是早先版本建的，都会在这里补上。
  ensureWorktreePiLink(project, workspaceCwd, trace);
  diagnosticLog("session.switch.runtime.workspace_resolved", {
    ...trace,
    sessionPath: sessionManager.getSessionFile(),
    workspaceCwd,
    isWorktree: workspaceCwd !== project.cwd,
  });
  diagnosticLog("session.switch.runtime.session_loaded", {
    ...trace,
    sessionPath: sessionManager.getSessionFile(),
    durationMs: Date.now() - startedAt,
  });
  const uiBridge = createExtensionUiBridge();
  const runtimeRef = { current: null };
  const trustStore = new ProjectTrustStore(agentDir);
  // Resolve project trust *before* the capability inventory. pi only discovers project
  // `.pi/skills`/extensions under a trusted settings manager, and the session loader's own
  // trust pass resolves later (inside the resource loader). Running the inventory first
  // under an untrusted manager made the selection disagree with what the loader loaded.
  // Same source as the loader uses (`ProjectTrustStore` + default), so both passes align.
  const projectTrusted = await resolveProjectTrustForRuntime({
    cwd: project.cwd,
    settingsManager,
    trustStore,
    projectTrustContext: uiBridge.createProjectTrustContext(project.cwd),
  });
  settingsManager.setProjectTrusted(projectTrusted);
  const capabilityPaths = await resolveRuntimeCapabilityPaths({
    project,
    settingsManager,
    sessionManager,
  });
  diagnosticLog("session.switch.runtime.capabilities_resolved", {
    ...trace,
    sessionPath: sessionManager.getSessionFile(),
    durationMs: Date.now() - startedAt,
    extensionCount: capabilityPaths.extensionPaths.length,
    skillPathCount: capabilityPaths.skillPaths.length,
  });

  const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir: runtimeAgentDir, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
    const servicesStartedAt = Date.now();
    const services = await createAgentSessionServices({
      cwd,
      agentDir: runtimeAgentDir,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: capabilityPaths.extensionPaths,
        additionalSkillPaths: capabilityPaths.skillPaths,
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((extension) => {
            if (String(extension.path).startsWith("<inline:")) {
              return true;
            }
            const normalized = canonicalPath(extension.path);
            if (capabilityPaths.disabledPackageRoots.some((root) => isPathInside(root, normalized))) {
              return false;
            }
            if (capabilityPaths.standaloneExtensionIds.has(extensionCapabilityId(normalized))) {
              return capabilityPaths.activeExtensionIds.has(extensionCapabilityId(normalized));
            }
            return true;
          }),
        }),
        skillsOverride: (base) => {
          // pi hands us its discovered set *before* any filtering - same loader, same trust
          // state, same instant. That set is the inventory, so the capability page and the
          // session agree without a second, potentially disagreeing, discovery pass.
          const { skills, inventory } = applySkillSelection(base.skills, capabilityPaths.skillSelection, {
            isManaged: (path) => isManagedSkillPath(path, project),
            isDisabledPath: (path) => capabilityPaths.disabledPackageRoots.some((root) => isPathInside(root, canonicalPath(path))),
            onMismatch: (skill) => reportSkillInventoryMismatch(skill, project),
          });
          capabilityPaths.skillInventory = inventory;
          return { ...base, skills };
        },
        appendSystemPromptOverride: (base) => [...base, hostSystemPrompt],
        extensionFactories: [
          createPiDesktopRuntimeExtension(project, workspaceCwd),
        ],
      },
      resourceLoaderReloadOptions: {
        resolveProjectTrust: async ({ extensionsResult }) => resolveProjectTrustForRuntime({
          cwd,
          settingsManager,
          trustStore,
          projectTrustContext: uiBridge.createProjectTrustContext(cwd),
          extensionsResult,
        }),
      },
    });
    diagnosticLog("session.switch.runtime.services_ready", {
      ...trace,
      sessionPath: runtimeSessionManager.getSessionFile(),
      durationMs: Date.now() - servicesStartedAt,
    });

    // 新任务的起点按项目记（projects.json 的 composerDefaults）：只有「还没提交过消息」的新会话
    // 才从项目记录里取模型/等级；历史会话照旧由 pi 从会话文件自己的 model_change 恢复。没记过的
    // 项目传 undefined，让 pi 走它自己的兜底（全局 settings 默认 / 列表第一项）。
    const freshSession = isFreshSession(runtimeSessionManager);
    const storedDefaults = freshSession ? normalizeComposerDefaults(project.composerDefaults) : undefined;
    // 项目记录可能只有等级（用户只改过等级、还没换过模型）：这时候别拿空 provider/model 去
    // 查模型，让 pi 继续用它的全局默认模型，只把等级带上。
    const storedModelRef = composerDefaultModelReference(storedDefaults);
    const storedModel = storedModelRef ? resolveModel(storedModelRef.provider, storedModelRef.model) : undefined;
    const startingModel =
      storedModel && isUsableModel(storedModel) && services.modelRuntime.hasConfiguredAuth(storedModel.provider)
        ? storedModel
        : undefined;

    const sessionStartedAt = Date.now();
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: runtimeSessionManager,
      sessionStartEvent,
      customTools: createPiDesktopSkillTools(project, services.resourceLoader),
      model: startingModel,
      thinkingLevel: storedDefaults?.thinkingLevel,
    });
    diagnosticLog("session.switch.runtime.session_ready", {
      ...trace,
      sessionPath: runtimeSessionManager.getSessionFile(),
      durationMs: Date.now() - sessionStartedAt,
    });

    const session = created.session;
    session.setSteeringMode("all");
    allowHttp429Retry(session);
    await ensureModelSelection(session, services.settingsManager);
    return {
      session,
      services,
      diagnostics: services.diagnostics,
      modelFallbackMessage: created.modelFallbackMessage,
    };
  }, {
    cwd: workspaceCwd,
    agentDir,
    sessionManager,
    sessionStartEvent: { type: "session_start", reason: "startup" },
  });
  diagnosticLog("session.switch.runtime.agent_created", {
    ...trace,
    sessionPath: sessionManager.getSessionFile(),
    durationMs: Date.now() - startedAt,
  });

  runtimeRef.current = runtime;
  await bindPiDesktopSessionExtensions(runtime.session, runtimeRef, uiBridge);
  runtime.setRebindSession(async (session) => {
    await bindPiDesktopSessionExtensions(session, runtimeRef, uiBridge);
  });
  runtime.setBeforeSessionInvalidate(() => {
    uiBridge.clearPendingRequests();
  });

  const targetRuntime = {
    projectId: project.id,
    runtime,
    uiBridge,
    // 会话的工作目录（worktree 会话就是 worktree 路径）。所有“这台会话现在在哪”的
    // 判断都读这里，而不是再回到 project.cwd。
    workspaceCwd,
    get session() {
      return runtime.session;
    },
    get settingsManager() {
      return runtime.services.settingsManager;
    },
    get resourceLoader() {
      return runtime.services.resourceLoader;
    },
    capabilityPaths,
  };
  // Project extensions can vote on trust through pi's `project_trust` event, which only
  // runs during the loader's own reload. If that pass disagreed with the trust we used to
  // build the inventory, re-align once and let pi re-run its skill pass.
  if (targetRuntime.settingsManager.isProjectTrusted() !== projectTrusted) {
    await refreshRuntimeCapabilityPaths(targetRuntime);
    reloadRuntimeSkills(targetRuntime);
  }
  // createAgentSessionServices already loaded the resource loader with these
  // session-specific paths; reloading here would scan every capability twice.
  diagnosticLog("session.switch.runtime.ready", {
    ...trace,
    sessionPath: targetRuntime.session.sessionFile,
    durationMs: Date.now() - startedAt,
  });
  return targetRuntime;
}

function ensureBuiltinPackages(settingsManager) {
  const builtinPackages = discoverBuiltinPackagePaths();
  if (!builtinPackages.length) {
    return;
  }

  const packages = [...(settingsManager.getGlobalSettings().packages ?? [])];
  const configuredPaths = new Set(packages
    .map((entry) => typeof entry === "string" ? entry : entry?.source)
    .filter(Boolean)
    .map((source) => resolve(agentDir, source)));
  const missing = builtinPackages.filter((path) => !configuredPaths.has(resolve(path)));
  if (!missing.length) {
    return;
  }

  settingsManager.setPackages([
    ...packages,
    ...missing.map((source) => ({ source, autoload: true })),
  ]);
}

function discoverBuiltinPackagePaths() {
  if (!existsSync(appPackagesDir)) {
    return [];
  }

  return readdirSync(appPackagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(appPackagesDir, entry.name))
    .filter((packagePath) => existsSync(join(packagePath, "package.json")));
}

async function resolveRuntimeCapabilityPaths({ project, settingsManager, sessionManager }) {
  const packages = configuredPackagesForRuntime({
    projectId: project.id,
    settingsManager,
  });
  const allSkills = await discoverAllProjectSkills(project, settingsManager);
  const config = ensureCapabilitiesConfigInitialized(managedSkills(allSkills, project));
  const selection = activeSessionCapabilitySelection(sessionManager, allSkills, config, {
    projectId: project.id,
    settingsManager,
  });
  const selectedPackageIds = new Set(selection.packages ?? []);
  const selectedExtensionIds = new Set(selection.extensions ?? []);
  const defaultPackageIds = new Set(
    packages.filter((pkg) => packageDefaultEnabled(config, pkg)).map(packageCapabilityId),
  );
  const extensionPaths = [];
  const skillPaths = [];

  for (const pkg of packages) {
    const packageId = packageCapabilityId(pkg);
    if (!selectedPackageIds.has(packageId) || defaultPackageIds.has(packageId)) {
      continue;
    }
    const resolved = await resolvePackageResources({ project, settingsManager, pkg });
    extensionPaths.push(...enabledResourcePaths(resolved, "extensions"));
    skillPaths.push(...enabledResourcePaths(resolved, "skills"));
  }

  const standaloneExtensionPaths = discoverStandaloneExtensionPaths(project, settingsManager);
  const defaultExtensionIds = new Set(
    standaloneExtensionPaths
      .map(extensionCapabilityId)
      .filter((id) => extensionDefaultEnabled(config, id)),
  );
  for (const path of standaloneExtensionPaths) {
    const extensionId = extensionCapabilityId(path);
    if (selectedExtensionIds.has(extensionId) && !defaultExtensionIds.has(extensionId)) {
      extensionPaths.push(path);
    }
  }

  return {
    extensionPaths: [...new Set(extensionPaths.map((path) => canonicalPath(path)))],
    skillPaths: [appSkillsDir, ...new Set(skillPaths.map((path) => canonicalPath(path)))],
    disabledPackageRoots: packages
      .filter((pkg) => !selectedPackageIds.has(packageCapabilityId(pkg)))
      .map((pkg) => pkg.installedPath)
      .filter(Boolean)
      .map((path) => canonicalPath(path)),
    standaloneExtensionIds: new Set(standaloneExtensionPaths.map(extensionCapabilityId)),
    activeExtensionIds: new Set([...selectedExtensionIds]),
    // Kept for the reload plan / message-part decoration; the loader no longer reads it.
    activeSkillIds: new Set(selection.skills ?? []),
    // Live skill selection: the loader's `skillsOverride` decides per skill from this
    // policy, so the decision can never be stale relative to what pi discovered.
    skillSelection: createSkillSelectionPolicy({
      selection,
      config,
      inventorySkills: allSkills,
      isManaged: (path) => isManagedSkillPath(path, project),
    }),
    // The full set pi's loader discovers, captured from its own pass (seeded with the
    // pre-resolve so the page has data even before the loader runs).
    skillInventory: allSkills,
  };
}

async function refreshRuntimeCapabilityPaths(targetRuntime) {
  const project = findProject(targetRuntime.projectId);
  const next = await resolveRuntimeCapabilityPaths({
    project,
    settingsManager: targetRuntime.settingsManager,
    sessionManager: targetRuntime.session.sessionManager,
  });
  const current = targetRuntime.capabilityPaths;
  current.extensionPaths.splice(0, current.extensionPaths.length, ...next.extensionPaths);
  current.skillPaths.splice(0, current.skillPaths.length, ...next.skillPaths);
  current.disabledPackageRoots = next.disabledPackageRoots;
  current.standaloneExtensionIds = next.standaloneExtensionIds;
  current.activeExtensionIds = next.activeExtensionIds;
  current.activeSkillIds = next.activeSkillIds;
  replaceSkillSelectionPolicy(current.skillSelection, next.skillSelection);
  current.skillInventory = next.skillInventory;
  return current;
}

function allowHttp429Retry(session) {
  if (typeof session._isRetryableError !== "function") {
    return;
  }

  const defaultIsRetryableError = session._isRetryableError.bind(session);
  session._isRetryableError = (message) => {
    if (defaultIsRetryableError(message)) {
      return true;
    }

    if (message?.stopReason !== "error") {
      return false;
    }

    return isHttp429ProviderError(message.errorMessage);
  };
}

function isHttp429ProviderError(errorMessage) {
  const message = String(errorMessage ?? "");
  return http429StatusPatterns.some((pattern) => pattern.test(message));
}

async function replaceRuntime(project, sessionPath, trace = {}) {
  const startedAt = Date.now();
  const requestedSessionPath = sessionPath ? resolve(sessionPath) : undefined;
  // 归档会话不是可打开的会话：项目的 lastSessionPath 可能还指着刚被归档的那条，
  // 不拦的话重启/切项目会打开一个侧栏里看不见的会话。退回到列表里最新的未归档会话。
  const resolvedSessionPath =
    requestedSessionPath && sessionStore.isArchived(project.id, requestedSessionPath)
      ? listProjectSessions(project)[0]?.path
      : requestedSessionPath;
  let nextRuntime = resolvedSessionPath ? openRuntimes.get(resolvedSessionPath) : undefined;
  diagnosticLog("session.switch.runtime.start", {
    ...trace,
    projectId: project.id,
    sessionPath: resolvedSessionPath,
    reused: Boolean(nextRuntime),
  });
  if (!nextRuntime) {
    nextRuntime = await createRuntime(project, resolvedSessionPath, trace);
    openRuntimes.set(sessionRuntimeKey(nextRuntime.session.sessionFile), nextRuntime);
  }

  runtime = nextRuntime;
  activeProjectId = project.id;
  touchProject(project.id, { lastSessionPath: runtime.session.sessionFile });
  const snapshot = await refreshSnapshot({ traceSessionSwitch: true });
  diagnosticLog("session.switch.runtime.response_ready", {
    projectId: project.id,
    sessionPath: runtime.session.sessionFile,
    durationMs: Date.now() - startedAt,
    messageCount: snapshot.snapshot?.conversation?.messages?.length,
  });
  return snapshot;
}

function sessionRuntimeKey(sessionPath) {
  if (!sessionPath) {
    throw new Error("Session file is required.");
  }

  return resolve(sessionPath);
}

function getRuntimeForRequest(body) {
  const requestedSessionPath = String(body?.sessionPath ?? "").trim();
  if (!requestedSessionPath) {
    return runtime;
  }

  const targetRuntime = openRuntimes.get(sessionRuntimeKey(requestedSessionPath));
  if (!targetRuntime) {
    throw new Error("Session is not open.");
  }

  return targetRuntime;
}

function isSessionBusy(session) {
  return session.isStreaming || session.isCompacting || session.pendingMessageCount > 0;
}

function disposeRuntime(sessionPath) {
  const targetRuntime = openRuntimes.get(sessionRuntimeKey(sessionPath));
  if (!targetRuntime) {
    return;
  }

  if (isSessionBusy(targetRuntime.session)) {
    throw new Error("The selected session is busy.");
  }

  targetRuntime.unsubscribe?.();
  targetRuntime.session.dispose();
  openRuntimes.delete(sessionRuntimeKey(sessionPath));
}

function disposeProjectRuntimes(projectId) {
  const projectRuntimes = [...openRuntimes.values()].filter((candidate) => candidate.projectId === projectId);
  if (projectRuntimes.some((candidate) => isSessionBusy(candidate.session))) {
    throw new Error("Stop the project's running sessions before changing or removing it.");
  }

  for (const targetRuntime of projectRuntimes) {
    targetRuntime.unsubscribe?.();
    targetRuntime.session.dispose();
    openRuntimes.delete(sessionRuntimeKey(targetRuntime.session.sessionFile));
  }
}

/**
 * 打开会话时给它挑一个能用的模型：pi 已经会按会话文件里自己那条 `model_change` 恢复，
 * 这里只负责「恢复出来的（或压根没有的）模型现在用不了」的情况。
 *
 * 一律按 `session-open` 记账：这次应用只归这条会话，不许改写「新任务从哪个模型开始」。
 * 那条默认值只有用户在输入框里切换才算数（见 `setModelConfiguration`）。
 */
async function ensureModelSelection(session, settingsManager) {
  if (session.model) {
    if (isUsableModel(session.model) && modelRuntime.hasConfiguredAuth(session.model.provider)) {
      return;
    }
    await applyModelToSession({
      session,
      settingsManager,
      model: usableDefaultModel(settingsManager) ?? defaultComposerModel(),
      reason: MODEL_APPLY_REASONS.sessionOpen,
    }).catch(() => undefined);
    return;
  }

  const defaults = usableDefaultModel(settingsManager);
  if (defaults) {
    try {
      await applyModelToSession({ session, settingsManager, model: defaults, reason: MODEL_APPLY_REASONS.sessionOpen });
      return;
    } catch {
      // Fall through to leave the session unconfigured.
    }
  }

  // 没记住任何选择：用输入框下拉列表的第一项（自定义模型优先）。
  const available = defaultComposerModel();
  if (available) {
    try {
      await applyModelToSession({ session, settingsManager, model: available, reason: MODEL_APPLY_REASONS.sessionOpen });
    } catch {
      // Leave unconfigured until the user supplies a provider/model/key pair.
    }
  }
}

function findDefaultModel(settingsManager) {
  const providerId = settingsManager.getDefaultProvider();
  const modelId = settingsManager.getDefaultModel();
  if (!providerId || !modelId) {
    return undefined;
  }

  const candidate = modelRuntime.getModel(providerId, modelId);
  return candidate ?? undefined;
}

/**
 * 记住的默认模型现在还能不能真拿来对话。
 *
 * 「还认识」不等于「能用」：删掉内置供应商的最后一个模型时，models.json 的行没了、
 * auth.json 的 key 也跟着清了，但模型本身仍在 pi 的目录里 —— 这时候 `setModel()` 会抛
 * "No API key"，得当成没有默认值处理。
 */
function usableDefaultModel(settingsManager) {
  const model = findDefaultModel(settingsManager);
  return model && isUsableModel(model) && modelRuntime.hasConfiguredAuth(model.provider) ? model : undefined;
}

function listAvailableModels() {
  const available = new Set(
    modelRuntime
      .getAvailableSnapshot()
      .filter((model) => !model.provider.startsWith("qwen-token-plan"))
      .map((model) => `${model.provider}/${model.id}`),
  );
  return modelRuntime
    .getModels()
    .filter((model) => !model.provider.startsWith("qwen-token-plan"))
    .map((model) => describeModel(model, available.has(`${model.provider}/${model.id}`)));
}

function describeModel(model, available = true) {
  return {
    provider: model.provider,
    model: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    // 复用 pi 的按模型档位能力：composer 菜单显示几档，完全由模型的 thinkingLevelMap 决定
    // （null / 未声明 xhigh·max = 不存在；off..high 未声明 = pi 默认放行）。
    // 不再写“没映射表就按 off 处理”—— pi 对开了推理但没写映射表的模型给的是 off..high，
    // 前端按 off 渲染会让菜单与真实能力脱节。
    supportedThinkingLevels: getSupportedThinkingLevels(model),
    supportsImages: model.input?.includes("image") ?? false,
    available,
  };
}

function basePiDesktopResourceLoaderOptions(project, settingsManager) {
  return {
    cwd: project.cwd,
    agentDir,
    settingsManager,
    additionalSkillPaths: [
      appSkillsDir,
    ],
    appendSystemPromptOverride: (base) => [...base, hostSystemPrompt],
  };
}

function createPiDesktopRuntimeExtension(project, workspaceCwd = project.cwd) {
  return {
    name: "pi-desktop-runtime",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        return {
          systemPrompt: [
            event.systemPrompt,
            projectContextInstruction(project, workspaceCwd),
            personalizationInstruction(),
          ].filter(Boolean).join("\n\n"),
        };
      });
    },
  };
}

function createMcpToolsStatus(status = "idle", message = "") {
  return {
    status,
    message,
    totalTools: 0,
    enabledTools: 0,
    errorCount: 0,
    servers: [],
    tools: [],
    updatedAt: Date.now(),
    selectionHash: "",
  };
}

async function inspectMcpServerTools(targetRuntime, server) {
  let client;
  let transport;
  try {
    ({ client, transport } = await connectMcpInspector(targetRuntime, server));
    const result = await withMcpProbeTimeout(client.listTools(), `${server.name} listTools`);
    const rawTools = Array.isArray(result?.tools) ? result.tools : [];
    const tools = rawTools
      .filter((tool) => tool?.name)
      .map((tool) => {
        const originalName = String(tool.name);
        const name = formatMcpToolName(originalName, server.id);
        return {
          name,
          originalName,
          title: String(tool.title ?? originalName),
          description: String(tool.description ?? ""),
          enabled: isMcpToolEnabled(server, name, originalName),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      id: server.id,
      name: server.name,
      status: "ready",
      toolCount: tools.length,
      enabledToolCount: tools.filter((tool) => tool.enabled).length,
      tools,
    };
  } catch (error) {
    return {
      id: server.id,
      name: server.name,
      status: "error",
      toolCount: 0,
      enabledToolCount: 0,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await closeMcpInspector(client, transport);
  }
}

async function connectMcpInspector(targetRuntime, server) {
  if (server.transport === "stdio") {
    return connectMcpInspectorWithTransport(server, new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: normalizeMcpInspectorEnv({ ...process.env, ...server.env }),
      cwd: resolveMcpServerCwd(targetRuntime, server),
      stderr: "pipe",
    }));
  }

  const url = new URL(server.url);
  const requestInit = Object.keys(server.headers).length ? { headers: server.headers } : undefined;
  if (server.transport === "sse") {
    return connectMcpInspectorWithTransport(server, new SSEClientTransport(url, {
      eventSourceInit: requestInit,
      requestInit,
    }));
  }

  try {
    return await connectMcpInspectorWithTransport(server, new StreamableHTTPClientTransport(url, { requestInit }));
  } catch (error) {
    if (String(error instanceof Error ? error.message : error).toLowerCase().includes("unauthorized")) {
      throw error;
    }
    return connectMcpInspectorWithTransport(server, new SSEClientTransport(url, {
      eventSourceInit: requestInit,
      requestInit,
    }));
  }
}

async function connectMcpInspectorWithTransport(server, transport) {
  const client = new Client({ name: "pi-desktop-mcp-inspector", version: "0.1.0" });
  try {
    await withMcpProbeTimeout(client.connect(transport, { timeout: mcpToolProbeTimeoutMs }), `${server.name} connect`);
    return { client, transport };
  } catch (error) {
    await closeMcpInspector(client, transport);
    throw error;
  }
}

function resolveMcpServerCwd(targetRuntime, server) {
  if (!server.cwd) {
    return findProject(targetRuntime.projectId).cwd;
  }
  return isAbsolute(server.cwd) ? server.cwd : resolve(findProject(targetRuntime.projectId).cwd, server.cwd);
}

function normalizeMcpInspectorEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
}

async function closeMcpInspector(client, transport) {
  await Promise.allSettled([
    client?.close?.(),
    transport?.close?.(),
  ]);
}

async function withMcpProbeTimeout(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${mcpToolProbeTimeoutMs}ms`)), mcpToolProbeTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function formatMcpToolName(toolName, serverId) {
  const serverPrefix = String(serverId).replace(/[^A-Za-z0-9_-]/g, "_") || "mcp";
  const sanitizedTool = String(toolName).replace(/\./g, "_");
  return `${serverPrefix}_${sanitizedTool}`;
}

function isMcpToolEnabled(server, name, originalName) {
  const candidates = [name, originalName].filter(Boolean);
  const included = server.includeTools.length === 0 || selectorListMatches(server.includeTools, candidates);
  const excluded = selectorListMatches(server.excludeTools, candidates);
  return included && !excluded;
}

function selectorListMatches(selectors, candidates) {
  return selectors.some((selector) => candidates.some((candidate) => toolSelectorMatches(selector, candidate)));
}

function toolSelectorMatches(selector, value) {
  if (selector === value) {
    return true;
  }
  const escaped = String(selector).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(String(value));
}

function createEmptyCapabilitiesConfig() {
  return {
    version: capabilitiesConfigVersion,
    skills: {},
    packages: {},
    extensions: {},
    mcpServers: {},
  };
}

function readCapabilitiesConfig() {
  if (!existsSync(capabilitiesFile)) {
    return createEmptyCapabilitiesConfig();
  }

  try {
    return normalizeCapabilitiesConfig(JSON.parse(readFileSync(capabilitiesFile, "utf8")));
  } catch {
    return createEmptyCapabilitiesConfig();
  }
}

function ensureCapabilitiesConfigInitialized(allSkills) {
  const existed = existsSync(capabilitiesFile);
  const config = readCapabilitiesConfig();
  const defaults = readCapabilitiesDefaults();
  let changed = false;

  changed = applyMissingDefaultEnabledSkillNames(config, allSkills, defaults.defaultEnabledSkills) || changed;

  if (!existed || config.version !== capabilitiesConfigVersion) {
    config.version = capabilitiesConfigVersion;
    changed = true;
  }

  return changed ? writeCapabilitiesConfig(config) : config;
}

function readCapabilitiesDefaults() {
  if (!existsSync(capabilitiesDefaultsFile)) {
    return createEmptyCapabilitiesDefaults();
  }

  try {
    return normalizeCapabilitiesDefaults(JSON.parse(readFileSync(capabilitiesDefaultsFile, "utf8")));
  } catch {
    return createEmptyCapabilitiesDefaults();
  }
}

function createEmptyCapabilitiesDefaults() {
  return {
    version: 1,
    defaultEnabledSkills: [],
  };
}

function normalizeCapabilitiesDefaults(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: Number(source.version ?? 1),
    defaultEnabledSkills: normalizeStringArray(source.defaultEnabledSkills),
  };
}

function applyMissingDefaultEnabledSkillNames(config, allSkills, skillNames) {
  const names = new Set(normalizeStringArray(skillNames));
  let changed = false;
  for (const skill of allSkills) {
    if (!names.has(skill.name)) {
      continue;
    }
    const id = skillCapabilityId(skill);
    if (config.skills[id]) {
      continue;
    }
    config.skills[id] = {
      defaultEnabled: true,
      pinned: false,
    };
    changed = true;
  }
  return changed;
}

function writeCapabilitiesConfig(config) {
  const normalized = normalizeCapabilitiesConfig(config);
  mkdirSync(dirname(capabilitiesFile), { recursive: true });
  writeFileSync(capabilitiesFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function normalizeCapabilitiesConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const skills = {};
  for (const [id, value] of Object.entries(source.skills && typeof source.skills === "object" ? source.skills : {})) {
    const normalizedId = normalizeCapabilityId(id);
    if (!normalizedId) {
      continue;
    }
    const item = value && typeof value === "object" ? value : {};
    skills[normalizedId] = {
      defaultEnabled: item.defaultEnabled === true,
      pinned: Boolean(item.pinned),
    };
  }

  const mcpServers = {};
  for (const [id, value] of Object.entries(source.mcpServers && typeof source.mcpServers === "object" ? source.mcpServers : {})) {
    const server = normalizeMcpServerDefinition({ ...(value && typeof value === "object" ? value : {}), id }, { allowEmptyId: false });
    if (server) {
      mcpServers[server.id] = server;
    }
  }

  return {
    version: Number(source.version ?? capabilitiesConfigVersion),
    skills,
    packages: normalizeCapabilityMetadataMap(source.packages),
    extensions: normalizeCapabilityMetadataMap(source.extensions),
    mcpServers,
  };
}

function normalizeCapabilityMetadataMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result = {};
  for (const [id, entry] of Object.entries(value)) {
    const normalizedId = String(id).trim();
    if (!normalizedId) {
      continue;
    }
    const source = entry && typeof entry === "object" ? entry : {};
    result[normalizedId] = {
      defaultEnabled: source.defaultEnabled !== false,
      pinned: Boolean(source.pinned),
    };
  }
  return result;
}

function normalizeCapabilityId(value) {
  return String(value ?? "").trim();
}

function skillCapabilityId(skill) {
  return skill.name;
}

function mcpCapabilityId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeMcpServerDefinition(value, options = {}) {
  const source = value && typeof value === "object" ? value : {};
  const id = mcpCapabilityId(source.id || source.name);
  if (!id && !options.allowEmptyId) {
    return null;
  }

  const name = String(source.name ?? id).trim();
  const transport = ["stdio", "sse", "http"].includes(String(source.transport ?? "")) ? String(source.transport) : "stdio";
  const args = Array.isArray(source.args) ? source.args.map((arg) => String(arg)) : splitArgs(source.args);
  const env = normalizeStringMap(source.env);
  const headers = normalizeStringMap(source.headers);
  const command = String(source.command ?? "").trim();
  const url = String(source.url ?? "").trim();

  if (transport === "stdio" && !command) {
    throw new Error("MCP stdio server requires a command.");
  }
  if (transport !== "stdio" && !url) {
    throw new Error("MCP remote server requires a URL.");
  }

  return {
    id,
    name: name || id,
    description: String(source.description ?? "").trim(),
    transport,
    command,
    args,
    env,
    url,
    headers,
    cwd: String(source.cwd ?? "").trim(),
    defaultEnabled: Boolean(source.defaultEnabled),
    pinned: Boolean(source.pinned),
    directTools: Boolean(source.directTools),
    includeTools: Array.isArray(source.includeTools) ? source.includeTools.map(String).filter(Boolean) : [],
    excludeTools: Array.isArray(source.excludeTools) ? source.excludeTools.map(String).filter(Boolean) : [],
  };
}

function splitArgs(value) {
  if (Array.isArray(value)) {
    return value.map((arg) => String(arg));
  }
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }
  return raw.split(/\s+/g).filter(Boolean);
}

function normalizeStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, nextValue]) => [String(key).trim(), String(nextValue ?? "")])
      .filter(([key]) => Boolean(key)),
  );
}

function readSessionCapabilitySelection(sessionManager) {
  const entries = typeof sessionManager.getBranch === "function"
    ? sessionManager.getBranch()
    : sessionManager.getEntries();

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === piDesktopCapabilitiesCustomType) {
      return normalizeSessionCapabilitySelection(entry.data);
    }
  }

  return null;
}

function normalizeSessionCapabilitySelection(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: Number(source.version ?? 3),
    skills: normalizeStringArray(source.skills),
    enabledSkills: normalizeStringArray(source.enabledSkills),
    disabledSkills: normalizeStringArray(source.disabledSkills),
    packages: normalizeStringArray(source.packages),
    enabledPackages: normalizeStringArray(source.enabledPackages),
    disabledPackages: normalizeStringArray(source.disabledPackages),
    extensions: normalizeStringArray(source.extensions),
    enabledExtensions: normalizeStringArray(source.enabledExtensions),
    disabledExtensions: normalizeStringArray(source.disabledExtensions),
    updatedAt: Number(source.updatedAt ?? Date.now()),
  };
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))] : [];
}

function defaultSkillEnabled(config, skillId) {
  const entry = config.skills[skillId];
  return entry?.defaultEnabled === true;
}

function defaultMcpEnabled(server) {
  return Boolean(server.defaultEnabled);
}

function defaultSessionCapabilitySelection(config, skills, targetRuntime = runtime) {
  const packages = configuredPackagesForRuntime(targetRuntime)
    .filter((pkg) => packageDefaultEnabled(config, pkg))
    .map(packageCapabilityId);
  const project = findProject(targetRuntime.projectId);
  const extensions = discoverStandaloneExtensionPaths(project, targetRuntime.settingsManager).map(extensionCapabilityId);
  return {
    version: 3,
    skills: defaultSkillIdsForSkills(config, managedSkills(skills)),
    enabledSkills: [],
    disabledSkills: [],
    packages,
    enabledPackages: [],
    disabledPackages: [],
    extensions: extensions.filter((id) => extensionDefaultEnabled(config, id)),
    enabledExtensions: [],
    disabledExtensions: [],
    // Not `Date.now()`: a default selection has never been changed, and a
    // request-time value makes every `/api/bootstrap` payload differ by one field,
    // which defeats the revalidation tag on a ~1MB body. Nothing on the client
    // reads this.
    updatedAt: 0,
  };
}

function activeSessionCapabilitySelection(sessionManager, skills, config, targetRuntime = runtime) {
  const selection = readSessionCapabilitySelection(sessionManager);
  if (!selection) {
    return defaultSessionCapabilitySelection(config, skills, targetRuntime);
  }
  return mergeSessionCapabilitySelection(selection, skills, config, targetRuntime);
}

function appendSessionCapabilitySelection(sessionManager, selection) {
  const normalized = normalizeSessionCapabilitySelection({ ...selection, version: 3, updatedAt: Date.now() });
  sessionManager.appendCustomEntry(piDesktopCapabilitiesCustomType, normalized);
  persistSessionShell(sessionManager);
  return normalized;
}

function defaultSkillIdsForSkills(config, skills) {
  return skills.filter((skill) => defaultSkillEnabled(config, skillCapabilityId(skill))).map(skillCapabilityId);
}

function mergeSessionCapabilitySelection(selection, skills, config, targetRuntime = runtime) {
  const project = findProject(targetRuntime.projectId);
  const managed = managedSkills(skills, project);
  const knownSkillIds = new Set(managed.map(skillCapabilityId));
  const defaultSkillIds = new Set(defaultSkillIdsForSkills(config, managed));
  const enabledSkillIds = new Set(selection.enabledSkills);
  const disabledSkillIds = new Set(selection.disabledSkills);

  const activeSkillIds = new Set(defaultSkillIds);
  for (const id of enabledSkillIds) {
    if (knownSkillIds.has(id)) {
      activeSkillIds.add(id);
    }
  }
  for (const id of disabledSkillIds) {
    activeSkillIds.delete(id);
  }

  const packages = configuredPackagesForRuntime(targetRuntime);
  const knownPackageIds = new Set(packages.map(packageCapabilityId));
  const defaultPackageIds = new Set(packages.filter((item) => packageDefaultEnabled(config, item)).map(packageCapabilityId));
  const enabledPackageIds = new Set(selection.enabledPackages);
  const disabledPackageIds = new Set(selection.disabledPackages);
  const activePackageIds = new Set(defaultPackageIds);
  for (const id of enabledPackageIds) {
    if (knownPackageIds.has(id)) activePackageIds.add(id);
  }
  for (const id of disabledPackageIds) activePackageIds.delete(id);

  const extensionPaths = discoverStandaloneExtensionPaths(project, targetRuntime.settingsManager);
  const knownExtensionIds = new Set(extensionPaths.map(extensionCapabilityId));
  const defaultExtensionIds = new Set(extensionPaths
    .map(extensionCapabilityId)
    .filter((id) => extensionDefaultEnabled(config, id)));
  const enabledExtensionIds = new Set(selection.enabledExtensions);
  const disabledExtensionIds = new Set(selection.disabledExtensions);
  const activeExtensionIds = new Set(defaultExtensionIds);
  for (const id of enabledExtensionIds) {
    if (knownExtensionIds.has(id)) activeExtensionIds.add(id);
  }
  for (const id of disabledExtensionIds) activeExtensionIds.delete(id);

  return {
    ...selection,
    version: 3,
    skills: managed.map(skillCapabilityId).filter((id) => activeSkillIds.has(id)),
    enabledSkills: [...enabledSkillIds],
    disabledSkills: [...disabledSkillIds],
    packages: packages.map(packageCapabilityId).filter((id) => activePackageIds.has(id)),
    enabledPackages: [...enabledPackageIds],
    disabledPackages: [...disabledPackageIds],
    extensions: extensionPaths.map(extensionCapabilityId).filter((id) => activeExtensionIds.has(id)),
    enabledExtensions: [...enabledExtensionIds],
    disabledExtensions: [...disabledExtensionIds],
  };
}

function managedSkills(skills, project = activeProject()) {
  return skills.filter((skill) => isManagedSkillPath(skill.filePath, project));
}

function isManagedSkillPath(filePath, project = activeProject()) {
  return isSkillPathUnderRoots(filePath, [appSkillsDir, agentSkillsDir, join(project.cwd, ".pi", "skills")]);
}

function packageCapabilityId(pkg) {
  return `${pkg.scope}:${pkg.source}`;
}

function packageDefaultEnabled(config, pkg) {
  return pkg.autoload !== false;
}

function extensionDefaultEnabled(config, id) {
  return config.extensions[id]?.defaultEnabled !== false;
}

function configuredPackagesForRuntime(targetRuntime = runtime) {
  const project = findProject(targetRuntime.projectId);
  const settingsManager = targetRuntime.settingsManager;
  const packageManager = new DefaultPackageManager({ cwd: project.cwd, agentDir, settingsManager });
  return packageManager.listConfiguredPackages().map((pkg) => ({
    ...pkg,
    id: packageCapabilityId(pkg),
    autoload: packageAutoloadEnabled(settingsManager, pkg),
  }));
}

/**
 * pi's own view of what a package contains. One resolve per package feeds the session's resource
 * paths, the command attribution and the card's resource chips, so they can never disagree.
 * `temporary` keeps this exploratory resolve from installing anything.
 */
async function resolvePackageResources({ project, settingsManager, pkg }) {
  if (!pkg.installedPath) {
    return emptyPackageResources();
  }
  const packageManager = new DefaultPackageManager({ cwd: project.cwd, agentDir, settingsManager });
  return packageManager.resolveExtensionSources([pkg.installedPath], {
    local: pkg.scope === "project",
    temporary: true,
  });
}

async function packageResourcesForRuntime(targetRuntime, pkg) {
  return resolvePackageResources({
    project: findProject(targetRuntime.projectId),
    settingsManager: targetRuntime.settingsManager,
    pkg,
  });
}

function enabledResourcePaths(resolved, type) {
  return (resolved?.[type] ?? [])
    .filter((resource) => resource.enabled)
    .map((resource) => canonicalPath(resource.path));
}

function commandMatchesPackage(command, pkg, extensionPaths) {
  const sourceInfo = command.sourceInfo;
  if (!sourceInfo) {
    return false;
  }

  if (sourceInfo.origin === "package" && sourceInfo.source === pkg.source) {
    return true;
  }

  return extensionPaths.has(canonicalPath(sourceInfo.path));
}

function packageAutoloadEnabled(settingsManager, pkg) {
  const settings = pkg.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
  const entry = (settings.packages ?? []).find((candidate) =>
    (typeof candidate === "string" ? candidate : candidate.source) === pkg.source,
  );
  return !(typeof entry === "object" && entry.autoload === false);
}

/**
 * pi writes a local install into user-scope settings as a path relative to the scope's base
 * directory, which makes the capability id (`user:<source>`) — and every selection, default and
 * pin stored against it — depend on that string staying resolvable. Straighten it to an
 * absolute path while the answer is still known.
 */
function straightenInstalledPackage(targetRuntime, installSource) {
  return absolutizeInstalledUserPackage({
    settingsManager: targetRuntime.settingsManager,
    installSource,
    projectCwd: findProject(targetRuntime.projectId).cwd,
    agentDir,
  });
}

function setPackageAutoload(settingsManager, pkg, enabled) {
  const scope = pkg.scope === "project" ? "project" : "user";
  const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
  const packages = [...(settings.packages ?? [])];
  const index = packages.findIndex((candidate) =>
    (typeof candidate === "string" ? candidate : candidate.source) === pkg.source,
  );
  if (index < 0) {
    throw new Error("Package source is not configured.");
  }

  const current = packages[index];
  if (enabled) {
    packages[index] = typeof current === "string"
      ? current
      : (() => {
          const next = { ...current };
          delete next.autoload;
          return next;
        })();
  } else {
    packages[index] = {
      ...(typeof current === "string" ? { source: current } : current),
      autoload: false,
    };
  }

  if (scope === "project") {
    settingsManager.setProjectPackages(packages);
  } else {
    settingsManager.setPackages(packages);
  }
}

function extensionPathsForSettings(project, settingsManager) {
  const result = [];
  const global = settingsManager.getGlobalSettings();
  const projectSettings = settingsManager.getProjectSettings();
  for (const path of global.extensions ?? []) {
    if (String(path).startsWith("!")) continue;
    const resolved = resolve(agentDir, String(path));
    result.push(...(statMaybeDirectory(resolved) ? collectExtensionEntries(resolved) : [resolved]));
  }
  for (const path of projectSettings.extensions ?? []) {
    if (String(path).startsWith("!")) continue;
    const resolved = resolve(project.cwd, ".pi", String(path));
    result.push(...(statMaybeDirectory(resolved) ? collectExtensionEntries(resolved) : [resolved]));
  }
  return result;
}

function statMaybeDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function discoverStandaloneExtensionPaths(project = activeProject(), settingsManager = runtime?.settingsManager) {
  const roots = [join(agentDir, "extensions")];
  if (settingsManager?.isProjectTrusted?.() !== false) {
    roots.push(join(project.cwd, ".pi", "extensions"));
  }
  const paths = roots.flatMap(collectExtensionEntries);
  if (settingsManager) paths.push(...extensionPathsForSettings(project, settingsManager));
  return [...new Set(paths.map((path) => resolve(path)).filter((path) => existsSync(path)))];
}

function collectExtensionEntries(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) {
      entries.push(path);
    } else if (entry.isDirectory()) {
      const index = ["index.ts", "index.js"].find((name) => existsSync(join(path, name)));
      if (index) entries.push(join(path, index));
      else entries.push(...collectExtensionEntries(path));
    }
  }
  return entries;
}

function allDiscoveredSkillsForLoader(resourceLoader) {
  return resourceLoader.getSkills().skills;
}

async function discoverAllProjectSkills(project, settingsManager = undefined) {
  const effectiveSettingsManager = settingsManager ?? SettingsManager.create(project.cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    ...basePiDesktopResourceLoaderOptions(project, effectiveSettingsManager),
    // Inventory only: importing the packages' extensions is the bulk of this pass' cost
    // and none of it feeds skill discovery (package skills still resolve either way).
    noExtensions: true,
    extensionFactories: [],
  });
  await loader.reload();
  return loader.getSkills().skills;
}

function loadedExtensionReport(targetRuntime = runtime) {
  const result = targetRuntime.resourceLoader?.getExtensions?.();
  return {
    loaded: (result?.extensions ?? []).map((extension) => ({
      path: extension.path,
      resolvedPath: extension.resolvedPath,
      tools: [...(extension.tools?.keys?.() ?? [])],
      commands: [...(extension.commands?.keys?.() ?? [])],
    })),
    errors: (result?.errors ?? []).map((error) => ({ path: error.path, error: error.error })),
  };
}

// pi never fails loudly when a configured package silently does not reach the session, so
// the panel used to report "loaded" off the selection set alone. Diff the real load result
// against the previous one and shout once per change instead of storing it in a log nobody reads.
const lastCapabilityLoadStatuses = new Map();

function reportUnhealthyLoads(health, packages) {
  const issues = packages
    .map((pkg) => ({ pkg, summary: health.packages[pkg.id] }))
    .filter((item) => item.summary && isUnhealthyLoadStatus(item.summary.status));
  const fingerprint = issues.map((item) => `${item.pkg.id}:${item.summary.status}`).join(",");
  if (lastCapabilityLoadStatuses.get("fingerprint") === fingerprint) {
    return;
  }
  lastCapabilityLoadStatuses.set("fingerprint", fingerprint);
  for (const item of issues) {
    const message = `[pi-desktop:capability] ${item.pkg.id} ${describeLoadStatus(item.summary.status, item.summary)}`;
    console.error(message);
    diagnosticLog("capability.load_issue", { package: item.pkg.id, status: item.summary.status, errors: item.summary.errors });
  }
}

// A managed skill can only be judged against the pre-resolved inventory. If pi's loader
// discovers one that pass never saw, the two disagree; keep it (fail open) and say so
// once, instead of letting the override silently delete a capability.
const reportedSkillInventoryMismatches = new Set();

function reportSkillInventoryMismatch(skill, project) {
  const key = `${project?.id ?? ""}:${skill?.name ?? ""}`;
  if (reportedSkillInventoryMismatches.has(key)) {
    return;
  }
  reportedSkillInventoryMismatches.add(key);
  console.error(`[pi-desktop:capability] skill ${skill?.name} was loaded by pi but missing from the pre-resolved inventory; keeping it`);
  diagnosticLog("capability.skill_inventory_mismatch", {
    projectId: project?.id,
    skill: skill?.name,
    path: skill?.filePath,
  });
}

async function buildCapabilitiesSnapshot(targetRuntime = runtime, options = {}) {
  const project = findProject(targetRuntime.projectId);
  // Reuse the set pi's session loader actually discovered (post-trust, post-package).
  // Re-running a discovery pass here would cost a full resource resolve per snapshot *and*
  // could disagree with what the session really loaded - which is exactly how project
  // skills went missing while the page still claimed they were active.
  const allSkills = targetRuntime.capabilityPaths?.skillInventory
    ?? await discoverAllProjectSkills(project, targetRuntime.settingsManager);
  const managed = managedSkills(allSkills, project);
  const config = ensureCapabilitiesConfigInitialized(managed);
  const sessionSelection = activeSessionCapabilitySelection(targetRuntime.session.sessionManager, allSkills, config, targetRuntime);
  const skillPolicy = targetRuntime.capabilityPaths?.skillSelection
    ?? createSkillSelectionPolicy({
      selection: sessionSelection,
      config,
      inventorySkills: allSkills,
      isManaged: (path) => isManagedSkillPath(path, project),
    });
  const packages = configuredPackagesForRuntime(targetRuntime);
  const extensionPaths = discoverStandaloneExtensionPaths(project, targetRuntime.settingsManager);
  const activePackages = new Set(sessionSelection.packages ?? []);
  const activeExtensions = new Set(sessionSelection.extensions ?? []);
  const loadedPackageCommands = targetRuntime.session.extensionRunner?.getRegisteredCommands?.() ?? [];
  // One resolve per package: the command attribution and the resource chips both read it, so the
  // card can never claim a skill count the session's own path resolution disagrees with.
  const packageResources = new Map(
    await Promise.all(packages.map(async (pkg) => [pkg.id, await packageResourcesForRuntime(targetRuntime, pkg)])),
  );
  const packageCommandPaths = new Map(
    packages.map((pkg) => [pkg.id, new Set(enabledResourcePaths(packageResources.get(pkg.id), "extensions"))]),
  );
  const extensionReport = loadedExtensionReport(targetRuntime);
  const loadHealth = summarizePackageHealth({
    loaded: extensionReport.loaded,
    errors: extensionReport.errors,
    packages: packages.map((pkg) => ({
      id: pkg.id,
      installedPath: pkg.installedPath,
      paths: [...(packageCommandPaths.get(pkg.id) ?? [])],
    })),
    activeIds: sessionSelection.packages ?? [],
  });
  const loadedExtensionPaths = new Set(
    extensionReport.loaded.flatMap((entry) => [entry.path, entry.resolvedPath]
      .filter((path) => path && !String(path).startsWith("<"))
      .map((path) => canonicalPath(path))),
  );
  reportUnhealthyLoads(loadHealth, packages);
  const activeToolNames = new Set(targetRuntime.session.getActiveToolNames?.() ?? []);
  const mcpServers = Object.values(config.mcpServers).map((server) => ({
    id: server.id,
    kind: "mcp",
    name: server.name,
    description: server.description,
    transport: server.transport,
    defaultEnabled: server.defaultEnabled,
    active: [...activeToolNames].some((toolName) => toolName.startsWith(`${server.id}_`)),
    pinned: Boolean(server.pinned),
  })).sort(compareCapabilityCards);

  return {
    skills: managed
      .map((skill) => {
        const id = skillCapabilityId(skill);
        const metadata = config.skills[id] ?? {};
        return {
          id,
          kind: "skill",
          name: skill.name,
          description: skill.description,
          path: skill.filePath,
          source: isBuiltinSkillPath(skill.filePath)
            ? "builtin"
            : isSkillPathUnderRoots(skill.filePath, [agentSkillsDir])
              ? "agent"
              : "project",
          disableModelInvocation: skill.disableModelInvocation,
          defaultEnabled: metadata.defaultEnabled === true,
          pinned: Boolean(metadata.pinned),
          active: skillEnabledBySelection(skillPolicy, id),
          readonly: isBuiltinSkillPath(skill.filePath),
        };
      })
      .sort(compareCapabilityCards),
    packages: packages.map((pkg) => ({
      id: packageCapabilityId(pkg),
      kind: "package",
      name: packageDisplayName(pkg),
      description: packageDescription(pkg),
      source: pkg.source,
      scope: pkg.scope,
      installedPath: pkg.installedPath,
      filtered: pkg.filtered,
      autoload: pkg.autoload,
      defaultEnabled: packageDefaultEnabled(config, pkg),
      active: activePackages.has(packageCapabilityId(pkg)),
      loadStatus: loadHealth.packages[pkg.id]?.status ?? "unknown",
      loadErrors: loadHealth.packages[pkg.id]?.errors ?? [],
      loadedTools: loadHealth.packages[pkg.id]?.tools ?? [],
      resources: summarizePackageResources(packageResources.get(pkg.id)),
      pinned: Boolean(config.packages[packageCapabilityId(pkg)]?.pinned),
      commands: loadedPackageCommands
        .filter((command) => commandMatchesPackage(command, pkg, packageCommandPaths.get(pkg.id) ?? new Set()))
        .map((command) => ({
          name: command.invocationName,
          ...(command.description ? { description: command.description } : {}),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    })).sort(compareCapabilityCards),
    extensions: extensionPaths.map((path) => ({
      id: extensionCapabilityId(path),
      kind: "extension",
      name: basename(dirname(path)) === "extensions" ? basename(path) : basename(dirname(path)),
      description: path,
      path,
      source: isPathInside(canonicalPath(join(project.cwd, ".pi", "extensions")), canonicalPath(path))
        ? "project"
        : isPathInside(canonicalPath(agentDir), canonicalPath(path))
          ? "agent"
          : "settings",
      defaultEnabled: extensionDefaultEnabled(config, extensionCapabilityId(path)),
      active: activeExtensions.has(extensionCapabilityId(path)),
      loaded: loadedExtensionPaths.has(canonicalPath(path)),
      pinned: Boolean(config.extensions[extensionCapabilityId(path)]?.pinned),
      readonly: false,
    })).sort(compareCapabilityCards),
    mcpServers,
    session: sessionSelection,
    extensionErrors: loadHealth.unattributedErrors.map((error) => (error.path ? `${error.message}（${error.path}）` : error.message)),
  };
}

async function resolveCapabilityPackageCommand(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const packageId = normalizeCapabilityId(body?.packageId);
  const commandName = String(body?.command ?? "").trim().replace(/^\/+/, "");
  const args = String(body?.args ?? "").trim();
  if (!packageId || !commandName) {
    throw new Error("Package command is required.");
  }

  const packageItem = configuredPackagesForRuntime(targetRuntime).find((item) => item.id === packageId);
  if (!packageItem) {
    throw new Error("Package not found.");
  }

  const packageExtensionPaths = new Set(enabledResourcePaths(await packageResourcesForRuntime(targetRuntime, packageItem), "extensions"));
  const command = targetRuntime.session.extensionRunner?.getRegisteredCommands?.().find((candidate) =>
    commandMatchesPackage(candidate, packageItem, packageExtensionPaths)
    && (candidate.invocationName === commandName || candidate.name === commandName),
  );
  if (!command) {
    throw new Error(`Command /${commandName} is not loaded from this package.`);
  }

  return {
    targetRuntime,
    commandText: `/${command.invocationName}${args ? ` ${args}` : ""}`,
  };
}

async function streamCapabilityPackageCommand(req, res) {
  const body = await readJson(req);
  const { targetRuntime, commandText } = await resolveCapabilityPackageCommand(body);
  const sessionPath = targetRuntime.session.sessionFile;
  activePackageCommands.set(sessionPath, targetRuntime);
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...corsHeaders(),
  });

  let closed = false;
  const writeEvent = (payload) => {
    if (!closed && !res.destroyed) {
      res.write(`${JSON.stringify(payload)}\n`);
    }
  };
  const unsubscribeUi = targetRuntime.uiBridge?.subscribe(writeEvent);
  // pi swallows extension command failures (they only reach runner error listeners), so
  // without this bridge-side forward a broken package command just "does nothing" in the UI.
  const unsubscribeExtensionErrors = targetRuntime.session.extensionRunner?.onError?.((error) => {
    const detail = String(error?.error ?? error?.message ?? error ?? "").trim();
    writeEvent({ type: "error", message: `${commandText} 执行失败：${detail || "未知错误"}` });
  });
  const unsubscribeSession = targetRuntime.session.subscribe((event) => {
    if (event.type !== "message_end" || event.message?.role !== "custom" || !event.message.display) {
      return;
    }

    const message = messageDisplayText(event.message);
    if (!message) {
      return;
    }

    const customType = String(event.message.customType ?? "package-command").trim() || "package-command";
    writeEvent({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "notify",
      message: `[${customType}] ${message}`,
      notifyType: "info",
    });
  });

  try {
    await targetRuntime.session.prompt(commandText, {
      expandPromptTemplates: true,
      source: "interactive",
    });
    updateSessionStoreFromRuntime(targetRuntime);
    writeEvent({ type: "snapshot", snapshot: await buildSnapshot(targetRuntime) });
    writeEvent({ type: "done" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeEvent({ type: "error", message });
  } finally {
    if (activePackageCommands.get(sessionPath) === targetRuntime) {
      activePackageCommands.delete(sessionPath);
    }
    closed = true;
    unsubscribeSession();
    unsubscribeExtensionErrors?.();
    unsubscribeUi?.();
    res.end();
  }
}

function packageDisplayName(pkg) {
  if (!pkg.installedPath) return pkg.source;
  try {
    const manifest = JSON.parse(readFileSync(join(pkg.installedPath, "package.json"), "utf8"));
    return String(manifest.name ?? pkg.source);
  } catch {
    return pkg.source;
  }
}

function packageDescription(pkg) {
  if (!pkg.installedPath) return pkg.source;
  try {
    const manifest = JSON.parse(readFileSync(join(pkg.installedPath, "package.json"), "utf8"));
    return String(manifest.description ?? pkg.source);
  } catch {
    return pkg.source;
  }
}

function compareCapabilityCards(left, right) {
  return Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || left.name.localeCompare(right.name);
}

function createMcpAdapterStatus(status, message = "") {
  return {
    status,
    message,
    package: "pi-mcp-adapter",
  };
}

async function setDefaultCapability(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const kind = ["skill", "package", "extension", "mcp"].includes(body?.kind) ? body.kind : "skill";
  const id = normalizeCapabilityId(body?.id);
  const enabled = Boolean(body?.enabled);
  if (!id) {
    throw new Error("Capability id is required.");
  }

  const config = readCapabilitiesConfig();
  if (kind === "skill") {
    config.skills[id] = {
      ...(config.skills[id] ?? {}),
      defaultEnabled: enabled,
    };
  } else if (kind === "package") {
    const packageItem = configuredPackagesForRuntime(targetRuntime).find((item) => item.id === id);
    if (!packageItem) {
      throw new Error("Package not found.");
    }
    setPackageAutoload(targetRuntime.settingsManager, packageItem, enabled);
  } else if (kind === "extension") {
    if (!discoverStandaloneExtensionPaths(findProject(targetRuntime.projectId), targetRuntime.settingsManager).includes(id)) {
      throw new Error("Extension not found.");
    }
    config.extensions[id] = {
      ...(config.extensions[id] ?? {}),
      defaultEnabled: enabled,
    };
  } else {
    const server = config.mcpServers[id];
    if (!server) {
      throw new Error("MCP server not found.");
    }
    server.defaultEnabled = enabled;
  }

  writeCapabilitiesConfig(config);
  // A default skill change only moves which skills pass the loader's filter; the heavier
  // package/extension/MCP changes still need the full runtime reload.
  if (kind === "skill") {
    await reloadOpenRuntimeSkills("all");
  } else {
    await reloadOpenRuntimeCapabilities("all");
  }
  return { capabilities: await buildCapabilitiesSnapshot(targetRuntime) };
}

async function setCapabilityPinned(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const kind = ["skill", "package", "extension", "mcp"].includes(body?.kind) ? body.kind : "skill";
  const id = normalizeCapabilityId(body?.id);
  const pinned = Boolean(body?.pinned);
  if (!id) {
    throw new Error("Capability id is required.");
  }

  const config = readCapabilitiesConfig();
  if (kind === "skill") {
    config.skills[id] = {
      ...(config.skills[id] ?? {}),
      pinned,
    };
  } else if (kind === "package") {
    if (!configuredPackagesForRuntime(targetRuntime).some((item) => item.id === id)) {
      throw new Error("Package not found.");
    }
    config.packages[id] = {
      ...(config.packages[id] ?? {}),
      pinned,
    };
  } else if (kind === "extension") {
    if (!discoverStandaloneExtensionPaths(findProject(targetRuntime.projectId), targetRuntime.settingsManager).includes(id)) {
      throw new Error("Extension not found.");
    }
    config.extensions[id] = {
      ...(config.extensions[id] ?? {}),
      pinned,
    };
  } else {
    const server = config.mcpServers[id];
    if (!server) {
      throw new Error("MCP server not found.");
    }
    server.pinned = pinned;
  }

  writeCapabilitiesConfig(config);
  // Pinning only changes capability ordering/labels; it never enters a runtime path, so
  // there is nothing to reload - the fresh snapshot below is enough.
  return { capabilities: await buildCapabilitiesSnapshot(targetRuntime) };
}

async function setSessionSkillCapability(body) {
  const targetRuntime = getRuntimeForRequest(body);
  if (isSessionBusy(targetRuntime.session)) {
    throw new Error("Stop the running response before changing this session's skills.");
  }

  const id = normalizeCapabilityId(body?.id);
  const enabled = Boolean(body?.enabled);
  if (!id) {
    throw new Error("Skill id is required.");
  }

  await updateRuntimeSessionCapabilities(targetRuntime, (selection) => {
    const enabledSkills = new Set(selection.enabledSkills);
    const disabledSkills = new Set(selection.disabledSkills);
    if (enabled) {
      enabledSkills.add(id);
      disabledSkills.delete(id);
    } else {
      enabledSkills.delete(id);
      disabledSkills.add(id);
    }
    return {
      ...selection,
      enabledSkills: [...enabledSkills],
      disabledSkills: [...disabledSkills],
    };
  });
  return { capabilities: await buildCapabilitiesSnapshot(targetRuntime) };
}

async function updateRuntimeSessionCapabilities(targetRuntime, updateSelection) {
  const context = await readRuntimeCapabilityContext(targetRuntime);
  const current = activeSessionCapabilitySelection(
    targetRuntime.session.sessionManager,
    context.allSkills,
    context.config,
    targetRuntime,
  );
  const next = mergeSessionCapabilitySelection(
    normalizeSessionCapabilitySelection(updateSelection(current, context)),
    context.allSkills,
    context.config,
    targetRuntime,
  );

  const plan = capabilityReloadPlan(current, next);
  if (plan === "none") {
    return current;
  }

  appendSessionCapabilitySelection(targetRuntime.session.sessionManager, next);
  await refreshRuntimeCapabilityPaths(targetRuntime);
  // A skill toggle already refreshed `capabilityPaths.skillSelection` above, and pi's
  // loader re-reads it through `skillsOverride`; only a package/extension move needs the
  // full reload.
  if (plan !== "skills" || !reloadRuntimeSkills(targetRuntime)) {
    await targetRuntime.session.reload();
  }
  return next;
}

async function setSessionPackageCapability(body) {
  const targetRuntime = getRuntimeForRequest(body);
  if (isSessionBusy(targetRuntime.session)) {
    throw new Error("Stop the running response before changing this session's packages.");
  }
  const id = normalizeCapabilityId(body?.id);
  if (!id) throw new Error("Package id is required.");

  await updateRuntimeSessionCapabilities(targetRuntime, (selection) => {
    const enabledPackages = new Set(selection.enabledPackages);
    const disabledPackages = new Set(selection.disabledPackages);
    if (Boolean(body?.enabled)) {
      enabledPackages.add(id);
      disabledPackages.delete(id);
    } else {
      enabledPackages.delete(id);
      disabledPackages.add(id);
    }
    return { ...selection, enabledPackages: [...enabledPackages], disabledPackages: [...disabledPackages] };
  });
  return { capabilities: await buildCapabilitiesSnapshot(targetRuntime) };
}

async function setSessionExtensionCapability(body) {
  const targetRuntime = getRuntimeForRequest(body);
  if (isSessionBusy(targetRuntime.session)) {
    throw new Error("Stop the running response before changing this session's extensions.");
  }
  const id = normalizeCapabilityId(body?.id);
  if (!id) throw new Error("Extension id is required.");

  await updateRuntimeSessionCapabilities(targetRuntime, (selection) => {
    const enabledExtensions = new Set(selection.enabledExtensions);
    const disabledExtensions = new Set(selection.disabledExtensions);
    if (Boolean(body?.enabled)) {
      enabledExtensions.add(id);
      disabledExtensions.delete(id);
    } else {
      enabledExtensions.delete(id);
      disabledExtensions.add(id);
    }
    return { ...selection, enabledExtensions: [...enabledExtensions], disabledExtensions: [...disabledExtensions] };
  });
  return { capabilities: await buildCapabilitiesSnapshot(targetRuntime) };
}

function capabilityPackageManager(targetRuntime, onProgress) {
  const project = findProject(targetRuntime.projectId);
  const manager = new DefaultPackageManager({
    cwd: project.cwd,
    agentDir,
    settingsManager: targetRuntime.settingsManager,
  });
  // pi reports install/remove/update through `withProgress` (start -> complete | error). Without
  // this the long npm/git steps are a black box: the HTTP call just never answers until it is done.
  if (onProgress) {
    manager.setProgressCallback(onProgress);
  }
  return manager;
}

async function installCapabilityPackage(body, onProgress) {
  const targetRuntime = getRuntimeForRequest(body);
  const source = String(body?.source ?? "").trim();
  if (!source) throw new Error("Package source is required.");
  const local = body?.scope === "project";
  if (local && !targetRuntime.settingsManager.isProjectTrusted()) {
    throw new Error("Project is not trusted; cannot install a project package.");
  }

  const packageManager = capabilityPackageManager(targetRuntime, onProgress);
  await packageManager.installAndPersist(source, { local });
  if (!local) {
    straightenInstalledPackage(targetRuntime, source);
  }
  // The persisted source may no longer equal what the UI sent (pi relativises local paths), so
  // match on where the package actually landed as well.
  const installTarget = installTargetPath(source, findProject(targetRuntime.projectId).cwd);
  const installed = configuredPackagesForRuntime(targetRuntime).find((pkg) => (
    pkg.scope === (local ? "project" : "user")
    && (pkg.source === source || Boolean(installTarget) && pkg.installedPath === resolve(installTarget))
  ));
  if (installed && body?.autoload === false) {
    setPackageAutoload(targetRuntime.settingsManager, installed, false);
  }
  await reloadOpenRuntimeCapabilities("all");
  return refreshSnapshot();
}

async function removeCapabilityPackage(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const project = findProject(targetRuntime.projectId);
  const source = String(body?.source ?? "").trim();
  if (!source) throw new Error("Package source is required.");
  const local = body?.scope === "project";
  // Settings keep local sources relative to the scope base dir, pi resolves them
  // against the project cwd — pass the absolute path or nothing matches.
  const removableSource = packageSourceForPi({
    source,
    scope: local ? "project" : "user",
    projectCwd: project.cwd,
    agentDir,
  });
  const removed = await capabilityPackageManager(targetRuntime).removeAndPersist(removableSource, { local });
  if (!removed) {
    // pi treats "nothing matched" as a no-op; the user pressed Delete, so say so.
    throw new Error(`Package is not configured in ${local ? "project" : "user"} settings: ${source}`);
  }
  await reloadOpenRuntimeCapabilities("all");
  return refreshSnapshot();
}

async function updateCapabilityPackage(body, onProgress) {
  const targetRuntime = getRuntimeForRequest(body);
  const source = String(body?.source ?? "").trim() || undefined;
  await capabilityPackageManager(targetRuntime, onProgress).update(source);
  await reloadOpenRuntimeCapabilities("all");
  return refreshSnapshot();
}

/**
 * Install/update used to be plain JSON POSTs, which meant the panel showed a spinner with no
 * idea whether npm was downloading or stuck. pi's progress callback is forwarded over the same
 * NDJSON shape the package-command stream already uses, so the client keeps one parser.
 */
async function streamCapabilityPackageAction(req, res, operation) {
  const body = await readJson(req);
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...corsHeaders(),
  });

  let closed = false;
  const writeEvent = (payload) => {
    if (!closed && !res.destroyed) {
      res.write(`${JSON.stringify(payload)}\n`);
    }
  };

  try {
    const snapshot = await operation(body, (event) => writeEvent(packageProgressEvent(event)));
    writeEvent({ type: "snapshot", snapshot: snapshot ?? await refreshSnapshot() });
    writeEvent({ type: "done" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeEvent({ type: "error", message });
  } finally {
    closed = true;
    res.end();
  }
}

async function readCapabilityPackageResources(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const packageId = normalizeCapabilityId(body?.packageId);
  if (!packageId) {
    throw new Error("Package id is required.");
  }
  const pkg = configuredPackagesForRuntime(targetRuntime).find((candidate) => packageCapabilityId(candidate) === packageId);
  if (!pkg) {
    throw new Error(`Package is not configured: ${packageId}`);
  }
  const resolved = await packageResourcesForRuntime(targetRuntime, pkg);
  return {
    id: packageId,
    name: packageDisplayName(pkg),
    installedPath: pkg.installedPath ?? "",
    resources: packageResourceDetails(resolved, { packageRoot: pkg.installedPath ?? "" }),
  };
}

/**
 * Read-only preview of one resolved package file. pi's own resolution is the whitelist: a path
 * that this package did not resolve is rejected, so the endpoint cannot be used as a file reader.
 */
async function readCapabilityPackageFile(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const packageId = normalizeCapabilityId(body?.packageId);
  const requestedPath = String(body?.path ?? "").trim();
  if (!packageId || !requestedPath) {
    throw new Error("Package id and path are required.");
  }
  const pkg = configuredPackagesForRuntime(targetRuntime).find((candidate) => packageCapabilityId(candidate) === packageId);
  if (!pkg) {
    throw new Error(`Package is not configured: ${packageId}`);
  }
  const resolved = await packageResourcesForRuntime(targetRuntime, pkg);
  const entry = findPackageResourceEntry(resolved, requestedPath, { packageRoot: pkg.installedPath ?? "" });
  if (!entry) {
    throw new Error("Path does not belong to this package.");
  }
  if (!existsSync(entry.absolutePath)) {
    throw new Error(`File not found: ${requestedPath}`);
  }

  const stats = statSync(entry.absolutePath);
  const common = { type: entry.type, enabled: entry.enabled, bytes: stats.size };
  if (stats.isDirectory()) {
    return { ...common, directory: true, content: "", binary: false, truncated: false };
  }

  // Read at most the preview cap: a 200 MB asset must not be pulled into memory just to be
  // refused by the dialog.
  const limit = Math.min(stats.size, MAX_RESOURCE_PREVIEW_BYTES);
  const buffer = Buffer.alloc(limit);
  const fd = openSync(entry.absolutePath, "r");
  let read = 0;
  try {
    read = limit > 0 ? readSync(fd, buffer, 0, limit, 0) : 0;
  } finally {
    closeSync(fd);
  }
  return { ...common, directory: false, ...resourcePreview(buffer.subarray(0, read), { totalBytes: stats.size }) };
}

async function addCapabilityExtension(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const project = findProject(targetRuntime.projectId);
  const rawPath = String(body?.path ?? "").trim();
  if (!rawPath) throw new Error("Extension path is required.");
  const scope = body?.scope === "project" ? "project" : "user";
  if (scope === "project" && !targetRuntime.settingsManager.isProjectTrusted()) {
    throw new Error("Project is not trusted; cannot add a project extension.");
  }
  const baseDir = scope === "project" ? join(project.cwd, ".pi") : agentDir;
  const path = resolve(baseDir, rawPath);
  if (!existsSync(path)) throw new Error(`Extension path does not exist: ${path}`);

  const settingsManager = targetRuntime.settingsManager;
  const current = scope === "project" ? settingsManager.getProjectSettings().extensions ?? [] : settingsManager.getGlobalSettings().extensions ?? [];
  const next = [...new Set([...current, rawPath])];
  if (scope === "project") settingsManager.setProjectExtensionPaths(next);
  else settingsManager.setExtensionPaths(next);
  await reloadOpenRuntimeCapabilities("all");
  return refreshSnapshot();
}

async function removeCapabilityExtension(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const id = resolve(String(body?.id ?? body?.path ?? "").trim());
  if (!id) throw new Error("Extension id is required.");
  const project = findProject(targetRuntime.projectId);
  const settingsManager = targetRuntime.settingsManager;
  const scopes = [
    ["user", settingsManager.getGlobalSettings().extensions ?? [], agentDir],
    ["project", settingsManager.getProjectSettings().extensions ?? [], join(project.cwd, ".pi")],
  ];
  for (const [scope, paths, baseDir] of scopes) {
    const next = paths.filter((entry) => resolve(baseDir, String(entry)) !== id);
    if (next.length !== paths.length) {
      if (scope === "project") settingsManager.setProjectExtensionPaths(next);
      else settingsManager.setExtensionPaths(next);
    }
  }
  await reloadOpenRuntimeCapabilities("all");
  return refreshSnapshot();
}

async function readRuntimeCapabilityContext(targetRuntime) {
  const project = findProject(targetRuntime.projectId);
  const allSkills = targetRuntime.capabilityPaths?.skillInventory
    ?? await discoverAllProjectSkills(project, targetRuntime.settingsManager);
  const config = ensureCapabilitiesConfigInitialized(managedSkills(allSkills, project));
  return {
    project,
    config,
    allSkills,
  };
}

async function importSkillFromCapabilityPage(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const project = findProject(targetRuntime.projectId);
  const result = await installPiDesktopSkill(project, targetRuntime.resourceLoader, {
    sourcePath: body?.sourcePath,
    scope: body?.scope === "user" ? "user" : "project",
    name: body?.name,
    overwrite: Boolean(body?.overwrite),
    reload: true,
  }, project.cwd);
  return {
    ...result,
    capabilities: await buildCapabilitiesSnapshot(targetRuntime),
    snapshot: await buildSnapshot(targetRuntime),
  };
}

async function deleteSkillFromCapabilityPage(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const project = findProject(targetRuntime.projectId);
  const skillTarget = String(body?.path ?? body?.id ?? "").trim();
  const skillPath = skillTarget ? resolve(skillTarget) : "";
  const allSkills = targetRuntime.capabilityPaths?.skillInventory
    ?? await discoverAllProjectSkills(project, targetRuntime.settingsManager);
  const skill = allSkills.find((candidate) =>
    candidate.name === skillTarget || resolve(candidate.filePath) === skillPath,
  );
  if (!skill) {
    throw new Error("Skill not found.");
  }

  const skillRoot = dirname(skill.filePath);
  assertWritableSkillRoot(skillRoot);
  await snapshotInstalledSkillVersion(project, body?.scope === "user" ? "user" : inferInstalledSkillScope(project, skillRoot), basename(skillRoot), skillRoot, "before-delete");
  rmSync(skillRoot, { recursive: true, force: true });

  const config = readCapabilitiesConfig();
  delete config.skills[skillCapabilityId(skill)];
  writeCapabilitiesConfig(config);
  await reloadPiDesktopSkills({ scope: "all", projectId: project.id, sourceLoader: targetRuntime.resourceLoader });
  return {
    capabilities: await buildCapabilitiesSnapshot(targetRuntime),
    snapshot: await buildSnapshot(targetRuntime),
  };
}

function inferInstalledSkillScope(project, skillRoot) {
  if (isSkillPathUnderRoots(skillRoot, [agentSkillsDir])) {
    return "user";
  }
  return "project";
}

function readSkillContent(filePath) {
  // 匹配要按真实路径（worktree 会话里同一条技能报的是软链那侧），
  // 兜底发现则传原始路径：用户的技能本身就是软链，只比 realpath 会找不到。
  const normalizedPath = canonicalPath(filePath);
  const project = findProject(runtime.projectId);
  const allSkills = allDiscoveredSkillsForLoader(runtime.resourceLoader);
  const skill = allSkills.find((candidate) => canonicalPath(candidate.filePath) === normalizedPath)
    ?? discoverSkillFromKnownRoots(project, filePath);

  if (!skill) {
    throw new Error("Skill not found.");
  }

  return {
    name: skill.name,
    path: skill.filePath,
    content: readFileSync(skill.filePath, "utf8"),
  };
}

function discoverSkillFromKnownRoots(project, filePath) {
  const roots = [appSkillsDir, agentSkillsDir, join(project.cwd, ".pi", "skills")];
  if (!isSkillPathUnderRoots(filePath, roots)) {
    return null;
  }
  const candidate = canonicalPath(filePath);
  if (!candidate || !existsSync(candidate) || basename(candidate) !== "SKILL.md") {
    return null;
  }

  return {
    name: basename(dirname(candidate)),
    description: "",
    filePath: candidate,
    disableModelInvocation: false,
  };
}

function createPiDesktopSkillTools(project, resourceLoader) {
  return [
    {
      name: "install_skill",
      label: "Install Skill",
      description: "Copy a local skill directory containing SKILL.md into ~/.pi/agent/skills or the current project's .pi/skills, then optionally reload skills. Do not use for ordinary documents or project files.",
      promptSnippet: "Install a local SKILL.md directory only when the user explicitly asks to install or update a skill.",
      promptGuidelines: [
        "Use install_skill only when the user explicitly asks to install, copy, add, register, or update a skill directory that contains SKILL.md.",
        "Do not use install_skill merely to activate, invoke, read, or follow an already loaded skill.",
        "If a skill is already listed in the available skills, use/read/follow that skill directly; do not call install_skill for it.",
        "For ordinary user tasks like searching the web, using a browser, writing content, or analyzing files, do not call install_skill even if a relevant skill name or path appears in context.",
        "Use install_skill with scope \"project\" for the current project unless the user asks for a global/user install.",
        "Never use install_skill for ordinary files, documents, reports, code, application files, or bidding/tender documents (招标文件).",
      ],
      parameters: Type.Object({
        sourcePath: Type.String({
          description: "Path to the local skill directory. Relative paths are resolved from the current project directory.",
        }),
        scope: StringEnum(["project", "user"], {
          description: "Install into the current project's .pi/skills directory or the user's ~/.pi/agent/skills directory.",
          default: "project",
        }),
        name: Type.Optional(Type.String({
          description: "Optional destination folder name. Defaults to the source directory name.",
        })),
        overwrite: Type.Optional(Type.Boolean({
          description: "Whether to overwrite files when the destination skill folder already exists.",
          default: false,
        })),
        reload: Type.Optional(Type.Boolean({
          description: "Whether to reload Pi Desktop skills after installation.",
          default: true,
        })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Cancelled." }], details: { cancelled: true } };
        }

        const result = await installPiDesktopSkill(project, resourceLoader, params, ctx?.cwd);
        const reloadText = result.reloaded
          ? ` Reloaded Pi Desktop skills; ${result.skillCount} skill(s) are now loaded.`
          : " Reload was skipped.";

        return {
          content: [{
            type: "text",
            text: result.alreadyInstalled
              ? `${result.name} is already installed in ${result.scope} skills: ${result.targetPath}.${reloadText}`
              : `Installed ${result.name} to ${result.scope} skills: ${result.targetPath}.${reloadText}`,
          }],
          details: result,
        };
      },
    },
    {
      name: "write_skill_file",
      label: "Write Skill File",
      description: "Write or replace a file inside an installed skill only, preserving a version before the change. Do not use for ordinary documents, reports, code, or application files.",
      promptSnippet: "Write a file that belongs to an installed skill and keep a version backup.",
      promptGuidelines: [
        "Use write_skill_file only for files that belong to an installed skill under the current project's .pi/skills or ~/.pi/agent/skills, such as SKILL.md or a referenced skill asset.",
        "Never use write_skill_file for ordinary documents, especially bidding/tender documents (招标文件), reports, source code, or application files.",
        "Never use write_skill_file to modify built-in skills under the bundled skills directory.",
        "Use install_skill with overwrite: true if the user wants to replace an installed skill directory from a source copy.",
      ],
      parameters: Type.Object({
        scope: StringEnum(["project", "user"], {
          description: "Which installed skill store to edit.",
          default: "project",
        }),
        skillName: Type.String({
          description: "Installed skill folder name under the selected skill store.",
        }),
        relativePath: Type.String({
          description: "File path inside the skill folder, such as SKILL.md.",
          default: "SKILL.md",
        }),
        content: Type.String({
          description: "New file content to write.",
        }),
        reload: Type.Optional(Type.Boolean({
          description: "Whether to reload Pi Desktop skills after the write.",
          default: true,
        })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Cancelled." }], details: { cancelled: true } };
        }

        const result = await writePiDesktopSkillFile(project, resourceLoader, params);
        return {
          content: [{
            type: "text",
            text: `Updated ${result.relativePath} in ${result.scope} skill ${result.skillName}. Saved version ${result.versionId}.${result.reloaded ? ` Reloaded ${result.skillCount} skill(s).` : ""}`,
          }],
          details: result,
        };
      },
    },
    {
      name: "list_skill_versions",
      label: "List Skill Versions",
      description: "List saved versions for an installed skill so the user can choose a restore point. Only use for installed skills.",
      promptSnippet: "List saved versions for an installed skill.",
      promptGuidelines: [
        "Use list_skill_versions only when the user asks to review or choose a previous version of an installed skill, never for ordinary files or documents.",
      ],
      parameters: Type.Object({
        scope: StringEnum(["project", "user"], {
          description: "Which installed skill store to inspect.",
          default: "project",
        }),
        skillName: Type.String({
          description: "Installed skill folder name under the selected skill store.",
        }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const result = listPiDesktopSkillVersions(project, params);
        return {
          content: [{
            type: "text",
            text: result.versions.length
              ? result.versions.map((version) => `${version.versionId} ${version.createdAt} ${version.reason ?? ""}`.trim()).join("\n")
              : `No saved versions for ${result.skillName}.`,
          }],
          details: result,
        };
      },
    },
    {
      name: "restore_skill_version",
      label: "Restore Skill Version",
      description: "Restore a previously saved version of an installed skill and reload skills afterward. Only use for installed skills.",
      promptSnippet: "Restore a previous version of an installed skill.",
      promptGuidelines: [
        "Use restore_skill_version only after the user chooses a listed version of an installed skill.",
        "Use list_skill_versions first if the user has not specified a versionId.",
        "Never use restore_skill_version for ordinary files, documents, reports, code, or application files.",
      ],
      parameters: Type.Object({
        scope: StringEnum(["project", "user"], {
          description: "Which installed skill store to restore.",
          default: "project",
        }),
        skillName: Type.String({
          description: "Installed skill folder name under the selected skill store.",
        }),
        versionId: Type.String({
          description: "Version identifier returned by list_skill_versions.",
        }),
        reload: Type.Optional(Type.Boolean({
          description: "Whether to reload Pi Desktop skills after restore.",
          default: true,
        })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Cancelled." }], details: { cancelled: true } };
        }

        const result = await restorePiDesktopSkillVersion(project, resourceLoader, params);
        return {
          content: [{
            type: "text",
            text: `Restored ${result.skillName} to version ${result.versionId}.${result.reloaded ? ` Reloaded ${result.skillCount} skill(s).` : ""}`,
          }],
          details: result,
        };
      },
    },
    {
      name: "reload_skills",
      label: "Reload Skills",
      description: "Reload skills from system, user, and current project skill directories after a skill-only change.",
      promptSnippet: "Reload skills after an installed skill changes.",
      promptGuidelines: [
        "Use reload_skills only after creating, editing, copying, restoring, or installing skill files, not after ordinary document or code changes.",
      ],
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const result = await reloadPiDesktopSkills({ scope: "all", sourceLoader: resourceLoader });
        return {
          content: [{ type: "text", text: `Reloaded Pi Desktop skills; ${result.skillCount} skill(s) are now loaded.` }],
          details: result,
        };
      },
    },
  ];
}

async function installPiDesktopSkill(project, resourceLoader, params, cwd) {
  const sourcePath = resolveToolPath(String(params?.sourcePath ?? ""), cwd ?? project.cwd);
  assertSkillDirectory(sourcePath);

  const scope = params?.scope === "user" ? "user" : "project";
  const targetParent = getInstalledSkillRoot(project, scope);
  const name = normalizeSkillFolderName(params?.name, basename(sourcePath));
  const targetPath = resolve(targetParent, name);
  const overwrite = Boolean(params?.overwrite);
  const existedBefore = existsSync(targetPath);
  let alreadyInstalled = false;
  assertWritableSkillTarget(targetPath);

  mkdirSync(targetParent, { recursive: true });

  await withFileMutationQueue(targetPath, async () => {
    if (resolve(sourcePath) === targetPath) {
      alreadyInstalled = true;
      return;
    }

    if (existsSync(targetPath) && !overwrite && directoriesHaveSameContent(sourcePath, targetPath)) {
      alreadyInstalled = true;
      return;
    }

    if (existsSync(targetPath) && !overwrite) {
      throw new Error(`Skill already exists at ${targetPath}. Set overwrite to true to update it.`);
    }

    if (existsSync(targetPath)) {
      await snapshotInstalledSkillVersion(project, scope, name, targetPath, "before-overwrite");
      rmSync(targetPath, { recursive: true, force: true });
    }

    cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  });

  let reloadResult = {
    skillCount: resourceLoader.getSkills().skills.length,
    skills: skillSummaries(resourceLoader),
  };
  const shouldReload = params?.reload !== false;
  if (shouldReload) {
    reloadResult = await reloadPiDesktopSkills({ scope, projectId: project.id, sourceLoader: resourceLoader });
  }

  return {
    name,
    scope,
    sourcePath,
    targetPath,
    alreadyInstalled,
    overwritten: existedBefore && overwrite,
    reloaded: shouldReload,
    ...reloadResult,
  };
}

async function writePiDesktopSkillFile(project, resourceLoader, params) {
  const scope = params?.scope === "user" ? "user" : "project";
  const skillName = normalizeSkillFolderName(params?.skillName, "");
  const skillRoot = getInstalledSkillPath(project, scope, skillName);
  assertWritableSkillRoot(skillRoot);

  const relativePath = normalizeSkillRelativePath(params?.relativePath ?? "SKILL.md");
  const absolutePath = resolve(skillRoot, relativePath);
  assertWritableSkillFile(skillRoot, absolutePath);
  let version = { versionId: null, snapshotPath: null };

  await withFileMutationQueue(skillRoot, async () => {
    version = await snapshotInstalledSkillVersion(project, scope, skillName, skillRoot, `before-write:${relativePath}`);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, String(params?.content ?? ""), "utf8");
  });

  let reloadResult = {
    skillCount: resourceLoader.getSkills().skills.length,
    skills: skillSummaries(resourceLoader),
  };
  const shouldReload = params?.reload !== false;
  if (shouldReload) {
    reloadResult = await reloadPiDesktopSkills({ scope, projectId: project.id, sourceLoader: resourceLoader });
  }

  return {
    scope,
    skillName,
    relativePath,
    absolutePath,
    versionId: version.versionId,
    reloaded: shouldReload,
    ...reloadResult,
  };
}

function listPiDesktopSkillVersions(project, params) {
  const scope = params?.scope === "user" ? "user" : "project";
  const skillName = normalizeSkillFolderName(params?.skillName, "");
  const versionsRoot = getSkillVersionsRoot(project, scope);
  const skillVersionsRoot = join(versionsRoot, skillName);
  const versions = [];

  if (existsSync(skillVersionsRoot)) {
    for (const entry of readdirSync(skillVersionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const versionDir = join(skillVersionsRoot, entry.name);
      const meta = readVersionMetadata(versionDir);
      if (!meta) {
        continue;
      }

      versions.push(meta);
    }
  }

  versions.sort((left, right) => Number(right.createdAtMs ?? 0) - Number(left.createdAtMs ?? 0));

  return {
    scope,
    skillName,
    versions,
  };
}

async function restorePiDesktopSkillVersion(project, resourceLoader, params) {
  const scope = params?.scope === "user" ? "user" : "project";
  const skillName = normalizeSkillFolderName(params?.skillName, "");
  const versionId = String(params?.versionId ?? "").trim();
  if (!versionId) {
    throw new Error("versionId is required.");
  }

  const skillRoot = getInstalledSkillPath(project, scope, skillName);
  assertWritableSkillTarget(skillRoot);

  const versionDir = getSkillVersionDir(project, scope, skillName, versionId);
  const snapshotDir = join(versionDir, "files");
  if (!existsSync(snapshotDir)) {
    throw new Error(`Unknown version: ${versionId}`);
  }

  await withFileMutationQueue(skillRoot, async () => {
    if (existsSync(skillRoot)) {
      await snapshotInstalledSkillVersion(project, scope, skillName, skillRoot, `before-restore:${versionId}`);
      rmSync(skillRoot, { recursive: true, force: true });
    }

    cpSync(snapshotDir, skillRoot, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  });

  let reloadResult = {
    skillCount: resourceLoader.getSkills().skills.length,
    skills: skillSummaries(resourceLoader),
  };
  const shouldReload = params?.reload !== false;
  if (shouldReload) {
    reloadResult = await reloadPiDesktopSkills({ scope, projectId: project.id, sourceLoader: resourceLoader });
  }

  return {
    scope,
    skillName,
    versionId,
    reloaded: shouldReload,
    ...reloadResult,
  };
}

async function reloadPiDesktopSkills({ scope = "all", projectId, sourceLoader } = {}) {
  const reload = async () => {
    const targets = [...openRuntimes.values()].filter((candidate) =>
      scope === "all" || scope === "user" || candidate.projectId === projectId,
    );
    await reloadRuntimeTargets(targets);

    const summaryLoader = sourceLoader ?? targets[0]?.resourceLoader ?? runtime.resourceLoader;
    return {
      skillCount: summaryLoader.getSkills().skills.length,
      skills: skillSummaries(summaryLoader),
      reloadedSessionPaths: targets.map((candidate) => candidate.session.sessionFile),
    };
  };

  const queuedReload = skillReloadQueue.then(reload, reload);
  skillReloadQueue = queuedReload.catch(() => undefined);
  return queuedReload;
}

async function reloadOpenRuntimeCapabilities(scope = "all") {
  const targets = [...openRuntimes.values()].filter((candidate) =>
    scope === "all" || candidate.projectId === scope,
  );
  await reloadRuntimeTargets(targets);
}

/**
 * Apply a skill-only default change to the open runtimes. `reloadRuntimeTargets` skips
 * busy sessions, exactly like the full reload path does, so a change lands on the next
 * reload/restart for a session that is mid-turn rather than mutating its prompt.
 */
async function reloadOpenRuntimeSkills(scope = "all") {
  const targets = [...openRuntimes.values()].filter((candidate) =>
    scope === "all" || candidate.projectId === scope,
  );
  await reloadRuntimeTargets(targets, { skillsOnly: true });
}

async function reloadRuntimeTargets(targets, { skillsOnly = false } = {}) {
  await Promise.all(targets.map(async (candidate) => {
    if (isSessionBusy(candidate.session)) {
      return;
    }
    // 刚装的项目技能 / 包就在项目根的 `.pi` 里：先保证 worktree 会话能看到它，再重载。
    const project = projects.find((entry) => entry.id === candidate.projectId);
    if (project) {
      ensureWorktreePiLink(project, candidate.workspaceCwd);
    }
    if (skillsOnly) {
      // The loader's filter reads `capabilityPaths` by reference, so refresh it first and
      // then let pi re-run its own skill pass. Fall through to the full reload only when
      // pi does not expose that entry point.
      await refreshRuntimeCapabilityPaths(candidate);
      if (reloadRuntimeSkills(candidate)) {
        return;
      }
    }
    await candidate.settingsManager.reload();
    await refreshRuntimeCapabilityPaths(candidate);
    await candidate.session.reload();
  }));
}

function skillSummaries(resourceLoader) {
  return resourceLoader.getSkills().skills.map((skill) => ({
    name: skill.name,
    path: skill.filePath,
  }));
}

function resolveToolPath(input, cwd) {
  const path = String(input ?? "").trim().replace(/^@+/, "");
  if (!path) {
    throw new Error("sourcePath is required.");
  }

  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return resolve(cwd, path);
}

function assertSkillDirectory(path) {
  if (!existsSync(path)) {
    throw new Error(`Skill source does not exist: ${path}`);
  }

  const stats = statSync(path);
  if (!stats.isDirectory()) {
    throw new Error(`Skill source must be a directory: ${path}`);
  }

  if (!existsSync(join(path, "SKILL.md"))) {
    throw new Error(`Skill source must contain SKILL.md: ${path}`);
  }
}

function assertWritableSkillRoot(skillRoot) {
  assertWritableSkillTarget(skillRoot);

  if (!existsSync(skillRoot)) {
    throw new Error(`Installed skill not found: ${skillRoot}`);
  }

  if (!statSync(skillRoot).isDirectory()) {
    throw new Error(`Installed skill must be a directory: ${skillRoot}`);
  }
}

function assertWritableSkillTarget(skillRoot) {
  if (isBuiltinSkillPath(skillRoot)) {
    throw new Error("Built-in skills are read-only. Copy the skill to the user or current project skills directory before editing it.");
  }
}

function assertWritableSkillFile(skillRoot, absolutePath) {
  const normalizedRoot = resolve(skillRoot);
  const normalizedPath = resolve(absolutePath);

  if (!isPathInside(normalizedRoot, normalizedPath)) {
    throw new Error("Skill file must stay inside the selected skill directory.");
  }

  if (existsSync(normalizedPath)) {
    const realTarget = realpathSync(normalizedPath);
    if (isBuiltinSkillPath(realTarget) || !isPathInside(normalizedRoot, realTarget)) {
      throw new Error("Skill file resolves outside the selected skill directory.");
    }
    return;
  }

  let existingParent = dirname(normalizedPath);
  while (existingParent !== normalizedRoot && !existsSync(existingParent)) {
    const nextParent = dirname(existingParent);
    if (nextParent === existingParent) {
      break;
    }
    existingParent = nextParent;
  }

  if (existsSync(existingParent)) {
    const realParent = realpathSync(existingParent);
    if (isBuiltinSkillPath(realParent) || !isPathInside(normalizedRoot, realParent)) {
      throw new Error("Skill file resolves outside the selected skill directory.");
    }
  }
}

function isBuiltinSkillPath(path) {
  const normalized = resolve(path);
  const builtinRoot = resolve(appSkillsDir);
  if (isPathInside(builtinRoot, normalized)) {
    return true;
  }

  if (!existsSync(normalized)) {
    return false;
  }

  try {
    return isPathInside(builtinRoot, realpathSync(normalized));
  } catch {
    return false;
  }
}

function directoriesHaveSameContent(left, right) {
  if (!existsSync(left) || !existsSync(right)) {
    return false;
  }

  const leftStats = statSync(left);
  const rightStats = statSync(right);
  if (leftStats.isDirectory() !== rightStats.isDirectory()) {
    return false;
  }

  if (!leftStats.isDirectory()) {
    return leftStats.size === rightStats.size && readFileSync(left).equals(readFileSync(right));
  }

  const leftEntries = readdirSync(left, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  const rightEntries = readdirSync(right, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();

  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (let index = 0; index < leftEntries.length; index += 1) {
    if (leftEntries[index] !== rightEntries[index]) {
      return false;
    }

    if (!directoriesHaveSameContent(join(left, leftEntries[index]), join(right, rightEntries[index]))) {
      return false;
    }
  }

  return true;
}

function getInstalledSkillRoot(project, scope) {
  return scope === "user"
    ? agentSkillsDir
    : join(project.cwd, ".pi", "skills");
}

function getInstalledSkillPath(project, scope, skillName) {
  return resolve(getInstalledSkillRoot(project, scope), skillName);
}

function getSkillVersionsRoot(project, scope) {
  return scope === "user"
    ? join(agentDir, "skill-versions")
    : join(project.cwd, ".pi", "skill-versions");
}

function getSkillVersionDir(project, scope, skillName, versionId) {
  return join(getSkillVersionsRoot(project, scope), skillName, versionId);
}

async function snapshotInstalledSkillVersion(project, scope, skillName, skillRoot, reason) {
  if (!existsSync(skillRoot)) {
    return { versionId: null, snapshotPath: null };
  }

  const versionId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const versionDir = getSkillVersionDir(project, scope, skillName, versionId);
  const snapshotPath = join(versionDir, "files");

  mkdirSync(versionDir, { recursive: true });
  cpSync(skillRoot, snapshotPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });

  writeVersionMetadata(versionDir, {
    versionId,
    skillName,
    scope,
    reason,
    createdAtMs: Date.now(),
    createdAt: new Date().toISOString(),
    skillRoot,
  });

  return { versionId, snapshotPath };
}

function writeVersionMetadata(versionDir, meta) {
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function readVersionMetadata(versionDir) {
  const metaPath = join(versionDir, "meta.json");
  if (!existsSync(metaPath)) {
    return null;
  }

  try {
    const raw = readFileSync(metaPath, "utf8");
    const meta = JSON.parse(raw);
    if (!meta || typeof meta !== "object") {
      return null;
    }

    return {
      versionId: String(meta.versionId ?? basename(versionDir)),
      skillName: String(meta.skillName ?? ""),
      scope: String(meta.scope ?? ""),
      reason: typeof meta.reason === "string" ? meta.reason : "",
      createdAt: String(meta.createdAt ?? ""),
      createdAtMs: Number(meta.createdAtMs ?? 0),
    };
  } catch {
    return null;
  }
}

function normalizeSkillRelativePath(value) {
  const path = String(value ?? "").trim().replace(/^@+/, "");
  if (!path) {
    throw new Error("relativePath is required.");
  }

  const normalized = path.replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("relativePath is invalid.");
  }

  if (normalized.split(/[\\/]+/).includes("..")) {
    throw new Error("relativePath cannot traverse outside the skill directory.");
  }

  return normalized;
}

function normalizeSkillFolderName(value, fallback) {
  const name = String(value ?? fallback ?? "").trim();
  if (!name) {
    throw new Error("Skill destination name is required.");
  }

  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error("Skill destination name may only contain letters, numbers, dots, underscores, and hyphens.");
  }

  return name;
}

async function setModelConfiguration(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const provider = String(body?.provider ?? "").trim();
  const modelId = String(body?.model ?? "").trim();
  const thinkingLevel = normalizeThinkingLevel(body?.thinkingLevel ?? targetRuntime.session.thinkingLevel ?? "off");
  const apiKey = String(body?.apiKey ?? "").trim();
  if (!provider || !modelId) {
    throw new Error("provider and model are required");
  }

  if (isSessionBusy(targetRuntime.session)) {
    throw new Error("The current reply is still running — stop it before switching models.");
  }

  if (apiKey) {
    persistModelApiKey(provider, apiKey);
    await modelRuntime.setRuntimeApiKey(provider, apiKey);
  }

  const model = resolveModel(provider, modelId);
  if (!model) {
    throw new Error(`Unknown model: ${provider}/${modelId}`);
  }

  // 新任务从哪个模型/等级开始 = 按项目记在 projects.json（composerDefaults），且只有「还没提交过
  // 消息」的新会话里改才算数；历史会话里切模型只管这条会话自己。pi 的 setModel()/setThinkingLevel()
  // 都会顺手写全局 settings，一律挡掉，改由 rememberProjectComposerDefaults 记到项目上。
  const remember = isFreshSession(targetRuntime.session);
  const restore = silenceGlobalModelWrites(targetRuntime.settingsManager);
  try {
    await targetRuntime.session.setModel(model);
    targetRuntime.session.setThinkingLevel(thinkingLevel);
  } finally {
    restore();
  }
  if (remember) {
    rememberProjectComposerDefaults(targetRuntime.projectId, {
      provider: model.provider,
      model: model.id,
      thinkingLevel: targetRuntime.session.thinkingLevel,
    });
  }
  await targetRuntime.settingsManager.flush();
  return buildSnapshot(targetRuntime);
}

/**
 * 自定义模型读写。文件唯一真相是 `~/.pi/agent/models.json`，这里只负责：
 * 读T解析T只改目标 providerT原子写回T让 runtime 重新加载，不丢注释以外的字段。
 */
function readCustomModelsConfig() {
  const raw = existsSync(modelsJsonFile) ? readFileSync(modelsJsonFile, "utf8") : "";
  return parseModelsConfig(raw, displayAgentPath(modelsJsonFile));
}

function writeCustomModelsConfig(config) {
  mkdirSync(dirname(modelsJsonFile), { recursive: true });
  // 先写同目录临时文件再 rename：中途崩了不会把用户唯一的模型配置留成半截 JSON。
  const tempFile = `${modelsJsonFile}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tempFile, 0o600);
  renameSync(tempFile, modelsJsonFile);
}

function displayAgentPath(path) {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function customModelsPayload() {
  const config = readCustomModelsConfig();
  const available = new Set(modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
  return {
    modelsPath: displayAgentPath(modelsJsonFile),
    customModels: listCustomModels(config).map((entry) => {
      // 从内置目录挑的模型只写了 id + 少量字段，cost/compat/上下文这些由 pi 继承内置目录，
      // 所以展示时要拿 runtime 的“合并后”值，否则列表里会显示成默认 128k。
      const runtime = modelRuntime.getModel(entry.providerId, entry.model);
      return {
        ...entry,
        ...(runtime ? {
          modelLabel: entry.modelLabel === entry.model ? (runtime.name || entry.modelLabel) : entry.modelLabel,
          contextWindow: runtime.contextWindow ?? entry.contextWindow,
          maxTokens: runtime.maxTokens ?? entry.maxTokens,
          reasoning: Boolean(runtime.reasoning),
          supportsImages: Array.isArray(runtime.input) ? runtime.input.includes("image") : entry.supportsImages,
          baseUrl: runtime.baseUrl || entry.baseUrl,
          api: runtime.api || entry.api,
        } : {}),
        apiKeyConfigured: modelRuntime.hasConfiguredAuth(entry.providerId),
        builtin: builtInProviderIds().has(entry.providerId),
        available: available.has(`${entry.providerId}/${entry.model}`),
      };
    }),
  };
}

// 内置 provider id 只认 pi 自己的目录，models.json 里的条目不算。
// 构造 40 多个 provider 对象不便宜，算一次记住；失败也不重算（下次重启进程才有新目录）。
let builtInProviderIdCache = null;
function builtInProviderIds() {
  if (builtInProviderIdCache) {
    return builtInProviderIdCache;
  }
  try {
    builtInProviderIdCache = new Set(builtinProviders().map((provider) => provider.id));
  } catch {
    builtInProviderIdCache = new Set();
  }
  return builtInProviderIdCache;
}

/** 「选择已有供应商」的列表：pi 内置的 + models.json 里已经存过的。 */
function modelProviderCatalog() {
  return normalizeProviderCatalog(providerRows());
}

/**
 * 单家供应商的详情（带模型列表）。
 *
 * 只有这一个口回传明文 apiKey：弹窗要把已存的 key 填回输入框（默认密文、点眼睛看明文）。
 * 列表口 `/api/model-providers` 不带 key —— 一次把 40 多家的 key 全吐出去没必要，也不该留在那个
 * 会被别处复用的形状里。OAuth 鉴权的供应商没有 key 可给，readStoredApiKey 自己会回空串。
 */
function providerCatalogRow(providerId) {
  const row = providerRows({ withModelsFor: providerId }).find((candidate) => candidate.id === providerId);
  if (!row) {
    return null;
  }
  const normalized = normalizeProviderCatalog([row], { withModels: true })[0];
  return normalized ? { ...normalized, apiKey: readStoredApiKey(row.id) } : null;
}

/**
 * runtime 的 provider 只告诉我们「有哪些」，两种「来源」得自己标：
 * models.json 里存过 = 用户加的；pi 内置目录里有 = 内置供应商。
 * 模型列表按 `withModelsFor` 只展开需要的那一家，41 家全展开一次就是上千条。
 */
function providerRows({ withModelsFor = "" } = {}) {
  const configProviders = readCustomModelsConfig().providers ?? {};
  const inModelsJson = new Set(Object.keys(configProviders));
  const builtins = builtInProviderIds();
  return modelRuntime.getProviders().map((provider) => {
    const authConfigured = modelRuntime.hasConfiguredAuth(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      // runtime 的 provider 不暴露 api，只能从 models.json 拿（内置的没有，行级 api 已经够了）。
      api: String(configProviders[provider.id]?.api ?? "").trim(),
      models: provider.id === withModelsFor ? modelRuntime.getModels(provider.id) ?? [] : [],
      modelCount: modelRuntime.getModels(provider.id)?.length ?? 0,
      authConfigured,
      authKind: modelRuntime.isUsingOAuth(provider.id) ? "oauth" : authConfigured ? "api_key" : "none",
      authMethods: Object.keys(provider.auth ?? {}),
      registered: inModelsJson.has(provider.id),
      builtin: builtins.has(provider.id),
    };
  });
}

/**
 * 填了 key 就把它存下来，然后把这个供应商的模型列表端出来。
 *
 * 两家供应商的“列表在哪”不一样：
 *   · pi 内置供应商：provider 自己带了远端列表能力，`modelRuntime.refresh({ allowNetwork: true })` 就能拿到；
 *   · `models.json` 里用户自己加的：runtime 里没有这个能力（provider 没 `refreshModels`），
 *     refresh 是静默 no-op，只能我们按 api 类型自己 GET 一次端点的列表接口。
 * 拉不动就退回本地已知目录 —— 目录里有的模型 pi 本来就能调用，不该因为网络抖动加不了。
 */
async function discoverProviderModels(body) {
  const providerId = String(body?.providerId ?? "").trim();
  if (!providerId) {
    throw new Error("Pick a provider first.");
  }
  if (!modelRuntime.getProvider(providerId)) {
    throw new Error("Unknown provider. Pick it again.");
  }

  const apiKey = String(body?.apiKey ?? "").trim();
  if (apiKey) {
    if (!isProbablyKeyValue(apiKey)) {
      throw new Error("The API key must not contain spaces or line breaks.");
    }
    persistModelApiKey(providerId, apiKey);
    await modelRuntime.setRuntimeApiKey(providerId, apiKey).catch(() => undefined);
  }

  // 能不能让 runtime 拉，看的是 provider 有没有实现 refreshModels，不看它“像不像内置”。
  const runtimeCanList = providerSupportsRuntimeListing(providerId);

  let refreshed = false;
  let warning = "";
  try {
    const result = await withTimeout(
      modelRuntime.refresh({ providers: [providerId], allowNetwork: true, force: true }),
      12_000,
      "Timed out fetching the model list; using the local catalog.",
    );
    const errors = result?.errors;
    if (errors && typeof errors[Symbol.iterator] === "function" && errors.size !== 0) {
      const first = [...errors.values()][0];
      warning = first?.message ?? String(first);
    } else {
      // 只有 runtime 真的会联网拉的供应商，才配说“已刷新”；自定义 provider 这里什么都没发生。
      refreshed = runtimeCanList;
    }
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
  }

  const row = providerCatalogRow(providerId);
  let models = row?.models ?? [];

  if (!runtimeCanList) {
    const listingBaseUrl = String(row?.baseUrl || providerConfigBaseUrl(providerId) || "").trim();
    if (!listingBaseUrl) {
      // 内置供应商里 Bedrock / Vertex 这类根本没有 HTTP 端点（鉴权也不走 API key）。
      // 目录就是它们能给出的最新列表，别拿一句 “Base URL is required.” 去砸用户。
      warning = "This provider is built into pi and has no endpoint to refresh from \u2014 the list below is pi's catalog.";
    } else {
      const listing = await requestModelListing({
        api: providerListingApi(providerId, models),
        baseUrl: listingBaseUrl,
        apiKey: apiKey || readStoredApiKey(providerId),
      });
      if (listing.ok) {
        models = mergeListingRows({
          listing: listing.models,
          localModels: row?.models ?? [],
          api: listing.api,
          baseUrl: normalizeBaseUrl(listingBaseUrl),
        });
        refreshed = true;
        warning = "";
      } else if (!warning) {
        warning = listing.error;
      }
    }
  }

  return {
    ok: true,
    providerId,
    // discover 的响应里不带 key：key 只从「单家详情」那个口出去。
    provider: row ? { ...row, models: undefined, apiKey: undefined } : null,
    models,
    authConfigured: modelRuntime.hasConfiguredAuth(providerId),
    refreshed,
    warning,
  };
}

/** runtime 会不会替这家供应商联网拉列表（内置 provider 有 `refreshModels`，models.json 里没有）。 */
function providerSupportsRuntimeListing(providerId) {
  try {
    return typeof modelRuntime.getProvider(providerId)?.refreshModels === "function";
  } catch {
    return false;
  }
}

/** 列表按哪种 api 拼：文件里 provider 级优先，其次看已有的模型行，最后才按 OpenAI 兼容猜。 */
function providerListingApi(providerId, models = []) {
  return providerConfigValue(providerId, "api")
    || String(models.find((model) => model?.api)?.api ?? "").trim()
    || "openai-completions";
}

function providerConfigBaseUrl(providerId) {
  return String(providerConfigValue(providerId, "baseUrl") ?? "").trim();
}

function providerConfigValue(providerId, key) {
  const providers = readCustomModelsConfig().providers ?? {};
  const id = Object.keys(providers).find((candidate) => candidate.toLowerCase() === providerId.toLowerCase());
  const value = id ? providers[id]?.[key] : undefined;
  return value === undefined || value === null ? "" : String(value).trim();
}

/**
 * 改一个自定义供应商的 provider 级设置（名字 / 端点 / api 类型），可选顺手换 key。
 *
 * 内置供应商不给改：models.json 里给内置 id 写 baseUrl 会把那家所有模型都盖到同一个地址上
 * （xai / azure 这种一家多地址的会被改坏），它们的鉴权也是 pi 自己的事。
 */
async function updateProvider(body) {
  const providerId = String(body?.providerId ?? "").trim();
  if (!providerId) {
    throw new Error("Pick a provider first.");
  }
  if (builtInProviderIds().has(providerId)) {
    throw new Error("Built-in providers are managed by pi — only the API key can be changed.");
  }
  // key 格式先校：不然报错之前已经把 models.json 写了半截。
  const apiKey = String(body?.apiKey ?? "").trim();
  if (apiKey && !isProbablyKeyValue(apiKey)) {
    throw new Error("The API key must not contain spaces or line breaks.");
  }
  const result = updateProviderSettings(readCustomModelsConfig(), {
    providerId,
    name: body?.name,
    baseUrl: body?.baseUrl,
    api: body?.api,
  });
  writeCustomModelsConfig(result.config);
  if (apiKey) {
    persistModelApiKey(result.providerId, apiKey);
    await modelRuntime.setRuntimeApiKey(result.providerId, apiKey).catch(() => undefined);
  }
  await reloadCustomModelProviders([result.providerId]);
  return {
    ...customModelsPayload(),
    providerId: result.providerId,
    baseUrl: result.baseUrl,
    api: result.api,
    availableModels: listAvailableModels(),
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function currentDefaultModel() {
  const provider = runtime.settingsManager.getDefaultProvider() ?? "";
  const model = runtime.settingsManager.getDefaultModel() ?? "";
  return provider && model ? { provider, model } : null;
}

/** 删掉的模型正好是默认模型时，把默认值换到一个还能用的模型上，别留个断链。 */
function repairDefaultModelAfterRemoval() {
  const current = currentDefaultModel();
  if (!current || usableDefaultModel(runtime.settingsManager)) {
    return;
  }
  const fallback = defaultComposerModel();
  if (!fallback) {
    return;
  }
  runtime.settingsManager.setDefaultProvider(fallback.provider);
  runtime.settingsManager.setDefaultModel(fallback.id);
  void runtime.settingsManager.flush().catch(() => undefined);
}

/**
 * 输入框下拉列表的“第一个模型”，也是没记住任何选择时新会话的起点。
 *
 * 顺序必须和 `buildComposerModelOptions` 一致：自定义模型在前（按 models.json 里的顺序），
 * 其后是已配好鉴权的内置模型。两边各排各的会出现“下拉框选中第一项、实际用的是另一项”。
 */
function defaultComposerModel() {
  const available = new Set(modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
  for (const entry of listCustomModels(readCustomModelsConfig())) {
    if (!entry.managed || !entry.model) {
      continue;
    }
    const model = resolveModel(entry.providerId, entry.model);
    if (model && available.has(`${model.provider}/${model.id}`)) {
      return model;
    }
  }
  return modelRuntime.getAvailableSnapshot()[0];
}

async function saveCustomModel(body) {
  const config = readCustomModelsConfig();
  const targetProviderId = String(body?.targetProviderId ?? "").trim();
  const targetModel = String(body?.targetModel ?? "").trim();
  const existing = targetProviderId && targetModel
    ? findCustomModel(config, targetProviderId, targetModel)
    : undefined;
  if (targetProviderId && targetModel && !existing) {
    throw new Error("That model is no longer there. Reopen settings.");
  }

  // 先按 upsert 的同一套规则算出这条草稿会落到哪个 provider，再决定“没 key 行不行”：
  // 往已有供应商里加第二个模型时，key 早就存过了，不该再逼用户填一遍。
  const target = existing ? { providerId: targetProviderId, model: targetModel } : undefined;
  // 探一次“这条草稿会落到哪家”：内置供应商在 models.json 里根本没有 baseUrl，probe 不能拿它当
  // 必填 —— 否则“往内置供应商加模型”在这步就 500（真正的 builtin/custom 判定仍在下面按 resolvedId 做）。
  const probeBody = builtInProviderIds().has(String(body?.providerId ?? "").trim())
    ? { ...body, providerMode: "builtin" }
    : body;
  const probe = normalizeCustomModelInputs(probeBody, { requireApiKey: false })[0];
  const resolvedId = resolveProviderTarget(config, probe, target).providerId;
  const hasStoredKey = Boolean(readStoredApiKey(resolvedId)) || modelRuntime.hasConfiguredAuth(resolvedId);
  // 落到 pi 内置供应商上时只补模型行，baseUrl/authHeader 由内置 provider 自己管。
  const builtinTarget = builtInProviderIds().has(resolvedId);
  const bodyWithMode = { ...body, providerMode: builtinTarget ? "builtin" : "custom" };
  // 内置供应商的鉴权是 pi 自己的事（env / OAuth / 之后 /login 都行），没 key 也允许先把模型加进来，
  // 列表里会标成 "no API key"。自定义端点没 key 就什么都调不了，必须填。
  const requireApiKey = !hasStoredKey && !builtinTarget;
  const entries = normalizeCustomModelInputs(bodyWithMode, { hasStoredKey, requireApiKey });
  // models.json 的模型行会整条盖掉内置目录，所以写之前先把目录里的 cost/compat/thinkingLevelMap
  // 抄进新行 —— 不然加一个 Claude 进去就变成免费模型、思考等级映射也没了。
  const seeds = {};
  for (const entry of entries) {
    const seed = catalogSeedFromModel(modelRuntime.getModel(resolvedId, entry.model.id));
    if (seed) {
      seeds[entry.model.id] = seed;
    }
  }
  const result = upsertCustomModels(config, entries, { target, seeds });

  writeCustomModelsConfig(result.config);
  const apiKey = entries[0]?.apiKey.trim() ?? "";
  if (apiKey) {
    for (const providerId of result.providerIds) {
      persistModelApiKey(providerId, apiKey);
      await modelRuntime.setRuntimeApiKey(providerId, apiKey).catch(() => undefined);
    }
  }
  await reloadCustomModelProviders([...result.providerIds, result.previousProviderId]);

  return {
    ...customModelsPayload(),
    providerId: result.providerId,
    model: result.modelId,
    models: result.models,
    availableModels: listAvailableModels(),
  };
}

async function deleteCustomModel(body) {
  const config = readCustomModelsConfig();
  const result = removeCustomModel(config, {
    providerId: String(body?.providerId ?? "").trim(),
    model: String(body?.model ?? "").trim(),
  });

  writeCustomModelsConfig(result.config);
  if (result.providerRemoved) {
    await modelRuntime.removeRuntimeApiKey(result.providerId).catch(() => undefined);
    dropStoredApiKey(result.providerId);
  }
  await reloadCustomModelProviders([result.providerId]);
  repairDefaultModelAfterRemoval();

  return { ...customModelsPayload(), availableModels: listAvailableModels() };
}

async function reloadCustomModelProviders(providerIds) {
  const targets = [...new Set(providerIds.filter(Boolean))];
  try {
    await modelRuntime.refresh({ providers: targets.length ? targets : undefined, allowNetwork: false });
  } catch {
    // 加载失败不能吞掉已写入的配置：下一次 bootstrap 会重新拼出可用列表。
  }
}

async function testCustomModelConnection(body) {
  const baseUrl = normalizeBaseUrl(body?.baseUrl);
  const providerId = String(body?.providerId ?? body?.targetProviderId ?? "").trim();
  // 没填就用已存的那份；两边都没有也不是错：拉列表本身可以不带鉴权（本地网关），
  // 真需要 key 的端点会回 401，那句报错比在门口拦下来更说得清。以前这里空 key 直接报错，
  // 结果用户填完地址也按不动 Fetch，看上去就像这个弹窗干不了事。
  const apiKey = String(body?.apiKey ?? "").trim() || readStoredApiKey(providerId);

  // 不同 api 类型的列表端点/鉴权头都不一样（Anthropic 不认 Bearer，Google 走 x-goog-api-key）。
  const plan = listingPlan(body?.api, baseUrl, apiKey);
  if (plan.unsupported) {
    return { ok: false, error: plan.unsupported, endpoint: "" };
  }

  const modelId = String(body?.model ?? "").trim();
  const openAiFamily = ["openai-completions", "openai-responses", "openai-codex-responses", "mistral-conversations"]
    .includes(plan.api);
  try {
    const listed = await requestOpenAiJson(plan.url, { headers: plan.headers, signal: AbortSignal.timeout(10_000) });
    const listing = plan.extract(listed.payload);
    const models = listing.map((model) => model.id);
    return {
      ok: true,
      api: plan.api,
      endpoint: plan.url,
      models: modelId && !models.includes(modelId) ? [modelId, ...models] : models,
      listing: modelId && !models.includes(modelId) ? [{ id: modelId, name: prettifyModelId(modelId) }, ...listing] : listing,
    };
  } catch (error) {
    const status = error?.status;
    // 不少 OpenAI 兼容网关不实现 /models，404 时用一次最小对话请求探测真实性。
    if (status === 404 && modelId && openAiFamily) {
      try {
        await requestOpenAiJson(chatCompletionsUrl(baseUrl), {
          apiKey,
          signal: AbortSignal.timeout(15_000),
          payload: { model: modelId, messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
        });
        return { ok: true, api: plan.api, endpoint: chatCompletionsUrl(baseUrl), models: [modelId], listing: [{ id: modelId, name: prettifyModelId(modelId) }] };
      } catch (probeError) {
        return { ok: false, error: describeConnectionFailure(baseUrl, probeError) };
      }
    }
    return { ok: false, error: describeConnectionFailure(baseUrl, error) };
  }
}

/** 内置供应商只能改 key：单独一个口，不碰 models.json 里的任何字段。 */
async function saveProviderApiKey(body) {
  const providerId = String(body?.providerId ?? "").trim();
  if (!providerId) {
    throw new Error("Pick a provider first.");
  }
  const apiKey = String(body?.apiKey ?? "").trim();
  if (!apiKey) {
    throw new Error("API key is required.");
  }
  if (!isProbablyKeyValue(apiKey)) {
    throw new Error("The API key must not contain spaces or line breaks.");
  }
  persistModelApiKey(providerId, apiKey);
  return customModelsPayload();
}

async function requestOpenAiJson(endpoint, { apiKey, payload, signal, headers }) {
  const key = String(apiKey ?? "").trim();
  const response = await fetch(endpoint, {
    method: payload ? "POST" : "GET",
    headers: {
      // 没 key 就不发空头（同 listingPlan 的规矩）：`Bearer ` 会被严一点的服务端直接 400。
      ...(headers ?? (key ? { authorization: `Bearer ${key}` } : {})),
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal,
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.body = text.slice(0, 300);
    throw error;
  }
  try {
    return { payload: JSON.parse(text) };
  } catch {
    const error = new Error("端点返回的不是 JSON。");
    error.status = response.status;
    error.body = text.slice(0, 200);
    throw error;
  }
}

function readAuthCredentials() {
  if (!existsSync(authFile)) {
    return {};
  }
  const raw = readFileSync(authFile, "utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid model auth storage.");
  }
  return parsed;
}

function readStoredApiKey(provider) {
  if (!provider) {
    return "";
  }
  const credential = readAuthCredentials()[provider];
  return credential?.type === "api_key" ? String(credential.key ?? "") : "";
}

function dropStoredApiKey(provider) {
  if (!provider || !existsSync(authFile)) {
    return;
  }
  const credentials = readAuthCredentials();
  if (!Object.hasOwn(credentials, provider)) {
    return;
  }
  delete credentials[provider];
  writeFileSync(authFile, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(authFile, 0o600);
}

async function setPersonalization(body) {
  const style = normalizePersonalizationStyle(body?.style);
  const customInstructions = normalizePersonalizationText(body?.customInstructions, 1500, "customInstructions");
  const persona = normalizePersonalizationText(body?.persona, 1000, "persona");
  const extensionUi = normalizeExtensionUiMode(body?.extensionUi);
  personalization = { style, customInstructions, persona, extensionUi };
  writeJsonFile(personalizationFile, personalization);
  return buildSnapshot(getRuntimeForRequest(body));
}

function normalizePersonalizationStyle(value) {
  const style = String(value ?? "").trim();
  return Object.hasOwn(personalizationStyles, style) ? style : "default";
}

function normalizePersonalizationText(value, maxLength, name) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) {
    throw new Error(`${name} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function persistModelApiKey(provider, apiKey) {
  const credentials = readAuthCredentials();

  credentials[provider] = { type: "api_key", key: apiKey };
  mkdirSync(dirname(authFile), { recursive: true });
  writeFileSync(authFile, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(authFile, 0o600);
}

async function setSessionThinkingLevel(body) {
  const targetRuntime = getRuntimeForRequest(body);
  if (isSessionBusy(targetRuntime.session)) {
    throw new Error("Stop the running response before switching thinking.");
  }

  const thinkingLevel = normalizeThinkingLevel(body?.thinkingLevel ?? targetRuntime.session.thinkingLevel ?? "off");
  // 只有「还没提交过消息」的新会话里改，才算改写「新任务从哪个等级开始」；历史会话里改只管
  // 这条会话自己。pi 的 setThinkingLevel() 会顺手写全局 settings，一律挡掉（见 sessionModelPolicy）。
  const remember = isFreshSession(targetRuntime.session);
  const restore = silenceGlobalModelWrites(targetRuntime.settingsManager);
  try {
    targetRuntime.session.setThinkingLevel(thinkingLevel);
  } finally {
    restore();
  }
  if (remember) {
    rememberProjectComposerDefaults(targetRuntime.projectId, { thinkingLevel: targetRuntime.session.thinkingLevel });
  }
  await targetRuntime.settingsManager.flush();
  return buildSnapshot(targetRuntime);
}

function normalizeThinkingLevel(value) {
  const thinkingLevel = String(value ?? "").trim();
  return THINKING_LEVELS.includes(thinkingLevel) ? thinkingLevel : "off";
}

function resolveModel(provider, modelId) {
  const exact = modelRuntime.getModel(provider, modelId);
  if (exact) {
    return exact;
  }

  const matches = modelRuntime.getModels(provider).find((model) =>
    model.id.toLowerCase() === modelId.toLowerCase() || String(model.name ?? "").toLowerCase() === modelId.toLowerCase(),
  );
  return matches ?? undefined;
}

function isUsableModel(model) {
  return Boolean(model && model.provider && model.id && model.provider !== "unknown" && model.id !== "unknown");
}

async function createProject(body) {
  const cwd = resolve(String(body?.cwd ?? "").trim() || appCwd);
  mkdirSync(cwd, { recursive: true });
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Project folder is not a directory: ${cwd}`);
  }

  const existing = findProjectByFolder(projects, cwd);
  if (existing) {
    // That folder is already tracked: switch to the existing project instead of
    // adding a second one for it, and say so — the dialog reads this field to
    // tell the user the folder was opened, not created.
    const snapshot = await selectProject(existing.id);
    return {
      ...snapshot,
      existingProject: { id: existing.id, name: existing.name, cwd: existing.cwd },
    };
  }

  const now = Date.now();
  const name = String(body?.name ?? "").trim() || basename(cwd) || "Project";
  const project = {
    id: createProjectId(name),
    name,
    cwd,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    sessionPins: {},
  };

  projects = [...projects, project];
  activeProjectId = project.id;
  saveProjects();
  return replaceRuntime(project);
}

async function selectProject(projectId) {
  const project = findProject(projectId);
  activeProjectId = project.id;
  saveProjects();
  return replaceRuntime(project, project.lastSessionPath);
}

async function trustProject(projectId) {
  const project = findProject(projectId);
  const trustStore = new ProjectTrustStore(agentDir);
  trustStore.set(project.cwd, true);

  const targets = [...openRuntimes.values()].filter((candidate) => candidate.projectId === project.id);
  for (const target of targets) {
    target.settingsManager.setProjectTrusted(true);
  }

  await reloadOpenRuntimeCapabilities(project.id);
  return refreshSnapshot();
}

async function updateProject(body) {
  const project = findProject(String(body?.projectId ?? ""));
  const name = String(body?.name ?? "").trim() || project.name;
  const cwdInput = String(body?.cwd ?? project.cwd).trim();
  const cwd = resolve(cwdInput || project.cwd);

  mkdirSync(cwd, { recursive: true });
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Project folder is not a directory: ${cwd}`);
  }

  const cwdChanged = cwd !== project.cwd;
  if (cwdChanged) {
    disposeProjectRuntimes(project.id);
  }

  projects = projects.map((candidate) =>
    candidate.id === project.id
      ? {
          ...candidate,
          name,
          cwd,
          updatedAt: Date.now(),
        }
      : candidate,
  );
  saveProjects();

  const updated = findProject(project.id);
  if (cwdChanged && updated.id === activeProjectId) {
    return replaceRuntime(updated, updated.lastSessionPath);
  }

  return refreshSnapshot();
}

async function reorderProjects(body) {
  const requestedIds = Array.isArray(body?.projectIds)
    ? body.projectIds.map((projectId) => String(projectId ?? "").trim()).filter(Boolean)
    : [];
  const knownIds = new Set(projects.map((project) => project.id));
  const reorderedIds = [
    ...requestedIds.filter((projectId, index) => knownIds.has(projectId) && requestedIds.indexOf(projectId) === index),
    ...projects.map((project) => project.id).filter((projectId) => !requestedIds.includes(projectId)),
  ];

  if (reorderedIds.length !== projects.length) {
    throw new Error("Invalid project order");
  }

  const projectsById = new Map(projects.map((project) => [project.id, project]));
  projects = reorderedIds.map((projectId) => projectsById.get(projectId));
  saveProjects();
  return refreshSnapshot();
}

async function pinProject(projectId, pinned) {
  const project = findProject(projectId);
  touchProject(project.id, { pinned: Boolean(pinned) });
  return refreshSnapshot();
}

async function removeProject(projectId) {
  const project = findProject(projectId);
  if (projects.length <= 1) {
    throw new Error("Cannot remove the last project");
  }

  disposeProjectRuntimes(project.id);
  projects = projects.filter((candidate) => candidate.id !== project.id);
  sessionStore.deleteProject(project.id);
  activeProjectId = activeProjectId === project.id ? projects[0].id : activeProjectId;
  saveProjects();

  if (project.id === runtime.projectId) {
    return replaceRuntime(activeProject(), activeProject().lastSessionPath);
  }

  return refreshSnapshot();
}

async function revealProject(projectId) {
  const project = findProject(projectId);
  await revealFolder(project.cwd);
  return refreshSnapshot();
}

async function createProjectSession(projectId, nameValue, worktreeRequest) {
  const project = findProject(projectId);
  activeProjectId = project.id;
  saveProjects();

  // worktree 必须在建会话之前建好：会话文件头里的 cwd 就是 worktree 路径（pi 的
  // `SessionManager.create(cwd, dir)` 会写进去），所以建失败就不建会话，不留半条记录。
  const worktree = worktreeRequest?.enabled ? await createSessionWorktree(project, worktreeRequest) : null;
  const sessionManager = SessionManager.create(worktree?.path ?? project.cwd, getProjectSessionDir(project));
  const name = String(nameValue ?? "").trim();
  if (name) {
    sessionManager.appendSessionInfo(name);
  }
  // Persist the shell immediately so a newly-created empty session can be
  // selected while its first prompt is still streaming.
  persistSessionShell(sessionManager);
  updateSessionStoreFromSession(project, sessionManager, { includeEmpty: true });
  return replaceRuntime(project, sessionManager.getSessionFile());
}

/**
 * 给新会话建一个托管 worktree（参考 Codex 桌面端：一个会话一个隔离检出、detached HEAD）。
 *
 * `baseRef` 默认 `HEAD`（当前分支的当前提交），非 Git 仓库 / 空仓库都给可读错误；
 * 建之前先 `readGitInfo` 查一次仓库，是为了把“不是仓库”和“还没有提交”分开说清楚。
 */
async function createSessionWorktree(project, request = {}) {
  const info = await readGitInfo(project.cwd);
  if (!info.isRepo) {
    throw new Error("只有 Git 仓库才能创建 worktree：先在这个项目里初始化仓库。");
  }

  const baseRef = String(request?.baseRef ?? "").trim() || "HEAD";
  const created = await createManagedWorktree(project.cwd, {
    root: worktreesRoot,
    id: managedWorktreeId(project.name, randomUUID().slice(0, 8)),
    baseRef,
  });
  diagnosticLog("worktree.created", {
    projectId: project.id,
    worktreePath: created.path,
    base: created.base,
    includedFiles: created.included.copied.length,
    skippedIncludeFiles: created.included.skipped,
    piLink: created.piLink?.reason ?? "",
  });
  return created;
}

async function selectProjectSession(projectId, sessionPath, requestId, clientTraceId) {
  const startedAt = Date.now();
  diagnosticLog("session.select.start", { requestId, clientTraceId, projectId, sessionPath });
  const project = findProject(projectId);
  if (!sessionPath) {
    throw new Error("sessionPath is required");
  }

  const projectSessionDir = getProjectSessionDir(project);
  const resolvedPath = resolve(sessionPath);
  if (!resolvedPath.startsWith(resolve(projectSessionDir))) {
    throw new Error("Session does not belong to this project");
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`Session file does not exist: ${resolvedPath}`);
  }

  activeProjectId = project.id;
  saveProjects();
  diagnosticLog("session.select.before_runtime", {
    requestId,
    clientTraceId,
    projectId: project.id,
    sessionPath: resolvedPath,
    durationMs: Date.now() - startedAt,
  });
  const response = await replaceRuntime(project, resolvedPath, { requestId, clientTraceId });
  diagnosticLog("session.select.snapshot_ready", {
    requestId,
    clientTraceId,
    projectId: project.id,
    sessionPath: resolvedPath,
    durationMs: Date.now() - startedAt,
    messageCount: response.snapshot?.conversation?.messages?.length,
  });
  return response;
}

async function updateProjectSession(projectId, sessionPath, nameValue) {
  const project = findProject(projectId);
  const resolvedPath = assertProjectSessionPath(project, sessionPath);
  const name = String(nameValue ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!name) {
    throw new Error("Session title is required");
  }

  const openRuntime = openRuntimes.get(sessionRuntimeKey(resolvedPath));
  if (openRuntime) {
    openRuntime.session.setSessionName(name);
    persistSessionShell(openRuntime.session.sessionManager);
    updateSessionStoreFromRuntime(openRuntime);
  } else {
    const sessionManager = SessionManager.open(resolvedPath, getProjectSessionDir(project));
    sessionManager.appendSessionInfo(name);
    persistSessionShell(sessionManager);
    updateSessionStoreFromSession(project, sessionManager);
  }

  return refreshSnapshot();
}

async function pinProjectSession(projectId, sessionPath, pinned) {
  const project = findProject(projectId);
  const resolvedPath = assertProjectSessionPath(project, sessionPath);
  const sessionPins = {
    ...(project.sessionPins && typeof project.sessionPins === "object" ? project.sessionPins : {}),
    [resolvedPath]: Boolean(pinned),
  };

  if (!pinned) {
    delete sessionPins[resolvedPath];
  }

  touchProject(project.id, { sessionPins });
  sessionStore.setPinned(project.id, resolvedPath, pinned);
  return refreshSnapshot();
}

async function deleteProjectSession(projectId, sessionPath) {
  const project = findProject(projectId);
  const resolvedPath = assertProjectSessionPath(project, sessionPath);
  const isActiveSession = resolvedPath === runtime.session.sessionFile;
  removeSessionRecord(project, resolvedPath);

  if (isActiveSession) {
    const sessions = listProjectSessions(findProject(project.id));
    return replaceRuntime(findProject(project.id), sessions[0]?.path);
  }

  return refreshSnapshot();
}

/**
 * 归档 / 取消归档一条会话。
 *
 * 归档只是会话索引上的一个标记，会话文件原样留在磁盘上（所以可恢复）；被归档的会话
 * 从项目的会话列表里消失，改由设置页的「归档聊天」列出。归档当前正在打开的会话时，
 * 跳回列表里的第一条未归档会话（没有就新建一条），否则活动会话会“挂着”一个不可见的会话。
 */
async function archiveProjectSession(projectId, sessionPath, archived = true) {
  const project = findProject(projectId);
  const resolvedPath = assertProjectSessionPath(project, sessionPath);
  const isActiveSession = resolvedPath === runtime.session.sessionFile;

  // 先确保索引里有这条记录：索引是归档清单的唯一来源，没登记的话归档后就找不回来了。
  const openRuntime = openRuntimes.get(sessionRuntimeKey(resolvedPath));
  if (openRuntime) {
    updateSessionStoreFromRuntime(openRuntime);
  } else if (existsSync(resolvedPath)) {
    // 不传 cwdOverride：会话文件头里的 cwd 才是它真正的工作目录（worktree 会话不能在这里
    // 被改回项目目录）。
    const sessionManager = SessionManager.open(resolvedPath, getProjectSessionDir(project));
    updateSessionStoreFromSession(project, sessionManager);
  }
  sessionStore.setArchived(project.id, resolvedPath, archived);

  if (archived && isActiveSession) {
    disposeRuntime(resolvedPath);
    const sessions = listProjectSessions(findProject(project.id));
    return replaceRuntime(findProject(project.id), sessions[0]?.path);
  }

  return refreshSnapshot();
}

/**
 * 永久删除归档会话：全部，或限某个项目。
 *
 * 归档会话不在侧栏里，但它可能仍是当前活动会话（归档那一刻起就没再切过会话），
 * 所以这里要像 deleteProjectSession 一样处理“删到活动会话”的情况。
 */
async function deleteArchivedSessions(projectId = "") {
  const archived = sessionStore.listArchived().filter((session) => !projectId || session.projectId === projectId);
  let activeSessionDeleted = false;

  for (const session of archived) {
    const project = findProject(session.projectId);
    if (!project) {
      sessionStore.remove(session.projectId, session.path);
      continue;
    }
    const resolvedPath = assertProjectSessionPath(project, session.path);
    if (resolvedPath === runtime.session.sessionFile) {
      activeSessionDeleted = true;
    }
    removeSessionRecord(project, resolvedPath);
  }

  if (activeSessionDeleted) {
    const project = findProject(runtime.projectId);
    const sessions = listProjectSessions(project);
    return replaceRuntime(project, sessions[0]?.path);
  }

  return refreshSnapshot();
}

/**
 * Delete one session's file + index row. Shared by the sidebar's permanent delete and by
 * the archived page's bulk delete so the two cannot drift apart (pins must be dropped
 * either way, otherwise unarchiving later would resurrect a stale pin).
 */
function removeSessionRecord(project, resolvedPath) {
  scheduleWorktreeCleanup(project, resolvedPath);
  disposeRuntime(resolvedPath);

  if (existsSync(resolvedPath)) {
    unlinkSync(resolvedPath);
  }
  sessionStore.remove(project.id, resolvedPath);

  const sessionPins = { ...(project.sessionPins ?? {}) };
  delete sessionPins[resolvedPath];
  touchProject(project.id, {
    sessionPins,
    lastSessionPath: project.lastSessionPath === resolvedPath ? undefined : project.lastSessionPath,
  });
}

/**
 * Rewind the session branch to just before the Nth user message (1-based, the
 * same ordinal `chatBubbleId` uses).
 *
 * pi sessions are append-only: `navigateTree` only moves the leaf pointer, it
 * never deletes entries, so the abandoned turn's token/cost usage keeps
 * accumulating in `getSessionStats()` while the UI (which reads `getBranch()`)
 * stops showing it. `summarize:false` keeps the abandoned branch out of the new
 * context without an extra model call.
 */
async function rewindSessionToTurn(session, turn) {
  if (session.isStreaming) {
    throw new Error("Wait for the current response to finish before editing.");
  }

  const manager = session.sessionManager;
  const entries = typeof manager?.getBranch === "function"
    ? manager.getBranch() ?? []
    : manager?.getEntries?.() ?? [];

  const targetEntryId = userMessageEntryIdForTurn(entries, turn);
  if (!targetEntryId) {
    throw new Error(`Message t${turn}#user is not in the current branch.`);
  }

  const result = await session.navigateTree(targetEntryId, { summarize: false });
  if (result?.cancelled) {
    throw new Error("Editing was cancelled.");
  }
}

async function streamPrompt(req, res, requestId, options = {}) {
  const promptStartedAt = Date.now();
  const body = options.body ?? await readJson(req);
  const rawInput = String(body?.input ?? "");
  const displayInput = String(body?.displayInput ?? rawInput);
  const streamingBehavior = body?.streamingBehavior === "followUp" ? "followUp" : "steer";
  const activeRuntime = getRuntimeForRequest(body);
  // 编辑重发：先回退分支，之后所有 bubble ordinal / 上下文都按回退后的分支计算。
  if (options.rewindTurn != null) {
    await rewindSessionToTurn(activeRuntime.session, options.rewindTurn);
  }
  diagnosticLog("prompt.start", {
    requestId,
    streamingBehavior,
    inputLength: rawInput.length,
    attachmentCount: Array.isArray(body?.attachments) ? body.attachments.length : 0,
    ...sessionDetails(activeRuntime),
  });
  const attachments = persistPromptAttachments(activeRuntime, body?.attachments);
  const messageParts = await normalizePromptMessageParts(activeRuntime, body?.messageParts, displayInput, attachments);
  if (!rawInput.trim() && !attachments.length) {
    throw new Error("input is required");
  }
  if (!isUsableModel(activeRuntime.session.model)) {
    throw new Error("请先选择 provider 和 model。");
  }
  if (!modelRuntime.hasConfiguredAuth(activeRuntime.session.model.provider)) {
    throw new Error(`请先配置 ${activeRuntime.session.model.provider} 的 API key。`);
  }

  const baseInput = rawInput || attachmentOnlyPrompt(attachments);
  const input = appendAttachmentContext(baseInput, displayInput, attachments, messageParts);
  const images = activeRuntime.session.model.input?.includes("image")
    ? attachments
        .filter((attachment) => attachment.kind === "image")
        .map((attachment) => ({
          type: "image",
          data: attachment.data,
          mimeType: attachment.mimeType,
        }))
    : [];

  const activeSession = activeRuntime.session;
  const wasStreaming = activeSession.isStreaming;
  const shouldTitleAfterFirstTurn = !wasStreaming && streamingBehavior !== "followUp" && shouldGenerateInitialTitle(activeRuntime);
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...corsHeaders(),
  });

  let closed = false;
  let finalAgentError = "";
  let assistantMessageStreamIndex = -1;
  // Bubble identity for this run, computed with the very same rule the snapshot
  // builder uses, so every event addresses the bubble the client already shows.
  const bubbleTracker = createBubbleTracker(countTranscriptTurns(displayTranscript(activeSession)));
  const bubbleOf = () => bubbleTracker.currentAssistant()?.bubbleId ?? null;
  const toolArgsById = new Map();
  const toolStreamIdsByCallId = new Map();
  // Identity of a thinking block across the delta stream and the cumulative
  // snapshots. Keyed by pi's own content index (not the ordinal among thinking
  // blocks) so it lines up with `contentIndex` on `thinking_delta`, even when the
  // message interleaves text and tool calls around the thinking.
  const thinkingStreamKeyOf = (contentIndex) =>
    `assistant-${assistantMessageStreamIndex}-thinking-${contentIndex}`;
  const writeEvent = (payload) => {
    if (closed || res.destroyed) {
      return;
    }

    res.write(`${JSON.stringify(payload)}\n`);
  };
  // 回退后先播一次权威快照：旧轮次从 UI 消失、剩下来的轮次编号与新 stream 一致，
  // 否则新 prompt 的 `t{turn}#...` 事件会和客户端里还没清掉的旧轮次撞号。
  if (options.rewindTurn != null) {
    // `assumeStreaming`: this snapshot is emitted before `prompt()` starts the run,
    // but the client is already showing it as streaming - without the flag the
    // snapshot would tell the client the run is over and kill the stop button.
    writeEvent({ type: "snapshot", snapshot: await buildSnapshot(activeRuntime, { assumeStreaming: true }) });
  }
  // The thinking block whose end the provider has not reported yet.
  //
  // pi streams a message's content blocks one after another, so the start of any
  // later block proves the one before it is over. That matters because the
  // OpenAI-compatible providers (`openai-completions` and friends) only finalize
  // blocks once the whole message stream has ended - measured 0.4-4.1s after the
  // last thinking token on a real session, during which the tool card below is
  // already running and the reasoning panel above would keep spinning. The
  // Anthropic-style providers close each block where it happens, so they never
  // take this path.
  //
  // The settle event is a *textless* `assistant_partial`: the client clears the
  // panel's `open` flag from it and never touches the streamed text (see
  // `projectProcessBlocks`), and the provider's real `thinking_end` still gets to
  // publish the authoritative cumulative body afterwards.
  let openThinkingKey = null;
  const settleThinking = () => {
    const key = openThinkingKey;
    if (!key) {
      return;
    }

    openThinkingKey = null;
    writeEvent({
      type: "assistant_partial",
      bubbleId: bubbleOf(),
      closeThinking: true,
      blocks: [{ type: "thinking", thinking: "", streamKey: key }],
    });
  };
  // pi reports thinking and tool-argument progress twice over: an incremental
  // `delta` *and* the cumulative `partial` message. Only the delta is forwarded per
  // token - forwarding the cumulative body would re-serialise the whole block ~60x/s
  // - but that is no reason to throttle: a 120ms coalescer here is what turned
  // reasoning into "hang, then a chunk of text" and hid the tool-argument typewriter
  // completely. The cumulative snapshot goes out at the structural edges instead.
  const unsubscribeUi = activeRuntime.uiBridge?.subscribe(writeEvent);
  const unsubscribe = activeSession.subscribe((event) => {
    if (
      event.type === "agent_start" ||
      event.type === "agent_end" ||
      event.type === "auto_retry_start" ||
      event.type === "auto_retry_end" ||
      event.type === "compaction_start" ||
      event.type === "compaction_end" ||
      event.type === "message_end"
    ) {
      diagnosticLog("session.event", {
        requestId,
        eventType: event.type,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        success: event.success,
        finalError: event.finalError,
        reason: event.reason,
        willRetry: event.willRetry,
        aborted: event.aborted,
        ...sessionDetails(activeRuntime),
      });
    }

    if (event.type === "message_start") {
      const bubble = bubbleTracker.messageStarted(event.message.role);
      if (event.message.role === "user") {
        writeEvent({
          type: "user_message_start",
          bubbleId: bubble?.bubbleId,
          turn: bubble?.turn,
          content: messageDisplayText(event.message),
        });
      }

      if (event.message.role === "assistant") {
        assistantMessageStreamIndex += 1;
        writeEvent({
          type: "assistant_message_start",
          bubbleId: bubble?.bubbleId,
          turn: bubble?.turn,
        });
      }
    }

    if (event.type === "message_end") {
      // A message that ends with a thinking block still tracked as open means
      // the provider never reported the block end (openai-completions defers
      // every finishBlock to the message tail and skips them on abort). The
      // message is over, so the thinking is over - settle before anything else
      // (tool executions, the next message) can flow past the stale key.
      if (event.message.role === "assistant") {
        settleThinking();
      }
      if (event.message.role === "user") {
        // AgentSession persists the message immediately after notifying
        // subscribers, so defer the index refresh until that append completes.
        queueMicrotask(() => updateSessionStoreFromRuntime(activeRuntime));
      }
    }

    if (event.type === "message_end" || event.type === "compaction_end") {
      // pi's usage numbers can only change when a message lands in
      // `state.messages` - exactly here - so publish them at that granularity
      // instead of making the meter wait for the end-of-run snapshot. The
      // microtask is the same deferral as above: the cumulative totals are read
      // from the persisted entries, which AgentSession appends after it has
      // finished notifying subscribers.
      queueMicrotask(() => {
        writeEvent({ type: "context_usage", ...usageFields(activeSession) });
      });
    }

    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;

      if (assistantEvent.type === "text_delta") {
        // Answer text can only follow a finished thinking block in this message.
        settleThinking();
        writeEvent({ type: "delta", bubbleId: bubbleOf(), delta: assistantEvent.delta });
      }

      if (assistantEvent.type === "thinking_delta" && assistantEvent.delta) {
        // Track from the deltas rather than `thinking_start`: some providers name
        // the block only when its first token arrives. A different key here is the
        // next thinking round beginning, which ends the one before it.
        const thinkingKey = thinkingStreamKeyOf(assistantEvent.contentIndex);
        if (openThinkingKey && openThinkingKey !== thinkingKey) {
          settleThinking();
        }
        openThinkingKey = thinkingKey;
        writeEvent({
          type: "thinking_delta",
          bubbleId: bubbleOf(),
          contentIndex: assistantEvent.contentIndex,
          thinkingStreamKey: thinkingKey,
          delta: assistantEvent.delta,
        });
      }

      if (assistantEvent.type === "thinking_end" && assistantEvent.partial?.content) {
        // Publish the authoritative cumulative text once - when the block closes.
        // `partial` is a live object the provider keeps mutating, so a snapshot
        // taken at `thinking_start` carries text belonging to deltas that are still
        // on their way: seeding a block with it and then appending those same
        // chunks is the "reasoning repeats its first chunk" bug. Nothing is lost by
        // waiting - the panel opens on the first delta anyway.
        writeEvent({
          type: "assistant_partial",
          bubbleId: bubbleOf(),
          contentIndex: assistantEvent.contentIndex,
          closeThinking: true,
          blocks: assistantThinkingBlocks(assistantEvent.partial.content, thinkingStreamKeyOf),
        });
        if (openThinkingKey === thinkingStreamKeyOf(assistantEvent.contentIndex)) {
          openThinkingKey = null;
        }
      }

      if (assistantEvent.type === "toolcall_start") {
        // A tool call is the next content block: whatever was thinking is done.
        settleThinking();
        const toolCall = partialToolCall(assistantEvent);
        const streamId = toolStreamId(assistantMessageStreamIndex, assistantEvent.contentIndex);
        if (toolCall?.id) {
          toolStreamIdsByCallId.set(toolCall.id, streamId);
        }
        writeEvent({
          type: "tool_call_stream_start",
          bubbleId: bubbleOf(),
          toolStreamId: streamId,
          contentIndex: assistantEvent.contentIndex,
          toolCallId: toolCall?.id,
          toolName: toolCall?.name,
          args: toolCall?.arguments ?? {},
        });
      }

      if (assistantEvent.type === "toolcall_delta") {
        const toolCall = partialToolCall(assistantEvent);
        const streamId = toolStreamId(assistantMessageStreamIndex, assistantEvent.contentIndex);
        if (toolCall?.id) {
          toolStreamIdsByCallId.set(toolCall.id, streamId);
        }
        // `delta` is the raw JSON text still being produced, which is exactly what
        // the argument typewriter animates; `tool_call_stream_end` follows with the
        // parsed arguments.
        writeEvent({
          type: "tool_call_stream_delta",
          bubbleId: bubbleOf(),
          toolStreamId: streamId,
          contentIndex: assistantEvent.contentIndex,
          toolCallId: toolCall?.id,
          toolName: toolCall?.name,
          argsText: assistantEvent.delta ?? "",
        });
      }

      if (assistantEvent.type === "toolcall_end") {
        const streamId = toolStreamId(assistantMessageStreamIndex, assistantEvent.contentIndex);
        toolArgsById.set(assistantEvent.toolCall.id, assistantEvent.toolCall.arguments ?? {});
        toolStreamIdsByCallId.set(assistantEvent.toolCall.id, streamId);
        writeEvent({
          type: "tool_call_stream_end",
          bubbleId: bubbleOf(),
          toolStreamId: streamId,
          contentIndex: assistantEvent.contentIndex,
          toolCallId: assistantEvent.toolCall.id,
          toolName: assistantEvent.toolCall.name,
          args: assistantEvent.toolCall.arguments ?? {},
        });
      }
    }

    if (event.type === "tool_execution_start") {
      // Tool execution only ever happens between assistant messages, so an
      // open thinking key at this point is stale (a block the provider never
      // closed). Settle it - the client must not keep a panel spinning above a
      // tool card that is already producing output just because one settle
      // event was lost.
      settleThinking();
      if (event.args !== undefined) {
        toolArgsById.set(event.toolCallId, event.args);
      }
      writeEvent({
        type: "tool_execution_start",
        bubbleId: bubbleOf(),
        toolCallId: event.toolCallId,
        toolStreamId: toolStreamIdsByCallId.get(event.toolCallId),
        toolName: event.toolName,
        args: event.args ?? toolArgsById.get(event.toolCallId),
      });
    }

    if (event.type === "tool_execution_update") {
      settleThinking();
      if (event.args !== undefined) {
        toolArgsById.set(event.toolCallId, event.args);
      }
      writeEvent({
        type: "tool_execution_update",
        bubbleId: bubbleOf(),
        toolCallId: event.toolCallId,
        toolStreamId: toolStreamIdsByCallId.get(event.toolCallId),
        toolName: event.toolName,
        args: event.args ?? toolArgsById.get(event.toolCallId),
        partialResult: event.partialResult,
      });
    }

    if (event.type === "tool_execution_end") {
      settleThinking();
      writeEvent({
        type: "tool_execution_end",
        bubbleId: bubbleOf(),
        toolCallId: event.toolCallId,
        toolStreamId: toolStreamIdsByCallId.get(event.toolCallId),
        toolName: event.toolName,
        args: event.args ?? toolArgsById.get(event.toolCallId),
        result: event.result,
        isError: event.isError,
      });
    }

    if (event.type === "queue_update") {
      writeEvent({
        type: "queued",
        behavior: streamingBehavior,
        ...pendingQueues(activeSession, queueSeq(activeSession, event)),
      });
      return;
    }

    if (event.type === "compaction_start") {
      writeEvent({ type: "compaction_start", reason: event.reason });
    }

    if (event.type === "compaction_end") {
      // `aborted` is the user pressing stop (or an extension refusing), not a
      // fault; only a failure carries `errorMessage` and has to be surfaced.
      writeEvent({
        type: "compaction_end",
        reason: event.reason,
        aborted: event.aborted === true,
        errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : undefined,
      });
    }

    if (event.type === "auto_retry_end" && event.success === false && event.finalError) {
      finalAgentError = formatAgentError(event.finalError);
    }

    if (event.type === "agent_end" && event.willRetry === false) {
      const assistantError = latestAssistantError(event.messages);
      if (assistantError) {
        finalAgentError = assistantError;
      }
    }

  });

  const onClientClose = () => {
    diagnosticLog("prompt.client_close", {
      requestId,
      wasStreaming,
      closed,
      ...sessionDetails(activeRuntime),
    });
    if (!wasStreaming && !closed && activeSession.isStreaming) {
      diagnosticLog("prompt.client_close_abort.start", { requestId, ...sessionDetails(activeRuntime) });
      void abortSession(activeSession, { requestId, reason: "prompt_client_close" })
        .catch(() => undefined);
    }
  };

  res.on("close", onClientClose);

  // 聊天输入永远是文本，不以 "/" 开头就例外。pi 的 prompt() 看到文本以 "/" 开头，会先把首个 token
  // 交给已注册的扩展命令执行（_tryExecuteExtensionCommand），于是打 "/run 命令行里的补全…" 时
  // pi-subagents 的 /run 被真的跑起来，报 "Unknown agent: 命令行里的补全…"。
  // 「这句是问题还是命令」文本本身分不出来，所以规则只能是：聊天框不派发命令。
  // 命令有自己的入口——斜杠菜单点选走 /api/capabilities/package/command（那里仍是
  // expandPromptTemplates: true），技能走徽标激活，都不经过这里。
  try {
    await activeSession.prompt(input, {
      images,
      streamingBehavior,
      expandPromptTemplates: false,
      preflightResult: () => undefined,
    });
    if (!closed) {
      if (wasStreaming) {
        writeEvent({ type: "queued", behavior: streamingBehavior, ...pendingQueues(activeSession) });
      } else {
        if (shouldTitleAfterFirstTurn) {
          await generateInitialSessionTitle(activeRuntime).catch((error) => {
            console.error(`Failed to generate initial session title: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        updateSessionStoreFromRuntime(activeRuntime);
        writeEvent({ type: "snapshot", snapshot: await buildSnapshot(activeRuntime) });
      }
      if (finalAgentError) {
        writeEvent({ type: "error", message: finalAgentError });
      }
      // `lifecycle` tells the client whether this stream merely acknowledged a
      // queue insert (the run keeps going) or actually ended the run.
      writeEvent({ type: "done", lifecycle: wasStreaming ? "queued" : "run" });
      closed = true;
      res.end();
    }
    diagnosticLog("prompt.success", {
      requestId,
      durationMs: Date.now() - promptStartedAt,
      wasStreaming,
      ...sessionDetails(activeRuntime),
    });
  } catch (error) {
    if (closed || res.destroyed) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    diagnosticLog("prompt.error", {
      requestId,
      wasStreaming,
      ...sessionDetails(activeRuntime),
      ...errorDetails(error),
    });
    if (!closed) {
      writeEvent({ type: "error", message });
      closed = true;
      res.end();
    }
  } finally {
    diagnosticLog("prompt.finally", { requestId, closed, ...sessionDetails(activeRuntime) });
    unsubscribe();
    unsubscribeUi?.();
    res.off("close", onClientClose);
  }
}

function latestAssistantError(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
      return formatAgentError(message.errorMessage);
    }

    if (message?.role === "assistant" && message.stopReason === "aborted") {
      return formatAgentError(message.errorMessage || "Request aborted");
    }
  }

  return "";
}

function formatAgentError(errorMessage) {
  const message = String(errorMessage ?? "").trim();
  return message ? `模型调用停止：${message}` : "模型调用停止：未知错误";
}

async function stopSession(targetRuntime, options = {}) {
  const activeSession = targetRuntime.session;
  const shouldClearQueues = options.clearQueues !== false;
  const requestId = options.requestId;
  const stopStartedAt = Date.now();
  diagnosticLog("stop.start", {
    requestId,
    clearQueues: shouldClearQueues,
    ...sessionDetails(targetRuntime),
  });
  const clearedQueue = shouldClearQueues && typeof activeSession.clearQueue === "function"
    ? activeSession.clearQueue()
    : { steering: [], followUp: [] };
  diagnosticLog("stop.queue_cleared", {
    requestId,
    clearedSteering: clearedQueue.steering?.length ?? 0,
    clearedFollowUp: clearedQueue.followUp?.length ?? 0,
    ...sessionDetails(targetRuntime),
  });

  if (activeSession.isCompacting) {
    diagnosticLog("stop.compaction_abort.start", { requestId, ...sessionDetails(targetRuntime) });
    activeSession.abortCompaction();
    diagnosticLog("stop.compaction_abort.success", { requestId, ...sessionDetails(targetRuntime) });
  }

  if (!shouldClearQueues && activeSession.isStreaming) {
    diagnosticLog("stop.abort.fire_and_forget", { requestId, ...sessionDetails(targetRuntime) });
    void abortSession(activeSession, { requestId, reason: "stop_preserve_queue" }).catch(() => undefined);
    return {
      clearedQueue,
      snapshot: await buildSnapshot(targetRuntime),
    };
  }

  if (isSessionBusy(activeSession)) {
    diagnosticLog("stop.abort.start", { requestId, ...sessionDetails(targetRuntime) });
    await abortSession(activeSession, { requestId, reason: "api_stop" });
    diagnosticLog("stop.abort.success", { requestId, durationMs: Date.now() - stopStartedAt, ...sessionDetails(targetRuntime) });
  } else {
    diagnosticLog("stop.abort.skipped", { requestId, ...sessionDetails(targetRuntime) });
  }

  diagnosticLog("stop.snapshot.start", { requestId, ...sessionDetails(targetRuntime) });
  const snapshot = await buildSnapshot(targetRuntime);
  diagnosticLog("stop.success", { requestId, durationMs: Date.now() - stopStartedAt, ...sessionDetails(targetRuntime) });
  return {
    clearedQueue,
    snapshot,
  };
}

async function abortSession(session, { requestId, reason }) {
  const existing = sessionAbortPromises.get(session);
  if (existing) {
    diagnosticLog("session.abort.join", {
      requestId,
      reason,
      ...sessionDetails({ session }),
    });
    return existing;
  }

  const startedAt = Date.now();
  diagnosticLog("session.abort.start", {
    requestId,
    reason,
    ...sessionDetails({ session }),
  });

  const promise = (async () => {
    const watchdog = setTimeout(() => {
      diagnosticLog("session.abort.pending", {
        requestId,
        reason,
        durationMs: Date.now() - startedAt,
        ...sessionDetails({ session }),
      });
    }, 5000);

    try {
      await session.abort();
      diagnosticLog("session.abort.success", {
        requestId,
        reason,
        durationMs: Date.now() - startedAt,
        ...sessionDetails({ session }),
      });
    } catch (error) {
      diagnosticLog("session.abort.error", {
        requestId,
        reason,
        durationMs: Date.now() - startedAt,
        ...sessionDetails({ session }),
        ...errorDetails(error),
      });
      throw error;
    } finally {
      clearTimeout(watchdog);
      if (sessionAbortPromises.get(session) === promise) {
        sessionAbortPromises.delete(session);
      }
    }
  })();

  sessionAbortPromises.set(session, promise);
  return promise;
}

async function refreshSnapshot(options = {}) {
  return buildSnapshot(runtime, options);
}

/**
 * The part of a snapshot that can change without the transcript moving, in O(1) in
 * conversation size.
 *
 * While this window owns a run, its own SSE stream is the authoritative transcript
 * feed, so the periodic poll exists only to pick up what the stream cannot carry:
 * pi's queues (a 插话 the server dropped or consumed), pending extension approval
 * prompts, which sessions are still busy, and whether a stop has landed. Answering
 * that with `buildSnapshot` costs a full conversation build plus a ~0.3-0.9 MB
 * `JSON.stringify` and md5 on the server, and a parse + normalise + merge on the
 * client's main thread - a stall that grows with context size, which is the wrong
 * shape for a watchdog. `done`/`error` already reconcile with a full snapshot, and
 * the stream carries pushed `snapshot` events, so nothing depends on the poll
 * carrying messages.
 */
function buildAmbientSnapshot(targetRuntime = runtime) {
  const session = targetRuntime.session;
  const model = isUsableModel(session.model) ? session.model : undefined;

  return {
    ambient: true,
    activeSessionPath: session.sessionFile,
    sessionFile: session.sessionFile,
    canPrompt: Boolean(model && modelRuntime.hasConfiguredAuth(model.provider)) && !session.isStreaming,
    projectTrusted: targetRuntime.settingsManager.isProjectTrusted(),
    streamingSessionPaths: [...openRuntimes.values()]
      .filter((candidate) => candidate.session.isStreaming)
      .map((candidate) => candidate.session.sessionFile),
    compactingSessionPaths: [...openRuntimes.values()]
      .filter((candidate) => candidate.session.isCompacting)
      .map((candidate) => candidate.session.sessionFile),
    pendingExtensionUiRequests: targetRuntime.uiBridge?.getPendingRequests() ?? [],
    pendingQueues: pendingQueues(session),
  };
}

async function respondToExtensionUiRequest(body) {
  const requestId = String(body?.id ?? body?.requestId ?? "").trim();
  if (!requestId) {
    throw new Error("Request id is required.");
  }

  for (const candidate of openRuntimes.values()) {
    if (await candidate.uiBridge?.respond(body)) {
      if (body?.cancelled && activePackageCommands.get(candidate.session.sessionFile) === candidate) {
        await abortSession(candidate.session, { reason: "extension_ui_cancel" }).catch(() => undefined);
      }
      return {
        ok: true,
        snapshot: await refreshSnapshot(),
      };
    }
  }

  throw new Error("Extension UI request not found.");
}

/**
 * The usage part of a snapshot, and of the per-message `context_usage` event.
 *
 * Same two reads pi's own footer uses: the context size comes from
 * `getContextUsage()` (it is only knowable from a settled assistant message,
 * which is why pi refreshes it at `message_end`) and the cumulative totals come
 * from the session stats over the persisted entries.
 *
 * `prepared` lets a caller that already read them - the snapshot builder does -
 * avoid a second full scan.
 */
function usageFields(targetSession, prepared = {}) {
  const stats = prepared.stats ?? targetSession.getSessionStats();
  const entries = prepared.entries ?? targetSession.sessionManager.getEntries();
  const contextUsage = prepared.contextUsage ?? targetSession.getContextUsage();
  return {
    contextTokens: contextUsage?.tokens ?? null,
    contextWindow: contextUsage?.contextWindow,
    contextPercent: contextUsage?.percent ?? null,
    tokenUsage: stats.tokens
      ? {
          ...stats.tokens,
          estimatedCostUsd: stats.cost,
          reasoning: entries.reduce((total, entry) => {
            const usage = entry.usage ?? (entry.type === "message" ? entry.message?.usage : undefined);
            return total + Number(usage?.reasoning ?? 0);
          }, 0),
        }
      : undefined,
  };
}

/**
 * Sessions that count as streaming in a snapshot.
 *
 * `assumeStreaming` covers the edit's pre-prompt snapshot: the client has already
 * accepted the rewind and drawn the optimistic streaming turn, but
 * `session.isStreaming` only flips inside `prompt()`, which has not been called
 * yet (the snapshot has to go out first so bubble ordinals line up). Without this
 * the snapshot said "not streaming", the reducer rebuilt `isStreaming` from it,
 * and the composer's stop button disappeared for the whole edited run.
 */
function liveStreamingSessionPaths(targetRuntime, options = {}) {
  const paths = new Set(
    [...openRuntimes.values()]
      .filter((candidate) => candidate.session.isStreaming)
      .map((candidate) => candidate.session.sessionFile),
  );
  if (options.assumeStreaming === true) {
    paths.add(targetRuntime.session.sessionFile);
  }
  return [...paths];
}

function sessionIsStreaming(targetRuntime, options = {}) {
  return targetRuntime.session.isStreaming || options.assumeStreaming === true;
}

async function buildSnapshot(targetRuntime = runtime, options = {}) {
  const traceSessionSwitch = options.traceSessionSwitch === true;
  const startedAt = traceSessionSwitch ? Date.now() : 0;
  const project = findProject(targetRuntime.projectId);
  const visibleMessages = buildChatBubbles(displayTranscript(targetRuntime.session), {
    isStreaming: targetRuntime.session.isStreaming,
    now: Date.now(),
    toAttachment: toConversationAttachment,
  });
  if (traceSessionSwitch) {
    diagnosticLog("session.switch.snapshot_messages", {
      sessionPath: targetRuntime.session.sessionFile,
      durationMs: Date.now() - startedAt,
      messageCount: visibleMessages.length,
    });
  }
  const stats = targetRuntime.session.getSessionStats();
  const contextUsage = targetRuntime.session.getContextUsage();
  const entries = targetRuntime.session.sessionManager.getEntries();
  if (traceSessionSwitch) {
    diagnosticLog("session.switch.snapshot_stats", {
      sessionPath: targetRuntime.session.sessionFile,
      durationMs: Date.now() - startedAt,
      entryCount: entries.length,
    });
  }
  const compactionEntries = entries.filter((entry) => entry.type === "compaction");
  const latestCompaction = compactionEntries.at(-1);
  const model = isUsableModel(targetRuntime.session.model) ? targetRuntime.session.model : undefined;
  const modelProvider = model?.provider ? String(model.provider) : targetRuntime.settingsManager.getDefaultProvider() ?? "";
  const modelId = model?.id ?? targetRuntime.settingsManager.getDefaultModel() ?? "";
  const messageCount = visibleMessages.length;
  const userMessages = visibleMessages.filter((message) => message.role === "user");
  const assistantMessages = visibleMessages.filter((message) => message.role === "assistant");
  const result = {
    snapshot: {
      conversation: {
        id: targetRuntime.session.sessionId,
        title: targetRuntime.session.sessionName ?? inferConversationTitle(userMessages),
        createdAt: parseTime(targetRuntime.session.sessionManager.getHeader()?.timestamp) ?? visibleMessages[0]?.createdAt ?? Date.now(),
        updatedAt: visibleMessages.at(-1)?.createdAt ?? Date.now(),
        messages: visibleMessages,
        projectId: project.id,
        // worktree 会话这里就是 worktree 路径，前端靠它区分“会话在哪个检出里跑”。
        workingDirectory: targetRuntime.workspaceCwd ?? project.cwd,
        sessionFile: targetRuntime.session.sessionFile,
      },
      project,
      modelConfig: {
        provider: modelProvider,
        model: modelId,
        thinkingLevel: targetRuntime.session.thinkingLevel,
        // 「新任务从哪个等级开始」按项目记；没记过的项目回退到 pi 的全局默认。
        defaultThinkingLevel:
          normalizeComposerDefaults(project?.composerDefaults)?.thinkingLevel
          ?? targetRuntime.settingsManager.getDefaultThinkingLevel()
          ?? "off",
        agentUrl: apiBase,
        apiKeyConfigured: model ? modelRuntime.hasConfiguredAuth(model.provider) : false,
      },
      stats: {
        turnCount: userMessages.length,
        userMessageCount: userMessages.length,
        assistantMessageCount: assistantMessages.length,
        messageCount,
        compactionCount: compactionEntries.length,
        toolCallCount: stats.toolCalls,
        latestCompactionSummary: latestCompaction?.summary ?? "",
        ...usageFields(targetRuntime.session, { stats, entries, contextUsage }),
        lastMessageAt: visibleMessages.at(-1)?.createdAt,
      },
    },
    projects: listProjectsWithSessions(),
    archivedSessions: listArchivedSessions(),
    activeProjectId: project.id,
    activeSessionPath: targetRuntime.session.sessionFile,
    availableModels: listAvailableModels(),
    skills: targetRuntime.resourceLoader.getSkills().skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation,
    })),
    capabilities: await buildCapabilitiesSnapshot(targetRuntime),
    server: {
      url: apiBase,
      ready: true,
    },
    projectTrusted: targetRuntime.settingsManager.isProjectTrusted(),
    canPrompt: Boolean(model && modelRuntime.hasConfiguredAuth(model.provider)) && !sessionIsStreaming(targetRuntime, options),
    sessionFile: targetRuntime.session.sessionFile,
    streamingSessionPaths: liveStreamingSessionPaths(targetRuntime, options),
    compactingSessionPaths: [...openRuntimes.values()]
      .filter((candidate) => candidate.session.isCompacting)
      .map((candidate) => candidate.session.sessionFile),
    pendingExtensionUiRequests: targetRuntime.uiBridge?.getPendingRequests() ?? [],
    // pi owns the steering/follow-up queue; exposing it is what lets the UI show
    // a queued 插话 before it is delivered, and survive a page reload.
    pendingQueues: pendingQueues(targetRuntime.session),
    personalization,
  };
  if (traceSessionSwitch) {
    diagnosticLog("session.switch.snapshot_complete", {
      sessionPath: targetRuntime.session.sessionFile,
      durationMs: Date.now() - startedAt,
    });
  }
  return result;
}

/**
 * pi emits one `queue_update` object per queue mutation and hands the same
 * instance to every subscriber, so counting it per session (deduped by object
 * identity) gives all clients one monotonic sequence. They need it because the
 * queue is reported as a snapshot: without a sequence, a duplicate or a late
 * `queued` would resurrect a 插话 that has already been delivered.
 */
const queueSeqBySession = new WeakMap();

function queueSeq(session, event) {
  const seen = queueSeqBySession.get(session);
  if (seen && seen.event === event) {
    return seen.seq;
  }
  const seq = (seen?.seq ?? 0) + 1;
  queueSeqBySession.set(session, { event, seq });
  return seq;
}

function pendingQueues(session, seq = queueSeqBySession.get(session)?.seq ?? 0) {
  return {
    steering: [...(session?.getSteeringMessages?.() ?? [])],
    followUp: [...(session?.getFollowUpMessages?.() ?? [])],
    seq,
  };
}

function inferConversationTitle(messages) {
  const first = messages[0];
  if (!first) {
    return "New session";
  }

  const snippet = deriveSessionTitle({ text: messageToText(first) });
  return snippet || "New session";
}

function shouldGenerateInitialTitle(targetRuntime) {
  if (targetRuntime.session.sessionManager.getSessionName()) {
    return false;
  }

  const userMessageCount = displayTranscript(targetRuntime.session).filter((message) => message.role === "user").length;
  return userMessageCount === 0;
}

async function generateInitialSessionTitle(targetRuntime) {
  if (targetRuntime.session.sessionManager.getSessionName()) {
    return;
  }

  const visibleMessages = buildChatBubbles(displayTranscript(targetRuntime.session), { isStreaming: false, toAttachment: toConversationAttachment });
  const userMessage = visibleMessages.find((message) => message.role === "user");
  const assistantMessage = visibleMessages.find((message) => message.role === "assistant");
  const fallbackTitle = fallbackSessionTitle(messageToText(userMessage)) || "New session";
  if (!userMessage || !assistantMessage || !isUsableModel(targetRuntime.session.model)) {
    setSessionTitleIfEmpty(targetRuntime, fallbackTitle);
    return;
  }

  try {
    const response = await modelRuntime.complete(
      targetRuntime.session.model,
      {
        systemPrompt: [
          "你是会话标题生成器。",
          "根据第一条用户消息和第一条助手回复，生成一个短标题。",
          `只输出标题，不要解释。中文标题不超过 ${generatedTitleMaxChars} 字；英文标题不超过 ${sessionTitleMaxWords} 个词；写不下就在标点处收尾，不要把词截成一半。`,
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "第一条用户消息：",
                  messageToText(userMessage),
                  "",
                  "第一条助手回复：",
                  messageToText(assistantMessage),
                ].join("\n"),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      // 同提交信息生成：maxTokens 要覆盖思考模型的 reasoning 消耗；始终思考的模型
      // 不显式给档位会被端点 400（见 server/oneShotModel.mjs）。
      {
        maxTokens: 512,
        cacheRetention: "none",
        sessionId: randomUUID(),
        reasoningEffort: oneShotThinkingEffort(targetRuntime.session.model),
      },
    );
    const generatedTitle = normalizeGeneratedTitle(assistantContentText(response));
    setSessionTitleIfEmpty(targetRuntime, generatedTitle || fallbackTitle);
  } catch {
    setSessionTitleIfEmpty(targetRuntime, fallbackTitle);
  }
}

function setSessionTitleIfEmpty(targetRuntime, title) {
  if (targetRuntime.session.sessionManager.getSessionName()) {
    return;
  }

  const cleanTitle = String(title ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!cleanTitle) {
    return;
  }

  targetRuntime.session.setSessionName(cleanTitle);
  persistSessionShell(targetRuntime.session.sessionManager);
  updateSessionStoreFromRuntime(targetRuntime);
}

function assistantContentText(message) {
  if (!Array.isArray(message?.content)) {
    return "";
  }

  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim();
}

/**
 * The submit-time provisional title used when no summary title is available (no
 * usable model, or the title call failed). The rule lives in the shared module so
 * the client's optimistic title and this server fallback cannot drift apart.
 */
function fallbackSessionTitle(input) {
  return deriveSessionTitle({ text: String(input ?? "") });
}

function normalizeGeneratedTitle(input) {
  // The prompt already bounds the length; whatever the model returns is kept as
  // written apart from whitespace and label/quote noise. Truncating here would
  // saw words in half (that is how "worktree多任" happened), so there is
  // deliberately no length cut on this path.
  const title = String(input ?? "")
    .replace(/^["'“”‘’「」『』《》【】\s]+|["'“”‘’「」『』《》【】\s.。!！?？:：,，;；]+$/gu, "")
    .replace(/^(?:标题|短标题)\s*[:：]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return title;
}

function persistPromptAttachments(activeRuntime, values) {
  const attachmentValues = Array.isArray(values) ? values : [];
  if (attachmentValues.length > maxAttachmentCount) {
    throw new Error(`A maximum of ${maxAttachmentCount} attachments is allowed.`);
  }

  const project = findProject(activeRuntime.projectId);
  const sessionHeader = activeRuntime.session.sessionManager.getHeader();
  const sessionId = String(sessionHeader?.id ?? basename(activeRuntime.session.sessionFile, extname(activeRuntime.session.sessionFile)));
  const attachmentDir = join(projectAttachmentRoot, project.id, sanitizePathPart(sessionId));
  let totalBytes = 0;

  return attachmentValues.map((attachment, index) => {
    const originalName = String(attachment?.name ?? `attachment-${index + 1}`).trim() || `attachment-${index + 1}`;
    const id = sanitizePathPart(String(attachment?.id ?? randomUUID())) || randomUUID();
    const sourcePath = typeof attachment?.sourcePath === "string" ? attachment.sourcePath : "";
    const resolvedSource = sourcePath ? resolve(sourcePath) : "";

    // 目录是一条「引用」，不是字节。客户端只把宿主解析到的绝对路径交过来（详见
    // src/shared/composerDrop.ts），这里既不复制也不当文件读：复制一个目录没有意义（模型
    // 要的是可以在原地 ls/grep 的那份），而且可能巨大。代价是这份路径是「活」的 —— 文件是
    // 快照，目录不是；回放旧消息时它可能已经不在，所以先校验再说清楚。
    if (String(attachment?.mimeType ?? "").trim().toLowerCase() === directoryMimeType) {
      if (!resolvedSource || !existsSync(resolvedSource) || !statSync(resolvedSource).isDirectory()) {
        throw new Error(`Folder "${originalName}" is no longer available at ${resolvedSource || "(no path)"}.`);
      }
      return {
        id,
        name: originalName,
        mimeType: directoryMimeType,
        size: 0,
        kind: "directory",
        path: resolvedSource,
        data: "",
      };
    }

    const reusablePath = resolvedSource.startsWith(`${resolve(projectAttachmentRoot)}/`)
      && existsSync(resolvedSource)
      && statSync(resolvedSource).isFile()
      ? resolvedSource
      : "";
    let data = String(attachment?.data ?? "");
    let buffer = Buffer.from(data, "base64");
    // 编辑一条带附件的消息时，客户端手里只有已落盘的 `sourcePath`（没有原始 File），
    // 直接复用磁盘上的那份，不要求它把字节重新读一遍再 base64 回来。
    if (!buffer.length && reusablePath) {
      buffer = readFileSync(reusablePath);
      data = buffer.toString("base64");
    }
    if (!buffer.length && Number(attachment?.size ?? 0) > 0) {
      throw new Error(`Attachment ${index + 1} could not be decoded.`);
    }
    if (buffer.length > maxAttachmentBytes) {
      throw new Error(`${String(attachment?.name ?? `Attachment ${index + 1}`)} exceeds 25 MB.`);
    }

    totalBytes += buffer.length;
    if (totalBytes > maxAttachmentTotalBytes) {
      throw new Error("Attachments exceed the 50 MB total limit.");
    }

    const fileName = `${id}-${sanitizeAttachmentName(originalName)}`;
    const path = reusablePath || join(attachmentDir, fileName);
    const mimeType = String(attachment?.mimeType ?? "application/octet-stream");

    if (!reusablePath) {
      mkdirSync(attachmentDir, { recursive: true });
      writeFileSync(path, buffer);
    }

    return {
      id,
      name: originalName,
      mimeType,
      size: buffer.length,
      kind: mimeType.startsWith("image/") ? "image" : "file",
      path,
      data,
    };
  });
}

function appendAttachmentContext(input, displayInput, attachments, messageParts = []) {
  const hasCapabilityParts = messageParts.some((part) => part?.kind === "capability");
  if (!attachments.length && !hasCapabilityParts) {
    return input;
  }

  const metadata = {
    displayInput,
    attachments: attachments.map(({ id, name, mimeType, size, kind, path }) => ({
      id,
      name,
      mimeType,
      size,
      kind,
      path,
    })),
    messageParts,
  };

  return [
    input,
    "",
    ...(attachments.length
      ? [
          "Attached files and folders are available at these local paths. Inspect them with the appropriate tools when needed:",
          ...attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`),
          "",
        ]
      : []),
    ATTACHMENT_CONTEXT_START,
    JSON.stringify(metadata),
    ATTACHMENT_CONTEXT_END,
  ].join("\n");
}

async function normalizePromptMessageParts(activeRuntime, parts, displayInput, attachments) {
  const normalized = normalizeMessageParts(parts, displayInput, attachments);
  const requestedCapabilities = normalized
    .filter((part) => part.kind === "capability")
    .map((part) => part.capability);
  if (!requestedCapabilities.length) {
    return normalized;
  }

  const context = await readRuntimeCapabilityContext(activeRuntime);
  const current = activeSessionCapabilitySelection(
    activeRuntime.session.sessionManager,
    context.allSkills,
    context.config,
    activeRuntime,
  );
  const requestedSkills = requestedCapabilities.filter((capability) => capability.kind === "skill");
  const selection = activeRuntime.session.isStreaming || !requestedSkills.length
    ? current
    : await updateRuntimeSessionCapabilities(activeRuntime, (currentSelection) => {
        const knownSkills = new Set(context.allSkills.map(skillCapabilityId));
        const enabledSkills = new Set(currentSelection.enabledSkills);
        const disabledSkills = new Set(currentSelection.disabledSkills);

        for (const capability of requestedSkills) {
          if (knownSkills.has(capability.id)) {
            enabledSkills.add(capability.id);
            disabledSkills.delete(capability.id);
          }
        }

        return {
          ...currentSelection,
          enabledSkills: [...enabledSkills],
          disabledSkills: [...disabledSkills],
        };
      });
  const activeSkills = new Set(selection.skills);
  return normalized.map((part) => {
    if (part.kind !== "capability") {
      return part;
    }

    return {
      ...part,
      capability: {
        ...part.capability,
        active: activeSkills.has(part.capability.id),
      },
    };
  });
}

function normalizeMessageParts(parts, displayInput, attachments) {
  const attachmentIds = new Set(attachments.map((attachment) => attachment.id));
  const normalized = Array.isArray(parts)
    ? parts.flatMap((part) => {
        if (part?.kind === "text") {
          const text = String(part.text ?? "");
          return text ? [{ kind: "text", text }] : [];
        }
        if (part?.kind === "attachment") {
          const attachmentId = String(part.attachmentId ?? "");
          return attachmentIds.has(attachmentId) ? [{ kind: "attachment", attachmentId }] : [];
        }
        if (part?.kind === "capability") {
          const capability = normalizeMessageCapabilityPart(part.capability);
          return capability ? [{ kind: "capability", capability }] : [];
        }
        return [];
      })
    : [];

  if (normalized.length) {
    return normalized;
  }

  return [
    ...(displayInput ? [{ kind: "text", text: displayInput }] : []),
    ...attachments.map((attachment) => ({ kind: "attachment", attachmentId: attachment.id })),
  ];
}

function normalizeMessageCapabilityPart(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = String(source.id ?? "").trim();
  const kind = source.kind === "mcp" ? "mcp" : source.kind === "skill" ? "skill" : "";
  if (!id || !kind) {
    return null;
  }

  return {
    id,
    kind,
    name: String(source.name ?? id).trim() || id,
    description: String(source.description ?? "").trim(),
    active: source.active === undefined ? undefined : Boolean(source.active),
  };
}

function toConversationAttachment(attachment) {
  const mimeType = String(attachment?.mimeType ?? "application/octet-stream");
  // 目录和图片一样是自成一类：旧消息里只有 image/file 两种 kind，所以两边都看。
  const kind = attachment?.kind === "directory" || mimeType.trim().toLowerCase() === directoryMimeType
    ? "directory"
    : attachment?.kind === "image" || mimeType.startsWith("image/")
      ? "image"
      : "file";
  const path = String(attachment?.path ?? "");
  return {
    id: String(attachment?.id ?? randomUUID()),
    name: String(attachment?.name ?? "Attachment"),
    mimeType,
    size: Number(attachment?.size ?? 0),
    kind,
    sourcePath: path || undefined,
    previewUrl: kind === "image" && path
      ? `${apiBase}/api/attachments?path=${encodeURIComponent(path)}`
      : undefined,
  };
}

function sendAttachment(res, filePath) {
  const resolvedPath = resolve(filePath);
  const resolvedRoot = resolve(projectAttachmentRoot);
  if (!resolvedPath.startsWith(`${resolvedRoot}/`) || !existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    sendJson(res, 404, { error: "Attachment not found." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": inferAttachmentMimeType(resolvedPath),
    "Cache-Control": "private, max-age=3600",
    ...corsHeaders(),
  });
  res.end(readFileSync(resolvedPath));
}

/**
 * Directories `GET /api/local-media` may read from. `/tmp` is listed next to
 * `tmpdir()` because on macOS the latter is the per-user `$TMPDIR` and agents keep
 * writing to the plain `/tmp` path that scripts use.
 */
function localMediaRoots() {
  return [agentDir, homedir(), tmpdir(), "/tmp", activeProject()?.cwd].filter(Boolean);
}

/**
 * Serve a media file the agent wrote on disk, for `<img>` / `<video>` in answers.
 *
 * The WebView cannot read the filesystem, so every local path in an answer has to
 * come back through here; `resolveLocalMediaPath` owns which paths are allowed
 * (project directory, agent directory, temp directory, home) and refuses anything
 * else before a byte is read.
 *
 * Partial responses are implemented because WKWebView refuses to seek in a video
 * it cannot range-request, and a 200-only server makes every clip unscrubbable.
 */
function sendLocalMedia(res, rawPath, rangeHeader) {
  const decision = resolveLocalMediaPath(rawPath, {
    roots: localMediaRoots(),
    cwd: activeProject()?.cwd,
    homedir: homedir(),
  });
  if (!decision.ok) {
    sendJson(res, decision.status, { error: decision.error });
    return;
  }

  const headers = {
    "Content-Type": decision.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    // An answer can name an .svg, and a document opened from that URL must not be
    // able to script against this server.
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'",
    ...corsHeaders(),
  };

  const range = parseByteRange(rangeHeader, decision.size);
  if (range) {
    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${range.start}-${range.end}/${decision.size}`,
      "Content-Length": range.end - range.start + 1,
    });
  } else {
    res.writeHead(200, { ...headers, "Content-Length": decision.size });
  }

  createReadStream(decision.path, range ? { start: range.start, end: range.end } : undefined)
    .on("error", () => res.destroy())
    .pipe(res);
}

function sanitizeAttachmentName(name) {
  return name
    .normalize("NFKC")
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "attachment";
}

function sanitizePathPart(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function attachmentOnlyPrompt(attachments) {
  if (attachments.length === 1) {
    const only = attachments[0];
    return `Please review the attached ${only?.kind === "directory" ? "folder" : "file"}: ${only?.name}`;
  }
  return `Please review these ${attachments.length} attached files.`;
}

function inferAttachmentMimeType(path) {
  const mimeTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
  };
  return mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function partialToolCall(assistantEvent) {
  const block = assistantEvent.partial?.content?.[assistantEvent.contentIndex];
  return block?.type === "toolCall" ? block : null;
}

function toolStreamId(assistantIndex, contentIndex) {
  const messageIndex = assistantIndex >= 0 ? assistantIndex : "unknown";
  return `assistant-${messageIndex}-tool-content-${contentIndex}`;
}

function loadProjects() {
  const stored = readJsonFile(projectsFile);
  const now = Date.now();
  const parsed = Array.isArray(stored?.projects) ? stored.projects : [];
  const normalized = parsed
    .map((project) => {
      const id = String(project?.id ?? "").trim() || createProjectId(project?.name);
      return {
        id,
        name: String(project?.name ?? "").trim() || "Project",
        cwd: resolve(String(project?.cwd ?? appCwd)),
        createdAt: Number(project?.createdAt ?? now),
        updatedAt: Number(project?.updatedAt ?? now),
        pinned: Boolean(project?.pinned),
        lastSessionPath: typeof project?.lastSessionPath === "string" ? project.lastSessionPath : undefined,
        sessionPins: project?.sessionPins && typeof project.sessionPins === "object" ? project.sessionPins : {},
        composerDefaults: normalizeComposerDefaults(project?.composerDefaults),
      };
    })
    .filter((project) => project.cwd);

  if (normalized.length) {
    return normalized;
  }

  return [
    {
      id: createProjectId(basename(appCwd)),
      name: basename(appCwd) || "Code",
      cwd: appCwd,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      sessionPins: {},
    },
  ];
}

function saveProjects() {
  writeJsonFile(projectsFile, {
    activeProjectId,
    projects,
  });
}

function readActiveProjectId(projectList) {
  const stored = readJsonFile(projectsFile);
  const storedId = typeof stored?.activeProjectId === "string" ? stored.activeProjectId : "";
  if (projectList.some((project) => project.id === storedId)) {
    return storedId;
  }

  return projectList[0]?.id;
}

function loadPersonalization() {
  const stored = readJsonFile(personalizationFile);
  return {
    style: normalizePersonalizationStyle(stored?.style),
    customInstructions: normalizePersonalizationText(stored?.customInstructions, 1500, "customInstructions"),
    persona: normalizePersonalizationText(stored?.persona, 1000, "persona"),
    extensionUi: normalizeExtensionUiMode(stored?.extensionUi),
  };
}

function activeProject() {
  return projects.find((candidate) => candidate.id === activeProjectId) ?? projects[0];
}

function findProject(projectId) {
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  return project;
}

function touchProject(projectId, patch = {}) {
  const now = Date.now();
  projects = projects.map((project) => (project.id === projectId ? { ...project, ...patch, updatedAt: now } : project));
  saveProjects();
}

/**
 * 把「新任务从哪个模型/思考等级开始」记到项目上（而不是 pi 的全局 settings）。
 *
 * 只在新建会话里改动时才调。半条记录（只有 provider 没有 model、或等级不认识）会被
 * `normalizeComposerDefaults` 丢掉对应字段，宁可不改也不写脏数据。
 */
function rememberProjectComposerDefaults(projectId, patch = {}) {
  const project = findProject(projectId);
  const next = normalizeComposerDefaults({ ...normalizeComposerDefaults(project.composerDefaults), ...patch });
  if (next) {
    touchProject(projectId, { composerDefaults: next });
  }
}

async function createSessionStore(projectList) {
  const db = await openSqliteDatabase(sessionsDatabaseFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS session_index (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      first_message TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, path)
    );
    CREATE INDEX IF NOT EXISTS session_index_project_sort
      ON session_index (project_id, pinned DESC, updated_at DESC);
    CREATE TABLE IF NOT EXISTS session_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 旧库没有 archived 列：CREATE TABLE IF NOT EXISTS 对已存在的表是空操作，只能显式补列。
  // 详见 server/sessionArchive.mjs（可测、幂等）。
  ensureSessionArchiveColumn(db);

  const versionRow = db.query("SELECT value FROM session_index_meta WHERE key = 'version'").get();
  if (Number(versionRow?.value ?? 0) < sessionsDatabaseVersion) {
    const insert = db.prepare(`
      INSERT INTO session_index (
        project_id, path, id, name, title, cwd, created_at, updated_at,
        message_count, first_message, pinned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET
        id = excluded.id,
        name = excluded.name,
        title = excluded.title,
        cwd = excluded.cwd,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        message_count = excluded.message_count,
        first_message = excluded.first_message
    `);
    const migratedRows = [];
    for (const project of projectList) {
      const sessions = await SessionManager.list(project.cwd, getProjectSessionDir(project));
      for (const session of sessions) {
        if (session.messageCount <= 0) {
          continue;
        }
        const path = resolve(session.path);
        const pins = project.sessionPins && typeof project.sessionPins === "object" ? project.sessionPins : {};
        migratedRows.push([
          project.id,
          path,
          String(session.id ?? basename(path, extname(path))),
          session.name || null,
          session.name || deriveSessionTitle({ text: session.firstMessage }) || "New session",
          session.cwd || project.cwd,
          session.created?.getTime?.() || Date.now(),
          session.modified?.getTime?.() || Date.now(),
          session.messageCount,
          session.firstMessage || "(no messages)",
          pins[path] ? 1 : 0,
        ]);
      }
    }
    db.transaction(() => {
      for (const row of migratedRows) {
        insert.run(...row);
      }
      db.query(`
        INSERT INTO session_index_meta (key, value) VALUES ('version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(sessionsDatabaseVersion));
    })();
  }

  const selectByPath = db.prepare("SELECT pinned, archived FROM session_index WHERE project_id = ? AND path = ?");
  const insert = db.prepare(`
    INSERT INTO session_index (
      project_id, path, id, name, title, cwd, created_at, updated_at,
      message_count, first_message, pinned, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, path) DO UPDATE SET
      id = excluded.id,
      name = excluded.name,
      title = excluded.title,
      cwd = excluded.cwd,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      message_count = excluded.message_count,
      first_message = excluded.first_message
  `);

  return {
    upsert(project, sessionManager, options = {}) {
      const record = sessionRecordFromManager(project, sessionManager);
      const existing = selectByPath.get(project.id, record.path);
      if (record.messageCount <= 0 && !options.includeEmpty && !existing) {
        db.query("DELETE FROM session_index WHERE project_id = ? AND path = ?").run(project.id, record.path);
        return;
      }
      const pins = project.sessionPins && typeof project.sessionPins === "object" ? project.sessionPins : {};
      insert.run(
        record.projectId,
        record.path,
        record.id,
        record.name,
        record.title,
        record.cwd,
        record.createdAt,
        record.updatedAt,
        record.messageCount,
        record.firstMessage,
        existing ? Number(existing.pinned) : (pins[record.path] ? 1 : 0),
        // 归档位只由用户动作切换：会话被重新打开/续写（upsert）时不能把它悄悄取消。
        existing ? Number(existing.archived) : 0,
      );
    },
    remove(projectId, path) {
      db.query("DELETE FROM session_index WHERE project_id = ? AND path = ?").run(projectId, resolve(path));
    },
    setPinned(projectId, path, pinned) {
      db.query("UPDATE session_index SET pinned = ? WHERE project_id = ? AND path = ?")
        .run(pinned ? 1 : 0, projectId, resolve(path));
    },
    setArchived(projectId, path, archived) {
      db.query("UPDATE session_index SET archived = ? WHERE project_id = ? AND path = ?")
        .run(archived ? 1 : 0, projectId, resolve(path));
    },
    /** 归档会话不能当会话打开（项目 lastSessionPath 可能还指着它）。 */
    isArchived(projectId, path) {
      const row = db.query("SELECT archived FROM session_index WHERE project_id = ? AND path = ?")
        .get(projectId, resolve(path));
      return Boolean(row?.archived);
    },
    /** 会话索引里的 cwd（会话可能没打开，但 worktree 清理需要知道它当时在哪）。 */
    findCwd(projectId, path) {
      const row = db.query("SELECT cwd FROM session_index WHERE project_id = ? AND path = ?")
        .get(projectId, resolve(path));
      return String(row?.cwd ?? "");
    },
    deleteProject(projectId) {
      db.query("DELETE FROM session_index WHERE project_id = ?").run(projectId);
    },
    list(project) {
      return listProjectSessionRows(db, project.id, project.cwd);
    },
    /**
     * 归档清单是跨项目的（设置页把它们按项目分组展示），所以这里不按 project 过滤，
     * 由调用方补上 projectName。
     */
    listArchived() {
      return listArchivedSessionRows(db);
    },
    close() {
      db.close();
    },
  };
}

function sessionRecordFromManager(project, sessionManager) {
  const path = resolve(sessionManager.getSessionFile());
  const entries = sessionManager.getEntries();
  const messageEntries = entries.filter((entry) => entry?.type === "message" && entry.message);
  const firstUserMessage = messageEntries.find((entry) => entry.message?.role === "user");
  const firstMessage = firstUserMessage ? messageToText(firstUserMessage.message) : "";
  const header = sessionManager.getHeader();
  const createdAt = parseTime(header?.timestamp) ?? Date.now();
  const updatedAt = messageEntries.reduce((latest, entry) => {
    const timestamp = typeof entry.message?.timestamp === "number"
      ? entry.message.timestamp
      : parseTime(entry.timestamp);
    return timestamp && timestamp > latest ? timestamp : latest;
  }, createdAt);
  const name = sessionManager.getSessionName() || null;
  return {
    projectId: project.id,
    path,
    id: sessionManager.getSessionId() || basename(path, extname(path)),
    name,
    title: name || (firstMessage ? deriveSessionTitle({ text: firstMessage }) : "New session") || "New session",
    cwd: sessionWorkspaceCwd(project, sessionManager),
    createdAt,
    updatedAt,
    messageCount: messageEntries.length,
    firstMessage,
  };
}

function updateSessionStoreFromSession(project, sessionManager, options) {
  sessionStore.upsert(project, sessionManager, options);
}

function updateSessionStoreFromRuntime(targetRuntime) {
  const project = findProject(targetRuntime.projectId);
  updateSessionStoreFromSession(project, targetRuntime.session.sessionManager);
}

function listProjectsWithSessions() {
  return projects.map((project) => ({
    ...project,
    sessions: listProjectSessions(project),
  }));
}

/**
 * 归档会话清单：跨项目，按项目分组由前端完成；带上 projectName 是为了让设置页
 * 直接展示分组标题，不必再回项目列表里兜一圈。
 */
function listArchivedSessions() {
  return sessionStore.listArchived().map((session) => ({
    ...session,
    projectName: projects.find((project) => project.id === session.projectId)?.name,
  }));
}

function listProjectSessions(project) {
  // 侧栏会话行末尾那枚 worktree 徽标：摘要里带一个布尔即可，不必逐会话再去问一次 git。
  // 判定复用「这条会话跑在哪个目录」的唯一规则（`resolveSessionWorkspaceCwd`，reason
  // `worktree` = 落在托管根目录里且目录还在）—— 目录已被移除/外部删掉时会话已经退回项目
  // 目录，列表徽标必须跟着消失，否则移除后还会留着一个点不掉的标记。
  return sessionStore.list(project).map((session) => ({
    ...session,
    inWorktree:
      resolveSessionWorkspaceCwd({
        projectCwd: project.cwd,
        worktreeRoot: worktreesRoot,
        sessionCwd: session.cwd,
      }).reason === "worktree",
  }));
}

function getProjectSessionDir(project) {
  return join(projectSessionRoot, project.id);
}

/**
 * 会话自己的工作目录，唯一判定口（规则本身在 `sessionWorkspace.mjs`，可测）。
 *
 * 只有同时满足「落在托管 worktree 根目录里」+「目录还在」才采信 worktree 路径；否则退回
 * 项目目录 —— 项目被移动、会话文件被手改、worktree 被外部删掉时都不会让 agent 跑错地方。
 */
function sessionWorkspaceCwd(project, sessionManager) {
  const resolved = resolveSessionWorkspaceCwd({
    projectCwd: project.cwd,
    worktreeRoot: worktreesRoot,
    sessionCwd: sessionManager?.getCwd?.(),
  });
  if (resolved.reason === "missing") {
    diagnosticLog("worktree.missing", { projectId: project.id, worktreePath: String(sessionManager?.getCwd?.() ?? "") });
  }
  return resolved.cwd;
}

/**
 * 保证 worktree 会话能看到项目根的 `.pi`（项目级 skills / extensions / 包配置）。
 *
 * 幂等、不抛错：差的是「项目级能力看不见」，不该让开会话 / 重载失败，诊断里留 reason 即可。
 * 只在 workspace 真的落在托管 worktree 里时动手；普通会话和其它目录一律不碰（绝不在项目
 * 子目录里凭空造出一个 `.pi` 软链）。
 */
function ensureWorktreePiLink(project, workspaceCwd, trace = {}) {
  if (!project || !workspaceCwd || workspaceCwd === project.cwd) {
    return null;
  }
  if (!isManagedWorktreePath(worktreesRoot, workspaceCwd)) {
    return null;
  }
  const piLink = linkProjectPiIntoWorktree(project.cwd, workspaceCwd);
  if (piLink.reason === "error") {
    console.error(
      `[pi-desktop:worktree] 项目 .pi 无法链进 worktree：${piLink.error instanceof Error ? piLink.error.message : String(piLink.error ?? "")}`,
    );
  }
  if (piLink.reason !== "already" && piLink.reason !== "no-project-pi" && piLink.reason !== "existing-pi") {
    diagnosticLog("worktree.pi_link", {
      projectId: project.id,
      worktreePath: workspaceCwd,
      linked: piLink.linked,
      reason: piLink.reason,
      ...trace,
    });
  }
  return piLink;
}

/** 按会话路径解析 workspace：优先已打开的 runtime，其次会话索引里的 cwd。 */
function sessionWorkspaceCwdForPath(project, sessionPath) {
  const resolvedPath = resolve(String(sessionPath ?? ""));
  const openRuntime = openRuntimes.get(sessionRuntimeKey(resolvedPath));
  if (openRuntime?.workspaceCwd) {
    return openRuntime.workspaceCwd;
  }

  const stored = sessionStore.findCwd(project.id, resolvedPath);
  if (stored && isManagedWorktreePath(worktreesRoot, stored) && existsSync(stored)) {
    return stored;
  }
  return project.cwd;
}

/** 请求体里带了 sessionPath 就按会话的 workspace 干活，没带就是项目目录。 */
function requestWorkspaceCwd(project, body) {
  const sessionPath = String(body?.sessionPath ?? "").trim();
  return sessionPath ? sessionWorkspaceCwdForPath(project, sessionPath) : project.cwd;
}

/** 要求这条会话现在确实跑在一个活着的托管 worktree 里（建分支 / 删除的入口闸）。 */
function requireSessionWorktreeCwd(project, sessionPath) {
  const cwd = sessionWorkspaceCwdForPath(project, sessionPath);
  if (!isManagedWorktreePath(worktreesRoot, cwd) || !existsSync(cwd)) {
    throw new Error("这条会话不在托管 worktree 里。");
  }
  return cwd;
}

/**
 * 读取一条会话的 worktree 信息（会话头部那枚 worktree 徽标的数据源）。
 * 不在托管 worktree 里就是 `{ isWorktree: false }`，UI 据此不显示徽标。
 */
async function readSessionWorktreeInfo(project, sessionPath) {
  const resolvedPath = assertProjectSessionPath(project, sessionPath);
  const cwd = sessionWorkspaceCwdForPath(project, resolvedPath);
  if (!isManagedWorktreePath(worktreesRoot, cwd)) {
    return { isWorktree: false };
  }

  const exists = existsSync(cwd);
  const changes = exists ? await readWorktreeChanges(cwd) : { changed: [], untracked: [], ignored: [] };
  const entries = await listManagedWorktrees(project.cwd, { root: worktreesRoot });
  const entry = entries.find((candidate) => resolve(candidate.path) === resolve(cwd));
  return {
    isWorktree: true,
    path: cwd,
    displayName: worktreeDisplayName(cwd),
    exists,
    branch: entry?.branchName ?? "",
    detached: entry ? entry.detached : true,
    changes: {
      changed: changes.changed.length,
      untracked: changes.untracked.length,
      ignored: changes.ignored.length,
    },
  };
}

/**
 * 删除一条会话的托管 worktree：清掉检出、把会话退回主检出。
 *
 * 三道闸：回答生成中不能删（会话还指着这个目录）；git 侧还有一道（有未提交内容且没 `force`
 * 就拒绝，见 `removeManagedWorktree`）；路由层只负责把用户二次确认后的 `force` 传下来。
 *
 * 目录已经被外部删掉时这里仍然放行：此时移除唯一的作用就是清掉 git 里的注册信息（在
 * `removeManagedWorktree` 里走 prune），不然那个红徽标永远点不掉。
 */
async function removeSessionWorktree(project, sessionPath, force) {
  const resolvedPath = assertProjectSessionPath(project, sessionPath);
  const cwd = sessionWorkspaceCwdForPath(project, resolvedPath);
  if (!isManagedWorktreePath(worktreesRoot, cwd)) {
    throw new Error("这条会话不在托管 worktree 里。");
  }
  const wasActive = resolvedPath === runtime.session.sessionFile;
  const openRuntime = openRuntimes.get(sessionRuntimeKey(resolvedPath));
  if (openRuntime && isSessionBusy(openRuntime.session)) {
    throw new Error("回答生成中，先等它结束再移除 worktree。");
  }

  await removeManagedWorktree(project.cwd, cwd, { root: worktreesRoot, force: Boolean(force) });
  diagnosticLog("worktree.removed", { projectId: project.id, worktreePath: cwd, reason: "user" });

  // 会话文件头里的 cwd 改不了（pi 不提供 setter），但目录已经没了 —— `sessionWorkspaceCwd`
  // 下一次就会退回项目目录，索引里的 cwd 也会在 upsert 时跟着改回项目目录。
  if (wasActive) {
    disposeRuntime(resolvedPath);
    return { result: await replaceRuntime(project, resolvedPath), worktree: await readSessionWorktreeInfo(project, resolvedPath) };
  }

  return { result: await refreshSnapshot(), worktree: await readSessionWorktreeInfo(project, resolvedPath) };
}

/**
 * 删除会话时顺手回收它自己的托管 worktree。
 *
 * 只删“还干净的那个”：worktree 里还有未提交内容时保留原地（那是用户的活，不能因为删了
 * 个聊天就没了），只写一条诊断。异步、不 await —— 清理失败不该让删会话失败。
 */
function scheduleWorktreeCleanup(project, resolvedPath) {
  const stored = sessionStore.findCwd(project.id, resolvedPath);
  if (!stored || !isManagedWorktreePath(worktreesRoot, stored)) {
    return;
  }

  void removeManagedWorktree(project.cwd, stored, { root: worktreesRoot })
    .then(() => diagnosticLog("worktree.removed", { projectId: project.id, worktreePath: stored, reason: "session_deleted" }))
    .catch((error) => diagnosticLog("worktree.remove_skipped", {
      projectId: project.id,
      worktreePath: stored,
      reason: error instanceof Error ? error.message : String(error),
    }));
}

function persistSessionShell(sessionManager) {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile || existsSync(sessionFile)) {
    return;
  }

  const entries = [sessionManager.getHeader(), ...sessionManager.getEntries()].filter(Boolean);
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  sessionManager.flushed = true;
}

function assertProjectSessionPath(project, sessionPath) {
  if (!sessionPath) {
    throw new Error("sessionPath is required");
  }

  const projectSessionDir = resolve(getProjectSessionDir(project));
  const resolvedPath = resolve(sessionPath);
  if (!resolvedPath.startsWith(projectSessionDir)) {
    throw new Error("Session does not belong to this project");
  }

  return resolvedPath;
}

function createProjectId(seed) {
  const prefix = String(seed ?? "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "project";
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function projectContextInstruction(project, workspaceCwd = project.cwd) {
  const inWorktree = workspaceCwd !== project.cwd;
  return [
    "## Active Project Context",
    `Project name: ${project.name}`,
    `Working directory: ${workspaceCwd}`,
    ...(inWorktree
      ? [
          `This session runs in an app-managed Git worktree (detached checkout) at the working directory above; the project's main checkout is ${project.cwd}.`,
          "Changes made here stay isolated from other sessions. Commit them in this worktree, or create a branch here, to keep the work.",
        ]
      : []),
    "When the user asks to read or write files without giving a concrete absolute path, interpret paths relative to the working directory above.",
    `Project skills directory: ${join(project.cwd, ".pi", "skills")}`,
    `User skills directory: ${agentSkillsDir}`,
    `System skills directory: ${appSkillsDir}`,
  ].join("\n");
}

function personalizationInstruction() {
  const sections = [
    "## User Personalization",
    `Response style: ${personalizationStyles[personalization.style]}`,
  ];

  if (personalization.persona) {
    sections.push("Persona:", personalization.persona);
  }
  if (personalization.customInstructions) {
    sections.push("Custom instructions that apply to every conversation:", personalization.customInstructions);
  }

  return sections.join("\n");
}

function parseTime(value) {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function readJsonFile(path) {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * `GET /api/bootstrap` carries the whole conversation (~0.3-0.9 MB) and the client
 * polls it, so an unchanged answer used to cost a full parse + normalise + merge on
 * the main thread every tick. Tag the payload with a content hash and let the client
 * revalidate; nothing else in this server is conditionally requested, which is why
 * this lives beside `sendJson` instead of inside it.
 */
function sendBootstrapJson(res, req, snapshot) {
  const body = JSON.stringify(snapshot);
  // Change detection only - no adversary can choose the input - so md5 is the cheap
  // and sufficient choice, and it stays cheap on a ~1 MB body.
  const etag = `"${createHash("md5").update(body).digest("hex")}"`;
  const headers = {
    ETag: etag,
    // `no-cache` (not `no-store`): the client may keep the last body and must be able
    // to ask whether it is still current.
    "Cache-Control": "no-cache",
    // The app runs on another origin, so `fetch` can only read ETag when it is exposed.
    "Access-Control-Expose-Headers": "ETag",
    ...corsHeaders(),
  };

  if (String(req.headers["if-none-match"] ?? "").trim() === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(body);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  res.end(JSON.stringify(body));
}

function sendNdjson(res, events) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...corsHeaders(),
  });
  for (const event of events) {
    res.write(`${JSON.stringify(event)}\n`);
  }
  res.end();
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
