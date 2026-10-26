import { useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useMemo, useRef } from "react";

import {
  AssistantMessage,
  UserMessage,
} from "../../components/assistant-ui/elements/thread.aui";
import type { ToolCallLike } from "../../shared/turnChangedFiles";
import type {
  CapabilitiesState,
  ChatAttachment,
  ChatMessagePart,
} from "../../types";
import { MessageEditBox, type MessageEditPayload } from "./MessageEditBox";
import { TurnChangedFiles } from "./TurnChangedFiles";

/**
 * `ChatThread` 的两条消息槽（用户气泡 / 助手气泡）与它们背后的两个 context。
 *
 * 抽出来只有一个理由：`ChatThread.tsx` 被 `max-lines` 棘轮冻着（不许再长），而这两个槽
 * 必须留在**模块级** —— `ThreadPrimitive.Messages` 按 `components` 对象的身份 bail out，
 * 定义在组件内部会每次 render 换类型、整棵消息列表重挂（见 ChatThread 里那段注释）。
 * 纯搬家：JSX 与 context 语义一字未改。
 */

/** 行内编辑（用户气泡）的状态；`null` = 这一行不在编辑。 */
export type EditController = {
  editingMessageId: string | null;
  capabilities: Pick<CapabilitiesState, "skills" | "packages">;
  canSubmit: boolean;
  /** Text to seed a reopened editor with, after a failed send. */
  draftText?: string;
  onCancel: () => void;
  onSubmit: (messageId: string, payload: MessageEditPayload) => Promise<boolean>;
};

export const ChatThreadEditContext = createContext<EditController | null>(null);

/**
 * User bubble slot: the ordinary bubble, or the inline editor when this message
 * is the one being edited. Kept at module scope so `ThreadPrimitive.Messages`
 * can keep bailing out on a stable `components` object.
 */
export function UserMessageSlot() {
  const edit = useContext(ChatThreadEditContext);
  const messageId = useAuiState((s) => s.message.id);
  const custom = useAuiState((s) => s.message.metadata.custom);

  if (!edit || edit.editingMessageId !== messageId) {
    return <UserMessage />;
  }

  const parts = Array.isArray(custom?.piDesktopInlineParts)
    ? (custom.piDesktopInlineParts as ChatMessagePart[])
    : [];
  const attachments = Array.isArray(custom?.piDesktopInlineAttachments)
    ? (custom.piDesktopInlineAttachments as ChatAttachment[])
    : [];
  const fallbackText = typeof custom?.piDesktopInlineText === "string" ? custom.piDesktopInlineText : "";

  return (
    <MessageEditBox
      key={messageId}
      messageId={messageId}
      parts={parts}
      attachments={attachments}
      fallbackText={fallbackText}
      capabilities={edit.capabilities}
      canSubmit={edit.canSubmit}
      draftText={edit.draftText}
      onCancel={edit.onCancel}
      onSubmit={edit.onSubmit}
    />
  );
}

/** 「这一轮改了哪些文件」面板里那三个动作。 */
export type ChangedFileActions = {
  workspaceRoot: string;
  onOpenDiff: (path: string) => void;
  onOpenContent: (path: string) => void;
  onOpenInIde: (path: string) => void;
};

/**
 * 「这一轮改了哪些文件」那三个动作走 context 而不是 props：`MESSAGE_COMPONENTS` 必须是
 * 模块级常量（见 ChatThread 里的注释），行组件拿不到 props。
 */
export const ChatThreadChangedFilesContext = createContext<ChangedFileActions | null>(null);

/**
 * 助手气泡 + 底下的「N 个文件已更改」。
 *
 * 面板只在**这一轮结束后**渲染：流式途中工具还在跑，列表会一行行往外蹦（滚动位置跟着跳），
 * 而且那时的 diff 也不完整。判断用状态而不是「有没有正在跑的工具卡」——后者在两次工具调用
 * 之间会短暂为假，面板就会闪。
 */
export function AssistantMessageSlot() {
  const actions = useContext(ChatThreadChangedFilesContext);
  const parts = useAuiState((s) => s.message.parts);
  const isRunning = useAuiState((s) => s.message.status?.type === "running");

  return (
    <>
      <AssistantMessage />
      {actions && !isRunning ? (
        <TurnChangedFiles
          parts={parts as readonly ToolCallLike[]}
          workspaceRoot={actions.workspaceRoot}
          onOpenDiff={actions.onOpenDiff}
          onOpenContent={actions.onOpenContent}
          onOpenInIde={actions.onOpenInIde}
        />
      ) : null}
    </>
  );
}

/**
 * 把宿主传进来的三个回调稳定成 context value。
 *
 * 三个回调每次 App render 都是新函数（宿主里是内联箭头）。直接把它们放进 context 的
 * value 会让**每一行助手气泡**在每次 App render 时重渲染（记过：一次 App render 已经
 * 牵动 9 个气泡）。所以 value 的恒定性靠自己保证：三个包装函数建一次就不变，
 * 真正的实现塞在 ref 里（render 期间写入是有意的 —— 用 effect 写会让首帧的点击落空）。
 */
export function useChangedFileActions({
  onChangedFileDiff,
  onChangedFileContent,
  onChangedFileInIde,
  workspaceRoot,
}: {
  onChangedFileDiff?: (path: string) => void;
  onChangedFileContent?: (path: string) => void;
  onChangedFileInIde?: (path: string) => void;
  workspaceRoot: string;
}): ChangedFileActions | null {
  const changedFileActionsRef = useRef<Omit<ChangedFileActions, "workspaceRoot"> | null>(null);
  const hasChangedFileActions = Boolean(onChangedFileDiff && onChangedFileContent && onChangedFileInIde);
  changedFileActionsRef.current = hasChangedFileActions
    ? {
        onOpenDiff: onChangedFileDiff as (path: string) => void,
        onOpenContent: onChangedFileContent as (path: string) => void,
        onOpenInIde: onChangedFileInIde as (path: string) => void,
      }
    : null;

  return useMemo(
    () =>
      hasChangedFileActions
        ? {
            // 项目根是字符串（只在切项目时变），可以直接进 value；三个回调走 ref 保持恒定。
            workspaceRoot,
            onOpenDiff: (path: string) => changedFileActionsRef.current?.onOpenDiff(path),
            onOpenContent: (path: string) => changedFileActionsRef.current?.onOpenContent(path),
            onOpenInIde: (path: string) => changedFileActionsRef.current?.onOpenInIde(path),
          }
        : null,
    [hasChangedFileActions, workspaceRoot],
  );
}