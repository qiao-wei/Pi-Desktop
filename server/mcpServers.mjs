import { normalizeStringMap, parseMcpCapabilityId, splitArgs } from "./capabilityMetadata.mjs";
import { mcpFileScope, mcpNamespaceOf, mcpToolExposure, normalizeMcpServerEntry, normalizeMcpServerName, readMcpConfigPath, removeMcpServer as removeMcpServerEntry, upsertMcpServer, writeMcpConfigPath } from "./mcpConfig.mjs";
import { ProjectTrustStore, hasTrustRequiringProjectResources } from "./piKernel.mjs";
import { agentDir } from "./sessionStoreFactory.mjs";
import { assertMcpWriteScope, isSessionBusy, mcpMetaKey, mcpToolsByNamespace } from "./smallHelpers.mjs";
import { MANAGED_TOOL_NAME, applyToolToggle, isToolToggleState, readToolSettingsFile, readToolSettingsSnapshot, readToolToggle, toolSettingsPath, writeToolSettingsFile } from "./toolSettings.mjs";
import { join } from "node:path";

/**
 * MCP 服务器配置与工具开关（含项目三态）
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createMcpServers(state, deps) {
  const { appCwd, openRuntimes } = deps;
  const reloadOpenRuntimeCapabilities = /** @type {any} */ ((...args) => deps.reloadOpenRuntimeCapabilities(...args));
  // 跨域引用：由别的域工厂提供，且两边可能互相调用 —— 转发到共享的 deps，调用时才取。
  const buildCapabilitiesSnapshot = /** @type {any} */ ((...args) => deps.buildCapabilitiesSnapshot(...args));
  const buildSnapshot = /** @type {any} */ ((...args) => deps.buildSnapshot(...args));
  const writeCapabilitiesConfig = /** @type {any} */ ((...args) => deps.writeCapabilitiesConfig(...args));
  // 跨域引用：由别的域工厂提供，且两边可能互相调用 —— 转发到共享的 deps，调用时才取。
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));
  const readCapabilitiesConfig = /** @type {any} */ ((...args) => deps.readCapabilitiesConfig(...args));
  const readMcpRuntimeState = /** @type {any} */ ((...args) => deps.readMcpRuntimeState(...args));

/** 能力清单的 MCP 条目：文件事实（mcp.json）× 会话事实（已注册工具）× app 元数据。 */
function mcpCapabilityEntries(targetRuntime) {
  const state = readMcpRuntimeState(targetRuntime);
  const toolsByNamespace = mcpToolsByNamespace(targetRuntime);
  const entries = state.servers.map((server) => {
    // 服务器名 → 命名空间：带 `-` 的名字在会话里已被 pi 换成 `_`，必须换算后再查。
    const tools = toolsByNamespace.get(mcpNamespaceOf(server.name)) ?? [];
    return {
      id: `${server.scope}:${server.name}`,
      kind: "mcp",
      name: server.name,
      description: String(server.meta?.description ?? ""),
      transport: server.transport,
      scope: server.scope,
      source: server.scope === "project" ? state.projectPath : state.globalPath,
      exposure: server.exposure,
      enabled: server.enabled,
      defaultEnabled: server.enabled,
      overridesGlobal: Boolean(server.overridesGlobal),
      active: server.enabled && tools.length > 0,
      toolCount: tools.length,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        exposure: mcpToolExposure(server, tool.name),
        declaredExposure: tool.exposure,
      })),
      pinned: Boolean(server.meta?.pinned),
    };
  });
  return { ...state, entries };
}

/**
 * 桌面端的「工具开关」就是 pi 自己的 `defaultTools`（全局 + 项目 `.pi/settings.json`），
 * 读写规则全在 `server/toolSettings.mjs`。这里只做三件事：读现状、写文件、把变化落到已打开的会话。
 */
