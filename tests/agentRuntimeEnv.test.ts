/**
 * The bundled-runtime environment contract: on a host with no Node and no Python,
 * `node`, `python`, `npm` and `pip` must still work inside the app.
 *
 * Two halves:
 *   - where the launchers put things on PATH (npm/pip output dirs included, or an
 *     install silently lands somewhere the app cannot call);
 *   - the `~/.pi/agent/bin` launchers themselves, executed for real under `env -i`.
 *     A launcher that cannot find its runtime must say so and exit non-zero — the
 *     old ones exec'd a stale absolute path, which is how "python3 is broken" got
 *     mistaken for "python3 was never bundled".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { agentRuntimePathDirs, mergePath, packageManagerBinDirs } from "../server/agentEnv.mjs";
import { createAgentShims } from "../server/agentShims.mjs";

// A PATH with nothing but OS directories: no nvm, no Homebrew, no pyenv.
const HOST_WITHOUT_RUNTIMES = "/usr/bin:/bin:/usr/sbin:/sbin";

const dirs = {
  agentPythonBaseDir: "/home/user/.pi/agent/python",
  agentPythonCacheDir: "/home/user/.pi/agent/python/cache",
  agentNodeBaseDir: "/home/user/.pi/agent/node",
  agentNodeCacheDir: "/home/user/.pi/agent/npm-cache",
  agentNodeConfigFile: "/home/user/.pi/agent/node/npmrc",
};
const shims = createAgentShims(dirs);

function withTemp(body) {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-agent-env-"));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

/** A stand-in interpreter that reports how it was invoked. */
function fakeInterpreter(path, label) {
  writeExecutable(path, ["#!/bin/sh", `echo "${label} $*"`, ""].join("\n"));
}

function run(file, args = [], env = {}) {
  return spawnSync(file, args, {
    encoding: "utf8",
    // No inherited PATH: what the launcher can reach is only what it sets itself.
    env: { HOME: process.env.HOME, PATH: HOST_WITHOUT_RUNTIMES, ...env },
  });
}

test("PATH assembly keeps the bundled runtimes first and adds package-manager output", () => {
  const result = agentRuntimePathDirs({
    agentDir: "/home/user/.pi/agent",
    bundledNodeBin: "/Applications/Pi Desktop.app/Contents/Resources/node-runtime/bin/node",
    platform: "darwin",
  });

  assert.deepEqual(result, [
    "/home/user/.pi/agent/bin",
    "/Applications/Pi Desktop.app/Contents/Resources/node-runtime/bin",
    "/home/user/.pi/agent/node/bin",
    "/home/user/.pi/agent/python/bin",
  ]);
});

test("package-manager output directories follow each platform's convention", () => {
  assert.deepEqual(packageManagerBinDirs("/agent", "darwin"), [
    join("/agent", "node", "bin"),
    join("/agent", "python", "bin"),
  ]);
  // npm's global bin on Windows *is* the prefix root; pip uses \Scripts.
  assert.deepEqual(packageManagerBinDirs("C:\\agent", "win32"), [
    join("C:\\agent", "node"),
    join("C:\\agent", "python", "Scripts"),
  ]);
  assert.deepEqual(packageManagerBinDirs("/agent", "linux"), packageManagerBinDirs("/agent", "darwin"));
});

test("bundledNodeBin is optional (dev runs the server without a shell)", () => {
  const result = agentRuntimePathDirs({ agentDir: "/agent", platform: "darwin" });
  assert.equal(result[0], join("/agent", "bin"));
  assert.equal(result.length, 3, "shim dir + the two package-manager dirs");
});

test("mergePath prepends without reordering or duplicating", () => {
  const merged = mergePath(
    ["/agent/bin", "/app/node/bin", "/agent/bin"],
    "/usr/bin:/agent/bin:/bin",
    "darwin",
  );
  assert.equal(merged, "/agent/bin:/app/node/bin:/usr/bin:/bin");
});

