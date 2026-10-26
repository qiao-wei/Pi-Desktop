import {
  Plus,
  X,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/i18n/react";
import { cn } from "@/lib/utils";

import { PanelTabOverview } from "./PanelTabOverview";
import {
  RIGHT_PANEL_TAB_FRAME,
  RIGHT_PANEL_TOOL_TABS,
  toolTab,
  type RecentClosedPanelTab,
  type RightPanelTab,
  type RightPanelToolTabId,
} from "./rightPanelTabs";
import { PanelTabIcon } from "./PanelTabIcon";

/**
 * 「一张 tab 都没有」（全被关掉）时，空状态内容在 `views` 里的 key。
 *
 * 它不是一张 tab（不进 `tabs` 数组、strip 上也不出现），只是一个具名落点 —— 比到处写
 * `views[""]` 好读，也免得和真实的 tab id 混淆。
 */
export const EMPTY_RIGHT_PANEL_VIEW_ID = "__empty__";

/**
 * 一个 tab 的标题。
 *
 * 文件 tab 只显示**文件名**（`src/foo/bar.ts` → `bar.ts`）：面板只有 ~340px，strip 上一行放不下
 * 两三个完整路径，而同一目录下的两个 `index.ts` 靠图标和悬浮提示区分（完整路径在 tip 里）。
 */
function tabTitle(tab: RightPanelTab, t: ReturnType<typeof useT>): string {
  if (tab.kind === "file") {
    const name = tab.path.split("/").filter(Boolean).pop() ?? tab.path;
    return name;
  }
  const tool = RIGHT_PANEL_TOOL_TABS.find((candidate) => candidate.id === tab.id);
  return tool ? t(tool.labelKey) : tab.id;
}

function tabHint(tab: RightPanelTab, t: ReturnType<typeof useT>): string {
  if (tab.kind === "file") {
    return tab.path;
  }
  const tool = RIGHT_PANEL_TOOL_TABS.find((candidate) => candidate.id === tab.id);
  return tool ? t(tool.hintKey) : tab.id;
}

/**
 * 右侧面板的壳：**标签页 strip + 内容**（Codex 掉出来的那种：一个文件一个 tab、可关、可滚动）。
 *
 * 为什么不用 Radix 的 `Tabs`：tab 里要放一个原生关闭按钮，而 `TabsTrigger` 渲染的就是 `<button>`
 * —— 嵌一个 `<button>` 进去，浏览器修正 DOM 后 tab / 关闭 / 拖拽的事件全都会错位（ZCode 为同一件事
 * 绕了 `asChild` + `div` 一大圈）。这里干脆自己拿 `role="tablist"` 铺，代价是要自己接键盘左右键。
 *
 * 内容由调用方按 tab id 传进来（`views`），而不是在这里按 tab 造组件 —— 因为「项目技能 / 包 / MCP」
 * 面板的 call site 必须留在 App.tsx 里（`capabilityPanelParity.test.ts` 就在那里核对两个宿主的接线
 * 是否一致）。一张 tab 一张 view，同一个 id 只渲染激活的那份。
 *
 * 三条布局约定，动之前先看这两个测试：
 * - 窄屏（≤920px）是贴右边缘的浮层，必须 `top-[var(--titlebar-height)] + bottom-0`，
 *   用 `inset-y-0` 会被 z-[100] 的标题栏盖住第一行（`contextPanelNarrowLayout.test.ts`）；
 * - strip 不能比面板宽：视图变多或标题变长时由 strip 自己横向滚动，绝不能把父级 aside 撑出
 *   `scrollWidth > clientWidth`（那样点 tab 浏览器会把整块内容横推十几像素）；
 * - codex 主题给 `.context-panel-surface` 加了 `padding-top: var(--titlebar-height)`（整列通高）。
 *   所以**竖直内边距留在这个 aside 上、水平内边距留在内层**：把 padding-top 挪进内层会让 codex
 *   下多出一段空隙（`appearanceTheme.test.ts`）。
 */
export function RightPanel({
  collapsed,
  narrowOpen,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onOpenToolTab,
  recentClosedTabs,
  onReopenClosedTab,
  onMoveTab,
  views,
}: {
  /** 面板收起（宽屏时列宽已被 App 置 0，这里负责不再吃指针事件）。 */
  collapsed: boolean;
  /** 窄屏浮层是否可见（App 的 `showPanel`）。 */
  narrowOpen: boolean;
  /** 打开着的 tab（顺序就是 strip 上的顺序）。 */
  tabs: RightPanelTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  /** 打开 `+` 下拉里的某项（工具 tab）。 */
  onOpenToolTab: (toolId: RightPanelToolTabId) => void;
  /** 最近关闭的 tab（总览里可以重开）。 */
  recentClosedTabs: readonly RecentClosedPanelTab[];
  onReopenClosedTab: (tabId: string) => void;
  /** 拖拽换位（把 `fromId` 拖到 `toId` 的位置上）。 */
  onMoveTab: (fromId: string, toId: string) => void;
  /** tab id → 内容。没有内容的 tab 仍然在 strip 上（文件 tab 的加载/失败态自己画）；
   *  `EMPTY_RIGHT_PANEL_VIEW_ID` 那张是「一张 tab 都没有」时的空状态。 */
  views: Record<string, ReactNode>;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 拖拽换位用的两个状态：正在拖谁、当前落在谁身上（只影响高亮，落点由 onDrop 决定）。 */
  const [draggingTabId, setDraggingTabId] = useState("");
  const [dragOverTabId, setDragOverTabId] = useState("");

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  /** 键盘左右键在 strip 内移动（手写 strip 就得自己补上这个，Radix 的 Tabs 自带）。 */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) {
      return;
    }
    event.preventDefault();

    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    const last = tabs.length - 1;
    const nextIndex =
      event.key === "ArrowLeft"
        ? Math.max(index - 1, 0)
        : event.key === "ArrowRight"
          ? Math.min(index + 1, last)
          : event.key === "Home"
            ? 0
            : last;
    const next = tabs[nextIndex];
    if (!next) {
      return;
    }

    onSelectTab(next.id);
    listRef.current?.querySelector<HTMLElement>(`[data-right-panel-tab="${CSS.escape(next.id)}"]`)?.focus();
  };

  return (
    <aside
      className={cn(
        // 滚动的不是这一层：strip 要固定，各视图自己滚（滚动条仍在面板右边缘 —— 水平内边距
        // 在内层，所以位置和以前一致）。
        "context-panel-surface flex min-h-0 min-w-0 flex-col overflow-hidden pt-[18px]",
        collapsed && "invisible pointer-events-none",
        // 窄屏（≤920px）这个面板是贴右边缘的浮层。它必须从标题栏下面开始：标题栏
        // 是 z-[100] 的不透明条，浮层 z-20 从 y=0 起就会被整条盖住 —— 面板第一行是搜索框，
        // 用户看到的就是「搜索显示不全」。左侧项目栏同样用 top-[var(--titlebar-height)]，两边保持一致。
        "max-[920px]:fixed max-[920px]:top-[var(--titlebar-height)] max-[920px]:bottom-0 max-[920px]:right-0 max-[920px]:left-auto max-[920px]:z-20 max-[920px]:w-[min(88vw,360px)] max-[920px]:translate-x-[105%] max-[920px]:shadow-[var(--app-shadow-drawer-left)] max-[920px]:transition-transform",
        narrowOpen && "max-[920px]:visible max-[920px]:translate-x-0 max-[920px]:pointer-events-auto",
      )}
      aria-label={t("rightPanel.aria")}
    >
      {/* strip：左边是标签页视口（自己横向滚，绝不撑宽面板），右边是 `+` 与收起（收起在 App 的标题栏里）。 */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 px-2">
        {/* ZCode 的 strip 左边就是这个总览按钮：打开的 tab + 最近关闭的 tab（带搜索）。 */}
        <PanelTabOverview
          tabs={tabs}
          activeTabId={activeTabId}
          recentClosedTabs={recentClosedTabs}
          titleOf={(tab) => tabTitle(tab, t)}
          onActivateTab={onSelectTab}
          onCloseTab={onCloseTab}
          onReopenClosedTab={onReopenClosedTab}
        />
        <div
          ref={listRef}
          role="tablist"
          aria-label={t("rightPanel.tabsAria")}
          onKeyDown={handleKeyDown}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const title = tabTitle(tab, t);
            const hint = tabHint(tab, t);

            return (
              <ContextMenu key={tab.id}>
                <ContextMenuTrigger asChild>
                  <div
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    // 拖拽换位（ZCode 用 dnd-kit，这里用原生 HTML5 DnD：不引依赖、行为一样）。
                    draggable
                    onDragStart={(event) => {
                      // 拖的是什么放进 dataTransfer，不靠 state：一次拖拽里 dragstart/dragover/drop
                      // 可能落在同一批渲染里，state 还是旧值（真机上因为中间有渲染看不出问题，
                      // 但合成事件 / 快速拖拽就会丢）。
                      event.dataTransfer?.setData("text/plain", tab.id);
                      if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = "move";
                      }
                      setDraggingTabId(tab.id);
                    }}
                    onDragEnd={() => {
                      setDraggingTabId("");
                      setDragOverTabId("");
                    }}
                    onDragOver={(event) => {
                      if (!draggingTabId || draggingTabId === tab.id) {
                        return;
                      }
                      // 不 preventDefault 就不会触发 drop；默认只有链接等元素可放。
                      event.preventDefault();
                      setDragOverTabId(tab.id);
                    }}
                    onDragLeave={() => setDragOverTabId((current) => (current === tab.id ? "" : current))}
                    onDrop={(event) => {
                      event.preventDefault();
                      const from = event.dataTransfer?.getData("text/plain") || draggingTabId;
                      setDraggingTabId("");
                      setDragOverTabId("");
                      if (from && from !== tab.id) {
                        onMoveTab(from, tab.id);
                      }
                    }}
                    // Radix 的 ContextMenu 也会往这个节点写 data-state，所以激活态用**自己的**
                    // 属性名 `data-active`（ZCode 踩过同一个坑）。
                    data-active={isActive ? "" : undefined}
                    data-right-panel-tab={tab.id}
                    title={hint}
                    onClick={(event) => {
                      // 中键会同时派发 click/auxclick，先在这里拦掉，否则关闭之前会先把它激活。
                      if (event.button === 1) {
                        event.preventDefault();
                        return;
                      }
                      onSelectTab(tab.id);
                    }}
                    onAuxClick={(event) => {
                      if (event.button !== 1) {
                        return;
                      }
                      // 中键关闭是浏览器的肌肉记忆；同时取消默认的「中键自动滚动」。
                      event.preventDefault();
                      onCloseTab(tab.id);
                    }}
                    className={cn(
                      // 宽度按内容（max 156px）+ 能收缩：平分时每个标签都会差半个像素，
                      // `truncate` 就把「Skills」显示成「Skil…」（实测过）。
                      "group/tab relative flex h-7 max-w-[9.75rem] min-w-0 shrink-0 cursor-default items-center gap-1",
                      // 正在拖 / 落点：只用边框表达，不改宽度（改宽度会让 strip 在拖拽中抖动）。
                      draggingTabId === tab.id && "opacity-60",
                      dragOverTabId === tab.id && "ring-2 ring-ring/60",
                      "rounded-lg px-2 pr-6 text-[12px] font-medium text-muted-foreground select-none",
                      "transition-colors hover:bg-accent/50 hover:text-foreground",
                      "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                      isActive && "bg-accent text-accent-foreground",
                    )}
                  >
                    <PanelTabIcon tab={tab} />
                    {/* 不要 `flex-1`：它的 flex-basis 是 0，tab 的宽度会塌成「图标 + 内边距」，
                        标题就全被截成一个字母（实测过）。宽度按内容来，上限在 tab 的 max-w 上。
                        ZCode 那条 mask 渐隐这里不需要：关闭按钮的 24px 已经用 `pr-6` 让出来了，
                        标题不会压到 X 下面 —— 照抄 mask 反而会把 "Skills" 渐隐成 "Sl"。 */}
                    <span className="min-w-0 truncate">{title}</span>
                    <button
                      type="button"
                      aria-label={t("rightPanel.tab.close")}
                      title={t("rightPanel.tab.close")}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onCloseTab(tab.id);
                      }}
                      className={cn(
                        "absolute right-1 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded",
                        "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                        !isActive && "pointer-events-none opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100",
                      )}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-40">
                  <ContextMenuItem onSelect={() => onCloseTab(tab.id)}>{t("rightPanel.tab.close")}</ContextMenuItem>
                  <ContextMenuItem disabled={tabs.length <= 1} onSelect={() => onCloseOtherTabs(tab.id)}>
                    {t("rightPanel.tab.closeOthers")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={onCloseAllTabs}>{t("rightPanel.tab.closeAll")}</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>

        {/* ZCode 的「加标签页」是个下拉（终端 / 浏览器 / 改动 / 文件 …），不是一张新页面：
            选一项就直接开那张 tab，所以这里不占 strip 的位置、也不进 tabs 数组。 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("rightPanel.tab.addTab")}
              title={t("rightPanel.tab.addTab")}
              data-right-panel-add-tab
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Plus className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {RIGHT_PANEL_TOOL_TABS.map((tool) => (
              <DropdownMenuItem
                key={tool.id}
                data-right-panel-add-tool={tool.id}
                onSelect={() => onOpenToolTab(tool.id)}
              >
                <PanelTabIcon tab={toolTab(tool.id)} />
                <span>{t(tool.labelKey)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 一张 tab 都没有（全被关掉）：给一张工具表而不是留白 —— 和 `+` 下拉里能开的东西一致。 */}
      {activeTab ? (
        <div role="tabpanel" className={RIGHT_PANEL_TAB_FRAME}>
          {views[activeTab.id] ?? null}
        </div>
      ) : (
        <div role="tabpanel" className={RIGHT_PANEL_TAB_FRAME}>
          {views[EMPTY_RIGHT_PANEL_VIEW_ID] ?? null}
        </div>
      )}
    </aside>
  );
}
