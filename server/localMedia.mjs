/**
 * Which local files `GET /api/local-media` is allowed to hand out, and how a
 * path written by the agent becomes a readable file on disk.
 *
 * Why this exists: the UI runs inside a WebView whose origin is `http://127.0.0.1`
 * (or a Tauri custom origin), never the filesystem. So `![](/Users/me/shot.png)`
 * in an answer becomes a request for `http://127.0.0.1:5176/Users/me/shot.png`
 * and 404s; `file://` is refused too. The answer has to go through the local
 * server, which means it needs a boundary — an endpoint that reads any path the
 * browser asks for would let every web page on the machine pull images off disk
 * (the server binds 127.0.0.1 but has no origin check).
 *
 * The boundary (decided 2026-09-06): media may live under the current project
 * directory, the agent directory, the system temp directory, or the user's home.
 * Symlinks are resolved before the check, so a link out of those roots does not
 * count as inside, and `/tmp` vs `/private/tmp` are the same directory.
 */
import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";

/** Extensions the endpoint serves. Anything else is refused before touching disk. */
export const LOCAL_MEDIA_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".ogg": "video/ogg",
};

/** Media types that must be played rather than shown. */
export const VIDEO_MIME_TYPES = new Set(
  Object.entries(LOCAL_MEDIA_MIME_TYPES)
    .filter(([, mimeType]) => mimeType.startsWith("video/"))
    .map(([, mimeType]) => mimeType),
);

export const MAX_LOCAL_MEDIA_BYTES = 200 * 1024 * 1024;

/** image | video, from a mime type the table above produced. */
export function mediaKind(mimeType) {
  return VIDEO_MIME_TYPES.has(mimeType) ? "video" : "image";
}

/**
 * Turn whatever the agent wrote (`/abs`, `~/x`, `./rel`, `file:///x`, `C:\x`)
 * into a readable media file inside the allowed roots.
 *
 * Returns `{ ok: true, path, mimeType, kind, size }`, or `{ ok: false, status,
 * error }` where `status` is the HTTP code to answer with. `fs` is injectable so
 * the rules can be tested without touching a real disk.
 */
export function resolveLocalMediaPath(input, options = {}) {
  const fs = options.fs ?? { realpath: realpathSync, stat: statSync };
  const homedir = options.homedir ?? "";
  const cwd = options.cwd ?? "";
  const maxBytes = options.maxBytes ?? MAX_LOCAL_MEDIA_BYTES;

  const raw = String(input ?? "").trim();
  if (!raw) {
    return failure(400, "path is required.");
  }
  if (raw.includes("\0")) {
    return failure(400, "Invalid path.");
  }

  const normalized = stripFileUrl(raw);
  if (normalized === null) {
    return failure(400, "Only local file: URLs can be opened.");
  }
  if (hasForeignProtocol(normalized)) {
    return failure(400, "Only local files can be read.");
  }

  const mimeByExtension = mimeForExtension(normalized);
  if (!mimeByExtension) {
    return failure(415, "Unsupported media type.");
  }

  const target = expandHome(normalized, { homedir, cwd });
  if (!target) {
    return failure(400, "Relative paths need a project directory.");
  }

  let realPath;
  try {
    realPath = fs.realpath(target);
  } catch {
    return failure(404, "File not found.");
  }

  let stats;
  try {
    stats = fs.stat(realPath);
  } catch {
    return failure(404, "File not found.");
  }
  if (!stats.isFile()) {
    return failure(404, "File not found.");
  }
  if (Number(stats.size ?? 0) > maxBytes) {
    return failure(413, "File is too large to preview.");
  }

  const roots = (options.roots ?? []).map((root) => realRoot(root, fs));
  if (!roots.some((root) => isInsidePath(root, realPath))) {
    return failure(403, "Path is outside the allowed directories.");
  }

  return {
    ok: true,
    path: realPath,
    mimeType: mimeByExtension,
    kind: mediaKind(mimeByExtension),
    size: Number(stats.size ?? 0),
  };
}

/**
 * `Range: bytes=a-b` → `{ start, end }` in inclusive byte offsets, `null` when the
 * header is absent, malformed, or lists several ranges (then the caller serves the
 * whole file). Video playback in WKWebView only seeks when partial responses work,
 * and the browser always asks with this header.
 */
export function parseByteRange(header, size) {
  const value = String(header ?? "").trim();
  if (!value) {
    return null;
  }
  const match = /^bytes=(.+)$/i.exec(value);
  if (!match) {
    return null;
  }

  const specs = match[1].split(",").map((part) => part.trim()).filter(Boolean);
  if (specs.length !== 1 || Number(size) <= 0) {
    return null;
  }

  const [first, last] = specs[0].split("-");
  const total = Number(size);
  let start;
  let end;

  if (first === "") {
    // `bytes=-500` is "the last 500 bytes".
    const suffix = Number(last);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    start = Math.max(total - Math.min(suffix, total), 0);
    end = total - 1;
  } else {
    start = Number(first);
    if (!Number.isFinite(start) || start < 0 || start >= total) {
      return null;
    }
    end = last === "" || last === undefined ? total - 1 : Number(last);
    if (!Number.isFinite(end) || end < start) {
      return null;
    }
    end = Math.min(end, total - 1);
  }

  if (end < start) {
    return null;
  }
  return { start, end };
}

/** Does `candidate` sit at or below `root`? Both must already be resolved. */
export function isInsidePath(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function failure(status, error) {
  return { ok: false, status, error };
}

function mimeForExtension(path) {
  const windowsDrive = /^[a-zA-Z]:[\\/]/.test(path);
  const name = windowsDrive ? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "" : path;
  const ext = extname(name).toLowerCase();
  return LOCAL_MEDIA_MIME_TYPES[ext];
}

function stripFileUrl(value) {
  if (!/^file:/i.test(value)) {
    return value;
  }

  const withoutScheme = value.replace(/^file:/i, "");
  // `file:///x` → `//x`, and `file://localhost/x` names this machine; a host in
  // there means someone is asking for another machine's disk.
  let pathname = withoutScheme;
  if (pathname.startsWith("//")) {
    const body = pathname.slice(2);
    const slash = body.indexOf("/");
    const host = slash === -1 ? "" : body.slice(0, slash);
    if (host && host !== "localhost") {
      return null;
    }
    pathname = slash === -1 ? "/" : body.slice(slash);
  }

  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function hasForeignProtocol(value) {
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    // Windows absolute path, `C:\dir\a.png`, whose colon is not a scheme.
    return false;
  }
  const colon = value.indexOf(":");
  const slash = value.indexOf("/");
  return colon > 0 && (slash === -1 || colon < slash);
}

function expandHome(value, { homedir, cwd }) {
  if (value === "~") {
    return homedir || null;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return homedir ? resolve(homedir, value.slice(2)) : null;
  }
  if (isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    return resolve(value);
  }
  // A relative markdown path (`docs/a.png`) belongs to the project the agent runs in.
  return cwd ? resolve(cwd, value) : null;
}

function realRoot(root, fs) {
  const resolved = resolve(String(root ?? ""));
  try {
    return fs.realpath(resolved);
  } catch {
    return resolved;
  }
}
