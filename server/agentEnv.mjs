// Where the bundled runtimes live inside the agent directory, and how PATH has to
// be assembled so they are actually found.
//
// This is the single source of truth for both shells: `src-electron/sidecar.js`
// and `src-tauri/src/lib.rs::bundled_runtime_path` prepend the shim directory and
// the bundled Node bin, but neither can know where npm and pip *write* their
// executables. The sidecar is the one parent every shell, pi and skill shares, so
// the merge happens here — that is what makes the behaviour identical for the
// packaged Electron app, the packaged Tauri app and `npm run dev`.
//
// Why it matters: the POSIX/Windows launchers force npm's global prefix and pip's
// user base into the agent directory. If the matching bin directory is not on
// PATH, `npm i -g <tool>` / `pip install --user <tool>` succeeds and the app still
// cannot call the tool — which is indistinguishable from "not installed".

import { delimiter, join } from "node:path";

/**
 * Directories where the bundled package managers install executables.
 * Windows: npm's global bin *is* the prefix root; pip's user scripts live in
 * `<PYTHONUSERBASE>\Scripts`. POSIX: both use a `bin` child.
 */
export function packageManagerBinDirs(agentDir, platform = process.platform) {
  if (platform === "win32") {
    return [join(agentDir, "node"), join(agentDir, "python", "Scripts")];
  }
  return [join(agentDir, "node", "bin"), join(agentDir, "python", "bin")];
}

/**
 * PATH entries that must come *before* whatever the host happens to provide.
 * Order is the contract: the agent shim dir first so `node`/`python3` mean the
 * bundled runtimes (that isolation is deliberate), then the bundled Node bin, then
 * the two package-manager output directories.
 */
export function agentRuntimePathDirs({ agentDir, bundledNodeBin, platform = process.platform }) {
  const dirs = [join(agentDir, "bin")];
  const nodeBinDir = parentDir(bundledNodeBin ?? "");
  if (nodeBinDir) {
    dirs.push(nodeBinDir);
  }
  return [...dirs, ...packageManagerBinDirs(agentDir, platform)];
}

/** Parent directory of a path, accepting either separator (target may be Windows). */
function parentDir(value) {
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return index > 0 ? value.slice(0, index) : "";
}

/** Prepends `dirs` to `existing`, dropping duplicates without reordering. */
export function mergePath(dirs, existing, platform = process.platform) {
  const sep = platform === "win32" ? ";" : delimiter;
  const caseInsensitive = platform === "win32";
  const seen = new Set();
  const out = [];
  for (const raw of [...dirs, ...String(existing ?? "").split(sep)]) {
    const entry = trimTrailingSeparator(raw);
    if (!entry) {
      continue;
    }
    const key = caseInsensitive ? entry.toLowerCase() : entry;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out.join(sep);
}

/** Drops a redundant trailing separator, but never a bare root (`/`, `C:\`). */
function trimTrailingSeparator(value) {
  const entry = String(value ?? "").trim();
  if (entry.length > 1 && /[\\/]$/.test(entry) && !/^([a-zA-Z]:[\\/]|[\\/])$/.test(entry)) {
    return entry.replace(/[\\/]+$/, "");
  }
  return entry;
}
