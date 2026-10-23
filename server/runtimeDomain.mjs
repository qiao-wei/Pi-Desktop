import { canonicalPath, extensionCapabilityId, isPathInside } from "./capabilityPathIdentity.mjs";
import { reloadRuntimeSkills } from "./capabilityReload.mjs";
import { applySkillSelection } from "./capabilitySkillSelection.mjs";
import { ProjectTrustStore, SessionManager, SettingsManager, createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, createCodemodeExtension, createMcpExtension, createToolSearchExtension } from "./piKernel.mjs";
import { resolveProjectTrustForRuntime } from "./runtimeTrust.mjs";
import { MODEL_APPLY_REASONS, applyModelToSession, composerDefaultModelReference, isFreshSession, normalizeComposerDefaults } from "./sessionModelPolicy.mjs";
import { agentDir, diagnosticLog, getProjectSessionDir, sessionWorkspaceCwd } from "./sessionStoreFactory.mjs";
import { isSessionBusy, sessionRuntimeKey } from "./smallHelpers.mjs";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 会话运行时生命周期（创建/替换/销毁、能力路径刷新）
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createRuntimeDomain(state, deps) {
  const { hostSystemPrompt, modelRuntime, openRuntimes, sessionStore } = deps;
  const findProject = /** @type {any} */ ((...args) => deps.findProject(...args));
  const createPiDesktopRuntimeExtension = /** @type {any} */ ((...args) => deps.createPiDesktopRuntimeExtension(...args));
  // 跨域引用：由别的域工厂提供，且两边可能互相调用 —— 转发到共享的 deps，调用时才取。
  const discoverAllProjectSkills = /** @type {any} */ ((...args) => deps.discoverAllProjectSkills(...args));
  const discoverBuiltinPackagePaths = /** @type {any} */ ((...args) => deps.discoverBuiltinPackagePaths(...args));
  const isManagedSkillPath = /** @type {any} */ ((...args) => deps.isManagedSkillPath(...args));
  const managedSkills = /** @type {any} */ ((...args) => deps.managedSkills(...args));
  const reportSkillInventoryMismatch = /** @type {any} */ ((...args) => deps.reportSkillInventoryMismatch(...args));
  // 跨域引用：由别的域工厂提供，且两边可能互相调用 —— 转发到共享的 deps，调用时才取。
  const ensureWorktreePiLink = /** @type {any} */ ((...args) => deps.ensureWorktreePiLink(...args));
  const listProjectSessions = /** @type {any} */ ((...args) => deps.listProjectSessions(...args));
  const touchProject = /** @type {any} */ ((...args) => deps.touchProject(...args));
  // 跨域引用：由别的域工厂提供，且两边可能互相调用 —— 转发到共享的 deps，调用时才取。
  const defaultComposerModel = /** @type {any} */ ((...args) => deps.defaultComposerModel(...args));
  const isHttp429ProviderError = /** @type {any} */ ((...args) => deps.isHttp429ProviderError(...args));
  const isUsableModel = /** @type {any} */ ((...args) => deps.isUsableModel(...args));
  const resolveModel = /** @type {any} */ ((...args) => deps.resolveModel(...args));
  const usableDefaultModel = /** @type {any} */ ((...args) => deps.usableDefaultModel(...args));
  const bindPiDesktopSessionExtensions = /** @type {any} */ ((...args) => deps.bindPiDesktopSessionExtensions(...args));
  const createExtensionUiBridge = /** @type {any} */ ((...args) => deps.createExtensionUiBridge(...args));
  const createPiDesktopSkillTools = /** @type {any} */ ((...args) => deps.createPiDesktopSkillTools(...args));
  const ensureCapabilitiesConfigInitialized = /** @type {any} */ ((...args) => deps.ensureCapabilitiesConfigInitialized(...args));
  const refreshRuntimeCapabilityPaths = /** @type {any} */ ((...args) => deps.refreshRuntimeCapabilityPaths(...args));
  const refreshSnapshot = /** @type {any} */ ((...args) => deps.refreshSnapshot(...args));
  const resolveRuntimeCapabilityPaths = /** @type {any} */ ((...args) => deps.resolveRuntimeCapabilityPaths(...args));

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
  // codemode / tool_search 是 pi 0.99 的内置扩展，注册时是 inactive，要靠 settings 里的
  // `defaultTools` 打开。Desktop **不替用户默认打开**：这里既不写文件也不 applyOverrides，
  // 读的就是 pi 自己的那份设置（不写 = 内建 read/bash/edit/write）。开关在「设置 → 个性化」，
  // 项目层写在项目自己的 `.pi/settings.json`，和终端 TUI 是同一个键，两边不可能不一致。
  // 有 codemode 型 MCP 服务器时 pi 仍会自动激活 codemode —— 内核行为，这里不插手。

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
  /** @type {{ current: any }} */
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
          // pi 的 CLI 把这几个当内置扩展加载；SDK 宿主必须自己加进 factories
          // （docs/sdk.md#codemode-mcp）。加进来才能和 TUI 用同一份内核：
          // - codemode：QuickJS 沙箱里跑模型写的 JS，可并行调工具；
          // - tool_search：把 deferred（如 MCP）工具搜出来声明给模型；
          // - mcp：读 agent 目录的 mcp.json + 信任项目的 .pi/mcp.json，session_start 连接。
          createCodemodeExtension(),
          createToolSearchExtension(),
          createMcpExtension(),
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
      // 内核的 `CreateAgentSessionRuntimeResult` 要求这个字段（扩展加载结果，进 trust 判定用）。
      extensionsResult: created.extensionsResult,
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

  state.runtime = nextRuntime;
  state.activeProjectId = project.id;
  touchProject(project.id, { lastSessionPath: state.runtime.session.sessionFile });
  const snapshot = await refreshSnapshot({ traceSessionSwitch: true });
  diagnosticLog("session.switch.runtime.response_ready", {
    projectId: project.id,
    sessionPath: state.runtime.session.sessionFile,
    durationMs: Date.now() - startedAt,
    messageCount: snapshot.snapshot?.conversation?.messages?.length,
  });
  return snapshot;
}

function getRuntimeForRequest(body) {
  const requestedSessionPath = String(body?.sessionPath ?? "").trim();
  if (!requestedSessionPath) {
    return state.runtime;
  }

  const targetRuntime = openRuntimes.get(sessionRuntimeKey(requestedSessionPath));
  if (!targetRuntime) {
    throw new Error("Session is not open.");
  }

  return targetRuntime;
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

  return { allowHttp429Retry, createRuntime, disposeRuntime, ensureBuiltinPackages, ensureModelSelection, getRuntimeForRequest, readRuntimeCapabilityContext, replaceRuntime };
}
