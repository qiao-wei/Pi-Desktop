/**
 * 指针 / 滚轮落在什么上面 —— 会话视口的跟随逻辑要区分「读者在滚」与「读者点了个控件」。
 *
 * 从 `ChatThread.tsx` 搬出来（`max-lines` 棘轮）。两个判定都只读 DOM：
 * - {@link isInteractiveTarget}：这次按下是不是落在控件上（展开按钮、行里的链接）——
 *   点击会改变布局，但不是滚动意图，不能拿它当「读者离开底部」的证据；
 * - {@link absorbedByScrollableCard}：滚轮会不会被指针下面的可滚动卡片吃掉（过程/思考面板
 *   有自己的 `overflow-y`），吃掉了就说明会话本身没动，读者还在跟着流。
 */

/** 算作「控件」的节点：按下它们不意味着要滚会话。 */
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, summary, [role="button"], [role="tab"], [contenteditable="true"]';

export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}

/**
 * Would this wheel be absorbed by a scrollable card under the cursor instead of
 * the thread? If it can still scroll that way, the thread itself is not moving
 * and the reader is still following the run.
 *
 * `boundary` is the thread viewport - the walk stops there (scrolling the
 * viewport is exactly what the caller is trying to detect).
 */
export function absorbedByScrollableCard(
  target: EventTarget | null,
  up: boolean,
  boundary: Element | null,
): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== boundary) {
    const overflowY = getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      (up ? node.scrollTop > 0 : node.scrollHeight - node.scrollTop > node.clientHeight + 1)
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}
