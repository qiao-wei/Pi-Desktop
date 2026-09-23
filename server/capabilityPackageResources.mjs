import { isAbsolute, relative, resolve } from "node:path";

/**
 * pi discovers a package's contents itself — either from `package.json`'s `pi` manifest or from
 * the `extensions/ · skills/ · prompts/ · themes/` directory convention — and hands the result
 * back from `DefaultPackageManager.resolveExtensionSources()`. Pi Desktop used to keep only the
 * extension paths from that call and drop the other three types, so a package that ships skills
 * looked empty in the panel.
 *
 * This module is the pure part of surfacing that resolution: counts for the card chips, detail
 * rows for the dialog, and the pi progress event -> NDJSON payload mapping used by the install
 * and update streams.
 */

export const PACKAGE_RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"];

export function emptyPackageResources() {
  return { extensions: [], skills: [], prompts: [], themes: [] };
}

function resourceList(resolved, type) {
  const list = resolved?.[type];
  return Array.isArray(list) ? list : [];
}

/** Card chips: every type is always present, so the UI can render four even at zero. */
export function summarizePackageResources(resolved) {
  const counts = {};
  for (const type of PACKAGE_RESOURCE_TYPES) {
    counts[type] = resourceList(resolved, type).length;
  }
  return counts;
}

function displayPath(path, base) {
  const value = String(path ?? "");
  if (!value || !base) {
    return value;
  }
  const root = resolve(base);
  const candidate = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(root, candidate);
  return rel && !rel.startsWith("..") ? rel : value;
}

/**
 * Detail rows for the resource dialog: where each entry sits inside the package and whether pi
 * will actually hand it to a session (a settings `{source, skills: [...]}` entry can filter one
 * type, and pi marks the filtered-out entries disabled).
 */
export function packageResourceDetails(resolved, { packageRoot = "" } = {}) {
  const details = {};
  for (const type of PACKAGE_RESOURCE_TYPES) {
    details[type] = resourceList(resolved, type).map((entry) => {
      const path = String(entry?.path ?? "");
      const base = packageRoot || entry?.metadata?.baseDir || "";
      return {
        path,
        relativePath: displayPath(path, base),
        enabled: entry?.enabled !== false,
      };
    });
  }
  return details;
}

function absoluteEntryPath(path, base) {
  const value = String(path ?? "");
  if (!value) {
    return "";
  }
  if (isAbsolute(value)) {
    return resolve(value);
  }
  return resolve(base || process.cwd(), value);
}

/**
 * Which resolved entry a requested path means. This is the whitelist that makes previewing a
 * package file safe: only paths pi already resolved for *this* package can be read, so a client
 * cannot walk out of the package with `../` or an absolute path of its choosing.
 *
 * @returns {{ type: string, path: string, absolutePath: string, enabled: boolean } | null}
 */
export function findPackageResourceEntry(resolved, requestedPath, { packageRoot = "" } = {}) {
  const wanted = String(requestedPath ?? "").trim();
  if (!wanted) {
    return null;
  }
  const base = packageRoot ? resolve(packageRoot) : "";
  const candidates = new Set([wanted]);
  if (isAbsolute(wanted)) {
    candidates.add(resolve(wanted));
  }
  if (base) {
    candidates.add(absoluteEntryPath(wanted, base));
  }

  for (const type of PACKAGE_RESOURCE_TYPES) {
    for (const entry of resourceList(resolved, type)) {
      const path = String(entry?.path ?? "");
      if (!path) {
        continue;
      }
      const absolutePath = absoluteEntryPath(path, base);
      if (candidates.has(path) || candidates.has(absolutePath)) {
        return { type, path, absolutePath, enabled: entry?.enabled !== false };
      }
    }
  }
  return null;
}

/** How much of a resource file the read-only preview will carry. */
export const MAX_RESOURCE_PREVIEW_BYTES = 512 * 1024;

/**
 * Preview text for the file pane. Binary files are refused instead of dumped into a <pre>, and an
 * oversized file is truncated (the caller only reads up to the cap in the first place).
 */
export function resourcePreview(buffer, { totalBytes } = {}) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? "");
  const bytes = Number.isFinite(totalBytes) ? Number(totalBytes) : data.byteLength;
  const truncated = bytes > data.byteLength;
  if (data.includes(0)) {
    return { content: "", binary: true, truncated, bytes };
  }
  return { content: data.toString("utf8"), binary: false, truncated, bytes };
}

const PROGRESS_PHASES = ["start", "complete", "error"];

/** pi progress event (`withProgress`) -> the payload the package install/update stream writes. */
export function packageProgressEvent(event) {
  const phase = PROGRESS_PHASES.includes(event?.type) ? event.type : "start";
  return {
    type: "package_progress",
    phase,
    action: String(event?.action ?? ""),
    source: String(event?.source ?? ""),
    message: String(event?.message ?? ""),
  };
}