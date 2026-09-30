/**
 * 「工具开关」的读写。Desktop 不另起一套存储：写的就是 **pi 自己的 `defaultTools`** ——
 * 全局 `~/.pi/agent/settings.json` + 项目 `<cwd>/.pi/settings.json`。
 *
 * 为什么非得写 pi 的文件：pi 的 SettingsManager **没有** `setDefaultTools()`（只有 getter），
 * 因为 TUI 里这个值本来就是手改文件的。Desktop 也照做，于是两边读的是同一个键，
 * "Desktop 关了、TUI 还开着"这种分歧从结构上就不可能发生。
 *
 * pi 的语义（docs/settings.md#tools）：
 * - 纯名字（`read`）会**替换**内建清单 `read/bash/edit/write`；只含 `+`/`-` 项时是"改"继承来的选择；
 * - `+name` 加、`-name` 减，按列表顺序应用；
 * - **`[]` 和"没这个键"不是一回事**：`[]` = 一个内建工具都不要；没这个键 = 内建四件套。
 *   这条很要命，所以"关掉 codemode"在全局层必须是**删键**（或删掉那一项），不能写成 `[]`。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** pi 的内建默认工具。resolve 时"没写过 defaultTools"就落在这里。 */
export const DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"];

/** 桌面端目前只管这一个工具；`tool_search` 交给 pi 的 MCP 扩展按需自动激活。 */
export const MANAGED_TOOL_NAME = "codemode";

/** 项目层的三态：没在这一层设过 = 继承全局。 */
export const TOOL_TOGGLE_STATES = ["inherit", "on", "off"];

export function isToolToggleState(value) {
  return TOOL_TOGGLE_STATES.includes(value);
}

function isToolModifier(entry) {
  return typeof entry === "string" && (entry.startsWith("+") || entry.startsWith("-"));
}

