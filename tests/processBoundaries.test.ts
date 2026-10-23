/**
 * Guards for `process-boundary`.
 *
 * The rule exists because "which tsconfig covers which process" used to be folklore: the renderer
 * was checked, and `server/` + `src-electron/` + `scripts/` were checked by nothing at all. Now
 * every scanned source root must be claimed by a boundary, and the config that boundary names must
 * actually include the files under that root - so a new directory (a second host, a scheduler, a
 * CLI) cannot be added without deciding who typechecks it.
 *
 * Also pinned here: `matchGlob` must treat `**` as "zero or more segments". The first version did
 * not, so `server/**\/*.mjs` failed to match `server/agentEnv.mjs` and the rule reported 61 false
 * positives - a checker that cries wolf gets switched off, which is worse than no checker.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  checkProcessBoundaries,
  readConfigInclude,
} from "../scripts/architecture/lib/boundaries.mjs";
import { REPO_ROOT, loadPolicy, matchGlob, runCheck } from "../scripts/architecture/check.mjs";

const policy = loadPolicy(REPO_ROOT);

test("matchGlob：`**` 消耗零段或多段，`*` 不跨目录", () => {
  assert.equal(matchGlob("server/**/*.mjs", "server/x.mjs"), true, "`**` 必须能匹配零段");
  assert.equal(matchGlob("server/**/*.mjs", "server/deep/x.mjs"), true);
  assert.equal(matchGlob("server/**/*.mjs", "server/x.js"), false);
  assert.equal(matchGlob("src/**", "src/app/App.tsx"), true);
  assert.equal(matchGlob("**/*.test.ts", "a.test.ts"), true, "开头 `**` 也要能匹配零段");
  assert.equal(matchGlob("src/*", "src/app/App.tsx"), false, "`*` 不跨目录");
});

test("每个被扫描的源码根都有边界认领（新目录不能悄悄不被检查）", () => {
  const claimed = new Set(
    (policy.processBoundaries ?? []).flatMap((boundary) =>
      (Array.isArray(boundary.root) ? boundary.root : [boundary.root]).map((entry) =>
        entry.replace(/\/$/, ""),
      ),
    ),
  );
  const unclaimed = (policy.scanRoots ?? []).filter((root) => !claimed.has(root));
  assert.deepEqual(unclaimed, [], `这些源码根没有边界：${unclaimed.join(", ")}`);
});

test("边界指名的 tsconfig 真的存在，且 include 覆盖该根下所有源码", () => {
  const result = runCheck();
  const violations = result.violations.filter((item) => item.rule === "process-boundary");
  assert.deepEqual(violations.map((item) => item.message), []);
  for (const boundary of policy.processBoundaries.filter((entry) => entry.checked !== false)) {
    assert.ok(readConfigInclude(REPO_ROOT, boundary.config), `${boundary.config} 必须存在`);
  }
});

test("不检查的边界必须写明谁检查（Rust 走 cargo，不是没人管）", () => {
  const unchecked = policy.processBoundaries.filter((entry) => entry.checked === false);
  assert.ok(unchecked.length > 0, "src-tauri/src 应当显式登记为『不归 tsc 管』");
  for (const boundary of unchecked) {
    assert.ok(boundary.why && boundary.why.length > 8, `${boundary.id} 要写 why`);
  }
  assert.ok(
    unchecked.some((entry) => (Array.isArray(entry.root) ? entry.root : [entry.root]).some((r) => r.includes("src-tauri"))),
    "Rust 侧必须有个说法",
  );
});

test("反例：边界指了不存在的 config、或漏了某个根 → 必须报违规", () => {
  const violation = (rule, message) => ({ rule, message });
  const base = {
    processBoundaries: [
      { id: "renderer", root: ["src"], config: "tsconfig.json", checked: true },
      { id: "node-runtime", root: ["server"], config: "tsconfig.node-runtime.json", checked: true },
    ],
    scanRoots: ["src", "server"],
  };
  const helpers = {
    root: REPO_ROOT,
    violation,
    matchGlob,
    listSourceFiles: () => [],
    relativeTo: (_root, file) => file,
  };

  // ① config 不存在
  const bogus = structuredClone(base);
  bogus.processBoundaries[1].config = "tsconfig.nope.json";
  assert.equal(
    checkProcessBoundaries(bogus, helpers).filter((v) => /does not exist/.test(v.message)).length,
    1,
  );

  // ② 被扫描的根没人认领
  const orphan = structuredClone(base);
  orphan.scanRoots = ["src", "server", "src-electron"];
  assert.equal(
    checkProcessBoundaries(orphan, helpers).filter((v) => /no process boundary claims it/.test(v.message)).length,
    1,
  );

  // ③ 不检查又不说为什么
  const silent = structuredClone(base);
  silent.processBoundaries.push({ id: "rust-shell", root: ["src-tauri/src"], config: null, checked: false });
  assert.equal(
    checkProcessBoundaries(silent, helpers).filter((v) => /without a why/.test(v.message)).length,
    1,
  );

  // 正例：同一份策略必须干净
  assert.deepEqual(checkProcessBoundaries(base, helpers), []);
});