/**
 * 会话搜索的纯逻辑：全局搜索的两端（服务端扫会话文件、前端渲染结果）共用同一套
 * 匹配 / 片段 / 计数规则，保证「高亮的字」和「匹配到的字」不会各算各的。
 *
 * 刻意保持无 DOM、无 Node 依赖：服务端 `server/sessionSearch.mjs` 和浏览器都能导入，
 * `tests/sessionSearch.test.ts` 直接对着它跑。
 */

export interface TextMatchRange {
  start: number;
  end: number;
}

export interface SessionSearchMessage {
  /** 稳定的气泡 id（`t3#user` / `t4#assistant`），前端靠它滚到命中消息。 */
  bubbleId: string;
  role: "user" | "assistant";
  text: string;
}

export interface SessionSearchDocument {
  projectId: string;
  projectName: string;
  sessionPath: string;
  sessionTitle: string;
  updatedAt: number;
  messages: readonly SessionSearchMessage[];
}

export type SessionSearchResultKind = "title" | "message";

export interface SessionSearchResult {
  kind: SessionSearchResultKind;
  projectId: string;
  projectName: string;
  sessionPath: string;
  sessionTitle: string;
  updatedAt: number;
  /** 命中消息的气泡 id；标题命中时为 null（只切会话、不滚动）。 */
  messageId: string | null;
  role: "user" | "assistant" | null;
  snippet: string;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  truncated: boolean;
}

/** 去掉首尾空白；空串表示「不搜」。 */
export function normalizeSearchQuery(query: string | null | undefined): string {
  return String(query ?? "").trim();
}

/**
 * 所有非重叠命中，大小写不敏感。`limit` 让「只想知道有没有」的调用方不必扫完整串。
 */
export function findMatchRanges(text: string, query: string, limit = Number.POSITIVE_INFINITY): TextMatchRange[] {
  const needle = normalizeSearchQuery(query).toLowerCase();
  if (!needle || !text) {
    return [];
  }
  const haystack = text.toLowerCase();
  const ranges: TextMatchRange[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) {
      break;
    }
    ranges.push({ start: found, end: found + needle.length });
    if (ranges.length >= limit) {
      break;
    }
    // 命中之间不重叠：从命中末尾继续，`aaaa` 里搜 `aa` 只算一处。
    from = found + needle.length;
  }
  return ranges;
}

export function hasMatch(text: string, query: string): boolean {
  return findMatchRanges(text, query, 1).length > 0;
}

/**
 * 命中附近的一小段上下文。偏移量在**原文**上算，最后才把空白折成单个空格，
 * 否则换行/缩进会把 `…` 的位置算错。
 */
export function buildSnippet(text: string, range: TextMatchRange, radius = 60): string {
  const start = Math.max(0, range.start - radius);
  const end = Math.min(text.length, range.end + radius);
  const body = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** 把一段文本按命中切成「普通 / 命中」片段，供前端渲染 `<mark>`。 */
export function splitByMatches(text: string, query: string, limit = Number.POSITIVE_INFINITY): HighlightSegment[] {
  const ranges = findMatchRanges(text, query, limit);
  if (!ranges.length) {
    return text ? [{ text, match: false }] : [];
  }
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), match: false });
    }
    segments.push({ text: text.slice(range.start, range.end), match: true });
    cursor = range.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), match: false });
  }
  return segments;
}

/**
 * 一份会话文档里只保留「第一条」命中：结果是「项目 › 会话 › 片段」，同一会话同一
 * 条消息出现十次不该占十行（同一消息里的多次命中由前端在片段里一起高亮）。
 */
export function searchDocuments(
  documents: readonly SessionSearchDocument[],
  query: string,
  options: { limit?: number } = {},
): SessionSearchResponse {
  const needle = normalizeSearchQuery(query);
  if (!needle) {
    return { results: [], truncated: false };
  }
  const rawLimit = Number(options.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 30;
  const results: SessionSearchResult[] = [];
  let truncated = false;

  const push = (result: SessionSearchResult) => {
    if (results.length >= limit) {
      truncated = true;
      return false;
    }
    results.push(result);
    return true;
  };

  for (const document of documents) {
    const base = {
      projectId: document.projectId,
      projectName: document.projectName,
      sessionPath: document.sessionPath,
      sessionTitle: document.sessionTitle,
      updatedAt: document.updatedAt,
    };
    const titleRange = findMatchRanges(document.sessionTitle, needle, 1)[0];
    if (titleRange) {
      const ok = push({
        ...base,
        kind: "title",
        messageId: null,
        role: null,
        snippet: buildSnippet(document.sessionTitle, titleRange),
      });
      if (!ok) {
        break;
      }
    }
    for (const message of document.messages) {
      const range = findMatchRanges(message.text, needle, 1)[0];
      if (!range) {
        continue;
      }
      const ok = push({
        ...base,
        kind: "message",
        messageId: message.bubbleId,
        role: message.role,
        snippet: buildSnippet(message.text, range),
      });
      if (!ok) {
        break;
      }
    }
    if (truncated) {
      break;
    }
  }

  return { results, truncated };
}

/* -------------------------------------------------------------------------- */
/* 任务内搜索（当前会话的可见正文）                                            */
/* -------------------------------------------------------------------------- */

export interface SequenceMatch {
  /** 命中落在第几个文本块（DOM 里就是第几个文本节点）。 */
  index: number;
  start: number;
  end: number;
}

/**
 * 在一串**已按文档顺序排好**的文本块里找全部命中。
 *
 * 任务内搜索走 DOM 文本节点而不是消息模型：Markdown 渲染后 `**粗体**` 的星号并不
 * 出现在屏幕上，用模型偏移去画高亮会错位。计数与导航因此都以「屏幕上真正读到的字」
 * 为准。
 */
export function findSequenceMatches(texts: readonly string[], query: string): SequenceMatch[] {
  const needle = normalizeSearchQuery(query).toLowerCase();
  if (!needle) {
    return [];
  }
  const matches: SequenceMatch[] = [];
  texts.forEach((text, index) => {
    for (const range of findMatchRanges(text, needle)) {
      matches.push({ index, start: range.start, end: range.end });
    }
  });
  return matches;
}

/** 上下跳，越界时回绕；没有命中时返回 -1。 */
export function stepMatchIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) {
    return -1;
  }
  const normalized = ((current % total) + total) % total;
  return (normalized + direction + total) % total;
}

/** 结果数量变化（继续流式输出 / 换查询）后把选中位置夹回有效范围。 */
export function clampMatchIndex(current: number, total: number): number {
  if (total <= 0) {
    return -1;
  }
  if (current < 0) {
    return 0;
  }
  return current >= total ? total - 1 : current;
}