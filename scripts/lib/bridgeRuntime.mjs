/**
 * Pure helpers for shipping the bridge as plain sources plus a real `node_modules`, executed by
 * the bundled Node instead of a compiled-in binary.
 *
 * Why this exists: compiling the bridge into a single executable inlines pi's own modules and lets
 * the bundler rename their exports, while pi loads runtime extensions through jiti against those
 * inlined copies. The rename numbering shifts between builds, so a whole artefact can load every
 * extension and the next one cannot (`Type3 is not defined`) - which is why the compiled sidecar
 * was retired. Running the bridge under Node against on-disk packages makes extension loading
 * deterministic, exactly like the terminal CLI.
 */

import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

const BARE_IMPORT = /(?:^|\n)\s*(?:import|export)[^"']*?from\s*"([a-z@][^"]*)"|require\("([a-z@][^"]*)"\)/g;

/**
 * 怎么起那句 `npm install`。
 *
 * 首选 npm 自己给的 `npm_execpath`（`npm run …` 会设它）。没有它时**不能**直接退化成裸 `npm`：
 * Windows 上 `npm` 是个 `.cmd`，而这里用的是 `spawnSync(…, {shell:false})` —— CreateProcess 只会
 * 补 `.exe`，spawn 直接失败，报出来是一句「npm install failed for the bridge runtime:」后面什么都
 * 没有（2026-10-22 CI 的 Windows slim 包就是这么红的）。
 *
 * 所以退一步去找**真的存在**的 npm-cli.js：调用方给的候选（比如内置运行时里那份），然后是官方
 * Node 发行版里「npm 就在 node 旁边」的位置（POSIX 是 `<node>/../lib/node_modules/npm`，Windows 是
 * `<node>/node_modules/npm`；setup-node / nvm / brew / 官方安装包都是这个形状）。
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   execPath?: string,
 *   candidates?: string[],
 *   exists?: (path: string) => boolean,
 * }} [options]
 * @returns {{ command: string, baseArgs: string[], source: string }}
 */
export function resolveNpmInvocation({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  candidates = [],
  exists = existsSync,
} = {}) {
  const declared = String(env.npm_execpath ?? "").trim();
  if (declared) {
    // npm 给的是 cli.js 的路径（要用 node 跑）；但 dev 下也可能是那个 shell 包装，那就直接执行它。
    return declared.endsWith(".js")
      ? { command: execPath, baseArgs: [declared], source: "npm_execpath" }
      : { command: declared, baseArgs: [], source: "npm_execpath" };
  }
  for (const cli of [...candidates, ...siblingNpmCliCandidates(execPath, platform)]) {
    if (exists(cli)) {
      return { command: execPath, baseArgs: [cli], source: "npm-cli" };
    }
  }
  // 最后手段：PATH 里的 `npm`。POSIX 上它是带 shebang 的脚本，能直接 exec；Windows 上仍然不行，
  // 所以调用方必须把命令与 spawn 的 error 写进报错里，不能只打 stdout/stderr。
  return { command: "npm", baseArgs: [], source: "path" };
}

/**
 * 官方 Node 发行版里 npm 相对于 node 的位置（Windows 与 POSIX 的目录形状不一样）。
 *
 * 用 `win32` / `posix` 两个 flavor 而不是宿主的 `join`：这样给出的永远是**那个平台**的形状，
 * 在 mac 上也测得动 win32 那条分支（就为这个踩过一次：拿宿主 flavor 拼 win32 路径会当成文件名）。
 */
export function siblingNpmCliCandidates(execPath = process.execPath, platform = process.platform) {
  return platform === "win32"
    ? [win32.resolve(win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js")]
    : [posix.resolve(posix.dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
}

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
      if (specifier.startsWith("node:")) {
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
 *
 * `__appVersion` is the app's own version, carried in the same map by the caller (it is not a
 * dependency, which is why it is spelled with the `__` prefix).
 *
 * @param {{
 *   versions?: Record<string, string>,
 *   imports?: string[],
 *   overrides?: Record<string, string>,
 *   name?: string,
 * }} [options]
 */
export function bridgePackageManifest({ versions = {}, imports = [], overrides = {}, name = "pi-desktop-bridge" } = {}) {
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
  // Exact transitive pins for the packages the repo's own tree resolved. Without them npm is free
  // to pick a newer minor for a dependency of a dependency (`^1.1.0` -> 1.2.0), and the bridge then
  // ships a combination no test ever ran - pi-codemode 1.2.0 dropped an export pi-coding-agent
  // 1.1.0 imports, which broke startup while the repo tree was fine.
  const pins = Object.fromEntries(Object.entries(overrides).filter(([pkg]) => dependencies[pkg] === undefined));

  return {
    manifest: {
      name,
      version: versions.__appVersion ?? "0.0.0",
      private: true,
      type: "module",
      description: "Pi Desktop local bridge. Not an app; installed by npm ci at build time.",
      engines: { node: ">=22" },
      dependencies,
      ...(Object.keys(pins).length ? { overrides: pins } : {}),
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

/** `file` 是不是在 `dir` 里面（分隔符与 flavor 都按给定平台算）。 */
export function isInsideTree(dir, file, platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * 解析自解析探针（`build-bridge-runtime.mjs` 的 `verifyBridgeSelfResolve`）的一行输出：
 * `<spec>\t<state>\t<target>`。返回需要报出来的描述，东西好好落在树里就返回 null。
 *
 * 判"落在树里"**不能**拿 URL 的 `pathname` 与宿主路径比字符串：Windows 上 `file:///D:/a/…` 的
 * pathname 是 `/D:/a/…`（多一个前导斜杠、而且是正斜杠），树根却是 `D:\a\…` —— 前缀永远不匹配，
 * 于是 27 个依赖全被判成"跑出树外/缺失"，Windows 上 bridge:build 直接失败（2026-10-22 CI，mac 上是好的）。
 * 修法是两头都补：探针侧用 `fileURLToPath` 拿真路径，判定侧用 `relative` 而不是字符串前缀。
 */
export function resolveProbeVerdict({ spec, state, target, dir, platform = process.platform }) {
  if (state !== "ok") {
    return `${spec} -> ${state} ${target}`;
  }
  if (!isInsideTree(dir, target, platform)) {
    return `${spec} -> outside ${target}`;
  }
  return null;
}

/** 探针的整体输出 → 要报出来的条目。逐行 trim：Windows 的输出可能带 CR。 */
export function escapedSpecsFromProbe(output, dir, platform = process.platform) {
  const escaped = [];
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const [spec, state, target = ""] = line.split("\t");
    if (!spec || !state) {
      continue;
    }
    const verdict = resolveProbeVerdict({ spec, state, target, dir, platform });
    if (verdict) {
      escaped.push(verdict);
    }
  }
  return escaped;
}
