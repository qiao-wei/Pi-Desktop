import { ChevronsDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/i18n/react";
import { cn } from "@/lib/utils";
import { relativeTimeLabel } from "@/shared/relativeTime";

import { PanelTabIcon } from "./RightPanel";
import type { RecentClosedPanelTab, RightPanelTab } from "./rightPanelTabs";

/**
 * strip 左边的「标签页总览」（ZCode `SidePaneTabOverview`）。
 *
 * 三件事和 ZCode 对齐：
 * - 一个新标签页/总览按钮点开的是一个 **popover**，里面先搜索、再分组；
 * - 两组：**打开的标签页**（右侧带关闭按钮 + 打开时间）与**最近关闭的标签页**（点一下重开 + 关闭时间）；
 * - 相对时间会随面板开着而每分钟刷新一次（不然「刚刚」会一直停在屏幕上）。
 *
 * 搜索是本地子串匹配（ZCode 走 fuzzy 排序 + cmdk）：命中的是标题，够用且没有额外依赖。
 */
export function PanelTabOverview({
  tabs,
  activeTabId,
  recentClosedTabs,
  titleOf,
  onActivateTab,
  onCloseTab,
  onReopenClosedTab,
}: {
  tabs: readonly RightPanelTab[];
  activeTabId: string;
  recentClosedTabs: readonly RecentClosedPanelTab[];
  titleOf: (tab: RightPanelTab) => string;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReopenClosedTab: (tabId: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [highlight, setHighlight] = useState(0);

  // 「3 分钟前」要跟着时间走：面板开着时每分钟重算一次。
  useEffect(() => {
    if (!open) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlight(0);
    }
  }, [open]);

  const needle = query.trim().toLowerCase();
  const openRows = useMemo(
    () => tabs.filter((tab) => !needle || titleOf(tab).toLowerCase().includes(needle)),
    [needle, tabs, titleOf],
  );
  const closedRows = useMemo(
    () => recentClosedTabs.filter((entry) => !needle || titleOf(entry.tab).toLowerCase().includes(needle)),
    [needle, recentClosedTabs, titleOf],
  );
  const rowCount = openRows.length + closedRows.length;

  const relative = (timestamp: number) => {
    const label = relativeTimeLabel(timestamp, now);
    return t(label.key, label.params);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rowCount === 0) {
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((current) => (current + delta + rowCount) % rowCount);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (highlight < openRows.length) {
        const tab = openRows[highlight];
        if (tab) {
          onActivateTab(tab.id);
          setOpen(false);
        }
        return;
      }
      const entry = closedRows[highlight - openRows.length];
      if (entry) {
        onReopenClosedTab(entry.tab.id);
        setOpen(false);
      }
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("rightPanel.overview.title")}
          title={t("rightPanel.overview.title")}
          data-right-panel-overview
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronsDown aria-hidden="true" className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-0 p-0">
        <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
          <Search aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={handleKeyDown}
            aria-label={t("rightPanel.overview.search")}
            placeholder={t("rightPanel.overview.search")}
            data-right-panel-overview-search
            className="h-6 w-full min-w-0 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
          />
        </div>

        <div className="max-h-80 overflow-y-auto p-1" data-right-panel-overview-list>
          {rowCount === 0 ? (
            <div className="px-2 py-4 text-center text-[12px] text-muted-foreground">
              {t("rightPanel.overview.empty")}
            </div>
          ) : null}

          {openRows.length > 0 ? (
            <div>
              <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
                {t("rightPanel.overview.open")}
              </div>
              {openRows.map((tab, index) => {
                const title = titleOf(tab);
                const isActive = tab.id === activeTabId;
                return (
                  <div
                    key={tab.id}
                    role="button"
                    tabIndex={-1}
                    data-right-panel-overview-tab={tab.id}
                    data-highlight={index === highlight ? "" : undefined}
                    onClick={() => {
                      onActivateTab(tab.id);
                      setOpen(false);
                    }}
                    onMouseEnter={() => setHighlight(index)}
                    className={cn(
                      "group/row flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 text-[12px]",
                      "hover:bg-accent/60",
                      isActive && "bg-accent text-accent-foreground",
                      index === highlight && !isActive && "bg-accent/40",
                    )}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                      <PanelTabIcon tab={tab} />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{relative(tab.openedAt ?? now)}</span>
                    <button
                      type="button"
                      aria-label={t("rightPanel.tab.closeNamed", { title })}
                      title={t("rightPanel.tab.closeNamed", { title })}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onCloseTab(tab.id);
                      }}
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-70 hover:bg-background/60 hover:opacity-100"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {closedRows.length > 0 ? (
            <div>
              <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
                {t("rightPanel.overview.recent")}
              </div>
              {closedRows.map((entry, index) => {
                const title = titleOf(entry.tab);
                const rowIndex = openRows.length + index;
                return (
                  <div
                    key={entry.tab.id}
                    role="button"
                    tabIndex={-1}
                    data-right-panel-overview-closed={entry.tab.id}
                    onClick={() => {
                      onReopenClosedTab(entry.tab.id);
                      setOpen(false);
                    }}
                    onMouseEnter={() => setHighlight(rowIndex)}
                    className={cn(
                      "flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 text-[12px] hover:bg-accent/60",
                      rowIndex === highlight && "bg-accent/40",
                    )}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                      <PanelTabIcon tab={entry.tab} />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{relative(entry.closedAt)}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}