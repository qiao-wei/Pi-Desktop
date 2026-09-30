/**
 * pi 内置 MCP 的配置文件（`mcp.json`）读写。
 *
 * 背景：0.99 起 MCP 是 pi 的内置扩展，配置只有两层——agent 目录的 `~/.pi/agent/mcp.json`
 * （全局）和信任项目的 `<project>/.pi/mcp.json`（项目），同名时项目条目整体覆盖全局。
 * 格式就是各家 MCP 客户端通用的 `mcpServers`，字段语义必须与 pi 的
 * `validateMcpServerConfig`（`@earendil-works/pi-coding-agent` 的 core/mcp-servers）对齐：
 *
 *   - `command`/`args`/`env`/`cwd` → stdio；`url`/`headers`/`oauth` → streamable HTTP；
 *   - legacy SSE 被 pi 明确拒绝（"legacy SSE transport is not supported"）；
 *   - `exposure`（默认 `codemode`）、`toolExposure`、`enabled`、`timeout`；
 *   - 未知字段 pi 会忽略，所以这里**保留**它们（`oauth` 等由用户在文件里手写的内容不能丢）。
 *
 * 这个模块只做纯函数 + 文件读写，不 import pi，方便单测；`index.mjs` 负责把它接到能力清单
 * 和会话上。Pi Desktop 自己的 `pinned` / 描述不进 `mcp.json`，存在 capabilities.json 的
 * `mcp` 段（见 index.mjs 里的 capability detail store）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** pi 接受的全部 exposure。顺序即 UI 下拉的展示顺序。 */
export const MCP_EXPOSURES = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"];

/** pi 的默认：工具只对 codemode 脚本可见，不进模型的工具声明。 */
export const DEFAULT_MCP_EXPOSURE = "codemode";

/** pi 的服务器名约束：字母、数字、下划线、连字符。 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 只声明 codemode / tool_search 之外的两种真实传输——SSE 在 pi 里已不支持。 */
export const MCP_TRANSPORTS = ["stdio", "http"];

const EXPOSURE_SET = new Set(MCP_EXPOSURES);

export function isMcpExposure(value) {
  return typeof value === "string" && EXPOSURE_SET.has(value);
}

/** `mcp.json` 的位置。`scope` 是 pi 的两个作用域名：全局 agent 目录 / 项目 `.pi`。 */
export function mcpConfigPath({ agentDir, projectCwd, scope }) {
  return scope === "project" ? join(projectCwd, ".pi", "mcp.json") : join(agentDir, "mcp.json");
}

/** 能力清单里的 scope 用 "user" 和 packages 保持一致，落盘时映射成 pi 的 "global"。 */
export function mcpFileScope(scope) {
  return scope === "project" ? "project" : "global";
}

/**
 * 服务器名归一化：去空白、拒绝非法字符。返回 null 表示这个名字不能写进 mcp.json，
 * 调用方据此报错（写进去会被 pi 静默跳过，用户看不到任何提示）。
 */
export function normalizeMcpServerName(value) {
  const name = String(value ?? "").trim();
  return MCP_SERVER_NAME_PATTERN.test(name) ? name : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringMap(value) {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, next]) => [String(key).trim(), String(next ?? "")])
      .filter(([key]) => Boolean(key)),
  );
}

function stringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/**
 * 一个 `mcpServers` 条目的归一化视图。`transport` 按 pi 的规则推导：有 `command` 就是
 * stdio，有 `url` 就是 streamable HTTP；显式 `type` 只用来校验，不参与推导。
 *
 * 非法条目不是抛错就是返回错误串——由 `parseMcpConfigText` 决定是跳过还是整体失败。
 */
