/**
 * Scope rules for the capability surfaces.
 *
 * Two views share one snapshot (`CapabilitiesState`) but must never overlap:
 * - "global" (the Global skills & packages page): everything the agent itself
 *   provides — builtin + agent-level skills, user-scope packages.
 * - "project" (the conversation context panel): only what this project adds —
 *   `.pi/skills` and project-scope packages.
 *
 * Pure functions live here so the partition can be tested without a browser.
 */

import { t } from "../i18n/index.ts";

export type CapabilityView = "global" | "project";
export type CapabilityScopeTab = "skill" | "package";
export type SkillSourceCategory = "all" | "builtin" | "agent";

/** Minimal shape the partition needs from `CapabilitySkill` / `CapabilityPackage`. */
export interface ScopedCapability {
  kind: string;
  /** Skills: "builtin" | "agent" | "project". */
  source?: string;
  /** Packages: "user" | "project". */
  scope?: string;
  /** Skills/extensions shipped with the app cannot be removed (the bridge refuses). */
  readonly?: boolean;
}

/** The Extensions tab is gone from the panel; only these two kinds are shown. */
export const CAPABILITY_TABS: CapabilityScopeTab[] = ["skill", "package"];

/** "项目级" is deliberately absent: project skills belong to the context panel. */
export const SKILL_SOURCE_CATEGORIES: SkillSourceCategory[] = ["all", "builtin", "agent"];

export const SKILL_SOURCE_CATEGORY_LABEL_KEYS: Record<SkillSourceCategory, string> = {
  all: "capability.category.all",
  builtin: "capability.category.builtin",
  agent: "capability.category.agent",
};

export function isProjectScopedCapability(item: ScopedCapability): boolean {
  if (item.kind === "package") {
    return item.scope === "project";
  }

  return item.source === "project";
}

export function scopedCapabilityItems<T extends ScopedCapability>(items: readonly T[], view: CapabilityView): T[] {
  return items.filter((item) => isProjectScopedCapability(item) === (view === "project"));
}

export function matchesSkillCategory(item: ScopedCapability, category: SkillSourceCategory): boolean {
  // The category row only exists on the Skills tab; letting it filter packages
  // (or anything without a source) would silently empty the list on a stale tab.
  if (category === "all" || item.kind !== "skill") {
    return true;
  }

  return item.source === category;
}

/**
 * Case-insensitive substring search shared by the capability surfaces.
 *
 * Searches the display fields a user can actually see (name, description,
 * package source, skill path); an empty/whitespace query matches everything.
 * Kept pure so both the page and the context panel filter identically.
 */
export function matchesCapabilityQuery(
  item: { name: string; description?: string; source?: string; path?: string },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return [item.name, item.description, item.source, item.path]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(needle));
}

/**
 * Removal rules shared by the card list and the detail sheet, so a capability
 * never looks deletable on one surface and read-only on the other.
 *
 * Packages live in the user/project pi directories and are always removable;
 * skills and extensions are only removable when they are not app-bundled.
 */
export function canDeleteCapability(item: ScopedCapability): boolean {
  if (item.kind === "package") {
    return true;
  }

  if (item.kind === "skill" || item.kind === "extension") {
    return item.readonly !== true;
  }

  return false;
}

export function capabilitySourceLabel(item: ScopedCapability): string {
  if (item.kind === "skill") {
    if (item.source === "builtin") return t("capability.source.builtin");
    if (item.source === "agent") return t("capability.source.agent");
    if (item.source === "project") return t("capability.source.project");
  }

  return t("capability.source.discovered");
}
