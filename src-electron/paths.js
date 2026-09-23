"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Resource layout, kept identical to what src-tauri ships (see the
// `bundle.resources` map in src-tauri/tauri.conf.json):
//
//   packaged  <resources>/pi-desktop-server      (POSIX launcher; win32: node-runtime + bridge entry)
//             <resources>/bridge/{server,src,node_modules}
//             <resources>/python-runtime/...
//             <resources>/bridge/server/bridgeListen.mjs   (shared port-discovery rules)
//             <resources>/node-runtime/...
//             <resources>/skills
//             <resources>/capabilities.defaults.json
//             <resources>/renderer        (vite dist)
//
//   dev       <repo>/src-tauri/binaries/*  (produced by npm run sidecar:build /
//             python:build / node:build)
//             <repo>/skills, <repo>/capabilities.defaults.json, <repo>/dist

const REPO_ROOT = path.resolve(__dirname, "..");

function resolveShellPaths(app) {
  const platform = process.platform;
  const sidecarName = platform === "win32" ? "pi-desktop-server.exe" : "pi-desktop-server";

  // The bridge ships unpacked (sources + node_modules) and runs on the bundled node: a compiled
  // single file would inline pi's modules and extension loading is not deterministic then.
  const bridgeEntry = (root) => path.join(root, "bridge", "server", "index.mjs");
  // The port rules live in the bridge itself; the shell imports that same file so dev and the
  // packaged app cannot drift into two policies again.
  const bridgeListen = (root) => path.join(root, "bridge", "server", "bridgeListen.mjs");
  const bundledNode = (runtimeDir) =>
    path.join(runtimeDir, platform === "win32" ? "node.exe" : "bin/node");

  // A POSIX launcher sits beside the runtimes and finds them itself; Windows has no shell script
  // to exec, so the host spawns node with the entry and hands the same pair to the pi launcher.
  // In `system` mode there is no bundled node to name, so the host resolves the machine's own.
  const launchFor = (root, runtimeDir, { runtimeMode, systemNode }) =>
    platform === "win32"
      ? {
          sidecar: runtimeMode === "system" ? systemNode : bundledNode(runtimeDir),
          sidecarArgs: [bridgeEntry(root)],
          piCli: {
            runtime: runtimeMode === "system" ? systemNode : bundledNode(runtimeDir),
            entry: bridgeEntry(root),
          },
        }
      : {
          sidecar: path.join(root, sidecarName),
          sidecarArgs: [],
          piCli: { binary: path.join(root, sidecarName) },
        };

  // Everything the shell needs to answer "which runtimes do I have" lives here, once, so the
  // packaged Electron app, the packaged Tauri app and `npm run dev` cannot drift apart.
  const runtimes = (root, runtimeRoot) => {
    const dirs = {
      pythonRuntime: path.join(runtimeRoot, "python-runtime"),
      nodeRuntime: path.join(runtimeRoot, "node-runtime"),
    };
    const runtimeMode = resolveRuntimeMode(dirs);
    const hostPath = systemHostPath({ runtimeMode });
    const systemNode = runtimeMode === "system" ? resolveNodeOnPath(hostPath, platform) : null;
    return {
      ...dirs,
      runtimeMode,
      hostPath,
      systemNode,
      ...launchFor(root, dirs.nodeRuntime, { runtimeMode, systemNode }),
    };
  };

  if (app.isPackaged) {
    const resources = process.resourcesPath;
    return {
      mode: "packaged",
      root: resources,
      bridgeListen: bridgeListen(resources),
      ...runtimes(resources, resources),
      skills: path.join(resources, "skills"),
      capabilitiesDefaults: path.join(resources, "capabilities.defaults.json"),
      renderer: path.join(resources, "renderer"),
    };
  }

  const binaries = path.join(REPO_ROOT, "src-tauri", "binaries");
  return {
    mode: "dev",
    root: REPO_ROOT,
    bridgeListen: path.join(REPO_ROOT, "server", "bridgeListen.mjs"),
    ...runtimes(REPO_ROOT, binaries),
    skills: path.join(REPO_ROOT, "skills"),
    capabilitiesDefaults: path.join(REPO_ROOT, "capabilities.defaults.json"),
    renderer: path.join(REPO_ROOT, "dist"),
  };
}

/**
 * Which runtime source the shell must use.
 *
 * `PI_DESKTOP_RUNTIME_MODE` wins when set (`bundled` / `system`); otherwise the presence of the
 * shipped runtimes decides. Inferring instead of baking the mode into the artifact means a build
 * cannot disagree with itself: the packaging config and the running app read the same fact, and a
 * bundle whose `*-runtime` directories were pruned simply uses the machine's own interpreters.
 */
function resolveRuntimeMode(dirs, env = process.env) {
  const explicit = String(env.PI_DESKTOP_RUNTIME_MODE ?? "").trim().toLowerCase();
  if (explicit === "system") {
    return "system";
  }
  if (explicit === "bundled") {
    return "bundled";
  }
  const hasBoth = pathIsFile(bundledNodePaths(dirs).bin) && bundledPythonPaths(dirs) !== null;
  return hasBoth ? "bundled" : "system";
}

