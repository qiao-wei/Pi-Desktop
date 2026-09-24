/**
 * Live skill selection.
 *
 * Pi Desktop owns per-session skill selection and re-asserts it through pi's
 * `skillsOverride`. The old shape precomputed an `activeSkillIds` allow-list from a
 * separate discovery pass; when that pass ran before project trust was resolved it could
 * not see project `.pi/skills`, so the override deleted project skills pi had correctly
 * loaded (jev was the visible casualty).
 *
 * These tests pin the fix at three levels: the pure policy decides from live state, a real
 * pi `DefaultResourceLoader` keeps a project skill even when the inventory is stale, and
 * `server/index.mjs` is wired to that policy instead of a precomputed list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  applySkillSelection,
  createSkillSelectionPolicy,
  replaceSkillSelectionPolicy,
  skillEnabledBySelection,
} from "../server/capabilitySkillSelection.mjs";

const ROOT = join(import.meta.dirname, "..");

const skill = (name: string, filePath: string) => ({ name, filePath, description: `${name} skill` });

function projectFixture() {
  const root = mkdtempSync(join(tmpdir(), "capability-skill-selection-"));
  const projectCwd = join(root, "proj");
  const agentDir = join(root, "agent");
  const skillDir = join(projectCwd, ".pi", "skills", "proj-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: proj-skill\ndescription: project skill\n---\n\nBody.\n");
  return { root, projectCwd, agentDir, skillFilePath: join(skillDir, "SKILL.md") };
}

/* ------------------------------ policy decisions ------------------------------ */

test("explicit session selection wins, config supplies the default, unknown ids stay off", () => {
  const policy = createSkillSelectionPolicy({
    selection: { enabledSkills: ["forced"], disabledSkills: ["on"] },
    config: { skills: { on: { defaultEnabled: true }, off: { defaultEnabled: false } } },
  });

  assert.equal(skillEnabledBySelection(policy, "on"), false, "an explicit disable beats the config default");
  assert.equal(skillEnabledBySelection(policy, "off"), false, "config default is the fallback");
  assert.equal(skillEnabledBySelection(policy, "forced"), true, "an explicit enable beats a missing default");
  assert.equal(skillEnabledBySelection(policy, "unknown"), false, "unknown skills stay opt-in");
});

test("only managed skills enter the inventory the selection may judge", () => {
  const policy = createSkillSelectionPolicy({
    inventorySkills: [
      skill("proj", "/proj/.pi/skills/proj/SKILL.md"),
      skill("pkg", "/agent/npm/pkg/skills/pkg/SKILL.md"),
    ],
    isManaged: (path: string) => path.startsWith("/proj/.pi/skills/"),
  });

  assert.deepEqual([...policy.inventoryIds], ["proj"]);
});

test("unmanaged skills pass through and disabled package roots are dropped", () => {
  const base = [
    skill("proj", "/proj/.pi/skills/proj/SKILL.md"),
    skill("pkg", "/agent/npm/pkg/skills/pkg/SKILL.md"),
  ];
  const policy = createSkillSelectionPolicy({
    inventorySkills: [base[0]],
    config: { skills: { proj: { defaultEnabled: false } } },
    isManaged: (path: string) => path.startsWith("/proj/.pi/skills/"),
  });

  const out = applySkillSelection(base, policy, {
    isManaged: (path: string) => path.startsWith("/proj/.pi/skills/"),
    isDisabledPath: (path: string) => path.startsWith("/agent/npm/pkg/"),
  });

  assert.deepEqual(out.skills.map((item) => item.name), [], "the disabled package's skill and the opted-out project skill both go");
  assert.deepEqual(out.inventory.map((item) => item.name), ["proj", "pkg"], "the inventory is always pi's raw set");
});

/* ------------------------- the regression, pinned directly ------------------------- */

test("a managed skill the pre-resolve never saw fails open instead of disappearing", () => {
  const base = [skill("jev", "/proj/.pi/skills/jev/SKILL.md")];
  // Exactly the old failure: the inventory was resolved before trust, so it knows no
  // managed ids and the config never got an entry for the project skill.
  const stale = createSkillSelectionPolicy({ selection: {}, config: { skills: {} }, inventorySkills: [] });
  const mismatches: string[] = [];

  const out = applySkillSelection(base, stale, {
    isManaged: () => true,
    onMismatch: (item) => mismatches.push(item.name),
  });

  assert.deepEqual(out.skills.map((item) => item.name), ["jev"], "losing the skill silently is the bug; keeping it is the fix");
  assert.deepEqual(mismatches, ["jev"], "the divergence must be reported, not swallowed");
});

