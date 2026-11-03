/**
 * 右侧面板的标签页模型（Codex 风格：**一个文件一个 tab**，可关、可切换）。
 *
 * 为什么要有这个纯模块：标签页的「开/关/激活」全部是有具体规则的代数 ——
 * 重复点同一个文件不能再开一个、关掉当前 tab 要落到哪一个、面板里的 tab 全关掉之后显示什么。
 * 这些规则写进组件里就只能靠点出来，放这里可以被 `node --test` 直接钉住。
 *
 * 和 ZCode（`lib/workspaceSidePane.ts`）对齐的三条语义：
 * - **按稳定身份复用**：同一个「文件 + 模式（正文/改动）+ 来源」只有一个 tab，再点就刷新它
 *   （`matchedTab ? { ...matchedTab, source }` 那条：入口不同、身份相同，不许开一排同名 tab）；
 * - **新 tab 追加在末尾并激活**；
 * - **关掉当前 tab 时落到它的右邻居，没有右邻居就落到左邻居**（关最后一个就是它自己）。
 *
 * strip 上的 `+` 是 ZCode 的「加标签页」下拉（终端 / 改动 / 文件 / 浏览器…），不是一张新页面：
 * 选一项就直接开一张那张内容的 tab。
 */
import type { WorkspaceDiffSource } from "@/shared/workspaceDiff";

/**
 * 面板自带的工具视图（`+` 下拉和空状态里能开的东西）。顺序 = 列表顺序。
 *
 * 只有「改动」在右面板里：**文件树在左侧栏**、**技能/包/MCP 是项目条目上的弹窗**
 * （2026-10-12 用户按 ZCode 的布局定的），终端之后从这里加。
 *
 * 「浏览器」是**宿主能力**驱动的视图（`supportsHostCapability("embedded_browser")`）：它出现在
 * 每一端，但只有声明了这个能力的壳（目前是 Electron）真的能画出来；其余宿主由面板自己说明原因，
 * 不在列表里按端分支 —— 端差异是数据，不是 `if`。
 */
export const RIGHT_PANEL_TOOL_TABS = [
  {
    id: "git",
    labelKey: "rightPanel.tab.git",
    hintKey: "rightPanel.gitAria",
    descriptionKey: "rightPanel.launcher.gitHint",
  },
  {
    id: "browser",
    labelKey: "rightPanel.tab.browser",
    hintKey: "rightPanel.browserAria",
    descriptionKey: "rightPanel.launcher.browserHint",
  },
] as const;

export type RightPanelToolTabId = (typeof RIGHT_PANEL_TOOL_TABS)[number]["id"];

export const DEFAULT_RIGHT_PANEL_TAB: RightPanelToolTabId = RIGHT_PANEL_TOOL_TABS[0].id;

export interface RightPanelToolTab {
  kind: "tool";
  /** 工具 tab 的身份就是工具 id（不需要再加一层前缀）。 */
  id: RightPanelToolTabId;
  /** 打开时间（总览里显示成「3 分钟前」）。由调用方写入，纯模块不自己取时间。 */
  openedAt?: number;
}

/** 一个被打开的文件：`mode` 决定**此刻**看正文还是看改动（再点一次可以换）。 */
export interface RightPanelFileTab {
  kind: "file";
  /** `fileTabId()` 生成：一个文件永远同一个 id。 */
  id: string;
  path: string;
  mode: "content" | "diff";
  /** 只有 `mode === "diff"` 才有。 */
  source?: WorkspaceDiffSource;
  base?: string;
  /**
   * 直接渲染的补丁（「这一轮改了什么」卡片点「审查」时给的）。
   *
   * 有它就不去读 git：agent 新建的文件在 git 里还是 untracked、改完就 commit 的文件在
   * unstaged 里也是空的 —— 那两种情况下现读 git 会得到一张空白页，而用户点的是「审查这一轮」。
   */
  patch?: string;
  /** 打开时间（总览里显示成「3 分钟前」）。 */
  openedAt?: number;
}

export type RightPanelTab = RightPanelToolTab | RightPanelFileTab;

