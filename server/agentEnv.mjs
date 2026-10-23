// Which interpreter the agent's `node` / `python3` / `pip` mean, and how PATH has to be
// assembled so those actually resolve.
//
// The rule: **a runtime the user already has wins; the bundled payload only fills a gap.**
// Shadowing an nvm node or a pyenv/Homebrew python with our copy is how the agent ends up on a
// different toolchain than the person staring at the same terminal, with none of the packages
// they installed. Only a machine that has neither gets the runtime shipped inside the app
// bundle - and that is also the only case where npm/pip output is redirected into the agent
// directory (`~/.pi/agent/{node,python}`) and the launchers in `~/.pi/agent/bin` are written.
//
// This module owns both halves of that decision, so they cannot disagree:
//   - what counts as "the user's runtime"  ->  isToolchainDir + runtimeCandidates + selectAgentRuntimes
//   - what goes on PATH                    ->  agentRuntimePathEntries
// Both read the *same* PATH (the one the shells assembled, login shell included). Judging on the
// GUI baseline PATH instead (macOS: `/usr/bin:/bin:/usr/sbin:/sbin`) would call a machine with
// nvm/pyenv "runtime-less" and then shadow the user's node with the bundled one.
//
// The shells cannot do this part: they run before the login-shell readback result is known to be
// enough, and the launchers/output directories are whoever runs the bridge's business. Electron,
// Tauri and `npm run dev` all reach the same code here.

import { existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Directories where an interpreter belongs to the OS or a developer toolchain rather than to the
 * user. Two concrete reasons this matters:
 *
 *  - macOS `/usr/bin/python3` only exists when Xcode/Command Line Tools are installed. It is
 *    Python 3.9.6 with pip 21.x, refuses modern packages, and — if it is missing — spawning
 *    `python3` pops the "install developer tools" dialog. It must never be treated as "the user
 *    has Python".
 *  - Windows' `WindowsApps` aliases are 0-byte stubs (identically shaped whether the Store
 *    package is installed or not); spawning one opens the Microsoft Store.
 *
 * Linux is deliberately absent: `/usr/bin/python3` there is the distribution's real environment,
 * usually with apt-installed modules in its `site-packages`, and shadowing it would break code
 * the user already has.
 */
const TOOLCHAIN_ONLY_PREFIXES = {
  darwin: [
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/System",
    "/Library/Developer/CommandLineTools",
    "/Library/Apple/usr/bin",
    "/Applications/Xcode.app",
  ],
  win32: [],
  linux: [],
};

/** Is this PATH entry one of the OS/toolchain directories above? */
export function isToolchainDir(dir, platform = process.platform) {
  const entry = normalizePath(dir, platform);
  if (!entry) {
    return false;
  }
  if (platform === "win32") {
    // No prefix list: the stub lives in a per-user package directory whose location varies.
    return /(^|[\\/])windowsapps([\\/]|$)/i.test(entry);
  }
  const prefixes = TOOLCHAIN_ONLY_PREFIXES[platform] ?? [];
  return prefixes.some((prefix) => entry === prefix || entry.startsWith(`${prefix}/`));
}

function normalizePath(value, platform = process.platform) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const withoutTrailing = trimmed.length > 1 ? trimmed.replace(/[/\\]+$/, "") : trimmed;
  return platform === "win32" ? withoutTrailing.toLowerCase() : withoutTrailing;
}

/**
 * Executable names to look for, in priority order, per runtime kind. Windows only ever matches
 * real executables (`node.exe`, `python.exe` / `python3.exe`): the extensionless names there are
 * launcher scripts for `cmd`, which `CreateProcess` cannot run.
 */
export function runtimeExecutableNames(kind, platform = process.platform) {
  if (kind === "node") {
    return platform === "win32" ? ["node.exe"] : ["node"];
  }
  return platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
}

/**
 * Every candidate for `kind` on a PATH value, in PATH order, toolchain-only directories removed.
 * Existence is not checked here - `probe` is what decides, because a file that exists may still
 * be a stub.
 */
export function runtimeCandidates(kind, pathValue, platform = process.platform) {
  const sep = platform === "win32" ? ";" : delimiter;
  const names = runtimeExecutableNames(kind, platform);
  const candidates = [];
  const seen = new Set();
  for (const raw of String(pathValue ?? "").split(sep)) {
    const dir = String(raw ?? "").trim();
    if (!dir || isToolchainDir(dir, platform)) {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const key = platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({ name, dir, path });
    }
  }
  return candidates;
}

const probeCache = new Map();

/**
 * Does this interpreter actually run? Returns `{ ok, version }`.
 *
 * Existence is not usability: the macOS CLT stub and the WindowsApps aliases are files that must
 * not be executed, and an nvm shim can exist while its target is gone. Results are cached per
 * absolute path for the life of the process; the *decision* is never cached, because a later
 * window may see a different PATH.
 */
