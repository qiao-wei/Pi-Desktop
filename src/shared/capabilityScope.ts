/**
 * Scope rules for the capability surfaces.
 *
 * Two views share one snapshot (`CapabilitiesState`) but must never overlap:
 * - "global" (the Global skills & packages page): everything the agent itself
 *   provides — builtin + agent-level skills, user-scope packages.
 * - "project" (the conversation context panel): only what this project adds —
 *   `.pi/skills`, project-level `.agents/skills`, project-scope packages.
 *
 * Pure functions live here so the partition can be tested without a browser.
 */

import { t } from "../i18n/index.ts";

export type CapabilityView = "global" | "project";
export type CapabilityScopeTab = "skill" | "package" | "mcp";
export type SkillSourceCategory = "all" | "builtin" | "piAgent" | "agents";

/** Minimal shape the partition needs from `CapabilitySkill` / `CapabilityPackage`. */
export interface ScopedCapability {
  kind: string;
  /** Skills: "builtin" | "piAgent" | "agents" | "projectAgents" | "project". */
  source?: string;
  /** Packages: "user" | "project". */
  scope?: string;
  /** Skills/extensions shipped with the app cannot be removed (the bridge refuses). */
  readonly?: boolean;
}

/** The Extensions tab is gone from the panel; MCP joined in pi 0.99 (built-in mcp.json). */
export const CAPABILITY_TABS: CapabilityScopeTab[] = ["skill", "package", "mcp"];

/** "项目级" is deliberately absent: project skills belong to the context panel. */
export const SKILL_SOURCE_CATEGORIES: SkillSourceCategory[] = ["all", "builtin", "piAgent", "agents"];

export const SKILL_SOURCE_CATEGORY_LABEL_KEYS: Record<SkillSourceCategory, string> = {
  all: "capability.category.all",
  builtin: "capability.category.builtin",
  piAgent: "capability.category.piAgent",
  agents: "capability.category.agents",
};

export function isProjectScopedCapability(item: ScopedCapability): boolean {
  if (item.kind === "package" || item.kind === "mcp") {
    return item.scope === "project";
  }

  // `projectAgents` = `<dir>/.agents/skills`（cwd 及其祖先目录）。它是**这个项目带来的**技能，
  // 所以归项目视图；但它是跨客户端共享目录，来源上仍然只读（见 isReadOnlySkillSource）。
  return item.source === "project" || item.source === "projectAgents";
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
  // Packages live in the user/project pi directories, MCP servers in an mcp.json we own.
  if (item.kind === "package" || item.kind === "mcp") {
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
    if (item.source === "piAgent") return t("capability.source.piAgent");
    if (item.source === "agents") return t("capability.source.agents");
    if (item.source === "projectAgents") return t("capability.source.projectAgents");
    if (item.source === "project") return t("capability.source.project");
  }

  if (item.kind === "mcp") {
    return item.scope === "project" ? t("capability.source.project") : t("capability.source.agent");
  }

  return t("capability.source.discovered");
}
