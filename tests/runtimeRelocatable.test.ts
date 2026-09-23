/**
 * Bundled-runtime relocatability (the build-time half of "works on a host with no
 * Node/Python").
 *
 * Both accidents this guards are invisible on the machine that caused them:
 *   - `cpSync(..., { dereference: true })` re-creates symlinks as absolute links
 *     back into the source install, so `bin/python3` dies on any other machine;
 *   - `ensurepip` bakes the build-time absolute interpreter path into `bin/pip`
 *     (and into `Scripts\pip.exe` on Windows).
 *
 * The tests below build fixtures and then *run* them, including a copy-to-a-
 * different-path round trip, because "it works here" is exactly the property that
 * is being claimed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  findUnrelocatable,
  parseShebang,
  platformForTarget,
  pruneHostReferenceMetadata,
  relocateRuntime,
  shebangProblem,
  stripBytecodeCache,
  verifyRuntimeRelocatable,
  walkTree,
} from "../scripts/lib/pythonRuntime.mjs";

// Stands in for the machine that builds the runtime.
const HOST = join(tmpdir(), "build-machine-host");
const BUILD_RUNTIME = join(HOST, "src-tauri", "binaries", "python-runtime");
const FORBIDDEN = [HOST, BUILD_RUNTIME];

function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-runtime-"));
  const runtimeDir = join(root, "python-runtime");
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  mkdirSync(HOST, { recursive: true });
  try {
    return body({ root, runtimeDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(HOST, { recursive: true, force: true });
  }
}

function writeFile(path, content, mode = 0o644) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8" });
  chmodSync(path, mode);
}

/** The bundled interpreter, as a script so it is runnable from a test. */
function fakePython(path) {
  writeFile(path, ["#!/bin/sh", 'echo "python $*"', ""].join("\n"), 0o755);
}

function relocate(runtimeDir, platform = "darwin") {
  return relocateRuntime(runtimeDir, {
    platform,
    pythonName: "python3.13",
    pythonExeName: "python.exe",
    forbidden: FORBIDDEN,
  });
}

function problems(runtimeDir, platform = "darwin") {
  return findUnrelocatable(runtimeDir, { platform, forbidden: FORBIDDEN });
}

test("platform comes from the target triple, not the build host", () => {
  assert.equal(platformForTarget("aarch64-apple-darwin"), "darwin");
  assert.equal(platformForTarget("x86_64-unknown-linux-gnu"), "linux");
  assert.equal(platformForTarget("x86_64-pc-windows-msvc"), "win32");
  assert.equal(platformForTarget(""), "linux");
});

