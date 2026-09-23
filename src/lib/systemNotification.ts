import { invoke } from "@tauri-apps/api/core";

/**
 * 系统通知的发送端（副作用都在这里）。
 *
 * 三个宿主共用一份 renderer：Electron 与 Tauri 都走 `invoke("notify_turn_complete")`
 * （Electron 侧由 `src-electron/preload.js` 的 shim 转发，和 `open_target` 同一条通路），
 * 纯 Web（`npm run dev:web`）退到浏览器 `Notification`。
 *
 * # 为什么必须看返回值
 *
 * macOS 从 Electron 42 起改用 `UNNotification`，未签名的开发版调用通知 API 只会静默
 * 失败：`show()` 不报错、也不显示，只在 `failed` 事件里说话。所以这条链路一律返回
 * `{ delivered, reason }`，让调用方（诊断日志）能区分「发了」和「以为发了」。
 */
const SHELL_COMMAND = "notify_turn_complete";

/**
 * renderer → 宿主的命令名。三个宿主必须同名：Electron 的 preload 白名单、Electron 的
 * ipcMain handler、Tauri 的 `generate_handler!`。改名字时三处一起改（有测试盯着）。
 */
export const TURN_NOTIFICATION_COMMAND = SHELL_COMMAND;

export interface SystemNotificationOutcome {
  delivered: boolean;
  /** 未送达的原因（`unsupported` / `denied` / `not-bundled` / 宿主原始错误文本……）。 */
  reason?: string;
}

export type SystemNotificationChannel = "shell" | "browser" | "none";

/** Electron / Tauri 是否在场（两个宿主都实现了 `__TAURI_INTERNALS__.invoke`）。 */
export function hasShellBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function browserNotificationApi(): typeof Notification | undefined {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return undefined;
  }
  return window.Notification;
}

/** 当前环境能走哪条通道；`none` 时设置页把开关禁用掉。 */
export function systemNotificationChannel(): SystemNotificationChannel {
  if (hasShellBridge()) {
    return "shell";
  }
  return browserNotificationApi() ? "browser" : "none";
}

export function canUseSystemNotifications(): boolean {
  return systemNotificationChannel() !== "none";
}

/**
 * 窗口是否在前台且可见。
 *
 * 两个条件都要：`hasFocus()` 单独用会在窗口被最小化/隐藏时仍然为 true（Electron 与
 * 浏览器都如此），而 `visibilityState` 单独用分不出「窗口在后台但页面可见」的浏览器
 * 场景。没有 DOM（单测）时按「在前台」处理 —— 宁可少发，不要给测试发通知。
 */
export function isAppWindowFocused(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  if (document.visibilityState !== "visible") {
    return false;
  }
  return document.hasFocus();
}

function normalizeShellOutcome(value: unknown): SystemNotificationOutcome {
  if (value && typeof value === "object" && "delivered" in value) {
    const record = value as { delivered?: unknown; reason?: unknown };
    const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : undefined;
    return { delivered: record.delivered === true, reason };
  }
  return { delivered: false, reason: "invalid-response" };
}

/**
 * Web 端的权限请求。必须由用户手势触发（浏览器只认手势），所以设置页在开关被点开时
 * 调它；发送路径里不再二次请求，免得在窗口失焦时静默拿到 `default` 却以为被允许。
 */
export async function ensureSystemNotificationPermission(): Promise<boolean> {
  const channel = systemNotificationChannel();
  if (channel === "shell") {
    return true;
  }

  const api = browserNotificationApi();
  if (!api) {
    return false;
  }
  if (api.permission === "granted") {
    return true;
  }
  if (api.permission === "denied") {
    return false;
  }

  try {
    return (await api.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export interface SystemNotificationRequest {
  title: string;
  body: string;
}

export async function showSystemNotification({
  title,
  body,
}: SystemNotificationRequest): Promise<SystemNotificationOutcome> {
  const channel = systemNotificationChannel();

  if (channel === "shell") {
    try {
      return normalizeShellOutcome(await invoke(SHELL_COMMAND, { title, body }));
    } catch (error) {
      return { delivered: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  if (channel === "browser") {
    const api = browserNotificationApi();
    if (!api) {
      return { delivered: false, reason: "unsupported" };
    }
    if (api.permission !== "granted") {
      return { delivered: false, reason: api.permission === "denied" ? "denied" : "permission" };
    }

    try {
      new api(title, { body });
      return { delivered: true };
    } catch (error) {
      return { delivered: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  return { delivered: false, reason: "unsupported" };
}