/**
 * 打包工作流的测试门必须是硬的。
 *
 * 背景：`package-electron.yml` 原来有一个 `run_tests` 布尔输入（默认 true），`verify` 作业靠
 * `if: ${{ inputs.run_tests }}` 决定跑不跑，出包作业再把 `skipped` 当成功 —— 也就是说**可以出一份
 * 没跑过测试的安装包**。打包恰恰是最不该跳过测试的一步（它把 src/server/shared 三个运行时分别
 * 打包、还要重建原生模块），所以这里把它钉死：没有开关，出包必须等测试成功。
 *
 * 这是结构性断言（读 workflow 文本），因为这一层没有可执行的 CI 环境；对应的**行为**由
 * `npm test` 本身覆盖（同一个 workflow 跑的就是它）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/package-electron.yml"), "utf8");

test("没有「跳过测试」的输入项", () => {
  // 先剔掉 YAML 注释：说明「曾经有过这个开关」的注释不算开关（不然这条断言会被自己的注释绊倒）。
  const live = workflow
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.ok(!/run_tests:/.test(live), "不应该再有 run_tests 输入：它是「出一份没测过的包」的开关");
  assert.ok(!/inputs\.run_tests/.test(live), "不应该再有任何引用 run_tests 的条件");
});

test("verify 作业无条件跑（不再靠输入决定）", () => {
  const verify = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("  package:"));
  assert.match(verify, /name: 测试（npm test）/);
  assert.ok(!/\n    if:/.test(verify), `verify 不该带 if 条件：\n${verify}`);
  assert.match(verify, /- run: npm test/, "verify 必须真的跑 npm test");
});

test("出包作业要求测试成功（skipped 不再算通过）", () => {
  const packageJob = workflow.slice(workflow.indexOf("  package:"));
  const condition = packageJob.slice(packageJob.indexOf("if: ${{"), packageJob.indexOf("runs-on:"));
  assert.match(condition, /needs\.verify\.result == 'success'/);
  assert.ok(
    !/needs\.verify\.result == 'skipped'/.test(condition),
    "skipped 不能被当成通过，否则跳过测试仍能出包",
  );
});