import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findProjectByCwd,
  isSameProjectCwd,
  normalizeProjectCwd,
} from "../src/shared/projectPaths.ts";
import { findProjectByFolder, isSameDirectory } from "../server/projectFolders.mjs";

/**
 * "新建项目时，如果目录已经存在" — a project is keyed by its folder, so the New
 * project dialog and `createProject` must agree on when two spellings are one
 * folder. The dialog uses the shared rules (no Node in the browser); the bridge
 * adds `realpath`, because a symlink is the same directory.
 */

const projects = [
  { id: "alpha", name: "Alpha", cwd: "/Users/me/work/alpha" },
  { id: "beta", name: "Beta", cwd: "/Users/me/work/beta/" },
  { id: "legacy", name: "Legacy", cwd: "" },
];

test("normalizeProjectCwd removes the noise that splits one folder in two", () => {
  assert.equal(normalizeProjectCwd("  /Users/me/work/alpha  "), "/Users/me/work/alpha");
  assert.equal(normalizeProjectCwd("/Users/me/work/alpha/"), "/Users/me/work/alpha");
  assert.equal(normalizeProjectCwd("/Users/me//work///alpha"), "/Users/me/work/alpha");
  assert.equal(normalizeProjectCwd("/"), "/");
  assert.equal(normalizeProjectCwd(""), "");
  assert.equal(normalizeProjectCwd(undefined as unknown as string), "");
});

test("normalizeProjectCwd understands Windows paths but not POSIX case", () => {
  assert.equal(normalizeProjectCwd("C:\\Users\\Me\\Work\\Alpha\\"), "c:/users/me/work/alpha");
  assert.equal(normalizeProjectCwd("C:/Users/Me/Work/Alpha"), "c:/users/me/work/alpha");
  // Case-sensitive volumes are real on POSIX: `Alpha` and `alpha` stay distinct.
  assert.notEqual(normalizeProjectCwd("/work/Alpha"), normalizeProjectCwd("/work/alpha"));
});

test("isSameProjectCwd never matches on an empty folder", () => {
  assert.equal(isSameProjectCwd("", ""), false);
  assert.equal(isSameProjectCwd("   ", "/Users/me/work/alpha"), false);
  assert.equal(isSameProjectCwd("/Users/me/work/alpha", "/Users/me/work/alpha"), true);
});

test("findProjectByCwd locates the project that owns the folder", () => {
  assert.equal(findProjectByCwd(projects, "/Users/me/work/alpha")?.id, "alpha");
  // The stored value carries the trailing separator, the typed one does not.
  assert.equal(findProjectByCwd(projects, "/Users/me/work/beta")?.id, "beta");
  assert.equal(findProjectByCwd(projects, "/Users/me/work/alpha/")?.id, "alpha");
  assert.equal(findProjectByCwd(projects, "/Users/me/work/gamma"), undefined);
  assert.equal(findProjectByCwd(projects, "alpha"), undefined);
  // A project without a folder must not swallow every blank query.
  assert.equal(findProjectByCwd(projects, ""), undefined);
  assert.equal(findProjectByCwd([], "/Users/me/work/alpha"), undefined);
});

test("isSameDirectory follows symlinks on the bridge (the dialog cannot)", () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "pi-desktop-folders-")));
  try {
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    const link = join(root, "link");
    symlinkSync(real, link);

    assert.equal(isSameDirectory(real, link), true);
    assert.equal(isSameDirectory(link, `${link}/`), true);
    assert.equal(isSameDirectory(real, join(real, "nested")), false);
    // Missing paths degrade to the textual rule instead of throwing.
    assert.equal(isSameDirectory(join(root, "gone"), join(root, "gone")), true);
    assert.equal(isSameDirectory(join(root, "gone"), join(root, "other")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findProjectByFolder matches through symlink and separator noise", () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "pi-desktop-folders-")));
  try {
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    const link = join(root, "link");
    symlinkSync(real, link);

    const tracked = [{ id: "one", name: "One", cwd: link }];
    assert.equal(findProjectByFolder(tracked, `${real}/`)?.id, "one");
    assert.equal(findProjectByFolder(tracked, join(root, "elsewhere")), undefined);
    assert.equal(findProjectByFolder(tracked, "  "), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
