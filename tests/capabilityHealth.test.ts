/**
 * Extension load health: the panel used to answer "当前会话已加载" from its own selection
 * set, so an installed + enabled package that never reached the session (pi autoload skipped
 * it, or the import threw) looked green. `resourceLoader.getExtensions()` has always reported
 * both the loaded set and per-path errors — nobody read it.
 *
 * These tests pin the classifier, and pin that the server reads pi's answer and that the UI
 * stopped presenting "selected" as "loaded".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describeLoadStatus, isUnhealthyLoadStatus, summarizePackageHealth } from "../server/capabilityHealth.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const NPM_ROOT = join(process.env.HOME ?? "", ".pi/agent/npm/node_modules");

function extension(path, { tools = [], commands = [], resolvedPath } = {}) {
  return { path, resolvedPath: resolvedPath ?? path, tools, commands };
}

test("a package whose extension loaded reports loaded, with the tools it registered", () => {
  const memoryEntry = join(NPM_ROOT, "pi-memory/index.ts");
  const result = summarizePackageHealth({
    loaded: [extension(memoryEntry, { tools: ["memory_search", "memory_write"], commands: [] })],
    errors: [],
    packages: [{ id: "user:npm:pi-memory", installedPath: join(NPM_ROOT, "pi-memory"), paths: [memoryEntry] }],
    activeIds: ["user:npm:pi-memory"],
  });

  assert.equal(result.packages["user:npm:pi-memory"].status, "loaded");
  assert.deepEqual(result.packages["user:npm:pi-memory"].tools, ["memory_search", "memory_write"]);
});

test("a package pi reported an error for is 'failed', and keeps the raw message", () => {
  const entry = join(NPM_ROOT, "pi-memory/index.ts");
  const result = summarizePackageHealth({
    loaded: [],
    errors: [{ path: entry, error: 'Stripping types is currently unsupported for files under "node_modules"' }],
    packages: [{ id: "user:npm:pi-memory", installedPath: join(NPM_ROOT, "pi-memory"), paths: [entry] }],
    activeIds: ["user:npm:pi-memory"],
  });

  const summary = result.packages["user:npm:pi-memory"];
  assert.equal(summary.status, "failed");
  assert.match(summary.errors[0], /Stripping types is currently unsupported/);
  assert.ok(isUnhealthyLoadStatus("failed"));
});

test("an error reported for a nested file inside the package still lands on the package", () => {
  const deep = join(NPM_ROOT, "pi-memory/scripts/helper.ts");
  const result = summarizePackageHealth({
    loaded: [],
    errors: [{ path: deep, error: "Cannot find module 'qmd'" }],
    packages: [{ id: "user:npm:pi-memory", installedPath: join(NPM_ROOT, "pi-memory"), paths: [] }],
    activeIds: ["user:npm:pi-memory"],
  });

  assert.equal(result.packages["user:npm:pi-memory"].status, "failed");
  assert.match(result.packages["user:npm:pi-memory"].errors[0], /Cannot find module/);
});

test("selected but silently absent is 'missing' — the case the old panel called loaded", () => {
  const result = summarizePackageHealth({
    loaded: [extension(join(NPM_ROOT, "pi-web-access/index.ts"), { commands: ["web_search"] })],
    errors: [],
    packages: [
      { id: "user:npm:pi-web-access", installedPath: join(NPM_ROOT, "pi-web-access"), paths: [join(NPM_ROOT, "pi-web-access/index.ts")] },
      { id: "user:npm:pi-memory", installedPath: join(NPM_ROOT, "pi-memory"), paths: [join(NPM_ROOT, "pi-memory/index.ts")] },
    ],
    activeIds: ["user:npm:pi-web-access", "user:npm:pi-memory"],
  });

  assert.equal(result.packages["user:npm:pi-web-access"].status, "loaded");
  assert.equal(result.packages["user:npm:pi-memory"].status, "missing");
  assert.ok(isUnhealthyLoadStatus("missing"));
  assert.match(describeLoadStatus("missing", result.packages["user:npm:pi-memory"]), /没有报错/);
});

test("an unselected package that is not loaded is 'disabled', not an alarm", () => {
  const result = summarizePackageHealth({
    loaded: [],
    errors: [],
    packages: [{ id: "user:npm:pi-memory", installedPath: join(NPM_ROOT, "pi-memory"), paths: [join(NPM_ROOT, "pi-memory/index.ts")] }],
    activeIds: [],
  });

  assert.equal(result.packages["user:npm:pi-memory"].status, "disabled");
  assert.ok(!isUnhealthyLoadStatus("disabled"));
});

test("a package with no resolved source is 'not-installed' rather than 'missing'", () => {
  const result = summarizePackageHealth({
    loaded: [],
    errors: [],
    packages: [{ id: "user:npm:not-here", installedPath: "", paths: [] }],
    activeIds: ["user:npm:not-here"],
  });

  assert.equal(result.packages["user:npm:not-here"].status, "not-installed");
  assert.match(describeLoadStatus("not-installed", result.packages["user:npm:not-here"]), /未解析到扩展入口/);
});

test("errors that belong to no package stay visible instead of being dropped", () => {
  const result = summarizePackageHealth({
    loaded: [],
    errors: [{ path: "/Users/someone/.pi/agent/extensions/broken.ts", error: "SyntaxError: boom" }],
    packages: [{ id: "user:npm:pi-memory", installedPath: join(NPM_ROOT, "pi-memory"), paths: [] }],
    activeIds: ["user:npm:pi-memory"],
  });

  assert.equal(result.unattributedErrors.length, 1);
  assert.match(result.unattributedErrors[0].message, /SyntaxError: boom/);
});

test("matching tolerates symlinks because extensions carry both path and resolvedPath", () => {
  const declared = join(NPM_ROOT, "pi-memory/index.ts");
  const result = summarizePackageHealth({
    loaded: [extension("/private" + declared, { resolvedPath: "/private" + declared, tools: ["memory_search"] })],
    errors: [{ path: declared, error: "duplicate tool name" }],
    packages: [{ id: "user:npm:pi-memory", installedPath: "/private" + join(NPM_ROOT, "pi-memory"), paths: [declared] }],
    activeIds: ["user:npm:pi-memory"],
  });

  // Loaded wins over the conflict warning: the extension is in the session.
  assert.equal(result.packages["user:npm:pi-memory"].status, "loaded");
});

test("empty pi results do not crash the classifier", () => {
  const result = summarizePackageHealth({});
  assert.deepEqual(result.packages, {});
  assert.deepEqual(result.unattributedErrors, []);
  assert.equal(result.packages["user:npm:whatever"], undefined);
});

test("the server reads pi's real load result and ships it with every package card", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");

  assert.match(source, /resourceLoader\?\.getExtensions\?\.\(\)/);
  assert.match(source, /summarizePackageHealth\(\{/, "the snapshot must classify against pi's result");
  assert.match(source, /loadStatus: loadHealth/, "every package card must carry its load status");
  assert.match(source, /loadErrors: loadHealth/, "every package card must carry pi's raw errors");
  assert.match(source, /extensionErrors: loadHealth/, "errors belonging to no package must still surface");
  assert.match(source, /console\.error\(message\)/, "an unhealthy load must be shouted, not only logged");
});

test("the panel no longer equates 'selected' with 'loaded'", () => {
  const card = readFileSync(join(ROOT, "src/app/App.tsx"), "utf8");
  const types = readFileSync(join(ROOT, "src/types/domain.ts"), "utf8");

  assert.ok(!/item\.active \? "当前会话已加载"/.test(card), "active must not be labelled as loaded");
  assert.match(card, /function capabilityLoadLabel/);
  assert.match(card, /case "missing":/);
  assert.match(card, /item\.loadErrors\.join/, "raw pi errors must be readable in the UI");
  assert.match(types, /loadStatus: string;/);
  assert.match(types, /loadErrors: string\[\];/);
});
