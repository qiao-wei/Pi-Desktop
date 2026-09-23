/**
 * Deleting a skill / package from the Global skills & packages page.
 *
 * Two contracts are pinned here:
 * 1. `canDeleteCapability` — what may be removed at all (app-bundled skills are
 *    read-only; packages always are removable). Tested as data.
 * 2. App.tsx wiring — the card and the detail sheet only *request* a delete, and
 *    the destructive call happens after the user confirms in the dialog.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canDeleteCapability } from "../src/shared/capabilityScope.ts";
import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";
import { setLocale, t } from "../src/i18n/index.ts";

/* ------------------------------ eligibility ------------------------------ */

test("packages are always removable", () => {
  assert.equal(canDeleteCapability({ kind: "package", scope: "user" }), true);
  assert.equal(canDeleteCapability({ kind: "package", scope: "project" }), true);
});

test("skills are removable unless they are app-bundled", () => {
  assert.equal(canDeleteCapability({ kind: "skill", source: "agent", readonly: false }), true);
  assert.equal(canDeleteCapability({ kind: "skill", source: "project", readonly: false }), true);
  assert.equal(canDeleteCapability({ kind: "skill", source: "builtin", readonly: true }), false);
  // A stale snapshot without the flag must stay deletable, not silently lock up.
  assert.equal(canDeleteCapability({ kind: "skill", source: "agent" }), true);
});

test("extensions follow the same read-only flag", () => {
  assert.equal(canDeleteCapability({ kind: "extension", readonly: false }), true);
  assert.equal(canDeleteCapability({ kind: "extension", readonly: true }), false);
});

test("kinds without a removal path are never deletable", () => {
  assert.equal(canDeleteCapability({ kind: "mcp" }), false);
  assert.equal(canDeleteCapability({ kind: "" }), false);
});

/* -------------------------------- wiring --------------------------------- */

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

