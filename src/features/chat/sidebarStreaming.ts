/**
 * Which sessions the sidebar should draw as busy.
 *
 * `bootstrap.streamingSessionPaths` is the server's list (read off the live runtimes),
 * and it is the authority for every run this window does not own. But this window's own
 * run only reaches `state.isStreaming`: the server list is refreshed by a snapshot, and
 * while this window owns the stream the next snapshot only arrives when the turn ends.
 * Without the union below the clock never appears for the session the user just
 * submitted in - the one row they are actually looking at.
 *
 * Deliberately *not* written into the bootstrap itself: adding the path there would
 * start the busy-session watchdog, whose first tick can be a full ~1 MB bootstrap pull
 * exactly while the user waits for the first token (see `pollMode.ts`).
 *
 * Kept free of runtime imports so it can be exercised without a bundler.
 */
export function sidebarStreamingSessionPaths(
  serverPaths: string[] | undefined,
  activeSessionPath: string | undefined,
  isStreamingLocally: boolean,
): string[] {
  const paths = serverPaths ?? [];
  if (!isStreamingLocally || !activeSessionPath || paths.includes(activeSessionPath)) {
    // Identity matters: this feeds a sidebar that must not re-render per token.
    return paths;
  }
  return [...paths, activeSessionPath];
}

/**
 * 会话行左侧那个状态槽里该画什么。
 *
 * ZCode 的任务列表（`TaskListItem.tsx` 的 leading slot）在任务跑起来时画的是一枚**真的在转**
 * 的 `Loader`（八道辐条），不是时钟：时钟只能 `animate-pulse`，看上去像在闪，读不出「还在动」
 * 这层意思（2026-10-22 用户按 ZCode 截图拍的）。这一版照它抄。
 *
 * pending（点了但还没渲染出来）与 streaming（正在生成）共用同一个槽位、同一个图标：状态来回
 * 切换时图标不会跳一下，动画也不会被重启一次；两者的区别只剩无障碍文案。
 *
 * 关键：`animate-spin` 必须挂在**槽位这个 HTML 元素**上，不能挂在里面的 SVG 上 —— SVG 自身
 * 旋转会让浏览器逐帧给图标重算样式，而外层槽位可以把旋转交给合成器（ZCode 那行注释写明了这条）。
 * 所以槽位类与图标类分开导出，别把动画挪到图标上。
 */
export type SidebarSessionBusyIndicator = "pending" | "streaming" | "none";

/** pending 优先：刚点下去的那一行才是用户此刻盯着的。两个都不是就不画（槽位留空，不占位）。 */
export function sidebarSessionBusyIndicator(
  isPending: boolean,
  isStreaming: boolean,
): SidebarSessionBusyIndicator {
  if (isPending) {
    return "pending";
  }
  if (isStreaming) {
    return "streaming";
  }
  return "none";
}

/** 转圈的那一层（HTML 槽位）。 */
export const SIDEBAR_SESSION_BUSY_SLOT_CLASS =
  "absolute left-3 flex size-[15px] animate-spin items-center justify-center";
/** 槽位里的图标：只管颜色与尺寸，动画不在这里。 */
export const SIDEBAR_SESSION_BUSY_ICON_CLASS = "size-[15px] text-muted-foreground";
