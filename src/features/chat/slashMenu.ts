import type { CapabilitiesState } from "../../types";

/** Structural input shape so callers can pass a full CapabilitiesState or a test fixture. */
export interface SlashMenuSkill {
  id: string;
  name: string;
  description: string;
  active: boolean;
}

export interface SlashMenuPackage {
  id: string;
  name: string;
  description: string;
  commands: { name: string; description?: string }[];
}

export interface CapabilitiesLike {
  skills: SlashMenuSkill[];
  packages: SlashMenuPackage[];
}

/**
 * Composer "/" autocomplete model.
 *
 * Selecting a skill keeps Pi Desktop's badge mechanism (the badge enables the skill
 * for the session and shows up in the message). Selecting a package command
 * runs it immediately through the same endpoint the Packages page uses
 * (/api/capabilities/package/command) and clears the typed "/command" text.
 */
export type SlashMenuItem =
  | { kind: "skill"; id: string; name: string; description: string; active: boolean }
  | { kind: "command"; packageId: string; packageName: string; name: string; description: string };

/**
 * The "/" trigger: a slash that starts the composer text or follows whitespace,
 * optionally followed by query characters, at the very end of the text. Returns
 * the query typed after the slash, or null when the menu should stay closed.
 * The zero-width caret marker used by the composer editor is ignored.
 */
export function matchSlashTrigger(text: string): string | null {
  const cleaned = text.replaceAll("\u200b", "");
  const match = /(?:^|\s)\/([^\s/]*)$/u.exec(cleaned);
  return match ? match[1] : null;
}

/** Upper bound per section (skills and commands are capped independently, so a
 *  long skill list can never crowd the commands out of the menu). */
export const SLASH_MENU_LIMIT = 50;

export function buildSlashMenuItems(
  capabilities: Pick<CapabilitiesState, "skills" | "packages"> | CapabilitiesLike,
  query: string,
  limit = SLASH_MENU_LIMIT,
): SlashMenuItem[] {
  const source: CapabilitiesLike = {
    skills: capabilities.skills,
    packages: capabilities.packages,
  };
  const needle = query.trim().toLowerCase();

  // 匹配优先级：名字以查询词开头 > 名字包含 > 描述包含；不上榜的过滤掉。
  // 这样 "/end" 的高亮直接落在 end-review，而不是描述里偶含 "end" 的无关项。
  const rankOf = (name: string, description: string) => {
    if (!needle) {
      return 0;
    }
    const haystackName = name.toLowerCase();
    if (haystackName.startsWith(needle)) {
      return 0;
    }
    if (haystackName.includes(needle)) {
      return 1;
    }
    return description.toLowerCase().includes(needle) ? 2 : 3;
  };

  const rankedSkills = source.skills
    .map((skill) => ({ skill, rank: rankOf(skill.name, skill.description) }))
    .filter(({ rank }) => rank < 3)
    .sort((left, right) =>
      left.rank - right.rank
      || Number(right.skill.active) - Number(left.skill.active)
      || left.skill.name.localeCompare(right.skill.name))
    .slice(0, limit);

  const rankedCommands = source.packages
    .flatMap((pkg) => pkg.commands.map((command) => ({
      kind: "command" as const,
      packageId: pkg.id,
      packageName: pkg.name,
      name: command.name,
      description: command.description ?? pkg.description,
    })))
    .map((command) => ({ command, rank: rankOf(command.name, `${command.packageName} ${command.description}`) }))
    .filter(({ rank }) => rank < 3)
    .sort((left, right) => left.rank - right.rank || left.command.name.localeCompare(right.command.name))
    .slice(0, limit);

  const skills: SlashMenuItem[] = rankedSkills.map(({ skill }) => ({
    kind: "skill",
    id: skill.id,
    name: skill.name,
    description: skill.description,
    active: skill.active,
  }));

  const commands: SlashMenuItem[] = rankedCommands.map(({ command }) => command);

  // 分组顺序跟随全局最佳匹配：查询非空时，含最优项的分组排前面
  // （如 "/end" 时指令组在前、高亮直接落在 end-review），空查询维持技能在前。
  const bestSkillRank = rankedSkills[0]?.rank ?? 3;
  const bestCommandRank = rankedCommands[0]?.rank ?? 3;
  return bestCommandRank < bestSkillRank
    ? [...commands, ...skills]
    : [...skills, ...commands];
}

/** Highlight movement with wrap-around, matching the pi TUI slash menu. */
export function moveHighlight(current: number, delta: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return (current + delta + length) % length;
}

/**
 * Raw-text index of the "/" that starts the trailing /query, or null.
 * Zero-width caret markers (\u200b) are invisible to the match — a slash typed
 * right after a badge lives in the same text node as its marker ("\u200b/") —
 * but the returned index maps back into the raw string for DOM editing.
 */
export function findSlashStart(rawBefore: string): number | null {
  const cleaned = rawBefore.replaceAll("\u200b", "");
  const match = /(?:^|\s)\/[^\s/]*$/u.exec(cleaned);
  if (!match) {
    return null;
  }

  const cleanedSlashIndex = match.index + match[0].lastIndexOf("/");
  let cleanedIndex = 0;
  for (let rawIndex = 0; rawIndex < rawBefore.length; rawIndex += 1) {
    if (rawBefore[rawIndex] === "\u200b") {
      continue;
    }
    if (cleanedIndex === cleanedSlashIndex) {
      return rawIndex;
    }
    cleanedIndex += 1;
  }
  return null;
}

/** Minimal DOM shape so the trigger-text walk can run against a real editor or a test fixture. */
export interface TriggerTextNode {
  nodeType: number;
  textContent?: string | null;
  childNodes?: ArrayLike<TriggerTextNode>;
  dataset?: Record<string, string | undefined>;
}

/**
 * Text used for "/" trigger detection. `editor.textContent` also contains the
 * badge-internal text (icon, skill name, "Skill", "×"), so a slash typed right
 * after a badge would look mid-word ("…Skill×​/") and never trigger. Here the
 * badge subtrees are skipped entirely — a badge counts as a token, so typing
 * "/" right after one behaves like after a space.
 */
export function readTriggerText(root: TriggerTextNode): string {
  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;
  let text = "";

  const walk = (node: TriggerTextNode) => {
    if (node.nodeType === TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) {
      return;
    }
    if (node.dataset?.attachmentId || node.dataset?.capabilityId) {
      return;
    }
    const children = node.childNodes;
    for (let index = 0; index < (children?.length ?? 0); index += 1) {
      walk(children![index]);
    }
  };
  const rootChildren = root.childNodes;
  for (let index = 0; index < (rootChildren?.length ?? 0); index += 1) {
    walk(rootChildren![index]);
  }
  return text;
}