export function toolTab(id: RightPanelToolTabId): RightPanelToolTab {
  return { kind: "tool", id };
}

export function isToolTabId(value: unknown): value is RightPanelToolTabId {
  return RIGHT_PANEL_TOOL_TABS.some((tab) => tab.id === value);
}

/**
 * 偏好里存下来的值必须过这里（只存「工具 tab」：文件 tab 是会话级的，路径相对工作区，
 * 换个项目再恢复出来只会指到别的文件）。
 */
export function normalizeRightPanelTab(value: unknown): RightPanelToolTabId {
  return isToolTabId(value) ? value : DEFAULT_RIGHT_PANEL_TAB;
}

/**
 * 文件 tab 的身份：**一个文件一张 tab**（Codex 的模型）。
 *
 * 模式（正文 / 改动）和来源（未暂存 / 已暂存 / 对比分支）都**不进** id：同一个文件从改动列表、
 * 文件树、git 徽标点进来时，标题会是同一个文件名 —— 拿它们拆成几张 tab，用户会在 strip 上看到
 * 两三个同名标签，却分不清哪张是哪张。所以再点一次就是「把那张 tab 切到新内容并刷新」。
 */
export function fileTabId(path: unknown): string {
  return `file:${String(path ?? "").trim()}`;
}

export function isFileTabId(id: unknown): boolean {
  return String(id ?? "").startsWith("file:");
}

/** 这个 id 对应的文件路径（树/改动列表拿它做高亮）；不是文件 tab 就是空串。 */
export function tabFilePath(tab: RightPanelTab | null | undefined): string {
  return tab?.kind === "file" ? tab.path : "";
}

function tabIndex(tabs: readonly RightPanelTab[], id: string): number {
  return tabs.findIndex((tab) => tab.id === id);
}

/**
 * 打开（或复用）一个 tab，并激活它。
 *
 * 复用是**原地替换**而不是删了重加：用户在 strip 上把它拖到了第三个位置（或者只是习惯了
 * 它在哪儿），再点一次不该让它跳到末尾。
 */
export function openPanelTab(
  tabs: readonly RightPanelTab[],
  activeTabId: string,
  tab: RightPanelTab,
): { tabs: RightPanelTab[]; activeTabId: string } {
  const index = tabs.findIndex((candidate) => candidate.id === tab.id);
  if (index >= 0) {
    const next = [...tabs];
    // 复用 = 换内容、不换身份：`openedAt` 留在原来那张上（ZCode `{...matchedTab, source: next}` 同），
    // 否则总览里「3 分钟前」会在每次点同一个文件时被重置成「刚刚」。
    next[index] = { ...tab, openedAt: tabs[index]!.openedAt ?? tab.openedAt };
    return { tabs: next, activeTabId: tab.id };
  }

  return { tabs: [...tabs, tab], activeTabId: tab.id };
}

/**
 * 关掉一个 tab。
 *
 * 关的正好是当前 tab 时落到「右邻居，没有右邻居就落到左邻居」（`min(索引, 新长度-1)`，
 * 和 ZCode 的 `closeSidePaneTab` 一致）：关中间那个会顺手把下一个抬上来，符合浏览器的肌肉记忆。
 */
export function closePanelTab(
  tabs: readonly RightPanelTab[],
  activeTabId: string,
  closeTabId: string,
): { tabs: RightPanelTab[]; activeTabId: string } {
  const index = tabIndex(tabs, closeTabId);
  if (index < 0) {
    return { tabs: [...tabs], activeTabId };
  }

  const next = tabs.filter((tab) => tab.id !== closeTabId);
  if (next.length === 0) {
    return { tabs: next, activeTabId: "" };
  }

  if (activeTabId !== closeTabId) {
    return { tabs: next, activeTabId };
  }

  return { tabs: next, activeTabId: next[Math.min(index, next.length - 1)]!.id };
}

/**
 * 「最近关闭」最多留几条（ZCode `RECENT_CLOSED_SIDE_PANE_TAB_LIMIT = 8`）。
 * 面板一共就几个 tab，留太多只会让总览变成一个需要翻的列表。
 */
export const RECENT_CLOSED_PANEL_TAB_LIMIT = 8;

