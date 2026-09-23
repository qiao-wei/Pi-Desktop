/**
 * Pure helpers for shipping the bridge as plain sources plus a real `node_modules`, executed by
 * the bundled Node instead of a compiled-in binary.
 *
 * Why this exists: `bun build --compile` inlines pi's own modules and lets the bundler rename
 * their exports, while pi loads runtime extensions through jiti against those inlined copies.
 * The rename numbering shifts between builds, so a whole artefact can load every extension and
 * the next one cannot (`Type3 is not defined`). Running the bridge under Node against on-disk
 * packages makes extension loading deterministic, exactly like the terminal CLI.
 */

const BARE_IMPORT = /(?:^|\n)\s*(?:import|export)[^"']*?from\s*"([a-z@][^"]*)"|require\("([a-z@][^"]*)"\)/g;

/** Every bare (non-relative, non-builtin) specifier the given sources import. */
export function collectBareImports(sources) {
  const found = new Set();
  for (const source of sources) {
    if (typeof source !== "string") {
      continue;
    }
    BARE_IMPORT.lastIndex = 0;
    let match;
    while ((match = BARE_IMPORT.exec(source))) {
      const specifier = match[1] || match[2];
      if (!specifier) {
        continue;
      }
      if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
        continue;
      }
      found.add(specifier);
    }
  }
  return [...found].sort();
}

/**
 * Package name of a bare specifier: `@scope/pkg/dist` -> `@scope/pkg`, `typebox` -> `typebox`.
 * Subpaths are how the bundler resolves them, but they must not become dependency keys.
 */
export function packageNameOf(specifier) {
  if (typeof specifier !== "string" || !specifier) {
    return "";
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/**
 * The bridge manifest. `versions` maps package name -> exact installed version, and every bare
 * import must be covered by it, otherwise the shipped tree would resolve a package the build
 * machine happened to hoist rather than one we declared.
 */
export function bridgePackageManifest({ versions = {}, imports = [], name = "pi-desktop-bridge" } = {}) {
  const missing = new Set();
  const dependencies = {};
  for (const specifier of imports) {
    const pkg = packageNameOf(specifier);
    if (!pkg) {
      continue;
    }
    if (versions[pkg]) {
      dependencies[pkg] = versions[pkg];
    } else {
      missing.add(pkg);
    }
  }
  return {
    manifest: {
      name,
      version: versions.__appVersion ?? "0.0.0",
      private: true,
      type: "module",
      description: "Pi Desktop local bridge. Not an app; installed by npm ci at build time.",
      engines: { node: ">=22" },
      dependencies,
    },
    missing: [...missing].sort(),
  };
}

/**
 * POSIX launcher that replaces the compiled sidecar: run the bundled node against the unpacked
 * entry, resolving both relative to the launcher itself so a moved bundle still works.
 *
 * A bundle without `node-runtime` (the slim variant, for machines that already have Node) falls
 * back to the first `node` on PATH. That fallback is deliberate and unconditional: the slim build
 * then needs no per-variant launcher, and a bundled build whose runtime was damaged degrades to
 * the host's Node instead of refusing to start.
 */
export function renderPosixBridgeLauncher({ entry, nodeBinRel, bridgeDirRel, cacheDir = "" }) {
  const lines = [
    "#!/bin/sh",
    "set -eu",
    // Where the launcher sits decides where everything else is: <resources>/pi-desktop-server next to
    // <resources>/node-runtime/bin/node and <resources>/bridge/{server,node_modules}. A host that
    // keeps them apart (a Tauri sidecar lives in MacOS/, resources in Resources/) passes overrides.
    'here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"',
    `BRIDGE_DIR="\${PI_DESKTOP_BRIDGE_DIR:-$here/${bridgeDirRel}}"`,
    `NODE_BIN="\${PI_DESKTOP_BRIDGE_NODE:-$here/${nodeBinRel}}"`,
    `if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi`,
    `if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ] || [ ! -f "$BRIDGE_DIR/${entry}" ]; then
  echo "Pi Desktop bridge: no usable node (bundled node-runtime is absent and none is on PATH) or the bridge sources are missing (NODE_BIN=\${NODE_BIN:-<none>} ENTRY=$BRIDGE_DIR/${entry}). Install Node.js 22 or newer, or reinstall the app." >&2
  exit 127
fi`,
    // V8 keeps a compile cache next to sources by default; point it at a writable directory so
    // running the bridge never writes into the (possibly read-only) bundle.
    ...(cacheDir ? [`export NODE_COMPILE_CACHE=${cacheDir}`] : []),
    `exec "$NODE_BIN" "$BRIDGE_DIR/${entry}" "$@"`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The sidecar name Tauri expects for the current host, or "" where no launcher is used
 * (win32 spawns node with the entry, there is no shell script to name).
 */
export function defaultTargetTriple(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") {
    return arch === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  return "";
}

/**
 * The bridge manifest records the versions **installed in the repo's `node_modules`**, not the ones
 * `package.json` asks for. Those disagree whenever a commit bumps a dependency and nobody has run
 * `npm install` since (pi 0.87.0 arrived that way): the bridge would then quietly ship the old
 * package, and any measurement taken from it describes the old tree. These helpers let the build
 * compare the two and say so.
 *
 * `versionFloor` reads the lowest version a range allows - `^0.87.0` and `~1.2.3` and `>=2.0.0` all
 * floor at their first version, `1.x` at `1.0.0` - and returns "" for ranges that do not open with a
 * version (`*`, `latest`, `workspace:*`, git and npm-alias specs), which callers read as "nothing to
 * compare".
 */
export function versionFloor(range) {
  // Anchored: a version mentioned in the middle of a spec (`npm:pi@^1`) does not describe this
  // package's own version, and guessing from it would produce a bogus floor.
  const match = String(range ?? "").trim().match(/^[\s~^<>=v]*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    return "";
  }
  const [, major, minor = "0", patch = "0"] = match;
  return `${major}.${minor}.${patch}`;
}

/** Numeric compare of dotted versions; a prerelease sorts below its release (`1.0.0-rc` < `1.0.0`). */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core, ...pre] = String(value ?? "").split("-");
    const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
    return { parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre: pre.join("-") };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) {
      return left.parts[index] < right.parts[index] ? -1 : 1;
    }
  }
  if (left.pre === right.pre) {
    return 0;
  }
  if (!left.pre) {
    return 1;
  }
  if (!right.pre) {
    return -1;
  }
  return left.pre < right.pre ? -1 : 1;
}

/** Installed versions below what `declared` requires - the ones a build must not ship silently. */
export function staleInstalledPackages({ declared = {}, installed = {} } = {}) {
  const stale = [];
  for (const [name, range] of Object.entries(declared)) {
    const floor = versionFloor(range);
    const have = installed[name];
    if (!floor || !have) {
      continue;
    }
    if (compareVersions(have, floor) < 0) {
      stale.push({ name, installed: have, declared: range, floor });
    }
  }
  return stale;
}
