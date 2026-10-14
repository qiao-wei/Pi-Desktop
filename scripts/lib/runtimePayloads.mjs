/**
 * The bundled node/python payloads: which distribution to fetch for which target, and how a
 * downloaded archive becomes a shippable `node-runtime` / `python-runtime` directory.
 *
 * Why download a pinned release instead of copying the interpreter the build machine happens
 * to have installed:
 *
 *  - the shipped version becomes a fact of the repository (version + archive + sha256, written
 *    into `SOURCES.json`) instead of a fact of whoever ran the build - `node:build` used to
 *    copy `process.execPath`'s own installation, so the app shipped `v25.4.0` on one machine
 *    and something else on the next;
 *  - the official archives are already relocatable. Copying an *installed* runtime is what
 *    created the failures `scripts/lib/pythonRuntime.mjs` exists to repair: `cpSync` recreating
 *    symlinks back into the source install, `ensurepip` baking the build-time absolute path
 *    into `bin/pip`;
 *  - a payload can be assembled for a target the host cannot execute (the win32 payload on a
 *    macOS build machine), which is what the target-keyed table below is for.
 *
 * Download sources default to npmmirror because that is what works from a CN build machine;
 * both are overridable (`PI_DESKTOP_NODE_DIST_MIRROR` / `PI_DESKTOP_PYTHON_DIST_MIRROR`), and
 * the python upstream is python-build-standalone's GitHub Releases.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Node's current release line. Must be bumped together with every sha256 in runtimePins.json. */
export const NODE_VERSION = "v25.9.0";
/** python-build-standalone's CPython version; version and release tag move as a pair. */
export const PYTHON_VERSION = "3.13.13";
export const PYTHON_RELEASE_TAG = "20260408";

const DEFAULT_NODE_DIST_BASE = "https://cdn.npmmirror.com/binaries/node";
/** python-build-standalone's release mirrors: npmmirror by default, GitHub Releases upstream. */
const DEFAULT_PYTHON_DIST_BASE = "https://cdn.npmmirror.com/binaries/python-build-standalone";
export const PYTHON_DIST_UPSTREAM_BASE =
  "https://github.com/astral-sh/python-build-standalone/releases/download";

/**
 * One entry per target we can assemble a payload for. `key` is the desktop's platform spelling
 * (`darwin-arm64`), and `triple` is the Rust triple `scripts/pack.mjs` hands down - the table is
 * the only place those two vocabularies meet.
 *
 * The triple in a python archive name comes from python-build-standalone and is not the same
 * string as the node one (`aarch64-pc-windows-msvc` vs `win32-arm64` in our own keys).
 */
export const RUNTIME_TARGETS = {
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    nodeArchive: `node-${NODE_VERSION}-darwin-arm64.tar.xz`,
    nodeArchiveType: "tar.xz",
    pythonTriple: "aarch64-apple-darwin",
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    nodeArchive: `node-${NODE_VERSION}-darwin-x64.tar.xz`,
    nodeArchiveType: "tar.xz",
    pythonTriple: "x86_64-apple-darwin",
  },
  "win32-x64": {
    triple: "x86_64-pc-windows-msvc",
    nodeArchive: `node-${NODE_VERSION}-win-x64.zip`,
    nodeArchiveType: "zip",
    pythonTriple: "x86_64-pc-windows-msvc",
  },
  "win32-arm64": {
    triple: "aarch64-pc-windows-msvc",
    nodeArchive: `node-${NODE_VERSION}-win-arm64.zip`,
    nodeArchiveType: "zip",
    pythonTriple: "aarch64-pc-windows-msvc",
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-gnu",
    nodeArchive: `node-${NODE_VERSION}-linux-x64.tar.xz`,
    nodeArchiveType: "tar.xz",
    pythonTriple: "x86_64-unknown-linux-gnu",
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-gnu",
    nodeArchive: `node-${NODE_VERSION}-linux-arm64.tar.xz`,
    nodeArchiveType: "tar.xz",
    pythonTriple: "aarch64-unknown-linux-gnu",
  },
};

/**
 * Node distribution files nobody needs at runtime: headers, docs, and corepack (npm does not
 * use it, and shipping a second package manager is a second thing to keep patched).
 */
export const NODE_PRUNED_PATHS = [
  "include",
  "share",
  "CHANGELOG.md",
  "README.md",
  "bin/corepack",
  "lib/node_modules/corepack",
  // The Windows zip spreads the same files over the archive root.
  "corepack",
  "corepack.cmd",
  "corepack.ps1",
  "node_modules/corepack",
  "install_tools.bat",
  "nodevars.bat",
];

const PINS_FILE = join(dirname(fileURLToPath(import.meta.url)), "runtimePins.json");

/** Platform key for a target triple (or for the key itself, so callers can pass either). */
export function runtimeTargetKey(triple = "") {
  const value = String(triple).trim();
  if (RUNTIME_TARGETS[value]) {
    return value;
  }
  for (const [key, spec] of Object.entries(RUNTIME_TARGETS)) {
    if (spec.triple === value) {
      return key;
    }
  }
  throw new Error(
    `unsupported bundled-runtime target: ${value || "(empty)"} (known: ${Object.keys(RUNTIME_TARGETS).join(", ")})`,
  );
}

export function runtimeSpec(targetTriple) {
  const key = runtimeTargetKey(targetTriple);
  return { key, ...RUNTIME_TARGETS[key] };
}

