import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { clampMatchIndex, findSequenceMatches } from "../../shared/sessionSearch";

/**
 * 任务内搜索（⌘F）的 DOM 侧实现。
 *
 * 走文本节点而不是消息模型：Markdown 渲染后 `**粗体**` 的星号并不在屏幕上，用模型
 * 偏移画高亮会错位，计数也会和用户看到的不一致。高亮用 CSS Custom Highlight API，
 * 不改 React 渲染出的 DOM —— 往 Markdown 里插 `<mark>` 会和 assistant-ui 的
 * reconcile 打架。
 *
 * 匹配 / 计数 / 导航这些「不碰 DOM 的算法」在 `src/shared/sessionSearch.ts`，这里有
 * 意只做「把节点读出来、把 Range 画上去」两件事。
 */

/** 高亮注册名的固定前缀，避免和扩展/其它功能撞名。 */
const HIGHLIGHT_ALL = "pi-session-search";
const HIGHLIGHT_ACTIVE = "pi-session-search-active";

/** 安全阀：异常大的会话不该让每次按键都遍历几十万个文本节点。 */
const MAX_TEXT_NODES = 20000;

/** 视口 owner 暴露给搜索的跳转能力（会同时撤销「跟随底部」）。 */
export interface ThreadViewportController {
  revealRange: (range: Range) => void;
}

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

function highlightRegistry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: unknown } }).CSS;
  const registry = css?.highlights as HighlightRegistry | undefined;
  return registry && typeof registry.set === "function" && typeof registry.delete === "function"
    ? registry
    : null;
}

function HighlightConstructor(): (new (...ranges: Range[]) => unknown) | null {
  return (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight ?? null;
}

function collectTextNodes(root: HTMLElement): Text[] {
  if (typeof document === "undefined" || typeof document.createTreeWalker !== "function") {
    return [];
  }
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue) {
        return NodeFilter.FILTER_REJECT;
      }
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA") {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    if (nodes.length >= MAX_TEXT_NODES) {
      break;
    }
    node = walker.nextNode();
  }
  return nodes;
}

function paintHighlights(ranges: Range[], active: Range | null) {
  const registry = highlightRegistry();
  const Highlight = HighlightConstructor();
  if (!registry || !Highlight) {
    return;
  }
  if (!ranges.length) {
    registry.delete(HIGHLIGHT_ALL);
    registry.delete(HIGHLIGHT_ACTIVE);
    return;
  }
  registry.set(HIGHLIGHT_ALL, new Highlight(...ranges));
  if (active) {
    registry.set(HIGHLIGHT_ACTIVE, new Highlight(active));
  } else {
    registry.delete(HIGHLIGHT_ACTIVE);
  }
}

export function useThreadSearch({
  viewportRef,
  sessionPath,
  query,
  activeIndex,
  controllerRef,
  onCountChange,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  sessionPath: string;
  query: string;
  activeIndex: number;
  controllerRef: RefObject<ThreadViewportController | null>;
  onCountChange: (count: number) => void;
}): void {
  const rangesRef = useRef<Range[]>([]);
  const lastCountRef = useRef(0);
  const [matchCount, setMatchCount] = useState(0);
  // 命中数量没变、但 Range 内容变了（流式回答重排了同一段文字）时，也要重画
  // 高亮 / 重新定位当前命中，所以给每次重算一个版本号。
  const [revision, setRevision] = useState(0);

  const recompute = useCallback(() => {
    const viewport = viewportRef.current;
    const needle = query.trim();
    if (!viewport || !needle) {
      rangesRef.current = [];
      if (lastCountRef.current !== 0) {
        lastCountRef.current = 0;
        setMatchCount(0);
        onCountChange(0);
      }
      return;
    }
    const nodes = collectTextNodes(viewport);
    const matches = findSequenceMatches(
      nodes.map((node) => node.nodeValue ?? ""),
      needle,
    );
    const ranges: Range[] = [];
    for (const match of matches) {
      const node = nodes[match.index];
      if (!node) {
        continue;
      }
      const range = document.createRange();
      range.setStart(node, match.start);
      range.setEnd(node, match.end);
      ranges.push(range);
    }
    rangesRef.current = ranges;
    setRevision((value) => value + 1);
    if (lastCountRef.current !== ranges.length) {
      lastCountRef.current = ranges.length;
      setMatchCount(ranges.length);
      onCountChange(ranges.length);
    }
  }, [onCountChange, query, viewportRef]);

  // 查询 / 会话变化：立刻重算一次，并在搜索期间跟着 DOM 变化（流式回答正在写入）
  // 节流重算 —— 不订阅的话，新写进来的正文永远搜不到。
  useEffect(() => {
    recompute();
    const viewport = viewportRef.current;
    if (!viewport || !query.trim()) {
      return undefined;
    }
    let frame = 0;
    const schedule = () => {
      if (frame) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) {
        cancelAnimationFrame(frame);
      }
    };
  }, [query, sessionPath, recompute, viewportRef]);

  // 选中位置变化：重画高亮，并把当前命中滚进视口。
  useEffect(() => {
    const ranges = rangesRef.current;
    const index = clampMatchIndex(activeIndex, ranges.length);
    const active = index >= 0 ? ranges[index] : null;
    paintHighlights(ranges, active);
    if (active) {
      controllerRef.current?.revealRange(active);
    }
  }, [activeIndex, controllerRef, matchCount, query, revision]);

  // 关闭搜索 / 卸载时清掉高亮，别把 `::highlight` 永久留在页面上。
  useEffect(
    () => () => {
      rangesRef.current = [];
      lastCountRef.current = 0;
      paintHighlights([], null);
    },
    [],
  );
}