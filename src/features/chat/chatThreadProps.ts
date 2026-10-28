/**
 * `ChatThread` 的入参与视口状态。单独成文件是为了让 `ChatThread.tsx` 留出行数额度。
 */
import type { CapabilitiesState, ChatAttachment, ChatMessage } from "../../types";
import type { MessageEditPayload } from "./MessageEditBox";

export type ChatThreadProps = {
  messages: ChatMessage[];
  isStreaming: boolean;
  sessionPath: string;
  viewportStates: Map<string, ViewportState>;
  onAttachmentHoverStart?: (attachment: ChatAttachment, element: HTMLElement) => void;
  onAttachmentHoverEnd?: () => void;
  editingMessageId?: string | null;
  capabilities?: Pick<CapabilitiesState, "skills" | "packages">;
  /** Set when a send failed, so the reopened editor keeps what was typed. */
  editDraftText?: string | null;
  onStartEditMessage?: (messageId: string) => void;
  onReloadMessage?: (parentMessageId: string) => void | Promise<void>;
  onCancelEditMessage?: () => void;
  onSubmitEditMessage?: (messageId: string, payload: MessageEditPayload) => Promise<boolean>;
  /** 任务内搜索的查询词；空串 = 未开启。高亮 / 计数 / 滚动都在线程内部完成。 */
  searchQuery?: string;
  searchActiveIndex?: number;
  /** 命中数量回传，供浮动小条显示「第 N / 共 M」。 */
  onSearchCountChange?: (count: number) => void;
  /**
   * 「N 个文件已更改」面板里的文件动作。三个都是可选的：没有宿主（比如只读回放）时
   * 面板干脆不出现，而不是给几个点了没反应的按钮。
   */
  onChangedFileDiff?: (path: string) => void;
  onChangedFileContent?: (path: string) => void;
  onChangedFileInIde?: (path: string) => void;
  /** 当前项目根（把工具参数里的绝对路径折成相对路径）。 */
  workspaceRoot?: string;
  /** 快照窗口之前还有更早的历史（服务端 `conversation.hasMoreBefore`）。 */
  hasMoreBefore?: boolean;
  /** 正在取上一页：按钮转成 disabled，避免同一页被连点。 */
  loadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
};

export type ViewportState = {
  scrollTop: number;
  shouldFollow: boolean;
};