function toolSettingsSnapshotFor(targetRuntime = state.runtime) {
  // 会话对象上只有 projectId（没有 project），所以要回项目清单里查。
  const project = state.projects.find((entry) => entry.id === targetRuntime?.projectId);
  const snapshot = readToolSettingsSnapshot({
    agentDir,
    projectCwd: project?.cwd ?? appCwd,
    // 和 `.pi/mcp.json` 同一条信任线：未信任的项目，pi 根本不会读它的 `.pi`。
    projectTrusted: targetRuntime?.settingsManager?.isProjectTrusted?.() !== false,
    toolName: MANAGED_TOOL_NAME,
  });
  // 会话里**实际**激活了哪些工具。不总是等于 effective：MCP 扩展会自己把 codemode 加回来，
  // tool_search 也会因为 deferred 型工具而自动激活。暴露出来才看得出开关到底有没有生效。
  return {
    ...snapshot,
    activeTools: targetRuntime?.session?.getActiveToolNames?.() ?? [],
  };
}

/** 项目清单里每个项目自己那一层的三态（只读它自己的文件，不做合并）。 */
function projectToolToggleState(project) {
  return readToolToggle(
    readToolSettingsFile(toolSettingsPath({ agentDir, projectCwd: project.cwd, scope: "project" })).defaultTools,
    MANAGED_TOOL_NAME,
  );
}

/**
 * 有 codemode 型 MCP 服务器时 pi 会自己把 codemode 加回激活列表（`ensureDiscoveryActive`）。
 * 那部分不归这个开关管，所以下面“关”的时候也不能把它摘掉——摘了 MCP 就不给模型了。
 */
function mcpNeedsCodemode(targetRuntime) {
  try {
    return mcpCapabilityEntries(targetRuntime).entries.some((entry) =>
      entry.enabled !== false && (entry.exposure === "codemode" || entry.exposure === "codemode-deferred"),
    );
  } catch {
    return false;
  }
}

/** 写设置时判断一个项目信不信任；已打开的会话优先用它的真值，否则回落到 trust.json。 */
function projectTrustForWrite(cwd) {
  const open = [...openRuntimes.values()].find((candidate) =>
    state.projects.find((entry) => entry.id === candidate.projectId)?.cwd === cwd,
  );
  if (open?.settingsManager?.isProjectTrusted) {
    return open.settingsManager.isProjectTrusted();
  }
  const decision = new ProjectTrustStore(agentDir).get(cwd);
  if (decision !== null && decision !== undefined) {
    return decision;
  }
  if (!hasTrustRequiringProjectResources(cwd)) {
    return true;
  }
  return readToolSettingsFile(join(agentDir, "settings.json")).defaultProjectTrust === "always";
}

/**
 * 把开关的变化落到已经打开的会话上。
 *
 * 为什么要专门做这一步：pi 只在**建会话**的时候按 `defaultTools` 算激活工具，改设置对运行中的
 * 会话没有任何影响（TUI 也一样，改完得重开）。这里补上，省得用户以为开关是坏的。
 * 只碰 codemode 一个名字；有需要它的 MCP 服务器时不往下摘。
 *
  * @param {{ projectId?: string, scope?: string }} [target]
 */
function applyToolToggleToRuntimes({ projectId, scope } = {}) {
  for (const targetRuntime of openRuntimes.values()) {
    if (scope === "project" && projectId && targetRuntime.projectId !== projectId) {
      continue;
    }
    // 和 reloadRuntimeTargets 同一个规矩：正在跑的会话别动它的工具清单。
    if (isSessionBusy(targetRuntime.session)) {
      continue;
    }
    const active = targetRuntime.session.getActiveToolNames();
    const has = active.includes(MANAGED_TOOL_NAME);
    const shouldHave = toolSettingsSnapshotFor(targetRuntime).effective || mcpNeedsCodemode(targetRuntime);
    if (shouldHave && !has) {
      targetRuntime.session.setActiveToolsByName([...active, MANAGED_TOOL_NAME]);
    } else if (!shouldHave && has) {
      targetRuntime.session.setActiveToolsByName(active.filter((name) => name !== MANAGED_TOOL_NAME));
    }
  }
}

