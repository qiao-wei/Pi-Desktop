import { packageDisplayName, resolvePackageResources } from "./capabilityMetadata.mjs";
import { packageResourceDetails } from "./capabilityPackageResources.mjs";
import { absolutizeInstalledUserPackage } from "./capabilityPackageSource.mjs";
import { canonicalPath, isCrossClientSkillPath, isPathInside, isSkillPathUnderRoots, projectAgentsSkillRoots } from "./capabilityPathIdentity.mjs";
import { normalizeSkillDiagnostics } from "./capabilitySkillDiagnostics.mjs";
import { normalizeCommandArgumentItems } from "./commandArguments.mjs";
import { readJson } from "./httpHelpers.mjs";
import { manualSkillPromptPrefix } from "./manualSkillPrompt.mjs";
import { packageAutoloadEnabled, packageCapabilityId } from "./packageHelpers.mjs";
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from "./piKernel.mjs";
import { persistSessionShell } from "./sessionHelpers.mjs";
import { agentDir, diagnosticLog } from "./sessionStoreFactory.mjs";
import { defaultSkillEnabled, sendJson, skillSummaries } from "./smallHelpers.mjs";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * 技能与能力包叶子（发现、安装、删改、诊断）
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createSkillLeaves(state, deps) {
  const { agentSkillsDir, agentsSkillsDir, appPackagesDir, appSkillsDir, openRuntimes, piDesktopCapabilitiesCustomType } = deps;
  const activeProject = /** @type {any} */ ((...args) => deps.activeProject(...args));
  const basePiDesktopResourceLoaderOptions = /** @type {any} */ ((...args) => deps.basePiDesktopResourceLoaderOptions(...args));
  const findProject = /** @type {any} */ ((...args) => deps.findProject(...args));
  const normalizeStringArray = /** @type {any} */ ((...args) => deps.normalizeStringArray(...args));
  const buildCapabilitiesSnapshot = /** @type {any} */ ((...args) => deps.buildCapabilitiesSnapshot(...args));
  const buildSnapshot = /** @type {any} */ ((...args) => deps.buildSnapshot(...args));
  const defaultSessionCapabilitySelection = /** @type {any} */ ((...args) => deps.defaultSessionCapabilitySelection(...args));
  const findCapabilityPackageCommand = /** @type {any} */ ((...args) => deps.findCapabilityPackageCommand(...args));
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));
  const installPiDesktopSkill = /** @type {any} */ ((...args) => deps.installPiDesktopSkill(...args));
  const mergeSessionCapabilitySelection = /** @type {any} */ ((...args) => deps.mergeSessionCapabilitySelection(...args));
  const refreshSnapshot = /** @type {any} */ ((...args) => deps.refreshSnapshot(...args));
  const reloadRuntimeTargets = /** @type {any} */ ((...args) => deps.reloadRuntimeTargets(...args));

