/**
 * Upstream (pi kernel) admission gate.
 *
 * The problem: `server/piKernel.mjs` re-exports 21 names from `@earendil-works/*`, two of them from
 * **non-public deep paths** into the package's `dist/`. A kernel bump that renames a symbol, drops an
 * export, or changes a signature is currently only noticed when something fails at runtime - and the
 * two deep imports have no type protection at all (they are not in the package's `exports` map, so
 * `tsc` sees them as `any`-ish JS).
 *
 * What this does instead: freeze what we actually depend on into
 * `architecture/generated/upstream-snapshot.json` - name, kind and arity for every export, plus the
 * exact deep-import paths - and compare on every test run. Removed or changed = red; added = "run
 * `npm run upstream:write` to admit it deliberately".
 *
 * Deliberately small (a few KB, not ZCode's 1.8 MB): we take 21 names from one package, so the gate only
 * needs to describe those 21. If it ever grows past the point where a human reads the diff, the honest
 * fix is fewer dependencies, not a bigger snapshot.
 *
 * Usage:
 *   node scripts/architecture/upstream-admission.mjs --check   # compare, exit 1 on drift
 *   node scripts/architecture/upstream-admission.mjs --write   # re-record (after reading the diff)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const SNAPSHOT_PATH = join(REPO_ROOT, "architecture", "generated", "upstream-snapshot.json");

/** Names the bridge takes from the kernel, and the deep paths it reaches outside `exports`. */
export const TRACKED_EXPORTS = [
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
  "resolveProjectTrusted",
  "hasTrustRequiringProjectResources",
  "runPiCli",
];

export const DEEP_IMPORTS = [
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/project-trust.js",
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js",
];

function kindOf(value) {
  if (typeof value === "function") return "function";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Load the adapter module the bridge itself uses (so the gate tracks what ships, not the package),
 * and keep it: a second import would re-run the kernel's module init for nothing.
 */
let cachedAdapter = null;
export async function loadAdapter() {
  cachedAdapter ??= await import(join(REPO_ROOT, "server", "piKernel.mjs"));
  return cachedAdapter;
}

export async function buildSnapshot() {
  const adapter = await loadAdapter();
  const exports = TRACKED_EXPORTS.map((name) => {
    const value = adapter[name];
    return { name, kind: kindOf(value), arity: typeof value === "function" ? value.length : null };
  });
  const deepImports = [];
  for (const specifier of DEEP_IMPORTS) {
    let loaded = null;
    try {
      loaded = await import(join(REPO_ROOT, "server", specifier));
    } catch (error) {
      deepImports.push({ specifier, ok: false, error: String(error?.message ?? error) });
      continue;
    }
    deepImports.push({
      specifier,
      ok: true,
      symbols: Object.keys(loaded).sort(),
    });
  }
  return {
    package: "@earendil-works/pi-coding-agent",
    version: packageVersion(),
    exports,
    deepImports,
  };
}

function packageVersion() {
  try {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
    );
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Diff recorded snapshot against a fresh one. `removed`/`changed` are failures; `added` needs a rerun. */
export function compareSnapshots(recorded, fresh) {
  const problems = [];
  const additions = [];
  const byName = new Map((fresh.exports ?? []).map((entry) => [entry.name, entry]));
  for (const entry of recorded.exports ?? []) {
    const current = byName.get(entry.name);
    if (!current) {
      problems.push(`${entry.name} disappeared from the kernel`);
      continue;
    }
    if (current.kind !== entry.kind) {
      problems.push(`${entry.name} changed kind: ${entry.kind} → ${current.kind}`);
    }
    if (current.arity !== entry.arity) {
      problems.push(`${entry.name} changed arity: ${entry.arity} → ${current.arity} (read the upstream source again)`);
    }
  }
  const recordedNames = new Set((recorded.exports ?? []).map((entry) => entry.name));
  for (const entry of fresh.exports ?? []) {
    if (!recordedNames.has(entry.name)) additions.push(entry.name);
  }

  // 两个方向都要走：只遍历 fresh 的话，「某个深引不再被跟踪」这种退化不会被发现
  // （tests/upstreamAdmission.test.ts 的负例就是这么抓出来的）。
  const freshDeep = new Map((fresh.deepImports ?? []).map((entry) => [entry.specifier, entry]));
  for (const missing of recorded.deepImports ?? []) {
    if (!freshDeep.has(missing.specifier)) {
      problems.push(`deep import ${missing.specifier} is no longer tracked`); 
    }
  }

  for (const deep of fresh.deepImports ?? []) {
    const before = (recorded.deepImports ?? []).find((entry) => entry.specifier === deep.specifier);
    if (!before) {
      additions.push(`deep import ${deep.specifier}`);
      continue;
    }
    if (before.ok !== deep.ok) {
      problems.push(`deep import ${deep.specifier} changed availability: ${before.ok} → ${deep.ok}`);
    }
    const beforeSymbols = before.symbols ?? [];
    const currentSymbols = deep.symbols ?? [];
    for (const symbol of beforeSymbols) {
      if (!currentSymbols.includes(symbol)) problems.push(`${deep.specifier} no longer exports ${symbol}`);
    }
    for (const symbol of currentSymbols) {
      if (!beforeSymbols.includes(symbol)) additions.push(`${deep.specifier}#${symbol}`);
    }
  }

  return { problems, additions };
}

function main(argv) {
  const action = argv.includes("--write") ? "write" : "check";
  return buildSnapshot().then((fresh) => {
    if (action === "write") {
      mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
      writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(fresh, null, 2)}\n`);
      console.log(`upstream-admission: recorded ${fresh.exports.length} exports (kernel ${fresh.version})`);
      return 0;
    }
    if (!existsSync(SNAPSHOT_PATH)) {
      console.log("upstream-admission: no snapshot yet; run npm run upstream:write to admit the current surface");
      return 1;
    }
    const recorded = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    const { problems, additions } = compareSnapshots(recorded, fresh);
    if (problems.length) {
      for (const problem of problems) console.log(`upstream-admission: ${problem}`);
      return 1;
    }
    if (additions.length) {
      console.log(`upstream-admission: new upstream surface not yet admitted: ${additions.join(", ")}`);
      console.log("upstream-admission: read the upstream change, then run npm run upstream:write");
      return 1;
    }
    console.log(`upstream-admission: ok (kernel ${fresh.version}, ${fresh.exports.length} exports)`);
    return 0;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}