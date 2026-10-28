/**
 * 快照窗口之下的历史：翻页按钮、滚动到顶自动续页、以及 prepend 的滚动锚定。
 *
 * 为什么单独成文件：这三件事围绕同一个前提——**服务端只发尾部窗口**
 * （`CONVERSATION_TAIL_TURNS` / ZCode 的 `snapshotTailWindowRows`）。所以"更早的对话"
 * 是一个需要主动取的资源，而不是一个已经在内存里的数组前段。
 *
 * 放进 `ChatThread.tsx` 会让那个文件继续膨胀（它已经在行数棘轮顶部），而这里的逻辑与
 * assistant-ui 没有耦合：视口是一个 DOM 元素，锚定只读 `scrollHeight`。
 */
import { useLayoutEffect, useRef, type RefObject } from "react";
import type { ChatMessage } from "../../types";
import { compareBubbleIds } from "../../shared/chatBubbleIds";
import { useT } from "../../i18n/react";

/**
 * 滚到顶就续一页 + prepend 后把读者按回原位。
 *
 * 用 ref 而不是把回调塞进 effect 依赖：滚动监听只装一次，回调每次渲染都变，塞进依赖会
 * 反复解绑/绑定（还会打断正在进行的滚动）。
 */
export function useOlderMessagesWindow(
  viewportRef: RefObject<HTMLDivElement | null>,
  messages: readonly ChatMessage[],
  hasMoreBefore: boolean,
  loadingOlderMessages: boolean,
  onLoadOlderMessages: (() => void) | undefined,
) {
  const loadOlderRef = useRef(onLoadOlderMessages);
  loadOlderRef.current = onLoadOlderMessages;
  const canLoadOlderRef = useRef(false);
  canLoadOlderRef.current = hasMoreBefore && !loadingOlderMessages;

  /**
   * 浏览器原生的 `overflow-anchor` 只管"删除/增高当前可见区"，对"在视口**上方**插入
   * 一整页"没有帮助：内容会把读者往下推，看上去像是自己跳回了更早的位置。所以在这里按
   * 高度差把它推回来——只在新首条**更早**时做，正常增长（流式）和会话切换都不碰。
   */
  const prependAnchorRef = useRef<{ firstId: string | undefined; scrollHeight: number } | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const firstId = messages[0]?.id;
    const previous = prependAnchorRef.current;
    prependAnchorRef.current = { firstId, scrollHeight: viewport.scrollHeight };
    if (!previous?.firstId || !firstId || previous.firstId === firstId) {
      return;
    }
    if (compareBubbleIds(firstId, previous.firstId) >= 0) {
      return;
    }
    const delta = viewport.scrollHeight - previous.scrollHeight;
    if (delta > 0) {
      viewport.scrollTop += delta;
    }
  }, [messages, viewportRef]);

  return { loadOlderRef, canLoadOlderRef };
}

/** 视口顶部那一行：还有更早的历史时才出现。 */
export function LoadOlderMessages({
  loading,
  onLoad,
}: {
  loading: boolean;
  onLoad?: () => void;
}) {
  const t = useT();
  return (
    <div className="aui-thread-load-older">
      <button type="button" className="aui-load-older" onClick={onLoad} disabled={loading}>
        {loading ? t("chat.loadOlder.loading") : t("chat.loadOlder.action")}
      </button>
    </div>
  );
}