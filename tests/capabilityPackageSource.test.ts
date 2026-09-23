/**
 * User-scope packages must not be stored as a path relative to whichever project happened to
 * be active at install time. pi does exactly that, and Pi Desktop keys capability ids (`user:<source>`),
 * per-session selections, defaults and pins off that string — so a moved project silently
 * orphans a package that is installed, enabled and loaded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  absolutizeInstalledUserPackage,
  absolutizedPackageEntry,
  installTargetPath,
  isRegistryPackageSource,
  packageSourceForPi,
  packageSourceOf,
  resolveEntryCandidates,
  selectEntriesToAbsolutize,
} from "../server/capabilityPackageSource.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CWD = "/Users/dev/Desktop/tmp/aaa";
const AGENT_DIR = "/Users/dev/.pi/agent";
const TARGET = "/tmp/probe-ext-pkg";
// Measured 2026-09-10: a user-scope local install is stored relative to the scope's base dir
// (`~/.pi/agent`) — not relative to the project cwd, which is 5 levels deep here and 4 there.
const PI_ENTRY = relative(AGENT_DIR, TARGET);
const CWD_RELATIVE_ENTRY = relative(CWD, TARGET);

test("install targets: absolute stays, relative resolves against the project, registry has none", () => {
  assert.equal(installTargetPath(TARGET, CWD), TARGET);
  assert.equal(installTargetPath(join(CWD, "local-pkg"), CWD), join(CWD, "local-pkg"));
  assert.equal(resolve(installTargetPath("./local-pkg", CWD)), join(CWD, "local-pkg"));
  assert.equal(installTargetPath("npm:pi-memory", CWD), "");
  assert.equal(installTargetPath("", CWD), "");
  assert.equal(installTargetPath(undefined, CWD), "");
});

test("registry-ish sources are never mistaken for paths", () => {
  assert.equal(isRegistryPackageSource("npm:pi-memory"), true);
  assert.equal(isRegistryPackageSource("git+https://example.com/x.git"), true);
  assert.equal(isRegistryPackageSource(PI_ENTRY), false);
  assert.equal(isRegistryPackageSource(TARGET), false);
  assert.equal(isRegistryPackageSource(""), false);
});

test("entry sources are read from both string and object forms", () => {
  assert.equal(packageSourceOf("npm:pi-web-access"), "npm:pi-web-access");
  assert.equal(packageSourceOf({ source: "npm:pi-memory", autoload: false }), "npm:pi-memory");
  assert.equal(packageSourceOf(undefined), "");
});

test("what pi really writes (base-dir relative) is found and rewritten absolute", () => {
  const packages = ["npm:pi-web-access", { source: PI_ENTRY }];
  const indexes = selectEntriesToAbsolutize({
    packages,
    installTarget: TARGET,
    bases: [AGENT_DIR, CWD],
  });

  assert.deepEqual(indexes, [1]);
  assert.equal(absolutizedPackageEntry("./whatever", TARGET), TARGET);
  assert.deepEqual(absolutizedPackageEntry(packages[1], TARGET), { source: TARGET });
});

test("a hand-written cwd-relative entry is caught too, because both bases are tried", () => {
  assert.ok(resolveEntryCandidates(PI_ENTRY, [AGENT_DIR]).includes(TARGET));
  const indexes = selectEntriesToAbsolutize({
    packages: [CWD_RELATIVE_ENTRY],
    installTarget: TARGET,
    bases: [AGENT_DIR, CWD],
  });
  assert.deepEqual(indexes, [0]);
});

test("object entries keep autoload and friends when only the source is rewritten", () => {
  assert.deepEqual(
    absolutizedPackageEntry({ source: PI_ENTRY, autoload: false }, TARGET),
    { source: TARGET, autoload: false },
  );
});

test("nothing to do: already absolute, registry source, or no matching install", () => {
  assert.deepEqual(selectEntriesToAbsolutize({ packages: [TARGET], installTarget: TARGET, bases: [CWD] }), []);
  assert.deepEqual(selectEntriesToAbsolutize({ packages: ["npm:pi-memory"], installTarget: TARGET, bases: [CWD] }), []);
  assert.deepEqual(selectEntriesToAbsolutize({ packages: ["./other"], installTarget: TARGET, bases: [CWD] }), []);
  assert.deepEqual(selectEntriesToAbsolutize({ packages: [], installTarget: "", bases: [CWD] }), []);
  assert.deepEqual(selectEntriesToAbsolutize({}), []);
});

test("duplicate relative twins for the same directory all get rewritten", () => {
  const indexes = selectEntriesToAbsolutize({
    packages: [PI_ENTRY, "npm:pi-web-access", { source: PI_ENTRY, autoload: false }],
    installTarget: TARGET,
    bases: [AGENT_DIR],
  });

  // Leaving one relative entry behind would keep `user:<source>` ambiguous.
  assert.deepEqual(indexes, [0, 2]);
});

function fakeSettingsManager(packages) {
  const calls = [];
  return {
    calls,
    getGlobalSettings: () => ({ packages: [...packages] }),
    setPackages: (next) => calls.push(next),
  };
}

test("the rewrite is actually persisted through the settings manager", () => {
  const sm = fakeSettingsManager(["npm:pi-web-access", { source: PI_ENTRY, autoload: false }]);
  const result = absolutizeInstalledUserPackage({
    settingsManager: sm,
    installSource: TARGET,
    projectCwd: CWD,
    agentDir: AGENT_DIR,
  });

  assert.equal(result.changed, true);
  assert.equal(sm.calls.length, 1, "an entry that points at the install must be written back");
  assert.deepEqual(sm.calls[0], ["npm:pi-web-access", { source: TARGET, autoload: false }]);
});

test("registry installs and already-absolute entries are left untouched", () => {
  const registry = fakeSettingsManager(["npm:pi-web-access", { source: "npm:pi-memory" }]);
  assert.equal(
    absolutizeInstalledUserPackage({
      settingsManager: registry,
      installSource: "npm:pi-memory",
      projectCwd: CWD,
      agentDir: AGENT_DIR,
    }).changed,
    false,
  );
  assert.equal(registry.calls.length, 0);

  const absolute = fakeSettingsManager([TARGET]);
  assert.equal(
    absolutizeInstalledUserPackage({
      settingsManager: absolute,
      installSource: TARGET,
      projectCwd: CWD,
      agentDir: AGENT_DIR,
    }).changed,
    false,
  );
  assert.equal(absolute.calls.length, 0);
});

test("the install handler straightens user-scope packages and matches them by where they landed", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");

  assert.match(source, /straightenInstalledPackage\(targetRuntime, source\)/);
  assert.match(source, /settingsManager: targetRuntime\.settingsManager/, "the rewrite must run against live settings");
  assert.match(source, /pkg\.installedPath === resolve\(installTarget\)/, "lookups must survive the rewritten source");
});

/* ------------------- remove/update: the stored source round-trip ------------------- */

