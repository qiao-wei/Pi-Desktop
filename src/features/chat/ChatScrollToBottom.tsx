/**
 * 「回到最新」浮标。
 *
 * 单独成文件只是为了让 `ChatThread.tsx` 留出行数额度；行为完全没变。
 */
import { ArrowDownIcon } from "lucide-react";
import { useThreadViewport, useThreadViewportStore } from "@assistant-ui/react";

export function CustomScrollToBottom() {
  const isAtBottom = useThreadViewport((state) => state.isAtBottom);
  const store = useThreadViewportStore();
  
  return (
    <button
      className="aui-scroll-to-bottom"
      data-visible={!isAtBottom}
      onClick={() => store.getState().scrollToBottom()}
      aria-label="Scroll to latest message"
    >
      {/* 线宽走 `--app-icon-stroke`（styles.css 的 svg.lucide 规则），不在图标上覆写。 */}
      <ArrowDownIcon size={18} />
    </button>
  );
}
