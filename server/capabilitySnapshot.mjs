import { PI_DESKTOP_BUILTIN_COMMANDS } from "./builtinCommands.mjs";
import { summarizePackageHealth } from "./capabilityHealth.mjs";
import { commandMatchesPackage, normalizeCapabilityMetadataMap, normalizeMcpCapabilityMetadataMap, packageDescription, packageDisplayName, parseMcpCapabilityId, resolvePackageResources, setPackageAutoload } from "./capabilityMetadata.mjs";
import { summarizePackageResources } from "./capabilityPackageResources.mjs";
import { canonicalPath, extensionCapabilityId, isPathInside, isReadOnlySkillSource, skillSourceForPath } from "./capabilityPathIdentity.mjs";
import { capabilityReloadPlan, reloadRuntimeSkills } from "./capabilityReload.mjs";
import { createSkillSelectionPolicy, replaceSkillSelectionPolicy, skillEnabledBySelection } from "./capabilitySkillSelection.mjs";
import { patchMcpServer, readMcpConfigPath, writeMcpConfigPath } from "./mcpConfig.mjs";
import { enabledResourcePaths, packageCapabilityId } from "./packageHelpers.mjs";
import { agentDir } from "./sessionStoreFactory.mjs";
import { assertMcpWriteScope, createEmptyCapabilitiesDefaults, isSessionBusy, mcpMetaKey } from "./smallHelpers.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * 能力快照与选择（技能/包/扩展的会话级开关）
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createCapabilitySnapshot(state, deps) {
  const { agentSkillsDir, agentsSkillsDir, appSkillsDir, capabilitiesConfigVersion, capabilitiesDefaultsFile, capabilitiesFile } = deps;
  const findProject = /** @type {any} */ ((...args) => deps.findProject(...args));
  const reportUnhealthyLoads = /** @type {any} */ ((...args) => deps.reportUnhealthyLoads(...args));
  const discoverStandaloneExtensionPaths = /** @type {any} */ ((...args) => deps.discoverStandaloneExtensionPaths(...args));
  const extensionDefaultEnabled = /** @type {any} */ ((...args) => deps.extensionDefaultEnabled(...args));
  const loadedExtensionReport = /** @type {any} */ ((...args) => deps.loadedExtensionReport(...args));
  const activeSessionCapabilitySelection = /** @type {any} */ ((...args) => deps.activeSessionCapabilitySelection(...args));
  const appendSessionCapabilitySelection = /** @type {any} */ ((...args) => deps.appendSessionCapabilitySelection(...args));
  const applyMissingDefaultEnabledSkillNames = /** @type {any} */ ((...args) => deps.applyMissingDefaultEnabledSkillNames(...args));
  const compareCapabilityCards = /** @type {any} */ ((...args) => deps.compareCapabilityCards(...args));
  const configuredPackagesForRuntime = /** @type {any} */ ((...args) => deps.configuredPackagesForRuntime(...args));
  const defaultSkillIdsForSkills = /** @type {any} */ ((...args) => deps.defaultSkillIdsForSkills(...args));
  const discoverAllProjectSkillResources = /** @type {any} */ ((...args) => deps.discoverAllProjectSkillResources(...args));
  const isManagedSkillPath = /** @type {any} */ ((...args) => deps.isManagedSkillPath(...args));
  const managedSkills = /** @type {any} */ ((...args) => deps.managedSkills(...args));
  const normalizeCapabilitiesDefaults = /** @type {any} */ ((...args) => deps.normalizeCapabilitiesDefaults(...args));
  const normalizeCapabilityId = /** @type {any} */ ((...args) => deps.normalizeCapabilityId(...args));
  const normalizeSessionCapabilitySelection = /** @type {any} */ ((...args) => deps.normalizeSessionCapabilitySelection(...args));
  const packageDefaultEnabled = /** @type {any} */ ((...args) => deps.packageDefaultEnabled(...args));
  const packageResourcesForRuntime = /** @type {any} */ ((...args) => deps.packageResourcesForRuntime(...args));
  const projectAgentsSkillsDirs = /** @type {any} */ ((...args) => deps.projectAgentsSkillsDirs(...args));
  const reloadOpenRuntimeCapabilities = /** @type {any} */ ((...args) => deps.reloadOpenRuntimeCapabilities(...args));
  const reloadOpenRuntimeSkills = /** @type {any} */ ((...args) => deps.reloadOpenRuntimeSkills(...args));
  const skillCapabilityId = /** @type {any} */ ((...args) => deps.skillCapabilityId(...args));
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));
  const mcpCapabilityEntries = /** @type {any} */ ((...args) => deps.mcpCapabilityEntries(...args));
  const readMcpRuntimeState = /** @type {any} */ ((...args) => deps.readMcpRuntimeState(...args));
  const readRuntimeCapabilityContext = /** @type {any} */ ((...args) => deps.readRuntimeCapabilityContext(...args));

