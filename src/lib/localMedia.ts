/**
 * Turning media paths an agent writes into something the WebView can actually load.
 *
 * The chat UI runs on an http origin, not on the filesystem, so `/Users/me/a.png`
 * in an answer resolves to `http://127.0.0.1:5176/Users/me/a.png` and 404s, and
 * `file://` is refused outright. Anything that is not already a URL the WebView can
 * fetch goes to `GET /api/local-media`, which re-reads it from disk inside the
 * allowed roots (see `server/localMedia.mjs` for the boundary and the reason).
 *
 * This module is deliberately free of React and of `api.ts` side effects so the
 * rules can be unit tested.
 */

export type LocalMediaKind = "image" | "video";

/** Sources the WebView can load as they are — never rewrite those. */
const DIRECT_SRC_PATTERN = /^(?:data:|blob:|https?:|file:)/i;

/** Keep in sync with `LOCAL_MEDIA_MIME_TYPES` in `server/localMedia.mjs`. */
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|m4v|mov|webm|ogv|ogg)(?:[?#].*)?$/i;

const trimTrailingSlash = (base: string) => base.replace(/\/+$/, "");

/** Is this already loadable (remote/data URL) without asking the local server? */
export function isDirectMediaSrc(src: string | undefined): boolean {
  const value = String(src ?? "").trim();
  return value.length > 0 && DIRECT_SRC_PATTERN.test(value);
}

/**
 * `file:///Users/me/a.png` on macOS/Linux, `file:///C:/x/a.png`, `/Users/me/a.png`,
 * `~/a.png` and `docs/a.png` all name a local file; only the local server can read
 * them, so they become an endpoint URL that carries the spelling untouched.
 */
export function localMediaUrl(src: string, apiBase: string): string {
  const value = String(src ?? "").trim();
  if (/^file:/i.test(value)) {
    return `${trimTrailingSlash(apiBase)}/api/local-media?path=${encodeFileUrl(value)}`;
  }
  return `${trimTrailingSlash(apiBase)}/api/local-media?path=${encodeURIComponent(value)}`;
}

/**
 * The `src` to hand an `<img>` / `<video>`: untouched for URLs the WebView can load
 * on its own, proxied through the local server for paths it cannot.
 */
export function resolveMediaSrc(
  src: string | undefined,
  apiBase: string,
): string | undefined {
  const value = String(src ?? "").trim();
  if (!value) {
    return undefined;
  }
  if (isDirectMediaSrc(value)) {
    // `file:` still needs the server, everything else is fine as it stands.
    return /^file:/i.test(value) ? localMediaUrl(value, apiBase) : value;
  }
  return localMediaUrl(value, apiBase);
}

/**
 * Whether a source should be played rather than shown. Judged on the original
 * spelling, because the proxied URL ends in `?path=...` and carries no extension.
 */
export function detectMediaKind(src: string | undefined): LocalMediaKind | undefined {
  const value = String(src ?? "").trim();
  if (!value) {
    return undefined;
  }

  const target = /^file:/i.test(value) ? decodeFileUrlPath(value) : value;
  if (VIDEO_EXTENSION_PATTERN.test(target)) {
    return "video";
  }
  if (/^data:/i.test(value)) {
    return /^data:video\//i.test(value) ? "video" : "image";
  }
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg|heic|heif)(?:[?#].*)?$/i.test(target)
    ? "image"
    : undefined;
}

function encodeFileUrl(value: string): string {
  const path = decodeFileUrlPath(value);
  return encodeURIComponent(path);
}

/** `file:///Users/me/a%20b.png` → `/Users/me/a b.png` (the server decodes too). */
function decodeFileUrlPath(value: string): string {
  let body = value.replace(/^file:/i, "");
  if (body.startsWith("//")) {
    const slash = body.indexOf("/", 2);
    body = slash === -1 ? "/" : body.slice(slash);
  }
  try {
    return decodeURIComponent(body);
  } catch {
    return body;
  }
}
