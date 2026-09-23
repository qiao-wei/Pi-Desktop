/**
 * Electron 宿主侧的「任务完成提醒」。
 *
 * 纯事件逻辑（不发真通知）单独拆在 src-electron/turn-notification.js 里就是为了能这样测：
 * 成败只有 `show` / `failed` 两个事件说得清，而 macOS 上未签名的开发版是**只发 failed
 * 或不发任何事件**的那种失败。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { DEFAULT_TITLE, deliverNotification, notificationPayload } = await import(
  "../src-electron/turn-notification.js"
);

/** 一个最小的假 Electron Notification：监听器 + 可编程的 show() 行为。 */
function fakeNotification(onShow?: (emit: (event: string, ...args: unknown[]) => void) => void) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    once(event: string, handler: (...args: unknown[]) => void) {
      listeners.set(event, handler);
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      listeners.set(event, handler);
    },
    show() {
      onShow?.((event, ...args) => listeners.get(event)?.(...args));
    },
  };
}

test("通知载荷：标题为空退回落款名，正文两端去空白", () => {
  assert.deepEqual(notificationPayload({ title: "  任务完成  ", body: "  会话 · 已完成。 " }), {
    title: "任务完成",
    body: "会话 · 已完成。",
  });
  assert.deepEqual(notificationPayload({ title: "   ", body: "正文" }), { title: DEFAULT_TITLE, body: "正文" });
  assert.deepEqual(notificationPayload({}), { title: DEFAULT_TITLE, body: "" });
  assert.deepEqual(notificationPayload(undefined), { title: DEFAULT_TITLE, body: "" });
});

test("显示成功：resolve delivered=true", async () => {
  const outcome = await deliverNotification(fakeNotification((emit) => emit("show")));
  assert.deepEqual(outcome, { delivered: true });
});

test("显示失败：把 electron 的错误带进 reason（macOS 未签名开发版走的就是这条）", async () => {
  const outcome = await deliverNotification(
    fakeNotification((emit) => emit("failed", {}, "Notifications are not allowed for this application")),
  );
  assert.deepEqual(outcome, {
    delivered: false,
    reason: "Notifications are not allowed for this application",
  });
});

test("failed 没带错误对象时也不能回 delivered=true", async () => {
  const outcome = await deliverNotification(fakeNotification((emit) => emit("failed")));
  assert.deepEqual(outcome, { delivered: false, reason: "failed" });
});

test("两个事件都没来（部分平台如此）时靠超时收尾，不让 handler 悬着", async () => {
  const outcome = await deliverNotification(fakeNotification(() => undefined), { timeoutMs: 20 });
  assert.deepEqual(outcome, { delivered: false, reason: "timeout" });
});

test("先到的事件说了算：后来的 failed 不能把已显示的成功翻掉", async () => {
  const outcome = await deliverNotification(
    fakeNotification((emit) => {
      emit("show");
      emit("failed", {}, "late failure");
    }),
  );
  assert.deepEqual(outcome, { delivered: true });
});