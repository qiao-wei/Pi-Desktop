/**
 * `architecture:why <file>` - who depends on it, what it depends on, and which rules apply.
 *
 * Why this exists: the architecture gate says *that* a rule was broken, and the docs explain the layer
 * model, but when you are about to move a file (the B-group splits do this a lot) the question is
 * concrete: "what breaks if I move this?" Working it out by grep is slow and unreliable - `grep` misses
 * `import type`, dynamic `import()`, and re-exports, and it does not know which layer the file is in or
 * how big its ratchet ceiling is.
 *
 * This reads the same import graph the checker builds, so the answer matches the rules exactly:
 *
 *     npm run architecture:why src/lib/api.ts
 *     npm run architecture:why src/app/App.tsx --json
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildGraph, listSourceFiles, relativeTo } from "./lib/graph.mjs";
import { REPO_ROOT, loadPolicy } from "./check.mjs";

function layerOf(policy, file) {
  for (const module of policy.modules) {
    for (const root of module.roots) {
      // roots 是目录（`src/lib`）或文件（`src/main.tsx`）：目录按前缀算，文件按相等算。
      const isDirectory = !root.split("/").pop().includes(".");
      const owns = isDirectory ? file === root || file.startsWith(`${root}/`) : file === root;
      if (owns) return { module: module.id, layer: module.layer, bridgeSafe: module.bridgeSafe };
    }
  }
  return null;
}

function sizeInfo(policy, file) {
  if (!existsSync(join(REPO_ROOT, file))) return { lines: null, limit: null, exception: null };
  let limit = null;
  for (const rule of policy.sizeRules ?? []) {
    if (rule.match.endsWith("/**") ? file.startsWith(rule.match.slice(0, -2) + "/") : file === rule.match) {
      limit = rule.limit;
      break;
    }
  }
  const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n").length;
  const exception = (policy.exceptions ?? []).find((entry) => entry.rule === "max-lines" && entry.file === file);
  return { lines, limit, exception };
}

export function why(target, { asJson = false } = {}) {
  const policy = loadPolicy(REPO_ROOT);
  const files = policy.scanRoots.flatMap((root) => listSourceFiles(join(REPO_ROOT, root)));
  const graph = buildGraph(REPO_ROOT, files);
  const wanted = relative(REPO_ROOT, join(REPO_ROOT, target)).split("\\").join("/");
  const edges = graph.edges ?? [];

  const dependents = edges.filter((edge) => relativeTo(REPO_ROOT, edge.to) === wanted);
  const dependencies = edges.filter((edge) => relativeTo(REPO_ROOT, edge.from) === wanted);
  const info = layerOf(policy, wanted);
  const size = sizeInfo(policy, wanted);
  const seams = (policy.protocols ?? []).filter(
    (protocol) => protocol.contract === wanted || protocol.mirror === wanted || protocol.versionSource === wanted,
  );

  const report = {
    file: wanted,
    exists: graph.files.includes(join(REPO_ROOT, wanted)),
    module: info,
    size,
    dependents: [...new Set(dependents.map((edge) => relativeTo(REPO_ROOT, edge.from)))].sort(),
    dependencies: [...new Set(dependencies.map((edge) => relativeTo(REPO_ROOT, edge.to)))].sort(),
    typeOnlyDependents: [
      ...new Set(dependents.filter((edge) => edge.kind === "type").map((edge) => relativeTo(REPO_ROOT, edge.from))),
    ].sort(),
    protocols: seams.map((protocol) => protocol.id),
    rules: policy.rules ?? null,
  };

  if (asJson) return JSON.stringify(report, null, 2);

  const lines = [];
  lines.push(`${wanted}`);
  if (!report.exists) lines.push("  ! 不在依赖图里（不存在，或没被任何入口 import）");
  if (info) lines.push(`  层级：${info.layer} / 模块 ${info.module}${info.bridgeSafe ? "（进 bridge sidecar）" : ""}`);
  if (size.lines !== null) {
    lines.push(
      `  规模：${size.lines} 行${size.limit ? `（该目录上限 ${size.limit}${size.exception ? `，棘轮 ceiling ${size.exception.ceiling}，截止 ${size.exception.deadline}` : ""}）` : ""}`,
    );
  }
  if (seams.length) lines.push(`  协议：${seams.map((protocol) => protocol.id).join(", ")}`);
  lines.push("", `被谁依赖（改它要一起看这些，共 ${report.dependents.length}）:`);
  for (const file of report.dependents) {
    const kind = report.typeOnlyDependents.includes(file) ? " [仅类型]" : "";
    lines.push(`  ← ${file}${kind}`);
  }
  lines.push("", `它依赖什么（共 ${report.dependencies.length}）:`);
  for (const file of report.dependencies) lines.push(`  → ${file}`);
  return lines.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("why.mjs")) {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target) {
    console.log("usage: npm run architecture:why <path> [--json]");
    process.exit(1);
  }
  console.log(why(target, { asJson: args.includes("--json") }));
}