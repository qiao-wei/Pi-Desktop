/**
 * Upstream admission gate: the kernel surface we depend on is frozen, and drift is red.
 *
 * This runs inside `npm test` (not only in CI), because the failure it catches - a renamed export or a
 * changed signature in the pi kernel - would otherwise surface as a runtime `undefined` deep inside a
 * request handler. The negative cases at the end feed the comparison function synthetic snapshots, so the
 * gate itself is tested (a checker that cannot fail is not a checker).
 *
 * Scope, stated honestly: this covers names, kinds and arity, plus the two non-public deep imports. It
 * does **not** describe arbitrary field usage on kernel objects (that would need type analysis of the
 * bridge's 8.7k lines) - `arity` is the cheap tripwire that catches "a parameter was added".
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SNAPSHOT_PATH,
  buildSnapshot,
  compareSnapshots,
} from "../scripts/architecture/upstream-admission.mjs";

test("内核表面与准入快照一致（改名/改签名/丢导出都会红）", async () => {
  const recorded = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const fresh = await buildSnapshot();
  const { problems, additions } = compareSnapshots(recorded, fresh);
  assert.deepEqual(problems, [], `上游表面发生了不兼容变化：${problems.join("; ")}`);
  assert.deepEqual(additions, [], `出现未准入的上游表面（读一遍上游改动再跑 npm run upstream:write）：${additions.join(", ")}`);
  assert.equal(recorded.exports.length, 21, "跟踪的导出数量变了：要么补进 TRACKED_EXPORTS，要么说明为什么少了");
});

test("两个非公共深引在快照里被记下来（它们没有类型保护）", async () => {
  const fresh = await buildSnapshot();
  const paths = fresh.deepImports.map((entry) => entry.specifier);
  assert.ok(paths.some((path) => path.includes("project-trust.js")), "resolveProjectTrusted 的深引必须被跟踪");
  assert.ok(paths.some((path) => path.includes("trust-manager.js")), "hasTrustRequiringProjectResources 的深引必须被跟踪");
  for (const entry of fresh.deepImports) {
    assert.equal(entry.ok, true, `${entry.specifier} 现在导入不了：${entry.error ?? ""}`);
    assert.ok(entry.symbols.length > 0, `${entry.specifier} 里没有导出任何符号？`);
  }
});

test("闸门本身会失败：删掉一个导出 → red", async () => {
  const recorded = await buildSnapshot();
  const fresh = { ...recorded, exports: recorded.exports.filter((entry) => entry.name !== "initTheme") };
  const { problems } = compareSnapshots(recorded, fresh);
  assert.ok(problems.some((problem) => problem.includes("initTheme disappeared")), problems.join("; "));
});

test("闸门本身会失败：arity 变了 → red（「加了参数」这类漂移）", async () => {
  const recorded = await buildSnapshot();
  const fresh = {
    ...recorded,
    exports: recorded.exports.map((entry) =>
      entry.name === "resolveProjectTrusted" ? { ...entry, arity: (entry.arity ?? 0) + 1 } : entry,
    ),
  };
  const { problems } = compareSnapshots(recorded, fresh);
  assert.ok(problems.some((problem) => problem.includes("resolveProjectTrusted changed arity")), problems.join("; "));
});

test("闸门本身会失败：新出现未准入的导出 → red（提示人工准入）", async () => {
  const recorded = await buildSnapshot();
  const fresh = { ...recorded, exports: [...recorded.exports, { name: "someBrandNewApi", kind: "function", arity: 0 }] };
  const { additions } = compareSnapshots(recorded, fresh);
  assert.deepEqual(additions, ["someBrandNewApi"]);
});

test("深引退化 → red（符号没了 / 整条深引不再被跟踪）", async () => {
  const recorded = await buildSnapshot();
  const shrunk = {
    ...recorded,
    deepImports: [
      { specifier: "../node_modules/@earendil-works/pi-coding-agent/dist/core/project-trust.js", ok: true, symbols: [] },
    ],
  };
  const { problems } = compareSnapshots(recorded, shrunk);
  assert.ok(problems.some((problem) => problem.includes("no longer exports")), problems.join("; "));
  // 这条是负例测试逼出来的真实补丁：原来只遍历 fresh 的深引清单，于是「某条深引被删掉」
  // （跟踪范围悄悄变小）不会被发现。
  assert.ok(
    problems.some((problem) => problem.includes("trust-manager.js is no longer tracked")),
    problems.join("; "),
  );
});

test("深引符号多了 → 需要人工准入（不是自动通过）", async () => {
  const recorded = await buildSnapshot();
  const grown = {
    ...recorded,
    deepImports: recorded.deepImports.map((entry) => ({ ...entry, symbols: [...entry.symbols, "brandNewHelper"] })),
  };
  const { additions } = compareSnapshots(recorded, grown);
  assert.ok(additions.some((addition) => addition.includes("brandNewHelper")), additions.join(", "));
});