/**
 * 项目命令列表（会话头部「运行」按钮 + 它左边那个命令下拉）。
 *
 * 纯逻辑住在这里而不是组件里，因为「列表怎么合并、怎么去重、选中项怎么回退」是行为契约，
 * 要能被 `node --test` 直接跑；`server/index.mjs` 也 import 同一份归一化 —— `projects.json`
 * 是这份列表唯一的持久化点，两侧的规则必须完全一致。
 *
 * 序列化形状（写进 projects.json）：
 * - `commands`: `ProjectCommand[]`
 * - `selectedCommandId`: 下拉里当前选中的那条；列表变了之后由 `normalizeSelectedCommandId`
 *   兜底（选中项被删掉就退回第一条）。
 */

/** 一条可运行的命令。 */
export interface ProjectCommand {
  /** 稳定 id：同一条命令 + 同一个工作目录 + 同一个来源，永远是同一个 id（重复探测不会长出重复项）。 */
  id: string;
  /** 下拉里显示的名字，例如 `Makefile · dev` / `web · npm run dev`。 */
  label: string;
  /** 真正执行的命令行，例如 `npm run dev`。 */
  command: string;
  /** 工作目录相对项目根的子目录；空串 = 项目根。monorepo 的 workspace 命令靠它。 */
  cwd: string;
  /** 谁发现的：探测规则名（`package.json` / `Procfile` / `Makefile` …）或 `manual`。 */
  source: string;
}

export interface ProjectCommandsState {
  commands: ProjectCommand[];
  selectedCommandId: string;
}

/**
 * 列表上限。
 *
 * 探测会把根 package.json 的**全部**脚本 + 子包脚本都摆出来让用户挑，所以给得很大（列表本身
 * 可以搜索/滚动）；用户在列表里真正保存的通常只有几条。
 */
export const PROJECT_COMMAND_LIMIT = 200;
/** 单条命令行长度上限（探测出来的都是短命令，超长的一律当脏数据丢掉）。 */
export const PROJECT_COMMAND_MAX_LENGTH = 500;

/**
 * 稳定 id = 对「来源 + 工作目录 + 命令」做一次 djb2 哈希。
 *
 * 不用原文当 id：命令可能很长、带空格和引号，塞进 JSON、DOM key、POST body 里都不干净。
 * 40 条以内 32 位哈希的碰撞概率可以忽略，而且真正的去重靠 `command + cwd`（见 `normalize`）。
 */
export function projectCommandId(source: string, command: string, cwd = ""): string {
  const text = `${source}\u0000${cwd}\u0000${command}`;
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  // 再跑一轮，避免短字符串高位分布不均；结果恒为正。
  let second = 52711;
  for (let index = 0; index < text.length; index += 1) {
    second = ((second << 5) + second) ^ text.charCodeAt(index);
  }
  return `pc-${(hash >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

/**
 * 归一化一条命令的相对工作目录。
 *
 * 只接受「项目根往下一层或几层」的相对路径 —— 绝对路径和 `..` 一律回退到项目根，
 * 免得 projects.json 里一条脏数据把命令跑到项目外面去。
 */
export function normalizeCommandCwd(value: unknown): string {
  const text = String(value ?? "").replace(/\\/g, "/").trim();
  if (!text || text === ".") {
    return "";
  }
  if (text.startsWith("/") || /^[a-zA-Z]:/.test(text)) {
    return "";
  }
  const parts = text.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.includes("..")) {
    return "";
  }
  return parts.join("/");
}

/** 归一化持久化下来的命令列表：丢脏数据、按「工作目录 + 命令」去重、封顶。 */
export function normalizeProjectCommands(value: unknown): ProjectCommand[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const commands: ProjectCommand[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const command = String(record.command ?? "").replace(/\0/g, "").trim();
    if (!command || command.length > PROJECT_COMMAND_MAX_LENGTH) {
      continue;
    }
    const cwd = normalizeCommandCwd(record.cwd);
    const source = String(record.source ?? "").trim() || "manual";
    const label = String(record.label ?? "").trim() || command;
    const dedupeKey = `${cwd}\u0000${command}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    const id = String(record.id ?? "").trim() || projectCommandId(source, command, cwd);
    commands.push({ id, label, command, cwd, source });
    if (commands.length >= PROJECT_COMMAND_LIMIT) {
      break;
    }
  }

  return commands;
}