/** Does this target run on the build machine itself? Only then can a payload be executed. */
export function isNativeTarget(targetTriple, platform = process.platform, arch = process.arch) {
  const key = runtimeTargetKey(targetTriple);
  const hostArch = arch === "arm64" ? "arm64" : "x64";
  return key === `${platform === "win32" ? "win32" : platform}-${hostArch}`;
}

function trimmedBase(value, fallback) {
  const trimmed = String(value ?? "").trim();
  return (trimmed || fallback).replace(/\/+$/u, "");
}

export function nodeDistBase(env = process.env) {
  return trimmedBase(env.PI_DESKTOP_NODE_DIST_MIRROR, DEFAULT_NODE_DIST_BASE);
}

export function pythonDistBase(env = process.env) {
  return trimmedBase(env.PI_DESKTOP_PYTHON_DIST_MIRROR, DEFAULT_PYTHON_DIST_BASE);
}

export function nodeArchiveSpec(targetTriple, env = process.env) {
  const spec = runtimeSpec(targetTriple);
  return {
    name: spec.nodeArchive,
    type: spec.nodeArchiveType,
    url: `${nodeDistBase(env)}/${NODE_VERSION}/${spec.nodeArchive}`,
  };
}

export function pythonArchiveName(targetTriple) {
  const spec = runtimeSpec(targetTriple);
  return `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-${spec.pythonTriple}-install_only_stripped.tar.gz`;
}

export function pythonArchiveSpec(targetTriple, env = process.env) {
  const name = pythonArchiveName(targetTriple);
  return {
    name,
    type: "tar.gz",
    url: `${pythonDistBase(env)}/${PYTHON_RELEASE_TAG}/${encodeURIComponent(name)}`,
  };
}

/** The sha256 recorded when the payload was first fetched, if any. */
export function pinnedSha256(id, targetTriple) {
  try {
    const pins = JSON.parse(readFileSync(PINS_FILE, "utf8"));
    return String(pins?.[id]?.[runtimeTargetKey(targetTriple)] ?? "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Recorded hash vs. shipped hash. A target without a pin is not an error - the new hash is
 * written into `SOURCES.json` (that is how the first pin is produced) - but it does mean this
 * build is not verifiable against the repository, so it says so out loud.
 */
export function verifyPinnedHash({ id, target, sha256, warn = console.warn }) {
  const pinned = pinnedSha256(id, target);
  if (!pinned) {
    warn(
      `[${id}] no pinned sha256 for ${target} yet; recording ${sha256}. ` +
        `Add it to scripts/lib/runtimePins.json to make this payload verifiable.`,
    );
    return { pinned: null, verified: false };
  }
  if (pinned !== sha256) {
    throw new Error(
      `[${id}] sha256 mismatch for ${target}: pinned ${pinned}, downloaded ${sha256}. ` +
        `Either the mirror served something else, or the version was bumped without updating runtimePins.json.`,
    );
  }
  return { pinned, verified: true };
}

/** Download to `destination`, returning the sha256 of the bytes that arrived. */
export async function downloadArchive(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status} (${url})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${String(result.status)}`);
  }
}

/**
 * Unpack an archive into `destinationDir`, dropping the archive's single top-level directory.
 * tar handles both tar.xz and tar.gz; the Windows payloads are zips, which have no
 * `--strip-components` equivalent and are flattened afterwards.
 */
export function extractArchive(archivePath, archiveType, destinationDir) {
  mkdirSync(destinationDir, { recursive: true });
  if (archiveType === "zip") {
    run("unzip", ["-o", "-q", archivePath, "-d", destinationDir]);
    flattenArchiveRoot(destinationDir);
    return;
  }
  run("tar", ["-xf", archivePath, "-C", destinationDir, "--strip-components=1"]);
}

function flattenArchiveRoot(destinationDir) {
  const entries = readdirSync(destinationDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.length !== 1) {
    return;
  }
  const nestedRoot = join(destinationDir, entries[0].name);
  for (const child of readdirSync(nestedRoot)) {
    const from = join(nestedRoot, child);
    const to = join(destinationDir, child);
    rmSync(to, { recursive: true, force: true });
    // Same directory, so this rename never crosses a device.
    renameSync(from, to);
  }
  rmSync(nestedRoot, { recursive: true, force: true });
}

export function pruneNodeRuntime(nodeDir) {
  const removed = [];
  for (const relativePath of NODE_PRUNED_PATHS) {
    const target = join(nodeDir, relativePath);
    if (!existsSync(target)) {
      continue;
    }
    rmSync(target, { recursive: true, force: true });
    removed.push(relativePath);
  }
  return removed;
}

/** Archives built on a POSIX host keep the executable bit; the zips (`unzip`) do not. */
export function ensureExecutable(path) {
  try {
    if (statSync(path).isFile()) {
      chmodSync(path, 0o755);
    }
  } catch {
    // Windows payloads have no mode to set, and a symlink needs none.
  }
}

/**
 * Provenance, next to the payload it describes: which archive this directory came from and what
 * it hashed to. `LICENSE.txt` is the distribution's own license when the archive ships one
 * (node does; python-build-standalone does not).
 */
export function writeProvenance(runtimeDir, sources) {
  writeFileSync(join(runtimeDir, "SOURCES.json"), `${JSON.stringify(sources, null, 2)}\n`, "utf8");
  for (const candidate of ["LICENSE", "LICENSE.txt", "LICENSE.md"]) {
    const licensePath = join(runtimeDir, candidate);
    if (existsSync(licensePath)) {
      if (candidate !== "LICENSE.txt") {
        copyFileSync(licensePath, join(runtimeDir, "LICENSE.txt"));
      }
      break;
    }
  }
}