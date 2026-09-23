/**
 * The project panel (conversation sidebar) and the Global skills & packages page must offer the
 * same three operations: import a skill, install a package, and inspect a package's
 * extensions/skills/prompts/themes. They were duplicated once and drifted — the panel had no way
 * to add anything and no resource view at all.
 *
 * So this pins the *sharing*: one definition of each dialog, rendered by both hosts. If someone
 * re-implements the install form or the resource browser inside one surface, these tests fail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** Source of a top-level `function name(...) { ... }`, delimited at the next flush-left brace. */
function topLevelFunctionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = appSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return appSource.slice(start, end);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/* ------------------------------- the sharing ----------------------------- */

test("each shared dialog is defined exactly once", () => {
  for (const name of ["SkillImportDialog", "PackageInstallDialog", "PackageResourcesDialog", "CapabilityDetailDialog"]) {
    assert.equal(
      countOccurrences(appSource, `function ${name}(`),
      1,
      `${name} must exist once, not be re-implemented per surface`,
    );
  }
});

test("both surfaces render the shared dialogs instead of their own", () => {
  assert.equal(countOccurrences(appSource, "<SkillImportDialog"), 2, "Global page + project panel");
  assert.equal(countOccurrences(appSource, "<PackageInstallDialog"), 2, "Global page + project panel");
  assert.equal(countOccurrences(appSource, "<PackageResourcesDialog"), 2, "Global page + project panel");
  assert.equal(countOccurrences(appSource, "<CapabilityDetailDialog"), 2, "Global page + project panel");
});

