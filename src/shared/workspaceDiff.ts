/**
 * 右面板「查看改动」这条链路的共享类型与纯函数。
 *
 * 服务端那份在 `server/workspaceDiff.mjs`（`readFileDiff`），这里只放渲染层要用的东西：
 * 来源枚举、查询串拼接、响应归一化。放 `shared/` 是为了能被 `node --test` 直接测 —— 归一化
 * 里的每条分支都对应一种「渲染层会说谎」的可能，值得钉住。
 */

import { isGitFileStatus, type GitFileStatus } from "./gitStatusBadge.ts";

/** 对齐服务端 `GIT_DIFF_SOURCES` / `DEFAULT_DIFF_SOURCE`，两边不一致就会出现"点了没反应"。 */
export const WORKSPACE_DIFF_SOURCES = ["unstaged", "staged", "branch"] as const;
export type WorkspaceDiffSource = (typeof WORKSPACE_DIFF_SOURCES)[number];
export const DEFAULT_WORKSPACE_DIFF_SOURCE: WorkspaceDiffSource = "unstaged";

/**
 * `patch` 才有正文；`binary` / `truncated` / `unavailable` 都只有一句 `summary`。
 * 渲染层必须按这个字段分流，不能"有补丁就画"。
 */
export const WORKSPACE_DIFF_AVAILABILITIES = ["patch", "binary", "truncated", "unavailable"] as const;
export type WorkspaceDiffAvailability = (typeof WORKSPACE_DIFF_AVAILABILITIES)[number];

export interface WorkspaceDiff {
  /** 相对项目根的路径（服务端 `toPatchPath` 归一的那个）。 */
  path: string;
  source: WorkspaceDiffSource;
  availability: WorkspaceDiffAvailability;
  patch: string | null;
  /**
   * 两侧全文，给富渲染（M2e）用。读不到时**一起**是 null，不要拿它当"空文件"。
   */
  beforeContent: string | null;
  afterContent: string | null;
  added: number;
  removed: number;
  /** 没得看时的原因（英文，直接显示在右面板里）。 */
  summary: string | null;
}

export function isWorkspaceDiffSource(value: unknown): value is WorkspaceDiffSource {
  return WORKSPACE_DIFF_SOURCES.includes(value as WorkspaceDiffSource);
}

export function normalizeWorkspaceDiffSource(value: unknown): WorkspaceDiffSource {
  return isWorkspaceDiffSource(value) ? value : DEFAULT_WORKSPACE_DIFF_SOURCE;
}

/**
 * 来源的文案 key。服务端的 `diffSourceMessageId()` 是同一张表 —— 两边必须一致：
 * 这里给出的是「用户看到的来源」，服务端给出的是「这行数据来自哪里」，对不上就会串味。
 */
export function workspaceDiffSourceLabelKey(source: unknown): string {
  const normalized = normalizeWorkspaceDiffSource(source);
  if (normalized === "staged") {
    return "git.source.staged";
  }
  if (normalized === "branch") {
    return "git.source.branch";
  }
  return "git.source.unstaged";
}

function isAvailability(value: unknown): value is WorkspaceDiffAvailability {
  return WORKSPACE_DIFF_AVAILABILITIES.includes(value as WorkspaceDiffAvailability);
}

/**
 * `GET /api/projects/git/diff` 的查询串。
 *
 * 路径必须 `encodeURIComponent`：中文文件名、空格、`#` 直接拼会把查询串截断，服务端拿到的
 * 就是半个路径，最后显示成"文件不存在"。空值不进查询串，让服务端用自己的缺省（unstaged）。
 */
export function buildWorkspaceDiffQuery(input: {
  projectId: string;
  sessionPath?: string;
  path: string;
  source?: string;
  base?: string;
}): string {
  const params = new URLSearchParams();
  params.set("projectId", String(input.projectId ?? ""));
  params.set("path", String(input.path ?? ""));

  const sessionPath = String(input.sessionPath ?? "").trim();
  if (sessionPath) {
    params.set("sessionPath", sessionPath);
  }

  const source = String(input.source ?? "").trim();
  if (source) {
    params.set("source", source);
  }

  const base = String(input.base ?? "").trim();
  if (base) {
    params.set("base", base);
  }

  return `/api/projects/git/diff?${params.toString()}`;
}