test("mergePath uses ';' and is case-insensitive on Windows", () => {
  const merged = mergePath(
    ["C:\\agent\\bin\\", "C:\\agent\\node"],
    "C:\\Windows\\system32;C:\\AGENT\\BIN",
    "win32",
  );
  assert.equal(merged, "C:\\agent\\bin;C:\\agent\\node;C:\\Windows\\system32");
});

test("mergePath survives an empty host PATH and drops empty entries", () => {
  assert.equal(mergePath(["/a", "", "/b"], "", "darwin"), "/a:/b");
  assert.equal(mergePath([], undefined, "darwin"), "");
});

test("launchers run the bundled runtime even when the host has none", () =>
  withTemp((root) => {
    const runtime = join(root, "Pi Desktop.app/Contents/Resources");
    mkdirSync(join(runtime, "node-runtime/bin"), { recursive: true });
    fakeInterpreter(join(runtime, "node-runtime/bin/node"), "node");
    const npmCli = join(runtime, "node-runtime/lib/node_modules/npm/bin/npm-cli.js");
    mkdirSync(join(npmCli, ".."), { recursive: true });
    writeFileSync(npmCli, "");

    const launcher = join(root, "node");
    writeExecutable(
      launcher,
      shims.renderPosixNodeShim(join(runtime, "node-runtime/bin/node"), npmCli, "node"),
    );
    const result = run(launcher, ["-e", "0"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^node -e 0/);
  }));

test("npm and pip point at their own entry modules and keep the isolated prefix", () =>
  withTemp((root) => {
    const nodeBin = join(root, "node.exe.sh");
    fakeInterpreter(nodeBin, "NODE");
    const npmLauncher = join(root, "npm");
    writeExecutable(
      npmLauncher,
      shims.renderPosixNodeShim(nodeBin, "/bundle/npm-cli.js", "npm"),
    );
    const npm = run(npmLauncher, ["i", "-g", "left-pad"]);
    assert.equal(npm.status, 0, npm.stderr);
    assert.match(npm.stdout, /NODE \/bundle\/npm-cli\.js i -g left-pad/);

    const pythonBin = join(root, "python3.13.sh");
    fakeInterpreter(pythonBin, "PY");
    const pipLauncher = join(root, "pip3");
    writeExecutable(pipLauncher, shims.renderPosixShim(pythonBin, "pip", join(root, "py-home")));
    const pip = run(pipLauncher, ["install", "requests"]);
    assert.equal(pip.status, 0, pip.stderr);
    // `-m pip`, not the baked console script: the shipped launcher survives a move.
    assert.match(pip.stdout, /PY -m pip install requests/);

    const pythonLauncher = join(root, "python3");
    writeExecutable(pythonLauncher, shims.renderPosixShim(pythonBin, "python", join(root, "py-home")));
    const py = run(pythonLauncher, ["-c", "print(1)"]);
    assert.match(py.stdout, /PY -c print\(1\)/);
  }));

test("a launcher whose baked runtime vanished fails loudly instead of silently", () =>
  withTemp((root) => {
    const gone = join(root, "Volumes/DELETED/Pi Desktop.app/Contents/Resources/node-runtime/bin/node");
    const launcher = join(root, "node");
    writeExecutable(launcher, shims.renderPosixNodeShim(gone, join(root, "npm-cli.js"), "node"));

    const result = run(launcher, ["--version"]);
    assert.notEqual(result.status, 0, "a dead runtime must not look like success");
    assert.equal(result.status, 127);
    assert.match(result.stderr, /bundled runtime is unavailable/);
    assert.doesNotMatch(
      result.stderr,
      /No such file or directory/,
      "the shell must not be the one reporting the failure",
    );
  }));

test("the python launcher reports a missing runtime the same way", () =>
  withTemp((root) => {
    const gone = join(root, "Volumes/DELETED/Pi Desktop.app/Contents/Resources/python-runtime/bin/python3.13");
    const launcher = join(root, "python3");
    writeExecutable(launcher, shims.renderPosixShim(gone, "python", join(root, "nope")));

    const result = run(launcher, ["--version"]);
    assert.equal(result.status, 127);
    assert.match(result.stderr, /bundled runtime is unavailable/);
    assert.doesNotMatch(result.stderr, /No such file or directory/, "the message, not sh's, is what the user sees");
  }));

test("a launcher written by an older launch self-heals from the live environment", () =>
  withTemp((root) => {
    // The app was moved (DMG -> /Applications): the baked path is stale, but the
    // running shell exports the live one.
    const stale = join(root, "Volumes/OLD/node");
    const current = join(root, "Applications/Pi Desktop.app/Contents/Resources/node");
    mkdirSync(join(current, ".."), { recursive: true });
    fakeInterpreter(current, "node");
    const npmCli = join(root, "Applications/Pi Desktop.app/Contents/Resources/npm-cli.js");
    writeFileSync(npmCli, "");

    const launcher = join(root, "node");
    writeExecutable(launcher, shims.renderPosixNodeShim(stale, join(root, "gone.js"), "node"));

    const result = run(launcher, ["-v"], {
      PI_DESKTOP_BUNDLED_NODE_BIN: current,
      PI_DESKTOP_BUNDLED_NPM_CLI: npmCli,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^node -v/, "the live runtime must win over the baked one");
  }));

/**
 * End-to-end on the locally built runtimes: launchers written by the real
 * renderer, executed with a host PATH that contains no Node and no Python. This is
 * the requirement itself - `node`, `python`, `npm`, `pip` must work, and what npm
 * or pip installs must be callable afterwards.
 *
 * Depends on `npm run node:build` / `npm run python:build` output, so it skips
 * rather than pretends when those are absent.
 */
test("built runtimes serve node / python / npm / pip without a host install", (t) => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const nodeBin = join(repoRoot, "src-tauri", "binaries", "node-runtime", "bin", "node");
  const npmCli = join(
    repoRoot,
    "src-tauri",
    "binaries",
    "node-runtime",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const pythonHome = join(repoRoot, "src-tauri", "binaries", "python-runtime");
  const pythonBin = join(pythonHome, "bin", "python3.13");
  if (!existsSync(nodeBin) || !existsSync(npmCli) || !existsSync(pythonBin)) {
    t.skip("run npm run node:build && npm run python:build first");
    return;
  }

  withTemp((root) => {
    const agentDir = join(root, "agent");
    const shimDir = join(agentDir, "bin");
    mkdirSync(shimDir, { recursive: true });
    const live = createAgentShims({
      agentPythonBaseDir: join(agentDir, "python"),
      agentPythonCacheDir: join(agentDir, "python", "cache"),
      agentNodeBaseDir: join(agentDir, "node"),
      agentNodeCacheDir: join(agentDir, "npm-cache"),
      agentNodeConfigFile: join(agentDir, "node", "npmrc"),
    });
    for (const [name, content] of [
      ["node", live.renderPosixNodeShim(nodeBin, npmCli, "node")],
      ["npm", live.renderPosixNodeShim(nodeBin, npmCli, "npm")],
      ["python3", live.renderPosixShim(pythonBin, "python", pythonHome)],
      ["pip3", live.renderPosixShim(pythonBin, "pip", pythonHome)],
    ]) {
      writeExecutable(join(shimDir, name), content);
    }

    const cleanHost = {
      HOME: root,
      // OS directories only: no nvm, no Homebrew, no pyenv.
      PATH: [
        shimDir,
        dirname(nodeBin),
        join(agentDir, "node", "bin"),
        join(agentDir, "python", "bin"),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
      PI_DESKTOP_BUNDLED_NODE_BIN: nodeBin,
      PI_DESKTOP_BUNDLED_NPM_CLI: npmCli,
      PI_DESKTOP_BUNDLED_PYTHON_BIN: pythonBin,
      PI_DESKTOP_BUNDLED_PYTHON_HOME: pythonHome,
      // Importing stdlib modules writes __pycache__ next to them; without this the
      // test run itself would leave this machine's paths inside the shipped tree.
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUSERBASE: join(agentDir, "python"),
    };
    const exec = (file, args) => spawnSync(file, args, { encoding: "utf8", env: cleanHost, timeout: 180000 });

    const node = exec("node", ["-e", "console.log(process.execPath)"]);
    assert.equal(node.status, 0, node.stderr);
    assert.equal(node.stdout.trim(), realpathSync(nodeBin), "must be the bundled interpreter");

    const python = exec("python3", ["-c", "import sys;print(sys.executable)"]);
    assert.equal(python.status, 0, python.stderr);
    assert.ok(
      python.stdout.trim().startsWith(pythonHome),
      `must not fall back to a host python: ${python.stdout.trim()}${python.stderr}`,
    );

    // The aliases that used to be a dead link and a baked shebang elsewhere.
    const alias = spawnSync(join(pythonHome, "bin", "python3"), ["-c", "print(1)"], {
      encoding: "utf8",
      // Importing the stdlib writes __pycache__ next to these real files, and a
      // cache that records this machine would fail the shipped-tree gate.
      env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(alias.status, 0, alias.stderr);
    const pipConsole = spawnSync(join(pythonHome, "bin", "pip"), ["--version"], {
      encoding: "utf8",
      env: {
        PATH: `${join(pythonHome, "bin")}:/usr/bin:/bin`,
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    assert.equal(pipConsole.status, 0, pipConsole.stderr);
    assert.match(pipConsole.stdout, /^pip \d/);

    const npm = exec("npm", ["--version"]);
    assert.equal(npm.status, 0, npm.stderr);
    assert.match(npm.stdout, /^\d+\.\d+/);

    // Install globally, then call it by name - only works because the npm prefix
    // bin directory is on PATH.
    const pkg = join(root, "hello-pkg");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "hello-pi-desktop", version: "1.0.0", bin: { "hello-pi-desktop": "bin/cli.js" } }),
    );
    writeFileSync(join(pkg, "bin", "cli.js"), "#!/usr/bin/env node\nconsole.log('installed and callable');\n");
    const install = exec("npm", ["i", "-g", "--no-audit", "--no-fund", pkg]);
    assert.equal(install.status, 0, install.stderr);
    const called = exec("sh", ["-c", "hello-pi-desktop"]);
    assert.equal(called.status, 0, `${called.stdout}${called.stderr}`);
    assert.match(called.stdout, /installed and callable/);

    // pip --user writes its scripts here; prove that is the directory we expose.
    const target = exec("python3", [
      "-c",
      "import sysconfig;print(sysconfig.get_path('scripts', scheme='posix_user'))",
    ]);
    assert.equal(target.status, 0, target.stderr);
    assert.equal(target.stdout.trim(), join(agentDir, "python", "bin"));
  });
});

test("windows launchers keep the same resolution order and failure code", () => {
  const python = shims.renderWindowsShim("C:\\Pi Desktop\\python3.13.exe", "python", "C:\\Pi Desktop");
  assert.match(python, /@echo off/);
  assert.match(python, /if defined PI_DESKTOP_BUNDLED_PYTHON_BIN if exist/);
  assert.match(python, /:pybaked/);
  assert.match(python, /exit \/b 127/);
  assert.match(python, /set "PYTHONHOME=%PI_DESKTOP_BUNDLED_PYTHON_HOME%"/);
  assert.match(python, /"%PI_DESKTOP_BUNDLED_PYTHON_BIN%" %\*/);

  const pip = shims.renderWindowsShim("C:\\Pi Desktop\\python3.13.exe", "pip", "C:\\Pi Desktop");
  assert.match(pip, /-m pip %\*/);

  const npx = shims.renderWindowsNodeShim("C:\\Pi Desktop\\node.exe", "C:\\Pi Desktop\\npm-cli.js", "npx");
  assert.match(npx, /"%PI_DESKTOP_BUNDLED_NODE_BIN%" "%PI_DESKTOP_BUNDLED_NPM_CLI%" exec -- %\*/);
  assert.match(npx, /if not defined PI_DESKTOP_BUNDLED_NPM_CLI/);

  // Windows quoting: a path with a space must survive `if exist`.
  const spaced = shims.renderPosixNodeShim("C:\\Program Files\\Pi Desktop\\node.exe", "x", "node");
  assert.match(spaced, /"C:\\\\Program Files\\\\Pi Desktop\\\\node\.exe"/);
});

function countFiles(root, matches) {
  if (!existsSync(root)) {
    return 0;
  }
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      total += countFiles(path, matches);
    } else if (matches(entry.name)) {
      total += 1;
    }
  }
  return total;
}

const isPyc = (name) => name.endsWith(".pyc");

test("python launchers keep bytecode cache out of the shipped runtime", () => {
  const pythonBin = "/Applications/Pi Desktop.app/Contents/Resources/python-runtime/bin/python3.13";
  const pythonHome = "/Applications/Pi Desktop.app/Contents/Resources/python-runtime";

  // Importing the stdlib writes __pycache__ next to the source files, which bakes this
  // machine's absolute paths into the bundle and may not even be permitted there. The launcher
  // sends caches to the app-managed cache directory instead of disabling caching outright.
  assert.match(
    shims.renderPosixShim(pythonBin, "python", pythonHome),
    /^export PYTHONPYCACHEPREFIX="\/home\/user\/\.pi\/agent\/python\/cache\/pycache"$/m,
  );
  assert.match(shims.renderPosixShim(pythonBin, "pip", pythonHome), /^export PYTHONPYCACHEPREFIX=/m);
  assert.match(shims.renderWindowsShim(pythonBin, "python", pythonHome), /PYTHONPYCACHEPREFIX=/);
});

test("built python through its launcher leaves no cache inside the runtime tree", (t) => {
  const repoRoot = join(import.meta.dirname, "..");
  const pythonHome = join(repoRoot, "src-tauri", "binaries", "python-runtime");
  const pythonBin = join(pythonHome, "bin", "python3.13");
  if (!existsSync(pythonBin)) {
    t.skip("run npm run python:build first");
    return;
  }

  withTemp((root) => {
    const agentDir = join(root, "agent");
    const shimDir = join(agentDir, "bin");
    mkdirSync(shimDir, { recursive: true });
    const live = createAgentShims({
      agentPythonBaseDir: join(agentDir, "python"),
      agentPythonCacheDir: join(agentDir, "python", "cache"),
      agentNodeBaseDir: join(agentDir, "node"),
      agentNodeCacheDir: join(agentDir, "npm-cache"),
      agentNodeConfigFile: join(agentDir, "node", "npmrc"),
    });
    writeExecutable(join(shimDir, "python3"), live.renderPosixShim(pythonBin, "python", pythonHome));

    const before = countFiles(pythonHome, isPyc);
    const run = spawnSync("python3", ["-c", "import json, base64, uuid; print('imported')"], {
      encoding: "utf8",
      // No PYTHONDONTWRITEBYTECODE here on purpose: this is the real call an agent makes.
      env: {
        HOME: root,
        PATH: `${shimDir}:/usr/bin:/bin`,
        PI_DESKTOP_BUNDLED_PYTHON_BIN: pythonBin,
        PI_DESKTOP_BUNDLED_PYTHON_HOME: pythonHome,
      },
      timeout: 180000,
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /imported/);
    assert.equal(countFiles(pythonHome, isPyc), before, "the shipped runtime tree must not gain bytecode caches");
    assert.ok(
      countFiles(join(agentDir, "python", "cache", "pycache"), isPyc) > 0,
      "caching still happens, just outside the bundle",
    );
  });
});

test("the bridge itself points python caches outside the bundle before spawning anything", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "server/index.mjs"), "utf8");
  const apply = source.slice(
    source.indexOf("function applyAgentRuntimePath()"),
    source.indexOf("function applyAgentRuntimePath()") + 1400,
  );

  // Children inherit process.env, so this is what catches python calls that bypass the
  // ~/.pi/agent/bin launchers (MCP stdio servers, skill scripts, absolute paths).
  assert.match(apply, /process\.env\.PYTHONPYCACHEPREFIX = join\(agentPythonCacheDir, "pycache"\)/);
  assert.ok(apply.indexOf("PYTHONPYCACHEPREFIX") < apply.indexOf("process.env.PATH = "), "must be set for every child we spawn");
});
