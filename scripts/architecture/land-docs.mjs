#!/usr/bin/env node
/**
 * 把 `.wiki/output/` 里的架构文档草稿落盘到 `docs/`，然后生成并校验。
 *
 * 为什么需要这一步：`docs/` 是人工拥有的权威层，带写保护（见 project-wiki 的约定），
 * agent 不能直接写。草稿放在 `.wiki/output/`，由人确认后执行本脚本落盘。
 *
 *   node scripts/architecture/land-docs.mjs          # 落盘 + 生成 + 校验
 *   node scripts/architecture/land-docs.mjs --dry    # 只打印会做什么
 *
 * 落盘清单与目标路径一一对应；`docs/` 的改动应当走 git review。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY = process.argv.includes("--dry");

const PLAN = [
  [".wiki/output/architecture.md", "docs/architecture/architecture.md"],
  [".wiki/output/protocols.md", "docs/architecture/protocols.md"],
  [
    ".wiki/output/adr-001-layered-architecture-and-protocols.md",
    "docs/adr/ADR-001-layered-architecture-and-protocols.md",
  ],
];

let missing = 0;
for (const [from, to] of PLAN) {
  const source = join(REPO_ROOT, from);
  if (!existsSync(source)) {
    console.error(`draft missing: ${from}`);
    missing += 1;
    continue;
  }
  const body = readFileSync(source, "utf8");
  const hasRegion = /architecture:begin (layers|protocols)/.test(body);
  console.log(`${DRY ? "would copy" : "copy"} ${from} -> ${to} (${body.split("\n").length} lines${hasRegion ? ", has generated regions" : ""})`);
  if (DRY) continue;
  mkdirSync(dirname(join(REPO_ROOT, to)), { recursive: true });
  copyFileSync(source, join(REPO_ROOT, to));
}

if (missing) process.exit(1);
if (DRY) process.exit(0);

// 生成区域 + 棘轮快照，然后按 CI 的口径校验一遍。
const { runCheck, writeGenerated } = await import("./check.mjs");
const before = runCheck(REPO_ROOT);
writeGenerated(before);
const after = runCheck(REPO_ROOT);

if (after.violations.length) {
  for (const item of after.violations) console.error(`[${item.rule}] ${item.message}`);
  process.exit(1);
}
console.log(
  `architecture: docs landed and pinned (${after.stats.frozenRoutes} protocol routes, boundary v${after.stats.protocolVersion.declared})`,
);