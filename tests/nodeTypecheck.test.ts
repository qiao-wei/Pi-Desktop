/**
 * Boundary guard for the non-renderer half under `checkJs`.
 *
 * Before this existed, `tsconfig.json` only included `src`, so `server/` (18k lines of `.mjs`),
 * `src-electron/` and `scripts/` had no static protection at all: a typo or a renamed kernel
 * field surfaced as `undefined` inside a request handler instead of a compile error.
 *
 * What is pinned here:
 * 1. the config that turns checking on still covers all three roots and still sets the flags it
 *    needs (`allowImportingTsExtensions` in particular - without it `server/*.mjs` importing
 *    `../src/shared/*.ts` produces nine fake TS5097 errors);
 * 2. the ratchet comparison itself: growth is a violation, shrinkage asks for `--write`, and a
 *    *missing* baseline demands zero (that is the end state, not a permanent exception file);
 * 3. the pile recorded on disk equals the pile that actually exists today.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  NODE_TYPECHECK_BASELINE,
  NODE_TYPECHECK_CONFIG,
  NODE_TYPECHECK_ROOTS,
  baselineFromDiagnostics,
  compareToBaseline,
  isCheckedFile,
  readBaseline,
} from "../scripts/architecture/lib/typecheck.mjs";
import { REPO_ROOT, runCheck } from "../scripts/architecture/check.mjs";

const config = JSON.parse(readFileSync(join(REPO_ROOT, NODE_TYPECHECK_CONFIG), "utf8"));

test("node 侧类型检查的配置覆盖三个根，且带 allowImportingTsExtensions", () => {
  assert.equal(config.compilerOptions.allowJs, true);
  assert.equal(config.compilerOptions.checkJs, true);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.equal(
    config.compilerOptions.allowImportingTsExtensions,
    true,
    "server/*.mjs 直接 import ../src/shared/*.ts：不开这项会报 9 条 TS5097 假错",
  );
  assert.equal(config.compilerOptions.maxNodeModuleJsDepth, 0, "不要检查进 node_modules");
  const include = config.include.join(" ");
  for (const root of ["server/", "src-electron/", "scripts/"]) {
    assert.ok(include.includes(root), `include 必须覆盖 ${root}`);
  }
});

test("棘轮：涨了红、降了提示收紧、没有基线就必须是 0", () => {
  const baseline = { version: 1, total: 1, byCode: { 2339: 1 }, byFile: { "server/a.mjs": { 2339: 1 } } };

  // 现状 = 基线 → 无违规
  const same = compareToBaseline([{ file: "server/a.mjs", code: 2339, line: 1, message: "m" }], baseline);
  assert.deepEqual(same.violations, []);

  // 同一文件+错误码多出一条 → 红，且消息里带可定位信息
  const grew = compareToBaseline(
    [
      { file: "server/a.mjs", code: 2339, line: 1, message: "m" },
      { file: "server/a.mjs", code: 2339, line: 9, message: "new" },
    ],
    baseline,
  );
  assert.equal(grew.violations.length, 1);
  assert.match(grew.violations[0].message, /server\/a\.mjs:9/);
  assert.match(grew.violations[0].message, /baseline of 1/);

  // 新文件里出现诊断 → 红（新代码必须干净）
  const newFile = compareToBaseline([{ file: "server/b.mjs", code: 2322, line: 3, message: "m" }], baseline);
  assert.equal(newFile.violations.length, 1);
  assert.match(newFile.violations[0].message, /server\/b\.mjs:3/);

  // 降了 → 提示跑 --write 收紧（不是静默通过）
  const shrank = compareToBaseline([], baseline);
  assert.equal(shrank.violations.length, 1);
  assert.match(shrank.violations[0].message, /architecture:write/);

  // 没有基线 → 任何诊断都是违规（终态：0 条 + 删掉基线文件）
  const noBaseline = compareToBaseline([{ file: "server/a.mjs", code: 2339, line: 1, message: "m" }], null);
  assert.equal(noBaseline.violations.length, 1);
  assert.match(noBaseline.violations[0].message, /must stay at zero/);
  assert.deepEqual(compareToBaseline([], null).violations, []);
});

test("基线记录的形状稳定（按 code / file 排序，便于 diff）", () => {
  const aggregate = baselineFromDiagnostics([
    { file: "server/b.mjs", code: 2322, line: 1, message: "" },
    { file: "server/a.mjs", code: 2339, line: 1, message: "" },
    { file: "server/a.mjs", code: 2322, line: 2, message: "" },
  ]);
  assert.deepEqual(aggregate.byCode, { 2322: 2, 2339: 1 });
  assert.deepEqual(Object.keys(aggregate.byFile), ["server/a.mjs", "server/b.mjs"]);
  assert.deepEqual(Object.keys(aggregate.byFile["server/a.mjs"]), ["2322", "2339"]);
  assert.equal(aggregate.total, 3);
});

test("盘上的基线 = 今天的实际诊断数（跟着棘轮走，不漂移）", () => {
  const result = runCheck();
  const violations = result.violations.filter((item) => item.rule === "node-typecheck");
  assert.deepEqual(
    violations.map((item) => item.message),
    [],
    "node 侧诊断既不能涨，降了也要跑 architecture:write",
  );
  const recorded = readBaseline(REPO_ROOT);
  if (recorded === null) {
    // 终态：基线文件已删，此时必须真的是 0 条
    assert.equal(result.stats.nodeDiagnostics, 0, "基线已删除，诊断必须为 0");
    return;
  }
  assert.equal(result.stats.nodeDiagnostics, recorded.total);
  assert.ok(
    readFileSync(join(REPO_ROOT, NODE_TYPECHECK_BASELINE), "utf8").includes(`"total": ${recorded.total}`),
  );
});
test("诊断过滤：repo 内非声明文件都算，node_modules 与仓外不算", () => {
  // 实测过的漏洞（2026-10-22）：只认 `NODE_TYPECHECK_ROOTS` 时，`tsc` 打印 34 条而基线记 33 条 ——
  // 被 server 间接 import 的 `src/shared/*.ts` 那条谁都看不见。门禁少算一条 = 能悄悄放过一条新错误。
  // 反过来，这个 config 只有 node 类型（无 DOM），所以 `src/**` 不许进 include；过滤必须按「是不是本仓源码」判，不是按 roots 判。
  assert.equal(isCheckedFile("server/index.mjs"), true);
  assert.equal(isCheckedFile("src/shared/sessionTitle.ts"), true, "被 roots import 的仓内源码必须计入");
  assert.equal(isCheckedFile("node_modules/foo/index.js"), false);
  assert.equal(isCheckedFile("server/node_modules/foo.js"), false, "嵌套 node_modules 也不算");
  assert.equal(isCheckedFile("src/vite-env.d.ts"), false, "声明文件不算");
  assert.equal(isCheckedFile("../outside/thing.mjs"), false, "仓外不算");
  assert.ok(NODE_TYPECHECK_ROOTS.includes("server/"), "roots 仍是 include 的口径");
});