async function resolveRuntimeCapabilityPaths({ project, settingsManager, sessionManager }) {
  const packages = configuredPackagesForRuntime({
    projectId: project.id,
    settingsManager,
  });
  const skillResources = await discoverAllProjectSkillResources(project, settingsManager);
  const allSkills = skillResources.skills;
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
    const resolved = await resolvePackageResources({ project, settingsManager, agentDir, pkg });
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
    // pi 加载器对技能的诊断（重名冲突、frontmatter 非法…）。跟 skillInventory 同源同刻，
    // 所以在能力页里「少了哪个技能」和「为什么少」永远对得上。
    skillDiagnostics: skillResources.diagnostics,
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
  current.skillDiagnostics = next.skillDiagnostics;
  return current;
}

function createEmptyCapabilitiesConfig() {
  // `mcp` 是 Pi Desktop 自有的 MCP 元数据（pinned / 描述），键是 `<scope>:<server>`；
  // 服务器定义本身住在 pi 的 `mcp.json` 里（见 server/mcpConfig.mjs）。
  return {
    version: capabilitiesConfigVersion,
    skills: {},
    packages: {},
    extensions: {},
    mcp: {},
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

  return {
    version: Number(source.version ?? capabilitiesConfigVersion),
    skills,
    packages: normalizeCapabilityMetadataMap(source.packages),
    extensions: normalizeCapabilityMetadataMap(source.extensions),
    mcp: normalizeMcpCapabilityMetadataMap(source.mcp),
  };
}

function defaultSessionCapabilitySelection(config, skills, targetRuntime = state.runtime) {
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

function mergeSessionCapabilitySelection(selection, skills, config, targetRuntime = state.runtime) {
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

async function buildCapabilitiesSnapshot(targetRuntime = state.runtime, _options = {}) {
  const project = findProject(targetRuntime.projectId);
  // Reuse the set pi's session loader actually discovered (post-trust, post-package).
  // Re-running a discovery pass here would cost a full resource resolve per snapshot *and*
  // could disagree with what the session really loaded - which is exactly how project
  // skills went missing while the page still claimed they were active.
  const fallbackSkillResources = targetRuntime.capabilityPaths?.skillInventory
    ? null
    : await discoverAllProjectSkillResources(project, targetRuntime.settingsManager);
  const allSkills = targetRuntime.capabilityPaths?.skillInventory
    ?? fallbackSkillResources?.skills
    ?? [];
  // pi 加载器的诊断跟清单同源：重名冲突时它保留先发现的那份，丢掉的必须有个解释。
  const skillDiagnostics = targetRuntime.capabilityPaths?.skillDiagnostics ?? fallbackSkillResources?.diagnostics ?? [];
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
    await Promise.all(packages.map(async (pkg) =>
      /** @type {[string, Awaited<ReturnType<typeof packageResourcesForRuntime>>]} */ ([pkg.id, await packageResourcesForRuntime(targetRuntime, pkg)]))),
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
  // MCP 不再读 capabilities.json（那里只剩 app 元数据）：服务器定义来自 pi 的 mcp.json，
  // 工具/连接状态来自会话，见 mcpCapabilityEntries。
  const mcpServers = mcpCapabilityEntries(targetRuntime).entries;

  return {
    skills: managed
      .map((skill) => {
        const id = skillCapabilityId(skill);
        const metadata = config.skills[id] ?? {};
        const source = skillSourceForPath(skill.filePath, {
          builtin: appSkillsDir,
          piAgent: agentSkillsDir,
          agents: agentsSkillsDir,
          projectAgents: projectAgentsSkillsDirs(project),
        });
        return {
          id,
          kind: "skill",
          name: skill.name,
          description: skill.description,
          path: skill.filePath,
          source,
          disableModelInvocation: skill.disableModelInvocation,
          defaultEnabled: metadata.defaultEnabled === true,
          pinned: Boolean(metadata.pinned),
          active: skillEnabledBySelection(skillPolicy, id),
          // 内置与跨客户端（~/.agents/skills）来源只读：前者是应用资产，后者可能被别的
          // 客户端一起挂载。只有 piAgent / project 能在能力页删除。
          readonly: isReadOnlySkillSource(source),
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
          // 命令自己注册了参数补全（TUI 的 getArgumentCompletions）时，composer 才去
          // 问服务端要候选；没注册的命令不产生多一笔请求，也不显示参数菜单。
          hasArgumentCompletions: typeof command.getArgumentCompletions === "function",
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
    builtinCommands: PI_DESKTOP_BUILTIN_COMMANDS,
    session: sessionSelection,
    // pi 设置 `enableSkillCommands`（default true）：false 时 TUI 不把技能注册成命令。
    // 桌面 `/` 菜单跟着不列技能项，但手打 `/skill:<名字>` 仍然可用（见 slashMenu.ts）。
    skillCommandsEnabled: targetRuntime.settingsManager?.getEnableSkillCommands?.() !== false,
    // 技能加载告警：重名冲突时 pi 保留先发现的那份，用户只会看到「某个技能不见了」。
    skillDiagnostics,
    extensionErrors: loadHealth.unattributedErrors.map((error) => (error.path ? `${error.message}（${error.path}）` : error.message)),
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
    const parsed = parseMcpCapabilityId(id);
    if (!parsed) {
      throw new Error("MCP server not found.");
    }
    assertMcpWriteScope(targetRuntime, parsed.scope);
    const state = readMcpRuntimeState(targetRuntime);
    const path = parsed.scope === "project" ? state.projectPath : state.globalPath;
    // MCP 的「默认」就是 pi 的 `enabled`：写回定义它的那份 mcp.json（pi 的 `/mcp` 面板同理）。
    writeMcpConfigPath(path, patchMcpServer(readMcpConfigPath(path).config, parsed.name, { enabled }));
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
    const parsed = parseMcpCapabilityId(id);
    if (!parsed) {
      throw new Error("MCP server not found.");
    }
    const state = readMcpRuntimeState(targetRuntime);
    if (!state.servers.some((server) => server.name === parsed.name && server.scope === parsed.scope)) {
      throw new Error("MCP server not found.");
    }
    const key = mcpMetaKey(parsed.scope, parsed.name);
    config.mcp = { ...(config.mcp ?? {}), [key]: { ...(config.mcp?.[key] ?? {}), pinned } };
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
    if (body?.enabled) {
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
    if (body?.enabled) {
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

  return { buildCapabilitiesSnapshot, createEmptyCapabilitiesConfig, defaultSessionCapabilitySelection, ensureCapabilitiesConfigInitialized, mergeSessionCapabilitySelection, normalizeCapabilitiesConfig, readCapabilitiesConfig, readCapabilitiesDefaults, refreshRuntimeCapabilityPaths, resolveRuntimeCapabilityPaths, setCapabilityPinned, setDefaultCapability, setSessionExtensionCapability, setSessionPackageCapability, setSessionSkillCapability, updateRuntimeSessionCapabilities, writeCapabilitiesConfig };
}
