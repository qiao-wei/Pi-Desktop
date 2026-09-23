#!/usr/bin/env node
/**
 * 出包的唯一入口。规则和"哪些组合不可能"都在 scripts/lib/packPlan.mjs，这里只负责把计划跑出来：
 *
 *   npm run pack:tauri:mac:arm64              # bundled，Apple Silicon
 *   npm run pack:electron:mac:x64:slim        # 精简，Intel
 *   npm run pack:tauri:windows -- --cross     # 从 mac 交叉出 Windows（仅 slim）
 *
 * 为什么要一个脚本而不是 package.json 里的 && 链：
 *   - 模式（bundled/slim）现在只是一处翻译，Windows 上不再依赖 `VAR=x cmd` 这种 cmd 不认的写法；
 *   - 目标三元组统一经 PI_DESKTOP_TARGET_TRIPLE 下发，node/python/bridge 三个构建脚本读同一个值；
 *   - 不可能的组合（bundled 交叉、非 mac 上打 mac 包、universal）在跑任何东西之前就报错并给下一步；
 *   - 每个入口都是同样形状的一行，命名规则由测试守着，不会再漂。
 *
 * 步骤全部用 `node <js>` 直接调用（不经过 npm/npx），因此没有 shell 引用问题，Windows 同样成立。
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PackPlanError, buildPackPlan, parsePackArgs } from "./lib/packPlan.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolveStep(step) {
  const bin = step.pkg ? join(rootDir, "node_modules", step.pkg[0], step.pkg[1]) : join(rootDir, step.bin);
  return { label: step.label, cmd: process.execPath, args: [bin, ...step.args] };
}

function commandExists(name) {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [name], { stdio: "ignore" }).status === 0;
}

const relative = (path) => (path.startsWith(`${rootDir}/`) ? path.slice(rootDir.length + 1) : path);

function printPlan(plan) {
  console.log(`pack: ${plan.summary}`);
  if (plan.triple) {
    console.log(`pack: 目标三元组 ${plan.triple}，运行时模式 PI_DESKTOP_RUNTIME_MODE=${plan.env.PI_DESKTOP_RUNTIME_MODE}`);
  }
  if (plan.passthrough?.length) {
    console.log(`pack: 其余参数原样转交打包器：${plan.passthrough.join(" ")}`);
  }
  plan.steps.forEach((step, index) => {
    const { args } = resolveStep(step);
    const shown = args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : relative(arg))).join(" ");
    console.log(`pack:   ${index + 1}. ${step.label}`);
    console.log(`pack:      node ${shown}`);
  });
  for (const note of plan.notes) {
    console.log(`pack: 说明：${note}`);
  }
}

function main() {
  let plan;
  try {
    plan = buildPackPlan(parsePackArgs(process.argv.slice(2)), { commandExists });
  } catch (error) {
    if (!(error instanceof PackPlanError)) {
      throw error;
    }
    console.error(`pack: ${error.message}`);
    for (const hint of error.hints) {
      console.error(`pack:   → ${hint}`);
    }
    process.exit(2);
  }

  printPlan(plan);
  if (plan.dryRun) {
    console.log("pack: --dry-run：只打印，不执行。");
    return;
  }

  const env = { ...process.env, ...plan.env };
  for (const step of plan.steps) {
    const { label, cmd, args } = resolveStep(step);
    console.log(`\npack: 开始 ${label}`);
    const result = spawnSync(cmd, args, { cwd: rootDir, stdio: "inherit", env });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      console.error(`pack: ${label} 失败（退出码 ${result.status ?? "unknown"}），已中止，不会产出半成品包。`);
      process.exit(result.status ?? 1);
    }
  }
  console.log(`\npack: 完成 ${plan.summary}`);
}

main();