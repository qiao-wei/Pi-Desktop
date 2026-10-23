/**
 * 标题栏外壳.
 *
 * 标题栏 / 左格图标按钮 / Windows 窗口控制 / 平台判定。
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import { setLocale, t } from "../i18n/index.ts";
import { useLocale, useT } from "../i18n/react";
import { hasHostShell, invokeHostQuietly } from "../lib/shell/host.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Minus, PanelLeft, PanelRight, Search, SquareIcon, X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

function TitleBar({
  title,
  leftSidebarCollapsed,
  rightPanelCollapsed,
  showContextPanel = true,
  onToggleLeft,
  onToggleRight,
  onOpenSearch,
}: {
  title: string;
  leftSidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  /** Hidden when the visible view has no context panel to toggle. */
  showContextPanel?: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenSearch: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const isDesktopRuntime = hasHostShell();
  const isMac = isMacPlatform();
  const titlebarToggleAtRef = useRef(0);
  const leftClusterRef = useRef<HTMLDivElement | null>(null);

  /**
   * 把标题栏左格（红绿灯 / 侧栏开关 / 搜索…）的真实右边界公开成 CSS 变量。
   *
   * codex 主题把三列抬到窗口顶端，会话头要 `margin-left` 给左格让位（见
   * themes/codex/theme.css）。左格宽度由内容决定：以前主题里写死了「10px 内边距 +
   * 28px 侧栏开关」＝ 38px，结果加了搜索按钮之后常量没跟上，侧栏一收起项目名就直接
   * 压在搜索图标上。量出来的值是唯一不会跟按钮数量脱节的来源。
   *
   * 量的是**子元素的右边界**而不是左格自己的盒子：侧栏收起时它所在的那一列宽为
   * 0px（`min-w-0`），盒子被压成 0 宽、按钮只是视觉上溢出，拿盒子右边界会得到
   * 约 10px（= 标题栏内边距），留位就形同虚设。反过来，侧栏展开时左格会被网格
   * 拉伸到整列宽，也不能拿盒子右边界（那样会多出 10px 缩进）。子元素右边界两种
   * 情况都对。
   *
   * 用 `useLayoutEffect` 是为了在首次绘制前写好，避免收起侧栏时闪一下重叠。
   */
  useLayoutEffect(() => {
    const node = leftClusterRef.current;
    const root = document.documentElement;
    if (!node) {
      return undefined;
    }
    const publish = () => {
      const children = Array.from(node.children);
      const right = children.length
        ? Math.max(...children.map((child) => child.getBoundingClientRect().right))
        : node.getBoundingClientRect().right;
      root.style.setProperty("--titlebar-left-cluster-right", `${Math.round(right)}px`);
    };
    publish();
    if (typeof ResizeObserver === "undefined") {
      return () => root.style.removeProperty("--titlebar-left-cluster-right");
    }
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    for (const child of Array.from(node.children)) {
      observer.observe(child);
    }
    return () => {
      observer.disconnect();
      root.style.removeProperty("--titlebar-left-cluster-right");
    };
  }, [isDesktopRuntime, isMac]);

  function handleTitleBarMouseDown(event: ReactMouseEvent<HTMLElement>) {
    if (!isDesktopRuntime || event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }

    if (event.detail >= 2) {
      event.preventDefault();
      titlebarToggleAtRef.current = Date.now();
      invokeHostQuietly("toggle_window_maximize");
      return;
    }

    invokeHostQuietly("start_window_drag");
  }

  function handleTitleBarDoubleClick(event: ReactMouseEvent<HTMLElement>) {
    if (!isDesktopRuntime || (event.target as HTMLElement).closest("button")) {
      return;
    }

    event.preventDefault();
    if (Date.now() - titlebarToggleAtRef.current < 350) {
      return;
    }

    titlebarToggleAtRef.current = Date.now();
    invokeHostQuietly("toggle_window_maximize");
  }

  return (
    <header
      className="app-titlebar relative z-[100] grid h-[var(--titlebar-height)] flex-none grid-cols-[minmax(220px,1fr)_auto_minmax(220px,1fr)] items-center px-2.5 select-none [-webkit-app-region:drag]"
      data-tauri-drag-region
      onMouseDown={handleTitleBarMouseDown}
      onDoubleClick={handleTitleBarDoubleClick}
    >
      <div ref={leftClusterRef} className="flex min-w-0 items-center gap-2 max-[920px]:gap-1" data-tauri-drag-region>
        {isMac && isDesktopRuntime ? <WindowControls platform="mac" /> : null}
        <TitleBarIconButton
          onClick={onToggleLeft}
          active={!leftSidebarCollapsed}
          label={leftSidebarCollapsed ? t("titlebar.showProjects") : t("titlebar.hideProjects")}
        >
          <PanelLeft />
        </TitleBarIconButton>
        <TitleBarIconButton
          onClick={onOpenSearch}
          active={false}
          label={t("titlebar.search")}
        >
          <Search />
        </TitleBarIconButton>
      </div>
      <div className="min-w-0 text-center text-sm font-bold">
        <span className="block truncate">{title}</span>
      </div>
      <div className="flex min-w-0 items-center justify-end gap-2" data-tauri-drag-region>
        <TitleBarIconButton
          onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
          active={locale === "en"}
          label={locale === "zh" ? t("titlebar.switchToEnglish") : t("titlebar.switchToChinese")}
        >
          <span className="text-[11px] font-bold tracking-wide">{locale === "zh" ? "EN" : "中"}</span>
        </TitleBarIconButton>
        {showContextPanel ? (
          <TitleBarIconButton
            onClick={onToggleRight}
            active={!rightPanelCollapsed}
            label={rightPanelCollapsed ? t("titlebar.showContext") : t("titlebar.hideContext")}
          >
            <PanelRight />
          </TitleBarIconButton>
        ) : null}
        {!isMac && isDesktopRuntime ? <WindowControls platform="windows" /> : null}
      </div>
    </header>
  );
}

