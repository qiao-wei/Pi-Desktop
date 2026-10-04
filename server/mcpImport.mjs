/**
 * MCP 配置文件的导入：把各家客户端的 JSON 形状「猜」出来并翻译成 pi 的 `mcpServers` 条目。
 *
 * 之所以要猜：MCP 官方没有统一的配置文件标准，各家客户端各写各的。同一份语义至少有这些形状：
 *
 *   - Claude Desktop / Cursor / Cline / Windsurf / Claude Code / pi：`{ "mcpServers": { ... } }`；
 *   - VS Code（`.vscode/mcp.json`）：`{ "servers": { ... } }`，条目多一个 `"type": "stdio" | "http"`；
 *   - Zed（`settings.json`）：`{ "context_servers": { ... } }`，`command` 可能是对象或数组；
 *   - 有些工具（OpenCode 等）：`{ "mcp": { "servers": { ... } } }`，`command` 是数组、env 叫 `environment`；
 *   - 也有直接给一个条目（`{ "command": ... }`）或一个「名字 → 条目」裸表。
 *
 * 所以这里分两步：先把顶层容器猜出来，再把每个条目归一化成 pi 的字段语义。翻译过程**不写文件、
 * 不发网络请求、只做纯函数**，方便单测；`server/index.mjs` 只把解析结果回给前端，由
 * `McpServerEditor` 填进表单、走按钮保存那条路。
 *
 * 被显式翻译掉的字段（`type` / `source` / `command` 数组 / `environment` ...）不再保留；其余 pi 不
 * 认识但可能有用的字段（`oauth` / `auth` ...）收进 `extras`，保存时随表单一起写回，
 * 避免导入一次就丢掉用户的授权配置。
 */

import { DEFAULT_MCP_EXPOSURE, isMcpExposure, normalizeMcpServerName } from "./mcpConfig.mjs";

/** 顶层容器 → 格式代号；UI 用 `capability.mcp.import.format.<code>` 显示成人话。 */
const CONTAINER_FORMATS = [
  { key: "mcpServers", format: "mcp-servers" },
  { key: "mcp_servers", format: "mcp-servers" },
  { key: "servers", format: "vscode" },
  { key: "context_servers", format: "zed" },
];

/** 不写回 mcp.json 的键：要么是别家的传输描述，要么已经翻译进 pi 的字段。 */
const TRANSLATED_KEYS = new Set([
  "name",
  "id",
  "serverName",
  "server_name",
  "type",
  "transport",
  "kind",
  "source",
  "disabled",
  "serverUrl",
  "server_url",
  "httpUrl",
  "http_url",
  "endpoint",
  "envFile",
  "inputs",
  "command",
  "args",
  "env",
  "environment",
  "cwd",
  "workingDirectory",
  "url",
  "headers",
  "description",
]);

