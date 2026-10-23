/**
 * Guard for the test pools.
 *
 * `npm test` runs two pools (see `scripts/run-tests.mjs`): ~2000 cases in parallel, plus a small
 * serial pool for files that spawn real processes, bind real ports or cold-start the compiler.
 * That split exists because of a measured flake, so the config has to stay honest: an entry that
 * points at a deleted file, or a heavy file that nobody added to the list, both make the pool
 * silently useless.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { REPO_ROOT, listTestFiles, readIsolation, splitPools } from "../scripts/run-tests.mjs";

const files = listTestFiles(REPO_ROOT);
const isolation = readIsolation(REPO_ROOT);

test("串行池里每个文件都真的存在（删掉测试要同步删条目）", () => {
  const onDisk = new Set(files);
  const missing = isolation.serial.filter((file) => !onDisk.has(file));
  assert.deepEqual(missing, [], `isolation.json 指向了不存在的文件：${missing.join(", ")}`);
});

test("两条池合起来 = 盘上所有测试文件，且不重叠", () => {
  const { serial, parallel } = splitPools(files, isolation);
  assert.deepEqual(
    [...serial, ...parallel].sort(),
    files,
    "池的并集必须等于全部测试文件（否则有文件根本不跑）",
  );
  const overlap = serial.filter((file) => parallel.includes(file));
  assert.deepEqual(overlap, [], "同一个文件不能同时在两条池里");
  assert.ok(parallel.length > serial.length, "串行池应当是少数派");
});

test("真正开子进程 / 冷启动编译器的测试都在串行池里", () => {
  // 这三类有实测记录（见 tests/isolation.json 的 reason）：并行池里出现过超时或 9 秒晚失败。
  const mustBeSerial = [
    "tests/bundledRuntimeSelection.test.ts", // 并行池实测 5007ms 超时
    "tests/launcherRefresh.test.ts", // 并行池实测 9237ms 才失败
    "tests/agentRuntimeEnv.test.ts", // 同类：起真桥 + 解释器探测
  ];
  const serial = new Set(isolation.serial);
  const missing = mustBeSerial.filter((file) => !serial.has(file));
  assert.deepEqual(
    missing,
    [],
    `${missing.join(", ")} 会抢 CPU：请加进 tests/isolation.json 的 serial，而不是调大超时`,
  );
});

test("串行池的条目都写了原因（否则下一个人不知道能不能删）", () => {
  const config = JSON.parse(
    readFileSync(`${REPO_ROOT}/tests/isolation.json`, "utf8"),
  );
  assert.ok(Array.isArray(config.rules) && config.rules.length > 0, "要写清楚什么情况下该进串行池");
  for (const entry of config.serial) {
    assert.ok(entry.reason && entry.reason.length > 8, `${entry.file} 缺 reason`);
  }
});

test("测试入口替代了裸 glob：package.json 指向 run-tests.mjs", () => {
  const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, "utf8"));
  assert.match(
    pkg.scripts.test,
    /scripts\/run-tests\.mjs/,
    "裸 `node --test \"tests/**/*.test.ts\"` 会让重活与 2000 个用例抢 CPU",
  );
});