// Platform-only dependency pruning.
//
// Why this exists: `npm install` inside the bridge directory resolves `esbuild` through
// `@earendil-works/chord`, and pi ships an `npm-shrinkwrap.json` that lists esbuild's 26
// platform packages as optional dependencies. npm installs **all of them** in that case - the
// usual os/cpu filter does not apply to a shrinkwrap tree - so the bundled bridge carried 284M of
// binaries for other people's machines (only `@esbuild/darwin-arm64`, 10M, is usable here).
// `--os`/`--cpu` do not help: npm still follows the shrinkwrap. Pruning after the install does.
//
// The decision rule is npm's own: a package is platform-only when its manifest declares `os`/`cpu`,
// and it is kept when those lists match the target (including `any` and `!` negations).

import {
  existsSync as nodeExistsSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
  rmSync as nodeRmSync,
  statSync as nodeStatSync,
} from "node:fs";
import { join } from "node:path";

const DEFAULT_FS = {
  existsSync: nodeExistsSync,
  readdirSync: nodeReaddirSync,
  readFileSync: nodeReadFileSync,
  rmSync: nodeRmSync,
  statSync: nodeStatSync,
};

/** npm's `os` values, plus the words a rust target triple uses for the same thing. */
const OS_ALIASES = {
  win32: "win32",
  windows: "win32",
  win: "win32",
  darwin: "darwin",
  macos: "darwin",
  mac: "darwin",
  linux: "linux",
  freebsd: "freebsd",
  openbsd: "openbsd",
  netbsd: "netbsd",
  dragonfly: "dragonfly",
  sunos: "sunos",
  solaris: "sunos",
  aix: "aix",
  android: "android",
  openharmony: "openharmony",
};

/** npm's `cpu` values, plus the rust triple spellings. */
const CPU_ALIASES = {
  x64: "x64",
  x86_64: "x64",
  amd64: "x64",
  arm64: "arm64",
  aarch64: "arm64",
  ia32: "ia32",
  i386: "ia32",
  i586: "ia32",
  i686: "ia32",
  arm: "arm",
  armv6: "arm",
  armv7: "arm",
  thumbv7neon: "arm",
  riscv64: "riscv64",
  riscv64gc: "riscv64",
  ppc64: "ppc64",
  ppc64le: "ppc64",
  s390x: "s390x",
  mips64el: "mips64el",
  loong64: "loong64",
  loongarch64: "loong64",
};

export function normalizeOs(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const lowered = value.toLowerCase();
  return OS_ALIASES[lowered] ?? null;
}

export function normalizeCpu(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const lowered = value.toLowerCase();
  if (CPU_ALIASES[lowered]) {
    return CPU_ALIASES[lowered];
  }
  // `riscv64gc-unknown-linux-gnu`, `armv7a-...`: the triple's first segment carries extra suffixes.
  if (lowered.startsWith("riscv64")) {
    return "riscv64";
  }
  if (/^armv[678]/.test(lowered)) {
    return "arm";
  }
  return null;
}

/**
 * Which platform the tree is being assembled *for*.
 *
 * A rust target triple wins when one is known (Tauri sets `TAURI_ENV_TARGET_TRIPLE` during a
 * cross-build), otherwise the machine doing the build is the target.
 */
export function resolveTargetPlatform({ triple = "", platform = process.platform, arch = process.arch } = {}) {
  const host = { os: normalizeOs(platform) ?? platform, cpu: normalizeCpu(arch) ?? arch };
  if (!triple) {
    return host;
  }
  const segments = String(triple).split("-").filter(Boolean);
  // The cpu is always the first segment; the os can be any later one (`aarch64-apple-darwin`,
  // `x86_64-pc-windows-msvc`, `armv7-unknown-linux-gnueabihf`).
  const os = segments.slice(1).map(normalizeOs).find(Boolean) ?? host.os;
  const cpu = normalizeCpu(segments[0]) ?? host.cpu;
  return { os, cpu };
}

/** npm semantics for one of the `os` / `cpu` lists. */
function listMatches(values, value) {
  if (!Array.isArray(values) || values.length === 0) {
    return true;
  }
  const entries = values.filter((entry) => typeof entry === "string").map((entry) => entry.toLowerCase());
  const negatives = entries.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1));
  const positives = entries.filter((entry) => !entry.startsWith("!"));
  if (negatives.includes(value)) {
    return false;
  }
  if (positives.length === 0) {
    return true;
  }
  return positives.includes("any") || positives.includes(value);
}

/** True when a manifest declaring these `os` / `cpu` lists can run on `target`. */
export function platformMatches(entry, target) {
  return listMatches(entry?.os, target.os) && listMatches(entry?.cpu, target.cpu);
}

function isPlatformOnly(manifest) {
  const os = Array.isArray(manifest.os) && manifest.os.length > 0;
  const cpu = Array.isArray(manifest.cpu) && manifest.cpu.length > 0;
  return os || cpu;
}

function directoryBytes(dir, fs) {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // Unreadable file: it does not change the decision, only the reported number.
        }
      }
    }
  }
  return total;
}

/**
 * Every platform-only package in the tree that cannot run on `target`.
 *
 * Walks `node_modules` at any depth (npm nests a dependency's private tree under it) but never
 * follows symlinks, and never looks outside `root`.
 */
export function findPrunablePlatformPackages({ root, target, fs = DEFAULT_FS, maxDepth = 8 }) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // isDirectory() is false for symlinks on purpose: npm's `.bin` shims point at files we must
      // not delete through, and a link is not a package we installed.
      if (!entry.isDirectory()) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.name === "node_modules") {
        visit(full, depth + 1);
        continue;
      }
      if (entry.name.startsWith("@")) {
        visit(full, depth);
        continue;
      }
      const manifestPath = join(full, "package.json");
      if (fs.existsSync(manifestPath)) {
        let manifest = null;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        } catch {
          manifest = null;
        }
        if (manifest && isPlatformOnly(manifest) && !platformMatches(manifest, target)) {
          found.push({
            name: typeof manifest.name === "string" && manifest.name ? manifest.name : entry.name,
            version: typeof manifest.version === "string" ? manifest.version : "",
            dir: full,
            os: manifest.os ?? [],
            cpu: manifest.cpu ?? [],
          });
        }
      }
      const nested = join(full, "node_modules");
      if (fs.existsSync(nested)) {
        visit(nested, depth + 1);
      }
    }
  };
  visit(join(root, "node_modules"), 0);
  return found;
}

/**
 * Delete those packages, and report what happened.
 *
 * Never throws: a platform package that cannot be removed is dead weight, not a build failure -
 * the caller decides what to say about `failed`.
 */
export function prunePlatformPackages({ root, target, fs = DEFAULT_FS, dryRun = false, maxDepth = 8 }) {
  const candidates = findPrunablePlatformPackages({ root, target, fs, maxDepth });
  const removed = [];
  const failed = [];
  for (const candidate of candidates) {
    const bytes = directoryBytes(candidate.dir, fs);
    if (dryRun) {
      removed.push({ ...candidate, bytes });
      continue;
    }
    try {
      fs.rmSync(candidate.dir, { recursive: true, force: true });
      removed.push({ ...candidate, bytes });
    } catch (error) {
      failed.push({ ...candidate, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    target,
    removed,
    failed,
    bytes: removed.reduce((total, entry) => total + entry.bytes, 0),
  };
}

/** `267M`, `10M`, `512K` - for one build log line. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
  }
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))}M`;
  }
  return `${Math.round(bytes / 1024)}K`;
}