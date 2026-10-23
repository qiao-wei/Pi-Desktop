/**
 * lint 门禁本身的自检（E1，2026-10-23 加入 oxlint）。
 *
 * 三件事要钉住：
 * 1. `.oxlintrc.json` **由 `architecture/policy.json` 生成**，不许手改 —— 行数上限只有一个真源，
 *    否则改一处忘一处，`max-lines` 会静默失效（这正是 ZCode 的 .oxlintrc 与 policy 两份手抄的毛病）。
 * 2. 覆盖顺序：越具体的模式必须排在越后面（`src/**` 不许盖掉 `src/i18n/zh.ts: 1400`）——
 *    架构检查器的 `sizeLimit()` 取"最具体"，oxlint 取"最后一条"，两边要能对上。
 * 3. `npm run lint` 真的跑得通、退出码 0（warning 允许，error 不许），且 CI 里在测试之前跑。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CONFIG_PATH, buildConfig, renderConfig } from "../scripts/architecture/lint-config.mjs";
import { loadPolicy } from "../scripts/architecture/check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const policy = loadPolicy(ROOT);
const configText = readFileSync(join(ROOT, CONFIG_PATH), "utf8");
const config = JSON.parse(configText);

/** 整体移除注释，免得自己的说明文字被当成要检查的代码（踩过的坑）。 */
function stripComments(text: string): string {
  return text.replace(/^\s*#.*$/gm, "");
}

test(".oxlintrc.json 与 architecture/policy.json 一致（不许手改）", () => {
  assert.equal(
    configText,
    renderConfig(policy),
    `跑 \`npm run architecture:write\` 或 \`npm run lint:config\` 重新生成 ${CONFIG_PATH}`,
  );
});

test("每个 max-lines 棘轮例外在 oxlint 里有同样的上限", () => {
  const overrides = buildConfig(policy).overrides;
  const exceptions = policy.exceptions.filter((entry) => entry.rule === "max-lines");
  assert.ok(exceptions.length > 0, "至少应有存量债务例外，否则棘轮机制没在跑");
  for (const entry of exceptions) {
    const override = [...overrides].reverse().find((item) => item.files.includes(entry.file));
    assert.ok(override, `${entry.file} 必须有 max-lines override`);
    assert.deepEqual(
      override.rules["max-lines"],
      ["error", { max: entry.ceiling }],
      `${entry.file} 的 oxlint 上限必须等于棘轮 ceiling ${entry.ceiling}`,
    );
  }
});

test("具体模式排在泛模式之后（src/i18n 的 1400 不许被 src/** 的 700 盖掉）", () => {
  const files = config.overrides.map((override) => override.files[0]);
  const i18nIndex = files.indexOf("src/i18n/zh.ts");
  const srcIndex = files.indexOf("src/**");
  assert.ok(i18nIndex >= 0 && srcIndex >= 0, "两条规则都应在配置里");
  assert.ok(i18nIndex > srcIndex, "越具体的 override 必须越靠后（oxlint 取最后一条匹配）");
  const i18nOverride = config.overrides[i18nIndex];
  assert.deepEqual(i18nOverride.rules["max-lines"], ["error", { max: 1400 }]);
});

test("测试文件豁免 max-lines，但 correctness 规则仍是 error", () => {
  const testOverride = config.overrides.find((override) => override.files.includes("**/*.test.ts"));
  assert.equal(testOverride?.rules["max-lines"], "off");
  assert.equal(config.categories.correctness, "error");
  assert.equal(config.rules["react/rules-of-hooks"], "error", "拆出来的顺序 hook 靠这条守");
});

test("npm run lint 跑得通且没有 error（warning 允许）", () => {
  const result = spawnSync("npm", ["run", "lint", "--silent"], { cwd: ROOT, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, `oxlint 退出码 ${result.status}：\n${output}`);
  assert.doesNotMatch(output, /\berror\b/, `lint 不该有 error 级诊断：\n${output}`);
});

test("CI 在跑测试之前先跑 lint", () => {
  const workflow = stripComments(
    readFileSync(join(ROOT, ".github/workflows/package-electron.yml"), "utf8"),
  );
  const lintAt = workflow.indexOf("run: npm run lint");
  const testAt = workflow.indexOf("run: npm test");
  assert.ok(lintAt >= 0, "打包工作流必须先跑 lint（新代码进不了没检查过的包）");
  assert.ok(testAt >= 0, "工作流仍要跑测试");
  assert.ok(lintAt < testAt, "lint 应排在测试之前：便宜的先跑");
});