/**
 * PATH handed to the bridge (and through it to every skill).
 *
 * A GUI app on macOS does not inherit a login shell's PATH (`launchctl getenv PATH` is empty), so
 * anything the user installed outside the bundle - `/opt/homebrew/bin`, `~/.local/bin`, or a node
 * from nvm / pyenv - is invisible to it. Reading the login shell's PATH back is the only way those
 * installs can be found; how much of the shell to ask for depends on the mode:
 *
 * - `system` mode needs the machine's own node. For nvm / pyenv / asdf users that only exists in
 *   the *interactive* rc files, but those are also the expensive ones (`nvm use` in `.zshrc` alone
 *   can dominate startup), so this is skipped as soon as the current PATH resolves a node.
 * - `bundled` mode ships node and python, so the interactive files would add nothing the app needs
 *   while still costing their full price. A *non-interactive* login shell is enough for the
 *   profile-level installs (`~/.local/bin`, Homebrew, cargo) the user's own CLIs come from.
 *
 * `PI_DESKTOP_HOST_PATH` overrides the result in both modes.
 */
function systemHostPath({ runtimeMode, env = process.env, platform = process.platform } = {}) {
  const current = String(env.PATH ?? "");
  const explicit = String(env.PI_DESKTOP_HOST_PATH ?? "").trim();
  if (explicit) {
    return explicit;
  }
  const interactive = runtimeMode === "system";
  if (interactive && resolveNodeOnPath(current, platform)) {
    return current;
  }
  const fromLoginShell = loginShellPath(env, platform, { interactive });
  return fromLoginShell ? joinPathValues([fromLoginShell, current], platform) : current;
}

/** The PATH a login shell reports, or null when that cannot be read. */
function loginShellPath(env = process.env, platform = process.platform, { interactive = true } = {}) {
  if (platform === "win32") {
    return null;
  }
  const shell = String(env.SHELL ?? "").trim() || "/bin/zsh";
  if (!pathIsFile(shell)) {
    return null;
  }
  const marker = "__PI_DESKTOP_LOGIN_PATH__";
  try {
    // `-i` is the caller's choice, not a default: nvm / pyenv / asdf only export their PATH from
    // the interactive rc files, but those files are also what makes this read cost real time.
    // rc files may print banners, so the value is fished out by marker instead of trusting stdout.
    const result = spawnSync(shell, [interactive ? "-lic" : "-lc", `printf '%s%s' '${marker}' "$PATH"`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const index = String(result.stdout ?? "").lastIndexOf(marker);
    if (index < 0) {
      return null;
    }
    const value = String(result.stdout).slice(index + marker.length).split("\n")[0].trim();
    return value || null;
  } catch {
    return null;
  }
}

/** First `node` on a PATH value, or null. Existence only - the version is the bridge's problem. */
function resolveNodeOnPath(pathValue, platform) {
  const separator = platform === "win32" ? ";" : ":";
  const executable = platform === "win32" ? "node.exe" : "node";
  for (const dir of String(pathValue ?? "").split(separator)) {
    const entry = dir.trim();
    if (!entry) {
      continue;
    }
    const candidate = path.join(entry, executable);
    if (pathIsFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Prepends `values` to each other, dropping duplicates without reordering. */
function joinPathValues(values, platform) {
  const separator = platform === "win32" ? ";" : ":";
  const caseInsensitive = platform === "win32";
  const seen = new Set();
  const out = [];
  for (const value of values) {
    for (const raw of String(value ?? "").split(separator)) {
      const entry = raw.trim();
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
  }
  return out.join(separator);
}

function pathIsFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

// Mirrors `bundled_python_paths` in lib.rs: the macOS python-build layout keeps
// the interpreter under Versions/<x.y>, while Linux/Windows use bin/ directly.
function bundledPythonPaths(paths) {
  const candidates =
    process.platform === "darwin"
      ? [
          ["Versions/3.13/bin/python3.13", "Versions/3.13"],
          ["bin/python3.13", "."],
        ]
      : [[process.platform === "win32" ? "python.exe" : "bin/python3.13", "."]];

  for (const [binRelative, homeRelative] of candidates) {
    const bin = path.join(paths.pythonRuntime, binRelative);
    if (fs.existsSync(bin) && fs.statSync(bin).isFile()) {
      return {
        bin,
        home: path.normalize(path.join(paths.pythonRuntime, homeRelative)),
      };
    }
  }

  return null;
}

// Mirrors the BUNDLED_NODE_BIN / BUNDLED_NPM_CLI constants in lib.rs.
function bundledNodePaths(paths) {
  const windows = process.platform === "win32";
  return {
    bin: path.join(paths.nodeRuntime, windows ? "node.exe" : "bin/node"),
    npmCli: path.join(
      paths.nodeRuntime,
      windows
        ? "node_modules/npm/bin/npm-cli.js"
        : "lib/node_modules/npm/bin/npm-cli.js",
    ),
  };
}

// Dev-only nicety. In a packaged app electron-builder already turned
// `mac.icon` into `<resources>/icon.icns` + `CFBundleIconFile`, and the repo
// png is not inside the asar (`files` ships only *.js and package.json) — asking
// Electron to load it there throws, which must never be part of startup.
function dockIconPath(app) {
  // Unknown mode or packaged → skip. A decorative icon is never worth a
  // startup risk, and inside the bundle the repo path does not exist.
  if (!app || app.isPackaged) {
    return null;
  }

  const icon = path.join(REPO_ROOT, "src-tauri", "icons", "icon.png");
  return fs.existsSync(icon) ? icon : null;
}

function userPiAgentDir() {
  const home = process.env.HOME || process.env.USERPROFILE || REPO_ROOT;
  return path.join(home, ".pi", "agent");
}

module.exports = {
  REPO_ROOT,
  dockIconPath,
  bundledNodePaths,
  bundledPythonPaths,
  resolveRuntimeMode,
  resolveNodeOnPath,
  systemHostPath,
  loginShellPath,
  joinPathValues,
  resolveShellPaths,
  userPiAgentDir,
};
