// Bundled-runtime relocatability (macOS / Linux / Windows).
//
// Two independent accidents make the "bundled" runtimes non-relocatable, and both
// are invisible on the machine that built them:
//
//  1. `fs.cpSync(src, dst, { recursive: true, dereference: true })` does NOT
//     flatten symlinks it meets while recursing — it recreates them pointing back
//     into the *source* tree (verified on Node 25). With a uv / python-build-
//     standalone install as the source, the shipped `bin/python3`, `bin/idle3`,
//     `bin/python3-config`, ... become absolute links into the build machine.
//  2. `python -m ensurepip` writes console scripts with `#!<sys.executable>` —
//     i.e. the build-time absolute path of the runtime itself (`.../src-tauri/
//     binaries/python-runtime/bin/python3.13`), and on Windows `Scripts\pip.exe`
//     embeds that same path inside the launcher binary.
//
// On the build machine every one of those paths still exists, so nothing fails
// locally. On a host without Python the bundled runtime is dead on arrival. This
// module (a) repairs what can be repaired, (b) prunes metadata that cannot be
// repaired and is not needed at runtime, and (c) fails the build if anything
// still resolves to the build machine.
//
// Platform comes from the target triple, never from the build host, because
// `python:build` runs for mac / linux / windows targets.

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Present on any machine that can run the script at all.
const SYSTEM_SHELLS = new Set(["/bin/sh", "/bin/bash", "/bin/dash", "/usr/bin/env"]);
// A python/node interpreter is a hard dependency on whoever installed it. On a
// host without a runtime, `#!/usr/bin/env python3` resolves to nothing.
const LANGUAGE_INTERPRETER = /(?:^|[\\/])(?:python[\d._]*|pypy[\d._]*|node|nodejs)(?:\.exe)?$/i;
// Console entry points live in exactly these directories. Nothing else may be
// turned into a trampoline — the stdlib is full of `.py` files.
const SCRIPT_DIRS = new Set(["bin", "scripts", "sbin"]);
// `pip.exe` / `pip3.exe` / `wheel-0.4.exe`: launchers we can regenerate as
// `%~dp0python.exe -m <module>` wrappers. Anything else is reported, not guessed.
const WINDOWS_LAUNCHER = /^(?<module>pip|wheel|setuptools)(?<suffix>[\d.]*)\.exe$/i;
const WINDOWS_LAUNCHER_MODULES = new Set(["pip", "wheel", "setuptools"]);

export function platformForTarget(targetTriple = "") {
  if (targetTriple.includes("windows")) {
    return "win32";
  }
  if (targetTriple.includes("apple-darwin")) {
    return "darwin";
  }
  return "linux";
}

/** Every entry below `root`, symlinks included (never followed). */
export function walkTree(root) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    out.push(path);
    // A link to a directory must never be descended: that is how the escaping
    // symlinks this module exists to find would pull the whole host tree in.
    if (entry.isDirectory()) {
      out.push(...walkTree(path));
    }
  }
  return out;
}

export function isInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`.${sep}`) && !isAbsolute(rel));
}

/** `realpath` when the path exists, otherwise the path as given. */
export function realpathOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** `#!/dir/interp --flag` -> { interpreter, args, viaEnv } | null */
export function parseShebang(text) {
  if (!text.startsWith("#!")) {
    return null;
  }
  const line = text.split(/\r?\n/, 1)[0].slice(2).trim();
  if (!line) {
    return null;
  }
  const [interpreter, ...args] = line.split(/\s+/);
  return {
    interpreter,
    args,
    viaEnv: interpreter === "/usr/bin/env" || interpreter === "env",
  };
}

