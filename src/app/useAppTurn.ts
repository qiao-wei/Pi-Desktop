import type { useAppCore } from "./useAppCore";
import type { useAppWiring } from "./useAppWiring";
import type { useAppComposer } from "./useAppComposer";
import type { AppForwarded } from "./appForwarded";
import type { PendingTurnAction } from "./useAppModel";
import { capabilityBadgeKey, createCapabilityInstanceId, isComposerEmpty, maxAttachmentCount } from "./AppComposerHelpers";
import type {
  ChatAttachment,
} from "../types";
import type { MessageEditPayload } from "../features/chat/MessageEditBox";
import {
  selectRestorableQueuedEntries,
  type ClearedComposerQueue,
  type QueuedComposerEntry,
} from "../features/chat/queuedComposerText";
import { ComposerAttachment } from "./AttachmentHoverCard";
import { ComposerCapability } from "./AppComposerHelpers";
import { useCallback, useEffect, useMemo } from "react";

import { toAttachmentInputs } from "../features/chat/editorParts";

/**
 * 本段**之后**才声明的名字：只在延迟执行位置（回调/副作用里）用到 —— 类型直接 `Pick`
 * 后段返回类型（精确，不是 any）。它们每次 render 由 `deps` 重新赋值，
 * 所以 `deps.X` 读到的是当前 render 的值（比原来的闭包捕获更难过期）。
 */
type Later =
  Pick<AppForwarded, "clearEmptyComposerMarkers" | "createAttachmentBadgeNode" | "createCapabilityBadgeNode" | "readComposerParts">;


/**
 * 轮次动作：刷新 / 编辑 / 停止 / 排队恢复
 *
 * `useAppModel()` 顺序切出的第 4 段（原 body 语句 122–138，1375–1641 行）。
 *   · 本段**之前**声明的名字：从共享 `deps` 解构（拿到的是真值本身，闭包身份不变）。
 *   · 本段**之后**才声明的名字：就地写成 `deps.X`（只在延迟执行位置出现；读的是当前 render 的值）。
 * 段内语句一字未改 —— 正确性靠这一点，也靠 `tests/appModelSplit.test.ts` 的顺序与字段校验。
 *
 * 由 `.scratch/split-hook-segments.mjs` 机械搬出。
 */
