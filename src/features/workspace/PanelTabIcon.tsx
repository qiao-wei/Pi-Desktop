import { Blocks, FileDiff, FileText, FolderTree, GitCompare, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { RIGHT_PANEL_TOOL_TABS, type RightPanelTab } from "./rightPanelTabs";

/**
 * tab → 图标。
 *
 * 图标留在组件侧：`rightPanelTabs.ts` 是给 `node --test` 用的纯表，不该为了一个图标去 import lucide。
 * 工具 tab 用和「新标签页」列表里**同一张表**（`RIGHT_PANEL_TOOL_TABS` 的顺序），所以两处不会跑偏。
 *
 * 单独一个文件是为了切断 `RightPanel` ↔ `PanelTabOverview` 的 import 环：总览面板要画图标，
 * 而 strip 要渲染总览。
 */
const TOOL_TAB_ICON_ORDER: LucideIcon[] = [Blocks, FolderTree, GitCompare];

export function PanelTabIcon({ tab, className }: { tab: RightPanelTab; className?: string }) {
  const Icon =
    tab.kind === "file"
      ? tab.mode === "diff"
        ? FileDiff
        : FileText
      : (TOOL_TAB_ICON_ORDER[RIGHT_PANEL_TOOL_TABS.findIndex((tool) => tool.id === tab.id)] ?? Blocks);

  return <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", className)} />;
}