/** 写开关：`scope: "user"` 写 agent 目录，`"project"` 写目标项目自己的 `.pi/settings.json`。 */
async function saveToolSettings(body) {
  const scope = body?.scope === "project" ? "project" : "user";
  const state = body?.state;
  if (!isToolToggleState(state)) {
    throw new Error("Invalid tool toggle state.");
  }
  if (scope === "user" && state === "inherit") {
    throw new Error("The global layer has nothing to inherit.");
  }

  const project = scope === "project"
    ? state.projects.find((entry) => entry.id === String(body?.projectId ?? ""))
    : null;
  if (scope === "project" && !project) {
    throw new Error("Project not found.");
  }
  if (scope === "project" && !projectTrustForWrite(project.cwd)) {
    throw new Error("Trust this project before editing its .pi/settings.json.");
  }

  const path = toolSettingsPath({
    agentDir,
    projectCwd: project?.cwd ?? state.projects.find((entry) => entry.id === state.runtime.projectId)?.cwd ?? appCwd,
    scope,
  });
  const settings = readToolSettingsFile(path);
  const next = applyToolToggle(settings.defaultTools, state, { scope, toolName: MANAGED_TOOL_NAME });
  if (next === undefined) {
    delete settings.defaultTools;
  } else {
    settings.defaultTools = next;
  }
  writeToolSettingsFile(path, settings);

  applyToolToggleToRuntimes({ projectId: project?.id, scope });
  // 回整份 bootstrap：开关一变，`toolSettings` 和项目清单里的 `codemode` 都要跟着变，
  // 而且这是一次用户动作（不是每次敲键），不值得为它单搞一个增量 patch 通道。
  return buildSnapshot(getRuntimeForRequest(body));
}

/** 按能力 id 找到一条服务器的完整归一化配置（编辑器 / 探测用）。 */
function findMcpServer(targetRuntime, id) {
  const parsed = parseMcpCapabilityId(id);
  if (!parsed) {
    return null;
  }
  const state = readMcpRuntimeState(targetRuntime);
  const server = state.servers.find((entry) => entry.name === parsed.name && entry.scope === parsed.scope);
  return server ? { state, server } : null;
}

/** 把能力页表单的字段拼成 pi 的 `mcpServers` 条目形状。 */
function mcpRawConfigFromBody(body) {
  const source = body && typeof body === "object" ? body : {};
  const transport = source.transport === "http" ? "http" : "stdio";
  // `extras` 是表单不翻译但 pi 认识的字段（导入时从 oauth / auth 等带过来），
  // 先铺在底层，再让下面的已知字段覆盖同名键（已知字段始终以表单为准）。
  const extras = source.extras && typeof source.extras === "object" && !Array.isArray(source.extras) ? source.extras : {};
  const raw = transport === "http"
    ? { ...extras, url: String(source.url ?? "").trim(), headers: normalizeStringMap(source.headers) }
    : {
      ...extras,
      command: String(source.command ?? "").trim(),
      args: splitArgs(source.args),
      env: normalizeStringMap(source.env),
      cwd: String(source.cwd ?? "").trim(),
    };
  if (source.exposure) {
    raw.exposure = String(source.exposure);
  }
  if (source.toolExposure && typeof source.toolExposure === "object" && !Array.isArray(source.toolExposure)) {
    raw.toolExposure = source.toolExposure;
  }
  if (source.enabled === false) {
    raw.enabled = false;
  }
  if (source.timeout !== undefined && source.timeout !== null && source.timeout !== "") {
    raw.timeout = Number(source.timeout);
  }
  return raw;
}

