/**
 * Boundary `shell`: the host window is replaceable, and the real call sites go through the seam.
 *
 * The cases below install a recording fake host through `setHostShell()` and then drive the actual
 * shipped call sites - `syncShellAppearance`, `showSystemNotification`, `openTarget`, plus
 * `App.tsx`'s "is this a desktop runtime?" question (`hasHostShell`). Nothing in those modules is
 * edited or mocked: if someone goes back to calling `@tauri-apps/api/core` directly, or sniffs
 * `__TAURI_INTERNALS__` themselves, these cases stop seeing the commands.
 *
 * That is the difference between "there is an interface" and "the implementation is swappable".
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getHostShell,
  hasHostShell,
  invokeHost,
  invokeHostQuietly,
  setHostShell,
} from "../src/lib/shell/host.ts";
import type { HostCommandArgs, HostCommandId, HostShell } from "../src/shared/protocol/hostCommands.ts";
import { syncShellAppearance } from "../src/lib/shell-appearance.ts";
import { hasShellBridge, showSystemNotification } from "../src/lib/systemNotification.ts";
import { openTarget } from "../src/lib/open-target.ts";

interface Recorded {
  command: HostCommandId;
  args?: HostCommandArgs;
}

function recordingHost(outcomes: Record<string, unknown> = {}): HostShell & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    async invoke<T>(command: HostCommandId, args?: HostCommandArgs) {
      calls.push({ command, args });
      return outcomes[command] as T;
    },
  };
}

/** Install `host` for the duration of `fn`, then take it back out (`null` = no host). */
async function withHost<T>(host: HostShell | null, fn: () => Promise<T> | T): Promise<T> {
  setHostShell(host);
  try {
    return await fn();
  } finally {
    setHostShell(null);
  }
}

test("装上的宿主可以被读到，并且「有没有宿主」由协议回答（不再嗅 globals）", async () => {
  const host = recordingHost();
  await withHost(host, () => {
    assert.equal(getHostShell(), host);
    assert.equal(hasHostShell(), true);
    assert.equal(hasShellBridge(), true, "systemNotification 的判定必须跟着端口走");
  });
  assert.equal(hasHostShell(), false, "卸掉宿主后（node 里没有 window）就是没有宿主");
  assert.equal(hasShellBridge(), false);
});

test("窗口明暗同步打给装上的宿主（真实调用点，不是 mock）", async () => {
  const host = recordingHost();
  await withHost(host, () => {
    syncShellAppearance("dark");
  });
  // invokeHostQuietly 是 fire-and-forget，等一个微任务队列轮转。
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.calls, [{ command: "set_window_appearance", args: { appearance: "dark" } }]);
});

test("系统通知走宿主命令并解析回执（同样是真实调用点）", async () => {
  const host = recordingHost({ notify_turn_complete: "shown" });
  const outcome = await withHost(host, () => showSystemNotification({ title: "t", body: "b" }));
  assert.deepEqual(host.calls, [{ command: "notify_turn_complete", args: { title: "t", body: "b" } }]);
  assert.equal(typeof outcome, "object", "回执必须被规范化成对象");
});

test("宿主实现抛错时，渲染层拿到失败回执而不是异常", async () => {
  const host: HostShell = {
    async invoke() {
      throw new Error("host exploded");
    },
  };
  const outcome = await withHost(host, () => showSystemNotification({ title: "t", body: "b" }));
  assert.equal((outcome as { delivered?: boolean }).delivered, false);
  assert.match(String((outcome as { reason?: string }).reason), /host exploded/);
});

test("没有宿主时 invokeHost 给出明确错误（不是 Tauri 内部的 undefined 崩溃）", async () => {
  await withHost(null, async () => {
    await assert.rejects(() => invokeHost("open_target", { target: "https://x" }), /no host shell installed/);
  });
});

test("没有宿主时 invokeHostQuietly 不抛（窗口 chrome 的失败不该打断 UI）", async () => {
  await withHost(null, () => {
    invokeHostQuietly("set_window_appearance", { appearance: "light" });
  });
});

test("没有宿主时 openTarget 回落到 window.open（桌面路径之外的行为不变）", async () => {
  const opened: string[] = [];
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    open: (target: string) => {
      opened.push(target);
      return null;
    },
  };
  try {
    await withHost(null, () => openTarget("https://example.com/docs"));
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
  assert.deepEqual(opened, ["https://example.com/docs"]);
});

test("有宿主时 openTarget 打给宿主而不是 window.open", async () => {
  const host = recordingHost();
  const opened: string[] = [];
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { open: (target: string) => void opened.push(target) };
  try {
    await withHost(host, () => openTarget("/tmp/report.pdf"));
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
  assert.deepEqual(host.calls, [{ command: "open_target", args: { target: "/tmp/report.pdf" } }]);
  assert.deepEqual(opened, [], "装了宿主就不该再走 window.open");
});

test("setHostShell(undefined) 回到默认实现（不残留上一次的假宿主）", () => {
  const fake = recordingHost();
  setHostShell(fake);
  assert.equal(getHostShell(), fake);
  setHostShell(undefined);
  assert.notEqual(getHostShell(), fake);
});