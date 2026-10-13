import { useT } from "@/i18n/react";

import { PanelTabIcon } from "./RightPanel";
import { RIGHT_PANEL_TOOL_TABS, toolTab, type RightPanelToolTabId } from "./rightPanelTabs";

/**
 * 面板的**空状态**：一张 tab 都没有（全被关掉）时显示的工具表。
 *
 * 内容 = strip 末尾 `+` 下拉里能开的那些工具（同一个 `RIGHT_PANEL_TOOL_TABS`），
 * 所以两条路径开出来的东西不会不一致；信息比留一片空白有用（ZCode 这时是空白屏）。
 */
export function LauncherPane({ onChooseTool }: { onChooseTool: (toolId: RightPanelToolTabId) => void }) {
  const t = useT();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[18px] pb-[18px] pt-3">
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {t("rightPanel.launcher.title")}
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        {RIGHT_PANEL_TOOL_TABS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            data-right-panel-launcher-tool={tool.id}
            onClick={() => onChooseTool(tool.id)}
            className="flex w-full items-center gap-2 rounded-[var(--app-radius-card)] border border-border/60 bg-card/40 px-2 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {/* 图标和 strip 上用的是同一张表（`PanelTabIcon`），所以列表里认出来的形状
                在 tab 上仍然认得出来。 */}
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
              <PanelTabIcon tab={toolTab(tool.id)} className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{t(tool.labelKey)}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {t(tool.descriptionKey)}
              </span>
            </span>
          </button>
        ))}
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">{t("rightPanel.launcher.hint")}</p>
    </div>
  );
}