// pi resolves a local source argument against the project cwd, but project settings store it
// relative to `<cwd>/.pi`. Passing the stored string straight back matches nothing, so pi's
// remove no-ops silently and the Delete button looks broken.

test("a project entry is resolved from `.pi`, where pi actually wrote it", () => {
  // pi writes a project install as `relative(<cwd>/.pi, target)`; this is what
  // `/Users/dev/Desktop/tmp/aaa/packages/pi-mcp-adapter` looks like in settings.
  const projectEntry = "../packages/pi-mcp-adapter";

  assert.equal(
    packageSourceForPi({ source: projectEntry, scope: "project", projectCwd: CWD, agentDir: AGENT_DIR }),
    join(CWD, "packages", "pi-mcp-adapter"),
  );
  assert.notEqual(
    packageSourceForPi({ source: projectEntry, scope: "project", projectCwd: CWD, agentDir: AGENT_DIR }),
    projectEntry,
    "a bare relative source must not reach pi: it would resolve against the cwd and miss",
  );
});

test("a user entry is resolved from the agent dir", () => {
  assert.equal(packageSourceForPi({ source: PI_ENTRY, scope: "user", projectCwd: CWD, agentDir: AGENT_DIR }), TARGET);
});

test("absolute paths and registry sources pass through untouched", () => {
  assert.equal(packageSourceForPi({ source: TARGET, scope: "project", projectCwd: CWD, agentDir: AGENT_DIR }), TARGET);
  assert.equal(packageSourceForPi({ source: "npm:pi-memory", scope: "project", projectCwd: CWD, agentDir: AGENT_DIR }), "npm:pi-memory");
  assert.equal(
    packageSourceForPi({ source: "git:github.com/x/y", scope: "project", projectCwd: CWD, agentDir: AGENT_DIR }),
    "git:github.com/x/y",
  );
});

test("missing sources and surrounding whitespace are handled", () => {
  assert.equal(packageSourceForPi({ source: "  ", scope: "project", projectCwd: CWD, agentDir: AGENT_DIR }), "");
  assert.equal(packageSourceForPi({ scope: "project", projectCwd: CWD, agentDir: AGENT_DIR }), "");
  assert.equal(
    packageSourceForPi({ source: "  ./local-pkg  ", scope: "project", projectCwd: CWD, agentDir: AGENT_DIR }),
    join(CWD, ".pi", "local-pkg"),
  );
});

test("the remove handler resolves the stored source and refuses a silent no-op", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");

  assert.match(source, /const removableSource = packageSourceForPi\(\{/);
  assert.match(source, /removeAndPersist\(removableSource, \{ local \}\)/);
  // pi returns false when nothing matched; the user pressed Delete, so surface it.
  assert.match(source, /if \(!removed\) \{[\s\S]*?throw new Error\(/);
});
