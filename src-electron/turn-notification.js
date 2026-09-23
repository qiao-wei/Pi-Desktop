"use strict";

// Electron `Notification` 的结局收集器。刻意不依赖 electron：这里是纯事件逻辑，
// 单测用一个假 notification 就能覆盖「显示成功 / 失败 / 一直没动静」三条路径
// （tests/electronTurnNotification.test.ts）。
//
// 为什么需要它：`Notification.show()` 在 macOS（Electron 42 起改用 UNNotification）上
// 未签名时既不抛错也不显示，唯一线索是 'failed' 事件。宿主与 renderer 的契约是
// `{ delivered, reason }`，不能只报「调用过了」。

const DEFAULT_TITLE = "Pi Desktop";
/** 某些平台既不 emit show 也不 emit failed；超时后按未送达收尾，避免 handler 悬着。 */
const OUTCOME_TIMEOUT_MS = 2000;

function notificationPayload(args) {
  const title = String(args?.title ?? "").trim() || DEFAULT_TITLE;
  const body = String(args?.body ?? "").trim();
  return { title, body };
}

/**
 * 显示 `notification` 并等它的结局。
 *
 * @param {{ on: Function, show: Function, once?: Function }} notification
 * @returns {Promise<{ delivered: boolean, reason?: string }>}
 */
function deliverNotification(notification, { timeoutMs = OUTCOME_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (delivered, reason) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(reason ? { delivered, reason } : { delivered });
    };

    const timer = setTimeout(() => settle(false, "timeout"), timeoutMs);
    // electron 两种注册方式都有；`once` 是主路径，事件对象反正只发一次。
    const listen = typeof notification.once === "function" ? notification.once.bind(notification) : notification.on.bind(notification);
    listen("show", () => settle(true));
    listen("failed", (_event, error) => settle(false, String(error ?? "failed")));

    notification.show();
  });
}

module.exports = { DEFAULT_TITLE, OUTCOME_TIMEOUT_MS, notificationPayload, deliverNotification };