export function probeRuntime(candidate, kind) {
  const key = `${kind}\u0000${cacheKeyFor(candidate.path)}`;
  if (probeCache.has(key)) {
    return probeCache.get(key);
  }
  let result = { ok: false, version: "" };
  try {
    const args = kind === "node" ? ["-v"] : ["-V"];
    const spawned = spawnSync(candidate.path, args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${spawned.stdout ?? ""}${spawned.stderr ?? ""}`.trim();
    const pattern = kind === "node" ? /^v\d+\./ : /^Python 3\./;
    if (spawned.status === 0 && pattern.test(output)) {
      result = { ok: true, version: output.split("\n")[0] };
    }
  } catch {
    // A probe that throws is a probe that said no.
  }
  probeCache.set(key, result);
  return result;
}

function cacheKeyFor(path) {
  try {
    return realpathSync(path);
  } catch {
    return String(path);
  }
}

/**
 * The whole decision, in one place.
 *
 * `pathValue` is the effective PATH as inherited by the bridge. `ownDirs` are the entries this
 * app (or a previous launch) put in front of it - they are stripped before judging, otherwise
 * our own bundled node would be found as "the user's node" on every start.
 *
 * @param {{
 *   pathValue?: string,
 *   ownDirs?: string[],
 *   bundled?: { node?: { bin?: string, npmCli?: string } | null, python?: { bin?: string, home?: string } | null },
 *   forceSystem?: boolean,
 *   platform?: NodeJS.Platform,
 *   probe?: (candidate: { path: string }, kind: string) => { ok?: boolean, version?: string } | null | undefined,
 * }} [options]
 */
export function selectAgentRuntimes({
  pathValue,
  ownDirs = [],
  bundled = {},
  forceSystem = false,
  platform = process.platform,
  probe = probeRuntime,
} = {}) {
  const judgingPath = stripPathEntries(pathValue, ownDirs, platform);
  const pick = (kind, bundledEntry) => {
    for (const candidate of runtimeCandidates(kind, judgingPath, platform)) {
      const probed = probe(candidate, kind);
      if (probed?.ok) {
        return { source: "system", path: candidate.path, version: probed.version ?? "" };
      }
    }
    // `forceSystem` (slim packaging) never falls back to a payload that is not shipped, even if
    // `PI_DESKTOP_BUNDLED_*` leaked in from somewhere.
    if (!forceSystem && bundledEntry) {
      return { source: "bundled", path: bundledEntry.bin ?? "" };
    }
    return { source: "missing", path: "" };
  };

  return {
    judgingPath,
    node: { ...pick("node", bundled.node), npmCli: bundled.node?.npmCli ?? "" },
    python: { ...pick("python", bundled.python), home: bundled.python?.home ?? "" },
  };
}

/** A PATH value with `entries` removed (exact match, normalized for the platform). */
export function stripPathEntries(pathValue, entries, platform = process.platform) {
  const sep = platform === "win32" ? ";" : delimiter;
  const drop = new Set((entries ?? []).filter(Boolean).map((entry) => normalizePath(entry, platform)));
  return String(pathValue ?? "")
    .split(sep)
    .filter((entry) => {
      const key = normalizePath(entry, platform);
      return key && !drop.has(key);
    })
    .join(sep);
}

/** Directories where the bundled package managers install executables. */
export function packageManagerBinDirs(agentDir, platform = process.platform) {
  if (platform === "win32") {
    return [join(agentDir, "node"), join(agentDir, "python", "Scripts")];
  }
  return [join(agentDir, "node", "bin"), join(agentDir, "python", "bin")];
}

/**
 * PATH entries the agent needs, given the decision above.
 *
 * - `agentDir/bin` is always first: the `pi` launcher lives there (and so do the runtime
 *   launchers, but only when the bundled runtime won).
 * - the bundled Node bin dir is prepended only when the bundled Node won.
 * - npm's global output dir is prepended when the bundled Node won (`npm i -g <tool>` must be
 *   callable immediately) and *appended* when it did not, but only if it already exists - a CLI
 *   installed by an earlier version must not silently vanish when the user later installs node.
 * - pip's user-scripts dir is added only when the bundled Python won. Appending it otherwise
 *   splits the environment: `pip` would resolve to the bundled interpreter's packages while
 *   `python` resolves to the user's (see the Ada design note on the same trade-off).
 */
export function agentRuntimePathEntries({
  agentDir,
  selection,
  platform = process.platform,
  dirExists = (dir) => existsSync(dir),
}) {
  const [nodeOutputDir, pythonOutputDir] = packageManagerBinDirs(agentDir, platform);
  const prepend = [join(agentDir, "bin")];
  const append = [];

  if (selection?.node?.source === "bundled") {
    const nodeBinDir = parentDir(selection.node.path);
    if (nodeBinDir) {
      prepend.push(nodeBinDir);
    }
    prepend.push(nodeOutputDir);
  } else if (selection?.node?.source === "system" && dirExists(nodeOutputDir)) {
    append.push(nodeOutputDir);
  }

  if (selection?.python?.source === "bundled") {
    prepend.push(pythonOutputDir);
  }

  return { prepend, append };
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