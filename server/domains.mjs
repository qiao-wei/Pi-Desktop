import { createBridgeUtils } from "./bridgeUtils.mjs";
import { createCapabilitySnapshot } from "./capabilitySnapshot.mjs";
import { createExtensionUiDomain } from "./extensionUiDomain.mjs";
import { createMcpInspector } from "./mcpInspector.mjs";
import { createMcpServers } from "./mcpServers.mjs";
import { createModelLeaves } from "./modelLeaves.mjs";
import { createModelProviders } from "./modelProviders.mjs";
import { createProjectSessions } from "./projectSessions.mjs";
import { createPromptStream } from "./promptStream.mjs";
import { createRoutesApp } from "./routesApp.mjs";
import { createRoutesProjects } from "./routesProjects.mjs";
import { createRuntimeDomain } from "./runtimeDomain.mjs";
import { createSessionSnapshots } from "./sessionSnapshots.mjs";
import { createSkillLeaves } from "./skillLeaves.mjs";
import { createSkillPackages } from "./skillPackages.mjs";

/**
 * 组合区：把各域工厂建起来，并填满共享的 `deps`。
 *
 * 每个域一个工厂：搬出去的定义通过 `deps` 注入，返回值解构成**同名**局部变量（域内部用），
 * 域之间靠共享的 `deps` 互相取用（跨域引用是转发函数，所以建厂顺序不重要）。
 * 入口只需要它自己用到的名字，其余留在本模块。
 *
 * `scope` 是入口启动块里的值（`appCwd`、`openRuntimes` 这类），入口在这里把它们
 * 放进 `deps`，域工厂才好按名字解构。
 *
 * 由 `.scratch/extract-composition.mjs` 从 `server/index.mjs` 搬过来。
 */
