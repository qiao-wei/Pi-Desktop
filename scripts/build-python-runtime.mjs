import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTargetTriple();
const sourceDir = resolvePythonSourceDir(targetTriple);

mkdirSync(binariesDir, { recursive: true });
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(sourceDir, outputDir, {
  recursive: true,
  dereference: true,
});
removeMacFrameworkAliases(targetTriple, outputDir);

const layout = bundledPythonLayout(targetTriple, outputDir);
ensurePythonExecutable(layout);
resetSitePackages(layout);
verifyNoHostRuntimeDependencies(layout, targetTriple);
bootstrapPip(layout);

// cpSync leaves symlinks pointing into `sourceDir`, and ensurepip bakes this
// build-time path into bin/pip (or Scripts/pip.exe). Both resolve on this machine
// and nowhere else, so the tree has to be repaired before it is shipped.
const hostPaths = [sourceDir, outputDir];
const relocated = relocateRuntime(outputDir, {
  platform: platformForTarget(targetTriple),
  pythonName: basename(layout.bin),
  pythonExeName: platformForTarget(targetTriple) === "win32" ? basename(layout.bin) : undefined,
  forbidden: hostPaths,
});
const pruned = pruneHostReferenceMetadata(outputDir, { forbidden: hostPaths });
// Bytecode caches are stripped *after* everything that runs Python during the
// build, because a `.pyc` records the absolute path of the module it came from.
const stripped = stripBytecodeCache(outputDir);

verifyStandalonePython(layout);
// The checks above run the interpreter, which regenerates caches that record this
// machine's paths - strip again, then gate last.
const strippedLate = stripBytecodeCache(outputDir);
verifyRuntimeRelocatable(outputDir, {
  platform: platformForTarget(targetTriple),
  forbidden: hostPaths,
});

if (relocated.symlinks.length || relocated.scripts.length || relocated.wrappers.length || pruned.length || stripped.length || strippedLate.length) {
  console.log(
    `Relocated bundled Python: ${relocated.symlinks.length} symlink(s), ` +
      `${relocated.scripts.length} console script(s), ${relocated.wrappers.length} windows wrapper(s), ` +
      `${pruned.length} host-path-bound metadata file(s) removed, ` +
      `${stripped.length + strippedLate.length} __pycache__ entr(ies) stripped`,
  );
}

writeRuntimeMetadata(layout, targetTriple, { relocated, pruned });
console.log(`Built Pi Desktop Python runtime for ${targetTriple}: ${outputDir}`);

function resolvePythonSourceDir(target) {
  const override = process.env.PI_DESKTOP_PYTHON_SOURCE_DIR?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`PI_DESKTOP_PYTHON_SOURCE_DIR does not exist: ${override}`);
    }
    return override;
  }

  if (target.includes("windows")) {
    return resolveWindowsPythonSource();
  }

  if (target.includes("apple-darwin")) {
    return resolveMacPythonSource(target);
  }

  throw new Error(
    "Set PI_DESKTOP_PYTHON_SOURCE_DIR to a target-native, self-contained Python 3.13 runtime. Homebrew Python is not supported because it links to Homebrew libraries.",
  );
}

function resolveMacPythonSource(target) {
  const uvArchitecture = target.startsWith("aarch64-") ? "aarch64" : "x86_64";
  const candidates = [
    // uv-managed CPython builds are relocatable and do not depend on Homebrew.
    ...managedUvPythonCandidates(uvArchitecture),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "bin", "python3.13"))) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to find a target-native macOS Python 3.13 runtime. Install one with `uv python install 3.13` or set PI_DESKTOP_PYTHON_SOURCE_DIR to a relocatable Python.framework/runtime path.",
  );
}

function managedUvPythonCandidates(architecture) {
  const uvPythonDir = process.env.UV_PYTHON_INSTALL_DIR?.trim() || join(homedir(), ".local", "share", "uv", "python");
  if (!existsSync(uvPythonDir)) {
    return [];
  }

  return readdirSync(uvPythonDir)
    .filter((entry) => entry.startsWith("cpython-3.13") && entry.includes(`macos-${architecture}-`))
    .sort()
    .reverse()
    .map((entry) => join(uvPythonDir, entry));
}

function resolveWindowsPythonSource() {
  const candidates = [
    fromWhere("python"),
    fromWhere("python3"),
    join(process.env.LocalAppData ?? "", "Programs", "Python", "Python313"),
    join(process.env.ProgramFiles ?? "", "Python313"),
    join(process.env["ProgramFiles(x86)"] ?? "", "Python313"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (
      existsSync(join(candidate, "python.exe")) &&
      existsSync(join(candidate, "Lib")) &&
      existsSync(join(candidate, "DLLs"))
    ) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to find a Windows Python install. Set PI_DESKTOP_PYTHON_SOURCE_DIR to the Python installation root.",
  );
}

function fromWhere(command) {
  try {
    const result = spawnSync("where", [command], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) {
        return dirname(firstMatch);
      }
    }
  } catch {
    // Ignore lookup failures and continue with the next candidate.
  }

  return "";
}

function removeMacFrameworkAliases(target, outputDir) {
  if (!target.includes("apple-darwin") || !existsSync(join(outputDir, "Versions", "3.13"))) {
    return;
  }

  rmSync(join(outputDir, "Versions", "Current"), { recursive: true, force: true });
  rmSync(join(outputDir, "Headers"), { recursive: true, force: true });
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

function resetSitePackages(layout) {
  rmSync(join(layout.stdlib, "EXTERNALLY-MANAGED"), { force: true });
  rmSync(join(layout.stdlib, "sitecustomize.py"), { force: true });
  rmSync(layout.sitePackages, { recursive: true, force: true });
  mkdirSync(layout.sitePackages, { recursive: true });
}

function verifyNoHostRuntimeDependencies(layout, target) {
  if (!target.includes("apple-darwin")) {
    return;
  }

  const binaries = [
    layout.bin,
    ...collectFiles(join(layout.stdlib, "lib-dynload")).filter((path) => path.endsWith(".so")),
  ];
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

function collectFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

function bootstrapPip(layout) {
  runPython(layout, ["-m", "ensurepip", "--upgrade", "--default-pip"], "bootstrap pip");
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

function writeRuntimeMetadata(layout, target, relocation = {}) {
  writeFileSync(join(outputDir, "pi-desktop-runtime.json"), `${JSON.stringify({
    kind: "python",
    target,
    home: relativeRuntimePath(layout.home),
    executable: relativeRuntimePath(layout.bin),
    pip: "ensurepip",
    relocatable: true,
    relocated: {
      symlinks: (relocation.relocated?.symlinks ?? []).map(relativeRuntimePath),
      scripts: (relocation.relocated?.scripts ?? []).map(relativeRuntimePath),
      wrappers: (relocation.relocated?.wrappers ?? []).map(relativeRuntimePath),
      pruned: (relocation.pruned ?? []).map(relativeRuntimePath),
    },
  }, null, 2)}\n`, "utf8");
}

function relativeRuntimePath(value) {
  return value.slice(outputDir.length).replace(/^[/\\]/, "").replace(/\\/g, "/");
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
  // host-absolutepath cache outside the runtime - the relocatability gate then
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
