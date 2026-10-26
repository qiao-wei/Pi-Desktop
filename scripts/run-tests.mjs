#!/usr/bin/env node
/**
 * Test entry point: a parallel pool plus a small serial pool.
 *
 * Why a wrapper instead of a plain glob: a handful of tests really spawn processes, bind real
 * ports or cold-start the TypeScript compiler. Under `node --test "tests/**\/*.test.ts"` those run
 * next to ~2000 other cases and occasionally lose the CPU race - measured, not guessed:
 * `tests/bundledRuntimeSelection.test.ts` timed out at 5007ms inside the full run and passed in
 * 909ms on its own. Raising that test's timeout would hide the load problem and turn a genuine
 * regression into "sometimes red", so instead the heavy files run serially
 * (`--test-concurrency=1`) while everything else keeps the default parallelism.
 *
 *   node scripts/run-tests.mjs            # both pools
 *   node scripts/run-tests.mjs --pool=serial
 *   node scripts/run-tests.mjs --list     # which file lands in which pool
 *
 * The pools are declared in `tests/isolation.json` (with the reason per file), and
 * `tests/testPools.test.ts` fails if that list drifts from what is on disk.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every test file on disk, repo-relative and sorted so the command line is stable. */
export function listTestFiles(root = REPO_ROOT) {
  return readdirSync(join(root, "tests"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `tests/${name}`)
    .sort();
}

/** Read the isolation list. A missing config means "one parallel pool" rather than an error. */
export function readIsolation(root = REPO_ROOT) {
  const configPath = join(root, "tests", "isolation.json");
  if (!existsSync(configPath)) return { serial: [] };
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return { serial: (config.serial ?? []).map((entry) => entry.file) };
}

/** Split the files on disk into the two pools, preserving disk order in each. */
export function splitPools(files, isolation) {
  const serialSet = new Set(isolation.serial);
  return {
    serial: files.filter((file) => serialSet.has(file)),
    parallel: files.filter((file) => !serialSet.has(file)),
  };
}

function run(label, files, extraArgs) {
  if (!files.length) return { label, status: 0, skipped: true };
  const result = spawnSync(process.execPath, ["--test", ...extraArgs, ...files], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  return { label, status: result.status ?? 1, skipped: false };
}

function main(argv) {
  const files = listTestFiles();
  if (!files.length) {
    console.error("run-tests: no test files found under tests/");
    return 1;
  }
  const isolation = readIsolation();
  const { serial, parallel } = splitPools(files, isolation);

  if (argv.includes("--list")) {
    console.log(`serial (${serial.length}):`);
    for (const entry of isolation.serial) console.log(`  ${entry}`);
    console.log(`parallel (${parallel.length})`);
    return 0;
  }

  const pool = argv.find((arg) => arg.startsWith("--pool="))?.slice("--pool=".length);
  const results = [];
  if (!pool || pool === "parallel") {
    results.push(run("parallel", parallel, []));
  }
  if (!pool || pool === "serial") {
    results.push(run("serial", serial, ["--test-concurrency=1"]));
  }

  const failed = results.filter((result) => result.status !== 0);
  for (const result of results) {
    if (result.skipped) continue;
    console.log(`run-tests: ${result.label} pool -> ${result.status === 0 ? "ok" : "FAILED"}`);
  }
  return failed.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}