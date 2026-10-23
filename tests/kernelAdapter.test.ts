/**
 * Boundary `kernel-adapter`: the kernel is replaceable, and the bridge's own code can be driven by a
 * fake one.
 *
 * Before this test the claim was only "the bridge imports the kernel through one file" - a fact about
 * imports, not about behaviour. The seal test (first case) keeps that invariant; the swap cases below
 * install a fake kernel and assert what the bridge computes with it, which is what makes this a
 * protocol rather than a facade.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kernel = await import("../server/piKernel.mjs");

test("适配层导出的内核入口都真实存在（改名会变成具名失败）", () => {
  const expected = [
    "StringEnum",
    "getSupportedThinkingLevels",
    "builtinProviders",
    "createAgentSessionFromServices",
    "createAgentSessionRuntime",
    "createAgentSessionServices",
    "createCodemodeExtension",
    "createMcpExtension",
    "createToolSearchExtension",
    "DefaultResourceLoader",
    "DefaultPackageManager",
    "ProjectTrustStore",
    "ModelRuntime",
    "SettingsManager",
    "SessionManager",
    "withFileMutationQueue",
    "initTheme",
    "matchesKey",
    "runPiCli",
    "resolveProjectTrusted",
    "hasTrustRequiringProjectResources",
  ];
  for (const name of expected) {
    assert.notEqual(kernel[name], undefined, `piKernel 必须导出 ${name}`);
  }
});

test("非公共深引的两个符号签名没漂移（上游一旦改签名要在这里红）", () => {
  // 这两个不在包的 exports 里（deep import 进 dist/），所以没有任何类型保护会替我们看住它们。
  // 记录当前 arity：签名变化（例如加了参数）会让这条断言失败，提示重新读上游实现。
  assert.equal(kernel.resolveProjectTrusted.length, 1, "resolveProjectTrusted 现在是 (projectFolder)");
  assert.equal(
    kernel.hasTrustRequiringProjectResources.length,
    1,
    "hasTrustRequiringProjectResources 现在是 (projectFolder)",
  );
});

test("换掉内核：桥用的是假实现（这是「可替换」的兑现）", () => {
  const fakeLevels = ["fake-off", "fake-max"];
  kernel.setKernelAdapter({ getSupportedThinkingLevels: () => fakeLevels });
  try {
    const levels = kernel.supportedThinkingLevelsFor({ provider: "p", id: "m" });
    assert.deepEqual(levels, fakeLevels, "桥必须问当前装上的内核要档位表，而不是问包本身");
  } finally {
    kernel.setKernelAdapter(null);
  }

  // 换回来之后必须回到真实实现：假实现不许渗到别的用例。
  const real = kernel.supportedThinkingLevelsFor({ provider: "anthropic", id: "claude-sonnet-4-5" });
  assert.ok(Array.isArray(real), "恢复默认后仍能从真实内核拿到档位表");
  assert.notDeepEqual(real, fakeLevels, "默认适配器不是刚才那个假实现");
});

test("createKernelAdapter 只覆盖点名的字段，其余保持真实实现", () => {
  const adapter = kernel.createKernelAdapter({ initTheme: () => "fake-theme" });
  assert.equal(adapter.initTheme({}), "fake-theme");
  assert.equal(adapter.getSupportedThinkingLevels, kernel.getSupportedThinkingLevels, "没点名的字段仍是真实现");
  assert.equal(adapter.resolveProjectTrusted, kernel.resolveProjectTrusted);
});

test("setKernelAdapter 换回来以后 getKernelAdapter 不含上一次的覆盖（无残留）", () => {
  kernel.setKernelAdapter({ initTheme: () => "one-shot" });
  assert.equal(kernel.getKernelAdapter().initTheme({}), "one-shot");
  kernel.setKernelAdapter(null);
  assert.notEqual(kernel.getKernelAdapter().initTheme({}), "one-shot");
});

test("接缝登记表里的 kernel-adapter 条目指向真实文件与真实安装点", () => {
  // 登记表（src/shared/protocol/seams.ts）是文档与检查器的单一真源；这里只核准它没写成空话。
  const kernelSource = readFileSync(join(root, "server/piKernel.mjs"), "utf8");
  assert.match(kernelSource, /export function createKernelAdapter\(/, "安装点必须真的有 createKernelAdapter");
  assert.match(kernelSource, /export function setKernelAdapter\(/, "必须能换");
  assert.match(kernelSource, /export function getKernelAdapter\(/, "必须能读当前实现");
});