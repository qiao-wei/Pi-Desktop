/**
 * Import graph for the architecture checker.
 *
 * Uses the TypeScript parser rather than a regex because the repository writes multi-line
 * `import { ... } from "..."` statements constantly, and because the layer rules need to know
 * whether an import is **type-only** (erased at runtime, cannot create an initialisation cycle,
 * cannot smuggle a dependency across a boundary the way a value import can).
 *
 * `import type { A } from "../lib/api.ts"` is therefore recorded as kind `type`; a mixed
 * `import { type A, B }` is recorded as `runtime` (conservative: `B` is real).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".mts", ".cts"];

const DEFAULT_IGNORES = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "target",
  "gen",
  "binaries",
  ".git",
  ".scratch",
  "coverage",
  "out",
]);

export function posix(value) {
  return value.split("\\").join("/");
}

export function isTypeScriptLike(file) {
  return SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)) && !file.endsWith(".d.ts");
}

/** Recursively list candidate source files under `root`, skipping generated/installed trees. */
export function listSourceFiles(root, ignores = DEFAULT_IGNORES) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      if (ignores.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && isTypeScriptLike(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".mjs") || file.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".mjs", ".js", ".mts", ".cts"];

/** Resolve a relative specifier to a real file on disk, the way Node/Vite would. */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [];
  for (const suffix of RESOLUTION_SUFFIXES) candidates.push(`${base}${suffix}`);
  for (const suffix of RESOLUTION_SUFFIXES) {
    if (!suffix) continue;
    candidates.push(join(base, `index${suffix}`));
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Parse one file's imports/exports and return `{ specifier, kind, resolved }`.
 * `kind` is `type` only for whole-statement `import type` / `export type`.
 */
export function readImports(file) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const out = [];
  const isTypeOnlyStatement = (node) =>
    Boolean(node.importClause?.isTypeOnly) || node.isTypeOnly === true;

  const push = (specifier, kind) => {
    out.push({ specifier, kind, resolved: resolveRelative(file, specifier) });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      push(node.moduleSpecifier.text, isTypeOnlyStatement(node) ? "type" : "runtime");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      push(node.moduleSpecifier.text, isTypeOnlyStatement(node) ? "type" : "runtime");
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      push(node.arguments[0].text, "runtime");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return out.filter((entry) => entry.specifier.startsWith("."));
}

/**
 * Build the graph over the given files plus any files they resolve to inside `root`.
 * External (bare) specifiers are dropped: this graph is about *our* boundaries.
 */
export function buildGraph(root, entryFiles) {
  const files = new Map();
  const queue = [...entryFiles];
  const edges = [];

  const add = (file) => {
    if (files.has(file)) return false;
    const imports = readImports(file);
    files.set(file, imports);
    for (const entry of imports) {
      if (!entry.resolved) continue;
      if (!entry.resolved.startsWith(root)) continue;
      edges.push({
        from: file,
        to: entry.resolved,
        kind: entry.kind,
        specifier: entry.specifier,
      });
      queue.push(entry.resolved);
    }
    return true;
  };

  while (queue.length) {
    const next = queue.pop();
    add(next);
  }

  return { files: [...files.keys()], edges };
}

/** Import edges pointing *out* of the graph (into node_modules), for the closure rule. */
export function externalSpecifiers(file) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const out = new Set();
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.moduleSpecifier.text.startsWith(".")
    ) {
      out.add(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      !node.arguments[0].text.startsWith(".")
    ) {
      out.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...out];
}

export function relativeTo(root, file) {
  return posix(relative(root, file));
}