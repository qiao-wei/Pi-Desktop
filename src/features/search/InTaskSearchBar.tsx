import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { useT } from "../../i18n/react";
import { useImeSafeInput } from "./useImeSafeInput";

/**
 * 会话内搜索的浮动小条（⌘F）。
 *
 * 绝对定位在消息区上方，不占布局；宽度固定，计数出现 / 数字变化都不会让整条伸长
 * （右侧锚定，一伸长就会往左窜）。
 */
export function InTaskSearchBar({
  query,
  count,
  activeIndex,
  onQueryChange,
  onStep,
  onClose,
}: {
  query: string;
  count: number;
  activeIndex: number;
  onQueryChange: (query: string) => void;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const input = useImeSafeInput({ value: query, onCommit: onQueryChange });

  // 打开即聚焦（⌘F 的典型用法是直接打字）。
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // 组字中 Enter/Esc 属于输入法：确认候选 / 取消组字，不要当成导航或关闭。
    if (event.nativeEvent.isComposing || input.isComposing()) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onStep(event.shiftKey ? -1 : 1);
    }
  }

  /**
   * Escape 挂在容器而不是 input 上：用鼠标点过「上一个 / 下一个」之后焦点在按钮上，
   * input 的 keydown 收不到，Esc 就会失效。
   */
  function handleBarKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  const trimmed = query.trim();
  const counter = trimmed
    ? count > 0
      ? t("search.inTask.count", { index: activeIndex + 1, total: count })
      : t("search.inTask.noMatch")
    : "";

  return (
    <div className="in-task-search-bar" role="search" onKeyDown={handleBarKeyDown}>
      <Search className="in-task-search-bar-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        value={input.value}
        onChange={input.onChange}
        onCompositionStart={input.onCompositionStart}
        onCompositionEnd={input.onCompositionEnd}
        onKeyDown={handleKeyDown}
        placeholder={t("search.inTask.placeholder")}
        aria-label={t("search.inTask.placeholder")}
        autoComplete="off"
        spellCheck={false}
        className="in-task-search-bar-input"
      />
      {/* 始终占位：有/无计数、位数变化都不改布局。 */}
      <span className="in-task-search-bar-count" aria-live="polite">
        {counter}
      </span>
      <button
        type="button"
        className="in-task-search-bar-button"
        onClick={() => {
          onStep(-1);
          inputRef.current?.focus();
        }}
        disabled={count <= 0}
        aria-label={t("search.inTask.prev")}
        title={t("search.inTask.prev")}
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        type="button"
        className="in-task-search-bar-button"
        onClick={() => {
          onStep(1);
          inputRef.current?.focus();
        }}
        disabled={count <= 0}
        aria-label={t("search.inTask.next")}
        title={t("search.inTask.next")}
      >
        <ChevronDown className="size-4" />
      </button>
      <button
        type="button"
        className="in-task-search-bar-button"
        onClick={onClose}
        aria-label={t("search.inTask.close")}
        title={t("search.inTask.close")}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}