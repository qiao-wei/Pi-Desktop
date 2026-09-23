/**
 * 「任务完成后系统提醒」的决策口径。
 *
 * 这几条是产品行为，不是实现细节：只在窗口不在前台时提醒（用户正看着屏幕时弹横幅纯属
 * 噪音）、用户自己按停止不算完成（由 usePiDesktopApp 的 generation 拦，这里只钉住
 * 决策函数的输入输出）、正文里的会话名找不到时不能留下孤立的分隔符。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  composeTurnNotificationBody,
  resolveTurnNotificationLabel,
  shouldNotifyTurnSettled,
} from "../src/shared/turnNotifications.ts";

test("只有开关打开且窗口不在前台时才提醒", () => {
  assert.equal(shouldNotifyTurnSettled({ enabled: true, windowFocused: false }), true);
  // 用户就在看这个窗口：不需要系统横幅。
  assert.equal(shouldNotifyTurnSettled({ enabled: true, windowFocused: true }), false);
  // 默认关闭（ui-preferences 里缺省），所以后台跑完也不该弹。
  assert.equal(shouldNotifyTurnSettled({ enabled: false, windowFocused: false }), false);
  assert.equal(shouldNotifyTurnSettled({ enabled: false, windowFocused: true }), false);
});

test("会话名优先取当前会话，其次在同项目会话摘要里按路径找", () => {
  assert.equal(
    resolveTurnNotificationLabel({
      sessionPath: "/sessions/a.jsonl",
      conversation: { title: "重构认证", sessionFile: "/sessions/a.jsonl" },
      sessions: [{ path: "/sessions/a.jsonl", title: "摘要里的旧标题" }],
    }),
    "重构认证",
  );

  // 后台会话：当前会话快照不是它，只能靠摘要列表。
  assert.equal(
    resolveTurnNotificationLabel({
      sessionPath: "/sessions/b.jsonl",
      conversation: { title: "重构认证", sessionFile: "/sessions/a.jsonl" },
      sessions: [
        { path: "/sessions/a.jsonl", title: "重构认证" },
        { path: "/sessions/b.jsonl", title: "回归测试" },
      ],
    }),
    "回归测试",
  );

  // 摘要只有 name（无标题的会话）时退到 name。
  assert.equal(
    resolveTurnNotificationLabel({
      sessionPath: "/sessions/c.jsonl",
      sessions: [{ path: "/sessions/c.jsonl", title: "   ", name: "临时窗口" }],
    }),
    "临时窗口",
  );
});

test("找不到会话名时返回 undefined，由调用方退回落文案", () => {
  assert.equal(resolveTurnNotificationLabel({ sessionPath: undefined }), undefined);
  assert.equal(resolveTurnNotificationLabel({ sessionPath: "/sessions/x.jsonl" }), undefined);
  assert.equal(
    resolveTurnNotificationLabel({
      sessionPath: "/sessions/x.jsonl",
      conversation: { title: "别的会话", sessionFile: "/sessions/a.jsonl" },
      sessions: [{ path: "/sessions/other.jsonl", title: "也不是它" }],
    }),
    undefined,
  );
  // 标题只有空白 = 没有标题；否则提醒里会出现 " · 已完成本轮任务。" 这种孤零零的分隔符。
  assert.equal(
    resolveTurnNotificationLabel({
      sessionPath: "/sessions/a.jsonl",
      conversation: { title: "   ", sessionFile: "/sessions/a.jsonl" },
    }),
    undefined,
  );
});

test("正文 = 会话名 · 落文案；没有会话名时只剩落文案", () => {
  assert.equal(composeTurnNotificationBody("重构认证", "已完成本轮任务。"), "重构认证 · 已完成本轮任务。");
  assert.equal(composeTurnNotificationBody(undefined, "已完成本轮任务。"), "已完成本轮任务。");
  assert.equal(composeTurnNotificationBody("   ", "已完成本轮任务。"), "已完成本轮任务。");
});

test("开关写进 ui-preferences 并能读回来", async () => {
  const store = new Map<string, string>();
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  };

  try {
    const { loadUiPreferences, saveUiPreferences } = await import("../src/lib/ui-preferences.ts");
    // 缺省 = 关闭：系统通知是打断性的，必须由用户自己打开。
    assert.equal(loadUiPreferences().notifyOnTurnComplete, undefined);
    assert.notEqual(loadUiPreferences().notifyOnTurnComplete, true);

    saveUiPreferences({ notifyOnTurnComplete: true });
    assert.equal(loadUiPreferences().notifyOnTurnComplete, true);
    // 不能把别的偏好抹掉：saveUiPreferences 一直是「读回 + 覆盖」。
    assert.equal(typeof loadUiPreferences().theme, "string");

    saveUiPreferences({ notifyOnTurnComplete: false });
    assert.equal(loadUiPreferences().notifyOnTurnComplete, false);
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  }
});