/**
 * Assemble the bundled Python runtime: a pinned python-build-standalone CPython, downloaded and
 * unpacked, so `python3`, `pip` and `python3 -m venv` work on a machine that has none.
 *
 *   npm run python:build
 *
 * Produces `src-tauri/binaries/python-runtime/` (gitignored): the interpreter, its standard
 * library and the pip it ships with, plus `SOURCES.json` (archive URL + sha256) and
 * `pi-desktop-runtime.json`.
 *
 * Two deliberate consequences of shipping the upstream archive as-is:
 *
 *  - `pip` comes from the payload instead of `ensurepip`, so the build never executes the
 *    interpreter it is assembling. That is what lets a win32 payload be prepared on macOS, and
 *    it is why nothing here bakes a build-machine path into `bin/pip`.
 *  - bytecode caches are stripped, so the shipped tree is not written at runtime either: the
 *    app's own launchers point `PYTHONPYCACHEPREFIX` at `~/.pi/agent/python/cache`, and a
 *    signed `.app` whose `Resources` change after signing stops verifying.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  PYTHON_RELEASE_TAG,
  PYTHON_VERSION,
  downloadArchive,
  ensureExecutable,
  extractArchive,
  isNativeTarget,
  pythonArchiveSpec,
  runtimeSpec,
  verifyPinnedHash,
  writeProvenance,
} from "./lib/runtimePayloads.mjs";
import {
  platformForTarget,
  pruneHostReferenceMetadata,
  relocateRuntime,
  stripBytecodeCache,
  verifyRuntimeRelocatable,
} from "./lib/pythonRuntime.mjs";

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const binariesDir = join(rootDir, "src-tauri", "binaries");
const outputDir = join(binariesDir, "python-runtime");
// 同 build-node-runtime.mjs：出包脚本给的优先，其次是 Tauri 自己导出的，最后才是构建机自己。
const targetTriple = process.env.PI_DESKTOP_TARGET_TRIPLE?.trim() || process.env.TAURI_ENV_TARGET_TRIPLE?.trim() || hostTargetTriple();
const spec = runtimeSpec(targetTriple);
const archiveSpec = pythonArchiveSpec(targetTriple);
const sourceOverride = process.env.PI_DESKTOP_PYTHON_SOURCE_DIR?.trim();

mkdirSync(binariesDir, { recursive: true });
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

let sha256 = "";
if (sourceOverride) {
  if (!existsSync(sourceOverride)) {
    throw new Error(`PI_DESKTOP_PYTHON_SOURCE_DIR does not exist: ${sourceOverride}`);
  }
  console.log(`python: using ${sourceOverride} (target ${spec.key}, no download)`);
  cpSync(sourceOverride, outputDir, { recursive: true });
} else {
  const archivePath = join(binariesDir, ".downloads", archiveSpec.name);
  console.log(`python: downloading ${archiveSpec.url}`);
  sha256 = await downloadArchive(archiveSpec.url, archivePath);
  const { verified } = verifyPinnedHash({ id: "python", target: targetTriple, sha256 });
  console.log(
    `python: ${PYTHON_VERSION}+${PYTHON_RELEASE_TAG} sha256 ${sha256}${verified ? " (matches runtimePins.json)" : ""}`,
  );
  extractArchive(archivePath, archiveSpec.type, outputDir);
  rmSync(dirname(archivePath), { recursive: true, force: true });
}

removeMacFrameworkAliases(targetTriple, outputDir);
const layout = bundledPythonLayout(targetTriple, outputDir);
ensurePythonExecutable(layout);
ensureExecutable(layout.bin);
// The payload ships pip; only the two markers that stop it from installing into the app's own
// tree are removed. `site-packages` is left exactly as upstream built it.
preparePip(layout);

// Repair pass (the override path needs it; the archive path finds nothing to repair) and the
// gate that has to hold for both. Nothing below executes Python unless the target is native.
const hostPaths = [sourceOverride, outputDir].filter(Boolean);
const prunedMetadata = pruneHostReferenceMetadata(outputDir, { forbidden: hostPaths });
const stripped = stripBytecodeCache(outputDir);
const relocated = relocateRuntime(outputDir, {
  platform: platformForTarget(targetTriple),
  pythonName: basename(layout.bin),
  pythonExeName: platformForTarget(targetTriple) === "win32" ? basename(layout.bin) : undefined,
  forbidden: hostPaths,
});
if (relocated.symlinks.length || relocated.scripts.length || relocated.wrappers.length || prunedMetadata.length || stripped.length) {
  console.log(
    `python: relocated ${relocated.symlinks.length} symlink(s), ${relocated.scripts.length} console script(s), ` +
      `${relocated.wrappers.length} windows wrapper(s), pruned ${prunedMetadata.length} host-path metadata file(s), ` +
      `stripped ${stripped.length} __pycache__ entr(ies)`,
  );
}

// The payload cannot be executed while cross-assembling one, so the two checks that need a
// running interpreter (and `otool`) only happen on a native build. The file-level gate below
// still runs for every target.
const native = isNativeTarget(targetTriple);
let strippedLate = [];
if (native) {
  verifyNoHostRuntimeDependencies(layout, targetTriple);
  verifyStandalonePython(layout);
  // Running the interpreter regenerates caches that record this machine's paths - strip again,
  // then gate last.
  strippedLate = stripBytecodeCache(outputDir);
} else {
  console.log(`python: skipping the executable checks for ${spec.key} (assembled on ${process.platform}/${process.arch})`);
}

verifyRuntimeRelocatable(outputDir, {
  platform: platformForTarget(targetTriple),
  forbidden: hostPaths,
});

writeRuntimeMetadata(layout, targetTriple, { relocated, pruned: prunedMetadata, stripped: [...stripped, ...strippedLate], sha256, url: sourceOverride ? "" : archiveSpec.url });
writeProvenance(outputDir, {
  id: "python",
  version: PYTHON_VERSION,
  releaseTag: PYTHON_RELEASE_TAG,
  target: spec.key,
  url: sourceOverride ? "" : archiveSpec.url,
  sha256,
  source: sourceOverride || undefined,
  includesPip: true,
});

console.log(`Built Pi Desktop Python runtime for ${spec.key} (${PYTHON_VERSION}): ${outputDir}`);

function removeMacFrameworkAliases(target, runtimeDir) {
  if (!target.includes("apple-darwin") || !existsSync(join(runtimeDir, "Versions", "3.13"))) {
    return;
  }

  rmSync(join(runtimeDir, "Versions", "Current"), { recursive: true, force: true });
  rmSync(join(runtimeDir, "Headers"), { recursive: true, force: true });
}

function bundledPythonLayout(target, runtimeDir) {
  if (target.includes("windows")) {
    return {
      home: runtimeDir,
      bin: join(runtimeDir, "python.exe"),
      stdlib: join(runtimeDir, "Lib"),
      sitePackages: join(runtimeDir, "Lib", "site-packages"),
    };
  }

  if (target.includes("apple-darwin")) {
    const frameworkHome = join(runtimeDir, "Versions", "3.13");
    if (existsSync(join(frameworkHome, "bin", "python3.13"))) {
      return {
        home: frameworkHome,
        bin: join(frameworkHome, "bin", "python3.13"),
        stdlib: join(frameworkHome, "lib", "python3.13"),
        sitePackages: join(frameworkHome, "lib", "python3.13", "site-packages"),
      };
    }

    return {
      home: runtimeDir,
      bin: join(runtimeDir, "bin", "python3.13"),
      stdlib: join(runtimeDir, "lib", "python3.13"),
      sitePackages: join(runtimeDir, "lib", "python3.13", "site-packages"),
    };
  }

  return {
    home: runtimeDir,
    bin: join(runtimeDir, "bin", "python3.13"),
    stdlib: join(runtimeDir, "lib", "python3.13"),
    sitePackages: join(runtimeDir, "lib", "python3.13", "site-packages"),
  };
}

function ensurePythonExecutable(layout) {
  if (!existsSync(layout.bin)) {
    throw new Error(`Python runtime is missing its executable: ${layout.bin}`);
  }
}

/**
 * Keep the shipped pip usable from inside the app's own tree:
 *  - `EXTERNALLY-MANAGED` (a distro-packaging marker) would make `pip install` refuse;
 *  - a `sitecustomize.py` in the stdlib would run on every interpreter start.
 */
