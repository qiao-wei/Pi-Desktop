/**
 * Skill toggles used to run the full `session.reload()`, which tears down and re-imports
 * every extension and reconnects MCP servers for a change that only moves which skills
 * pi's loader keeps. These tests pin the decision (skills-only vs full vs nothing) and the
 * narrow pi entry points that replace the reload, plus the two call sites that must use
 * them (and the pin path that must not reload at all).
 *
 * The reload decision and the skill pass are pure/duck-typed, so they are exercised for
 * real here instead of asserted as source strings.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { capabilityReloadPlan, reloadRuntimeSkills, sameCapabilityIds } from "../server/capabilityReload.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function selection(overrides = {}) {
  return {
    skills: [],
    enabledSkills: [],
    disabledSkills: [],
    packages: [],
    enabledPackages: [],
    disabledPackages: [],
    extensions: [],
    enabledExtensions: [],
    disabledExtensions: [],
    ...overrides,
  };
}

function fakeRuntime({ skillPaths = ["/app/skills"], loader, session } = {}) {
  const calls = { extendResources: [], setActiveTools: [], reload: 0 };
  const runtime = {
    capabilityPaths: { skillPaths },
    resourceLoader: loader ?? {
      extendResources(args) {
        calls.extendResources.push(args);
      },
    },
    session: session ?? {
      reload() {
        calls.reload += 1;
      },
      getActiveToolNames: () => ["read", "bash"],
      setActiveToolsByName(names) {
        calls.setActiveTools.push(names);
      },
    },
  };
  return { runtime, calls };
}

test("an unchanged selection needs no reload at all", () => {
  const current = selection({ skills: ["a"], enabledSkills: ["a"] });
  assert.equal(capabilityReloadPlan(current, selection({ skills: ["a"], enabledSkills: ["a"] })), "none");
});

test("a skill id order shuffle is not a change", () => {
  const current = selection({ skills: ["a", "b"] });
  assert.equal(capabilityReloadPlan(current, selection({ skills: ["b", "a"] })), "none");
});

test("enabling or disabling a skill is skills-only", () => {
  assert.equal(capabilityReloadPlan(selection({ skills: ["a"] }), selection({ skills: ["a", "b"] })), "skills");
  assert.equal(
    capabilityReloadPlan(selection({ enabledSkills: ["a"] }), selection({ disabledSkills: ["a"] })),
    "skills",
  );
});

test("a package or extension move still forces the full reload", () => {
  assert.equal(capabilityReloadPlan(selection(), selection({ packages: ["p"] })), "full");
  assert.equal(capabilityReloadPlan(selection({ enabledPackages: ["p"] }), selection({ disabledPackages: ["p"] })), "full");
  assert.equal(capabilityReloadPlan(selection(), selection({ extensions: ["e"] })), "full");
  assert.equal(capabilityReloadPlan(selection({ enabledExtensions: ["e"] }), selection({ disabledExtensions: ["e"] })), "full");
});

test("missing selection fields read as empty, not as a change", () => {
  assert.equal(capabilityReloadPlan({}, {}), "none");
  assert.equal(capabilityReloadPlan({ skills: ["a"] }, {}), "skills");
});

test("sameCapabilityIds is order-insensitive and rejects length/type mismatches", () => {
  assert.ok(sameCapabilityIds([], []));
  assert.ok(sameCapabilityIds(["a", "b"], ["b", "a"]));
  assert.ok(!sameCapabilityIds(["a"], ["a", "b"]));
  assert.ok(!sameCapabilityIds(undefined, []));
  assert.ok(!sameCapabilityIds("a", ["a"]));
});

test("the skill reload re-runs pi's own skill pass and rebuilds the prompt, without a session reload", () => {
  const { runtime, calls } = fakeRuntime({ skillPaths: ["/app/skills", "/pkg/skills"] });

  assert.equal(reloadRuntimeSkills(runtime), true);
  assert.equal(calls.reload, 0, "the whole point is to not reload the session");
  assert.equal(calls.extendResources.length, 1);
  assert.deepEqual(
    calls.extendResources[0].skillPaths.map((entry) => entry.path),
    ["/app/skills", "/pkg/skills"],
    "pi only recomputes when handed the active paths",
  );
  assert.deepEqual(calls.setActiveTools, [["read", "bash"]], "the cached system prompt must be rebuilt for the next turn");
});

test("pi's own skill pass picks up a flipped filter through extendResources, with no reload", () => {
  const root = mkdtempSync(join(tmpdir(), "capability-reload-"));
  try {
    const skillsRoot = join(root, "skills");
    for (const name of ["alpha", "beta"]) {
      const dir = join(skillsRoot, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody for ${name}.\n`);
    }

    // Exactly the shape Pi Desktop feeds pi: a live filter over the app's selection set.
    const active = new Set(["alpha"]);
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      additionalSkillPaths: [skillsRoot],
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: (base) => ({ ...base, skills: base.skills.filter((skill) => active.has(skill.name)) }),
    });
    const entry = { path: skillsRoot, metadata: { source: "cli", scope: "temporary", origin: "top-level" } };
    const names = () => loader.getSkills().skills.map((skill) => skill.name).sort();

    loader.extendResources({ skillPaths: [entry] });
    assert.deepEqual(names(), ["alpha"], "the initial selection is filtered by pi's override");

    active.add("beta");
    loader.extendResources({ skillPaths: [entry] });
    assert.deepEqual(names(), ["alpha", "beta"], "enabling re-runs pi's override, no reload");

    active.delete("alpha");
    loader.extendResources({ skillPaths: [entry] });
    assert.deepEqual(names(), ["beta"], "disabling re-runs pi's override, no reload");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the skill reload declines so the caller can fall back to a full reload", () => {
  const withoutExtend = fakeRuntime({ loader: { updateSkillsFromPaths() {} } });
  assert.equal(reloadRuntimeSkills(withoutExtend.runtime), false);

  const withoutPromptRebuild = fakeRuntime({ session: { reload() {}, getActiveToolNames: () => ["read"] } });
  assert.equal(reloadRuntimeSkills(withoutPromptRebuild.runtime), false);

  const withoutPaths = fakeRuntime({ skillPaths: [] });
  assert.equal(reloadRuntimeSkills(withoutPaths.runtime), false);
  assert.equal(withoutPaths.calls.extendResources.length, 0);
});

test("the server decides through the tested module and never hand-rolls the comparison again", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");

  assert.match(source, /from "\.\/capabilityReload\.mjs"/);
  assert.match(source, /capabilityReloadPlan\(current, next\)/, "the mutation path must use the shared decision");
  assert.match(
    source,
    /plan !== "skills" \|\| !reloadRuntimeSkills\(targetRuntime\)/,
    "the fast path must fall back to the full reload when pi has no narrow entry point",
  );
  assert.ok(
    !/function sameCapabilityIds\(/.test(source),
    "the comparison must live in one module, not be duplicated in the server",
  );
});

test("a pin no longer reloads any runtime", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");
  const start = source.indexOf("async function setCapabilityPinned(");
  const end = source.indexOf("async function setSessionSkillCapability(", start);
  assert.ok(start !== -1 && end > start, "setCapabilityPinned must still exist");

  const pinned = source.slice(start, end);
  assert.ok(
    !/reloadOpenRuntimeCapabilities|reloadOpenRuntimeSkills|session\.reload\(/.test(pinned),
    "pinning only changes ordering/labels; nothing in the runtime reads it",
  );
  assert.match(pinned, /return \{ capabilities: await buildCapabilitiesSnapshot\(targetRuntime\) \}/);
});

test("skill mutations answer with the capability slice instead of a full snapshot", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");
  const start = source.indexOf("async function setSessionSkillCapability(");
  const end = source.indexOf("async function updateRuntimeSessionCapabilities(", start);
  const skillMutation = source.slice(start, end);

  assert.match(skillMutation, /return \{ capabilities: await buildCapabilitiesSnapshot\(targetRuntime\) \}/);
  assert.ok(!/refreshSnapshot\(\)/.test(skillMutation), "the transcript did not move, so it must not be rebuilt");
});

test("the client folds the capability slice back instead of re-fetching the transcript", () => {
  const source = readFileSync(join(ROOT, "src/features/chat/usePiDesktopApp.ts"), "utf8");
  const start = source.indexOf("const updateCapability = useCallback(");
  const end = source.indexOf("const setCapabilityDefault = useCallback(", start);
  assert.ok(start !== -1 && end > start, "updateCapability must still exist");

  const updateCapability = source.slice(start, end);
  assert.match(updateCapability, /dispatch\(\{ type: "replace-capabilities", capabilities: result\.capabilities \}\)/);
  assert.match(updateCapability, /case|"snapshot" in result/, "a full bootstrap answer must still be honoured");
  assert.match(source, /case "replace-capabilities":/, "the reducer must own the slice merge");
});