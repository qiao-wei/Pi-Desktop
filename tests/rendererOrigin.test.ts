/**
 * Guard for "panel collapse / theme / locale reset after restarting the desktop app".
 *
 * Root cause: the packaged Electron shell served `dist/` from
 * `http://127.0.0.1:<random port>` (`server.listen({ port: 0 })`). localStorage is
 * origin-scoped, so every launch wrote prefs under a *new* origin and read nothing
 * back — the UI looked like it had no persistence at all. The shell now serves the
 * renderer from the stable custom scheme `app://pi-desktop/`, matching Tauri's
 * `tauri://localhost`.
 *
 * These tests pin the origin contract itself (not a specific port): a fixed URL,
 * the scheme privileges Electron needs, and a correct dist/ file mapping.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const staticServer = require("../src-electron/static-server.js") as {
  RENDERER_SCHEME: string;
  RENDERER_URL: string;
  registerRendererProtocol: (protocol: unknown, rendererDir: string) => void;
  registerRendererProtocolScheme: (protocol: unknown) => void;
  resolveRendererFile: (root: string, pathname: string) => string | null;
};

// `app://pi-desktop` never changes between launches; an http loopback URL always did.
test("the packaged renderer origin is stable and not a loopback port", () => {
  assert.equal(staticServer.RENDERER_URL, "app://pi-desktop/index.html");
  assert.equal(staticServer.RENDERER_SCHEME, "app");
  assert.doesNotMatch(staticServer.RENDERER_URL, /127\.0\.0\.1|localhost|:\d+/);
});

test("the custom scheme is registered as a standard, secure origin", () => {
  const calls: Array<{ scheme: string; privileges: Record<string, boolean> }> = [];
  const protocol = {
    registerSchemesAsPrivileged: (schemes: typeof calls) => calls.push(...schemes),
  };

  staticServer.registerRendererProtocolScheme(protocol);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.scheme, "app");
  // `standard` is what gives the scheme an origin (localStorage bucket + relative URLs);
  // `secure` keeps crypto.subtle and friends available.
  assert.equal(calls[0]?.privileges.standard, true);
  assert.equal(calls[0]?.privileges.secure, true);
});

test("resolveRendererFile maps dist assets, directories, and blocks traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-renderer-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=root></div>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "index.js"), "console.log(1)");
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "index.html"), "<p>nested</p>");

  assert.equal(staticServer.resolveRendererFile(root, "/index.html"), join(root, "index.html"));
  assert.equal(staticServer.resolveRendererFile(root, "/assets/index.js"), join(root, "assets", "index.js"));
  // A directory serves its own index.html (vite can emit nested shells).
  assert.equal(staticServer.resolveRendererFile(root, "/nested/"), join(root, "nested", "index.html"));
  // Missing files and escapes both fall through to the SPA shell via null.
  assert.equal(staticServer.resolveRendererFile(root, "/does-not-exist.js"), null);
  assert.equal(staticServer.resolveRendererFile(root, "/../../etc/passwd"), null);
});

test("the protocol handler serves dist files and falls back to the SPA shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-renderer-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(root, "app.css"), "body{color:red}");

  let handler: ((request: Request) => Promise<Response>) | undefined;
  const protocol = {
    handle: (_scheme: string, next: (request: Request) => Promise<Response>) => {
      handler = next;
    },
  };

  staticServer.registerRendererProtocol(protocol, root);
  assert.ok(handler, "registerRendererProtocol must install a handler");

  const css = await handler(new Request("app://pi-desktop/app.css"));
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(await css.text(), "body{color:red}");

  // Unknown deep links render the app shell (client-side routing), status 200.
  const shell = await handler(new Request("app://pi-desktop/some/deep/link"));
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await shell.text(), /id=root/);

  // Traversal attempts must not escape dist/ either.
  const escaped = await handler(new Request("app://pi-desktop/%2e%2e/%2e%2e/etc/passwd"));
  assert.match(await escaped.text(), /id=root/);
});