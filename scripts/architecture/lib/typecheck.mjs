/**
 * `node-typecheck` rule support: the non-renderer half of the app under `checkJs`.
 *
 * Why this file exists: `tsconfig.json` only includes `src`, so `server/` (18k lines of `.mjs`),
 * `src-electron/` and `scripts/` had **no** static protection at all. A rename inside the kernel
 * or a typo in a handler came out as a runtime `undefined` in a request handler instead of a
 * compile error. `tsconfig.node-runtime.json` turns the checking on; this module makes the debt
 * *countable*, because turning it on over 18k untyped lines produces a four-figure pile you
 * cannot fix in one change.
 *
 * The policy is a ratchet, same as `max-lines`: every diagnostic is recorded per file and per
 * code, and the count may only go down. Once the pile reaches zero the baseline file is deleted
 * and the rule demands zero from then on - that is the end state, not a permanent exception list.
 *
 * Deliberate choices:
 * - `strict: false` in the config, for the same reason: `strict` on untyped `.mjs` is not a
 *   useful signal yet. The ratchet counts what is on today; tightening the config is a follow-up
 *   that must come with the pile at zero.
 * - Diagnostics are filtered to the three checked roots, so a diagnostic that actually belongs to
 *   the renderer (already checked by `tsconfig.json`) is not counted twice.
 * - `maxNodeModuleJsDepth: 0`: never typecheck into `node_modules`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

/** Config that enables `checkJs` for the non-renderer half. See the module comment. */
export const NODE_TYPECHECK_CONFIG = "tsconfig.node-runtime.json";

/** Where the current pile is recorded. Deleted once it reaches zero. */
export const NODE_TYPECHECK_BASELINE = "architecture/generated/node-typecheck-baseline.json";

/** Roots the rule is responsible for; anything else is someone else's typecheck. */
export const NODE_TYPECHECK_ROOTS = ["server/", "src-electron/", "scripts/"];

function posixPath(path) {
  return path.split("\\").join("/");
}

/**
 * Which files a diagnostic may come from.
 *
 * Root directories are what the tsconfig *includes*, but the compiler also checks everything those
 * roots import - `server/index.mjs` imports `src/shared/*.ts`, so a real error in `src/shared/` shows up
 * in `tsc` output. Filtering strictly by root made those invisible to the ratchet: the recorded pile
 * said 33 while `tsc` printed 34 (measured 2026-10-22, `src/shared/sessionTitle.ts:360` TS2322). A gate
 * that under-counts by one is a gate that can silently accept a new error, so: count every file that is
 * not a declaration file and lives inside the repo.
 */
export function isCheckedFile(relativePath) {
  if (relativePath.endsWith(".d.ts")) return false;
  if (relativePath.startsWith("node_modules/") || relativePath.includes("/node_modules/")) return false;
  return !relativePath.startsWith("../");
}

/**
 * Run the compiler once and return every diagnostic that belongs to a checked root.
 * Returns `null` when the config is absent (the rule then reports "no protection" instead of
 * silently passing).
 */
export function collectNodeDiagnostics(root) {
  const configPath = join(root, NODE_TYPECHECK_CONFIG);
  if (!existsSync(configPath)) return null;

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    return [
      {
        file: NODE_TYPECHECK_CONFIG,
        code: configFile.error.code,
        line: 1,
        message: ts.flattenDiagnosticMessageText(configFile.error.messageText, " "),
      },
    ];
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const raw = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];

  const entries = [];
  for (const diagnostic of raw) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    if (!diagnostic.file) {
      entries.push({ file: "(global)", code: diagnostic.code, line: 1, message });
      continue;
    }
    const relativePath = posixPath(diagnostic.file.fileName).replace(`${posixPath(resolve(root))}/`, "");
    if (!isCheckedFile(relativePath)) continue;
    const position = diagnostic.start ?? 0;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(position);
    entries.push({ file: relativePath, code: diagnostic.code, line: line + 1, message });
  }
  return entries;
}

/** Aggregate into the recorded shape: total, per code, and per file+code. */
export function baselineFromDiagnostics(entries) {
  const byCode = {};
  const byFile = {};
  for (const entry of entries) {
    byCode[entry.code] = (byCode[entry.code] ?? 0) + 1;
    const file = (byFile[entry.file] ??= {});
    file[entry.code] = (file[entry.code] ?? 0) + 1;
  }
  const sortedCodes = {};
  for (const code of Object.keys(byCode).sort((a, b) => Number(a) - Number(b))) {
    sortedCodes[code] = byCode[code];
  }
  const sortedFiles = {};
  for (const file of Object.keys(byFile).sort()) {
    const codes = {};
    for (const code of Object.keys(byFile[file]).sort((a, b) => Number(a) - Number(b))) {
      codes[code] = byFile[file][code];
    }
    sortedFiles[file] = codes;
  }
  return { version: 1, total: entries.length, byCode: sortedCodes, byFile: sortedFiles };
}

/**
 * Compare a run against the baseline. Returns violations plus the aggregate to record.
 *
 * Rules, in order of how easy they are to act on:
 * 1. a file that is not in the baseline and has diagnostics -> violation (new code must be clean);
 * 2. a file+code pair above its baseline count -> violation, with the extra diagnostics listed;
 * 3. everything below the baseline -> no violation, but `--write` tightens the record.
 */
export function compareToBaseline(entries, baseline, options = {}) {
  const violations = [];
  const makeViolation = options.violation ?? ((rule, message, extra = {}) => ({ rule, message, ...extra }));

  if (!baseline) {
    for (const entry of entries) {
      violations.push(
        makeViolation(
          "node-typecheck",
          `${entry.file}:${entry.line} TS${entry.code}: ${entry.message} (no baseline: the pile must stay at zero)`,
          { file: entry.file },
        ),
      );
    }
    return { violations, baseline: baselineFromDiagnostics(entries) };
  }

  const actual = baselineFromDiagnostics(entries);
  // Walk the diagnostics in order and let the first `allowed` of each file+code pass, so growing a
  // pair by two reports two violations (one per extra diagnostic) instead of flagging every entry
  // of that pair.
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.file}\u0000${entry.code}`;
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    const allowed = baseline.byFile?.[entry.file]?.[entry.code] ?? 0;
    if (index > allowed) {
      violations.push(
        makeViolation(
          "node-typecheck",
          `${entry.file}:${entry.line} TS${entry.code}: ${entry.message} (this file+code is already at its baseline of ${allowed})`,
          { file: entry.file },
        ),
      );
    }
  }

  const shrunk =
    actual.total < baseline.total ||
    Object.entries(baseline.byFile ?? {}).some(([file, codes]) =>
      Object.entries(codes).some(([code, count]) => (actual.byFile[file]?.[code] ?? 0) < count),
    );
  if (shrunk && !violations.length) {
    violations.push(
      makeViolation(
        "node-typecheck",
        `the pile shrank to ${actual.total} (baseline ${baseline.total}); run: npm run architecture:write`,
        {},
      ),
    );
  }

  return { violations, baseline: actual };
}

export function readBaseline(root) {
  const path = join(root, NODE_TYPECHECK_BASELINE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeBaseline(root, baseline) {
  const path = join(root, NODE_TYPECHECK_BASELINE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}