/**
 * The Electron host re-implements the two policy helpers from
 * src-tauri/src/lib.rs, so both shells must accept exactly the same targets —
 * this is the guard that keeps `open_target` from becoming an arbitrary
 * `shell.open*` escape hatch.
 *
 * Mirrors the `#[cfg(test)]` block in lib.rs plus the picker-hint fallbacks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dialogStartingDirectory, isOpenableTarget } from "../src-electron/host-policy.js";

test("open_target accepts local paths and supported links", () => {
  for (const target of [
    "/tmp/file.pdf",
    "\\\\server\\share\\file.pdf",
    "C:\\Users\\me\\file.pdf",
    "https://example.com/document",
    "http://127.0.0.1:6474/api/bootstrap",
    "mailto:hello@example.com",
  ]) {
    assert.equal(isOpenableTarget(target), true, `${target} should be openable`);
  }
});

test("open_target rejects unsafe or relative targets", () => {
  for (const target of ["../file.pdf", "file.pdf", "javascript:alert(1)", "file:///tmp/a.pdf", "", "   "]) {
    assert.equal(isOpenableTarget(target), false, `${target} should be rejected`);
  }
});

test("the picker opens in the hint directory, its parent, or nowhere", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-desktop-host-policy-")));
  try {
    const dir = join(root, "project");
    mkdirSync(dir);
    const file = join(dir, "notes.md");
    writeFileSync(file, "x");

    assert.equal(dialogStartingDirectory(dir), dir);
    // Trailing slash is kept verbatim (the Rust helper returns the hint as given).
    assert.equal(dialogStartingDirectory(`${dir}/`), `${dir}/`);
    assert.equal(dialogStartingDirectory(file), dir);
    assert.equal(dialogStartingDirectory(join(root, "missing", "deep.txt")), undefined);
    assert.equal(dialogStartingDirectory(undefined), undefined);
    assert.equal(dialogStartingDirectory("   "), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
