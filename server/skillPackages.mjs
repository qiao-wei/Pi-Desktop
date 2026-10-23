import { messageDisplayText } from "../src/shared/chatBubbles.ts";
import { commandMatchesPackage, setPackageAutoload } from "./capabilityMetadata.mjs";
import { MAX_RESOURCE_PREVIEW_BYTES, findPackageResourceEntry, packageProgressEvent, resourcePreview } from "./capabilityPackageResources.mjs";
import { installTargetPath, packageSourceForPi } from "./capabilityPackageSource.mjs";
import { isPathInside, skillPathTarget } from "./capabilityPathIdentity.mjs";
import { reloadRuntimeSkills } from "./capabilityReload.mjs";
import { corsHeaders } from "./cors.mjs";
import { readJson } from "./httpHelpers.mjs";
import { enabledResourcePaths, packageCapabilityId } from "./packageHelpers.mjs";
import { StringEnum, withFileMutationQueue } from "./piKernel.mjs";
import { agentDir } from "./sessionStoreFactory.mjs";
import { assertSkillDirectory, directoriesHaveSameContent, normalizeSkillFolderName, normalizeSkillRelativePath, readVersionMetadata, resolveToolPath } from "./skillHelpers.mjs";
import { isSessionBusy, skillSummaries, writeVersionMetadata } from "./smallHelpers.mjs";
import { randomUUID } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "typebox";

/**
 * 技能与包的安装/删除/版本
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createSkillPackages(state, deps) {
  const { activePackageCommands } = deps;
  // 跨域引用：由别的域工厂提供，且两边可能互相调用 —— 转发到共享的 deps，调用时才取。
  const findProject = /** @type {any} */ ((...args) => deps.findProject(...args));
  // 跨域引用：由别的域工厂提供，且两边可能互相调用 —— 转发到共享的 deps，调用时才取。
  const assertExistingSkillTarget = /** @type {any} */ ((...args) => deps.assertExistingSkillTarget(...args));
  const assertWritableSkillRoot = /** @type {any} */ ((...args) => deps.assertWritableSkillRoot(...args));
  const assertWritableSkillTarget = /** @type {any} */ ((...args) => deps.assertWritableSkillTarget(...args));
  const capabilityPackageManager = /** @type {any} */ ((...args) => deps.capabilityPackageManager(...args));
  const configuredPackagesForRuntime = /** @type {any} */ ((...args) => deps.configuredPackagesForRuntime(...args));
  const discoverAllProjectSkills = /** @type {any} */ ((...args) => deps.discoverAllProjectSkills(...args));
  const getInstalledSkillPath = /** @type {any} */ ((...args) => deps.getInstalledSkillPath(...args));
  const getInstalledSkillRoot = /** @type {any} */ ((...args) => deps.getInstalledSkillRoot(...args));
  const getSkillVersionDir = /** @type {any} */ ((...args) => deps.getSkillVersionDir(...args));
  const getSkillVersionsRoot = /** @type {any} */ ((...args) => deps.getSkillVersionsRoot(...args));
  const inferInstalledSkillScope = /** @type {any} */ ((...args) => deps.inferInstalledSkillScope(...args));
  const isBuiltinSkillPath = /** @type {any} */ ((...args) => deps.isBuiltinSkillPath(...args));
  const normalizeCapabilityId = /** @type {any} */ ((...args) => deps.normalizeCapabilityId(...args));
  const packageResourcesForRuntime = /** @type {any} */ ((...args) => deps.packageResourcesForRuntime(...args));
  const reloadOpenRuntimeCapabilities = /** @type {any} */ ((...args) => deps.reloadOpenRuntimeCapabilities(...args));
  const reloadPiDesktopSkills = /** @type {any} */ ((...args) => deps.reloadPiDesktopSkills(...args));
  const resolveCapabilityPackageCommand = /** @type {any} */ ((...args) => deps.resolveCapabilityPackageCommand(...args));
  const skillCapabilityId = /** @type {any} */ ((...args) => deps.skillCapabilityId(...args));
  const straightenInstalledPackage = /** @type {any} */ ((...args) => deps.straightenInstalledPackage(...args));
  // 跨域引用：由别的域工厂提供，且两边可能互相调用 —— 转发到共享的 deps，调用时才取。
  const ensureWorktreePiLink = /** @type {any} */ ((...args) => deps.ensureWorktreePiLink(...args));
  const buildCapabilitiesSnapshot = /** @type {any} */ ((...args) => deps.buildCapabilitiesSnapshot(...args));
  const buildSnapshot = /** @type {any} */ ((...args) => deps.buildSnapshot(...args));
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));
  const readCapabilitiesConfig = /** @type {any} */ ((...args) => deps.readCapabilitiesConfig(...args));
  const refreshRuntimeCapabilityPaths = /** @type {any} */ ((...args) => deps.refreshRuntimeCapabilityPaths(...args));
  const refreshSnapshot = /** @type {any} */ ((...args) => deps.refreshSnapshot(...args));
  const updateSessionStoreFromRuntime = /** @type {any} */ ((...args) => deps.updateSessionStoreFromRuntime(...args));
  const writeCapabilitiesConfig = /** @type {any} */ ((...args) => deps.writeCapabilitiesConfig(...args));

async function findCapabilityPackageCommand(targetRuntime, packageId, commandName) {
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

  return { packageItem, command };
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

  // 目录技能删整个目录；独立 markdown 技能（技能根下直接放的 *.md）只删那个文件。
  // 以前一律 `dirname(filePath)`：独立 md 技能会让目标变成整个 skills 根目录。
  const skillRoot = skillPathTarget(skill.filePath);
  assertWritableSkillTarget(skillRoot);
  assertExistingSkillTarget(skillRoot);
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

/** @typedef {{ type: "text", text: string }} HostToolTextContent */
/** @typedef {{ content: HostToolTextContent[], details: Record<string, unknown> }} HostToolResult */

/**
 * pi 的 `customTools` 形状：字面量 `type: "text"` 必须靠这里的上下文类型收窄成 "text"，
 * 否则每个 `return { content: [{ type: "text", … }] }` 都会被放宽成 `string` 而与内核类型对不上。
 *
 * @param {any} project
 * @param {{ reload?: () => Promise<unknown> } | null} resourceLoader
 * @returns {{
 *   name: string, label: string, description: string, promptSnippet: string, promptGuidelines: string[],
 *   parameters: any,
 *   execute: (...args: any[]) => Promise<HostToolResult>,
 * }[]}
 */
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
      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
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
  /** @type {{ versionId: string | null, snapshotPath: string | null }} */
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

async function reloadRuntimeTargets(targets, { skillsOnly = false } = {}) {
  await Promise.all(targets.map(async (candidate) => {
    if (isSessionBusy(candidate.session)) {
      return;
    }
    // 刚装的项目技能 / 包就在项目根的 `.pi` 里：先保证 worktree 会话能看到它，再重载。
    const project = state.projects.find((entry) => entry.id === candidate.projectId);
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

  return { addCapabilityExtension, assertWritableSkillFile, createPiDesktopSkillTools, deleteSkillFromCapabilityPage, findCapabilityPackageCommand, installCapabilityPackage, installPiDesktopSkill, listPiDesktopSkillVersions, readCapabilityPackageFile, reloadRuntimeTargets, removeCapabilityExtension, removeCapabilityPackage, restorePiDesktopSkillVersion, snapshotInstalledSkillVersion, streamCapabilityPackageAction, streamCapabilityPackageCommand, writePiDesktopSkillFile };
}
