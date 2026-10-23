import type { useAppCore } from "./useAppCore";
import type { useAppWiring } from "./useAppWiring";
import type { useAppComposer } from "./useAppComposer";
import type { useAppTurn } from "./useAppTurn";
import type { useAppComposerEditing } from "./useAppComposerEditing";
import type { useAppCaretSync } from "./useAppCaretSync";
import {
  clampMatchIndex,
  stepMatchIndex,
  type SessionSearchResult,
} from "../shared/sessionSearch";
import { useCallback, useEffect } from "react";
import { chatJumpBus } from "../shared/chatJumpBus";
import { markThreadSwitch } from "../components/assistant-ui/elements/thread.aui";


/**
 * 会话内搜索、全局搜索与上下文面板开关
 *
 * `useAppModel()` 顺序切出的第 7 段（原 body 语句 173–181，2406–2486 行）。
 *   · 本段**之前**声明的名字：从共享 `deps` 解构（拿到的是真值本身，闭包身份不变）。
 *   · 本段**之后**才声明的名字：就地写成 `deps.X`（只在延迟执行位置出现；读的是当前 render 的值）。
 * 段内语句一字未改 —— 正确性靠这一点，也靠 `tests/appModelSplit.test.ts` 的顺序与字段校验。
 *
 * 由 `.scratch/split-hook-segments.mjs` 机械搬出。
 */
export function useAppSearch(deps: ReturnType<typeof useAppCore> & ReturnType<typeof useAppWiring> & ReturnType<typeof useAppComposer> & ReturnType<typeof useAppTurn> & ReturnType<typeof useAppComposerEditing> & ReturnType<typeof useAppCaretSync>) {
  // 前面几段已经写进 deps 的值。
  const {
    activeMainView, inTaskMatchCount, selectSession, setActiveMainView, setGlobalSearchOpen, setInTaskMatchCount,
    setInTaskSearch, visibleSessionPath,
  } = deps;

  const closeInTaskSearch = useCallback(() => {
    setInTaskSearch({ open: false, query: "", activeIndex: 0 });
    setInTaskMatchCount(0);
  }, []);

  const openInTaskSearch = useCallback(() => {
    setInTaskSearch((state) => (state.open ? state : { open: true, query: "", activeIndex: 0 }));
    setInTaskMatchCount(0);
  }, []);

  const handleInTaskSearchQueryChange = useCallback((query: string) => {
    setInTaskSearch((state) => ({ ...state, open: true, query, activeIndex: 0 }));
  }, []);

  const handleInTaskSearchCount = useCallback((count: number) => {
    setInTaskMatchCount(count);
    setInTaskSearch((state) =>
      state.open ? { ...state, activeIndex: clampMatchIndex(state.activeIndex, count) } : state,
    );
  }, []);

  const stepInTaskSearch = useCallback(
    (direction: 1 | -1) => {
      setInTaskSearch((state) =>
        state.open ? { ...state, activeIndex: stepMatchIndex(state.activeIndex, inTaskMatchCount, direction) } : state,
      );
    },
    [inTaskMatchCount],
  );

  // 切会话就收起会话内搜索：高亮属于上一条会话的 DOM，留着只会让人以为新会话也搜过了。
  useEffect(() => {
    closeInTaskSearch();
  }, [visibleSessionPath, closeInTaskSearch]);

  // 全局 ⌘K（Ctrl+K）/ ⌘F（Ctrl+F）。捕获阶段拦住 ⌘F，否则浏览器/Electron 会先开
  // 原生「在页面中查找」。
  useEffect(() => {
    function handleSearchShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setGlobalSearchOpen((open) => !open);
        return;
      }
      if (key === "f") {
        event.preventDefault();
        setGlobalSearchOpen(false);
        openInTaskSearch();
      }
    }

    window.addEventListener("keydown", handleSearchShortcut, true);
    return () => window.removeEventListener("keydown", handleSearchShortcut, true);
  }, [openInTaskSearch]);

  async function handleGlobalSearchSelect(result: SessionSearchResult) {
    // 结果可能在「全局技能与扩展」页上被点中，先切回会话视图，否则切了会话也看不见。
    setActiveMainView("chat");
    // 目标会话的消息全是历史，不该重放进入动画（和侧栏切会话同一处理）。
    markThreadSwitch();
    try {
      await selectSession(result.projectId, result.sessionPath);
    } catch {
      // `selectSession` 内部已把错误写进 state，这里不再重复报错。
      return;
    }
    if (!result.messageId) {
      return;
    }
    // 切会话是异步的，目标线程此刻可能还没挂载；总线会把请求暂存到它订阅为止，
    // 挂载后视口 owner 会滚到这条消息并闪一下。
    chatJumpBus.request(result.sessionPath, result.messageId, "global-search");
  }

  // The context panel lists what *this conversation* pulls in, so the full-width
  // Global skills & packages page has no right panel next to it.
  const showContextPanel = activeMainView === "chat";

  return { closeInTaskSearch, handleGlobalSearchSelect, handleInTaskSearchCount, handleInTaskSearchQueryChange, openInTaskSearch, showContextPanel, stepInTaskSearch };
}
