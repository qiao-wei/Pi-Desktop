/**
 * 右面板 Files 视图要用的「读工作区目录 / 读文件正文」。
 *
 * 两条硬约束：
 * 1. **只读**，且路径必须落在项目根内 —— 越界（`../`、绝对路径、软链指向外面）一律拒绝，
 *    连 fs 都不碰（和 `workspaceDiff.mjs` 同一套判断，复用 `isInsidePath`）。
 * 2. **有界**：一个目录最多回 500 条、一个文件最多回 256KB。工作区里动辄有 `node_modules`
 *    这种几万条、几百 MB 的东西，不设上限就是把渲染层拖死。
 *
 * `.git` 与 `node_modules` 直接不出现在列表里：它们是「实现细节」而不是用户的代码，
 * 列出来只会把有用的文件挤到屏幕外（ZCode 的树同样有 ignore 名单）。
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { isInsidePath } from "./localMedia.mjs";

/** 一个目录最多回多少条（超出就是 `truncated`，渲染层要说明「还有更多」。 */
export const MAX_DIRECTORY_ENTRIES = 500;
/** 单个文件的正文上限，对齐 ZCode 的 `FILE_VIEWER_MAX_TEXT_BYTES = 256KB`。 */
export const MAX_FILE_TEXT_BYTES = 256 * 1024;
/** 不出现在列表里的目录名（用户的代码不会在这些里面）。 */
export const IGNORED_DIRECTORY_NAMES = [".git", "node_modules"];
/** 不出现在列表里的文件名（macOS 的元数据噪音）。 */
export const IGNORED_FILE_NAMES = [".DS_Store"];

/**
 * 归一化相对目录：`""`（根）/ `src` / `src/features`。
 *
 * 越界或绝对路径返回 null，由调用方报错 —— 不在这里抛，是为了让它能被直接单测。
 * 反斜杠一并归一：Windows 上传进来的 `src\features` 也要能走。
 */
export function normalizeRelativeDir(value) {
  const raw = String(value ?? "").trim().split("\\").join("/");
  if (!raw || raw === "." || raw === "/") {
    return "";
  }

  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    return null;
  }

  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      return null;
    }
    parts.push(part);
  }

  return parts.join("/");
}

export function isIgnoredEntryName(name, isDir) {
  const value = String(name ?? "");
  return isDir ? IGNORED_DIRECTORY_NAMES.includes(value) : IGNORED_FILE_NAMES.includes(value);
}

