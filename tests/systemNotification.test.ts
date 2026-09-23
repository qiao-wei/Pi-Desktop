/**
 * 系统通知发送端：通道选择、窗口焦点判定、以及「送达/未送达」的契约。
 *
 * 重点是最后一条：macOS（Electron 42 起用 UNNotification）上未签名的开发版调用通知 API
 * 只会**静默失败**，所以这条链路不能是 fire-and-forget —— 宿主必须回 `{ delivered, reason }`，
 * 否则「以为发了」和「发了」在日志里长得一模一样。这里把三个宿主的回复口径钉住。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  TURN_NOTIFICATION_COMMAND,
  canUseSystemNotifications,
  ensureSystemNotificationPermission,
  isAppWindowFocused,
  showSystemNotification,
  systemNotificationChannel,
} from "../src/lib/systemNotification.ts";

type AnyRecord = Record<string, unknown>;

function stubGlobals(values: { window?: unknown; document?: unknown }): () => void {
  const scope = globalThis as AnyRecord;
  const previous = { window: scope.window, document: scope.document };
  if ("window" in values) {
    scope.window = values.window;
  }
  if ("document" in values) {
    scope.document = values.document;
  }

  return () => {
    for (const key of ["window", "document"] as const) {
      if (previous[key] === undefined) {
        delete scope[key];
      } else {
        scope[key] = previous[key];
      }
    }
  };
}

/** 一个假的浏览器 `Notification` 类，记录构造参数。 */
function fakeNotificationApi(permission: NotificationPermission, requestResult?: NotificationPermission) {
  const created: Array<{ title: string; body?: string }> = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = async () => {
      FakeNotification.permission = requestResult ?? permission;
      return FakeNotification.permission;
    };
    constructor(title: string, options?: { body?: string }) {
      created.push({ title, body: options?.body });
    }
  }
  return { api: FakeNotification, created };
}

test("宿主在场时走 invoke，并把宿主的送达结果原样带回来", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const restore = stubGlobals({
    window: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: unknown) => {
          calls.push({ command, args });
          return { delivered: true };
        },
      },
    },
  });

  try {
    assert.equal(systemNotificationChannel(), "shell");
    const outcome = await showSystemNotification({ title: "任务完成", body: "会话 · 已完成。" });
    assert.deepEqual(outcome, { delivered: true, reason: undefined });
    assert.deepEqual(calls, [{ command: TURN_NOTIFICATION_COMMAND, args: { title: "任务完成", body: "会话 · 已完成。" } }]);
  } finally {
    restore();
  }
});

test("宿主报未送达时保留原因（区分 unsupported / not-bundled / 超时）", async () => {
  const restore = stubGlobals({
    window: {
      __TAURI_INTERNALS__: {
        invoke: async () => ({ delivered: false, reason: "not-bundled" }),
      },
    },
  });

  try {
    assert.deepEqual(await showSystemNotification({ title: "t", body: "b" }), {
      delivered: false,
      reason: "not-bundled",
    });
  } finally {
    restore();
  }
});

test("宿主抛错或回了个看不懂的东西时，也算未送达（而不是当成成功）", async () => {
  const throwing = stubGlobals({
    window: {
      __TAURI_INTERNALS__: {
        invoke: async () => {
          throw new Error("Notifications are not allowed for this application");
        },
      },
    },
  });
  try {
    const outcome = await showSystemNotification({ title: "t", body: "b" });
    assert.equal(outcome.delivered, false);
    assert.match(String(outcome.reason), /not allowed/);
  } finally {
    throwing();
  }

  const malformed = stubGlobals({
    window: { __TAURI_INTERNALS__: { invoke: async () => undefined } },
  });
  try {
    assert.deepEqual(await showSystemNotification({ title: "t", body: "b" }), {
      delivered: false,
      reason: "invalid-response",
    });
  } finally {
    malformed();
  }
});