function preparePip(layout) {
  rmSync(join(layout.stdlib, "EXTERNALLY-MANAGED"), { force: true });
  rmSync(join(layout.stdlib, "sitecustomize.py"), { force: true });
  if (!existsSync(layout.sitePackages)) {
    throw new Error(`Python runtime has no site-packages directory: ${layout.sitePackages}`);
  }
}

function verifyNoHostRuntimeDependencies(layout, target) {
  if (!target.includes("apple-darwin")) {
    return;
  }

  const binaries = [layout.bin];
  const dynload = join(layout.stdlib, "lib-dynload");
  for (const entry of existsSync(dynload) ? walk(dynload) : []) {
    if (entry.endsWith(".so")) {
      binaries.push(entry);
    }
  }
  for (const binary of binaries) {
    const result = spawnSync("otool", ["-L", binary], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`Unable to inspect macOS runtime dependency: ${binary}`);
    }
    const forbidden = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("/opt/homebrew/") || line.startsWith("/usr/local/"));
    if (forbidden) {
      throw new Error(
        `Python runtime is not self-contained: ${binary} links to ${forbidden}. Use a relocatable Python distribution instead of Homebrew.`,
      );
    }
  }
}

function walk(root, found = []) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      walk(path, found);
    } else {
      found.push(path);
    }
  }
  return found;
}