test("once the inventory catches up, the same skill follows the live default", () => {
  const filePath = "/proj/.pi/skills/jev/SKILL.md";
  const base = [skill("jev", filePath)];

  const enabled = createSkillSelectionPolicy({
    inventorySkills: [skill("jev", filePath)],
    config: { skills: { jev: { defaultEnabled: true } } },
  });
  assert.deepEqual(applySkillSelection(base, enabled).skills.map((item) => item.name), ["jev"]);

  const disabled = createSkillSelectionPolicy({
    inventorySkills: [skill("jev", filePath)],
    config: { skills: { jev: { defaultEnabled: false } } },
  });
  assert.deepEqual(applySkillSelection(base, disabled).skills.map((item) => item.name), [], "a real opt-out still wins");
});

test("replacing a policy in place keeps the loader's live reference pointed at the new selection", () => {
  const live = createSkillSelectionPolicy({ selection: { disabledSkills: ["jev"] } });
  const next = createSkillSelectionPolicy({ selection: { enabledSkills: ["jev"] } });

  replaceSkillSelectionPolicy(live, next);

  assert.equal(skillEnabledBySelection(live, "jev"), true);
  assert.deepEqual([...live.enabledIds], ["jev"]);
});

/* ------------------------------- real pi loader -------------------------------- */

