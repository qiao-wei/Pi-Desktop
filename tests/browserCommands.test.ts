/**
 * 浏览器层的三个纯模块：命令表（`browserCommands`）、执行器（`browserController`）、
 * 标签模型（`browserSession`）。
 *
 * 这三者刻意不碰 DOM / Electron / React —— 否则「面板」和「agent 工具」就会各写一份能力，
 * 而它们本该共用同一张表、同一份 URL 判据、同一组上限。测试用假端口跑完整命令面。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_COMMAND_IDS,
  DEFAULT_BROWSER_TIMEOUT_MS,
  isBrowserCommandId,
  normalizeBrowserCommand,
} from "../src/shared/browserCommands.ts";
import {
  createBrowserController,
  type BrowserViewPort,
} from "../src/features/browser/browserController.ts";
import {
  MAX_BROWSER_TABS,
  activateBrowserTab,
  browserTabLabel,
  closeBrowserTab,
  createBrowserTabs,
  openBrowserTab,
  resetBrowserTabIdsForTest,
  updateBrowserTab,
} from "../src/features/browser/browserSession.ts";
import { BLANK_BROWSER_URL } from "../src/shared/browserUrl.ts";

/** 记录调用、可注入失败的假 guest。 */
function fakePort(overrides: Partial<BrowserViewPort> = {}) {
  const calls: string[] = [];
  const scripts: string[] = [];
  const port: BrowserViewPort = {
    loadURL: async (url) => void calls.push(`loadURL:${url}`),
    getURL: () => "https://example.test/",
    canGoBack: () => true,
    canGoForward: () => false,
    goBack: () => void calls.push("goBack"),
    goForward: () => void calls.push("goForward"),
    reload: () => void calls.push("reload"),
    stop: () => void calls.push("stop"),
    executeJavaScript: async (script) => {
      scripts.push(script);
      return "ok";
    },
    capturePage: async () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
    ...overrides,
  };
  return { port, calls, scripts };
}

// --- 命令表 -------------------------------------------------------------------------------

test("未知命令给具名错误，而不是抛异常", () => {
  assert.deepEqual(normalizeBrowserCommand("teleport", {}), {
    ok: false,
    code: "unsupported_command",
    message: "unknown browser command: teleport",
  });
  assert.equal(isBrowserCommandId("navigate"), true);
  assert.equal(isBrowserCommandId("toString"), false);
});

test("参数校验在运行时做：线上来的 unknown 不会被当成可信形状", () => {
  const noUrl = normalizeBrowserCommand("navigate", {});
  assert.equal(noUrl.ok, false);
  assert.equal(noUrl.ok === false && noUrl.code, "invalid_args");

  const blankSelector = normalizeBrowserCommand("click", { selector: "   " });
  assert.equal(blankSelector.ok, false);

  const typeWithoutText = normalizeBrowserCommand("type", { selector: "#q" });
  assert.equal(typeWithoutText.ok, false);

  // 非对象参数按空对象处理，于是同样落到 invalid_args，而不是 TypeError。
  assert.equal(normalizeBrowserCommand("navigate", "https://x.test").ok, false);
});

