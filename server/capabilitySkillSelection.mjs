/**
 * Live per-session skill selection.
 *
 * pi only supports *settings-scoped* skill selection (the `skills` patterns in
 * `settings.json` / `--skills`). Pi Desktop needs per-session selection, so it re-asserts
 * its own selection through pi's `skillsOverride`.
 *
 * The selection used to be precomputed as an `activeSkillIds` allow-list from a *separate*
 * discovery pass, and the override filtered by that list. When the discovery pass ran
 * before project trust was resolved it could not see project `.pi/skills`; pi's session
 * loader then resolved trust and loaded them correctly, and the stale allow-list silently
 * deleted them again — project skills were the visible casualty.
 *
 * This module keeps the decision live instead. `skillsOverride` hands us pi's freshly
 * discovered set (that set *is* the inventory: same loader, same trust state, same
 * instant) and we decide per skill from the current config + selection. Nothing is
 * precomputed, so nothing can go stale; and a managed skill the pre-scan never saw fails
 * open (kept + reported) instead of disappearing.
 */

/** The id Pi Desktop keys skill selection by (same as pi's skill name). */
export function skillSelectionId(skill) {
  return String(skill?.name ?? "").trim();
}

/**
 * Config default for one skill id, with explicit session selection winning.
 * Unknown ids default to `false`, matching `defaultSkillEnabled` (opt-in per skill).
 */
export function skillEnabledBySelection(policy, skillId) {
  if (policy?.disabledIds?.has(skillId)) {
    return false;
  }
  if (policy?.enabledIds?.has(skillId)) {
    return true;
  }
  return policy?.config?.skills?.[skillId]?.defaultEnabled === true;
}

/**
 * Build the live policy object stored on `capabilityPaths`.
 *
 * `inventorySkills` is the pre-resolved (trust-aligned) inventory; its managed ids are the
 * ids the selection may judge. Anything pi discovers beyond that is a divergence and is
 * handled by `applySkillSelection`'s fail-open branch.
 */
export function createSkillSelectionPolicy({ selection, config, inventorySkills = [], isManaged = () => true } = {}) {
  const inventoryIds = new Set();
  for (const skill of inventorySkills ?? []) {
    if (!isManaged(skill?.filePath ?? "")) {
      continue;
    }
    const id = skillSelectionId(skill);
    if (id) {
      inventoryIds.add(id);
    }
  }
  return {
    enabledIds: new Set(selection?.enabledSkills ?? []),
    disabledIds: new Set(selection?.disabledSkills ?? []),
    config: config ?? { skills: {} },
    inventoryIds,
  };
}

/** Overwrite a policy in place so the loader's live reference keeps working after a reload. */
export function replaceSkillSelectionPolicy(policy, next) {
  if (!policy || typeof policy !== "object" || !next) {
    return next ?? policy;
  }
  policy.enabledIds = next.enabledIds ?? new Set();
  policy.disabledIds = next.disabledIds ?? new Set();
  policy.config = next.config ?? { skills: {} };
  policy.inventoryIds = next.inventoryIds ?? new Set();
  return policy;
}

/**
 * Filter pi's freshly discovered skills and hand back the raw inventory.
 *
 * - `isDisabledPath` drops skills whose package is disabled for this session (the caller
 *   keeps owning that guard; it is not selection).
 * - `isManaged` marks the skills this selection owns (app/user/project `.pi` roots).
 *   Unmanaged skills (package skills, etc.) pass through to the other guards.
 * - A managed skill absent from `policy.inventoryIds` fails open: the pre-resolve and
 *   pi's loader disagree, and keeping + reporting beats silently losing capability.
 */
export function applySkillSelection(baseSkills, policy, { isManaged = () => true, isDisabledPath = () => false, onMismatch } = {}) {
  const skills = [];
  const inventory = [...(baseSkills ?? [])];
  for (const skill of inventory) {
    const filePath = skill?.filePath ?? "";
    if (isDisabledPath(filePath)) {
      continue;
    }
    if (!isManaged(filePath)) {
      skills.push(skill);
      continue;
    }
    const id = skillSelectionId(skill);
    if (!policy?.inventoryIds?.has(id)) {
      onMismatch?.(skill);
      skills.push(skill);
      continue;
    }
    if (skillEnabledBySelection(policy, id)) {
      skills.push(skill);
    }
  }
  return { skills, inventory };
}