/**
 * 快照窗口之前的历史：按页取回。
 *
 * 服务端只发尾部窗口（`CONVERSATION_TAIL_TURNS`，对齐 ZCode 的 `snapshotTailWindowRows`），
 * 所以"更早的对话"不在内存里，要按 `oldestTurn` 往前翻页。三条不变量：
 *
 * - **一次只发一个请求**：滚动到顶的每一帧都会触发，不去重就会同时发十几个请求、
 *   并把同一页 prepend 多次。
 * - **按 `oldestTurn` 翻，不看本地列表长度**：本地可能还留着"窗口外的旧气泡"
 *   （`mergeChatBubbles` 会保留它们），长度会骗人。
 * - **失败不改状态**：游标停在原地，用户可以再试；挪了游标就会跳页。
 */
import { useRef, useState } from "react";
import { fetchSessionMessages } from "../../lib/api";
import { perfMark } from "../../lib/perf";
import type { BootstrapResponse } from "../../lib/api";
import type { ChatMessage } from "../../types";

export interface OlderMessagesPage {
  messages: ChatMessage[];
  oldestTurn: number;
  hasMoreBefore: boolean;
}

export function useOlderMessagePaging(
  bootstrap: BootstrapResponse,
  options: {
    dispatchPage: (action: OlderMessagesPage & { type: "prepend-session-messages"; sessionPath: string }) => void;
    reportError: (message: string) => void;
  },
) {
  const inFlightRef = useRef(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);

  async function loadOlderMessages() {
    if (inFlightRef.current) {
      return;
    }
    const conversation = bootstrap.snapshot.conversation;
    const oldestTurn = conversation.oldestTurn ?? 1;
    if (!conversation.hasMoreBefore || oldestTurn <= 1) {
      return;
    }
    const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile ?? "";
    inFlightRef.current = true;
    setLoadingOlderMessages(true);
    try {
      const page = await fetchSessionMessages({ beforeTurn: oldestTurn });
      options.dispatchPage({
        type: "prepend-session-messages",
        sessionPath,
        messages: page.messages,
        oldestTurn: page.oldestTurn,
        hasMoreBefore: page.hasMoreBefore,
      });
      perfMark("chat.loadOlder", page.messages.length);
    } catch (error) {
      options.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlightRef.current = false;
      setLoadingOlderMessages(false);
    }
  }

  return { loadOlderMessages, loadingOlderMessages };
}