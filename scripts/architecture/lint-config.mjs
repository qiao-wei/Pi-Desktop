#!/usr/bin/env node
// 从 architecture/policy.json 生成 .oxlintrc.json。
//
// 为什么是"生成"而不是手写：lint 里唯一值得门禁的行数上限，必须是**同一份棘轮**的产物。
// ZCode 那边 .oxlintrc 的 max-lines 与它的策略文件是两份各自维护的东西，改一处忘一处没人发现；
// 这里 policy.sizeRules 是上限、policy.exceptions 是棘轮，oxlint 的 overrides 由它们算出来 ——
// `architecture:write` 收窄/删除例外后重新生成，两边不可能漂移。
//
// 用法：
//   node scripts/architecture/lint-config.mjs            # 写 .oxlintrc.json
//   node scripts/architecture/lint-config.mjs --check    # 只校验是否与 policy 一致（CI/测试用）
//   node scripts/architecture/lint-config.mjs --dry      # 打印到 stdout
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CONFIG_PATH = ".oxlintrc.json";

// 关掉/降级的规则都写明理由：要么是"规则假设不成立"，要么是"改它属于语义级重构，先记录数量再排队"。
export const RULE_NOTES = {
  "react/react-in-jsx-scope": "自动 JSX runtime（React 17+）：本仓库不 import React 也能写 JSX，此规则只适用于 classic runtime。",
  "react/set-state-in-effect": "React 19 编译器规则。开启会报 21 处「effect 里 setState」，去掉它们是语义级重构（有的是刻意的一次性同步），不在 lint 轮次里做。",
  "max-lines": "只有 policy.sizeRules / policy.exceptions 列出的路径才开，见 overrides（与架构检查器同一份上限）。",
  "react/refs": "React 19 规则：渲染期读 ref。20 处都是刻意的（陈旧值读取/命令式测量），改它属于语义重构，先 warn。",
  "react/exhaustive-deps": "37 处：多数是刻意的窄依赖；当信号看，不挡门禁。",
  "react/exhaustive-effect-dependencies": "27 处：同上级别，React 19 编译器规则。",
  "no-console": "server/scripts 的诊断输出与测试里的断言用途，交由人工判断。",
  "no-empty-pattern（e2e/**）": "Playwright 夹具签名要求第一个形参是解构模式（`async ({}, use) => …`），空模式就是它的 API。",
  "react/*（e2e/**）":
    "e2e 是 Playwright，不是 React：夹具回调的形参就叫 `use`（Playwright 的 API），rules-of-hooks 会把它当 React 的 use() 报假红。整个目录关掉 React 规则，其余 correctness 规则照旧。",
};

const RULES = {
  // 默认 correctness 已是 error；显式写出来是为了让它出现在配置里可被搜索到。
  "no-unused-vars": "error",
  // 刚把 App() 拆成 7 段顺序 hook —— 顺序/条件调用正是这条规则守的东西。
  "react/rules-of-hooks": "error",
  // 这三条降为 warn（不挡门禁）：是 React 19 编译器时代的规则，报出来的 84 处要么是刻意的
  // 陈旧读取，要么改起来是语义级重构。数量记在这里与 `.wiki/log.md`，先当信号不当闸门。
  "react/exhaustive-deps": "warn",
  "react/exhaustive-effect-dependencies": "warn",
  "react/refs": "warn",
  "react/react-in-jsx-scope": "off",
  "react/set-state-in-effect": "off",
  "max-lines": "off",
  "no-console": "off",
};

/** @param {{sizeRules: {match: string, limit: number}[], exceptions: {rule: string, file: string, ceiling: number}[]}} policy */
export function buildConfig(policy) {
  // e2e（Playwright）：形参 `use` 是夹具回调，不是 React 的 use() —— 不关 React 规则会假红
  // （见 RULE_NOTES）。只关 react/*，correctness 与 max-lines 照旧。
  /** @type {{files: string[], rules: Record<string, unknown>}[]} */
  const overrides = [
    {
      files: ["e2e/**"],
      rules: {
        "react/rules-of-hooks": "off",
        "react/exhaustive-deps": "off",
        "react/exhaustive-effect-dependencies": "off",
        "react/refs": "off",
        "react/react-in-jsx-scope": "off",
        // Playwright 要求夹具的第一个形参必须是解构模式（空 `{}` 就是它的写法），
        // 运行时校验，不是风格问题 —— 见 e2e/lib/fixtures.ts 的 worker 夹具。
        "no-empty-pattern": "off",
      },
    },
  ];
  // 越靠后的 override 越优先，所以必须按"具体度递增"排（最泛的在前），否则 `src/**` 会盖掉 `src/i18n/zh.ts`。
  // 判据与 check.mjs 的 sizeLimit() 一致：模式里非通配字符越多越具体。
  const specificity = (match) => match.replace(/[*?{[\]}()!+@]/g, "").length;
  for (const rule of [...policy.sizeRules].sort((a, b) => specificity(a.match) - specificity(b.match))) {
    overrides.push({
      files: [rule.match],
      rules: { "max-lines": rule.limit > 0 ? ["error", { max: rule.limit }] : "off" },
    });
  }
  for (const entry of policy.exceptions.filter((exception) => exception.rule === "max-lines").sort((a, b) => a.file.localeCompare(b.file))) {
    // 放在最后：ESLint/oxlint 里越靠后的 overrides 优先，棘轮上限必须盖住上面的通配上限。
    overrides.push({
      files: [entry.file],
      rules: { "max-lines": ["error", { max: entry.ceiling }] },
    });
  }
  return {
    $schema: "./node_modules/oxlint/configuration_schema.json",
    categories: { correctness: "error" },
    plugins: ["react"],
    rules: RULES,
    overrides,
  };
}

export function renderConfig(policy) {
  return `${JSON.stringify(buildConfig(policy), null, 2)}\n`;
}

function main(argv) {
  const policy = JSON.parse(readFileSync(join(ROOT, "architecture/policy.json"), "utf8"));
  const next = renderConfig(policy);
  if (argv.includes("--dry")) {
    process.stdout.write(next);
    return 0;
  }
  if (argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(join(ROOT, CONFIG_PATH), "utf8");
    } catch {
      console.error(`lint-config: ${CONFIG_PATH} 不存在；跑 node scripts/architecture/lint-config.mjs 生成`);
      return 1;
    }
    if (current !== next) {
      console.error(`lint-config: ${CONFIG_PATH} 与 architecture/policy.json 不一致；跑 architecture:write 或直接生成`);
      return 1;
    }
    console.log(`lint-config: ${CONFIG_PATH} 与 policy 一致`);
    return 0;
  }
  writeFileSync(join(ROOT, CONFIG_PATH), next);
  console.log(`lint-config: 写入 ${CONFIG_PATH}（${buildConfig(policy).overrides.length} 条 overrides）`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