function TitleBarIconButton({
  onClick,
  active,
  label,
  children,
}: {
  onClick: () => void;
  active: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn(
        "size-7 text-muted-foreground [-webkit-app-region:no-drag]",
        active && "bg-accent text-accent-foreground",
      )}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {children}
    </Button>
  );
}

function WindowControls({ platform }: { platform: "mac" | "windows" }) {
  if (platform === "mac") {
    // Traffic-light colours are fixed macOS system colours, so they stay literal
    // rather than being mapped onto theme tokens.
    return (
      <div className="inline-flex items-center gap-2 pr-2 pl-1.5 [-webkit-app-region:no-drag]" aria-label="Window controls">
        <button
          type="button"
          className="size-3 rounded-full border border-black/15 bg-[#ff5f57] hover:brightness-[0.96]"
          onClick={() => invokeHostQuietly("close_window")}
          aria-label="Close"
          title="Close"
        />
        <button
          type="button"
          className="size-3 rounded-full border border-black/15 bg-[#ffbd2e] hover:brightness-[0.96]"
          onClick={() => invokeHostQuietly("minimize_window")}
          aria-label="Minimize"
          title="Minimize"
        />
        <button
          type="button"
          className="size-3 rounded-full border border-black/15 bg-[#28c840] hover:brightness-[0.96]"
          onClick={() => invokeHostQuietly("toggle_window_maximize")}
          aria-label="Maximize"
          title="Maximize"
        />
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-0.5 border-l pl-1 [-webkit-app-region:no-drag]" aria-label="Window controls">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 text-muted-foreground [-webkit-app-region:no-drag]"
        onClick={() => invokeHostQuietly("minimize_window")}
        aria-label="Minimize"
        title="Minimize"
      >
        <Minus />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 text-muted-foreground [-webkit-app-region:no-drag]"
        onClick={() => invokeHostQuietly("toggle_window_maximize")}
        aria-label="Maximize"
        title="Maximize"
      >
        <SquareIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 text-muted-foreground hover:bg-destructive hover:text-white [-webkit-app-region:no-drag]"
        onClick={() => invokeHostQuietly("close_window")}
        aria-label="Close"
        title="Close"
      >
        <X />
      </Button>
    </div>
  );
}

function isMacPlatform() {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.platform);
}

export { TitleBar, TitleBarIconButton, WindowControls, isMacPlatform };
