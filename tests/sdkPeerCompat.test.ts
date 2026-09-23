/**
 * 宿主 SDK 与 pi-subagents 之间的最小兼容契约（只看包清单和导出，不起 runner）。
 *
 * 背景：pi-subagents 的 watchdog（`src/watchdog/review.js`、`src/watchdog/permission-arbiter.js`）
 * 在模块顶层从 `@earendil-works/pi-ai` 具名导入 `createInitialSystemMessage` / `toToolDeclaration`。
 * 这两个符号来自 `utils/transcript.js`，**pi-ai 0.86.1 才出现**：
 *
 *   - 0.84.2（Pi Desktop 早先钉的版本）整个包里连这个文件都没有 → detached runner 一起步就是
 *     `SyntaxError: The requested module '@earendil-works/pi-ai' does not provide an export named
 *     'createInitialSystemMessage'`，run 直接 failed（2026-09-22 实测）。
 *   - 该 import 是静态的、由 `src/extension/index.js` 拉进来，所以它**无条件**决定 background
 *     subagent 能不能跑，跟用不用 watchdog 无关。
 *
 * 另外这四个包是 lockstep 发布的（0.87.0 的 pi-coding-agent 依赖 `^0.87.0` 的 pi-ai / pi-tui /
 * pi-agent-core / chord），只升一半会出现两套 pi-ai（别名指向宿主 nested 那份），比版本旧更难查。
 *
 * 这个文件把这两条前提钉住：谁把版本降回去 / 只升一半，这里立刻红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as piAi from "@earendil-works/pi-ai";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

/** lockstep 的四个包：版本必须一起动。 */
const LOCKSTEP = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;

/** pi-subagents 的 watchdog 真正依赖的最早版本（`utils/transcript.js` 的起点）。 */
const MIN_PI_AI = [0, 86, 1] as const;

const parseVersion = (text: string): number[] =>
  text
    .replace(/^[\^~>=<\s]+/, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number(part));

/** `a >= b`（只比数字段，够用：不涉及预发布号）。 */
const atLeast = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return true;
};

const installedVersion = (pkg: string): string =>
  JSON.parse(readFileSync(join(repoRoot, "node_modules", pkg, "package.json"), "utf8")).version as string;

test("四个 @earendil-works 包在清单里同版本（lockstep 发布，不许只升一半）", () => {
  const declared = LOCKSTEP.map((pkg) => {
    const range = manifest.dependencies[pkg];
    assert.ok(range, `${pkg} 必须出现在 package.json 的 dependencies 里`);
    return { pkg, version: range.replace(/^[\^~]/, "") };
  });

  const first = declared[0];
  for (const entry of declared) {
    assert.equal(entry.version, first.version, `${entry.pkg}@${entry.version} 与 ${first.pkg}@${first.version} 不一致`);
  }

  const installed = LOCKSTEP.map((pkg) => ({ pkg, version: installedVersion(pkg) }));
  for (const entry of installed) {
    assert.equal(entry.version, first.version, `已装的 ${entry.pkg}@${entry.version} 与清单里的 ${first.version} 不一致（改完要 npm install）`);
  }
});

test("已装的 pi-ai 不早于 watchdog 需要的那版（≥ 0.86.1）", () => {
  const version = installedVersion("@earendil-works/pi-ai");
  assert.ok(
    atLeast(parseVersion(version), MIN_PI_AI),
    `pi-ai ${version} 早于 ${MIN_PI_AI.join(".")}：pi-subagents 的 watchdog 顶层 import 会直接让 runner 崩`,
  );
});

test("pi-ai 真的导出 pi-subagents 顶层导入的那两个 transcript 符号", () => {
  const exports = piAi as Record<string, unknown>;
  for (const name of ["createInitialSystemMessage", "toToolDeclaration"]) {
    assert.equal(typeof exports[name], "function", `pi-ai 缺少 ${name}：pi-subagents 的 runner 会以 SyntaxError 起不来`);
  }
});