/**
 * 服务端响应的形状校验。
 *
 * 缺 `path` 一律当"拿不到"（返回 null）而不是补一个空字符串：右面板标题会变成空白，
 * 用户完全不知道自己在看哪个文件。未知的 `availability` 一律降级成 `unavailable` 并把正文
 * 丢掉 —— 这层的意义就是不让一个没见过的状态把半个补丁画成完整改动。
 */
export function normalizeWorkspaceDiffResponse(raw: unknown): WorkspaceDiff | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Record<string, unknown>;
  const path = typeof value.path === "string" ? value.path : "";
  if (!path) {
    return null;
  }

  const availability = isAvailability(value.availability) ? value.availability : "unavailable";
  const isPatch = availability === "patch";

  return {
    path,
    source: normalizeWorkspaceDiffSource(value.source),
    availability,
    // 非 patch 的正文即使有内容也不看：truncated 是半个补丁，画出来就是假的完整改动。
    patch: isPatch && typeof value.patch === "string" ? value.patch : null,
    beforeContent: typeof value.beforeContent === "string" ? value.beforeContent : null,
    afterContent: typeof value.afterContent === "string" ? value.afterContent : null,
    added: typeof value.added === "number" && Number.isFinite(value.added) ? value.added : 0,
    removed: typeof value.removed === "number" && Number.isFinite(value.removed) ? value.removed : 0,
    summary: typeof value.summary === "string" && value.summary ? value.summary : null,
  };
}

/** 有没有可渲染的补丁正文（空字符串也算没有：画出来只会是一片空白）。 */
export function canRenderWorkspaceDiffPatch(diff: WorkspaceDiff | null): boolean {
  return Boolean(diff && diff.availability === "patch" && diff.patch && diff.patch.trim());
}

/**
 * 富渲染（`MultiFileDiff`：能画「N 行未改动」上下文的那个）的两条上限，和 ZCode 同值
 * （`MAX_RICH_DIFF_FULL_CONTENT_CHAR_COUNT` / `..._LINE_COUNT`）。
 *
 * 为什么要有：富渲染要**同步比较整篇文件**（不是只看补丁里那几个 hunk），几十万字符的文件
 * 会在点开那一帧把主线程占住（ZCode 的 GitPane 在真机上量到过点击后 600ms+ 的长任务）。
 * 超了不是不画，而是退回落差补丁：hunk 少了上下文，但点开是即时的。
 */
export const MAX_RICH_DIFF_FULL_CONTENT_CHARS = 180_000;
export const MAX_RICH_DIFF_FULL_CONTENT_LINES = 1_200;

/** 逻辑行数（末尾换行不算多一行；空内容算 0 行）。 */
export function countDiffContentLines(content: unknown): number {
  if (typeof content !== "string" || content === "") {
    return 0;
  }

  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lines += 1;
    }
  }

  return content.endsWith("\n") ? lines - 1 : lines;
}

/**
 * 这一份 diff 能不能走富渲染。
 *
 * 两侧全文必须**一起**有（只有一侧说明服务端没读完整，拿它当空文件会把整篇画成增/删），
 * 且总字符数与最大行数都在上限内。判断放在 `shared/` 是因为它是渲染层与数据获取之间
 * 的纯规则：写错了的表现是「点开一个大文件就卡死」，值得被 `node --test` 直接钉住。
 */
export function canRenderRichWorkspaceDiff(
  diff: { beforeContent?: string | null; afterContent?: string | null } | null | undefined,
): diff is { beforeContent: string; afterContent: string } {
  if (!diff) {
    return false;
  }

  const { beforeContent, afterContent } = diff;
  if (typeof beforeContent !== "string" || typeof afterContent !== "string") {
    return false;
  }

  if (beforeContent.length + afterContent.length > MAX_RICH_DIFF_FULL_CONTENT_CHARS) {
    return false;
  }

  return (
    Math.max(countDiffContentLines(beforeContent), countDiffContentLines(afterContent)) <=
    MAX_RICH_DIFF_FULL_CONTENT_LINES
  );
}