test("a symlink escaping into the host install becomes an in-tree relative link", () =>
  fixture(({ runtimeDir }) => {
    fakePython(join(runtimeDir, "bin", "python3.13"));
    // What cpSync produces from a uv/python-build-standalone source.
    writeFile(join(HOST, "uv", "bin", "python3.13"), "#!/bin/sh\necho uv\n", 0o755);
    symlinkSync(join(HOST, "uv", "bin", "python3.13"), join(runtimeDir, "bin", "python3"));

    assert.deepEqual(
      problems(runtimeDir).map((problem) => problem.kind),
      ["escaping-symlink"],
    );

    relocate(runtimeDir);

    assert.equal(readlinkSync(join(runtimeDir, "bin", "python3")), "python3.13");
    assert.deepEqual(problems(runtimeDir), []);
    // The previously-dead alias now runs, and keeps running from a copy elsewhere.
    const moved = join(runtimeDir, "..", "moved", "python-runtime");
    cpSync(runtimeDir, moved, { recursive: true });
    const result = spawnSync(join(moved, "bin", "python3"), ["-c", "x"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /python -c x/);
  }));

test("an escaping symlink with no in-tree twin is materialised, not left dangling", () =>
  fixture(({ runtimeDir }) => {
    const hostFile = join(HOST, "share", "python-3.13.pc");
    writeFile(hostFile, "prefix=/somewhere\n");
    writeFile(join(runtimeDir, "lib", "pkgconfig", "ignored.txt"), "x\n");
    symlinkSync(hostFile, join(runtimeDir, "lib", "pkgconfig", "python3.pc"));

    relocate(runtimeDir);

    const shipped = join(runtimeDir, "lib", "pkgconfig", "python3.pc");
    assert.ok(lstatSync(shipped).isFile(), "expected a real file, not a link");
    assert.equal(readFileSync(shipped, "utf8"), "prefix=/somewhere\n");
    assert.deepEqual(problems(runtimeDir), []);
  }));

test("a dangling symlink is dropped instead of shipped", () =>
  fixture(({ runtimeDir }) => {
    fakePython(join(runtimeDir, "bin", "python3.13"));
    symlinkSync(join(HOST, "gone", "idle3.13"), join(runtimeDir, "bin", "idle3"));

    const changed = relocate(runtimeDir);
    assert.equal(existsSync(join(runtimeDir, "bin", "idle3")), false);
    assert.equal(changed.removed.length, 1);
    assert.deepEqual(problems(runtimeDir), []);
  }));

test("an absolute in-tree symlink is rewritten relative so the bundle can move", () =>
  fixture(({ runtimeDir }) => {
    fakePython(join(runtimeDir, "bin", "python3.13"));
    symlinkSync(join(runtimeDir, "bin", "python3.13"), join(runtimeDir, "bin", "python"));

    assert.deepEqual(
      problems(runtimeDir).map((problem) => problem.kind),
      ["absolute-symlink"],
    );
    relocate(runtimeDir);
    assert.equal(readlinkSync(join(runtimeDir, "bin", "python")), "python3.13");
    assert.deepEqual(problems(runtimeDir), []);
  }));

test("a console script with a baked interpreter path is relocated and still runs from a copy", () =>
  fixture(({ runtimeDir, root }) => {
    fakePython(join(runtimeDir, "bin", "python3.13"));
    const pip = join(runtimeDir, "bin", "pip");
    writeFile(
      pip,
      [
        `#!${join(BUILD_RUNTIME, "bin", "python3.13")}`,
        "# -*- coding: utf-8 -*-",
        "from pip._internal.cli.main import main",
        "import sys",
        "sys.exit(main())",
      ].join("\n"),
      0o755,
    );

    assert.deepEqual(
      problems(runtimeDir).map((problem) => [problem.kind, basename(problem.path)]),
      [["interpreter-shebang", "pip"]],
    );

    const changed = relocate(runtimeDir);
    assert.deepEqual(changed.scripts, [pip]);
    assert.deepEqual(parseShebang(readFileSync(pip, "utf8")).interpreter, "/bin/sh");
    // The Python body is preserved beside it.
    assert.match(readFileSync(join(runtimeDir, "bin", ".pip.py"), "utf8"), /from pip\._internal/);
    assert.deepEqual(problems(runtimeDir), []);

    // Relocatability is only proven by running the tree from somewhere else.
    const moved = join(root, "Applications", "Pi Desktop.app", "Contents", "Resources", "python-runtime");
    cpSync(runtimeDir, moved, { recursive: true });
    const result = spawnSync(join(moved, "bin", "pip"), ["--version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /python .*\.pip\.py --version/);
  }));

test("`#!/usr/bin/env python3` is fine only when the bundle ships that name", () => {
  assert.equal(
    shebangProblem({ interpreter: "/usr/bin/env", args: ["python3"], viaEnv: true }, "/rt/bin/x", "/rt"),
    "/usr/bin/env python3",
    "a clean host has no python3 at all",
  );
  // Same shebang, but the runtime provides bin/python3 -> relative link.
  assert.equal(shebangProblem(parseShebang("#!/bin/sh"), "/rt/bin/x", "/rt"), null);
});

test("env-shebang scripts pass the gate once bin/python3 exists in the tree", () =>
  fixture(({ runtimeDir }) => {
    fakePython(join(runtimeDir, "bin", "python3.13"));
    symlinkSync("python3.13", join(runtimeDir, "bin", "python3"));
    writeFile(join(runtimeDir, "bin", "tool"), "#!/usr/bin/env python3\nprint(1)\n", 0o755);

    assert.deepEqual(problems(runtimeDir), [], "resolvable inside the bundle");
    relocate(runtimeDir);
    assert.deepEqual(problems(runtimeDir), []);
  }));

test("stdlib files are never turned into trampolines, even with a shebang", () =>
  fixture(({ runtimeDir }) => {
    fakePython(join(runtimeDir, "bin", "python3.13"));
    const module = join(runtimeDir, "lib", "python3.13", "module.py");
    writeFile(module, `#!${join(BUILD_RUNTIME, "bin", "python3.13")}\nVALUE = 1\n`);

    relocate(runtimeDir);
    assert.equal(readFileSync(module, "utf8").startsWith("#!"), true, "left untouched");
    assert.equal(existsSync(join(runtimeDir, "lib", "python3.13", ".module.py.py")), false);
  }));

test("compiled bytecode that records the build path is stripped", () =>
  fixture(({ runtimeDir }) => {
    fakePython(join(runtimeDir, "bin", "python3.13"));
    writeFile(join(runtimeDir, "lib", "python3.13", "__pycache__", "abc.cpython-313.pyc"), `${HOST}\x00`);

    assert.equal(problems(runtimeDir).length, 1);
    const removed = stripBytecodeCache(runtimeDir);
    assert.equal(removed.length, 1);
    assert.equal(existsSync(join(runtimeDir, "lib", "python3.13", "__pycache__")), false);
    assert.deepEqual(problems(runtimeDir), []);
  }));

test("metadata that cannot be rewritten is pruned when it carries a host path", () =>
  fixture(({ runtimeDir }) => {
    fakePython(join(runtimeDir, "bin", "python3.13"));
    const pc = join(runtimeDir, "lib", "pkgconfig", "python-3.13.pc");
    writeFile(pc, `prefix=${HOST}\n`);
    const keep = join(runtimeDir, "lib", "pkgconfig", "keep.pc");
    writeFile(keep, "prefix=/usr\n");

    const removed = pruneHostReferenceMetadata(runtimeDir, { forbidden: FORBIDDEN });
    assert.deepEqual(removed, [pc]);
    assert.equal(existsSync(keep), true, "uninvolved files stay");
    assert.equal(existsSync(join(runtimeDir, "lib", "pkgconfig")), true, "dir still has keep.pc");

    rmSync(keep);
    pruneHostReferenceMetadata(runtimeDir, { forbidden: FORBIDDEN });
    assert.equal(existsSync(join(runtimeDir, "lib", "pkgconfig")), false, "emptied dir removed");
  }));

test("the gate fails on a fatal reference and lists it", () =>
  fixture(({ runtimeDir }) => {
    writeFile(join(runtimeDir, "bin", "python3.13"), `#!/bin/sh\necho ${BUILD_RUNTIME}\n`, 0o755);
    assert.throws(
      () => verifyRuntimeRelocatable(runtimeDir, { platform: "darwin", forbidden: FORBIDDEN }),
      /not relocatable.*host-path-reference/s,
    );
  }));

test("build-time install prefixes in sysconfig are reported, not fatal", () =>
  fixture(({ runtimeDir }) => {
    writeFile(
      join(runtimeDir, "lib", "python3.13", "_sysconfigdata__darwin_darwin.py"),
      `{"BINDIR": "${join(HOST, "bin")}"\n}\n`,
    );
    const found = problems(runtimeDir);
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "provenance");
    verifyRuntimeRelocatable(runtimeDir, { platform: "darwin", forbidden: FORBIDDEN });
  }));

test("windows console launchers are replaced by %~dp0 wrappers", () =>
  fixture(({ runtimeDir }) => {
    const scripts = join(runtimeDir, "Lib", "site-packages", "Scripts");
    writeFile(join(scripts, "pip.exe"), `MZ\x00${join(BUILD_RUNTIME, "python.exe")}\x00`, 0o755);
    writeFile(join(scripts, "unknown.exe"), `MZ\x00${join(BUILD_RUNTIME, "python.exe")}\x00`, 0o755);

    const changed = relocate(runtimeDir, "win32");
    const wrapper = join(scripts, "pip.cmd");
    assert.deepEqual(changed.wrappers, [wrapper]);
    assert.equal(existsSync(join(scripts, "pip.exe")), false);
    assert.match(readFileSync(wrapper, "utf8"), /"%~dp0python\.exe" -m pip %\*/);

    // Anything the relocator cannot regenerate must keep the gate shut.
    const remaining = problems(runtimeDir, "win32").map((problem) => problem.kind);
    assert.ok(remaining.includes("host-path-reference"), "unknown.exe must be reported");
    assert.throws(
      () => verifyRuntimeRelocatable(runtimeDir, { platform: "win32", forbidden: FORBIDDEN }),
      /unknown\.exe/,
    );
  }));

test("relocation is idempotent (a second pass changes nothing)", () =>
  fixture(({ runtimeDir }) => {
    fakePython(join(runtimeDir, "bin", "python3.13"));
    symlinkSync(join(HOST, "python3.13"), join(runtimeDir, "bin", "python3"));
    writeFile(join(runtimeDir, "bin", "pip"), `#!${join(BUILD_RUNTIME, "bin", "python3.13")}\npass\n`, 0o755);

    relocate(runtimeDir);
    const first = walkTree(runtimeDir).sort().join("\n");
    const second = relocate(runtimeDir);
    assert.deepEqual(second.scripts, []);
    assert.deepEqual(second.symlinks, []);
    assert.equal(walkTree(runtimeDir).sort().join("\n"), first);
    assert.deepEqual(problems(runtimeDir), []);
  }));

test("the build scripts actually run the relocatability pipeline", () => {
  const pythonBuild = readFileSync("scripts/build-python-runtime.mjs", "utf8");
  const nodeBuild = readFileSync("scripts/build-node-runtime.mjs", "utf8");

  for (const [label, source] of [
    ["python", pythonBuild],
    ["node", nodeBuild],
  ]) {
    assert.match(source, /relocateRuntime\(/, `${label}: symlinks and console scripts are repaired`);
    assert.match(source, /stripBytecodeCache\(/, `${label}: bytecode caches are stripped`);
    assert.match(source, /verifyRuntimeRelocatable\(/, `${label}: the result is gated`);
  }
  // Ordering matters: any Python run after the strip re-bakes the build path.
  assert.ok(
    pythonBuild.indexOf("verifyStandalonePython(layout);") < pythonBuild.indexOf("verifyRuntimeRelocatable("),
    "the relocatability gate runs after the last check that executes Python",
  );
  assert.match(
    pythonBuild,
    /env\.PYTHONDONTWRITEBYTECODE = "1"/,
    "build-time Python must not write caches that record this machine",
  );
});

test("the sidecar puts the bundled runtimes and their install dirs on PATH", () => {
  const source = readFileSync("server/index.mjs", "utf8");
  assert.match(source, /import \{ agentRuntimePathDirs, mergePath \} from "\.\/agentEnv\.mjs"/);
  assert.match(
    source,
    /const runtimeDirs = agentRuntimePathDirs\(\{[\s\S]*?\}\);/,
    "the bundled runtime dirs are computed",
  );
  assert.match(
    source,
    /process\.env\.PATH = mergePath\(usable, process\.env\.PATH/,
    "PATH is merged with them instead of replaced",
  );
  assert.match(source, /applyAgentRuntimePath\(\);/, "it happens during startup");
  assert.ok(
    source.indexOf("applyAgentRuntimePath();") < source.indexOf("await runPiCli("),
    "and before the embedded pi CLI takes the process over",
  );
  // One renderer, or Electron and Tauri drift apart again.
  assert.ok(!/export function renderPosixShim/.test(source), "launchers come from server/agentShims.mjs only");
});

// The real shipped trees: if they are built locally, they must pass the same gate
// the packager enforces. Skipped (not faked) when the runtimes are absent.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
for (const [name, dir] of [
  ["python", join(repoRoot, "src-tauri", "binaries", "python-runtime")],
  ["node", join(repoRoot, "src-tauri", "binaries", "node-runtime")],
]) {
  test(`the locally built ${name} runtime is relocatable`, (t) => {
    if (!existsSync(dir)) {
      t.skip(`${dir} is not built (npm run ${name}:build)`);
      return;
    }
    // Anything under the build user's home, or spelled with this repo's build
    // path, would be dead on the machine the app is installed on.
    const leftovers = findUnrelocatable(dir, {
      platform: process.platform,
      forbidden: [homedir(), dir],
    }).filter((problem) => problem.severity === "fatal");
    assert.deepEqual(
      leftovers.slice(0, 5),
      [],
      `${dir} still references the build machine: ${JSON.stringify(leftovers.slice(0, 3))}`,
    );
  });
}