function discoverBuiltinPackagePaths() {
  if (!existsSync(appPackagesDir)) {
    return [];
  }

  return readdirSync(appPackagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(appPackagesDir, entry.name))
    .filter((packagePath) => existsSync(join(packagePath, "package.json")));
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

function normalizeCapabilityId(value) {
  return String(value ?? "").trim();
}

function skillCapabilityId(skill) {
  return skill.name;
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

function activeSessionCapabilitySelection(sessionManager, skills, config, targetRuntime = state.runtime) {
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

function managedSkills(skills, project = activeProject()) {
  return skills.filter((skill) => isManagedSkillPath(skill.filePath, project));
}

function isManagedSkillPath(filePath, project = activeProject()) {
  return isSkillPathUnderRoots(filePath, managedSkillRoots(project));
}

/**
 * 受管的技能根。除了内置 / 用户 / 项目 `.pi/skills`，还包括项目里任意一层的
 * `<dir>/.agents/skills`（pi 从 cwd 一路收到 git 仓库根，见 projectAgentsSkillRoots 的注释）。
 * 不把后者算进来，这类技能在能力页里就是「查无此技能」：来源、会话开关、删除守卫全都对不上号。
 */
function managedSkillRoots(project = activeProject()) {
  return [appSkillsDir, agentSkillsDir, agentsSkillsDir, ...projectAgentsSkillsDirs(project), join(project.cwd, ".pi", "skills")];
}

function projectAgentsSkillsDirs(project = activeProject()) {
  return projectAgentsSkillRoots(project.cwd, homedir());
}

function packageDefaultEnabled(config, pkg) {
  return pkg.autoload !== false;
}

function configuredPackagesForRuntime(targetRuntime = state.runtime) {
  const project = findProject(targetRuntime.projectId);
  const settingsManager = targetRuntime.settingsManager;
  const packageManager = new DefaultPackageManager({ cwd: project.cwd, agentDir, settingsManager });
  return packageManager.listConfiguredPackages().map((pkg) => ({
    ...pkg,
    id: packageCapabilityId(pkg),
    autoload: packageAutoloadEnabled(settingsManager, pkg),
  }));
}

async function packageResourcesForRuntime(targetRuntime, pkg) {
  return resolvePackageResources({
    project: findProject(targetRuntime.projectId),
    settingsManager: targetRuntime.settingsManager,
    agentDir,
    pkg,
  });
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

function allDiscoveredSkillsForLoader(resourceLoader) {
  return resourceLoader.getSkills().skills;
}

async function discoverAllProjectSkills(project, settingsManager = undefined) {
  return (await discoverAllProjectSkillResources(project, settingsManager)).skills;
}

/**
 * 技能清单 + pi 加载器自己的诊断。
 *
 * `getSkills()` 返回 `{ skills, diagnostics }`，诊断里除了 frontmatter 非法，还包括**重名冲突**
 * （pi 保留先发现的、丢掉后来的，只说一声）。以前只取 `.skills`，于是用户看到「少了一个技能」
 * 而没有任何解释；现在把诊断一路带到能力页。
 */
async function discoverAllProjectSkillResources(project, settingsManager = undefined) {
  const effectiveSettingsManager = settingsManager ?? SettingsManager.create(project.cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    ...basePiDesktopResourceLoaderOptions(project, effectiveSettingsManager),
    // Inventory only: importing the packages' extensions is the bulk of this pass' cost
    // and none of it feeds skill discovery (package skills still resolve either way).
    noExtensions: true,
    extensionFactories: [],
  });
  await loader.reload();
  const result = loader.getSkills();
  return { skills: result?.skills ?? [], diagnostics: normalizeSkillDiagnostics(result?.diagnostics) };
}

const lastCapabilityLoadStatuses = new Map();

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

async function resolveCapabilityPackageCommand(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const packageId = normalizeCapabilityId(body?.packageId);
  const commandName = String(body?.command ?? "").trim().replace(/^\/+/, "");
  const args = String(body?.args ?? "").trim();
  const { command } = await findCapabilityPackageCommand(targetRuntime, packageId, commandName);

  return {
    targetRuntime,
    commandText: `/${command.invocationName}${args ? ` ${args}` : ""}`,
  };
}

async function readCapabilityCommandArguments(req, res) {
  const body = await readJson(req);
  const targetRuntime = getRuntimeForRequest(body);
  const packageId = normalizeCapabilityId(body?.packageId);
  const commandName = String(body?.command ?? "").trim().replace(/^\/+/, "");
  const prefix = typeof body?.prefix === "string" ? body.prefix : "";
  const { command } = await findCapabilityPackageCommand(targetRuntime, packageId, commandName);
  const raw = typeof command.getArgumentCompletions === "function"
    ? await command.getArgumentCompletions(prefix)
    : [];
  sendJson(res, 200, { items: normalizeCommandArgumentItems(raw) });
}

function compareCapabilityCards(left, right) {
  return Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || left.name.localeCompare(right.name);
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

async function updateCapabilityPackage(body, onProgress) {
  const targetRuntime = getRuntimeForRequest(body);
  const source = String(body?.source ?? "").trim() || undefined;
  await capabilityPackageManager(targetRuntime, onProgress).update(source);
  await reloadOpenRuntimeCapabilities("all");
  return refreshSnapshot();
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

function inferInstalledSkillScope(project, skillRoot) {
  if (isSkillPathUnderRoots(skillRoot, [agentSkillsDir, agentsSkillsDir])) {
    return "user";
  }
  return "project";
}

function readSkillContent(filePath) {
  // 匹配要按真实路径（worktree 会话里同一条技能报的是软链那侧），
  // 兜底发现则传原始路径：用户的技能本身就是软链，只比 realpath 会找不到。
  const normalizedPath = canonicalPath(filePath);
  const project = findProject(state.runtime.projectId);
  const allSkills = allDiscoveredSkillsForLoader(state.runtime.resourceLoader);
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
  const roots = managedSkillRoots(project);
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

/**
 * @param {{
 *   scope?: "all" | "user" | "project",
 *   projectId?: string,
 *   sourceLoader?: any,
 * }} [options]
 * @returns {Promise<{ skillCount: number, skills: any[], reloadedSessionPaths: string[] }>}
 */
async function reloadPiDesktopSkills({ scope = "all", projectId, sourceLoader } = {}) {
  const reload = async () => {
    const targets = [...openRuntimes.values()].filter((candidate) =>
      scope === "all" || scope === "user" || candidate.projectId === projectId,
    );
    await reloadRuntimeTargets(targets);

    const summaryLoader = sourceLoader ?? targets[0]?.resourceLoader ?? state.runtime.resourceLoader;
    return {
      skillCount: summaryLoader.getSkills().skills.length,
      skills: skillSummaries(summaryLoader),
      reloadedSessionPaths: targets.map((candidate) => candidate.session.sessionFile),
    };
  };

  // 队列本身只用来串行化（错误已被 catch 掉），返回值给调用方用，所以类型是「随时可 undefined 的 Promise」。
  /** @type {Promise<{ skillCount: number, skills: any[], reloadedSessionPaths: string[] }>} */
  const queuedReload = state.skillReloadQueue.then(reload, reload);
  state.skillReloadQueue = queuedReload.catch(() => undefined);
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

function assertWritableSkillRoot(skillRoot) {
  assertWritableSkillTarget(skillRoot);
  assertExistingSkillTarget(skillRoot, { directoryOnly: true });
}

/**
 * 删除目标必须真的存在，且只能是目录（目录技能）或文件（独立 markdown 技能）。
 *
 * @param {string} targetPath
 * @param {{ directoryOnly?: boolean }} [options] 写/恢复流程按技能目录操作，传 `directoryOnly`。
 */
function assertExistingSkillTarget(targetPath, options = {}) {
  if (!existsSync(targetPath)) {
    throw new Error(`Installed skill not found: ${targetPath}`);
  }

  const stats = statSync(targetPath);
  if (options.directoryOnly) {
    if (!stats.isDirectory()) {
      throw new Error(`Installed skill must be a directory: ${targetPath}`);
    }
    return;
  }

  if (!stats.isDirectory() && !stats.isFile()) {
    throw new Error(`Installed skill must be a directory or a markdown file: ${targetPath}`);
  }
}

function assertWritableSkillTarget(skillRoot) {
  if (isBuiltinSkillPath(skillRoot)) {
    throw new Error("Built-in skills are read-only. Copy the skill to the user or current project skills directory before editing it.");
  }
  // `.agents/skills` 是 Agent Skills 的跨客户端共享目录（用户的 `~/.agents/skills`，以及项目里
  // 任意一层的 `<dir>/.agents/skills`），Codex / Gemini / 百炼都从同一份目录读技能：从这个
  // 客户端删会把别人的入口一起删掉。守卫只看字面路径，所以 `~/.pi/agent/skills/x` 指向它的
  // 软链仍然可删 —— 删掉的只是那条软链本身。
  if (isCrossClientSkillPath(skillRoot)) {
    throw new Error("Skills in .agents/skills are shared across agents and read-only here.");
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

/**
 * 用户显式附上的 manual-only 技能 → 要拼进这条 prompt 的 skill block 前缀。
 *
 * 读不到 SKILL.md 就跳过这一个（pi 的 `_expandSkillCommand` 同样放弃展开并上报），
 * 不能让一条附件把整次提交打挂。注意这里不依赖 pi 的 loaded skills：服务端自己读文件，
 * 所以流式中途附上一个没使能的 manual-only 技能也照样能展开。
 */
function manualSkillPrefixFor(allSkills, requestedSkills) {
  const byId = new Map((allSkills ?? []).map((skill) => [skillCapabilityId(skill), skill]));
  const entries = [];
  for (const capability of requestedSkills ?? []) {
    const skill = byId.get(normalizeCapabilityId(capability?.id));
    if (!skill || skill.disableModelInvocation !== true) {
      continue;
    }
    try {
      entries.push({
        name: skill.name,
        filePath: skill.filePath,
        // 用内核自己算的 baseDir（`<skill ...>` 里 "References are relative to …" 就是它），
        // 只在它缺失时才退回 dirname(filePath) —— 包里的技能这两者可以不同。
        baseDir: skill.baseDir || dirname(skill.filePath),
        content: readFileSync(skill.filePath, "utf8"),
      });
    } catch (error) {
      diagnosticLog("prompt.manual_skill_read_failed", {
        skill: skill.name,
        path: skill.filePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return manualSkillPromptPrefix(entries);
}

  return { activeSessionCapabilitySelection, allDiscoveredSkillsForLoader, appendSessionCapabilitySelection, applyMissingDefaultEnabledSkillNames, assertExistingSkillTarget, assertWritableSkillRoot, assertWritableSkillTarget, capabilityPackageManager, compareCapabilityCards, configuredPackagesForRuntime, defaultSkillIdsForSkills, discoverAllProjectSkillResources, discoverAllProjectSkills, discoverBuiltinPackagePaths, discoverSkillFromKnownRoots, getInstalledSkillPath, getInstalledSkillRoot, getSkillVersionDir, getSkillVersionsRoot, importSkillFromCapabilityPage, inferInstalledSkillScope, isBuiltinSkillPath, isManagedSkillPath, lastCapabilityLoadStatuses, managedSkillRoots, managedSkills, manualSkillPrefixFor, normalizeCapabilitiesDefaults, normalizeCapabilityId, normalizeSessionCapabilitySelection, packageDefaultEnabled, packageResourcesForRuntime, projectAgentsSkillsDirs, readCapabilityCommandArguments, readCapabilityPackageResources, readSessionCapabilitySelection, readSkillContent, reloadOpenRuntimeCapabilities, reloadOpenRuntimeSkills, reloadPiDesktopSkills, reportSkillInventoryMismatch, reportedSkillInventoryMismatches, resolveCapabilityPackageCommand, skillCapabilityId, straightenInstalledPackage, updateCapabilityPackage };
}
