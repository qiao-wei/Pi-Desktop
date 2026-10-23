import type { useAppCore } from "./useAppCore";
import type { useAppWiring } from "./useAppWiring";
import type { useAppComposer } from "./useAppComposer";
import type { useAppTurn } from "./useAppTurn";
import type { useAppComposerEditing } from "./useAppComposerEditing";
import { capabilityBadgeKey, clampPanelWidth, composerCaretMarker } from "./AppComposerHelpers";
import type {
  CapabilityKind,
} from "../types";
import type {
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  COMPOSER_BLOCK_TAGS,
} from "../features/chat/pasteSanitize";
import {
  findSlashStart,
} from "../features/chat/slashMenu";
import { ComposerAttachment } from "./AttachmentHoverCard";
import { ComposerCapability, ComposerPart, capabilitySelector } from "./AppComposerHelpers";
import { badgeBeforeCaret, isMarkerOnlyTextNode, stepOverCaretMarker as stepSelectionOverCaretMarker } from "../features/chat/caretMarkerStep";


/**
 * 徽标/光标簿记 + 面板尺寸与折叠
 *
 * `useAppModel()` 顺序切出的第 6 段（原 body 语句 153–172，2120–2404 行）。
 *   · 本段**之前**声明的名字：从共享 `deps` 解构（拿到的是真值本身，闭包身份不变）。
 *   · 本段**之后**才声明的名字：就地写成 `deps.X`（只在延迟执行位置出现；读的是当前 render 的值）。
 * 段内语句一字未改 —— 正确性靠这一点，也靠 `tests/appModelSplit.test.ts` 的顺序与字段校验。
 *
 * 由 `.scratch/split-hook-segments.mjs` 机械搬出。
 */
