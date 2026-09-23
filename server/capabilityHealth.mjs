import { isAbsolute, relative, resolve } from "node:path";

/**
 * pi reports the extensions it really loaded (and the ones that blew up) through
 * `resourceLoader.getExtensions()`. Pi Desktop used to ignore that result for packages and
 * answered "当前会话已加载" straight from its own selection set, which is a different
 * thing: a package can be installed, switched on in the panel, and still never reach the
 * session because autoload skipped it or the import threw. Those cases were invisible.
 *
 * This module is the pure part of the health check: given what pi loaded, what pi
 * complained about, and where each package lives on disk, classify every package.
 */

const LOAD_STATUSES = ["loaded", "failed", "missing", "disabled", "not-installed"];

function normalize(path) {
  if (typeof path !== "string" || path.length === 0) {
    return "";
  }
  try {
    return resolve(path);
  } catch {
    return path;
  }
}

function isInside(root, target) {
  const base = normalize(root);
  const candidate = normalize(target);
  if (!base || !candidate) {
    return false;
  }
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function extensionIdentity(entry) {
  return [normalize(entry.path), normalize(entry.resolvedPath)].filter(Boolean);
}

function belongsToPackage(entry, expectedPaths, installedPath) {
  const identities = extensionIdentity(entry);
  if (identities.some((path) => expectedPaths.includes(path))) {
    return true;
  }
  return Boolean(installedPath) && identities.some((path) => isInside(installedPath, path));
}

function normalizeLoaded(loaded) {
  return (loaded ?? []).map((entry) => ({
    path: entry.path ?? "",
    resolvedPath: entry.resolvedPath ?? "",
    tools: [...(entry.tools ?? [])],
    commands: [...(entry.commands ?? [])],
  }));
}

function normalizeErrors(errors) {
  return (errors ?? [])
    .map((entry) => ({
      path: normalize(entry.path ?? ""),
      message: String(entry.error ?? entry.message ?? "").trim() || "extension failed to load",
    }))
    .filter((entry) => entry.message.length > 0);
}

/**
 * @returns {{ packages: Record<string, {status: string, loadedCount: number, expectedCount: number, tools: string[], commands: string[], errors: string[]}>, unattributedErrors: Array<{path:string,message:string}> }}
 */
export function summarizePackageHealth({ loaded = [], errors = [], packages = [], activeIds = [] } = {}) {
  const loadedEntries = normalizeLoaded(loaded);
  const errorEntries = normalizeErrors(errors);
  const active = new Set(activeIds ?? []);
  const claimed = new Set();
  const result = {};

  for (const pkg of packages ?? []) {
    const expectedPaths = (pkg.paths ?? []).map(normalize).filter(Boolean);
    const installedPath = normalize(pkg.installedPath || "");
    const matches = loadedEntries.filter((entry) => belongsToPackage(entry, expectedPaths, installedPath));
    const ownErrors = [];
    errorEntries.forEach((entry, index) => {
      const hit =
        (entry.path && expectedPaths.includes(entry.path)) ||
        (entry.path && installedPath && isInside(installedPath, entry.path));
      if (hit) {
        ownErrors.push(entry.path ? `${entry.message}（${entry.path}）` : entry.message);
        claimed.add(index);
      }
    });
    const selected = active.has(pkg.id);
    const hasSource = expectedPaths.length > 0 || Boolean(installedPath);

    let status = "missing";
    if (matches.length > 0) {
      status = "loaded";
    } else if (ownErrors.length > 0) {
      status = "failed";
    } else if (!hasSource) {
      status = "not-installed";
    } else if (!selected) {
      status = "disabled";
    }

    result[pkg.id] = {
      status,
      loadedCount: matches.length,
      expectedCount: expectedPaths.length,
      tools: [...new Set(matches.flatMap((match) => match.tools))].sort(),
      commands: [...new Set(matches.flatMap((match) => match.commands))].sort(),
      errors: ownErrors,
    };
  }

  return {
    packages: result,
    unattributedErrors: errorEntries.filter((_, index) => !claimed.has(index)),
  };
}

export function loadStatuses() {
  return [...LOAD_STATUSES];
}

export function isUnhealthyLoadStatus(status) {
  return status === "failed" || status === "missing";
}

export function describeLoadStatus(status, summary) {
  const tools = summary?.tools?.length ? `，注册工具 ${summary.tools.join("、")}` : "";
  switch (status) {
    case "loaded":
      return `本会话已加载${tools}`;
    case "failed":
      return `加载失败：${(summary?.errors ?? []).join("；") || "pi 报错但没给原因"}`;
    case "missing":
      return "已选中但没有加载：pi 的自动加载没有把它的扩展递进会话（没有报错，所以面板以前看不出来）";
    case "disabled":
      return "本会话未启用";
    case "not-installed":
      return "未解析到扩展入口：包可能没装好或 settings 里的 source 指向不存在的路径";
    default:
      return String(status ?? "未知");
  }
}