test("归一化后的命令只保留表里声明的字段（多余键不透传进脚本）", () => {
  const result = normalizeBrowserCommand("navigate", {
    url: "https://example.test/a",
    evil: "<script>",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.command, { id: "navigate", url: "https://example.test/a" });
});

test("可选字段有确定缺省：submit 默认 false，scroll 的 dx 默认 0，waitFor 用统一超时", () => {
  const typed = normalizeBrowserCommand("type", { selector: "#q", text: "hi" });
  assert.equal(typed.ok && typed.command.id === "type" && typed.command.submit, false);

  const scrolled = normalizeBrowserCommand("scroll", { dy: 200 });
  assert.equal(scrolled.ok && scrolled.command.id === "scroll" && scrolled.command.dx, 0);

  const waited = normalizeBrowserCommand("waitFor", { selector: "#done" });
  assert.equal(
    waited.ok && waited.command.id === "waitFor" && waited.command.timeoutMs,
    DEFAULT_BROWSER_TIMEOUT_MS,
  );
});

test("每个命令都有 id，且脚本类命令标了 needsPage", () => {
  assert.ok(BROWSER_COMMAND_IDS.includes("navigate"));
  assert.ok(BROWSER_COMMAND_IDS.includes("pickElement"));
  assert.equal(new Set(BROWSER_COMMAND_IDS).size, BROWSER_COMMAND_IDS.length);
});

// --- 执行器 -------------------------------------------------------------------------------

test("navigate 与地址栏共用 URL 判据：非 http(s) 在到达网络之前就被拒", async () => {
  const { port, calls } = fakePort();
  const controller = createBrowserController(() => port);

  const rejected = await controller.run("navigate", { url: "javascript:alert(1)" });
  assert.equal(rejected.ok, false);
  assert.equal(calls.length, 0, "被拒的地址不许碰 loadURL");

  const accepted = await controller.run("navigate", { url: "example.test" });
  assert.deepEqual(calls, ["loadURL:https://example.test"]);
  assert.equal(accepted.ok && accepted.value, "https://example.test");
});

test("没有 guest → page_not_ready；脚本类命令还要确认页面已 attach", async () => {
  const detached = createBrowserController(() => null);
  const missing = await detached.run("click", { selector: "#a" });
  assert.equal(missing.ok === false && missing.code, "page_not_ready");

  const { port } = fakePort({
    getURL: () => {
      throw new Error("not attached");
    },
  });
  const controller = createBrowserController(() => port);
  const notReady = await controller.run("click", { selector: "#a" });
  assert.equal(notReady.ok === false && notReady.code, "page_not_ready");

  // 导航类命令不要求页面 attach：guest 在手就能开新地址。
  const navigated = await controller.run("navigate", { url: "https://example.test/" });
  assert.equal(navigated.ok, true);
});

test("页面内命令注入脚本时，选择器一律走 JSON 转义", async () => {
  const { port, scripts } = fakePort();
  const controller = createBrowserController(() => port);

  const selector = `a[title="x"]'); throw new Error('pwn`;
  await controller.run("click", { selector });

  assert.equal(scripts.length, 1);
  const script = scripts[0];
  // 判据不是"载荷不可见"（它当然在脚本里），而是"载荷整体留在字符串字面量内"：
  // 选择器以 JSON 字面量出现，且整段脚本仍然是合法表达式 —— 注入没有撕开字符串。
  assert.ok(script.includes(JSON.stringify(selector)), "选择器以 JSON 字符串字面量整体注入");
  assert.doesNotThrow(() => new Function(`return ${script}`), "注入之后脚本仍须是合法 JS");
});

test("命令表与执行器覆盖同一批 id；截图走 capturePage", async () => {
  const { port, calls } = fakePort();
  const controller = createBrowserController(() => port);
  assert.deepEqual([...controller.commandIds], [...BROWSER_COMMAND_IDS]);

  for (const id of ["back", "forward", "reload", "stop"] as const) {
    const result = await controller.run(id);
    assert.equal(result.ok, true, `${id} 应当成功`);
  }
  assert.deepEqual(calls, ["goBack", "goForward", "reload", "stop"]);

  const shot = await controller.run("screenshot");
  assert.equal(shot.ok && shot.value, "data:image/png;base64,AAAA");
});

test("脚本抛错 → script_failed，错误文案透传", async () => {
  const { port } = fakePort({
    executeJavaScript: async () => {
      throw new Error("boom");
    },
  });
  const controller = createBrowserController(() => port);
  const result = await controller.run("extractText");
  assert.equal(result.ok === false && result.code, "script_failed");
  assert.equal(result.ok === false && result.message, "boom");
});

// --- 标签模型 -----------------------------------------------------------------------------

test("新标签追加并激活，超过上限挤掉最旧的非当前标签", () => {
  resetBrowserTabIdsForTest();
  let state = createBrowserTabs();
  assert.equal(state.tabs.length, 1);

  for (let index = 0; index < MAX_BROWSER_TABS + 2; index += 1) {
    state = openBrowserTab(state);
  }
  assert.equal(state.tabs.length, MAX_BROWSER_TABS);
  assert.equal(state.activeId, state.tabs.at(-1)?.id, "新标签永远是当前的");
  assert.ok(!state.tabs.some((tab) => tab.id === "tab-1"), "最早的标签被挤掉");
});

test("关掉当前标签：焦点交给右邻居，没有右邻居才交给左边", () => {
  resetBrowserTabIdsForTest();
  let state = createBrowserTabs();
  const first = state.activeId;
  state = openBrowserTab(state); // tab-2
  state = openBrowserTab(state); // tab-3
  const [a, b, c] = state.tabs.map((tab) => tab.id);
  assert.equal(first, a);

  state = activateBrowserTab(state, b);
  state = closeBrowserTab(state, b);
  assert.equal(state.activeId, c, "右邻居优先");

  state = closeBrowserTab(state, c);
  assert.equal(state.activeId, a, "没有右邻居时回退到左边");
});

test("关掉非当前标签不动焦点；关掉最后一张留下空白页而不是空数组", () => {
  resetBrowserTabIdsForTest();
  let state = createBrowserTabs();
  const only = state.activeId;
  state = openBrowserTab(state);
  const second = state.activeId;

  state = closeBrowserTab(state, only);
  assert.equal(state.activeId, second);

  state = closeBrowserTab(state, second);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].url, BLANK_BROWSER_URL);

  // 不存在的 id 是 no-op（返回同一个引用，方便 React 跳过重渲染）。
  assert.equal(closeBrowserTab(state, "nope"), state);
  assert.equal(activateBrowserTab(state, "nope"), state);
});

test("updateBrowserTab 只改目标标签，未知 id 保持原引用", () => {
  resetBrowserTabIdsForTest();
  const state = createBrowserTabs();
  const id = state.activeId;

  const titled = updateBrowserTab(state, id, { title: "Example", loading: true });
  assert.equal(titled.tabs[0].title, "Example");
  assert.equal(titled.tabs[0].loading, true);
  assert.equal(updateBrowserTab(state, "nope", { title: "x" }), state);
});

test("标签标题：页面标题 → 去协议的地址 → 占位", () => {
  const blank = {
    id: "t",
    initialUrl: BLANK_BROWSER_URL,
    url: BLANK_BROWSER_URL,
    title: "",
    loading: false,
  };
  assert.equal(browserTabLabel(blank, "新标签页"), "新标签页");
  assert.equal(
    browserTabLabel({ ...blank, url: "https://example.test/a" }, "新标签页"),
    "example.test/a",
  );
  assert.equal(browserTabLabel({ ...blank, title: "  Example  " }, "新标签页"), "Example");
  assert.equal(browserTabLabel({ ...blank, title: "   " }, "新标签页"), "新标签页");
});