test("the card list, the detail sheet and the context panel share one eligibility rule", () => {
  const card = functionBody(appSource, "function CapabilityMarketCard");
  const actions = functionBody(appSource, "function CapabilityActions");
  const panel = functionBody(appSource, "function ProjectCapabilitiesPanel");

  assert.match(card, /\{canDeleteCapability\(item\) \? \(/);
  assert.match(card, /onClick=\{\(\) => onDelete\(item\)\}/);
  // The old inline rule is gone: one helper decides for every surface.
  assert.doesNotMatch(actions, /item\.kind === "package" \|\| !item\.readonly/);
  assert.match(actions, /\{canDeleteCapability\(item\) \? \(/);
  assert.match(panel, /\{canDeleteCapability\(item\) \? \(/);
  assert.match(panel, /onClick=\{\(\) => setPendingDelete\(item\)\}/);
});

test("the page only requests a delete; the call runs on confirm", () => {
  const page = functionBody(appSource, "function CapabilitiesPage");

  // Both surfaces are wired to the request handler, never straight to the bridge.
  assert.match(page, /onDelete=\{requestDelete\}/);
  assert.doesNotMatch(page, /onDelete=\{\(?target\)? => run\("delete"/);

  const request = functionBody(page, "function requestDelete");
  assert.match(request, /setPendingDelete\(item\)/);
  assert.doesNotMatch(request, /onDelete\(/);

  const confirm = functionBody(page, "function confirmDelete");
  assert.match(confirm, /await onDelete\(item\)/);
  assert.match(confirm, /setPendingDelete\(null\)/);
});

test("the context panel follows the same request/confirm split", () => {
  const panel = functionBody(appSource, "function ProjectCapabilitiesPanel");

  const request = functionBody(panel, "function ProjectCapabilitiesPanel");
  assert.match(request, /onClick=\{\(\) => setPendingDelete\(item\)\}/);
  assert.doesNotMatch(request, /onClick=\{\(\) => onDelete\(/);

  const confirm = functionBody(panel, "async function confirmDelete");
  assert.match(confirm, /await onDelete\(item\)/);
  assert.match(confirm, /setPendingDelete\(null\)/);
  assert.match(confirm, /catch \(nextError\)/);
});

test("App hands the panel and the page one shared removal handler", () => {
  // Two call sites (page + panel) must use the single dispatcher, not each other's callbacks.
  assert.equal((appSource.match(/onDelete=\{deleteCapabilityItem\}/g) ?? []).length, 2);

  const handlerStart = appSource.indexOf("const deleteCapabilityItem = useCallback(");
  assert.notEqual(handlerStart, -1, "App must define one shared removal dispatcher");
  const handler = appSource.slice(handlerStart, appSource.indexOf("[deleteSkill, removePackage]", handlerStart));
  assert.match(handler, /deleteSkill\(item\.id\)/);
  assert.match(handler, /removePackage\(item\.source, item\.scope\)/);
});

test("one shared prompt confirms every destructive removal", () => {
  const prompt = functionBody(appSource, "function CapabilityDeleteDialog");

  assert.match(prompt, /<AlertDialog[\s\S]*?open=\{Boolean\(item\)\}/);
  assert.match(prompt, /<AlertDialogCancel disabled=\{busy\}>\{t\("common\.cancel"\)\}<\/AlertDialogCancel>/);
  assert.match(
    prompt,
    /<AlertDialogAction variant="destructive"[\s\S]*?onClick=\{onConfirm\}>[\s\S]*?capability\.delete\.confirm/,
  );
  assert.match(prompt, /capability\.delete\.description[\s\S]*?name: item\?\.name \?\? ""/);

  // Both surfaces render that one prompt.
  assert.equal((appSource.match(/<CapabilityDeleteDialog/g) ?? []).length, 2);
});

test("the prompt shows a deleting state and cannot be dismissed while the call runs", () => {
  const prompt = functionBody(appSource, "function CapabilityDeleteDialog");

  // npm uninstall can take tens of seconds, and the remove endpoint streams no progress:
  // the prompt itself is the only place that can say "still working".
  assert.match(prompt, /busy\?: boolean/);
  assert.match(prompt, /if \(!next && !busy\)/);
  assert.match(prompt, /role="status"/);
  assert.match(prompt, /capability\.delete\.deleting/);
  assert.match(prompt, /<AlertDialogCancel disabled=\{busy\}>/);
  assert.match(prompt, /disabled=\{busy\} onClick=\{onConfirm\}/);

  // Both surfaces hand the in-flight flag to that one prompt.
  assert.equal((appSource.match(/busy=\{busy === "delete"\}/g) ?? []).length, 2);

  // The delete is awaited *before* the item is cleared. Clearing first would unmount the
  // prompt immediately, which is exactly the silent gap this guards against.
  const page = functionBody(appSource, "function CapabilitiesPage");
  const pageConfirm = functionBody(page, "function confirmDelete");
  assert.ok(
    pageConfirm.indexOf("await onDelete(item)") < pageConfirm.indexOf("setPendingDelete(null)"),
    "page: the prompt must outlive the delete call",
  );

  const panel = functionBody(appSource, "function ProjectCapabilitiesPanel");
  const panelConfirm = functionBody(panel, "async function confirmDelete");
  assert.ok(
    panelConfirm.indexOf("await onDelete(item)") < panelConfirm.indexOf("setPendingDelete(null)"),
    "context panel: the prompt must outlive the delete call",
  );
});

/* --------------------------------- layout -------------------------------- */

// The card header carried 32px buttons with 12px gaps, so four actions read as
// four separate islands. 28px buttons in a 4px row keep them one cluster.

test("capability action clusters stay compact", () => {
  const card = functionBody(appSource, "function CapabilityMarketCard");
  const panel = functionBody(appSource, "function ProjectCapabilitiesPanel");

  assert.match(card, /className="flex items-center gap-1" onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  // 2026-09-20: the row's action cluster is now top-aligned (the chips made the left column
  // taller than one line) and opts out of the row's own click (which opens the detail sheet),
  // while keeping the same compact 28px controls.
  assert.match(
    panel,
    /<div className="flex shrink-0 items-center gap-0\.5 pt-0\.5" onClick=\{\(event\) => event\.stopPropagation\(\)\}>/,
  );
  assert.equal(
    (card.match(/size="icon-sm"\n\s+className="size-7"/g) ?? []).length,
    3,
    "gear / delete / pin share the compact 28px size",
  );
});

/* --------------------------------- copy ---------------------------------- */

test("delete copy exists in both packs and names the capability", () => {
  for (const key of [
    "capability.delete.skillTitle",
    "capability.delete.packageTitle",
    "capability.delete.description",
    "capability.delete.confirm",
    "capability.delete.deleting",
  ]) {
    assert.ok(key in zh, `中文包缺 key: ${key}`);
    assert.ok(key in en, `英文包缺 key: ${key}`);
  }

  setLocale("zh");
  assert.equal(t("capability.delete.deleting"), "删除中…");
  setLocale("en");
  assert.equal(t("capability.delete.deleting"), "Deleting…");
  setLocale("zh");
  assert.equal(t("capability.delete.description", { name: "bailian-cli" }),
    "确定删除「bailian-cli」吗？这会从磁盘移除它的文件，无法撤销。");
  setLocale("en");
  assert.equal(t("capability.delete.description", { name: "bailian-cli" }),
    "Delete “bailian-cli”? This removes its files from disk and cannot be undone.");
  setLocale("zh");
});

function functionBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} not found`);
  // Skip the parameter list first: `function f({ a = 1 }: X) {` would otherwise
  // make the first `{` the destructured parameters and cut the body in half.
  let parenDepth = 0;
  let i = start + marker.length;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "{" && parenDepth === 0) break;
  }
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${marker}: unbalanced braces`);
}