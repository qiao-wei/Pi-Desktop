/**
 * 零散纯函数.
 *
 * 时间戳解析、错误详情、运行时判定、JSON 收发等「一行到十行」的工具。
 *
 * 从 `server/index.mjs` 搬出来的纯函数（只依赖 import 进来的东西，不碰模块状态）——
 * 那个文件曾经 8.7k 行、棘轮不许它再长，所以按「一簇一文件」往外搬。
 */
import { corsHeaders } from "./cors.mjs";
import { groupMcpToolsByNamespace } from "./mcpConfig.mjs";
import { THINKING_LEVELS } from "./sessionModelPolicy.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function parseTime(value) {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function errorDetails(error) {
  return {
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack : undefined,
  };
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

function sessionRuntimeKey(sessionPath) {
  if (!sessionPath) {
    throw new Error("Session file is required.");
  }

  return resolve(sessionPath);
}

function normalizePersonalizationText(value, maxLength, name) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) {
    throw new Error(`${name} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function attachmentOnlyPrompt(attachments) {
  if (attachments.length === 1) {
    const only = attachments[0];
    return `Please review the attached ${only?.kind === "directory" ? "folder" : "file"}: ${only?.name}`;
  }
  return `Please review these ${attachments.length} attached files.`;
}

/** 结果条数上限：太小一行放不下就翻不到，太大又会把 JSON 撑肥。 */
function searchResultLimit(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return 30;
  }
  return Math.min(100, Math.floor(value));
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  res.end(JSON.stringify(body));
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createEmptyCapabilitiesDefaults() {
  return {
    version: 1,
    defaultEnabledSkills: [],
  };
}

function skillSummaries(resourceLoader) {
  return resourceLoader.getSkills().skills.map((skill) => ({
    name: skill.name,
    path: skill.filePath,
  }));
}

/** 命令列表接口的响应形状（前端 hook 只认这两个字段）。 */
function projectCommandsPayload(project) {
  return {
    commands: project.commands ?? [],
    selectedCommandId: project.selectedCommandId ?? "",
  };
}

/** 写项目 `.pi/mcp.json` 前先确认项目已信任——未信任时 pi 根本不会加载它。 */
function assertMcpWriteScope(targetRuntime, scope) {
  if (scope === "project" && targetRuntime.settingsManager?.isProjectTrusted?.() === false) {
    throw new Error("Trust this project before editing its .pi/mcp.json.");
  }
}

function defaultSkillEnabled(config, skillId) {
  const entry = config.skills[skillId];
  return entry?.defaultEnabled === true;
}

function writeVersionMetadata(versionDir, meta) {
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function displayAgentPath(path) {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function normalizeThinkingLevel(value) {
  const thinkingLevel = String(value ?? "").trim();
  return THINKING_LEVELS.includes(thinkingLevel) ? thinkingLevel : "off";
}

function formatAgentError(errorMessage) {
  const message = String(errorMessage ?? "").trim();
  return message ? `模型调用停止：${message}` : "模型调用停止：未知错误";
}

function partialToolCall(assistantEvent) {
  const block = assistantEvent.partial?.content?.[assistantEvent.contentIndex];
  return block?.type === "toolCall" ? block : null;
}

function toolStreamId(assistantIndex, contentIndex) {
  const messageIndex = assistantIndex >= 0 ? assistantIndex : "unknown";
  return `assistant-${messageIndex}-tool-content-${contentIndex}`;
}

/** True when this install relies on the host's node/python instead of shipped runtimes. */
function runtimeMode() {
  return process.env.PI_DESKTOP_RUNTIME_MODE?.trim().toLowerCase() === "system";
}

function isSessionBusy(session) {
  return session.isStreaming || session.isCompacting || session.pendingMessageCount > 0;
}

/** app 自己的 MCP 元数据（pinned / 描述）在 capabilities.json 里的键：`<scope>:<name>`。 */
function mcpMetaKey(scope, name) {
  return `${scope === "project" ? "project" : "user"}:${name}`;
}

/**
 * 当前会话里 pi 真正注册的 MCP 工具，按命名空间（`mcp__<server>`）分组。
 * 不额外连一遍服务器——直接读会话状态，和 TUI 看到的是同一份内核事实。
 * 纯分组与命名空间换算在 `mcpConfig.mjs`，那里可以单测；这里只负责拿到会话的工具列表。
 */
function mcpToolsByNamespace(targetRuntime) {
  return groupMcpToolsByNamespace(targetRuntime.session?.getAllTools?.() ?? []);
}

export { parseTime, errorDetails, readKeyResponse, sessionRuntimeKey, normalizePersonalizationText, attachmentOnlyPrompt, searchResultLimit, sendJson, writeJsonFile, createEmptyCapabilitiesDefaults, skillSummaries, projectCommandsPayload, assertMcpWriteScope, defaultSkillEnabled, writeVersionMetadata, displayAgentPath, normalizeThinkingLevel, formatAgentError, partialToolCall, toolStreamId, runtimeMode, isSessionBusy, mcpMetaKey, mcpToolsByNamespace };
