/**
 * Boundary `shell`: **能力是声明出来的，不是试出来的**。
 *
 * `hasHostShell()` 回答「有没有宿主」，`supportsHostCommand(id)` 回答「这个宿主能不能做这件事」。
 * 两个问题混在一起时，界面只能靠 try/catch 猜能力：没有文件夹选择器的宿主也会被画出选择器，
 * 发不出通知的宿主也会被切到 shell 通道。
 *
 * 下面的用例直接驱动真实调用点（`openTarget`、`systemNotificationChannel`），安装的只是宿主本身，
 * 所以它证明的是「能力声明真的会影响行为」，而不是「这里有个函数」。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getHostProfile,
  hasHostShell,
  invokeHost,
  setHostShell,
  supportsHostCommand,
} from "../src/lib/shell/host.ts";
import {
  HOST_COMMAND_IDS,
  hostProfileSupports,
  normalizeHostCommands,
  type HostCommandArgs,
  type HostCommandId,
  type HostShell,
} from "../src/shared/protocol/hostCommands.ts";
import { openTarget } from "../src/lib/open-target.ts";
import { hasShellBridge, systemNotificationChannel } from "../src/lib/systemNotification.ts";

interface Recorded {
  command: HostCommandId;
  args?: HostCommandArgs;
}

function host(options: { id?: string; commands?: readonly HostCommandId[] } = {}): HostShell & {
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.commands === undefined ? {} : { commands: options.commands }),
    async invoke<T>(command: HostCommandId, args?: HostCommandArgs) {
      calls.push({ command, args });
      return undefined as T;
    },
  };
}

/** Install `shell` for the duration of `fn`, then take it back out (`null` = no host). */
async function withHost<T>(shell: HostShell | null, fn: () => T | Promise<T>): Promise<T> {
  setHostShell(shell);
  try {
    return await fn();
  } finally {
    setHostShell(null);
  }
}

/** Run `fn` with a fake `window.open` so the non-host fallback path is observable in node. */
async function withWindowOpen<T>(fn: (opened: string[]) => T | Promise<T>): Promise<T> {
  const opened: string[] = [];
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    open: (target: string) => {
      opened.push(target);
      return null;
    },
  };
  try {
    return await fn(opened);
  } finally {
    (globalThis as { window?: unknown }).window = original;
  }
}

test("没有宿主：profile 为空，任何能力都是 false，调用给出的是「没有宿主」而不是「不支持」", async () => {
  await withHost(null, async () => {
    assert.equal(getHostProfile(), null);
    assert.equal(hasHostShell(), false);
    assert.equal(supportsHostCommand("open_target"), false);
    await assert.rejects(() => invokeHost("open_target", { target: "https://x" }), /no host shell installed/);
  });
});

test("宿主不声明命令集 = 实现整张表（现有 Tauri/Electron shim 的语义，向后兼容）", async () => {
  await withHost(host(), async () => {
    const profile = getHostProfile();
    assert.ok(profile);
    assert.equal(profile.id, "host", "没起名字的宿主用默认 id，且这个 id 只用于诊断");
    assert.deepEqual([...profile.commands].sort(), [...HOST_COMMAND_IDS].sort());
    for (const command of HOST_COMMAND_IDS) {
      assert.equal(supportsHostCommand(command), true, `${command} 应当可用`);
    }
  });
});

test("声明了窄命令集的宿主：只有声明过的算支持，未声明的在到达 transport 之前就被拒", async () => {
  const shell = host({ id: "web", commands: ["open_target"] });
  await withHost(shell, async () => {
    assert.equal(supportsHostCommand("open_target"), true);
    assert.equal(supportsHostCommand("choose_project_folder"), false);
    assert.equal(getHostProfile()?.id, "web");

    await assert.rejects(
      () => invokeHost("choose_project_folder", { defaultPath: "/tmp" }),
      /host "web" does not implement "choose_project_folder"/,
    );
    assert.deepEqual(shell.calls, [], "拒绝必须发生在 invoke() 之前，不能先打给宿主再报错");
  });
});

test("声明里带未知命令：过滤掉而不是让渲染进程启动就崩（新渲染进程 + 旧宿主）", async () => {
  assert.deepEqual(normalizeHostCommands(["open_target", "scan_fingerprint"]), ["open_target"]);
  assert.deepEqual(normalizeHostCommands([]), [], "显式声明空集就是「什么都不会」，不能退化成全部");
  assert.deepEqual(normalizeHostCommands(undefined), HOST_COMMAND_IDS);
});

test("能力判定是纯函数：宿主在不在不影响判据本身", () => {
  assert.equal(hostProfileSupports(null, "open_target"), false);
  assert.equal(hostProfileSupports({ id: "x", commands: ["open_target"] }, "open_target"), true);
  assert.equal(hostProfileSupports({ id: "x", commands: [] }, "open_target"), false);
});

test("真实调用点跟随能力：没有 open_target 的宿主不再被调用，回落 window.open", async () => {
  const shell = host({ id: "web", commands: [] });
  await withWindowOpen(async (opened) => {
    await withHost(shell, () => openTarget("https://example.com/docs"));
    assert.deepEqual(shell.calls, [], "能力不足时不该打给宿主");
    assert.deepEqual(opened, ["https://example.com/docs"], "应当回落到浏览器路径而不是抛错");
  });
});

test("真实调用点跟随能力：有 open_target 就走宿主，不再开浏览器窗口", async () => {
  const shell = host({ id: "tauri", commands: ["open_target"] });
  await withWindowOpen(async (opened) => {
    await withHost(shell, () => openTarget("/tmp/report.pdf"));
    assert.deepEqual(shell.calls, [{ command: "open_target", args: { target: "/tmp/report.pdf" } }]);
    assert.deepEqual(opened, []);
  });
});

test("通知通道按能力选：宿主能发通知才走 shell 通道", async () => {
  await withHost(host({ commands: ["notify_turn_complete"] }), () => {
    assert.equal(hasShellBridge(), true);
    assert.equal(systemNotificationChannel(), "shell");
  });

  await withHost(host({ commands: [] }), () => {
    assert.equal(hasShellBridge(), false, "有宿主但发不了通知，不能算 shell 通道");
    assert.notEqual(systemNotificationChannel(), "shell");
  });
});

test("setHostShell(undefined) 交还给默认实现，profile 不残留上一次的假宿主", () => {
  const fake = host({ id: "test", commands: ["open_target"] });
  setHostShell(fake);
  assert.equal(getHostProfile()?.id, "test");
  setHostShell(undefined);
  assert.notEqual(getHostProfile()?.id, "test");
  assert.equal(supportsHostCommand("open_target"), false, "node 里没有 window，默认就是没有宿主");
});