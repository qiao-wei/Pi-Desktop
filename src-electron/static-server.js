"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
};

// The renderer used to be served from `http://127.0.0.1:<random port>`. Every launch
// picked a new port, so every launch was a *new origin*: `localStorage` (theme, panel
// widths, collapsed sidebars, locale, pinned projects) was written under
// `http://127.0.0.1:59263` and read back from `http://127.0.0.1:59382` — i.e. prefs
// silently reset on restart. A custom scheme has a stable origin (`app://pi-desktop`),
// which is also what Tauri does with `tauri://localhost`. The bundle is built with
// vite's default `base: "/"`, so absolute asset URLs resolve to `app://pi-desktop/assets/...`.
const RENDERER_SCHEME = "app";
const RENDERER_HOST = "pi-desktop";
const RENDERER_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`;

// `standard: true` gives the scheme an origin + hierarchy (so `/assets/...` resolves);
// `secure: true` keeps it a secure context (crypto.subtle & co. are used in the renderer);
// `supportFetchAPI` / `stream` cover fetch() and media/code-cache reads inside the app.
const RENDERER_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  codeCache: true,
};

// Must run before `app.whenReady()`; without it `protocol.handle` responses are treated
// as opaque (no origin) and the renderer would neither get a stable storage bucket nor
// be allowed to use secure-context APIs.
function registerRendererProtocolScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: RENDERER_SCHEME, privileges: RENDERER_SCHEME_PRIVILEGES },
  ]);
}

// Maps a request pathname to a file inside `dist/`. Returns null when the request is
// outside the root or does not exist — the caller then serves the SPA shell.
function resolveRendererFile(root, pathname) {
  const requested = path.join(root, path.normalize(decodeURIComponent(pathname)));

  if (requested !== root && !path.resolve(requested).startsWith(root + path.sep)) {
    return null;
  }

  try {
    const stat = fs.statSync(requested);
    return stat.isDirectory() ? path.join(requested, "index.html") : requested;
  } catch {
    return null;
  }
}

function contentTypeFor(file) {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function readRendererFile(root, pathname) {
  const candidate = resolveRendererFile(root, pathname);

  if (candidate) {
    try {
      return { body: await fsp.readFile(candidate), file: candidate };
    } catch {
      // raced deletion — fall through to the SPA shell
    }
  }

  const fallback = path.join(root, "index.html");
  return { body: await fsp.readFile(fallback), file: fallback };
}

function registerRendererProtocol(protocol, rendererDir) {
  const root = path.resolve(rendererDir);

  protocol.handle(RENDERER_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const { body, file } = await readRendererFile(root, pathname);

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": contentTypeFor(file),
        "cache-control": "no-store",
        // Same-origin in practice; the header keeps `crossorigin` asset tags and any
        // fetch() from a differently-hashed origin working.
        "access-control-allow-origin": "*",
      },
    });
  });
}

module.exports = {
  RENDERER_SCHEME,
  RENDERER_URL,
  registerRendererProtocol,
  registerRendererProtocolScheme,
  resolveRendererFile,
};