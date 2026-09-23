"use strict";

const path = require("node:path");

// Host policy helpers, kept free of Electron imports so they stay unit-testable.
// These mirror `is_openable_target` / `dialog_starting_directory` in
// src-tauri/src/lib.rs — both shells have to accept exactly the same targets.

const OPENABLE_LINK = /^(?:https?:|mailto:)/i;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;
const WINDOWS_UNC_PATH = /^\\\\/;

function isOpenableTarget(target) {
  const value = String(target ?? "").trim();
  if (!value) {
    return false;
  }

  if (OPENABLE_LINK.test(value)) {
    return true;
  }

  // UNC shares and drive-letter paths are absolute on Windows only, and
  // `path.isAbsolute` answers per-host, so they are matched explicitly here.
  if (WINDOWS_UNC_PATH.test(value) || WINDOWS_ABSOLUTE_PATH.test(value)) {
    return true;
  }

  return path.isAbsolute(value);
}

// The directory a native picker should open in, or undefined when the hint is
// empty / unusable (same fallback chain as the Rust helper).
function dialogStartingDirectory(defaultPath) {
  const value = String(defaultPath ?? "").trim();
  if (!value) {
    return undefined;
  }

  const fs = require("node:fs");
  if (isDirectory(value)) {
    return value;
  }

  const parent = path.dirname(value);
  if (!parent || parent === value) {
    return undefined;
  }

  return isDirectory(parent) ? parent : undefined;
}

function isDirectory(candidate) {
  try {
    return require("node:fs").statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { dialogStartingDirectory, isOpenableTarget };