function verifyStandalonePython(layout) {
  const expectedHome = resolve(layout.home);
  const validation = [
    "import os, pathlib, pip, sys",
    `expected = pathlib.Path(${JSON.stringify(expectedHome)}).resolve()`,
    "prefix = pathlib.Path(sys.prefix).resolve()",
    "pip_path = pathlib.Path(pip.__file__).resolve()",
    "if prefix != expected:",
    "    raise SystemExit(f'Python prefix escaped bundled runtime: {prefix}')",
    "if expected not in pip_path.parents:",
    "    raise SystemExit(f'pip escaped bundled runtime: {pip_path}')",
    "if any('/opt/homebrew/' in path or '/usr/local/' in path for path in sys.path):",
    "    raise SystemExit(f'Python path contains a host location: {sys.path}')",
    "print(f'Python {sys.version_info.major}.{sys.version_info.minor} with bundled pip {pip.__version__}')",
  ].join("\n");
  runPython(layout, ["-c", validation], "verify standalone Python and pip");
}

function writeRuntimeMetadata(layout, target, { relocated, pruned, stripped, sha256, url } = {}) {
  writeFileSync(join(outputDir, "pi-desktop-runtime.json"), `${JSON.stringify({
    kind: "python",
    version: PYTHON_VERSION,
    releaseTag: PYTHON_RELEASE_TAG,
    target,
    url: url || undefined,
    sha256: sha256 || undefined,
    home: relativeRuntimePath(layout.home),
    executable: relativeRuntimePath(layout.bin),
    pip: "bundled",
    relocatable: true,
    relocated: {
      symlinks: (relocated?.symlinks ?? []).map(relativeRuntimePath),
      scripts: (relocated?.scripts ?? []).map(relativeRuntimePath),
      wrappers: (relocated?.wrappers ?? []).map(relativeRuntimePath),
      pruned: (pruned ?? []).map(relativeRuntimePath),
      stripped: (stripped ?? []).map(relativeRuntimePath),
    },
  }, null, 2)}\n`, "utf8");
}

function relativeRuntimePath(value) {
  return value.slice(outputDir.length).replace(/^[/\\]/, "").replace(/\\/g, "/") || ".";
}

function runPython(layout, args, label) {
  const result = spawnSync(layout.bin, args, {
    encoding: "utf8",
    env: isolatedPythonEnv(layout),
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${result.status ?? "unknown"}): ${result.stderr || result.stdout || "no output"}`,
    );
  }
}

function isolatedPythonEnv(layout) {
  const env = { ...process.env };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  delete env.PYTHONUSERBASE;
  // A pycache prefix redirects bytecode (and pip's RECORD entries for it) to a
  // host-absolute-path cache outside the runtime - the relocatability gate then
  // fails on build-machine paths baked into shipped metadata.
  delete env.PYTHONPYCACHEPREFIX;
  delete env.PIP_PREFIX;
  delete env.PIP_TARGET;
  delete env.PIP_USER;
  env.PYTHONHOME = layout.home;
  env.PYTHONNOUSERSITE = "1";
  // Build-time runs must not write a cache that records this machine's absolute
  // module paths: it would leak into user tracebacks after the tree is shipped.
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PIP_IGNORE_INSTALLED = "1";
  return env;
}

function hostTargetTriple() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }

  throw new Error(`Set TAURI_ENV_TARGET_TRIPLE when building on ${process.platform}.`);
}