/** VS Code 的 `inputs` 模板变量，pi 不认识，导入前必须由用户替换。 */
const TEMPLATE_VARIABLE = /\$\{[^}]+\}/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function firstRecord(...values) {
  for (const value of values) {
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function stringMap(value) {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value)
    .filter(([key]) => String(key).trim())
    .map(([key, next]) => [String(key).trim(), typeof next === "string" ? next : String(next ?? "")]);
  return Object.fromEntries(entries);
}

/**
 * 把一段命令字符串拆成 argv，认单双引号。`"npx -y foo"` → `["npx", "-y", "foo"]`。
 * 只在 `args` 缺失、且 `command` 自带空格时才用——正常格式应该把参数分开写。
 */
export function splitCommandString(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const char of String(input ?? "")) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * 服务器名归一化：pi 只接受 `[A-Za-z0-9_-]+`。非法字符换成 `-` 并折叠，尽量把名字救回来；
 * 救不回来（全非法/空）返回空串，由调用方报错。
 */
export function sanitizeImportedName(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  if (normalizeMcpServerName(raw)) {
    return raw;
  }
  const sanitized = raw
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalizeMcpServerName(sanitized) ?? "";
}

/** 一个对象看起来是不是「单个 MCP 服务器条目」。 */
function looksLikeServerEntry(value) {
  if (!isRecord(value)) {
    return false;
  }
  return ["command", "args", "env", "environment", "cwd", "url", "serverUrl", "server_url", "httpUrl", "http_url", "endpoint", "headers", "type", "transport", "kind"]
    .some((key) => key in value);
}

/** 「名字 → 条目」裸表：非空，且至少有一个值是像样的条目。 */
function looksLikeServerMap(value) {
  if (!isRecord(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([, entry]) => isRecord(entry)) && entries.some(([, entry]) => looksLikeServerEntry(entry));
}

/** 猜顶层容器。返回 `{ format, kind, value }`；`kind` 是 `"map"` / `"list"` / `"entry"`。 */
export function detectMcpImportShape(parsed) {
  if (Array.isArray(parsed)) {
    return { format: "list", kind: "list", value: parsed };
  }
  if (!isRecord(parsed)) {
    return null;
  }
  for (const candidate of CONTAINER_FORMATS) {
    if (isRecord(parsed[candidate.key])) {
      return { format: candidate.format, kind: "map", value: parsed[candidate.key] };
    }
  }
  // `{ "mcp": { "servers": { ... } } }` / `{ "mcp": { "mcpServers": { ... } } }` / 裸的 `{ "mcp": { ... } }`
  if (isRecord(parsed.mcp)) {
    if (isRecord(parsed.mcp.servers)) {
      return { format: "mcp", kind: "map", value: parsed.mcp.servers };
    }
    if (isRecord(parsed.mcp.mcpServers)) {
      return { format: "mcp", kind: "map", value: parsed.mcp.mcpServers };
    }
    if (looksLikeServerMap(parsed.mcp)) {
      return { format: "mcp", kind: "map", value: parsed.mcp };
    }
  }
  if (looksLikeServerEntry(parsed)) {
    return { format: "single", kind: "entry", value: parsed };
  }
  if (looksLikeServerMap(parsed)) {
    return { format: "map", kind: "map", value: parsed };
  }
  return null;
}

/**
 * 传输方式：把各家的 `type` / `transport` / `kind` 归一到 pi 的 `stdio` / `http`。
 * 返回 `{ transport }` 或 `{ error }`；`sse` 明确拒绝（pi 不支持 legacy SSE）。
 */
function resolveTransport(value) {
  const declared = String(firstString(value.type, value.transport, value.kind)).toLowerCase().replace(/[\s_]+/g, "-");
  const command = value.command;
  const hasCommand = typeof command === "string" || Array.isArray(command) || isRecord(command);
  const url = firstString(value.url, value.serverUrl, value.server_url, value.httpUrl, value.http_url, value.endpoint);

  if (declared === "sse") {
    return { error: "legacy SSE transport is not supported; use the streamable HTTP URL" };
  }
  if (declared === "stdio" || declared === "local" || declared === "process" || declared === "command") {
    if (!hasCommand) {
      return { error: `type is "${declared}" but there is no "command"` };
    }
    return { transport: "stdio" };
  }
  if (["http", "streamable-http", "streamablehttp", "remote", "url"].includes(declared)) {
    if (!url) {
      return { error: `type is "${declared}" but there is no "url"` };
    }
    return { transport: "http" };
  }
  if (declared) {
    return { error: `unsupported transport type "${declared}"` };
  }
  // 无显式 type 时按 pi 的规则：先看 url（http），再看 command（stdio）。两者都有时算 http。
  if (url) {
    return { transport: "http" };
  }
  if (hasCommand) {
    return { transport: "stdio" };
  }
  return { error: 'needs either "command" (stdio) or "url" (streamable HTTP)' };
}

/**
 * 归一化一个条目，产出 pi 的 `mcpServers` 条目（`entry`）+ 给 UI 看的字段（`server`）。
 * `entry` 会带上别家不认识但 pi 认识的额外字段（`oauth` / `auth` ...）。
 */
function normalizeImportedEntry(name, raw) {
  const warnings = [];
  if (!isRecord(raw)) {
    return { error: `server "${name}" must be an object` };
  }

  const resolved = resolveTransport(raw);
  if (resolved.error) {
    return { error: `server "${name}": ${resolved.error}` };
  }

  let command = "";
  let args = [];
  let env = {};
  const commandValue = raw.command;
  if (typeof commandValue === "string") {
    command = commandValue.trim();
    if (!Array.isArray(raw.args) && !(typeof raw.args === "string" && raw.args.trim()) && /\s/.test(command)) {
      const parts = splitCommandString(command);
      command = parts[0] ?? "";
      args = parts.slice(1);
      warnings.push(`server "${name}": split the inline command string into command + args`);
    }
  } else if (Array.isArray(commandValue)) {
    command = String(commandValue[0] ?? "").trim();
    args = commandValue.slice(1).map((item) => String(item));
  } else if (isRecord(commandValue)) {
    command = firstString(commandValue.path, commandValue.command);
    if (Array.isArray(commandValue.args)) {
      args = commandValue.args.map((item) => String(item));
    }
    env = { ...env, ...stringMap(commandValue.env) };
  }

  if (Array.isArray(raw.args)) {
    args = raw.args.map((item) => String(item));
  } else if (typeof raw.args === "string" && raw.args.trim()) {
    args = splitCommandString(raw.args);
  }

  env = { ...env, ...stringMap(firstRecord(raw.env, raw.environment)) };
  const headers = stringMap(raw.headers);
  const cwd = firstString(raw.cwd, raw.workingDirectory);
  const url = firstString(raw.url, raw.serverUrl, raw.server_url, raw.httpUrl, raw.http_url, raw.endpoint);

  if (resolved.transport === "stdio") {
    if (!command) {
      return { error: `server "${name}": needs a non-empty "command"` };
    }
  } else {
    if (!url) {
      return { error: `server "${name}": needs a non-empty "url"` };
    }
    if (TEMPLATE_VARIABLE.test(url)) {
      return { error: `server "${name}": url contains a template variable (${TEMPLATE_VARIABLE.exec(url)?.[0]}); resolve it before importing` };
    }
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
      return { error: `server "${name}": url must be an http or https URL` };
    }
  }
  if (resolved.transport === "stdio" && TEMPLATE_VARIABLE.test(command)) {
    warnings.push(`server "${name}": command contains a template variable; check it before importing`);
  }
  if (raw.envFile !== undefined) {
    warnings.push(`server "${name}": "envFile" is not supported yet; set the variables under env`);
  }
  if (raw.inputs !== undefined || TEMPLATE_VARIABLE.test(args.join(" "))) {
    warnings.push(`server "${name}": config has input placeholders; replace them before starting the server`);
  }

  // exposure / toolExposure：非法值不写回（pi 会因此整条拒绝），提示用户改。
  let exposure;
  if (raw.exposure !== undefined) {
    if (isMcpExposure(raw.exposure)) {
      exposure = raw.exposure;
    } else {
      warnings.push(`server "${name}": dropped unknown exposure "${String(raw.exposure)}"`);
    }
  }
  const toolExposure = {};
  if (isRecord(raw.toolExposure)) {
    for (const [tool, value] of Object.entries(raw.toolExposure)) {
      if (isMcpExposure(value)) {
        toolExposure[tool] = value;
      } else {
        warnings.push(`server "${name}": dropped unknown exposure "${String(value)}" for tool "${tool}"`);
      }
    }
  } else if (raw.toolExposure !== undefined) {
    warnings.push(`server "${name}": dropped malformed toolExposure`);
  }

  let timeout;
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout === "number" && raw.timeout > 0) {
      timeout = raw.timeout;
    } else {
      warnings.push(`server "${name}": dropped invalid timeout`);
    }
  }

  const disabled = raw.enabled === false || raw.disabled === true;

  // 保留 pi 认识、但本模块不翻译的字段（oauth / auth ...）。被翻译掉的键不要写回。
  const extras = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!TRANSLATED_KEYS.has(key) && key !== "exposure" && key !== "toolExposure" && key !== "enabled" && key !== "timeout") {
      extras[key] = value;
    }
  }
  const entry = { ...extras };
  if (resolved.transport === "stdio") {
    entry.command = command;
    if (args.length) {
      entry.args = args;
    }
    if (Object.keys(env).length) {
      entry.env = env;
    }
    if (cwd) {
      entry.cwd = cwd;
    }
  } else {
    entry.url = url;
    if (Object.keys(headers).length) {
      entry.headers = headers;
    }
  }
  if (exposure && exposure !== DEFAULT_MCP_EXPOSURE) {
    entry.exposure = exposure;
  }
  if (Object.keys(toolExposure).length) {
    entry.toolExposure = toolExposure;
  }
  if (disabled) {
    entry.enabled = false;
  }
  if (timeout) {
    entry.timeout = timeout;
  }

  return {
    entry,
    extras,
    warnings,
    server: {
      name,
      transport: resolved.transport,
      command,
      args,
      env,
      cwd,
      url,
      headers,
      exposure: exposure ?? DEFAULT_MCP_EXPOSURE,
      toolExposure,
      enabled: !disabled,
      timeout,
      hasOAuth: isRecord(entry.oauth),
      description: typeof raw.description === "string" ? raw.description.trim() : "",
    },
  };
}