export function createBridgeDomains(state, deps, scope) {
  const {
    activePackageCommands,
    agentSkillsDir,
    agentsSkillsDir,
    appCwd,
    appPackagesDir,
    appSkillsDir,
    authFile,
    capabilitiesConfigVersion,
    capabilitiesDefaultsFile,
    capabilitiesFile,
    commandRunsFile,
    directoryMimeType,
    extensionUiAnsiAccent,
    generatedTitleMaxChars,
    hostSystemPrompt,
    http429StatusPatterns,
    maxAttachmentBytes,
    maxAttachmentCount,
    maxAttachmentTotalBytes,
    mcpToolProbeTimeoutMs,
    modelLoginBroker,
    modelRuntime,
    modelsJsonFile,
    normalizeExtensionUiMode,
    normalizePersonalizationStyle,
    openRuntimes,
    personalizationFile,
    personalizationStyles,
    piDesktopCapabilitiesCustomType,
    projectAttachmentRoot,
    projectsFile,
    searchDocumentCache,
    searchDocumentCacheLimit,
    sessionStore,
  } = scope;

  Object.assign(deps, { mcpToolProbeTimeoutMs });
  const mcpInspector = createMcpInspector(state, deps);
  const { inspectMcpServerCapability, readMcpRuntimeState } = mcpInspector;
  Object.assign(deps, mcpInspector);
  Object.assign(deps, { appCwd, openRuntimes, readMcpRuntimeState });
  const mcpServers = createMcpServers(state, deps);
  const {
    mcpCapabilityEntries,
    projectToolToggleState,
    readMcpServerCapability,
    removeMcpServer,
    saveMcpServer,
    saveToolSettings,
    toolSettingsSnapshotFor,
  } = mcpServers;
  Object.assign(deps, mcpServers);
  Object.assign(deps, {
    directoryMimeType,
    maxAttachmentBytes,
    maxAttachmentCount,
    maxAttachmentTotalBytes,
    modelRuntime,
    projectAttachmentRoot,
  });
  const promptStream = createPromptStream(state, deps);
  const { streamPrompt } = promptStream;
  Object.assign(deps, promptStream);
  Object.assign(deps, {
    directoryMimeType,
    generatedTitleMaxChars,
    modelRuntime,
    openRuntimes,
    projectAttachmentRoot,
    searchDocumentCache,
    searchDocumentCacheLimit,
    sessionStore,
    toolSettingsSnapshotFor,
  });
  const sessionSnapshots = createSessionSnapshots(state, deps);
  const {
    abortSession,
    buildAmbientSnapshot,
    buildSnapshot,
    refreshSnapshot,
    searchSessionDocuments,
    sendAttachment,
    sendLocalMedia,
    stopSession,
    updateSessionStoreFromRuntime,
    updateSessionStoreFromSession,
  } = sessionSnapshots;
  Object.assign(deps, sessionSnapshots);
  Object.assign(deps, {
    agentSkillsDir,
    agentsSkillsDir,
    appSkillsDir,
    capabilitiesConfigVersion,
    capabilitiesDefaultsFile,
    capabilitiesFile,
    mcpCapabilityEntries,
    readMcpRuntimeState,
  });
  const capabilitySnapshot = createCapabilitySnapshot(state, deps);
  const {
    buildCapabilitiesSnapshot,
    defaultSessionCapabilitySelection,
    ensureCapabilitiesConfigInitialized,
    mergeSessionCapabilitySelection,
    readCapabilitiesConfig,
    refreshRuntimeCapabilityPaths,
    resolveRuntimeCapabilityPaths,
    setCapabilityPinned,
    setDefaultCapability,
    setSessionExtensionCapability,
    setSessionPackageCapability,
    setSessionSkillCapability,
    writeCapabilitiesConfig,
  } = capabilitySnapshot;
  Object.assign(deps, capabilitySnapshot);
  Object.assign(deps, {
    activePackageCommands,
    buildCapabilitiesSnapshot,
    buildSnapshot,
    readCapabilitiesConfig,
    refreshRuntimeCapabilityPaths,
    refreshSnapshot,
    updateSessionStoreFromRuntime,
    writeCapabilitiesConfig,
  });
  const skillPackages = createSkillPackages(state, deps);
  const {
    addCapabilityExtension,
    createPiDesktopSkillTools,
    deleteSkillFromCapabilityPage,
    findCapabilityPackageCommand,
    installCapabilityPackage,
    installPiDesktopSkill,
    readCapabilityPackageFile,
    reloadRuntimeTargets,
    removeCapabilityExtension,
    removeCapabilityPackage,
    streamCapabilityPackageAction,
    streamCapabilityPackageCommand,
  } = skillPackages;
  Object.assign(deps, skillPackages);
  Object.assign(deps, {
    abortSession,
    activePackageCommands,
    appCwd,
    extensionUiAnsiAccent,
    normalizeExtensionUiMode,
    openRuntimes,
    refreshSnapshot,
  });
  const extensionUiDomain = createExtensionUiDomain(state, deps);
  const { bindPiDesktopSessionExtensions, createExtensionUiBridge, respondToExtensionUiRequest } =
    extensionUiDomain;
  Object.assign(deps, extensionUiDomain);
  Object.assign(deps, {
    bindPiDesktopSessionExtensions,
    createExtensionUiBridge,
    createPiDesktopSkillTools,
    ensureCapabilitiesConfigInitialized,
    hostSystemPrompt,
    modelRuntime,
    openRuntimes,
    refreshRuntimeCapabilityPaths,
    refreshSnapshot,
    resolveRuntimeCapabilityPaths,
    sessionStore,
  });
  const runtimeDomain = createRuntimeDomain(state, deps);
  const { disposeRuntime, getRuntimeForRequest, replaceRuntime } = runtimeDomain;
  Object.assign(deps, runtimeDomain);
  Object.assign(deps, {
    buildSnapshot,
    getRuntimeForRequest,
    http429StatusPatterns,
    modelLoginBroker,
    modelRuntime,
    modelsJsonFile,
  });
  const modelProviders = createModelProviders(state, deps);
  const {
    customModelsPayload,
    deleteCustomModel,
    discoverProviderModels,
    isUsableModel,
    listAvailableModels,
    providerCatalogRow,
    providerRows,
    repairDefaultModelAfterRemoval,
    saveCustomModel,
    setModelConfiguration,
    streamModelLogin,
    testCustomModelConnection,
    updateProvider,
  } = modelProviders;
  Object.assign(deps, modelProviders);
  Object.assign(deps, {
    appCwd,
    buildSnapshot,
    commandRunsFile,
    disposeRuntime,
    getRuntimeForRequest,
    openRuntimes,
    projectToolToggleState,
    projectsFile,
    refreshSnapshot,
    replaceRuntime,
    sessionStore,
    updateSessionStoreFromRuntime,
    updateSessionStoreFromSession,
  });
  const projectSessions = createProjectSessions(state, deps);
  const {
    archiveProjectSession,
    createProject,
    createProjectSession,
    deleteArchivedSessions,
    listProjectSessions,
    pinProject,
    projectCommandRuns,
    readSessionWorktreeInfo,
    removeProject,
    removeSessionWorktree,
    reorderProjects,
    revealProject,
    selectProject,
    selectProjectSession,
    sessionWorkspaceCwdForPath,
    setSessionThinkingLevel,
    touchProject,
    updateProject,
    updateProjectSession,
  } = projectSessions;
  Object.assign(deps, projectSessions);
  Object.assign(deps, {
    agentSkillsDir,
    agentsSkillsDir,
    appPackagesDir,
    appSkillsDir,
    buildCapabilitiesSnapshot,
    buildSnapshot,
    defaultSessionCapabilitySelection,
    findCapabilityPackageCommand,
    getRuntimeForRequest,
    installPiDesktopSkill,
    mergeSessionCapabilitySelection,
    openRuntimes,
    piDesktopCapabilitiesCustomType,
    refreshSnapshot,
    reloadRuntimeTargets,
  });
  const skillLeaves = createSkillLeaves(state, deps);
  const {
    importSkillFromCapabilityPage,
    lastCapabilityLoadStatuses,
    readCapabilityCommandArguments,
    readCapabilityPackageResources,
    readSkillContent,
    reloadOpenRuntimeCapabilities,
    reloadPiDesktopSkills,
    updateCapabilityPackage,
  } = skillLeaves;
  Object.assign(deps, skillLeaves);
  Object.assign(deps, {
    authFile,
    buildSnapshot,
    customModelsPayload,
    getRuntimeForRequest,
    modelRuntime,
    modelsJsonFile,
    normalizeExtensionUiMode,
    normalizePersonalizationStyle,
    personalizationFile,
    personalizationStyles,
    providerRows,
  });
  const modelLeaves = createModelLeaves(state, deps);
  const {
    modelProviderCatalog,
    readStoredApiKey,
    reloadCustomModelProviders,
    saveProviderApiKey,
    setPersonalization,
  } = modelLeaves;
  Object.assign(deps, modelLeaves);
  Object.assign(deps, {
    agentSkillsDir,
    appSkillsDir,
    buildSnapshot,
    disposeRuntime,
    getRuntimeForRequest,
    hostSystemPrompt,
    lastCapabilityLoadStatuses,
    listProjectSessions,
    openRuntimes,
    refreshSnapshot,
    reloadOpenRuntimeCapabilities,
    reloadRuntimeTargets,
    replaceRuntime,
    sessionStore,
    sessionWorkspaceCwdForPath,
    touchProject,
    updateSessionStoreFromRuntime,
  });
  const bridgeUtils = createBridgeUtils(state, deps);
  const {
    deleteProjectSession,
    findProject,
    pinProjectSession,
    requestWorkspaceCwd,
    requireSessionWorktreeCwd,
    runBuiltinCommand,
    trustProject,
  } = bridgeUtils;
  Object.assign(deps, bridgeUtils);
  Object.assign(deps, {
    archiveProjectSession,
    createProject,
    createProjectSession,
    deleteArchivedSessions,
    deleteProjectSession,
    findProject,
    getRuntimeForRequest,
    isUsableModel,
    modelRuntime,
    pinProject,
    pinProjectSession,
    projectCommandRuns,
    readSessionWorktreeInfo,
    removeProject,
    removeSessionWorktree,
    reorderProjects,
    requestWorkspaceCwd,
    requireSessionWorktreeCwd,
    revealProject,
    selectProject,
    selectProjectSession,
    touchProject,
    trustProject,
    updateProject,
    updateProjectSession,
  });
  const routesProjects = createRoutesProjects(state, deps);

  Object.assign(deps, routesProjects);
  Object.assign(deps, {
    addCapabilityExtension,
    buildAmbientSnapshot,
    buildCapabilitiesSnapshot,
    buildSnapshot,
    customModelsPayload,
    deleteCustomModel,
    deleteSkillFromCapabilityPage,
    discoverProviderModels,
    getRuntimeForRequest,
    importSkillFromCapabilityPage,
    inspectMcpServerCapability,
    installCapabilityPackage,
    listAvailableModels,
    modelLoginBroker,
    modelProviderCatalog,
    modelRuntime,
    providerCatalogRow,
    readCapabilityCommandArguments,
    readCapabilityPackageFile,
    readCapabilityPackageResources,
    readMcpServerCapability,
    readSkillContent,
    readStoredApiKey,
    refreshSnapshot,
    reloadCustomModelProviders,
    reloadPiDesktopSkills,
    removeCapabilityExtension,
    removeCapabilityPackage,
    removeMcpServer,
    repairDefaultModelAfterRemoval,
    respondToExtensionUiRequest,
    runBuiltinCommand,
    saveCustomModel,
    saveMcpServer,
    saveProviderApiKey,
    saveToolSettings,
    searchSessionDocuments,
    sendAttachment,
    sendLocalMedia,
    setCapabilityPinned,
    setDefaultCapability,
    setModelConfiguration,
    setPersonalization,
    setSessionExtensionCapability,
    setSessionPackageCapability,
    setSessionSkillCapability,
    setSessionThinkingLevel,
    stopSession,
    streamCapabilityPackageAction,
    streamCapabilityPackageCommand,
    streamModelLogin,
    streamPrompt,
    testCustomModelConnection,
    updateCapabilityPackage,
    updateProvider,
  });
  const routesApp = createRoutesApp(state, deps);

  Object.assign(deps, routesApp);

  return {
    ...mcpInspector,
    ...mcpServers,
    ...promptStream,
    ...sessionSnapshots,
    ...capabilitySnapshot,
    ...skillPackages,
    ...extensionUiDomain,
    ...runtimeDomain,
    ...modelProviders,
    ...projectSessions,
    ...skillLeaves,
    ...modelLeaves,
    ...bridgeUtils,
    ...routesProjects,
    ...routesApp,
  };
}