/** Is there an interpreter with this name inside the bundle (i.e. shipped)? */
export function hasInTreeInterpreter(runtimeDir, name, extraDirs = []) {
  if (!name) {
    return false;
  }
  const roots = [runtimeDir, ...(Array.isArray(extraDirs) ? extraDirs : [])].filter(Boolean);
  const dirs = roots.flatMap((root) => [root, join(root, "bin"), join(root, "Scripts"), join(root, "sbin")]);
  return dirs.some((dir) => {
    const candidate = join(dir, name);
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
}

/** Reason this shebang needs a host/build-machine interpreter, or null if safe. */
export function shebangProblem(shebang, scriptPath, runtimeDir, interpreterDirs = []) {
  if (!shebang) {
    return null;
  }
  if (shebang.viaEnv) {
    const named = shebang.args[0] ?? "";
    if (!LANGUAGE_INTERPRETER.test(named)) {
      return null;
    }
    // `#!/usr/bin/env python3` is fine when the bundle ships its own `python3`
    // and its bin dir is on PATH (both shells prepend it); otherwise it is a
    // hard dependency on a host install. The interpreter may live in a sibling
    // directory of the same bundle (a JS tree shipped next to the node runtime),
    // which is what `interpreterDirs` declares.
    return hasInTreeInterpreter(runtimeDir, named, interpreterDirs) ? null : `/usr/bin/env ${named}`;
  }
  const { interpreter } = shebang;
  if (SYSTEM_SHELLS.has(interpreter) || !LANGUAGE_INTERPRETER.test(interpreter)) {
    return null;
  }
  if (!isInside(runtimeDir, resolve(dirname(scriptPath), interpreter))) {
    return interpreter;
  }
  // Inside this tree but spelled absolutely: it breaks as soon as the bundle is
  // copied somewhere else, which is exactly what the packager does.
  return isAbsolute(interpreter) ? interpreter : null;
}

function readHead(path, bytes = 4096) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(bytes);
    const size = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, size);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

function shebangOf(path) {
  const head = readHead(path);
  // Mach-O / ELF / Windows PE are full of NUL bytes; scripts are not.
  if (!head || head.includes(0)) {
    return null;
  }
  return parseShebang(head.toString("utf8"));
}

function isScriptDir(path, runtimeDir) {
  const parent = dirname(path);
  return SCRIPT_DIRS.has(basename(parent).toLowerCase()) || resolve(parent) === resolve(runtimeDir);
}

function isFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Follows symlinks: an in-tree link to a real file counts as a usable twin. */
function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Reads the whole file only for the sizes we are willing to grep by hand. */
function containsHostPath(path, forbidden, maxBytes = 8 * 1024 * 1024) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size > maxBytes) {
    return null;
  }
  let text;
  try {
    text = readFileSync(path).toString("latin1");
  } catch {
    return null;
  }
  for (const needle of forbidden) {
    if (needle && text.includes(needle)) {
      return needle;
    }
    // Windows launchers and .pth files may spell the same path with backslashes.
    const alternate = needle.replace(/\//g, "\\");
    if (alternate !== needle && text.includes(alternate)) {
      return needle;
    }
  }
  return null;
}

/**
 * Files that carry a build-time install prefix but are never consulted to *find*
 * anything at runtime: `sysconfig` install layout and the extension-build
 * Makefile. They leak a path in `pip install` error messages, nothing else. The
 * gate reports them instead of shipping them silently.
 */
export const PROVENANCE_ONLY = [
  /(^|[\\/])lib([\\/])python[\d.]+([\\/])_sysconfigdata[^\\/]*\.py$/i,
  /(^|[\\/])lib([\\/])python[\d.]+([\\/])config-[^\\/]+([\\/]|$)/i,
  /(^|[\\/])_sysconfigdata[^\\/]*\.py$/i,
];

function isProvenanceOnly(relPath) {
  return PROVENANCE_ONLY.some((pattern) => pattern.test(relPath));
}

/**
 * Everything in `runtimeDir` that would break on another machine.
 * @param {string} runtimeDir
 * @param {{platform?: string, forbidden?: string[]}} [options]
 * @returns {{kind: string, path: string, detail: string, severity: "fatal"|"provenance"}[]}
 */
export function findUnrelocatable(runtimeDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const forbidden = (options.forbidden ?? []).filter(Boolean);
  // macOS hands out `/var/...` while realpath says `/private/var/...`; comparing a
  // realpath against an unresolved root would call every in-tree link an escape.
  const root = realpathOrSelf(runtimeDir);
  const problems = [];
  const classify = (problem) => {
    const rel = relative(runtimeDir, problem.path).split(/[\\/]/).join("/");
    problems.push({ ...problem, severity: isProvenanceOnly(`/${rel}`) ? "provenance" : "fatal" });
  };

  for (const path of walkTree(runtimeDir)) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink()) {
      if (platform === "win32") {
        continue;
      }
      const raw = readlinkSync(path);
      const target = resolve(dirname(path), raw);
      if (!existsSync(target)) {
        classify({ kind: "dangling-symlink", path, detail: raw });
      } else if (!isInside(root, realpathOrSelf(target))) {
        classify({ kind: "escaping-symlink", path, detail: realpathOrSelf(target) });
      } else if (isAbsolute(raw)) {
        classify({ kind: "absolute-symlink", path, detail: raw });
      }
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    if (isScriptDir(path, runtimeDir)) {
      const shebang = shebangOf(path);
      const detail = shebang ? shebangProblem(shebang, path, runtimeDir, options.interpreterDirs ?? []) : null;
      if (detail) {
        classify({ kind: "interpreter-shebang", path, detail });
        continue;
      }
    }

    const needle = containsHostPath(path, forbidden);
    if (needle) {
      classify({ kind: "host-path-reference", path, detail: needle });
    }
  }

  return problems;
}

