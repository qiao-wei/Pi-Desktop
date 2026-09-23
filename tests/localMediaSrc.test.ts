/**
 * Regression test for "响应里的本地图片显示不了".
 *
 * The chat UI runs on an http origin, so `![](/Users/me/a.png)` in an answer used to
 * be requested as `http://127.0.0.1:5176/Users/me/a.png` (404) and nothing rendered.
 * Every local spelling now has to be rewritten to the local-media endpoint, while
 * sources the WebView can already load stay untouched — rewriting a `data:` URI or a
 * CDN url would break working images.
 *
 * Which paths may be read at all is decided server-side; see localMediaAccess.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  detectMediaKind,
  isDirectMediaSrc,
  localMediaUrl,
  resolveMediaSrc,
} from "../src/lib/localMedia.ts";

const API = "http://127.0.0.1:6474";
const proxied = (path: string) =>
  `${API}/api/local-media?path=${encodeURIComponent(path)}`;

test("local paths are proxied through the server", () => {
  assert.equal(resolveMediaSrc("/Users/me/work/shot.png", API), proxied("/Users/me/work/shot.png"));
  assert.equal(resolveMediaSrc("~/Downloads/a.jpg", API), proxied("~/Downloads/a.jpg"));
  assert.equal(resolveMediaSrc("./docs/diagram.svg", API), proxied("./docs/diagram.svg"));
  assert.equal(resolveMediaSrc("docs/diagram.svg", API), proxied("docs/diagram.svg"));
  assert.equal(resolveMediaSrc("C:\\Users\\me\\a.png", API), proxied("C:\\Users\\me\\a.png"));
});

test("the path survives spaces, CJK and query-looking characters", () => {
  assert.equal(
    resolveMediaSrc("/Users/me/文档/授权 二维码.png", API),
    `${API}/api/local-media?path=${encodeURIComponent("/Users/me/文档/授权 二维码.png")}`,
  );
  const url = new URL(resolveMediaSrc("/a/b?c=1.png", API)!);
  assert.equal(url.searchParams.get("path"), "/a/b?c=1.png");
});

test("sources the webview can load itself are left alone", () => {
  const dataUri = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(resolveMediaSrc(dataUri, API), dataUri);
  assert.equal(resolveMediaSrc("https://cdn/x/a.png", API), "https://cdn/x/a.png");
  assert.equal(resolveMediaSrc("http://localhost:3000/a.png", API), "http://localhost:3000/a.png");
  assert.equal(resolveMediaSrc("blob:http://127.0.0.1/uuid", API), "blob:http://127.0.0.1/uuid");
  assert.ok(isDirectMediaSrc(dataUri));
  assert.ok(!isDirectMediaSrc("/Users/me/a.png"));
});

test("file: urls become the plain path they name", () => {
  assert.equal(
    resolveMediaSrc("file:///Users/me/a%20b.png", API),
    proxied("/Users/me/a b.png"),
  );
  assert.equal(resolveMediaSrc("file:///Users/me/a.png", API), proxied("/Users/me/a.png"));
});

test("nothing usable comes back as undefined", () => {
  assert.equal(resolveMediaSrc(undefined, API), undefined);
  assert.equal(resolveMediaSrc("", API), undefined);
  assert.equal(resolveMediaSrc("   ", API), undefined);
});

test("video sources are recognised whatever spelling they arrive in", () => {
  assert.equal(detectMediaKind("/Users/me/out/clip.mp4"), "video");
  assert.equal(detectMediaKind("demo.MOV"), "video");
  assert.equal(detectMediaKind("https://cdn/x/a.webm?v=2"), "video");
  assert.equal(detectMediaKind("file:///Users/me/a.mp4"), "video");
  assert.equal(detectMediaKind("data:video/mp4;base64,AAA"), "video");
  assert.equal(detectMediaKind("data:image/png;base64,AAA"), "image");
  assert.equal(detectMediaKind("/Users/me/a.png"), "image");
  assert.equal(detectMediaKind("/Users/me/a.pdf"), undefined);
  assert.equal(detectMediaKind(""), undefined);
  assert.equal(detectMediaKind(undefined), undefined);
});

test("an already proxied url is left as it is (idempotent)", () => {
  const once = resolveMediaSrc("/Users/me/work/clip.mp4", API)!;
  assert.equal(resolveMediaSrc(once, API), once);
});

test("localMediaUrl trims a trailing slash on the api base", () => {
  assert.equal(
    localMediaUrl("/tmp/a.png", "http://127.0.0.1:6474/"),
    proxied("/tmp/a.png"),
  );
});

test("every renderer that can show media routes through the resolver", () => {
  const surfaces: Array<[string, string]> = [
    ["chat answer markdown", "../src/components/assistant-ui/elements/markdown-text.tsx"],
    ["image message part", "../src/components/assistant-ui/elements/image.tsx"],
    ["skill preview markdown", "../src/lib/markdown.tsx"],
  ];

  for (const [label, file] of surfaces) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /resolveMediaSrc\(/, `${label} must resolve local media paths`);
  }
});