export function useAppTurn(deps: ReturnType<typeof useAppCore> & ReturnType<typeof useAppWiring> & ReturnType<typeof useAppComposer> & Later) {
  // 前面几段已经写进 deps 的值。
  const {
    attachmentHoverGateRef, attachmentPreviewUrlsRef, composerAttachmentMapRef, composerCapabilityMapRef, composerEditorRef, composerSelectionRef,
    conversation, followLatestScroll, pendingTurnAction, setAttachmentHover, setAttachments, setComposerCapabilityCount,
    setComposerError, setComposerText, setEditingMessageId, setFailedEditText, setPendingTurnAction, state,
    stopTurn, submitEdit, t, visibleSessionPath,
  } = deps;

  // These two are passed to `ChatThread` and end up as the value of the inline
  // attachment context: a fresh identity per App render makes every user bubble
  // re-render on each keystroke in the composer (measured: 9 user renders per App
  // render, ~22 App renders/s while typing). They only close over `setState`,
  // which React already guarantees is stable, so an empty dep list is correct.
  const showAttachmentHover = useCallback((attachment: ChatAttachment, element: HTMLElement) => {
    setAttachmentHover({
      attachment,
      rect: element.getBoundingClientRect(),
    });
  }, []);

  const hideAttachmentHover = useCallback(() => {
    setAttachmentHover(null);
  }, []);

  // 上闸后的第一次 pointermove 才算"用户真的动了鼠标"：如果这时指针还在徽章上（新徽章不会
  // 再补发 mouseenter），就把预览补上，否则解除静默，等自然的 mouseenter。
  useEffect(() => {
    function handleAttachmentHoverPointerMove(event: PointerEvent) {
      const gate = attachmentHoverGateRef.current;
      if (!gate.isSuppressed() || !gate.releaseOnPointerMove()) {
        return;
      }

      const target = event.target as Element | null;
      const badge = target?.closest?.(".attachment-badge") as HTMLElement | null;
      const attachmentId = badge?.dataset.attachmentId;
      const attachment = attachmentId ? composerAttachmentMapRef.current.get(attachmentId) : undefined;
      if (attachment && badge) {
        showAttachmentHover(attachment, badge);
      }
    }

    window.addEventListener("pointermove", handleAttachmentHoverPointerMove);
    return () => window.removeEventListener("pointermove", handleAttachmentHoverPointerMove);
  }, [showAttachmentHover]);

  /**
   * 编辑 / 删除都作用于整轮。因为 pi 是线性 append-only 分支，回退到中间某一轮
   * 会把后面的轮次一起从当前分支拿掉；后面还有内容时先弹一次确认说清楚。
   */
  const lastUserMessageId = useMemo(() => {
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      if (conversation.messages[index].role === "user") {
        return conversation.messages[index].id;
      }
    }
    return null;
  }, [conversation.messages]);

  /**
   * 重新生成：不重传用户那轮的内容，直接用气泡里原样的 parts/附件再跑一遍。附件带着
   * `sourcePath`，服务端复用磁盘上那份，不要求客户端把字节读回来。
   */
  const runRefresh = useCallback(
    async (messageId: string) => {
      const userMessage = conversation.messages.find(
        (message) => message.id === messageId && message.role === "user",
      );
      if (!userMessage) {
        return;
      }
      setEditingMessageId(null);
      const attachmentInputs = await toAttachmentInputs(userMessage.attachments ?? [], () => undefined);
      await submitEdit(
        userMessage.id,
        userMessage.content,
        attachmentInputs,
        userMessage.contentParts ?? [],
      );
    },
    [conversation.messages, submitEdit],
  );

  const applyTurnAction = useCallback(
    (action: PendingTurnAction) => {
      setFailedEditText(null);
      if (action.kind === "edit") {
        setEditingMessageId(action.messageId);
        return;
      }
      void runRefresh(action.messageId);
    },
    [runRefresh],
  );

  const requestTurnAction = useCallback(
    (action: PendingTurnAction) => {
      if (state.isStreaming || state.isBootstrapping || state.isStopping) {
        return;
      }
      // 只有最后一轮能原地改/重生成；中间轮会连带移掉后面几轮，先让用户确认。
      if (action.messageId !== lastUserMessageId) {
        setPendingTurnAction(action);
        return;
      }
      applyTurnAction(action);
    },
    [applyTurnAction, lastUserMessageId, state.isBootstrapping, state.isStopping, state.isStreaming],
  );

  const startEditMessage = useCallback(
    (messageId: string) => requestTurnAction({ kind: "edit", messageId }),
    [requestTurnAction],
  );

  /**
   * assistant-ui 的 Reload 会把「这个回答前面那条消息」的 id 递过来，也就是同一轮的
   * `tN#user` 气泡。
   */
  const refreshMessage = useCallback(
    (parentMessageId: string) => {
      const userMessage = conversation.messages.find(
        (message) => message.id === parentMessageId && message.role === "user",
      );
      if (!userMessage || userMessage.provisional) {
        return;
      }
      requestTurnAction({ kind: "refresh", messageId: userMessage.id });
    },
    [conversation.messages, requestTurnAction],
  );

  const confirmTurnAction = useCallback(() => {
    const action = pendingTurnAction;
    setPendingTurnAction(null);
    if (action) {
      applyTurnAction(action);
    }
  }, [applyTurnAction, pendingTurnAction]);

  const cancelEditMessage = useCallback(() => {
    setEditingMessageId(null);
    setFailedEditText(null);
  }, []);

  const submitEditMessage = useCallback(
    async (messageId: string, payload: MessageEditPayload) => {
      // 和 composer 提交一样的节奏：点发送这一刻编辑框就消失、对话滚到底、那一轮
      // 立刻在屏幕上换成新内容 —— 等整段回答回来才关框，用户会看着编辑框悬在已经
      // 在流式的对话上面。
      setEditingMessageId(null);
      setFailedEditText(null);
      followLatestScroll(visibleSessionPath);
      const accepted = await submitEdit(messageId, payload.text, payload.attachments, payload.messageParts);
      if (accepted) {
        return true;
      }
      // 失败时和 composer 一样：把没发出去的文本放回去，别让用户白打一遍。
      // （带附件时不回填，附件字节已经随请求送走了，composer 也是这个规则。）
      if (!payload.attachments.length && payload.text.trim()) {
        setFailedEditText({ messageId, text: payload.text });
        setEditingMessageId(messageId);
      }
      setComposerError(t("composer.error.submitFailed"));
      return false;
    },
    [followLatestScroll, submitEdit, visibleSessionPath],
  );

  // 切会话时丢弃正在进行的编辑与确认（气泡已经不在了）。
  useEffect(() => {
    setEditingMessageId(null);
    setFailedEditText(null);
    setPendingTurnAction(null);
  }, [visibleSessionPath]);

  function syncComposerState() {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    const parts = deps.readComposerParts(editor);
    const nextAttachments = parts
      .filter((part): part is { kind: "attachment"; attachment: ComposerAttachment } => part.kind === "attachment")
      .map((part) => part.attachment);
    const nextText = parts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join("");

    setAttachments(nextAttachments);
    setComposerText(nextText);
    setComposerCapabilityCount(parts.filter((part) => part.kind === "capability").length);
    deps.clearEmptyComposerMarkers(editor, nextAttachments, nextText);
  }

  // pi TUI 对齐（interactive-mode.js 的 restoreQueuedMessagesToEditor）：中断时把服务端
  // clearQueue() 取出的未消费 steering / follow-up 退回编辑器；排队文本在前，已有文本在后。
  // 退回内容按本地排队气泡里的 parts 重建（徽标仍是徽标）；只有本地没有对应气泡时才
  // 退化成服务端原文。
  function restoreQueuedComposerMessages(cleared: ClearedComposerQueue) {
    const entries = selectRestorableQueuedEntries(cleared.entries ?? [], cleared);
    if (!entries.length) {
      return;
    }
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }
    composerSelectionRef.current = null;
    const fragment = document.createDocumentFragment();
    entries.forEach((entry, index) => {
      if (index > 0) {
        fragment.appendChild(document.createTextNode("\n\n"));
      }
      appendQueuedComposerEntry(fragment, entry);
    });
    if (!isComposerEmpty(editor)) {
      // 排队内容整体在前，编辑器已有内容在后（对齐 TUI）。
      fragment.appendChild(document.createTextNode("\n\n"));
    }
    editor.insertBefore(fragment, editor.firstChild);
    syncComposerState();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    editor.focus({ preventScroll: true });
  }

  /** 把一条本地排队消息写回编辑器：文本进文本节点，附件/技能还原成真的徽标。 */
  function appendQueuedComposerEntry(container: Node, entry: QueuedComposerEntry) {
    const parts = entry.parts?.length
      ? entry.parts
      : [{ kind: "text" as const, text: entry.text }];
    for (const part of parts) {
      if (part.kind === "text") {
        if (part.text) {
          container.appendChild(document.createTextNode(part.text));
        }
        continue;
      }
      if (part.kind === "attachment") {
        const attachment = entry.attachments?.find((candidate) => candidate.id === part.attachmentId);
        if (!attachment || composerAttachmentMapRef.current.size >= maxAttachmentCount) {
          continue;
        }
        const composerAttachment: ComposerAttachment = { ...attachment };
        composerAttachmentMapRef.current.set(composerAttachment.id, composerAttachment);
        if (composerAttachment.previewUrl) {
          attachmentPreviewUrlsRef.current.set(composerAttachment.id, composerAttachment.previewUrl);
        }
        container.appendChild(deps.createAttachmentBadgeNode(composerAttachment));
        continue;
      }
      if (part.capability.kind !== "skill") {
        // 编辑器目前只还原技能徽标（与 readComposerParts 的口径一致）。
        continue;
      }
      const capability: ComposerCapability = {
        id: part.capability.id,
        kind: "skill",
        name: part.capability.name,
        description: part.capability.description,
        active: true,
        instanceId: createCapabilityInstanceId(),
      };
      composerCapabilityMapRef.current.set(capabilityBadgeKey(capability), capability);
      container.appendChild(deps.createCapabilityBadgeNode(capability));
    }
  }

  async function handleStopTurn() {
    await stopTurn((cleared) => restoreQueuedComposerMessages(cleared));
  }

  return { appendQueuedComposerEntry, applyTurnAction, cancelEditMessage, confirmTurnAction, handleStopTurn, hideAttachmentHover, lastUserMessageId, refreshMessage, requestTurnAction, restoreQueuedComposerMessages, runRefresh, showAttachmentHover, startEditMessage, submitEditMessage, syncComposerState };
}