/**
 * `.pyc` files embed the absolute source path of the module they were compiled
 * from. Copying a stdlib therefore ships tracebacks that point at the build
 * machine, and `__pycache__` is only a startup cache: Python rebuilds it whenever
 * the source is newer or the cache is not writable. Strip it.
 */
export function stripBytecodeCache(runtimeDir) {
  const removed = [];
  for (const path of walkTree(runtimeDir)) {
    const rel = relative(runtimeDir, path).split(/[\\/]/).join("/");
    if (!/(^|[\\/])__pycache__([\\/]|$)/.test(rel)) {
      continue;
    }
    try {
      if (!existsSync(path)) {
        continue;
      }
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Unreadable entry: the gate below still inspects it.
    }
  }
  return removed;
}

const posixTrampoline = (pythonName, bodyName) =>
  [
    "#!/bin/sh",
    "# Relocatable entry point: resolves its own directory (so it keeps working",
    "# wherever the bundle ends up) and hands off to the bundled interpreter.",
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
    `exec "$here/${pythonName}" "$here/${bodyName}" "$@"`,
    "",
  ].join("\n");

const windowsWrapper = (pythonExeName, module) =>
  [
    "@echo off",
    // `%~dp0` is this script's own directory, so the wrapper survives any move.
    `"${'%~dp0'}${pythonExeName}" -m ${module} %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");

/**
 * Repairs a runtime tree in place.
 * @param {string} runtimeDir
 * @param {{platform?: string, pythonName?: string, pythonExeName?: string, forbidden?: string[]}} [options]
 */
export function relocateRuntime(runtimeDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const pythonName = options.pythonName ?? "python3.13";
  const pythonExeName = options.pythonExeName ?? "python.exe";
  const changed = { symlinks: [], scripts: [], wrappers: [], removed: [] };

  for (const path of walkTree(runtimeDir)) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }

    // --- POSIX symlinks -----------------------------------------------------
    if (stat.isSymbolicLink()) {
      if (platform === "win32") {
        continue;
      }
      const root = realpathOrSelf(runtimeDir);
      const raw = readlinkSync(path);
      const target = resolve(dirname(path), raw);
      const real = existsSync(target) ? realpathOrSelf(target) : null;

      if (real && isInside(root, real)) {
        const rel = relative(realpathOrSelf(dirname(path)), real);
        if (raw !== rel) {
          rmSync(path);
          symlinkSync(rel, path);
          changed.symlinks.push(path);
        }
        continue;
      }

      // Escaping or dangling: prefer the same-named file that already lives next
      // to it (`python3` -> `python3.13`), else materialise the real file so the
      // tree stands alone, else drop dead weight.
      const wanted = real ? basename(real) : basename(path);
      const neighbour = join(dirname(path), wanted);
      rmSync(path);
      if (real && isRegularFile(neighbour)) {
        symlinkSync(relative(realpathOrSelf(dirname(path)), realpathOrSelf(neighbour)), path);
        changed.symlinks.push(path);
      } else if (real) {
        copyFileSync(real, path);
        chmodSync(path, statSync(real).mode & 0o777);
        changed.symlinks.push(path);
      } else {
        changed.removed.push(path);
      }
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    // --- Windows console launchers -----------------------------------------
    if (platform === "win32") {
      if (!isScriptDir(path, runtimeDir) || !WINDOWS_LAUNCHER.test(basename(path))) {
        continue;
      }
      const needle = containsHostPath(path, options.forbidden ?? [], 1024 * 1024);
      const module = WINDOWS_LAUNCHER.exec(basename(path))?.groups?.module?.toLowerCase();
      if (!needle || !module || !WINDOWS_LAUNCHER_MODULES.has(module)) {
        continue;
      }
      const wrapper = join(dirname(path), `${basename(path).replace(/\.exe$/i, "")}.cmd`);
      writeFileSync(wrapper, windowsWrapper(pythonExeName, module));
      rmSync(path);
      changed.wrappers.push(wrapper);
      changed.removed.push(path);
      continue;
    }

    // --- POSIX console scripts ---------------------------------------------
    if (!isScriptDir(path, runtimeDir) || stat.size > 64 * 1024) {
      continue;
    }
    const shebang = shebangOf(path);
    if (!shebang || !shebangProblem(shebang, path, runtimeDir)) {
      continue;
    }
    const text = readFileSync(path, "utf8");
    const bodyName = `.${basename(path)}.py`;
    writeFileSync(join(dirname(path), bodyName), text.slice(text.indexOf("\n") + 1), {
      encoding: "utf8",
      mode: 0o644,
    });
    writeFileSync(path, posixTrampoline(pythonName, bodyName), { encoding: "utf8", mode: 0o755 });
    chmodSync(path, 0o755);
    changed.scripts.push(path);
  }

  return changed;
}

/**
 * Some shipped files embed an absolute build path that cannot be rewritten and is
 * never used at runtime (pkg-config metadata, man pages, `python3-config` — the
 * last one only matters for compiling C extensions, and no compiler ships). Those
 * are removed, and the removal is reported so the build gate below stays strict
 * for everything that *is* needed to run node / python / npm / pip.
 */
export const PRUNABLE_WHEN_HOST_REFERENCED = [
  /(^|[\\/])share([\\/](?:man|info))([\\/]|$)/i,
  /(^|[\\/])lib([\\/])pkgconfig([\\/]|$)/i,
  /(^|[\\/])bin([\\/])[^\\/]*-config(\.\w+)?$/i,
];

export function pruneHostReferenceMetadata(runtimeDir, options = {}) {
  const forbidden = (options.forbidden ?? []).filter(Boolean);
  const removed = [];

  for (const path of walkTree(runtimeDir)) {
    if (!isFile(path)) {
      continue;
    }
    const rel = relative(runtimeDir, path).split(/[\\/]/).join("/");
    if (!PRUNABLE_WHEN_HOST_REFERENCED.some((pattern) => pattern.test(`/${rel}`))) {
      continue;
    }
    if (containsHostPath(path, forbidden, 1024 * 1024)) {
      rmSync(path);
      removed.push(path);
    }
  }

  // Do not leave emptied metadata directories behind: they would only confuse.
  for (const dir of ["lib/pkgconfig", "share/man", "share/info"]) {
    const full = join(runtimeDir, dir);
    if (existsSync(full) && readdirSync(full).length === 0) {
      rmSync(full, { recursive: true, force: true });
    }
  }

  return removed;
}

/** Build gate: fail loudly rather than shipping a runtime that works only here. */
export function verifyRuntimeRelocatable(runtimeDir, options = {}) {
  const problems = findUnrelocatable(runtimeDir, options);
  const fatal = problems.filter((problem) => problem.severity === "fatal");
  const provenance = problems.filter((problem) => problem.severity === "provenance");

  if (provenance.length) {
    console.warn(
      `[pi-desktop] bundled runtime keeps ${provenance.length} build-time install prefix(es) in ` +
        `sysconfig/extension-build metadata (harmless for running python, visible in some ` +
        `pip error messages):\n` +
        provenance
          .slice(0, 5)
          .map((problem) => `  - ${relative(runtimeDir, problem.path)}`)
          .join("\n"),
    );
  }

  if (fatal.length === 0) {
    return;
  }

  const listing = fatal
    .slice(0, 20)
    .map((problem) => `  - [${problem.kind}] ${relative(runtimeDir, problem.path)} -> ${problem.detail}`)
    .join("\n");
  const more = fatal.length > 20 ? `\n  ... and ${fatal.length - 20} more` : "";

  throw new Error(
    `Bundled runtime is not relocatable: ${fatal.length} reference(s) resolve to the build machine ` +
      `or to an interpreter that has to be installed on the host. A machine without ` +
      `node/python hits these the moment the app is installed.\n${listing}${more}`,
  );
}

export { LANGUAGE_INTERPRETER, SYSTEM_SHELLS };
