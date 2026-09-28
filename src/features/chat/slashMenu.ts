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
  commands: { name: string; description?: string; hasArgumentCompletions?: boolean }[];
}

/** pi 内置命令里 Pi Desktop 真能执行的那几条（服务端只下发实现的）。 */
export interface SlashMenuBuiltinCommand {
  name: string;
  description: string;
}

export interface CapabilitiesLike {
  skills: SlashMenuSkill[];
  packages: SlashMenuPackage[];
  builtinCommands?: SlashMenuBuiltinCommand[];
}

/**
 * Composer "/" autocomplete model, mirroring the pi TUI editor.
 *
 * Skills keep Pi Desktop's badge mechanism (the badge enables the skill for the session
 * and shows up in the message). Package commands are completed into plain text so the
 * user can add arguments: Tab inserts `/command ` and, when the command registers
 * `getArgumentCompletions`, `matchSlashCommandArgs` drives the follow-up argument menu.
 * Enter submits (pi's autocomplete falls through to submit for a "/" prefix), and the
 * submitted line is dispatched to `/api/capabilities/package/command` — never chatted.
 */
export type SlashMenuItem =
  | { kind: "skill"; id: string; name: string; description: string; active: boolean }
  | {
      kind: "command";
      packageId: string;
      packageName: string;
      name: string;
      description: string;
      /** pi 侧注册了 getArgumentCompletions → 选中后继续给参数补全。 */
      hasArgumentCompletions: boolean;
    }
  | { kind: "argument"; value: string; label: string; description?: string }
  | { kind: "builtin"; name: string; description: string };

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

export interface SlashCommandArgs {
  name: string;
  prefix: string;
}

/**
 * TUI-style `/command args` detection for a whole composer line.
 *
 * `matchSlashTrigger` only ever sees the trailing `/query` token, so it goes quiet the
 * moment a space is typed. This is the follow-up half: it recognizes a *command line*
 * (`/end-review focus on tests`) so the composer can (a) keep completing arguments while
 * typing and (b) dispatch the package action on submit instead of sending the text to
 * the model. The name must start the text (pi itself keys command dispatch off
 * `text.startsWith("/")`), and arguments stay on the same line so a multi-line draft
 * never turns into a surprise command.
 *
 * The trailing whitespace is intentionally kept in `prefix`: a command like `/mcp` needs
 * the space after a subcommand (`/mcp disable `) to know the next token is a server
 * instance. Submitted text is already whitespace-normalized by the composer, so dispatch
 * sees `/command args` without the trailing space.
 */
export function matchSlashCommandArgs(text: string): SlashCommandArgs | null {
  const cleaned = text.replaceAll("\u200b", "");
  if (!cleaned.startsWith("/")) {
    return null;
  }
  // 参数必须和命令同一行：多行草稿里出现 /xxx 不该变成意外动作。
  if (cleaned.includes("\n")) {
    return null;
  }
  const firstSpace = cleaned.search(/\s/u);
  const name = firstSpace === -1 ? cleaned.slice(1) : cleaned.slice(1, firstSpace);
  if (!name || name.includes("/")) {
    return null;
  }
  const prefix = firstSpace === -1 ? "" : cleaned.slice(firstSpace + 1);
  return { name, prefix };
}

export interface PackageCommandRef {
  packageId: string;
  packageName: string;
  name: string;
  description: string;
  hasArgumentCompletions: boolean;
}

/** Look up one loaded package command by its invocation name across every package. */
export function findSlashCommand(
  capabilities: Pick<CapabilitiesState, "packages"> | { packages: SlashMenuPackage[] },
  name: string,
): PackageCommandRef | null {
  for (const pkg of capabilities.packages) {
    const command = pkg.commands.find((candidate) => candidate.name === name);
    if (command) {
      return {
        packageId: pkg.id,
        packageName: pkg.name,
        name: command.name,
        description: command.description ?? pkg.description,
        hasArgumentCompletions: Boolean(command.hasArgumentCompletions),
      };
    }
  }
  return null;
}

/**
 * Look up one built-in command (the Pi Desktop-executable subset) by name. The server
 * only ships implemented commands, so a hit here means the BFF can really run it.
 */
export function findBuiltinCommand(
  capabilities: { builtinCommands?: SlashMenuBuiltinCommand[] },
  name: string,
): SlashMenuBuiltinCommand | null {
  return (capabilities.builtinCommands ?? []).find((command) => command.name === name) ?? null;
}

/** Upper bound per section (skills and commands are capped independently, so a
 *  long skill list can never crowd the commands out of the menu). */
export const SLASH_MENU_LIMIT = 50;

export function buildSlashMenuItems(
  capabilities: Pick<CapabilitiesState, "skills" | "packages"> & { builtinCommands?: SlashMenuBuiltinCommand[] } | CapabilitiesLike,
  query: string,
  limit = SLASH_MENU_LIMIT,
): SlashMenuItem[] {
  const source: CapabilitiesLike = {
    skills: capabilities.skills,
    packages: capabilities.packages,
    builtinCommands: capabilities.builtinCommands,
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
      hasArgumentCompletions: Boolean(command.hasArgumentCompletions),
    })))
    .map((command) => ({ command, rank: rankOf(command.name, `${command.packageName} ${command.description}`) }))
    .filter(({ rank }) => rank < 3)
    .sort((left, right) => left.rank - right.rank || left.command.name.localeCompare(right.command.name))
    .slice(0, limit);

  // 内置命令是固定小名单（服务端只下发实现了的），同样按相关度参与分组排序。
  const rankedBuiltins = (source.builtinCommands ?? [])
    .map((command) => ({ command, rank: rankOf(command.name, command.description) }))
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

  const builtins: SlashMenuItem[] = rankedBuiltins.map(({ command }) => ({
    kind: "builtin",
    name: command.name,
    description: command.description,
  }));

  // 分组顺序跟随全局最佳匹配：查询非空时，含最优项的分组排前面
  // （如 "/end" 时指令组在前、高亮直接落在 end-review）；空查询时三个组并列第一，
  // 按内置 → 技能 → 指令的稳定顺序展示。用 sort（稳定）而不是手写比较，新分组才不会再漏。
  const groups = [
    { rank: rankedBuiltins[0]?.rank ?? 3, items: builtins },
    { rank: rankedSkills[0]?.rank ?? 3, items: skills },
    { rank: rankedCommands[0]?.rank ?? 3, items: commands },
  ];
  groups.sort((left, right) => left.rank - right.rank);
  return groups.flatMap((group) => group.items);
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