export function normalizeMcpServerEntry(name, value) {
  const serverName = normalizeMcpServerName(name);
  if (!serverName) {
    return { error: `invalid server name "${String(name)}" (use letters, digits, "_" and "-")` };
  }
  if (!isRecord(value)) {
    return { error: `server "${serverName}" must be an object` };
  }

  const type = typeof value.type === "string" ? value.type : "";
  if (type === "sse") {
    return { error: `server "${serverName}": legacy SSE transport is not supported; use the streamable HTTP URL` };
  }
  if (type && type !== "stdio" && type !== "http" && type !== "streamable-http") {
    return { error: `server "${serverName}": type must be "stdio", "http", or "streamable-http"` };
  }

  const command = typeof value.command === "string" ? value.command.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const transport = command ? "stdio" : url ? "http" : "";
  if (!transport) {
    return { error: `server "${serverName}" needs either "command" (stdio) or "url" (streamable HTTP)` };
  }

  if (value.exposure !== undefined && !isMcpExposure(value.exposure)) {
    return { error: `server "${serverName}": exposure must be one of ${MCP_EXPOSURES.map((entry) => `"${entry}"`).join(", ")}` };
  }
  if (value.toolExposure !== undefined) {
    if (!isRecord(value.toolExposure)) {
      return { error: `server "${serverName}": toolExposure must map tool names to exposures` };
    }
    for (const [tool, exposure] of Object.entries(value.toolExposure)) {
      if (!isMcpExposure(exposure)) {
        return { error: `server "${serverName}": toolExposure "${tool}" must be one of ${MCP_EXPOSURES.map((entry) => `"${entry}"`).join(", ")}` };
      }
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return { error: `server "${serverName}": enabled must be a boolean` };
  }
  if (value.timeout !== undefined && (typeof value.timeout !== "number" || !(value.timeout > 0))) {
    return { error: `server "${serverName}": timeout must be a positive number of seconds` };
  }

  return {
    server: {
      name: serverName,
      transport,
      command,
      args: stringArray(value.args),
      env: stringMap(value.env),
      cwd: typeof value.cwd === "string" ? value.cwd : "",
      url,
      headers: stringMap(value.headers),
      hasOAuth: isRecord(value.oauth),
      exposure: isMcpExposure(value.exposure) ? value.exposure : DEFAULT_MCP_EXPOSURE,
      toolExposure: isRecord(value.toolExposure)
        ? Object.fromEntries(Object.entries(value.toolExposure).map(([tool, exposure]) => [String(tool), String(exposure)]))
        : {},
      enabled: value.enabled !== false,
      timeout: typeof value.timeout === "number" ? value.timeout : undefined,
    },
  };
}

/**
 * 解析 `mcp.json` 文本。无效条目会被跳过并进入 `errors`，其余照常可用——和 pi 的行为一致
 * （"Invalid entries are skipped and reported; the other servers still connect"）。
 */
export function parseMcpConfigText(text) {
  const source = String(text ?? "").trim();
  if (!source) {
    return { config: { mcpServers: {} }, servers: [], errors: [], autoEnableCodemode: undefined };
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return {
      config: { mcpServers: {} },
      servers: [],
      errors: [`mcp.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      autoEnableCodemode: undefined,
    };
  }
  if (!isRecord(parsed)) {
    return { config: { mcpServers: {} }, servers: [], errors: ["mcp.json must contain an object"], autoEnableCodemode: undefined };
  }

  const rawServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  const servers = [];
  const errors = [];
  for (const [name, value] of Object.entries(rawServers)) {
    const normalized = normalizeMcpServerEntry(name, value);
    if (normalized.error) {
      errors.push(normalized.error);
    } else {
      servers.push(normalized.server);
    }
  }

  return {
    config: { ...parsed, mcpServers: rawServers },
    servers,
    errors,
    autoEnableCodemode: typeof parsed.autoEnableCodemode === "boolean" ? parsed.autoEnableCodemode : undefined,
  };
}

/** 读取一个 `mcp.json`；不存在时返回空配置（创建走写入路径）。 */
export function readMcpConfigPath(path) {
  if (!existsSync(path)) {
    return { path, exists: false, config: { mcpServers: {} }, servers: [], errors: [], autoEnableCodemode: undefined };
  }
  try {
    return { path, exists: true, ...parseMcpConfigText(readFileSync(path, "utf8")) };
  } catch (error) {
    return {
      path,
      exists: true,
      config: { mcpServers: {} },
      servers: [],
      errors: [error instanceof Error ? error.message : String(error)],
      autoEnableCodemode: undefined,
    };
  }
}

/** 写 `mcp.json`：2 空格缩进 + 末尾换行，目录不存在就建。 */
export function writeMcpConfigPath(path, config) {
  mkdirSync(dirname(path), { recursive: true });
  const normalized = isRecord(config) ? config : { mcpServers: {} };
  const payload = { ...normalized, mcpServers: isRecord(normalized.mcpServers) ? normalized.mcpServers : {} };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/**
 * 新增/覆盖一个服务器条目。只改 pi 认识的已知字段，保留条目里其它手写内容
 * （`oauth`、将来 pi 新增的字段）。设成默认值的字段会被删掉，让文件保持干净。
 */
export function upsertMcpServer(config, name, definition) {
  const serverName = normalizeMcpServerName(name);
  if (!serverName) {
    throw new Error(`Invalid MCP server name "${String(name)}".`);
  }
  const existing = isRecord(config?.mcpServers?.[serverName]) ? { ...config.mcpServers[serverName] } : {};
  const entry = { ...existing };

  for (const key of ["command", "args", "env", "cwd", "url", "headers", "type"]) {
    delete entry[key];
  }
  if (definition.transport === "stdio") {
    entry.command = String(definition.command ?? "").trim();
    if (Array.isArray(definition.args) && definition.args.length) {
      entry.args = definition.args.map((arg) => String(arg));
    }
    const env = stringMap(definition.env);
    if (Object.keys(env).length) {
      entry.env = env;
    }
    if (definition.cwd) {
      entry.cwd = String(definition.cwd);
    }
  } else {
    entry.url = String(definition.url ?? "").trim();
    const headers = stringMap(definition.headers);
    if (Object.keys(headers).length) {
      entry.headers = headers;
    }
  }

  if (isMcpExposure(definition.exposure) && definition.exposure !== DEFAULT_MCP_EXPOSURE) {
    entry.exposure = definition.exposure;
  } else {
    delete entry.exposure;
  }
  if (isRecord(definition.toolExposure) && Object.keys(definition.toolExposure).length) {
    entry.toolExposure = { ...definition.toolExposure };
  } else {
    delete entry.toolExposure;
  }
  if (definition.enabled === false) {
    entry.enabled = false;
  } else {
    delete entry.enabled;
  }
  if (typeof definition.timeout === "number" && definition.timeout > 0) {
    entry.timeout = definition.timeout;
  } else {
    delete entry.timeout;
  }

  return {
    ...config,
    mcpServers: { ...(isRecord(config?.mcpServers) ? config.mcpServers : {}), [serverName]: entry },
  };
}

export function removeMcpServer(config, name) {
  const serverName = normalizeMcpServerName(name);
  if (!serverName || !isRecord(config?.mcpServers) || !(serverName in config.mcpServers)) {
    return { config, removed: false };
  }
  const nextServers = { ...config.mcpServers };
  delete nextServers[serverName];
  return { config: { ...config, mcpServers: nextServers }, removed: true };
}

/** `/mcp` 面板的 Save 语义：只改 enabled / exposure，其它字段照旧。 */
export function patchMcpServer(config, name, patch) {
  const serverName = normalizeMcpServerName(name);
  const existing = serverName && isRecord(config?.mcpServers?.[serverName]) ? config.mcpServers[serverName] : null;
  if (!existing) {
    throw new Error(`MCP server "${String(name)}" is not defined in this file.`);
  }
  const entry = { ...existing };
  if (typeof patch?.enabled === "boolean") {
    if (patch.enabled) {
      delete entry.enabled;
    } else {
      entry.enabled = false;
    }
  }
  if (patch?.exposure !== undefined) {
    if (!isMcpExposure(patch.exposure)) {
      throw new Error(`Invalid MCP exposure "${String(patch.exposure)}".`);
    }
    if (patch.exposure === DEFAULT_MCP_EXPOSURE) {
      delete entry.exposure;
    } else {
      entry.exposure = patch.exposure;
    }
  }
  return { ...config, mcpServers: { ...config.mcpServers, [serverName]: entry } };
}

/**
 * 合并全局与项目：同名时**项目整体覆盖全局**（不按字段合并），并给每条打上来源。
 * 返回顺序按名字排序，UI 直接渲染。
 */
export function mergeMcpServerEntries(globalServers, projectServers, globalMeta = {}, projectMeta = {}) {
  const map = new Map();
  for (const server of globalServers) {
    map.set(server.name, { ...server, scope: "user", meta: globalMeta[server.name] ?? {} });
  }
  for (const server of projectServers) {
    map.set(server.name, { ...server, scope: "project", meta: projectMeta[server.name] ?? {}, overridesGlobal: map.has(server.name) });
  }
  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** pi 的通配规则：只有含 `*` 的键才算模式，精确名优先，模式按对象里的先后取第一个命中。 */
function toolPatternRegExp(pattern) {
  const source = String(pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/**
 * 单个工具最终落在哪个 exposure 上，语义与 pi 的 `getMcpToolExposure` 完全一致。
 * UI 用它显示/修改单工具覆盖，不需要再自己实现一遍通配。
 */
export function mcpToolExposure(server, toolName) {
  const overrides = isRecord(server?.toolExposure) ? server.toolExposure : {};
  if (overrides[toolName] !== undefined) {
    return overrides[toolName];
  }
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (String(pattern).includes("*") && toolPatternRegExp(pattern).test(String(toolName))) {
      return exposure;
    }
  }
  return isMcpExposure(server?.exposure) ? server.exposure : DEFAULT_MCP_EXPOSURE;
}