test("pi's own loader keeps a project skill when the inventory is stale", async () => {
  const { root, projectCwd, agentDir, skillFilePath } = projectFixture();
  try {
    const settingsManager = SettingsManager.create(projectCwd, agentDir, { projectTrusted: true });
    const capabilityPaths: {
      skillSelection: ReturnType<typeof createSkillSelectionPolicy>;
      skillInventory: unknown[];
    } = {
      skillSelection: createSkillSelectionPolicy({ inventorySkills: [] }),
      skillInventory: [],
    };
    const isManaged = (path: string) => path.startsWith(join(projectCwd, ".pi", "skills"));

    const loader = new DefaultResourceLoader({
      cwd: projectCwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: (base) => {
        const { skills, inventory } = applySkillSelection(base.skills, capabilityPaths.skillSelection, { isManaged });
        capabilityPaths.skillInventory = inventory;
        return { ...base, skills };
      },
    });
    await loader.reload();

    assert.ok(
      loader.getSkills().skills.some((item) => item.name === "proj-skill"),
      "the trusted loader found it; the stale inventory must not delete it",
    );
    assert.ok(
      capabilityPaths.skillInventory.some((item: any) => item.name === "proj-skill"),
      "the same pass captures the inventory the capability page will read",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pi does not discover project skills under an untrusted manager", async () => {
  const { root, projectCwd, agentDir } = projectFixture();
  try {
    const settingsManager = SettingsManager.create(projectCwd, agentDir, { projectTrusted: false });
    const loader = new DefaultResourceLoader({
      cwd: projectCwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    assert.ok(
      !loader.getSkills().skills.some((item) => item.name === "proj-skill"),
      "this is the contract that forces the capability inventory to be trust-aligned",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flipping the live policy lands through pi's own skill pass (no session reload)", async () => {
  const { root, projectCwd, agentDir, skillFilePath } = projectFixture();
  try {
    const settingsManager = SettingsManager.create(projectCwd, agentDir, { projectTrusted: true });
    const isManaged = (path: string) => path.startsWith(join(projectCwd, ".pi", "skills"));
    const inventory = [skill("proj-skill", skillFilePath)];
    const config = { skills: { "proj-skill": { defaultEnabled: true } } };
    const capabilityPaths: { skillSelection: ReturnType<typeof createSkillSelectionPolicy> } = {
      skillSelection: createSkillSelectionPolicy({ inventorySkills: inventory, config, isManaged }),
    };
    const loader = new DefaultResourceLoader({
      cwd: projectCwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: (base) => ({
        ...base,
        skills: applySkillSelection(base.skills, capabilityPaths.skillSelection, { isManaged }).skills,
      }),
    });
    await loader.reload();
    // pi also auto-discovers `~/.agents/skills` from the real home, so scope the
    // assertion to the skills this selection owns.
    const names = () => loader.getSkills().skills.filter((item) => isManaged(item.filePath)).map((item) => item.name);
    assert.deepEqual(names(), ["proj-skill"]);

    const disable = createSkillSelectionPolicy({
      selection: { disabledSkills: ["proj-skill"] },
      inventorySkills: inventory,
      config,
      isManaged,
    });
    replaceSkillSelectionPolicy(capabilityPaths.skillSelection, disable);
    loader.extendResources({ skillPaths: [{ path: join(projectCwd, ".pi", "skills"), metadata: { source: "cli", scope: "temporary", origin: "top-level" } }] });
    assert.deepEqual(names(), [], "disabling re-runs the override against the live policy");

    const enable = createSkillSelectionPolicy({
      selection: { enabledSkills: ["proj-skill"] },
      inventorySkills: inventory,
      config: { skills: { "proj-skill": { defaultEnabled: false } } },
      isManaged,
    });
    replaceSkillSelectionPolicy(capabilityPaths.skillSelection, enable);
    loader.extendResources({ skillPaths: [{ path: join(projectCwd, ".pi", "skills"), metadata: { source: "cli", scope: "temporary", origin: "top-level" } }] });
    assert.deepEqual(names(), ["proj-skill"], "an explicit enable beats a config default of false");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the inventory scan does not need extensions to find project skills", async () => {
  const { root, projectCwd, agentDir, skillFilePath } = projectFixture();
  try {
    const settingsManager = SettingsManager.create(projectCwd, agentDir, { projectTrusted: true });
    const loader = new DefaultResourceLoader({
      cwd: projectCwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    assert.ok(loader.getSkills().skills.some((item) => item.name === "proj-skill"));
    assert.equal(loader.getExtensions().extensions.length, 0, "no extension was imported for an inventory-only pass");
    assert.ok(skillFilePath.endsWith("SKILL.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------------- wiring guards -------------------------------- */

test("the server judges skills through the live policy, not a precomputed allow-list", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");

  assert.match(source, /from "\.\/capabilitySkillSelection\.mjs"/);
  assert.match(source, /applySkillSelection\(base\.skills, capabilityPaths\.skillSelection/);
  assert.match(source, /capabilityPaths\.skillInventory = inventory/);
  assert.match(source, /active: skillEnabledBySelection\(skillPolicy, id\)/);
  assert.ok(
    !/capabilityPaths\.activeSkillIds\.has\(/.test(source),
    "the loader must read the live policy; a precomputed id set is what went stale",
  );
});

test("runtime-time snapshots reuse the loader's inventory instead of re-running discovery", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");

  assert.match(source, /const allSkills = targetRuntime\.capabilityPaths\?\.skillInventory/);
  const total = source.match(/await discoverAllProjectSkills\(project, targetRuntime\.settingsManager\)/g)?.length ?? 0;
  const guarded = source.match(/\?\?\s*await discoverAllProjectSkills\(project, targetRuntime\.settingsManager\)/g)?.length ?? 0;
  assert.ok(total >= 3, "the runtime-time call sites must still exist");
  assert.equal(guarded, total, "every one of them must be a fallback behind the captured inventory");
});

test("trust is resolved before the capability inventory", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");
  const start = source.indexOf("async function createRuntime(");
  const end = source.indexOf("function ensureBuiltinPackages(", start);
  const body = source.slice(start, end);

  const trustAt = body.indexOf("resolveProjectTrustForRuntime({");
  const inventoryAt = body.indexOf("const capabilityPaths = await resolveRuntimeCapabilityPaths({");
  assert.ok(trustAt !== -1 && inventoryAt !== -1, "both steps must still exist");
  assert.ok(trustAt < inventoryAt, "an untrusted inventory is exactly how the project skill went missing");
  assert.match(body, /if \(targetRuntime\.settingsManager\.isProjectTrusted\(\) !== projectTrusted\)/);
  assert.match(body, /reloadRuntimeSkills\(targetRuntime\)/, "a late trust flip must re-run pi's skill pass");
});

test("the inventory scan is explicitly extension-free", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");
  const start = source.indexOf("async function discoverAllProjectSkills(");
  const end = source.indexOf("function loadedExtensionReport(", start);
  assert.ok(start !== -1 && end > start);

  assert.match(source.slice(start, end), /noExtensions: true/);
});

test("a capability change refreshes the live policy and the inventory together", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");
  const start = source.indexOf("async function refreshRuntimeCapabilityPaths(");
  const end = source.indexOf("function allowHttp429Retry(", start);
  const body = source.slice(start, end);

  assert.match(body, /replaceSkillSelectionPolicy\(current\.skillSelection, next\.skillSelection\)/);
  assert.match(body, /current\.skillInventory = next\.skillInventory/);
});