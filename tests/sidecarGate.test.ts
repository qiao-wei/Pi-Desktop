/**
 * The sidecar build gate: an assembled bridge must prove that every selected capability package
 * actually reached the session before it is allowed into a package. Without it, a compiled build's
 * symbol renaming ships an app where `pi-memory` silently fails to load, and the only symptom is a
 * user saying "I installed it and it still doesn't work".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { classifyCapabilityLoad, formatGateReport, waitForCapabilities } from "../scripts/lib/sidecarGate.mjs";
import { buildPackPlan, parsePackArgs } from "../scripts/lib/packPlan.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function pkg(source, loadStatus, { tools = [], errors = [] } = {}) {
  return { id: `user:${source}`, source, loadStatus, loadedTools: tools, loadErrors: errors };
}

test("a healthy snapshot passes and counts what loaded versus what is switched off", () => {
  const result = classifyCapabilityLoad({
    packages: [
      pkg("npm:pi-memory", "loaded", { tools: ["memory_search", "memory_write"] }),
      pkg("npm:pi-web-access", "loaded", { tools: ["web_search"] }),
      pkg("npm:pi-web-search", "disabled"),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.loaded.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(result.sawAnything, true);
});

test("a package that failed to load fails the build, with pi's raw reason kept", () => {
  const result = classifyCapabilityLoad({
    packages: [pkg("npm:pi-memory", "failed", { errors: ["Failed to load extension: Type3 is not defined"] })],
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].status, "failed");
  assert.match(formatGateReport(result), /FAILED\s+npm:pi-memory → Failed to load extension: Type3 is not defined/);
});

test("selected-but-absent and unresolved-entry are both blockers, not warnings", () => {
  const result = classifyCapabilityLoad({
    packages: [pkg("npm:a", "missing"), pkg("npm:b", "not-installed"), pkg("npm:c", "loaded", { tools: ["x"] })],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map((item) => item.source), ["npm:a", "npm:b"]);
  assert.equal(result.loaded.length, 1);
});

test("an empty package list is called out instead of silently passing", () => {
  const result = classifyCapabilityLoad({ packages: [] });

  assert.equal(result.ok, true, "nothing selected is a legitimate state");
  assert.equal(result.sawAnything, false, "but the caller must be able to notice it");
});

test("malformed snapshots are tolerated rather than crashing the gate", () => {
  assert.equal(classifyCapabilityLoad(undefined).ok, true);
  assert.equal(classifyCapabilityLoad({}).sawAnything, false);
  // A package with no status means the bridge could not tell us — that must block, not pass.
  const unknown = classifyCapabilityLoad({ packages: [{ source: "npm:x" }] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.failures[0].status, "unknown");
  assert.equal(classifyCapabilityLoad({ packages: [null] }).failures[0].id, "?");
});

test("the gate waits for a bridge that is still booting", async () => {
  const sleeps = [];
  let calls = 0;
  const result = await waitForCapabilities({
    url: "http://127.0.0.1:9/api/capabilities",
    sleep: async (ms) => { sleeps.push(ms); },
    attempts: 5,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("connect ECONNREFUSED");
      }
      return { ok: true, json: async () => ({ packages: [pkg("npm:pi-memory", "loaded")] }) };
    },
  });

  assert.equal(result.attempts, 3);
  assert.equal(sleeps.length, 2);
  assert.equal(result.payload.packages[0].loadStatus, "loaded");
});

test("the gate gives up loudly instead of hanging forever", async () => {
  await assert.rejects(
    waitForCapabilities({
      url: "http://127.0.0.1:9/api/capabilities",
      sleep: async () => {},
      attempts: 3,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /responded 503/,
  );

  await assert.rejects(
    waitForCapabilities({
      url: "http://127.0.0.1:9/api/capabilities",
      sleep: async () => {},
      attempts: 2,
      fetchImpl: async () => ({ ok: true, json: async () => ({ hello: "world" }) }),
    }),
    /no package list/,
  );
});

test("packaging runs the gate before the packager is allowed to produce an artifact", () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
  // 门禁脚本本身不再分模式：模式由出包计划经 env 下发（从前是内联 `VAR=x`，Windows 上根本跑不了）。
  assert.equal(scripts["sidecar:verify"], "node scripts/verify-sidecar-extensions.mjs");
  assert.ok(!Object.keys(scripts).some((name) => name.includes("sidecar:verify:slim")), "模式不再是脚本名的一个后缀");

  for (const host of ["electron", "tauri"]) {
    const plan = buildPackPlan(parsePackArgs(["--host", host, "--target", "mac", "--arch", "arm64"]), {
      platform: "darwin",
      arch: "arm64",
    });
    const labels = plan.steps.map((step) => step.label);
    const at = (needle) => labels.findIndex((label) => label.includes(needle));

    // findIndex 返回 -1，所以缺一步时裸的 `<` 比较会假绿。先要求都在。
    for (const needed of ["node:build", "bridge:build", "sidecar:verify"]) {
      assert.ok(at(needed) >= 0, `${host} 的打包链少了 ${needed}：${labels.join(" → ")}`);
    }
    assert.ok(at("node:build") < at("sidecar:verify"), "verify needs the bundled runtimes present");
    assert.ok(at("bridge:build") < at("sidecar:verify"), "verify must run against the assembled bridge");
    assert.equal(at("sidecar:verify"), labels.length - 2, `verify 必须紧接在打包器之前：${labels.join(" → ")}`);
    assert.ok(!labels.some((label) => label.includes("sidecar:build")), "the compiled single-file bridge must not be packaged");
  }
});

test("the runner keeps the packaged environment shape and honours the artifact under test", () => {
  const runner = readFileSync(join(ROOT, "scripts/verify-sidecar-extensions.mjs"), "utf8");

  assert.match(runner, /PI_DESKTOP_SIDECAR_BIN/, "so a build variant can be checked without moving files");
  assert.match(runner, /PI_DESKTOP_GATE_CWD/, "the app runs the bridge from the bundled skills dir; that must be reproducible");
  assert.match(runner, /PI_DESKTOP_APP_SKILLS_DIR/, "same env contract as the packaged shell");
  assert.match(runner, /freePort\(\)/, "a fixed port would collide with a running app and fake a failure");
});
