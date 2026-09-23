/**
 * Capability-selection reload helpers.
 *
 * A skill toggle only changes which skills pi's loader should keep. Pi Desktop already
 * feeds pi a live `skillsOverride` that reads `capabilityPaths.activeSkillIds`, so pi's
 * own (cheap) skill pass is enough to land the change. Package/extension changes go
 * through the loader's extension set and do need the full `session.reload()`.
 *
 * Both pieces live here, away from the HTTP server, so they can be tested without
 * booting a session.
 */

/** Order-insensitive, duplicate-insensitive id comparison (the caller builds ordered arrays). */
export function sameCapabilityIds(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  const values = new Set(left);
  return right.every((value) => values.has(value));
}

const SKILL_KEYS = ["skills", "enabledSkills", "disabledSkills"];
const RUNTIME_KEYS = [
  "packages",
  "enabledPackages",
  "disabledPackages",
  "extensions",
  "enabledExtensions",
  "disabledExtensions",
];

function anyChanged(current, next, keys) {
  return keys.some((key) => !sameCapabilityIds(current[key] ?? [], next[key] ?? []));
}

/**
 * @returns "none"   nothing in the selection moved; keep the current one
 *          "skills" only skill ids moved; the caller may skip `session.reload()`
 *          "full"   a package/extension moved; the loader's extension set must be rebuilt
 */
export function capabilityReloadPlan(current, next) {
  if (anyChanged(current, next, RUNTIME_KEYS)) {
    return "full";
  }
  return anyChanged(current, next, SKILL_KEYS) ? "skills" : "none";
}

/**
 * Re-filter skills and rebuild the cached system prompt without reloading the session.
 *
 * Pi Desktop already feeds pi a live `skillsOverride` that filters by
 * `capabilityPaths.activeSkillIds`, and pi re-runs that override whenever it reloads a
 * skill path set. `resourceLoader.extendResources()` is pi's public entry point that
 * re-runs exactly that pass, and `session.setActiveToolsByName()` is pi's public hook
 * that rebuilds the cached system prompt for the next turn. Both are pi's own code - we
 * only pick the narrow entry point instead of `session.reload()`, which would also clear
 * the extension cache, re-import every extension, reconnect MCP servers and rebuild the
 * provider/tool runtime, none of which a skill list depends on.
 *
 * @returns false when pi does not expose those entry points, so the caller can fall back
 *          to the full `session.reload()` rather than silently dropping the change.
 */
export function reloadRuntimeSkills(targetRuntime) {
  const loader = targetRuntime?.resourceLoader;
  const session = targetRuntime?.session;
  if (
    typeof loader?.extendResources !== "function" ||
    typeof session?.setActiveToolsByName !== "function" ||
    typeof session?.getActiveToolNames !== "function"
  ) {
    return false;
  }

  // `extendResources` only recomputes when handed at least one path. Re-passing the
  // already-active set is idempotent (pi dedupes paths) and is what re-runs the override.
  const skillPaths = targetRuntime.capabilityPaths?.skillPaths ?? [];
  if (skillPaths.length === 0) {
    return false;
  }
  loader.extendResources({
    skillPaths: skillPaths.map((path) => ({
      path,
      metadata: { source: "cli", scope: "temporary", origin: "top-level" },
    })),
  });
  session.setActiveToolsByName(session.getActiveToolNames());
  return true;
}