/**
 * 解析一份 MCP 配置文本。
 *
 * 返回 `{ ok, format, servers, errors, warnings }`，其中 `servers` 的每条是
 * `{ name, entry, extras, server, warnings }`：`entry` 是可直接写进 `mcpServers` 的完整条目，
 * `extras` 是 pi 认识但表单不翻译的字段（`oauth` ...），`server` 是给表单/预览用的字段视图。
 * 解析失败（不是 JSON / 认不出容器）时 `ok:false`、`servers` 为空、`errors` 是原因。
 */
export function parseMcpImportText(text, options = {}) {
  const source = String(text ?? "").trim();
  const empty = { ok: false, format: null, servers: [], errors: [], warnings: [] };
  if (!source) {
    return { ...empty, errors: ["The config file is empty."] };
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return { ...empty, errors: [`The config file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const shape = detectMcpImportShape(parsed);
  if (!shape) {
    return {
      ...empty,
      errors: ['Unrecognized MCP config: expected "mcpServers", "servers", "context_servers", "mcp" or a single server entry.'],
    };
  }

  const fallbackName = sanitizeImportedName(options.defaultName) || "imported-server";
  const rawEntries = shape.kind === "map"
    ? Object.entries(shape.value)
    : shape.kind === "list"
      ? shape.value.map((item, index) => [firstString(item?.name, item?.id, item?.serverName) || `${fallbackName}-${index + 1}`, item])
      : [[firstString(shape.value.name, shape.value.id, shape.value.serverName) || fallbackName, shape.value]];

  const servers = [];
  const errors = [];
  const warnings = [];
  const seen = new Set();
  for (const [rawName, rawEntry] of rawEntries) {
    const name = sanitizeImportedName(rawName);
    if (!name) {
      errors.push(`invalid server name "${String(rawName)}" (use letters, digits, "_" and "-")`);
      continue;
    }
    if (name !== String(rawName).trim()) {
      warnings.push(`server name "${String(rawName)}" was normalized to "${name}"`);
    }
    if (seen.has(name)) {
      errors.push(`duplicate server name "${name}"`);
      continue;
    }
    seen.add(name);
    const normalized = normalizeImportedEntry(name, rawEntry);
    if (normalized.error) {
      errors.push(normalized.error);
      continue;
    }
    servers.push({ name, entry: normalized.entry, extras: normalized.extras, server: normalized.server, warnings: normalized.warnings });
    warnings.push(...normalized.warnings);
  }

  return { ok: true, format: shape.format, servers, errors, warnings };
}