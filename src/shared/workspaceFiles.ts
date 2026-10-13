/**
 * 右面板 Files 视图的共享类型与纯函数（服务端那份在 `server/workspaceFiles.mjs`）。
 *
 * 和 `workspaceDiff.ts` 一样放 `shared/`：查询串拼接、响应归一化、文本切行这些都能被
 * `node --test` 直接钉住，而这些正是「渲染层会说谎」的地方（比如把「读不到」画成空文件）。
 */

export interface WorkspaceFileEntry {
  name: string;
  /** 相对项目根、用 `/` 分隔的路径（树用它当身份，也和 git 的路径对齐）。 */
  path: string;
  isDir: boolean;
  /** 软链（不追），渲染层给个不同的图标，也不让它展开。 */
  isLink: boolean;
  size: number;
}

export interface WorkspaceDirectoryListing {
  /** 相对项目根的目录路径；根目录是空串。 */
  dir: string;
  entries: WorkspaceFileEntry[];
  /** 目录里还有没列出来的条目（服务端有上限）。 */
  truncated: boolean;
}

export const WORKSPACE_FILE_AVAILABILITIES = ["text", "binary", "too-large", "unavailable"] as const;
export type WorkspaceFileAvailability = (typeof WORKSPACE_FILE_AVAILABILITIES)[number];

export interface WorkspaceFileContent {
  path: string;
  availability: WorkspaceFileAvailability;
  /** 只有 `text` 才有正文。 */
  text: string | null;
  size: number;
  truncated: boolean;
  /** 看不了时的原因（服务端给的英文说明，直接显示）。 */
  summary: string | null;
}

export function buildWorkspaceDirQuery(input: { projectId: string; sessionPath?: string; dir?: string }): string {
  const params = new URLSearchParams();
  params.set("projectId", String(input.projectId ?? ""));
  const dir = String(input.dir ?? "").trim();
  if (dir) {
    params.set("dir", dir);
  }
  const sessionPath = String(input.sessionPath ?? "").trim();
  if (sessionPath) {
    params.set("sessionPath", sessionPath);
  }
  return `/api/projects/files?${params.toString()}`;
}

export function buildWorkspaceFileQuery(input: { projectId: string; sessionPath?: string; path: string }): string {
  const params = new URLSearchParams();
  params.set("projectId", String(input.projectId ?? ""));
  params.set("path", String(input.path ?? ""));
  const sessionPath = String(input.sessionPath ?? "").trim();
  if (sessionPath) {
    params.set("sessionPath", sessionPath);
  }
  return `/api/projects/file?${params.toString()}`;
}

function normalizeEntry(raw: unknown): WorkspaceFileEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Record<string, unknown>;
  const path = typeof value.path === "string" ? value.path : "";
  const name = typeof value.name === "string" && value.name ? value.name : path.split("/").pop() ?? "";
  if (!path || !name) {
    return null;
  }

  return {
    name,
    path,
    isDir: value.isDir === true,
    isLink: value.isLink === true,
    size: typeof value.size === "number" && Number.isFinite(value.size) ? value.size : 0,
  };
}

/** 目录响应归一化：整体形状不对就是 null（渲染层说「这一层读不到」），坏条目单独丢掉。 */
export function normalizeDirectoryListing(raw: unknown): WorkspaceDirectoryListing | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.entries)) {
    return null;
  }

  return {
    dir: typeof value.dir === "string" ? value.dir : "",
    entries: value.entries.map(normalizeEntry).filter((entry): entry is WorkspaceFileEntry => entry !== null),
    truncated: value.truncated === true,
  };
}

export function normalizeFileContent(raw: unknown): WorkspaceFileContent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const value = raw as Record<string, unknown>;
  const path = typeof value.path === "string" ? value.path : "";
  if (!path) {
    return null;
  }

  const availability = WORKSPACE_FILE_AVAILABILITIES.includes(value.availability as WorkspaceFileAvailability)
    ? (value.availability as WorkspaceFileAvailability)
    : "unavailable";

  return {
    path,
    availability,
    // 非 text 一律不看正文：`binary` 里可能是乱码，`too-large` 是服务端没读过的东西。
    text: availability === "text" && typeof value.text === "string" ? value.text : null,
    size: typeof value.size === "number" && Number.isFinite(value.size) ? value.size : 0,
    truncated: value.truncated === true,
    summary: typeof value.summary === "string" && value.summary ? value.summary : null,
  };
}

export function canRenderFileText(content: WorkspaceFileContent | null): boolean {
  return Boolean(content && content.availability === "text" && typeof content.text === "string");
}

/** 父目录（树的展开状态按它走）：`src/a.ts` → `src`，根下的文件 → 空串。 */
export function parentDirectory(path: unknown): string {
  const parts = String(path ?? "").split("/");
  parts.pop();
  return parts.join("/");
}

export function fileNameOf(path: unknown): string {
  return String(path ?? "").split("/").pop() ?? "";
}

/** 人类可读的大小（树/预览头部用）。 */
export function formatFileSize(bytes: unknown): string {
  const value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
/** 过滤结果：要显示哪些行、哪些目录要因为命中而自动展开。 */
export interface WorkspaceTreeFilter {
  /** 显示的路径（命中项 + 它们的祖先目录）。 */
  visible: Set<string>;
  /** 因为「子孙里有命中」而要自动展开的目录。 */
  expand: Set<string>;
  /** 命中的条目数（0 就该显示「没有匹配」而不是空树）。 */
  matchCount: number;
}

/**
 * 在**已经读回来的**那几层目录里过滤（Codex 的 "Filter files..." 那行）。
 *
 * 为什么不做成全仓搜索：树是懒加载的，服务端没有索引接口；假装能搜全部只会让人以为
 * 「文件不存在」。所以命中范围就是已展开的目录，界面上一并说明这一点
 * （`rightPanel.filesFilterHint`），用户展开更多目录就能搜到更多。
 *
 * 空查询返回 null（= 不过滤），调用方据此走原来的渲染路径。
 */
export function filterWorkspaceTree(
  entriesByDir: ReadonlyMap<string, readonly WorkspaceFileEntry[]>,
  query: unknown,
): WorkspaceTreeFilter | null {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) {
    return null;
  }

  const visible = new Set<string>();
  const expand = new Set<string>();
  let matchCount = 0;

  // 命中项在某一层里，说明它的每一级祖先都已经被读回来过（树是懒加载的），
  // 所以祖先一定要显示 + 展开，否则命中行藏在收起的目录里，看起来就是「没搜到」。
  const showAncestors = (path: string) => {
    let parent = parentDirectory(path);
    while (parent) {
      visible.add(parent);
      expand.add(parent);
      parent = parentDirectory(parent);
    }
  };

  for (const entries of entriesByDir.values()) {
    for (const entry of entries) {
      const path = String(entry.path ?? "");
      if (!path.toLowerCase().includes(needle)) {
        continue;
      }
      matchCount += 1;
      if (!visible.has(path)) {
        // 命中的是目录本身时也只显示它、不替用户展开（他可能只是想看看它在不在）。
        visible.add(path);
        showAncestors(path);
      }
    }
  }

  return { visible, expand, matchCount };
}