/** 目录在前，然后按名字不区分大小写排（大小写只用来兜底，保证顺序稳定、可测）。 */
export function sortDirectoryEntries(entries) {
  return [...entries].sort((left, right) => {
    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1;
    }
    const a = left.name.toLowerCase();
    const b = right.name.toLowerCase();
    if (a !== b) {
      return a < b ? -1 : 1;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

function unavailableEntry(message) {
  return { ok: false, status: message };
}

/**
 * 列一层目录（不递归：树是懒加载的，展开哪层才读哪层）。
 *
 * 返回 `{ ok: true, dir, entries, truncated }` 或 `{ ok: false, status }`。
 * 只列一层也是安全考量：递归会跟着软链跑出项目根。
 *
 * @param {{ cwd?: string, dir?: string, limit?: number, fs?: { readdir?: typeof readdirSync, lstat?: typeof lstatSync } }} [options]
 */
export function listWorkspaceDirectory({ cwd, dir = "", limit = MAX_DIRECTORY_ENTRIES, fs = {} } = {}) {
  const root = resolve(String(cwd ?? ""));
  if (!root) {
    return unavailableEntry("Cannot list a project without a folder.");
  }

  const relativeDir = normalizeRelativeDir(dir);
  if (relativeDir === null) {
    return unavailableEntry("Path is outside the project folder.");
  }

  const readdir = fs.readdir ?? readdirSync;
  const lstat = fs.lstat ?? lstatSync;
  const absoluteDir = relativeDir ? join(root, relativeDir) : root;

  if (!isInsidePath(root, absoluteDir)) {
    return unavailableEntry("Path is outside the project folder.");
  }

  let names;
  try {
    names = readdir(absoluteDir);
  } catch {
    // 目录被删了 / 不是目录 / 没权限 —— 对渲染层是一回事：这一层现在没得看。
    return unavailableEntry("Folder is not readable.");
  }

  const entries = [];
  for (const name of names) {
    const absolute = join(absoluteDir, name);
    let stats;
    try {
      stats = lstat(absolute);
    } catch {
      continue;
    }

    const isLink = stats.isSymbolicLink();
    // 软链不追：真去 stat 目标就可能跑到项目外，而树上的展开动作是按 isDir 走的。
    const isDir = stats.isDirectory();
    if (isIgnoredEntryName(name, isDir)) {
      continue;
    }

    entries.push({
      name,
      path: relativeDir ? `${relativeDir}/${name}` : name,
      isDir,
      isLink,
      size: isDir ? 0 : stats.size,
    });
  }

  const sorted = sortDirectoryEntries(entries);
  return {
    ok: true,
    dir: relativeDir,
    entries: sorted.slice(0, Math.max(0, limit)),
    truncated: sorted.length > limit,
  };
}

function textOrUnavailable(path, availability, summary, extra = {}) {
  return { path, availability, text: null, size: 0, truncated: false, summary, ...extra };
}

/**
 * 读一个文件的正文（内置预览用）。
 *
 * `availability`：`text` / `binary` / `too-large` / `unavailable`。
 * 判成 `unavailable` 的原因（不存在 / 是目录 / 越界 / 软链跑出去）走 `summary`，渲染层直接显示。
 *
 * @param {{ cwd?: string, path?: string, maxBytes?: number, fs?: { lstat?: typeof lstatSync, stat?: typeof statSync, readFile?: typeof readFileSync, realpath?: typeof realpathSync } }} [options]
 */
export function readWorkspaceFile({ cwd, path, maxBytes = MAX_FILE_TEXT_BYTES, fs = {} } = {}) {
  const root = resolve(String(cwd ?? ""));
  const target = String(path ?? "").trim();
  if (!root || !target) {
    return textOrUnavailable(target, "unavailable", "Cannot read a file without a path.");
  }

  const relativePath = normalizeRelativeDir(target);
  if (relativePath === null || !relativePath) {
    return textOrUnavailable(target, "unavailable", "Path is outside the project folder.");
  }

  const lstat = fs.lstat ?? lstatSync;
  const stat = fs.stat ?? statSync;
  const readFile = fs.readFile ?? readFileSync;
  const realpath = fs.realpath ?? realpathSync;

  const absolute = join(root, relativePath);
  if (!isInsidePath(root, absolute)) {
    return textOrUnavailable(relativePath, "unavailable", "Path is outside the project folder.");
  }

  let link;
  try {
    link = lstat(absolute);
  } catch {
    return textOrUnavailable(relativePath, "unavailable", "File is missing on disk.");
  }

  if (link.isDirectory()) {
    return textOrUnavailable(relativePath, "unavailable", "This path is a folder.");
  }

  // 软链要按真实路径再查一次：`link -> /etc/passwd` 不能因为链接名在项目里就放行。
  // 比较的基准也得是**项目根的真实路径**：macOS 上 tmpdir 经 `/var -> /private/var`，
  // 拿字面路径比会把项目自己的文件全判成越界（用户的项目目录同样可能是软链过来的）。
  let realRoot = root;
  try {
    realRoot = realpath(root);
  } catch {
    // 根读不到真实路径时就用字面值：后面的 stat 会自己报 missing。
  }

  try {
    const real = realpath(absolute);
    if (!isInsidePath(realRoot, real)) {
      return textOrUnavailable(relativePath, "unavailable", "Path is outside the project folder.");
    }
  } catch {
    return textOrUnavailable(relativePath, "unavailable", "File is missing on disk.");
  }

  let stats;
  try {
    stats = stat(absolute);
  } catch {
    return textOrUnavailable(relativePath, "unavailable", "File is missing on disk.");
  }
  if (stats.size > maxBytes) {
    return textOrUnavailable(relativePath, "too-large", "File is larger than the preview limit.", {
      size: stats.size,
      truncated: true,
    });
  }

  let buffer;
  try {
    buffer = readFile(absolute);
  } catch {
    return textOrUnavailable(relativePath, "unavailable", "File is not readable.");
  }

  // 含 NUL 就是二进制（和 workspaceDiff 的判据一致，两处不能各说各话）。
  if (buffer.includes(0)) {
    return textOrUnavailable(relativePath, "binary", "Binary file is not previewable.", { size: stats.size });
  }

  const text = buffer.toString("utf8");
  return {
    path: relativePath,
    availability: "text",
    text,
    size: stats.size,
    truncated: false,
    summary: null,
  };
}