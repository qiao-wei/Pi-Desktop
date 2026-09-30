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

/** 后台运行结果里带回来的日志路径（前端「查看日志」用）。 */
export interface ProjectCommandRunResult {
  /** 实际用的方式：`background` 或拉起终端的命令名（`open` / `gnome-terminal` …）。 */
  launcher: string;
  command: string;
  /** 背景运行的日志文件；终端模式没有。 */
  logPath?: string;
  /** 背景运行的进程号；终端模式没有。 */
  pid?: number;
}