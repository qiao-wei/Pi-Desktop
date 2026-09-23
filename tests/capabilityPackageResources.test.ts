/**
 * A pi package is more than its extension entry: pi resolves `extensions`, `skills`, `prompts`
 * and `themes` from the package root (package.json `pi` manifest, or the directory convention).
 * Pi Desktop only ever read the extension paths out of that resolution, so a package that ships
 * skills or prompts looked empty in the panel.
 *
 * These tests pin the pure mapping: counts for the card chips, detail rows (package-relative
 * paths + pi's enabled flag) and the progress payload mapping used by the install/update stream.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  MAX_RESOURCE_PREVIEW_BYTES,
  PACKAGE_RESOURCE_TYPES,
  emptyPackageResources,
  findPackageResourceEntry,
  packageProgressEvent,
  packageResourceDetails,
  resourcePreview,
  summarizePackageResources,
} from "../server/capabilityPackageResources.mjs";

const ROOT = "/tmp/pi-desktop/pkg";

const RESOLVED = {
  extensions: [
    { path: join(ROOT, "extensions", "index.ts"), enabled: true },
    { path: join(ROOT, "extensions", "legacy.ts"), enabled: false },
  ],
  skills: [{ path: join(ROOT, "skills", "one", "SKILL.md"), enabled: true }],
  prompts: [],
  themes: [{ path: join(ROOT, "themes", "midnight.json"), enabled: true }],
};

test("counts cover all four types and tolerate a missing resolution", () => {
  const counts = summarizePackageResources(RESOLVED);
  assert.deepEqual(Object.keys(counts), [...PACKAGE_RESOURCE_TYPES]);
  assert.deepEqual(counts, { extensions: 2, skills: 1, prompts: 0, themes: 1 });

  // A package that is not installed yet has no resolution at all — the card must still render
  // four chips instead of crashing or hiding types.
  const zero = { extensions: 0, skills: 0, prompts: 0, themes: 0 };
  assert.deepEqual(summarizePackageResources(undefined), zero);
  assert.deepEqual(summarizePackageResources({ skills: "nope" }), zero);
  // `emptyPackageResources` is the array shape the detail endpoint starts from.
  assert.deepEqual(Object.keys(emptyPackageResources()), [...PACKAGE_RESOURCE_TYPES]);
  assert.deepEqual(packageResourceDetails(undefined), {
    extensions: [], skills: [], prompts: [], themes: [],
  });
});

test("details are package-relative and keep pi's enabled flag", () => {
  const details = packageResourceDetails(RESOLVED, { packageRoot: ROOT });
  assert.deepEqual(Object.keys(details), [...PACKAGE_RESOURCE_TYPES]);
  assert.deepEqual(details.skills, [{
    path: join(ROOT, "skills", "one", "SKILL.md"),
    relativePath: join("skills", "one", "SKILL.md"),
    enabled: true,
  }]);
  // pi switches a filtered-out entry off; the dialog says so instead of listing it as active.
  assert.equal(details.extensions[1].enabled, false);
  assert.equal(details.extensions[0].relativePath, join("extensions", "index.ts"));
});

test("details fall back to pi's metadata base and to the absolute path", () => {
  const resolved = {
    skills: [{ path: join(ROOT, "skills", "a", "SKILL.md"), metadata: { baseDir: ROOT } }],
    themes: [{ path: "/elsewhere/theme.json" }],
  };
  const details = packageResourceDetails(resolved);
  assert.equal(details.skills[0].relativePath, join("skills", "a", "SKILL.md"));
  // Outside the package root there is no meaningful relative form — keep the absolute path.
  assert.equal(details.themes[0].relativePath, "/elsewhere/theme.json");
  // No packageRoot and no metadata: still return the raw path rather than an empty row.
  assert.equal(packageResourceDetails({ extensions: [{ path: "/abs/ext.ts" }] }).extensions[0].relativePath, "/abs/ext.ts");
});

test("progress events map to a stable NDJSON payload", () => {
  assert.deepEqual(packageProgressEvent({ type: "start", action: "install", source: "npm:x", message: "Installing npm:x..." }), {
    type: "package_progress",
    phase: "start",
    action: "install",
    source: "npm:x",
    message: "Installing npm:x...",
  });
  // pi's `complete` event carries no message; the payload must still be well-formed.
  assert.deepEqual(packageProgressEvent({ type: "complete", action: "install", source: "npm:x" }), {
    type: "package_progress",
    phase: "complete",
    action: "install",
    source: "npm:x",
    message: "",
  });
  assert.equal(packageProgressEvent({ type: "error", action: "update", source: "npm:x", message: "boom" }).phase, "error");
  // Unknown/missing event types must not turn into `undefined` on the wire.
  assert.deepEqual(packageProgressEvent(undefined), { type: "package_progress", phase: "start", action: "", source: "", message: "" });
});

test("file previews are whitelisted by pi's own resolution of this package", () => {
  const skill = join(ROOT, "skills", "one", "SKILL.md");
  const found = findPackageResourceEntry(RESOLVED, skill, { packageRoot: ROOT });
  assert.deepEqual(found, { type: "skills", path: skill, absolutePath: skill, enabled: true });
  // The dialog sends back what the list gave it; a package-relative path means the same entry.
  assert.equal(findPackageResourceEntry(RESOLVED, join("skills", "one", "SKILL.md"), { packageRoot: ROOT })?.path, skill);
  // pi's filtered entry is still readable, but the dialog must be able to tell it is disabled.
  assert.equal(findPackageResourceEntry(RESOLVED, join(ROOT, "extensions", "legacy.ts"), { packageRoot: ROOT })?.enabled, false);

  // Anything pi did not resolve for this package is refused — including traversal and absolute
  // paths of the client's own choosing.
  assert.equal(findPackageResourceEntry(RESOLVED, join(ROOT, "..", "..", "etc", "passwd"), { packageRoot: ROOT }), null);
  assert.equal(findPackageResourceEntry(RESOLVED, "/etc/passwd", { packageRoot: ROOT }), null);
  assert.equal(findPackageResourceEntry(RESOLVED, "", { packageRoot: ROOT }), null);
  assert.equal(findPackageResourceEntry(undefined, skill, { packageRoot: ROOT }), null);
});

test("preview text refuses binaries and reports truncation", () => {
  assert.deepEqual(resourcePreview(Buffer.from("hello\nworld")), {
    content: "hello\nworld", binary: false, truncated: false, bytes: 11,
  });
  const binary = resourcePreview(Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
  assert.equal(binary.binary, true);
  assert.equal(binary.content, "");
  assert.equal(binary.bytes, 5);
  // The server reads only the cap, so the real size has to come in as `totalBytes`.
  const cut = resourcePreview(Buffer.from("abc"), { totalBytes: MAX_RESOURCE_PREVIEW_BYTES * 4 });
  assert.equal(cut.content, "abc");
  assert.equal(cut.truncated, true);
  assert.equal(cut.bytes, MAX_RESOURCE_PREVIEW_BYTES * 4);
  assert.deepEqual(resourcePreview(undefined), { content: "", binary: false, truncated: false, bytes: 0 });
});