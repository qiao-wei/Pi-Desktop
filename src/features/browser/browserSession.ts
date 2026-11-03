/**
 * 内置浏览器的标签页模型（纯函数，和 `rightPanelTabs` 同一个写法）。
 *
 * 规则只有四条，每一条都能在没有 DOM 的情况下钉住：
 *
 * - 新标签页追加在末尾并激活；
 * - 关掉当前标签页落到**右邻居**，没有右邻居落到左邻居；
 * - 关掉最后一个标签页留一张空白页（面板不该因为关光而消失）；
 * - 超过上限时挤掉**最久未激活**的非当前标签页（不是最左的，也不是最新的）。
 */

import { BLANK_BROWSER_URL } from "../../shared/browserUrl.ts";

export interface BrowserTabState {
  /** 稳定 id：React key、ref 表、事件回调都靠它。 */
  readonly id: string;
  /** 这张 tab 挂载时的地址（`<webview src>` 只在挂载时读一次，避免每帧重载）。 */
  readonly initialUrl: string;
  /** 当前地址（`did-navigate` 之后更新）。 */
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
}

export interface BrowserTabsState {
  readonly tabs: readonly BrowserTabState[];
  readonly activeId: string;
}

/** 同时活着的 guest 上限。每个 guest 是一个独立渲染进程，开太多等于把内存交给网页。 */
export const MAX_BROWSER_TABS = 8;

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `tab-${sequence}`;
}

function blankTab(url: string): BrowserTabState {
  return { id: nextId(), initialUrl: url, url, title: "", loading: false };
}

/** 初始状态：一张空白页。 */
export function createBrowserTabs(initialUrl: string = BLANK_BROWSER_URL): BrowserTabsState {
  const tab = blankTab(initialUrl);
  return { tabs: [tab], activeId: tab.id };
}

/** 新标签页：追加 + 激活；超上限时挤掉最久未激活的那张（当前这张永远不挤）。 */
export function openBrowserTab(
  state: BrowserTabsState,
  url: string = BLANK_BROWSER_URL,
): BrowserTabsState {
  const tab = blankTab(url);
  const tabs = [...state.tabs, tab];
  while (tabs.length > MAX_BROWSER_TABS) {
    const victim = tabs.find((candidate) => candidate.id !== tab.id);
    if (!victim) {
      break;
    }
    tabs.splice(tabs.indexOf(victim), 1);
  }
  return { tabs, activeId: tab.id };
}

export function activateBrowserTab(state: BrowserTabsState, id: string): BrowserTabsState {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state;
}

/**
 * 关掉一张 tab，并把焦点交出去。
 *
 * `closingIndex` 用来找「右邻居」：先看原位置右边那张（关闭后的同一索引），没有才看左边。
 */
export function closeBrowserTab(state: BrowserTabsState, id: string): BrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) {
    return state;
  }
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (tabs.length === 0) {
    return createBrowserTabs();
  }
  if (state.activeId !== id) {
    return { tabs, activeId: state.activeId };
  }
  return { tabs, activeId: tabs[Math.min(index, tabs.length - 1)].id };
}

export function updateBrowserTab(
  state: BrowserTabsState,
  id: string,
  patch: Partial<Pick<BrowserTabState, "url" | "title" | "loading">>,
): BrowserTabsState {
  if (!state.tabs.some((tab) => tab.id === id)) {
    return state;
  }
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
  };
}

/** tab 上显示什么：页面标题 → 地址 → 占位。空字符串不是好标题，会渲染成一条空条。 */
export function browserTabLabel(tab: BrowserTabState, fallback: string): string {
  const title = tab.title.trim();
  if (title) {
    return title;
  }
  const url = tab.url.trim();
  return url && url !== BLANK_BROWSER_URL ? url.replace(/^https?:\/\//i, "") : fallback;
}

/** 测试用：重置 id 序列，让断言不依赖跑过多少用例。 */
export function resetBrowserTabIdsForTest(): void {
  sequence = 0;
}