/** 把某一层的原始值规格化成字符串数组；非数组/非字符串按 pi 的容错处理。 */
export function normalizeToolList(value) {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/**
 * project 层叠在 global 层上——逐字复刻 pi 的 `mergeDefaultTools`：
 * 项目写纯 `+`/`-` 项时是"改"，写了任何纯名字时是"整体替换"。
 */
export function mergeToolLayers(globalRaw, projectRaw) {
  const global = normalizeToolList(globalRaw);
  const project = normalizeToolList(projectRaw);
  if (project === undefined) {
    return global;
  }
  if (global === undefined || !project.every(isToolModifier)) {
    return project;
  }
  return [...global, ...project];
}

/** 逐字复刻 pi 的 `resolveDefaultTools`；`undefined` = 内建四件套，`[]` = 什么都不开。 */
export function resolveToolNames(merged) {
  const entries = normalizeToolList(merged);
  if (entries === undefined) {
    return [...DEFAULT_TOOL_NAMES];
  }
  const tools = entries.filter((entry) => !isToolModifier(entry));
  const selection = tools.length > 0 || entries.length === 0 ? tools : [...DEFAULT_TOOL_NAMES];
  for (const entry of entries) {
    if (!isToolModifier(entry)) {
      continue;
    }
    const name = entry.slice(1);
    const index = selection.indexOf(name);
    if (entry.startsWith("+") && index === -1 && name) {
      selection.push(name);
    } else if (entry.startsWith("-") && index !== -1) {
      selection.splice(index, 1);
    }
  }
  return selection;
}

/**
 * 某一层里这个工具的状态。项目层用它决定三态显示：
 * `-codemode` → 关；`codemode` / `+codemode` → 开；其余 → 没在这层设过。
 */
export function readToolToggle(raw, toolName = MANAGED_TOOL_NAME) {
  const list = normalizeToolList(raw);
  if (!list) {
    return "inherit";
  }
  if (list.includes(`-${toolName}`)) {
    return "off";
  }
  if (list.includes(toolName) || list.includes(`+${toolName}`)) {
    return "on";
  }
  return "inherit";
}

/**
 * 把某一层里这个工具的名字全部摘掉（纯名 / `+名` / `-名` 三种写法），返回新列表。
 * 其它工具、顺序原样保留。
 */
export function stripToolToggle(raw, toolName = MANAGED_TOOL_NAME) {
  const list = normalizeToolList(raw) ?? [];
  return list.filter((entry) => entry.replace(/^[+-]/, "") !== toolName);
}

/**
 * 写入某一层。`state` 是 `on` / `off` / `inherit`。
 *
 * 全局层没有"继承"可言，`inherit` 等同于 `off`（回到内建四件套）。
 * **全局层的 `off` 在列表摘空后要删键**——写成 `[]` 会得到一个工具都没有的会话。
 */
export function applyToolToggle(raw, state, { scope, toolName = MANAGED_TOOL_NAME }) {
  if (!isToolToggleState(state)) {
    throw new Error(`invalid tool toggle state: ${String(state)}`);
  }
  const list = stripToolToggle(raw, toolName);
  const projectScoped = scope === "project";

  if (state === "on") {
    list.push(`+${toolName}`);
  } else if (state === "off" && projectScoped) {
    // 项目层要显式减，否则会继承全局的「开」。只含 `+`/`-` 的列表是"改"继承来的选择。
    list.push(`-${toolName}`);
  }

  if (list.length === 0) {
    // 全局层删键 = 内建四件套；项目层删键 = 继承全局。
    return undefined;
  }
  return list;
}

/** 某一层设置文件的路径，和 pi 的 `SettingsManager` 一致。 */
export function toolSettingsPath({ agentDir, projectCwd, scope }) {
  return scope === "project"
    ? join(projectCwd, ".pi", "settings.json")
    : join(agentDir, "settings.json");
}

/** 读一层的设置文件。坏 JSON 不抛——当成"这层什么都没写"，和 pi 的容错一致。 */
export function readToolSettingsFile(path) {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 只改 `defaultTools`，其它键（以及键的顺序）原样写回。 */
export function writeToolSettingsFile(path, settings) {
  const payload = { ...settings };
  if (payload.defaultTools === undefined) {
    delete payload.defaultTools;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (Object.keys(payload).length === 0) {
    // 摘干净了就删文件，别留一个 `{}`。留着的后果很具体：pi 认为
    // `.pi/settings.json` 是“需要信任的资源”，一个空文件也会让项目从此必须被信任。
    rmSync(path, { force: true });
    return payload;
  }
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/**
 * 一次性读出全局 / 项目两层，以及这个工具最终到底开不开。
 * `effective` 用真正的合并 + resolve 算出来，所以它才是"pi 会不会把这个工具给模型"的答案。
 */
export function readToolSettingsSnapshot({ agentDir, projectCwd, projectTrusted, toolName = MANAGED_TOOL_NAME }) {
  const globalPath = toolSettingsPath({ agentDir, projectCwd, scope: "user" });
  const projectPath = toolSettingsPath({ agentDir, projectCwd, scope: "project" });
  const globalSettings = readToolSettingsFile(globalPath);
  // 未信任的项目，pi 根本不读它的 settings.json —— 这里也不读，免得 UI 显示一个假状态。
  const projectSettings = projectTrusted ? readToolSettingsFile(projectPath) : {};

  const globalRaw = normalizeToolList(globalSettings.defaultTools);
  const projectRaw = projectTrusted ? normalizeToolList(projectSettings.defaultTools) : undefined;
  const merged = mergeToolLayers(globalRaw, projectRaw);

  return {
    agentDir,
    globalPath,
    projectPath,
    projectTrusted,
    global: readToolToggle(globalRaw, toolName) === "on",
    project: readToolToggle(projectRaw, toolName),
    effective: resolveToolNames(merged).includes(toolName),
    tools: resolveToolNames(merged),
  };
}