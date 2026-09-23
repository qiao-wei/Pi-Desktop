/**
 * Regression test for the boundary of `GET /api/local-media` — the endpoint that lets
 * an answer show a file the agent wrote on disk.
 *
 * The server binds 127.0.0.1 with no origin check, so "read whatever path the browser
 * asks for" would let any web page on the machine pull images off disk. The agreed
 * boundary (2026-09-06): project directory, agent directory, temp directory, home —
 * resolved through symlinks, media extensions only.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LOCAL_MEDIA_MIME_TYPES,
  isInsidePath,
  mediaKind,
  parseByteRange,
  resolveLocalMediaPath,
} from "../server/localMedia.mjs";

const sandbox = realpathSync(join(mkdtemp("pi-desktop-media-")));
const projectDir = join(sandbox, "project");
const outsideDir = join(sandbox, "outside");
mkdirSync(join(projectDir, "docs"), { recursive: true });
mkdirSync(outsideDir, { recursive: true });
writeFileSync(join(projectDir, "shot.png"), "fake-png-bytes");
writeFileSync(join(projectDir, "clip.mp4"), Buffer.alloc(4096, 7));
writeFileSync(join(projectDir, "notes.txt"), "secret-ish text file");
writeFileSync(join(outsideDir, "private.png"), "private");
writeFileSync(join(projectDir, "big.mov"), Buffer.alloc(8192, 1));
mkdirSync(join(projectDir, "folder.png"), { recursive: true });
symlinkSync(join(outsideDir, "private.png"), join(projectDir, "link.png"));

const roots = [projectDir];
const options = { roots, cwd: projectDir, homedir: projectDir };

test("media inside the allowed roots is readable", () => {
  const shot = resolveLocalMediaPath(join(projectDir, "shot.png"), options);
  assert.equal(shot.ok, true);
  assert.equal(shot.mimeType, "image/png");
  assert.equal(shot.kind, "image");
  assert.equal(shot.size, statSync(join(projectDir, "shot.png")).size);

  const clip = resolveLocalMediaPath(join(projectDir, "clip.mp4"), options);
  assert.equal(clip.kind, "video");
  assert.equal(clip.mimeType, "video/mp4");
});

test("relative paths belong to the project the agent runs in", () => {
  const climbed = resolveLocalMediaPath("docs/../shot.png", options);
  assert.equal(climbed.ok, true);
  assert.equal(climbed.path, realpathSync(join(projectDir, "shot.png")));

  const nested = resolveLocalMediaPath("./clip.mp4", options);
  assert.equal(nested.ok, true);
  assert.equal(nested.path, realpathSync(join(projectDir, "clip.mp4")));
});

test("~ and file: urls reach the same file", () => {
  assert.equal(resolveLocalMediaPath("~/clip.mp4", options).path, realpathSync(join(projectDir, "clip.mp4")));
  assert.equal(resolveLocalMediaPath("~", options).ok, false);
  assert.equal(resolveLocalMediaPath("file://" + join(projectDir, "shot.png"), options).path, realpathSync(join(projectDir, "shot.png")));
});

test("file: urls with escaped characters and a remote host", () => {
  const spaced = join(projectDir, "with space.png");
  writeFileSync(spaced, "x");
  assert.equal(resolveLocalMediaPath(`file://${spaced.replace(/ /g, "%20")}`, options).path, realpathSync(spaced));
  const remote = resolveLocalMediaPath("file://elsewhere/Users/me/a.png", options);
  assert.equal(remote.ok, false);
  assert.equal(remote.status, 400);
});

test("anything outside the roots is refused, including through a symlink", () => {
  const outside = resolveLocalMediaPath(join(outsideDir, "private.png"), options);
  assert.equal(outside.ok, false);
  assert.equal(outside.status, 403);

  const traversal = resolveLocalMediaPath(join(projectDir, "..", "outside", "private.png"), options);
  assert.equal(traversal.ok, false);
  assert.equal(traversal.status, 403);

  // `link.png` sits inside the project but resolves to a file that does not.
  const viaLink = resolveLocalMediaPath(join(projectDir, "link.png"), options);
  assert.equal(viaLink.ok, false);
  assert.equal(viaLink.status, 403);
});

test("only media extensions are served, and the check happens without a second read", () => {
  const text = resolveLocalMediaPath(join(projectDir, "notes.txt"), options);
  assert.equal(text.ok, false);
  assert.equal(text.status, 415);
  assert.ok(!("path" in text && text.path));

  assert.equal(LOCAL_MEDIA_MIME_TYPES[".png"], "image/png");
  assert.equal(LOCAL_MEDIA_MIME_TYPES[".MP4".toLowerCase()], "video/mp4");
});

test("missing files, directories and oversized media do not stream", () => {
  assert.equal(resolveLocalMediaPath(join(projectDir, "nope.png"), options).status, 404);
  // A directory that looks like media by name still has to be refused.
  assert.equal(resolveLocalMediaPath(join(projectDir, "folder.png"), options).status, 404);
  // No extension at all is refused even earlier, without a filesystem answer.
  assert.equal(resolveLocalMediaPath(join(projectDir, "docs"), options).status, 415);

  const big = resolveLocalMediaPath(join(projectDir, "big.mov"), { ...options, maxBytes: 1024 });
  assert.equal(big.ok, false);
  assert.equal(big.status, 413);
});

test("garbage input is rejected before any path is built", () => {
  assert.equal(resolveLocalMediaPath("", options).status, 400);
  assert.equal(resolveLocalMediaPath("   ", options).status, 400);
  assert.equal(resolveLocalMediaPath("/a/b\0.png", options).status, 400);
  assert.equal(resolveLocalMediaPath("http://example.com/a.png", options).status, 400);
  assert.equal(resolveLocalMediaPath("javascript:alert(1).png", options).status, 400);
  assert.equal(resolveLocalMediaPath("data:image/png;base64,AAA", options).status, 400);
});

test("a relative path with no project directory cannot be resolved", () => {
  const result = resolveLocalMediaPath("shot.png", { ...options, cwd: "" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test("mediaKind follows the mime table", () => {
  assert.equal(mediaKind("video/webm"), "video");
  assert.equal(mediaKind("image/svg+xml"), "image");
});

test("byte ranges: what webkit video seeking sends", () => {
  assert.equal(parseByteRange(undefined, 1000), null);
  assert.equal(parseByteRange("", 1000), null);
  assert.deepEqual(parseByteRange("bytes=0-1", 1000), { start: 0, end: 1 });
  assert.deepEqual(parseByteRange("bytes=999-", 1000), { start: 999, end: 999 });
  assert.deepEqual(parseByteRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-500", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-5000", 1000), { start: 0, end: 999 });
  // A range past the end is clamped, an impossible one is dropped (caller sends 200).
  assert.deepEqual(parseByteRange("bytes=0-99999", 1000), { start: 0, end: 999 });
  assert.equal(parseByteRange("bytes=1000-2000", 1000), null);
  assert.equal(parseByteRange("bytes=900-100", 1000), null);
  assert.equal(parseByteRange("bytes=abc-def", 1000), null);
  assert.equal(parseByteRange("bytes=0-1,20-30", 1000), null);
  assert.equal(parseByteRange("items=0-1", 1000), null);
  assert.equal(parseByteRange("bytes=0-1", 0), null);
});

test("isInsidePath treats the root itself as inside but a prefix string as outside", () => {
  assert.equal(isInsidePath("/a/b", "/a/b"), true);
  assert.equal(isInsidePath("/a/b", "/a/b/c"), true);
  assert.equal(isInsidePath("/a/b", "/a/bc"), false);
  assert.equal(isInsidePath("/a/b", "/a"), false);
});

test("the temp root works through its /private symlink, and other roots still gate", () => {
  const tmpReal = realpathSync(tmpdir());
  const probe = join(tmpReal, `pi-desktop-probe-${process.pid}.png`);
  writeFileSync(probe, "x");
  try {
    // Asked with the unresolved `/var/...` spelling, inside a root spelled the same way.
    const viaTmp = resolveLocalMediaPath(probe, { roots: [tmpdir()], cwd: projectDir, homedir: projectDir });
    assert.equal(viaTmp.ok, true);
    assert.equal(viaTmp.path, probe);
  } finally {
    rmSync(probe, { force: true });
  }

  // The same file is out of bounds when the only root is somewhere else.
  assert.equal(
    resolveLocalMediaPath(join(projectDir, "shot.png"), { roots: [outsideDir], homedir: outsideDir }).status,
    403,
  );
});

function mkdtemp(prefix) {
  const base = join(realpathSync(tmpdir()), prefix);
  mkdirSync(base, { recursive: true });
  return base;
}

process.on("exit", () => {
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});