/** 落盘一份服务器：pi 认识的字段进 mcp.json，app 的 pinned / 描述进 capabilities.json。 */
function saveMcpServerDefinition(targetRuntime, body) {
  const name = normalizeMcpServerName(body?.name);
  if (!name) {
    throw new Error('MCP server name may only contain letters, digits, "_" and "-".');
  }
  const scope = mcpFileScope(body?.scope);
  assertMcpWriteScope(targetRuntime, scope);
  const state = readMcpRuntimeState(targetRuntime);
  const normalized = normalizeMcpServerEntry(name, mcpRawConfigFromBody(body));
  if (normalized.error) {
    throw new Error(normalized.error);
  }

  // 编辑器允许改名 / 换作用域：先把旧条目从它原来那份文件里摘掉（含元数据），
  // 否则会留下一条指向旧名字的孤儿服务器。
  const original = parseMcpCapabilityId(body?.originalId ?? body?.id);
  if (original && (original.name !== name || original.scope !== scope)) {
    assertMcpWriteScope(targetRuntime, original.scope);
    const originPath = original.scope === "project" ? state.projectPath : state.globalPath;
    const removed = removeMcpServerEntry(readMcpConfigPath(originPath).config, original.name);
    if (removed.removed) {
      writeMcpConfigPath(originPath, removed.config);
    }
    const originConfig = readCapabilitiesConfig();
    if (originConfig.mcp) {
      delete originConfig.mcp[mcpMetaKey(original.scope, original.name)];
      writeCapabilitiesConfig(originConfig);
    }
  }

  const path = scope === "project" ? state.projectPath : state.globalPath;
  // 重新读一遍：上面可能刚写过别的文件，用最新内容做 upsert 更稳。
  writeMcpConfigPath(path, upsertMcpServer(readMcpConfigPath(path).config, name, normalized.server));

  const config = readCapabilitiesConfig();
  const key = mcpMetaKey(scope, name);
  config.mcp = {
    ...(config.mcp ?? {}),
    [key]: {
      pinned: Boolean(body?.pinned ?? config.mcp?.[key]?.pinned),
      description: String(body?.description ?? "").trim(),
    },
  };
  writeCapabilitiesConfig(config);
  return { scope, name, path };
}

/** 编辑器用的原始字段（含 env / headers 这类可能含密钥的值，所以只在点开时按需读）。 */
function readMcpServerCapability(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const id = String(body?.id ?? "");
  const found = findMcpServer(targetRuntime, id);
  if (!found) {
    throw new Error("MCP server not found.");
  }
  const { server } = found;
  return {
    detail: {
      id: `${server.scope}:${server.name}`,
      name: server.name,
      scope: server.scope,
      transport: server.transport,
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
      cwd: server.cwd,
      url: server.url,
      headers: { ...server.headers },
      hasOAuth: Boolean(server.hasOAuth),
      exposure: server.exposure,
      toolExposure: { ...server.toolExposure },
      enabled: server.enabled,
      timeout: server.timeout,
      description: String(server.meta?.description ?? ""),
      pinned: Boolean(server.meta?.pinned),
    },
  };
}

async function saveMcpServer(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const saved = saveMcpServerDefinition(targetRuntime, body);
  await reloadOpenRuntimeCapabilities("all");
  return { capabilities: await buildCapabilitiesSnapshot(targetRuntime), saved };
}

async function removeMcpServer(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const parsed = parseMcpCapabilityId(body?.id)
    ?? (normalizeMcpServerName(body?.name) ? { scope: mcpFileScope(body?.scope), name: normalizeMcpServerName(body?.name) } : null);
  if (!parsed) {
    throw new Error("MCP server id is required.");
  }
  assertMcpWriteScope(targetRuntime, parsed.scope);
  const state = readMcpRuntimeState(targetRuntime);
  const path = parsed.scope === "project" ? state.projectPath : state.globalPath;
  const removed = removeMcpServerEntry(readMcpConfigPath(path).config, parsed.name);
  if (removed.removed) {
    writeMcpConfigPath(path, removed.config);
  }
  const config = readCapabilitiesConfig();
  if (config.mcp) {
    delete config.mcp[mcpMetaKey(parsed.scope, parsed.name)];
  }
  writeCapabilitiesConfig(config);
  await reloadOpenRuntimeCapabilities("all");
  return { capabilities: await buildCapabilitiesSnapshot(targetRuntime) };
}

  return { applyToolToggleToRuntimes, findMcpServer, mcpCapabilityEntries, mcpNeedsCodemode, mcpRawConfigFromBody, projectToolToggleState, projectTrustForWrite, readMcpServerCapability, removeMcpServer, saveMcpServer, saveMcpServerDefinition, saveToolSettings, toolSettingsSnapshotFor };
}
