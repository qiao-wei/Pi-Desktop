/**
 * 行内徽标（`contenteditable=false` 原子节点）周围的零宽光标标记（\u200b）与方向键导航。
 *
 * 为什么会「经过徽标要按两次」
 * --------------------------
 * 浏览器需要在原子节点旁边有一个可落点的文本节点，所以插入徽标时会跟一个 \u200b。但零宽
 * 标记没有宽度，光标落在它内部的两个偏移（0 / 1）时屏幕上是同一个点；而且同一个「徽标
 * 右侧」位置还可能被浏览器表示成父子边界 `(parent, index)`。于是默认方向键会出现「按一次
 * 没反应」的死按：
 * - 光标在标记内 / 父子边界上按 ←：先落回标记的另一个偏移，再按一次才越过徽标；
 * - 连续徽标之间按 →：先落到下一个徽标的左侧（和当前位置是同一个点），再按一次才跨过去。
 *
 * 这里把光标跨到徽标外侧，让方向键一次按键就有视觉位移：
 * - ←：落到徽标前一个文本节点的末尾（用元素偏移 `(parent, index)` 时 Chrome 会把光标画到
 *   行首，所以优先落到文本节点）；
 * - →：先跳过徽标后的零宽标记，再落到后面第一个真正可见的位置——下一个徽标就先跨过它，
 *   是文本则落到第一个码点之后（按码点走，避免劈开 emoji 的代理对）。
 *
 * composer（App.tsx）与消息编辑框（MessageEditBox.tsx）共用这份逻辑，各自把结果写回自己的
 * selection ref。
 */

/** 只由零宽标记组成（允许 1 个或多个）的文本节点。 */
export function isMarkerOnlyTextNode(node: Node | null, marker: string): boolean {
  return Boolean(
    node &&
      node.nodeType === Node.TEXT_NODE &&
      (node.textContent ?? "").length > 0 &&
      (node.textContent ?? "").replaceAll(marker, "").length === 0,
  );
}

function isBadgeElement(node: Node | null): node is HTMLElement {
  return Boolean(
    node &&
      node.nodeType === Node.ELEMENT_NODE &&
      ((node as HTMLElement).dataset?.attachmentId || (node as HTMLElement).dataset?.capabilityId),
  );
}

/** 文本节点开头连续零宽标记的长度（打字会把标记和文字并进同一个节点）。 */
function leadingMarkerLength(text: string, marker: string): number {
  let length = 0;
  while (text.startsWith(marker, length)) {
    length += marker.length;
  }
  return length;
}

/**
 * 光标是否正落在某个徽标的「右侧边界」。
 *
 * 同一个边界有四种等价表示，必须都认：
 * - 零宽标记文本节点内部（offset 0 / 1）；
 * - 父子边界 `(parent, index)`（Chrome 在跨过徽标后常把光标规范成这种）；
 * - 紧跟「徽标（+ 标记）」的文本节点 offset 0；
 * - 标记与正文并进同一个文本节点后，标记长度范围内的偏移（那个范围也是零宽的）。
 */
export function badgeBeforeCaret(container: Node, offset: number, marker: string): HTMLElement | null {
  let candidate: Node | null = null;
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent ?? "";
    if (isMarkerOnlyTextNode(container, marker)) {
      candidate = container.previousSibling;
    } else if (offset <= leadingMarkerLength(text, marker)) {
      candidate = container.previousSibling;
    } else {
      return null;
    }
  } else if (container.nodeType === Node.ELEMENT_NODE) {
    candidate = container.childNodes[offset - 1] ?? null;
  } else {
    return null;
  }

  // 连续徽标之间可能夹着标记节点，先跳过它们再看是不是徽标。
  while (candidate && isMarkerOnlyTextNode(candidate, marker)) {
    candidate = candidate.previousSibling;
  }
  return isBadgeElement(candidate) ? candidate : null;
}

/**
 * 光标停在徽标右侧边界时，跨到外侧。
 * @returns 新的折叠 Range；没有处理（不应接管按键）时返回 null。
 */
export function stepOverCaretMarker(
  editor: HTMLElement | null,
  selection: Selection | null,
  direction: -1 | 1,
  marker: string,
): Range | null {
  if (!editor || !selection || !selection.rangeCount || !selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const badge = badgeBeforeCaret(range.startContainer, range.startOffset, marker);
  if (!badge || !editor.contains(badge)) {
    return null;
  }

  const parent = badge.parentNode;
  if (!parent) {
    return null;
  }
  const index = Array.prototype.indexOf.call(parent.childNodes, badge);

  const next = document.createRange();
  if (direction < 0) {
    // 落到徽标前一个文本节点的末尾；没有文本节点时才用元素偏移。
    const before = badge.previousSibling;
    if (before && before.nodeType === Node.TEXT_NODE) {
      next.setStart(before, (before.textContent ?? "").length);
    } else {
      next.setStart(parent, Math.max(0, index));
    }
  } else {
    let follower: Node | null = badge.nextSibling;
    while (follower && isMarkerOnlyTextNode(follower, marker)) {
      follower = follower.nextSibling;
    }
    if (!follower) {
      return null;
    }
    if (isBadgeElement(follower)) {
      // 连续徽标：一次按键直接跨到下一个徽标的右侧（两个徽标之间只有一个视觉停点）。
      const followerIndex = Array.prototype.indexOf.call(parent.childNodes, follower);
      next.setStart(parent, followerIndex + 1);
    } else if (follower.nodeType === Node.TEXT_NODE) {
      // 跳过开头可能并进来的零宽标记，再跨过一个码点（而不是一个 UTF-16 码元），
      // 避免把 emoji 的代理对劈成两半。
      const text = follower.textContent ?? "";
      const leading = leadingMarkerLength(text, marker);
      if (leading >= text.length) {
        return null;
      }
      const codePoint = text.codePointAt(leading) ?? 0;
      next.setStart(follower, Math.min(leading + (codePoint > 0xffff ? 2 : 1), text.length));
    } else {
      return null;
    }
  }

  next.collapse(true);
  selection.removeAllRanges();
  selection.addRange(next);
  return next;
}