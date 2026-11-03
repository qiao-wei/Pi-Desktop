/**
 * 内置浏览器：**URL 策略、webview 生命周期、宿主能力**这三层可以在没有 Electron 的情况下被钉住。
 *
 * 这是移植 ZCode 那套内置浏览器时唯二可以完整搬过来的部分（其余 1.1 万行是 Electron 主进程的
 * 标签驻留 / 截图面 / 视频录制 / Chrome 配置导入，和它的平台接口绑死）。搬的是**判据**：
 * 什么能打开、哪些异常是竞态、哪些退出可恢复、哪个宿主能画 —— 实现留在各自的壳里。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BLANK_BROWSER_URL,
  browserAddressLabel,
  isAllowedBrowserUrl,
  normalizeBrowserAddress,
} from "../src/shared/browserUrl.ts";
import {
  isRecoverableGuestExitReason,
  isWebviewDetachedError,
  safeWebviewCall,
} from "../src/features/browser/webviewLifecycle.ts";
import {
  HOST_CAPABILITIES,
  hostProfileSupportsCapability,
  normalizeHostCapabilities,
} from "../src/shared/protocol/hostCommands.ts";
import { getHostProfile, supportsHostCapability } from "../src/lib/shell/host.ts";
import { RIGHT_PANEL_TOOL_TABS } from "../src/features/workspace/rightPanelTabs.ts";

test("只有 http(s) 与空白页能进 guest：file / javascript / data 一律拒绝", () => {
  assert.equal(isAllowedBrowserUrl("https://example.com"), true);
  assert.equal(isAllowedBrowserUrl("http://localhost:3000/a?b=1"), true);
  assert.equal(isAllowedBrowserUrl(BLANK_BROWSER_URL), true);

  for (const bad of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "chrome://settings",
    "about:config",
    "",
    "   ",
  ]) {
    assert.equal(isAllowedBrowserUrl(bad), false, `${bad} 不该被允许`);
  }
});

test("地址栏输入：域名补 https，显式 scheme 不补，非法输入给出可区分的理由", () => {
  assert.deepEqual(normalizeBrowserAddress("example.com"), {
    ok: true,
    url: "https://example.com",
  });
  assert.deepEqual(normalizeBrowserAddress("  example.com/docs  "), {
    ok: true,
    url: "https://example.com/docs",
  });
  assert.deepEqual(normalizeBrowserAddress("localhost:5173"), {
    ok: true,
    url: "https://localhost:5173",
  });
  assert.deepEqual(normalizeBrowserAddress("http://example.com"), {
    ok: true,
    url: "http://example.com",
  });

  assert.deepEqual(normalizeBrowserAddress(""), { ok: false, reason: "empty" });
  assert.deepEqual(normalizeBrowserAddress("javascript:alert(1)"), {
    ok: false,
    reason: "unsupported_scheme",
  });
  assert.deepEqual(normalizeBrowserAddress("file:///etc/passwd"), {
    ok: false,
    reason: "unsupported_scheme",
  });
  assert.deepEqual(normalizeBrowserAddress("just some words"), { ok: false, reason: "not_a_url" });
});

test("地址栏显示不做校验：空页面显示成空，https 前缀去掉", () => {
  assert.equal(browserAddressLabel(BLANK_BROWSER_URL), "");
  assert.equal(browserAddressLabel("https://example.com/"), "example.com");
  assert.equal(browserAddressLabel("http://example.com/a"), "example.com/a");
});

test("webview 生命周期竞态被收敛，其它异常照常抛（吞掉一切比不吞更糟）", () => {
  assert.equal(isWebviewDetachedError(new Error("The WebView must be attached to the DOM")), true);
  assert.equal(
    isWebviewDetachedError("Render frame was disposed before WebView could be created"),
    true,
  );
  assert.equal(isWebviewDetachedError(new Error("boom")), false);
  assert.equal(isWebviewDetachedError(undefined), false);

  const seen: unknown[] = [];
  const value = safeWebviewCall(
    () => {
      throw new Error("must be attached to the DOM");
    },
    "fallback",
    (error) => seen.push(error),
  );
  assert.equal(value, "fallback");
  assert.equal(seen.length, 1, "收敛不等于静默：调用方要能拿到证据");

  assert.throws(
    () =>
      safeWebviewCall(() => {
        throw new Error("real bug");
      }, "fallback"),
    /real bug/,
  );
});

test("只有“页面被系统回收”类退出可原位重建，启动/完整性失败不行", () => {
  for (const reason of ["abnormal-exit", "killed", "crashed", "oom", "memory-eviction"]) {
    assert.equal(isRecoverableGuestExitReason(reason), true, reason);
  }
  for (const reason of ["launch-failed", "integrity-failure", "clean-exit", ""]) {
    assert.equal(isRecoverableGuestExitReason(reason), false, reason);
  }
});

test("能力默认是「没有」：声明缺失不能把功能打开（与命令表的缺省语义相反）", () => {
  assert.deepEqual(HOST_CAPABILITIES, ["embedded_browser"]);
  assert.deepEqual(normalizeHostCapabilities(undefined), []);
  assert.deepEqual(normalizeHostCapabilities([]), []);
  assert.deepEqual(normalizeHostCapabilities(["embedded_browser", "tray"]), ["embedded_browser"]);

  assert.equal(hostProfileSupportsCapability(null, "embedded_browser"), false);
  assert.equal(
    hostProfileSupportsCapability({ id: "x", commands: [], capabilities: [] }, "embedded_browser"),
    false,
  );
  assert.equal(
    hostProfileSupportsCapability(
      { id: "x", commands: [], capabilities: ["embedded_browser"] },
      "embedded_browser",
    ),
    true,
  );
});

test("壳可以通过 __PI_HOST_PROFILE__ 声明端 profile，渲染进程不嗅 Electron", async () => {
  const globals = globalThis as { window?: unknown };
  const original = globals.window;
  globals.window = {
    __TAURI_INTERNALS__: { invoke: async () => undefined },
    __PI_HOST_PROFILE__: { id: "electron", capabilities: ["embedded_browser"] },
  };
  try {
    assert.equal(getHostProfile()?.id, "electron");
    assert.equal(supportsHostCapability("embedded_browser"), true);
  } finally {
    globals.window = original;
  }
});

test("Tauri 壳（只有 __TAURI_INTERNALS__，没有 profile 声明）拿不到内置浏览器", () => {
  const globals = globalThis as { window?: unknown };
  const original = globals.window;
  globals.window = { __TAURI_INTERNALS__: { invoke: async () => undefined } };
  try {
    assert.equal(getHostProfile()?.id, "host");
    assert.equal(supportsHostCapability("embedded_browser"), false, "没声明就是没有，不能默认开");
  } finally {
    globals.window = original;
  }
});

test("浏览器 tab 进的是工具表（数据），不是按端分支的 if", () => {
  const ids = RIGHT_PANEL_TOOL_TABS.map((tool) => tool.id);
  assert.ok(ids.includes("browser"));
  const browser = RIGHT_PANEL_TOOL_TABS.find((tool) => tool.id === "browser");
  assert.ok(browser);
  // 三个 key 都必须存在，否则 tab 打开是一片空白（i18nKeyCoverage 只查 t() 调用，查不到这里）
  for (const key of [browser.labelKey, browser.hintKey, browser.descriptionKey]) {
    assert.match(key, /^(rightPanel\.)/);
  }
});
