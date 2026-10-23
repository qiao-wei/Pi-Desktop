import { normalizeProjectCommands, normalizeSelectedCommandId } from "../src/shared/projectCommands.ts";
import { agentRuntimePathEntries, mergePath, packageManagerBinDirs, selectAgentRuntimes } from "./agentEnv.mjs";
import { removeBundledShims, runtimeShimSpecs } from "./agentShimFiles.mjs";
import { createAgentShims } from "./agentShims.mjs";
import { bridgeUrlFor, isPortExplicit, preferredPort } from "./bridgeListen.mjs";
import { readJsonFile } from "./httpHelpers.mjs";
import { createModelLoginBroker } from "./modelLogin.mjs";
import { ModelRuntime, SettingsManager, initTheme, runPiCli } from "./piKernel.mjs";
import { createProjectId } from "./sessionHelpers.mjs";
import { normalizeComposerDefaults } from "./sessionModelPolicy.mjs";
import { agentDir, createSessionStore, diagnosticLines, diagnosticLog, diagnosticLogFile, diagnosticsEnabled, projectSessionRoot } from "./sessionStoreFactory.mjs";
import { errorDetails, normalizePersonalizationText, runtimeMode } from "./smallHelpers.mjs";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 启动块（路径/环境常量、state、PI 运行时装配）
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export async function createBridgeBoot() {

const host = process.env.PI_DESKTOP_HOST ?? process.env.ENGBUDDY_HOST ?? "127.0.0.1";

const requestedPort = preferredPort(process.env);

const portWasRequested = isPortExplicit(process.env);

/**
 * 桥运行期的**可变**状态，全部收在这一个显式对象里（`let` 散落顶层曾是拆分最大的障碍：
 * 任何用到它们的闭包都无法独立成模块）。读写分别是 `state.x` / `state.x = y`，
 * 位置保持原样，所以急切初始化的顺序不变。诊断相关的那两个 (`diagnosticFlushTimer` /
 * `diagnosticWriting`) 住在 `sessionStoreFactory.mjs` —— 它们只服务于那一簇。
 *
 * 字段类型按各字段**原始声明的推断结果**写（不是 nullable）：下面构造器里的 `null` 只是占位，
 * 真值在启动流程里陆续赋上（见后面的 `state.x = …`）。写成 nullable 会凭空要求几百处空检查。
 *
 * @typedef {object} BridgeState
 * @property {number} port
 * @property {string} apiBase
 * @property {ReturnType<typeof loadPersonalization>} personalization
 * @property {ReturnType<typeof loadProjects>} projects
 * @property {string} activeProjectId
 * @property {any} runtime —— 这里只能是 any：createRuntime 的返回类型反过来读 state.runtime
 *   （复用已开的会话），写成 `ReturnType<typeof createRuntime>` 会形成循环注解（TS2502）。
 * @property {Promise<unknown>} skillReloadQueue
 * @property {Set<string> | null} builtInProviderIdCache
 */
/** @type {BridgeState} */
const state = /** @type {BridgeState} */ (/** @type {unknown} */ ({
  port: requestedPort,
  apiBase: null,
  personalization: null,
  projects: [],
  activeProjectId: null,
  runtime: null,
  skillReloadQueue: Promise.resolve(),
  builtInProviderIdCache: null,
}));

const searchDocumentCache = new Map();

const searchDocumentCacheLimit = 512;

const mcpToolProbeTimeoutMs = Number(process.env.PI_DESKTOP_MCP_PROBE_TIMEOUT_MS ?? 15000);

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

const agentBinDir = join(agentDir, "bin");

const agentPythonBaseDir = join(agentDir, "python");

const agentPythonCacheDir = join(agentPythonBaseDir, "cache");

const agentNodeBaseDir = join(agentDir, "node");

const agentNodeCacheDir = join(agentDir, "npm-cache");

const agentNodeConfigFile = join(agentNodeBaseDir, "npmrc");

const agentShims = createAgentShims({
  agentPythonBaseDir,
  agentPythonCacheDir,
  agentNodeBaseDir,
  agentNodeCacheDir,
  agentNodeConfigFile,
});

const agentSkillsDir = join(agentDir, "skills");

const agentsSkillsDir = join(homedir(), ".agents", "skills");

const projectsFile = join(agentDir, "projects.json");

const commandRunsFile = join(agentDir, "command-runs.json");

const personalizationFile = join(agentDir, "personalization.json");

const capabilitiesFile = join(agentDir, "capabilities.json");

const authFile = join(agentDir, "auth.json");

const modelsJsonFile = join(agentDir, "models.json");

const projectAttachmentRoot = join(agentDir, "attachments");

const piDesktopCapabilitiesCustomType = "pi-desktop.capabilities";

const capabilitiesConfigVersion = 3;

const capabilitiesDefaultsFile = process.env.PI_DESKTOP_CAPABILITIES_DEFAULTS_FILE?.trim()
  || join(serverDir, "..", "capabilities.defaults.json");

const maxAttachmentCount = 10;

const maxAttachmentBytes = 25 * 1024 * 1024;

const maxAttachmentTotalBytes = 50 * 1024 * 1024;

const directoryMimeType = "inode/directory";

const generatedTitleMaxChars = 16;

const piCliFlag = "--pi-cli";

const http429StatusPatterns = [
  /^\s*(?:http\s*)?429\b/i,
  /\bhttp(?:\/\d+(?:\.\d+)?)?\s+429\b/i,
  /\bstatus(?:\s+code)?\s*[:=]?\s*429\b/i,
  /["']status["']\s*:\s*429\b/i,
];

const bundledNodeBinEnv = process.env.PI_DESKTOP_BUNDLED_NODE_BIN?.trim() || "";

const bundledNpmCliEnv = process.env.PI_DESKTOP_BUNDLED_NPM_CLI?.trim() || "";

const bundledPythonBinEnv = process.env.PI_DESKTOP_BUNDLED_PYTHON_BIN?.trim() || "";

const bundledPythonHomeEnv = process.env.PI_DESKTOP_BUNDLED_PYTHON_HOME?.trim() || "";

const bundledRuntimes = {
  node:
    existsSync(bundledNodeBinEnv) && existsSync(bundledNpmCliEnv)
      ? { bin: bundledNodeBinEnv, npmCli: bundledNpmCliEnv }
      : null,
  python: existsSync(bundledPythonBinEnv) ? { bin: bundledPythonBinEnv, home: bundledPythonHomeEnv } : null,
};

const runtimeSelection = selectAgentRuntimes({
  pathValue: process.env.PATH,
  // Everything this app (or a previous launch) put in front of the host PATH must not be judged
  // as "the user's node" - otherwise the bundled node we prepended last time counts as a system
  // runtime on the next start and the payload is never used again.
  ownDirs: [
    agentBinDir,
    ...(bundledRuntimes.node ? [dirname(bundledRuntimes.node.bin)] : []),
    ...packageManagerBinDirs(agentDir, process.platform),
  ],
  bundled: bundledRuntimes,
  // Slim packaging ships no payloads: never fall back to one, even if the environment says so.
  forceSystem: runtimeMode(),
  platform: process.platform,
});

function applyAgentRuntimePath() {
  const { prepend, append } = agentRuntimePathEntries({
    agentDir,
    selection: runtimeSelection,
    platform: process.platform,
  });
  if (runtimeSelection.python.source === "bundled") {
    // Anything we spawn (npm, pip, MCP servers, skill scripts) inherits this. Without it a stray
    // `python -c import ...` writes __pycache__ into the read-only app bundle, baking this
    // machine's paths into a shipped tree. The user's own Python is left alone: its caches are
    // its own business.
    process.env.PYTHONPYCACHEPREFIX = join(agentPythonCacheDir, "pycache");
  }
  const usable = [];
  for (const dir of prepend) {
    try {
      mkdirSync(dir, { recursive: true });
      usable.push(dir);
    } catch {
      // A directory that cannot be created holds nothing either; the launchers
      // report a missing bundled runtime themselves.
    }
  }
  const separator = process.platform === "win32" ? ";" : ":";
  const merged = mergePath(usable, process.env.PATH, process.platform);
  // Install output from a runtime we did *not* take over stays behind the host PATH: it is the
  // user's environment that should win, while a tool installed by an earlier bundled version
  // stays callable.
  process.env.PATH = append.length ? mergePath([], [merged, ...append].join(separator), process.platform) : merged;
  if (diagnosticsEnabled) {
    // `ps -E` only ever shows the environment a process was exec'd with, never a
    // later mutation, so the assembled PATH has to be reported by the process
    // itself for it to be checkable on a user's machine. The selection is part of
    // that fact: "the app ignored my nvm node" is not diagnosable from PATH alone.
    console.log(
      `[pi-desktop:diag] runtime node=${runtimeSelection.node.source} python=${runtimeSelection.python.source} PATH=${process.env.PATH ?? ""}`,
    );
  }
}

const piCliArgs = process.argv.slice(2).filter((arg) => arg !== piCliFlag);

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

const RUNTIME_SHIM_SPECS = runtimeShimSpecs();

/** Remove this family's launchers (it is not ours to provide), or write them. */
function syncRuntimeShims(family, takenOver) {
  if (!takenOver) {
    removeBundledShims({
      dir: agentBinDir,
      family,
      readFileSync,
      readlinkSync,
      rmSync,
      join,
      warn: (message) => console.error(`[pi-desktop] ${message}`),
    });
    return;
  }

  const bundled = family === "node" ? bundledRuntimes.node : bundledRuntimes.python;
  if (!bundled) {
    return;
  }
  const shimSpecs = RUNTIME_SHIM_SPECS.filter((shim) => shim.family === family);
  for (const shim of shimSpecs) {
    const shimPath = join(agentBinDir, shim.name);
    const content =
      family === "node"
        ? process.platform === "win32"
          ? agentShims.renderWindowsNodeShim(bundled.bin, bundled.npmCli, shim.kind)
          : agentShims.renderPosixNodeShim(bundled.bin, bundled.npmCli, shim.kind)
        : process.platform === "win32"
          ? agentShims.renderWindowsShim(bundled.bin, shim.kind, bundled.home)
          : agentShims.renderPosixShim(bundled.bin, shim.kind, bundled.home);
    if (process.platform === "win32") {
      writeFileSync(shimPath, content, "utf-8");
    } else {
      writeFileSync(shimPath, content, { encoding: "utf-8", mode: 0o755 });
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

function normalizeExtensionUiMode(value) {
  const mode = String(value ?? "").trim();
  return extensionUiModes.includes(mode) ? mode : defaultExtensionUiMode;
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

const modelLoginBroker = createModelLoginBroker();

const openRuntimes = new Map();

const activePackageCommands = new Map();

function normalizePersonalizationStyle(value) {
  const style = String(value ?? "").trim();
  return Object.hasOwn(personalizationStyles, style) ? style : "default";
}

function loadProjects() {
  const stored = readJsonFile(projectsFile);
  const now = Date.now();
  const parsed = Array.isArray(stored?.projects) ? stored.projects : [];
  const normalized = parsed
    .map((project) => {
      const id = String(project?.id ?? "").trim() || createProjectId(project?.name);
      const commands = normalizeProjectCommands(project?.commands);
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
        commands,
        selectedCommandId: normalizeSelectedCommandId(project?.selectedCommandId, commands),
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
      commands: [],
      selectedCommandId: "",
    },
  ];
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

try {
  initTheme(SettingsManager.create(appCwd, agentDir, { projectTrusted: false }).getTheme(), false);
} catch {
  initTheme(undefined, false);
}
// The `~/.pi/agent/bin` launchers, written on every start (see agentShims.mjs).
// 跨客户端技能约定目录（Agent Skills 的 `.agents/skills`）。pi 无条件发现它，这里把它并入
// 受管根：能力页才能显示来源、按会话开关；删除仍然禁止（见 assertWritableSkillTarget）。
// 后台命令的进程台账：桥重启后还能认出「上次那个 dev server 是否还活着」并给出停止入口。
// pi 自己的自定义模型文件：桥里的 modelRuntime 和命令行 pi 读同一份，Pi Desktop 的设置页只是它的编辑器。
state.apiBase = bridgeUrlFor(host, state.port);
// 目录附件的类型。客户端拖进文件夹时带的就是它（
// 见 `src/shared/attachmentKind.ts`），两边要一起改。
// npm and pip install into the agent directory (the launchers below force that
// prefix). Without their output directories on PATH an install succeeds and the
// app still cannot call the tool, which looks exactly like "not installed". This
// is the one place both shells (Electron, Tauri) and `npm run dev` share, so the
// rule lives here rather than being duplicated per shell.
// Which interpreter `node` / `python3` / `pip` mean is decided once, here: the user's own
// runtime wins, and the bundled payload only fills the gap (server/agentEnv.mjs has the
// reasoning, including why macOS `/usr/bin/python3` does not count as "the user's Python").
// The shells only put `agentDir/bin` in front of the login-shell PATH, so the judgement runs on
// the same PATH it later injects into - see `ownDirs` below.
// The pi CLI is where tools and skills actually run, and this branch exits before
// everything else, so the runtime PATH has to be assembled above it.
applyAgentRuntimePath();

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

diagnosticLog("server.start", { apiBase: state.apiBase, diagnosticLogFile, cwd: appCwd });

// See server/agentShimFiles.mjs: the writer and the cleaner share one name list on purpose.
// This has to be declared before the bootstrap below runs: those functions are called at module
// top level, so a `const` sitting after it is in its temporal dead zone and throws.
// Writing the launchers must never take the bridge down: without them skills lose
// node/python, but a window that cannot reach the API is a worse failure, and an
// uncaught throw here used to be silent.
try {
  ensurePiShim();
  // Per runtime, not per install: a machine with node but no python gets the python launchers
  // and one the machine's own node. The launchers for a runtime we did *not* take over are
  // removed - `~/.pi/agent/bin` is first on PATH, so a leftover launcher pointing at a payload
  // (or a deleted one) would shadow the user's own interpreter with `exit 127`, which looks
  // exactly like "the tool is not installed".
  syncRuntimeShims("node", runtimeSelection.node.source === "bundled");
  syncRuntimeShims("python", runtimeSelection.python.source === "bundled");
} catch (error) {
  console.error(
    `[pi-desktop] could not refresh ${agentBinDir} launchers: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// Headless stand-in for pi's Theme. Extensions receive this wherever the TUI would hand
// them a real theme (ctx.ui.custom factory args, ctx.ui.theme) and render plain text, so
// every color/weight helper just returns its input. Every Theme method must exist: a
// missing one (e.g. `bold`) throws inside the extension's factory synchronously, which
// finishes the custom dialog as `closed` before the frontend ever sees it — the command
// then fails silently (pi catches command errors and only reports them to error
// listeners). That is exactly how clicking /review used to do nothing.
// 供应商登录（OAuth / 交互式 API key）：一个会话一条 NDJSON 流，答复走 POST。
// 名单不在这里，全部读 provider.auth —— 见 server/modelLogin.mjs。
state.personalization = loadPersonalization();
state.projects = loadProjects();
state.activeProjectId = readActiveProjectId(state.projects);
const sessionStore = await createSessionStore(state.projects);

  return { sessionStore, RUNTIME_SHIM_SPECS, activePackageCommands, agentBinDir, agentNodeBaseDir, agentNodeCacheDir, agentNodeConfigFile, agentPythonBaseDir, agentPythonCacheDir, agentShims, agentSkillsDir, agentsSkillsDir, appCwd, appPackagesDir, appSkillsDir, applyAgentRuntimePath, authFile, bundledNodeBinEnv, bundledNpmCliEnv, bundledPythonBinEnv, bundledPythonHomeEnv, bundledRuntimes, bundledSkillsDir, capabilitiesConfigVersion, capabilitiesDefaultsFile, capabilitiesFile, commandRunsFile, defaultExtensionUiMode, directoryMimeType, ensurePiShim, extensionUiAnsiAccent, extensionUiModes, flushDiagnosticsSync, generatedTitleMaxChars, getPiCliArgs, host, hostSystemPrompt, http429StatusPatterns, loadPersonalization, loadProjects, maxAttachmentBytes, maxAttachmentCount, maxAttachmentTotalBytes, mcpToolProbeTimeoutMs, modelLoginBroker, modelRuntime, modelsJsonFile, normalizeExtensionUiMode, normalizePersonalizationStyle, openRuntimes, personalizationFile, personalizationStyles, piCliArgs, piCliFlag, piDesktopCapabilitiesCustomType, portWasRequested, projectAttachmentRoot, projectsFile, readActiveProjectId, requestedPort, runtimeSelection, searchDocumentCache, searchDocumentCacheLimit, serverDir, state, syncRuntimeShims  };
}