/** 选中项必须真的在列表里；不在（空列表 / 被删了）就退回第一条。 */
export function normalizeSelectedCommandId(value: unknown, commands: ProjectCommand[]): string {
  const id = String(value ?? "").trim();
  if (id && commands.some((command) => command.id === id)) {
    return id;
  }
  return commands[0]?.id ?? "";
}

/** 当前选中的命令，没有就返回 null（「运行」按钮据此禁用）。 */
export function selectedProjectCommand(commands: ProjectCommand[], selectedCommandId: string): ProjectCommand | null {
  return commands.find((command) => command.id === selectedCommandId) ?? null;
}

/**
 * 这条候选是不是已经在列表里了（按 id 或「目录+命令」判重，和 `mergeDetectedCommands` 一致）。
 *
 * 下拉里用它把已加过的候选标成勾：可以连着加好几条，每条都有反馈。
 */
export function isCommandSaved(commands: ProjectCommand[], candidate: ProjectCommand): boolean {
  return commands.some(
    (command) => command.id === candidate.id || (command.cwd === candidate.cwd && command.command === candidate.command),
  );
}

/**
 * 把探测出来的候选并进列表。
 *
 * 用户在下拉里点一条加一条（一次只点一条，但可以连着加好几条），所以这里只做"并入 + 去重 +
 * 空列表时自动选中第一条新加的"。列表原本非空时不改选中项 —— 用户正在用的命令不该被探测结果顶掉。
 */
export function mergeDetectedCommands(
  commands: ProjectCommand[],
  selectedCommandId: string,
  detected: ProjectCommand[],
): ProjectCommandsState {
  const next = [...commands];
  let selected = normalizeSelectedCommandId(selectedCommandId, commands);
  let firstAdded = "";
  for (const candidate of detected) {
    if (next.length >= PROJECT_COMMAND_LIMIT) {
      break;
    }
    if (next.some((command) => command.id === candidate.id || (command.cwd === candidate.cwd && command.command === candidate.command))) {
      continue;
    }
    next.push(candidate);
    firstAdded ||= candidate.id;
  }
  if (!selected) {
    selected = firstAdded;
  }
  return { commands: next, selectedCommandId: selected };
}

/** 删掉一条命令；删的正好是选中项时选中项退回新列表的第一条。 */
export function removeProjectCommand(
  commands: ProjectCommand[],
  selectedCommandId: string,
  id: string,
): ProjectCommandsState {
  const next = commands.filter((command) => command.id !== id);
  return {
    commands: next,
    selectedCommandId: normalizeSelectedCommandId(selectedCommandId === id ? "" : selectedCommandId, next),
  };
}

/** 「运行」按钮为什么不能点；null = 可以点。 */
export type RunCommandDisabledReason = "none" | "running";

export function runCommandDisabledReason(
  selected: ProjectCommand | null,
  isRunning: boolean,
): RunCommandDisabledReason | null {
  if (!selected) {
    return "none";
  }
  if (isRunning) {
    return "running";
  }
  return null;
}

/** 探测结果与列表项同一个形状，直接复用合并逻辑。 */
export type DetectedProjectCommand = ProjectCommand;

/**
 * 下拉里的搜索：命中「名字 + 命令 + 子目录 + 来源」，按空白切成多个 token 做 AND。
 *
 * 一个 NextClaw 体量的项目探测出来就是几十条，没有搜索得靠眼扫。规则和包命令面板的
 * `filterPackageCommands` 保持一致（大小写不敏感、前导 `/` 不算搜索词）。
 */
export function filterProjectCommands(commands: ProjectCommand[], query: string): ProjectCommand[] {
  const tokens = String(query ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) {
    return commands;
  }
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.command} ${command.cwd} ${command.source}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/** 服务端 `GET/POST /api/projects/commands` 的响应。 */
export interface ProjectCommandsPayload {
  commands: ProjectCommand[];
  selectedCommandId: string;
}