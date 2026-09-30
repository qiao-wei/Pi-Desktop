/**
 * 「运行命令」在哪儿跑：后台静默、系统默认终端、还是指定某个终端 app。
 *
 * 这是纯 UI 偏好（`src/lib/ui-preferences.ts` 存 localStorage），但规则要能被 `node --test`
 * 直接跑，所以放共享层。渲染层把归一化后的 token 放进 `/api/projects/commands/run` 的请求体，
 * 桥再决定是 spawn 后台进程还是 `open -a <终端>`。
 */

/** 后台静默运行：不弹窗，输出写日志。 */
export const PROJECT_COMMAND_BACKGROUND = "background";
/** 系统默认终端（macOS = `Terminal`）。 */
export const PROJECT_COMMAND_DEFAULT_TERMINAL = "default";

/**
 * 偏好值的形态卫生：非法 / 空白一律落回后台静默。
 *
 * 终端 app 名走 `open -a`，只允许字母数字与 `. + - _` 空格；这样既挡了注入，也保证旧版本
 * localStorage 里的怪值不会让「运行」直接报错。
 */
export function normalizeProjectCommandTerminal(value: unknown): string {
  if (typeof value !== "string") {
    return PROJECT_COMMAND_BACKGROUND;
  }
  const text = value.trim();
  if (text === PROJECT_COMMAND_BACKGROUND) {
    return PROJECT_COMMAND_BACKGROUND;
  }
  if (text === PROJECT_COMMAND_DEFAULT_TERMINAL) {
    return PROJECT_COMMAND_DEFAULT_TERMINAL;
  }
  return /^[\w .+-]{1,64}$/.test(text) ? text : PROJECT_COMMAND_BACKGROUND;
}

export function isProjectCommandBackground(target: string): boolean {
  return target === PROJECT_COMMAND_BACKGROUND;
}

/** 后台运行结果里带回来的日志路径（前端「查看日志」用）。 */export interface ProjectCommandRunResult {
  /** 实际用的方式：`background` 或拉起终端的命令名（`open` / `gnome-terminal` …）。 */
  launcher: string;
  command: string;
  /** 背景运行的日志文件；终端模式没有。 */
  logPath?: string;
  /** 背景运行的进程号；终端模式没有。 */
  pid?: number;
}

/**
 * 一条还在后台跑着的命令（`/api/projects/commands/status` 的返回项）。
 *
 * 服务端只返回**存活**的记录，所以拿到它就说明进程还在；轮询到它消失即代表已退出。
 */
export interface ProjectCommandRun {
  /** pid + 启动时间拼出的稳定 id，「停止」用它定位。 */
  id: string;
  pid: number;
  projectId: string;
  commandId: string;
  command: string;
  cwd: string;
  /** 后台日志路径（「查看日志」用）。 */
  logPath: string;
  startedAt: number;
  sessionPath: string;
}

/**
 * 把状态接口的返回洗成可渲染的记录：脏数据、缺 pid / 命令的一律丢掉，按 id 去重、
 * 最新的在前。桥还是旧版本（没这个接口）时返回空数组，界面就只当没有运行中的命令。
 */
export function normalizeProjectCommandRuns(value: unknown): ProjectCommandRun[] {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const runs: ProjectCommandRun[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const source = raw as Record<string, unknown>;
    const pid = Number(source.pid);
    const startedAt = Number(source.startedAt);
    const command = String(source.command ?? "").trim();
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startedAt) || startedAt <= 0 || !command) {
      continue;
    }
    const id = typeof source.id === "string" && source.id ? source.id : `${pid}-${startedAt}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    runs.push({
      id,
      pid,
      startedAt,
      command,
      projectId: String(source.projectId ?? ""),
      commandId: String(source.commandId ?? ""),
      cwd: String(source.cwd ?? ""),
      logPath: typeof source.logPath === "string" ? source.logPath : "",
      sessionPath: typeof source.sessionPath === "string" ? source.sessionPath : "",
    });
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * 两份运行列表是不是同一份内容（按归一化后的稳定顺序逐项比）。
 *
 * 轮询是 3 秒一次，如果每次都 `setRuns(新数组)`，React 会认为 state 变了、把整个 App
 * 重渲染一遍——哪怕进程列表一个字节没动。用它把「没变」的情况挡回去（返回同一引用，
 * React 直接 bail out），只在真有进程起来/退出时才重渲染。
 */
export function sameProjectCommandRuns(a: readonly ProjectCommandRun[], b: readonly ProjectCommandRun[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left.id !== right.id
      || left.pid !== right.pid
      || left.startedAt !== right.startedAt
      || left.logPath !== right.logPath
      || left.command !== right.command
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 当前选中的命令有没有正在跑的后台进程（最新的一条）。
 *
 * 「运行」按钮据此变成「停止」：选中的命令在跑就停止它，否则还是开始跑。列表按启动
 * 时间倒序，所以同一条命令被跑了多次时拿到的是最新那次。
 */
export function findCommandRun(
  runs: readonly ProjectCommandRun[],
  commandId: string,
): ProjectCommandRun | null {
  if (!commandId) {
    return null;
  }
  return runs.find((run) => run.commandId === commandId) ?? null;
}