test("Web 端退到浏览器 Notification：权限给全才发，否则报原因", async () => {
  const granted = fakeNotificationApi("granted");
  const restoreGranted = stubGlobals({ window: { Notification: granted.api } });
  try {
    assert.equal(systemNotificationChannel(), "browser");
    assert.deepEqual(await showSystemNotification({ title: "任务完成", body: "已完成。" }), { delivered: true });
    assert.deepEqual(granted.created, [{ title: "任务完成", body: "已完成。" }]);
  } finally {
    restoreGranted();
  }

  const denied = fakeNotificationApi("denied");
  const restoreDenied = stubGlobals({ window: { Notification: denied.api } });
  try {
    assert.deepEqual(await showSystemNotification({ title: "t", body: "b" }), {
      delivered: false,
      reason: "denied",
    });
    assert.equal(denied.created.length, 0, "被拒绝时不该构造通知");
  } finally {
    restoreDenied();
  }

  const prompt = fakeNotificationApi("default");
  const restorePrompt = stubGlobals({ window: { Notification: prompt.api } });
  try {
    assert.deepEqual(await showSystemNotification({ title: "t", body: "b" }), {
      delivered: false,
      reason: "permission",
    });
  } finally {
    restorePrompt();
  }
});

test("浏览器权限请求只在设置页的用户手势里发生（发送路径不请求）", async () => {
  const pending = fakeNotificationApi("default", "granted");
  const restore = stubGlobals({ window: { Notification: pending.api } });
  try {
    assert.equal(await ensureSystemNotificationPermission(), true);
    assert.equal(await ensureSystemNotificationPermission(), true, "已经 granted 就不该再次请求");
  } finally {
    restore();
  }

  const denied = fakeNotificationApi("denied");
  const restoreDenied = stubGlobals({ window: { Notification: denied.api } });
  try {
    assert.equal(await ensureSystemNotificationPermission(), false);
  } finally {
    restoreDenied();
  }
});

test("没有 window / 没有 Notification 的环境 = 没有可用通道", () => {
  const restore = stubGlobals({ window: undefined, document: undefined });
  try {
    assert.equal(systemNotificationChannel(), "none");
    assert.equal(canUseSystemNotifications(), false);
  } finally {
    restore();
  }

  const restorePlain = stubGlobals({ window: {} });
  try {
    assert.equal(systemNotificationChannel(), "none");
    assert.equal(canUseSystemNotifications(), false);
  } finally {
    restorePlain();
  }
});

test("窗口焦点判定：隐藏或不聚焦都不算前台；没有 DOM 时按前台处理（宁可少发）", () => {
  const hidden = stubGlobals({ document: { visibilityState: "hidden", hasFocus: () => true } });
  try {
    assert.equal(isAppWindowFocused(), false);
  } finally {
    hidden();
  }

  const blurred = stubGlobals({ document: { visibilityState: "visible", hasFocus: () => false } });
  try {
    assert.equal(isAppWindowFocused(), false);
  } finally {
    blurred();
  }

  const focused = stubGlobals({ document: { visibilityState: "visible", hasFocus: () => true } });
  try {
    assert.equal(isAppWindowFocused(), true);
  } finally {
    focused();
  }

  const noDom = stubGlobals({ document: undefined });
  try {
    assert.equal(isAppWindowFocused(), true);
  } finally {
    noDom();
  }
});

test("三个宿主实现的是同一个命令名（renderer 只认这一个）", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (relative: string) =>
    readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

  const preload = read("src-electron/preload.js");
  const hostCommands = read("src-electron/host-commands.js");
  const tauriLib = read("src-tauri/src/lib.rs");

  assert.ok(
    preload.includes(`"${TURN_NOTIFICATION_COMMAND}"`),
    "preload 的 HOST_COMMANDS 白名单少了这个命令：renderer 会拿到 Unsupported host command",
  );
  assert.ok(
    hostCommands.includes(`ipcMain.handle("${TURN_NOTIFICATION_COMMAND}"`),
    "Electron 侧没有对应 handler",
  );
  assert.match(tauriLib, new RegExp(`fn ${TURN_NOTIFICATION_COMMAND}\\(`), "Tauri 侧没有这个命令");
  assert.ok(
    tauriLib.slice(tauriLib.indexOf("generate_handler!")).includes(TURN_NOTIFICATION_COMMAND),
    "Tauri 命令没注册进 generate_handler!：前端调用会直接失败",
  );
  assert.ok(
    /\.plugin\(tauri_plugin_notification::init\(\)\)/.test(tauriLib),
    "没注册通知插件",
  );
});