export function useAppCaretSync(deps: ReturnType<typeof useAppCore> & ReturnType<typeof useAppWiring> & ReturnType<typeof useAppComposer> & ReturnType<typeof useAppTurn> & ReturnType<typeof useAppComposerEditing>) {
  // 前面几段已经写进 deps 的值。
  const {
    composerAttachmentMapRef, composerCapabilityMapRef, composerEditorRef, composerSelectionRef, leftSidebarWidth, panelResizeRef,
    pendingCapabilitySyncRef, rightPanelWidth, setLeftSidebarCollapsed, setLeftSidebarWidth, setResizingSide, setRightPanelCollapsed,
    setRightPanelWidth, setShowLeftPanel, setShowPanel,
  } = deps;

  function trackPendingCapabilitySync(promise: Promise<unknown>) {
    const tracked = promise.then(() => true, () => false);
    pendingCapabilitySyncRef.current = tracked;
    void tracked.then(() => {
      if (pendingCapabilitySyncRef.current === tracked) {
        pendingCapabilitySyncRef.current = null;
      }
    });
  }

  async function waitForPendingCapabilitySync() {
    if (!pendingCapabilitySyncRef.current) {
      return true;
    }

    return pendingCapabilitySyncRef.current;
  }

  function restoreComposerCaret(container: Node | null, offset: number) {
    const editor = composerEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection) {
      return;
    }

    const target = container && editor.contains(container) ? container : editor;
    const range = document.createRange();
    range.setStart(target, Math.min(offset, target.childNodes.length));
    range.collapse(true);
    editor.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    composerSelectionRef.current = range.cloneRange();
  }

  function removableBadgeBeforeCaret(dataKey: "attachmentId" | "capabilityId") {
    const editor = composerEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || !selection.rangeCount || !selection.isCollapsed) {
      return null;
    }

    // 与方向键共用同一套「徽标右侧边界」识别：光标可能停在零宽标记节点内部、被 Chrome
    // 规范成的父子边界上，或标记与正文并进同一个文本节点后的开头偏移。只认「父子边界+
    // 前一个兄弟是徽标」会漏掉夹着标记的情况，于是 Backspace 先删掉那个看不见的标记
    // （Chrome 还会补一个 <br> 占位），要再按一次才删徽标。
    const range = selection.getRangeAt(0);
    const badge = badgeBeforeCaret(range.startContainer, range.startOffset, composerCaretMarker);
    if (!badge || !editor.contains(badge) || !(badge as HTMLElement).dataset?.[dataKey]) {
      return null;
    }
    return badge as HTMLSpanElement;
  }

  function isAttachmentElement(node: Node | null): node is HTMLSpanElement {
    return Boolean(node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset?.attachmentId);
  }

  function isCapabilityElement(node: Node | null): node is HTMLSpanElement {
    return Boolean(node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset?.capabilityId);
  }

  function hasComposerCapability(capability: Pick<ComposerCapability, "kind" | "id">) {
    return Boolean(composerEditorRef.current?.querySelector(capabilitySelector(capability)));
  }

  /**
   * 光标停在徽标后的零宽标记上时，用共享的跨标记逻辑把光标移到徽标外侧，
   * 避免方向键「按一次没反应」（具体说明见 caretMarkerStep.ts）。
   * 返回 true 表示已经处理并移动了光标。
   */
  function stepOverCaretMarker(direction: -1 | 1) {
    const next = stepSelectionOverCaretMarker(
      composerEditorRef.current,
      window.getSelection(),
      direction,
      composerCaretMarker,
    );
    if (!next) {
      return false;
    }
    composerSelectionRef.current = next.cloneRange();
    return true;
  }

  function removeLeadingCaretMarker(node: Node | null) {
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      return;
    }

    const text = node.textContent ?? "";
    if (!text.startsWith(composerCaretMarker)) {
      return;
    }

    node.textContent = text.slice(composerCaretMarker.length);
    if (!node.textContent) {
      node.parentNode?.removeChild(node);
    }
  }

  function clearEmptyComposerMarkers(editor: HTMLDivElement, nextAttachments: ComposerAttachment[], nextText: string) {
    if (nextAttachments.length > 0 || nextText.length > 0 || editor.childNodes.length === 0) {
      return;
    }

    if (Array.from(editor.childNodes).every((node) => isMarkerOnlyTextNode(node, composerCaretMarker))) {
      editor.innerHTML = "";
      composerSelectionRef.current = null;
    }
  }

  function readComposerParts(editor: HTMLDivElement | null) {
    const parts: ComposerPart[] = [];
    if (!editor) {
      return parts;
    }

    appendComposerParts(editor, parts);
    return normalizeComposerTextParts(compactComposerParts(parts));
  }

  function appendComposerParts(
    root: Node,
    parts: ComposerPart[],
  ) {
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent ?? "").replaceAll(composerCaretMarker, "");
        if (text) {
          parts.push({ kind: "text", text });
        }
        continue;
      }

      if (isAttachmentElement(node)) {
        const attachmentId = node.dataset.attachmentId;
        const attachment = attachmentId ? composerAttachmentMapRef.current.get(attachmentId) : undefined;
        if (attachment) {
          parts.push({ kind: "attachment", attachment });
        }
        continue;
      }

      if (isCapabilityElement(node)) {
        const capabilityId = node.dataset.capabilityId;
        const capabilityKind = node.dataset.capabilityKind as CapabilityKind | undefined;
        if (capabilityKind !== "skill") {
          continue;
        }
        const capability = capabilityId && capabilityKind
          ? composerCapabilityMapRef.current.get(capabilityBadgeKey({
              id: capabilityId,
              kind: capabilityKind,
              instanceId: node.dataset.capabilityInstanceId,
            }))
          : undefined;
        if (capability) {
          parts.push({ kind: "capability", capability });
        }
        continue;
      }

      appendComposerParts(node, parts);
      // <br>（Shift+Enter / 粘贴换行）与块级边界都算换行，提交时保留。
      const tagName = (node as Element).nodeName?.toUpperCase() ?? "";
      if (tagName === "BR" || COMPOSER_BLOCK_TAGS.has(tagName)) {
        parts.push({ kind: "text", text: "\n" });
      }
    }
  }

  function compactComposerParts(parts: ComposerPart[]) {
    const compacted: ComposerPart[] = [];
    for (const part of parts) {
      const previous = compacted.at(-1);
      if (part.kind === "text" && previous?.kind === "text") {
        previous.text += part.text;
      } else {
        compacted.push(part);
      }
    }
    return compacted;
  }

  /** 提交序列化的换行保留：连续 3+ 个换行压成两个，去掉结尾换行（块级边界累积产生）。 */
  function normalizeComposerTextParts(parts: ComposerPart[]): ComposerPart[] {
    return parts
      .map((part, index) => {
        if (part.kind !== "text") {
          return part;
        }
        let text = part.text.replace(/\n{3,}/g, "\n\n");
        if (index === parts.length - 1) {
          text = text.replace(/\s+$/u, "");
        }
        return text ? { ...part, text } : null;
      })
      .filter((part): part is ComposerPart => part !== null);
  }

  /**
   * Removes the "/query" text (or a bare "/") right before the caret, so a
   * picked menu item replaces the trigger instead of leaving residue behind.
   * Zero-width caret markers are invisible to the match but kept in the text.
   */
  function removeSlashBeforeRange(range: Range) {
    const container = range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE || range.startOffset === 0) {
      return;
    }

    const text = container.textContent ?? "";
    const slashIndex = findSlashStart(text.slice(0, range.startOffset));
    if (slashIndex == null) {
      return;
    }

    container.textContent = `${text.slice(0, slashIndex)}${text.slice(range.startOffset)}`;
    range.setStart(container, slashIndex);
    range.collapse(true);
  }

  function handlePanelResizeStart(side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panelResizeRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === "left" ? leftSidebarWidth : rightPanelWidth,
    };
    setResizingSide(side);
  }

  function handlePanelResize(side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    const resize = panelResizeRef.current;
    if (!resize || resize.side !== side) {
      return;
    }

    const delta = event.clientX - resize.startX;
    const nextWidth = side === "left" ? resize.startWidth + delta : resize.startWidth - delta;
    const clamped = side === "left" ? clampPanelWidth(nextWidth, "left") : clampPanelWidth(nextWidth, "right");

    if (side === "left") {
      setLeftSidebarCollapsed(false);
      setLeftSidebarWidth(clamped);
    } else {
      setRightPanelCollapsed(false);
      setRightPanelWidth(clamped);
    }
  }

  function handlePanelResizeEnd(side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    if (panelResizeRef.current?.side === side) {
      panelResizeRef.current = null;
    }
    setResizingSide(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function toggleRightPanel() {
    if (window.innerWidth <= 920) {
      setShowPanel((value) => !value);
      return;
    }

    setRightPanelCollapsed((value) => !value);
  }

  function toggleLeftPanel() {
    if (window.innerWidth <= 920) {
      setShowLeftPanel((value) => !value);
      return;
    }

    setLeftSidebarCollapsed((value) => !value);
  }

  return { appendComposerParts, clearEmptyComposerMarkers, compactComposerParts, handlePanelResize, handlePanelResizeEnd, handlePanelResizeStart, hasComposerCapability, isAttachmentElement, isCapabilityElement, normalizeComposerTextParts, readComposerParts, removableBadgeBeforeCaret, removeLeadingCaretMarker, removeSlashBeforeRange, restoreComposerCaret, stepOverCaretMarker, toggleLeftPanel, toggleRightPanel, trackPendingCapabilitySync, waitForPendingCapabilitySync };
}