/**
 * 两次请求说的是不是同一个「文件 + 来源 + base」。
 *
 * 用来决定「重新拉时要不要先清空」：同一个文件把上一次的内容继续挂在屏上，等新数据回来再换
 * —— 不然每点一下都先闪一片空白；换成另一个文件（或换了 base）就必须清掉，否则标题写着 B、
 * 正文还是 A 的行。
 *
 * 注意故意**不缓存结果**：agent 每轮都可能再改同一个文件，缓存下来的 diff 会变成旧改动
 * （用户看到的是上上轮的差异）。便宜的是重读几百毫秒，贵的是看到假的差异。
 */
export function sameWorkspaceDiffSubject(
  previous: { path: string; source?: unknown; base?: string } | null,
  next: { path: string; source?: unknown; base?: string },
): boolean {
  if (!previous) {
    return false;
  }

  return (
    String(previous.path ?? "") === String(next.path ?? "") &&
    normalizeWorkspaceDiffSource(previous.source) === normalizeWorkspaceDiffSource(next.source) &&
    String(previous.base ?? "").trim() === String(next.base ?? "").trim()
  );
}

/**
 * 分支对比下的一个文件行。和服务端 `parseNameStatusZ` 的输出一一对应；
 * `origPath` 只有重命名/复制才有（渲染层要用 `旧 → 新` 说清改名）。
 *
 * `added` / `removed` 是这一份差异里的行数（服务端 `git diff --numstat`）：改动清单要在
 * 行上就显示 `+N −M`，和 ZCode 的 review 面板一致 —— 没有它，用户得逐个点开才知道哪个文件
 * 动得多。数不出来（二进制、git 报错）时是 0/0，这一档渲染成「不显示统计」而不是「0 行」。
 */
export interface WorkspaceChangedFile {
  path: string;
  origPath: string;
  status: GitFileStatus;
  added: number;
  removed: number;
}

/** 某个来源下的改动文件清单（目前只有 branch 需要向服务端要）。 */
export function buildWorkspaceChangedFilesQuery(input: {
  projectId: string;
  sessionPath?: string;
  source?: string;
  base?: string;
}): string {
  const params = new URLSearchParams();
  params.set("projectId", String(input.projectId ?? ""));

  const source = String(input.source ?? "").trim();
  if (source) {
    params.set("source", source);
  }

  const base = String(input.base ?? "").trim();
  if (base) {
    params.set("base", base);
  }

  const sessionPath = String(input.sessionPath ?? "").trim();
  if (sessionPath) {
    params.set("sessionPath", sessionPath);
  }

  return `/api/projects/git/files?${params.toString()}`;
}

/**
 * 文件清单响应归一化。
 *
 * `summary` 非空时**把文件清空**：那句摘要说的是「这个来源现在列不出来」，
 * 这时候屏幕上留着上一次的清单（例如换分支前的那批文件）比空着更误导。
 */
export function normalizeChangedFilesResponse(
  raw: unknown,
): { source: WorkspaceDiffSource; base: string; files: WorkspaceChangedFile[]; summary: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.files)) {
    return null;
  }

  const summary = typeof value.summary === "string" && value.summary ? value.summary : "";
  const files: WorkspaceChangedFile[] = [];

  for (const item of value.files) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const row = item as Record<string, unknown>;
    const path = typeof row.path === "string" ? row.path : "";
    if (!path) {
      continue;
    }

    files.push({
      path,
      origPath: typeof row.origPath === "string" ? row.origPath : "",
      status: isGitFileStatus(row.status) ? row.status : "modified",
      added: typeof row.added === "number" && Number.isFinite(row.added) && row.added > 0 ? row.added : 0,
      removed:
        typeof row.removed === "number" && Number.isFinite(row.removed) && row.removed > 0 ? row.removed : 0,
    });
  }

  return {
    source: normalizeWorkspaceDiffSource(value.source),
    base: typeof value.base === "string" ? value.base : "",
    files: summary ? [] : files,
    summary,
  };
}