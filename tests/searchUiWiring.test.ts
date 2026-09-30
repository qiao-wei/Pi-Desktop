/**
 * 搜索功能的接线回归：纯逻辑在 `sessionSearch.test.ts` / `chatJumpBus.test.ts`，
 * 这里只钉住「两端真的接上了」这件事。
 *
 * 这类断言不能替代行为测试，但它能挡住「组件写好了却没渲染 / 请求没带 query」这种
 * 单测看不见、只有手点才发现的问题。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const chatThreadSource = readFileSync(
  new URL("../src/features/chat/ChatThread.tsx", import.meta.url),
  "utf8",
);
const threadSearchSource = readFileSync(
  new URL("../src/features/chat/useThreadSearch.ts", import.meta.url),
  "utf8",
);
const dialogSource = readFileSync(
  new URL("../src/features/search/GlobalSearchDialog.tsx", import.meta.url),
  "utf8",
);
const barSource = readFileSync(
  new URL("../src/features/search/InTaskSearchBar.tsx", import.meta.url),
  "utf8",
);
const globalSearchSource = readFileSync(
  new URL("../src/features/search/globalSearch.ts", import.meta.url),
  "utf8",
);
const imeSource = readFileSync(
  new URL("../src/features/search/useImeSafeInput.ts", import.meta.url),
  "utf8",
);
const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const codexThemeSource = readFileSync(
  new URL("../src/themes/codex/theme.css", import.meta.url),
  "utf8",
);

test("标题栏：搜索按钮挂在侧栏开关右边，点击打开全局搜索", () => {
  const leftGroup = appSource.slice(
    appSource.indexOf('<div ref={leftClusterRef} className="flex min-w-0 items-center gap-2'),
  );
  const panelLeft = leftGroup.indexOf("<PanelLeft />");
  const search = leftGroup.indexOf("<Search />", panelLeft);
  assert.ok(panelLeft >= 0, "找不到侧栏开关");
  assert.ok(search > panelLeft, "搜索 icon 必须排在侧栏开关后面（右边）");
  assert.match(appSource, /onOpenSearch=\{\(\) => setGlobalSearchOpen\(true\)\}/);
  assert.match(leftGroup, /label=\{t\("titlebar\.search"\)\}/);
});

test("标题栏左格把真实右边界公开成 CSS 变量（codex 会话头靠它让位）", () => {
  // 主题里写死的「10px + 28px」常量加一个按钮就会失灵（实测：搜索按钮压住项目名），
  // 所以左格宽度必须由 App 量出来。
  assert.match(appSource, /leftClusterRef/);
  assert.match(appSource, /--titlebar-left-cluster-right/);
  assert.match(appSource, /new ResizeObserver\(publish\)/);
  assert.match(appSource, /getBoundingClientRect\(\)\.right/);
  assert.match(codexThemeSource, /var\(--titlebar-left-cluster-right,\s*\d+px\)/);
});

test("App：⌘K / ⌘F 快捷键与两个搜索状态都接上了", () => {
  assert.match(appSource, /key === "k"/);
  assert.match(appSource, /key === "f"/);
  assert.match(appSource, /setGlobalSearchOpen\(\(open\) => !open\)/);
  assert.match(appSource, /openInTaskSearch\(\)/);
  // ⌘F 必须走捕获阶段并 preventDefault，否则浏览器原生「查找」会先开。
  assert.match(appSource, /addEventListener\("keydown", handleSearchShortcut, true\)/);
  assert.match(appSource, /event\.preventDefault\(\)/);
});

test("App：全局搜索结果点击会切会话并发起跳转请求", () => {
  assert.match(appSource, /<GlobalSearchDialog/);
  assert.match(appSource, /onSelect=\{\(result\) => void handleGlobalSearchSelect\(result\)\}/);
  assert.match(appSource, /await selectSession\(result\.projectId, result\.sessionPath\)/);
  assert.match(appSource, /chatJumpBus\.request\(result\.sessionPath, result\.messageId, "global-search"\)/);
});

test("App：会话内搜索小条浮在线程区上，并把查询传给 ChatThread", () => {
  assert.match(appSource, /<InTaskSearchBar/);
  assert.match(appSource, /className="conversation-thread-area relative flex min-h-0 flex-1 flex-col"/);
  assert.match(appSource, /searchQuery=\{inTaskSearch\.open \? inTaskSearch\.query : ""\}/);
  assert.match(appSource, /searchActiveIndex=\{inTaskSearch\.activeIndex\}/);
  assert.match(appSource, /onSearchCountChange=\{handleInTaskSearchCount\}/);
});

test("ChatThread：搜索 props 交给 useThreadSearch，视口 owner 提交 revealRange", () => {
  assert.match(chatThreadSource, /searchQuery\?: string/);
  assert.match(chatThreadSource, /useThreadSearch\(\{/);
  assert.match(chatThreadSource, /controllerRef\.current = \{ revealRange \}/);
});

test("useThreadSearch：用 CSS Custom Highlight API 画高亮，不往 React DOM 里插 mark", () => {
  assert.match(threadSearchSource, /\.highlights/);
  assert.match(threadSearchSource, /new Highlight\(/);
  assert.match(threadSearchSource, /findSequenceMatches\(/);
  assert.match(threadSearchSource, /MutationObserver/);
  assert.ok(!/createElement\("mark"\)/.test(threadSearchSource), "不该自己造 mark 节点");
});

test("GlobalSearchDialog：防抖 + AbortController + 后发请求作废先发的", () => {
  assert.match(dialogSource, /setTimeout\(/);
  assert.match(dialogSource, /new AbortController\(\)/);
  assert.match(dialogSource, /controller\.abort\(\)/);
  assert.match(dialogSource, /searchGlobalSessions\(/);
  assert.match(dialogSource, /splitByMatches\(/);
  assert.match(dialogSource, /ArrowDown|ArrowUp/);
});

test("InTaskSearchBar：计数、上下跳、Esc 关闭", () => {
  assert.match(barSource, /search\.inTask\.count/);
  assert.match(barSource, /onStep\(event\.shiftKey \? -1 : 1\)/);
  assert.match(barSource, /event\.key === "Escape"/);
});

test("两个搜索输入都做 IME 组字：compositionend 才提交，组字中不导航", () => {
  for (const source of [dialogSource, barSource]) {
    assert.match(source, /useImeSafeInput\(/);
    assert.match(source, /onCompositionStart=\{/);
    assert.match(source, /onCompositionEnd=\{/);
    assert.match(source, /isComposing\(\)/);
  }
  // 铁律：组字中只更新本地草稿，不把拼音抛给搜索。
  assert.match(imeSource, /composingRef\.current = true/);
  assert.match(imeSource, /composingRef\.current = false/);
  assert.match(imeSource, /if \(!composingRef\.current\) \{\s*onCommit\(next\);/);
});

test("会话内小条宽度固定：计数出现 / 位数变化都不伸缩", () => {
  assert.match(stylesSource, /\.in-task-search-bar \{[\s\S]*?width:\s*\d+px/);
  assert.match(stylesSource, /\.in-task-search-bar-input \{[\s\S]*?flex:\s*1 1 auto/);
  assert.match(stylesSource, /\.in-task-search-bar-count \{[\s\S]*?min-width:\s*\d+px/);
});

test("客户端请求带 query 与 limit，并支持 signal", () => {
  assert.match(globalSearchSource, /URLSearchParams\(\{ q: query, limit:/);
  assert.match(globalSearchSource, /signal: options\.signal/);
});

test("服务端：/api/search 有结果上限、缓存与诊断", () => {
  assert.match(serverSource, /searchResultLimit/);
  assert.match(serverSource, /searchDocumentCache/);
  assert.match(serverSource, /diagnosticLog\("search\.query"/);
  assert.match(serverSource, /displayTranscript\(\{ sessionManager: manager \}\)/);
  assert.match(serverSource, /buildChatBubbles\(transcript/);
});

test("样式：会话内高亮走 ::highlight，小条不占布局", () => {
  assert.match(stylesSource, /::highlight\(pi-session-search\)/);
  assert.match(stylesSource, /::highlight\(pi-session-search-active\)/);
  assert.match(stylesSource, /\.in-task-search-bar\s*\{[\s\S]*?position:\s*absolute/);
});