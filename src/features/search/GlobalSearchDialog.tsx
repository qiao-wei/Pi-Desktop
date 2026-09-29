import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CornerDownLeft, Loader2, Search, SearchX, X } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n/react";
import { splitByMatches, type SessionSearchResult } from "../../shared/sessionSearch";
import { searchGlobalSessions } from "./globalSearch";
import { useImeSafeInput } from "./useImeSafeInput";

/**
 * 全局搜索面板（⌘K / Ctrl+K）。
 *
 * 服务端跨项目扫会话文件；这里负责防抖请求（后发请求作废先发的）、按会话分组渲染、
 * 键盘上下选。片段用与匹配同一套 `splitByMatches` 高亮，保证「高亮的字」就是命中的字。
 *
 * 中文输入法组字期间不发请求，选词落定（compositionend）后才搜。
 */

/** 输入后多久发请求。太短会在每个字母上扫一遍文件，太长又显得迟钝。 */
const SEARCH_DEBOUNCE_MS = 200;

interface ResultGroup {
  key: string;
  projectName: string;
  sessionTitle: string;
  items: Array<{ result: SessionSearchResult; index: number }>;
}

export function GlobalSearchDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (result: SessionSearchResult) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // 请求序号：晚到的响应不能覆盖新查询的结果。
  const requestSeq = useRef(0);
  const input = useImeSafeInput({ value: query, onCommit: setQuery });

  // 每次打开都从干净状态开始：上次的查询和结果留着只会让人以为搜过了。
  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setResults([]);
    setTruncated(false);
    setActiveIndex(0);
    setLoading(false);
    requestSeq.current += 1;
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setTruncated(false);
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      const seq = (requestSeq.current += 1);
      searchGlobalSessions(trimmed, { signal: controller.signal })
        .then((response) => {
          if (seq !== requestSeq.current) {
            return;
          }
          setResults(response.results);
          setTruncated(response.truncated);
          setActiveIndex(0);
          setLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted || seq !== requestSeq.current) {
            return;
          }
          setResults([]);
          setTruncated(false);
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  // 选中行始终留在视口里（键盘走到列表外时把它滚进来）。
  useEffect(() => {
    rowRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results]);

  // 同一会话的命中合成一组，会话标题只出现一次，比每行重复「项目 › 会话」干净得多。
  const groups = useMemo<ResultGroup[]>(() => {
    const map = new Map<string, ResultGroup>();
    results.forEach((result, index) => {
      const key = `${result.projectId}:${result.sessionPath}`;
      const existing = map.get(key);
      if (existing) {
        existing.items.push({ result, index });
        return;
      }
      map.set(key, {
        key,
        projectName: result.projectName,
        sessionTitle: result.sessionTitle,
        items: [{ result, index }],
      });
    });
    return [...map.values()];
  }, [results]);

  const active = results[activeIndex] ?? null;
  const trimmed = query.trim();
  const showEmptyState = !loading && trimmed.length > 0 && results.length === 0;

  function handleSelect(result: SessionSearchResult) {
    onSelect(result);
    onOpenChange(false);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // 组字中 Enter/↑↓ 属于输入法，不要拿去选结果。
    if (event.nativeEvent.isComposing || input.isComposing()) {
      return;
    }
    if (!results.length) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (active) {
        handleSelect(active);
      }
    }
  }

  const footer = loading
    ? t("search.global.searching")
    : !trimmed
      ? t("search.global.hint")
      : results.length === 0
        ? t("search.global.empty")
        : truncated
          ? t("search.global.truncated", { count: results.length })
          : t("search.global.resultCount", { count: results.length });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[9%] w-[min(680px,calc(100vw-2rem))] translate-y-0 gap-0 overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-[var(--app-shadow-dialog)] sm:max-w-none"
        // 面板本体是搜索框，点内容区不该把焦点交给 Dialog 自己。
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">{t("search.global.title")}</DialogTitle>

        {/* 头部：无边框输入，像命令面板而不是表单。 */}
        <div className="flex items-center gap-2.5 border-b px-4 py-3">
          <Search className="size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={input.value}
            onChange={input.onChange}
            onCompositionStart={input.onCompositionStart}
            onCompositionEnd={input.onCompositionEnd}
            onKeyDown={handleKeyDown}
            placeholder={t("search.global.placeholder")}
            aria-label={t("search.global.placeholder")}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground/80"
          />
          {loading ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : (
            <kbd className="hidden shrink-0 rounded border px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground sm:inline-block">
              Esc
            </kbd>
          )}
          <button
            type="button"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:hidden"
            onClick={() => onOpenChange(false)}
            aria-label={t("search.global.close")}
            title={t("search.global.close")}
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="max-h-[56vh] min-h-[120px] overflow-y-auto p-1.5" role="listbox" aria-label={t("search.global.title")}>
          {showEmptyState ? (
            <div className="flex h-[160px] flex-col items-center justify-center gap-2 text-muted-foreground">
              <SearchX className="size-6 opacity-70" aria-hidden="true" />
              <span className="text-[12.5px]">{t("search.global.empty")}</span>
            </div>
          ) : null}

          {!trimmed ? (
            <div className="flex h-[160px] flex-col items-center justify-center gap-1.5 text-muted-foreground">
              <Search className="size-6 opacity-60" aria-hidden="true" />
              <span className="text-[12.5px]">{t("search.global.hint")}</span>
            </div>
          ) : null}

          {groups.map((group) => (
            <div key={group.key} className="mb-1 last:mb-0">
              <div className="sticky top-0 z-10 -mx-1.5 flex items-center gap-1.5 bg-popover/95 px-4 py-1.5 text-[11px] backdrop-blur">
                <span className="shrink-0 font-medium text-foreground">{group.projectName}</span>
                <span className="shrink-0 text-muted-foreground/60" aria-hidden="true">
                  ›
                </span>
                <span className="min-w-0 truncate text-muted-foreground">{group.sessionTitle}</span>
              </div>
              <div className="flex flex-col">
                {group.items.map(({ result, index }) => (
                  <SearchResultRow
                    key={`${group.key}:${result.messageId ?? "title"}:${index}`}
                    result={result}
                    query={query}
                    active={index === activeIndex}
                    rowRef={(node) => {
                      rowRefs.current[index] = node;
                    }}
                    onHover={() => setActiveIndex(index)}
                    onSelect={() => handleSelect(result)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5 text-[11.5px] text-muted-foreground">
          <span className="min-w-0 truncate">{footer}</span>
          <span className="hidden shrink-0 items-center gap-3 sm:flex">
            <span className="flex items-center gap-1">
              <kbd className="rounded border px-1.5 py-0.5 font-sans text-[10px]">↑</kbd>
              <kbd className="rounded border px-1.5 py-0.5 font-sans text-[10px]">↓</kbd>
              <span>{t("search.global.selectHint")}</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="flex items-center rounded border px-1 py-0.5 font-sans text-[10px]">
                <CornerDownLeft className="size-3" />
              </kbd>
              <span>{t("search.global.openHint")}</span>
            </span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SearchResultRow({
  result,
  query,
  active,
  rowRef,
  onHover,
  onSelect,
}: {
  result: SessionSearchResult;
  query: string;
  active: boolean;
  rowRef: (node: HTMLButtonElement | null) => void;
  onHover: () => void;
  onSelect: () => void;
}) {
  const t = useT();
  const segments = splitByMatches(result.snippet, query);
  return (
    <button
      ref={rowRef}
      type="button"
      role="option"
      aria-selected={active}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      onMouseMove={onHover}
      onMouseEnter={onHover}
      onClick={onSelect}
    >
      {result.kind === "title" ? (
        <span className="mt-0.5 shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] whitespace-nowrap text-muted-foreground">
          {t("search.global.titleMatch")}
        </span>
      ) : null}
      <span className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-relaxed break-words text-foreground/90">
        {segments.map((segment, index) =>
          segment.match ? (
            <mark
              key={index}
              className="rounded-[3px] bg-[var(--app-warning-border)] px-0.5 font-medium text-[var(--app-warning-ink)]"
            >
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </span>
    </button>
  );
}