export interface RecentClosedPanelTab {
  tab: RightPanelTab;
  /** 关掉的时间（总览里显示成「3 分钟前」）。 */
  closedAt: number;
}

/**
 * 关掉一批 tab 之后把它们记进「最近关闭」：新的在最前、按 id 去重、最多 8 条（ZCode 同）。
 * 记的是整个 tab 对象，所以重开时连内容一起回来（改动那档会重新读一次，见 hook）。
 */
export function rememberClosedPanelTabs(
  recent: readonly RecentClosedPanelTab[],
  closedTabs: readonly RightPanelTab[],
  closedAt: number,
): RecentClosedPanelTab[] {
  if (closedTabs.length === 0) {
    return [...recent];
  }

  const closingIds = new Set(closedTabs.map((tab) => tab.id));
  return [
    ...closedTabs.map((tab) => ({ tab, closedAt })),
    ...recent.filter((entry) => !closingIds.has(entry.tab.id)),
  ].slice(0, RECENT_CLOSED_PANEL_TAB_LIMIT);
}

/** 重开（或又关了一次）之后，从「最近关闭」里去掉这条。 */
export function forgetRecentClosedPanelTab(
  recent: readonly RecentClosedPanelTab[],
  tabId: string,
): RecentClosedPanelTab[] {
  return recent.filter((entry) => entry.tab.id !== tabId);
}

/**
 * 拖拽换位：把 `fromId` 那张插到 `toId` **原来所在的位置**（ZCode `reorderSidePaneTab` 逐字同）。
 *
 * 于是往左拖 = 插到目标前面，往右拖 = 插到目标后面；索引在被移除的数组上原样使用，
 * 别「修正」它 —— 那会让往左拖和往右拖的行为不对称。
 */
export function movePanelTab(
  tabs: readonly RightPanelTab[],
  fromId: string,
  toId: string,
): RightPanelTab[] {
  if (fromId === toId) {
    return [...tabs];
  }

  const fromIndex = tabIndex(tabs, fromId);
  const toIndex = tabIndex(tabs, toId);
  if (fromIndex < 0 || toIndex < 0) {
    return [...tabs];
  }

  const next = [...tabs];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) {
    return [...tabs];
  }
  next.splice(toIndex, 0, moved);
  return next;
}

export function closeOtherPanelTabs(
  tabs: readonly RightPanelTab[],
  keepTabId: string,
): { tabs: RightPanelTab[]; activeTabId: string } {
  const kept = tabs.filter((tab) => tab.id === keepTabId);
  if (kept.length === 0) {
    return { tabs: [], activeTabId: "" };
  }
  return { tabs: kept, activeTabId: keepTabId };
}

/**
 * 选中的 tab 必须真的存在：不存在就落到最后一个（和 ZCode 的 `normalizeWorkspaceSidePaneState`
 * 一致）。返回空串表示「一个 tab 都没有」，面板这时显示「新标签页」。
 */
export function normalizeActivePanelTab(tabs: readonly RightPanelTab[], candidate: unknown): string {
  const value = String(candidate ?? "");
  if (value && tabIndex(tabs, value) >= 0) {
    return value;
  }
  return tabs.length > 0 ? tabs[tabs.length - 1]!.id : "";
}

/**
 * 内容框的 class（布局契约，不是随手写的样式）。
 *
 * 每一张 tab 都自己钉住头部、正文自己滚，正文贴满面板宽度；竖直内边距**不在**这里，
 * 它挂在 `RightPanel` 的 aside 上（codex 主题要覆盖 `padding-top`，挪进内层就会多一段空隙），
 * 所以这串里不许出现 `pt-`；水平/底部内边距归各视图自己。
 *
 * 2026-10-12：能力面板搬去项目条目上的弹窗、文件树搬去左侧栏之后，右面板只剩「改动」这类
 * 自带头部的视图，原来那套「整块滚动」的框（`RIGHT_PANEL_SCROLL_FRAME`）就没有使用者了。
 */
export const RIGHT_PANEL_TAB_FRAME = "flex min-h-0 flex-1 flex-col";
