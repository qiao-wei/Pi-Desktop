/**
 * `process-boundary` rule support: every process boundary has a tsconfig, and every source
 * directory belongs to one.
 *
 * The point is not to count tsconfigs (ZCode has 52 because it really has that many processes).
 * The point is that **no source tree can be untyped without anyone noticing**: before this, the
 * renderer was checked by `tsconfig.json` and everything else was checked by nothing, which is how
 * 18k lines of `server/*.mjs` and `src-electron/*.js` drifted out of static reach. A new directory
 * (a second host, a scheduler, a CLI) must be registered here, and the checker verifies that the
 * config it names actually includes the files under its root.
 *
 * `checked: false` is allowed only with a `why`: Rust has no tsconfig, so `src-tauri/src` says
 * "cargo checks this" explicitly instead of quietly being absent.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Read one tsconfig's `include` list (JSON with comments is not used in this repo). */
export function readConfigInclude(root, configPath) {
  const absolute = join(root, configPath);
  if (!existsSync(absolute)) return null;
  const parsed = JSON.parse(readFileSync(absolute, "utf8"));
  return { include: parsed.include ?? [], references: (parsed.references ?? []).map((ref) => ref.path) };
}

/**
 * TypeScript's `include` semantics: a bare directory name means "everything under it", which is
 * not what a naive glob match says (`src` does not match `src/app/App.tsx`). Mirror the compiler
 * instead of quietly reporting 143 false positives.
 */
function includeMatches(include, file, root) {
  return include.some((pattern) => {
    if (matchGlobish(pattern, file, root)) return true;
    const dir = pattern.replace(/\/$/, "");
    if (!pattern.includes("*") && existsSync(join(root, dir))) {
      return matchGlobish(`${dir}/**`, file, root);
    }
    return false;
  });
}

// Injected by the caller (check.mjs owns the glob implementation); kept as a module-level hook so
// the pure logic below stays testable without re-implementing globbing here.
/** @type {(pattern: string, file: string, root: string) => boolean} */
let matchGlobish = () => false;
export function useGlob(matcher) {
  matchGlobish = matcher;
}

/**
 * Verify the declared boundaries against the tree.
 *
 * Returns violations for:
 * 1. a boundary whose config file is missing (unless `checked: false` with a reason);
 * 2. a source file under a boundary root that the named config does not include (the silent hole);
 * 3. a scan root that no boundary claims (a new source tree nobody type-checks);
 * 4. an unchecked boundary without a reason.
 */
export function checkProcessBoundaries(policy, { root, violation, matchGlob, listSourceFiles, relativeTo }) {
  useGlob(matchGlob);
  const boundaries = policy.processBoundaries ?? [];
  if (!boundaries.length) {
    return [
      violation(
        "process-boundary",
        "policy.processBoundaries is empty: nothing states which tsconfig covers which process",
        {},
      ),
    ];
  }

  const violations = [];
  const claimedRoots = new Set();

  for (const boundary of boundaries) {
    const roots = Array.isArray(boundary.root) ? boundary.root : [boundary.root];
    for (const entry of roots) claimedRoots.add(entry.replace(/\/$/, ""));

    if (boundary.checked === false) {
      if (!boundary.why) {
        violations.push(
          violation(
            "process-boundary",
            `${boundary.id} is declared unchecked without a why; say who checks it (cargo / a host runner / nothing)`,
            {},
          ),
        );
      }
      continue;
    }

    const config = readConfigInclude(root, boundary.config);
    if (!config) {
      violations.push(
        violation("process-boundary", `${boundary.id} names ${boundary.config}, which does not exist`, {
          file: boundary.config,
        }),
      );
      continue;
    }

    // Every source file under the root must be matched by an include pattern of that config.
    const uncovered = [];
    for (const entry of roots) {
      const absolute = join(root, entry);
      if (!existsSync(absolute)) continue;
      const files = listSourceFiles(absolute).map((file) => relativeTo(root, file));
      for (const file of files) {
        if (!includeMatches(config.include, file, root)) uncovered.push(file);
      }
    }
    if (uncovered.length) {
      violations.push(
        violation(
          "process-boundary",
          `${boundary.id} (${roots.join(", ")}) has ${uncovered.length} file(s) outside ${boundary.config}: ${uncovered
            .slice(0, 3)
            .join(", ")}${uncovered.length > 3 ? ", ..." : ""}`,
          { file: uncovered[0] },
        ),
      );
    }
  }

  for (const scanRoot of policy.scanRoots ?? []) {
    if (!claimedRoots.has(scanRoot)) {
      violations.push(
        violation(
          "process-boundary",
          `${scanRoot}/ is scanned by the architecture rules but no process boundary claims it - is it typechecked at all?`,
          {},
        ),
      );
    }
  }

  return violations;
}