test("the two Dialog wrappers for installing/importing are gone from the page body", () => {
  // The install form used to live inside the detail sheet; keeping a second copy would make the
  // project panel's form drift again.
  const page = topLevelFunctionSource("CapabilitiesPage");
  assert.doesNotMatch(page, /Package source/, "no inline install form left in the page");
  assert.doesNotMatch(page, /capability\.importScope\.user/, "no inline import-scope radio group left");
  assert.doesNotMatch(page, /setPackageSource\(/, "install fields moved into PackageInstallDialog");
  assert.doesNotMatch(page, /setSkillImportScope\(/, "scope lives inside SkillImportDialog");
  assert.doesNotMatch(page, /fetchJson<\{ content: string \}>/, "skill previews are read by the shared sheet");
  assert.doesNotMatch(page, /capability\.detail\.update/, "the update button lives in the shared sheet");
});

/* --------------------------- what each host asks for --------------------- */

test("the project panel receives the same skill/package entry points as the page", () => {
  const panel = topLevelFunctionSource("ProjectCapabilitiesPanel");
  assert.match(panel, /onImportSkill: \(sourcePath: string, scope\?: "user" \| "project"\) => Promise<unknown>/);
  assert.match(panel, /onInstallPackage: \(source: string, scope\?: "user" \| "project"/);
  assert.match(panel, /<SkillImportDialog path=\{skillImportPath\} onClose=\{[^}]*\} onImport=\{onImportSkill\} \/>/);
  assert.match(panel, /<PackageInstallDialog[\s\S]*?onInstall=\{onInstallPackage\}/);

  const callSite = appSource.slice(appSource.indexOf("<ProjectCapabilitiesPanel"));
  assert.match(callSite.slice(0, 600), /onImportSkill=\{importSkill\}/, "wired to the real hook action");
  assert.match(callSite.slice(0, 600), /onInstallPackage=\{installPackage\}/, "wired to the real hook action");
});

test("install defaults match the surface: project scope in the panel, user scope on the page", () => {
  const panel = topLevelFunctionSource("ProjectCapabilitiesPanel");
  assert.match(panel, /defaultScope="project"/, "the panel belongs to a project");

  const page = topLevelFunctionSource("CapabilitiesPage");
  assert.match(page, /defaultScope="user"/, "the Global page installs agent-wide by default");
});

/* ------------------------------ resource view ---------------------------- */

test("package rows in the panel open the same resource browser as the cards", () => {
  const panel = topLevelFunctionSource("ProjectCapabilitiesPanel");
  assert.match(panel, /<CapabilityResourceChips\s+compact\s+item=\{item\}\s+onOpen=\{\(pkg, type\) => setResourceRequest\(\{ item: pkg, type \}\)\}/);
  assert.match(panel, /<PackageResourcesDialog request=\{resourceRequest\} onClose=\{\(\) => setResourceRequest\(null\)\} \/>/);

  const page = topLevelFunctionSource("CapabilitiesPage");
  assert.match(page, /function openPackageResources\(item: CapabilityPackage, type: CapabilityPackageResourceType\) \{\n    setResourceRequest\(\{ item, type \}\);/);
});

test("the panel only offers resources on package rows", () => {
  const panel = topLevelFunctionSource("ProjectCapabilitiesPanel");
  const start = panel.indexOf("Same four resource types");
  assert.notEqual(start, -1, "the chips are gone from the panel");
  assert.match(
    panel.slice(start, start + 400),
    /\{item\.kind === "package" && item\.resources \? \(\s*<CapabilityResourceChips/,
    "skills have no extensions/skills/prompts/themes to show",
  );
});

test("the panel drops the empty resource types, the cards keep showing them", () => {
  const chips = topLevelFunctionSource("CapabilityResourceChips");
  assert.match(
    chips,
    /\(type\) => !compact \|\| \(item\.resources\?\.\[type\] \?\? 0\) > 0,/,
    "compact mode exists so a 330px row does not wrap four pills onto two lines",
  );
  assert.match(chips, /if \(!types\.length\) \{\n    return null;\n  \}/, "a package with no resources renders nothing");
  // The card's compact flag is the default (false), i.e. the global page still shows 0-counts.
  const page = topLevelFunctionSource("CapabilitiesPage");
  assert.doesNotMatch(page, /compact/, "the Global page keeps the full four-chip row");
});

/* --------------------------------- flash --------------------------------- */

test("the resource dialog renders nothing until list + first file are both in hand", () => {
  const dialog = topLevelFunctionSource("PackageResourcesDialog");
  assert.match(
    dialog,
    /if \(!request \|\| !loaded\) \{\n    return null;\n  \}/,
    "an open-but-empty dialog is the flash this dialog exists to avoid",
  );
  // One commit for list + content, and a read-then-swap for file clicks.
  assert.match(dialog, /const file = entries\[0\] \? await loadPackageResourceFile\(request\.item, entries\[0\]\) : null;/);
  assert.match(dialog, /const file = await loadPackageResourceFile\(request\.item, entry\);\n    setLoaded\(\(current\) => \(current \? \{ \.\.\.current, file \} : current\)\);/);
});

test("install fields get unique ids so two hosts cannot collide", () => {
  const dialog = topLevelFunctionSource("PackageInstallDialog");
  assert.match(dialog, /const id = useId\(\)/, "duplicate label/input ids would bind the wrong field");
  assert.match(dialog, /id=\{`\$\{id\}-source`\}/);
  assert.doesNotMatch(dialog, /id="capability-package-source"/);
});

/* --------------------------- progress + errors --------------------------- */

test("install progress and failures are reported inside the dialog, not on the host page", () => {
  const dialog = topLevelFunctionSource("PackageInstallDialog");
  assert.match(dialog, /await onInstall\(source\.trim\(\), scope, autoload, setProgress\)/);
  assert.match(dialog, /\{busy && progress \? <p className="text-xs break-all text-muted-foreground" role="status">\{progress\}<\/p> : null\}/);
  assert.match(dialog, /\{error \? <p className="text-sm text-destructive" role="status">\{error\}<\/p> : null\}/);
  // Closing while pi is mid-install would hide the only progress readout there is.
  assert.match(dialog, /onOpenChange=\{\(next\) => \{ if \(!next && !busy\) \{ onClose\(\); \} \}\}/);
});

test("import failures stay in the import dialog and it cannot be dismissed mid-copy", () => {
  const dialog = topLevelFunctionSource("SkillImportDialog");
  assert.match(dialog, /\{error \? <p className="text-sm text-destructive" role="status">\{error\}<\/p> : null\}/);
  assert.match(dialog, /onOpenChange=\{\(next\) => \{ if \(!next && !busy\) \{ onClose\(\); \} \}\}/);
  assert.match(dialog, /await onImport\(path, scope\)/);
  assert.match(dialog, /useState<"user" \| "project">\("project"\)/, "project is the safe default scope");
});

/* ---------------------------- click to preview --------------------------- */

test("a panel row opens the same detail sheet as a card click", () => {
  const panel = topLevelFunctionSource("ProjectCapabilitiesPanel");
  // The row itself is the target (mouse + keyboard), and the action cluster opts out.
  assert.match(panel, /onClick=\{\(\) => setSelected\(item\)\}/);
  assert.match(panel, /role="button"\n\s+tabIndex=\{0\}/);
  assert.match(panel, /className="flex shrink-0 items-center gap-0\.5 pt-0\.5" onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(panel, /<CapabilityDetailDialog\s+item=\{selected\}/);

  const page = topLevelFunctionSource("CapabilitiesPage");
  assert.match(page, /<CapabilityDetailDialog\s+item=\{selected\}/);
  // One sheet, one definition: a project skill cannot drift from the Global one.
  assert.equal(countOccurrences(appSource, "<CapabilityDetailDialog"), 2);
});

test("the sheet reads the skill body itself, so both surfaces get it for free", () => {
  const sheet = topLevelFunctionSource("CapabilityDetailDialog");
  assert.match(sheet, /fetchJson<\{ content: string \}>\(`\/api\/skills\/content\?path=\$\{encodeURIComponent\(skillPath\)\}`\)/);
  assert.match(sheet, /const skillPath = item\.kind === "skill" \? item\.path : "";/);
  assert.match(sheet, /\{skillContent \? <MarkdownContent text=\{skillContent\} \/> : null\}/);
  // Failures must land inside the modal: the host's strip is behind it.
  assert.match(sheet, /\{actionError \? <p className="text-sm text-destructive" role="status">\{actionError\}<\/p> : null\}/);
  // A new update starts from a clean progress line, not the previous run's last message.
  assert.match(sheet, /setUpdateProgress\(""\);/);
});

test("the panel can run every action the sheet offers", () => {
  const panel = topLevelFunctionSource("ProjectCapabilitiesPanel");
  for (const prop of ["onSetDefault", "onSetPinned", "onDelete", "onUpdatePackage"]) {
    assert.match(panel, new RegExp(`${prop}=\\{`), `${prop} must be handed to the sheet`);
  }

  const callSite = appSource.slice(appSource.indexOf("<ProjectCapabilitiesPanel"));
  const props = callSite.slice(0, 700);
  assert.match(props, /onSetPinned=\{setCapabilityPinned\}/, "pin is wired to the shared handler");
  assert.match(props, /onUpdatePackage=\{updatePackage\}/, "update is wired to the shared handler");
});

/* --------------------------- folding + headers --------------------------- */

test("each section folds on its own, and the fold survives a restart", () => {
  const section = topLevelFunctionSource("CapabilityPanelSection");
  assert.match(section, /aria-expanded=\{!collapsed\}/, "the label is the disclosure trigger");
  assert.match(section, /\{collapsed \? null : <div className="grid gap-0\.5 pt-0\.5">\{children\}<\/div>\}/);
  assert.match(section, /<span className="shrink-0 tabular-nums opacity-60">\{count\}<\/span>/, "a folded section still shows how much is inside");

  const panel = topLevelFunctionSource("ProjectCapabilitiesPanel");
  assert.match(panel, /function toggleSection\(section: CapabilitySectionId\)/);
  assert.match(panel, /saveUiPreferences\(\{ capabilityPanelCollapsedSections: next \}\)/);
  assert.match(panel, /useState<CapabilitySectionId\[\]>\(\s*\(\) => \(loadUiPreferences\(\)\.capabilityPanelCollapsedSections \?\? \[\]\) as CapabilitySectionId\[\],/);
  // Two independent sections, keyed by id.
  assert.match(panel, /renderSection\("skills", t\("capability\.section\.skills"\)/);
  assert.match(panel, /renderSection\("packages", t\("capability\.section\.packages"\)/);

  const prefs = readFileSync(new URL("../src/lib/ui-preferences.ts", import.meta.url), "utf8");
  assert.match(prefs, /capabilityPanelCollapsedSections\?: string\[\]/, "persisted like the settings page's provider groups");
  assert.match(prefs, /缺省 = 两个都展开/);
});

test("the panel header uses one compact icon button, not a labelled toolbar button", () => {
  const panel = topLevelFunctionSource("ProjectCapabilitiesPanel");
  for (const label of ["capability.market.importSkill", "capability.market.installPackage"]) {
    assert.match(panel, new RegExp(label.replace(/\./g, "\\.")), `${label} action missing from the panel`);
  }
  assert.doesNotMatch(panel, /variant="outline"/, "the big outline buttons were what looked wrong in a narrow panel");
  assert.match(panel, /variant="ghost"\s+\n?\s*size="icon-sm"/);
  assert.match(panel, /aria-label=\{t\("capability\.market\.installPackage"\)\}/, "icon-only needs a name");
});