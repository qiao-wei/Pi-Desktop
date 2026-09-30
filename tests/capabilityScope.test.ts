/**
 * Capability scope rules: the Global skills & packages page and the conversation
 * context panel split one snapshot into two disjoint halves.
 *
 * The partition itself is tested as data (no DOM); the last group of tests only
 * pins that App.tsx is wired to those helpers instead of re-filtering inline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CAPABILITY_TABS,
  SKILL_SOURCE_CATEGORIES,
  capabilitySourceLabel,
  isProjectScopedCapability,
  matchesCapabilityQuery,
  matchesSkillCategory,
  scopedCapabilityItems,
} from "../src/shared/capabilityScope.ts";

const builtinSkill = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  kind: "skill" as const,
  name,
  source: "builtin",
  ...extra,
});
const agentSkill = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  kind: "skill" as const,
  name,
  source: "agent",
  ...extra,
});
const projectSkill = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  kind: "skill" as const,
  name,
  source: "project",
  ...extra,
});
const userPackage = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  kind: "package" as const,
  name,
  source: `npm:${name}`,
  scope: "user",
  ...extra,
});
const projectPackage = (name: string) => ({ ...userPackage(name), scope: "project" });
const mcpServer = (name: string, scope: "user" | "project") => ({
  id: `${scope}:${name}`,
  kind: "mcp" as const,
  name,
  scope,
  transport: "http" as const,
});

/* ------------------------------- tab list -------------------------------- */

test("the page has Skills, Packages and MCP tabs, nothing else", () => {
  // MCP joined in pi 0.99: the servers live in mcp.json and are managed from this page.
  assert.deepEqual(CAPABILITY_TABS, ["skill", "package", "mcp"]);
});

test("the skill source filter has no 项目级 entry", () => {
  assert.deepEqual(SKILL_SOURCE_CATEGORIES, ["all", "builtin", "agent"]);
});

/* ------------------------------ partitioning ----------------------------- */

test("skills are split by source, packages by scope", () => {
  const skills = [builtinSkill("a"), agentSkill("b"), projectSkill("c")];
  const packages = [userPackage("d"), projectPackage("e")];

  assert.deepEqual(scopedCapabilityItems(skills, "global").map((i) => i.name), ["a", "b"]);
  assert.deepEqual(scopedCapabilityItems(skills, "project").map((i) => i.name), ["c"]);
  assert.deepEqual(scopedCapabilityItems(packages, "global").map((i) => i.name), ["d"]);
  assert.deepEqual(scopedCapabilityItems(packages, "project").map((i) => i.name), ["e"]);
});

test("MCP servers split by scope, exactly like packages", () => {
  const servers = [mcpServer("global-one", "user"), mcpServer("project-one", "project")];

  assert.deepEqual(scopedCapabilityItems(servers, "global").map((i) => i.name), ["global-one"]);
  assert.deepEqual(scopedCapabilityItems(servers, "project").map((i) => i.name), ["project-one"]);
  assert.equal(isProjectScopedCapability(mcpServer("project-one", "project")), true);
  assert.equal(isProjectScopedCapability(mcpServer("global-one", "user")), false);
});

test("the two views are disjoint and together cover the snapshot", () => {
  const items = [
    builtinSkill("a"),
    agentSkill("b"),
    projectSkill("c"),
    userPackage("d"),
    projectPackage("e"),
    mcpServer("f", "user"),
    mcpServer("g", "project"),
    // A stale payload without source/scope must not vanish from both lists.
    { id: "h", kind: "skill", name: "h" },
  ];

  const globalView = scopedCapabilityItems(items, "global");
  const projectView = scopedCapabilityItems(items, "project");

  assert.deepEqual(globalView.map((i) => i.name), ["a", "b", "d", "f", "h"]);
  assert.deepEqual(projectView.map((i) => i.name), ["c", "e", "g"]);
  assert.equal(globalView.filter((g) => projectView.includes(g)).length, 0);
  assert.equal(globalView.length + projectView.length, items.length);
});

test("empty or unknown payloads fall back to the global view", () => {
  assert.deepEqual(scopedCapabilityItems([], "global"), []);
  assert.deepEqual(scopedCapabilityItems([], "project"), []);
  assert.equal(isProjectScopedCapability({ kind: "package" }), false);
  assert.equal(isProjectScopedCapability({ kind: "skill", source: "who-knows" }), false);
  // Only skills and packages carry a source/scope, so extensions stay global.
  assert.equal(isProjectScopedCapability({ kind: "extension", source: "project" }), true);
  assert.equal(isProjectScopedCapability({ kind: "extension", scope: "project" }), false);
});

/* -------------------------------- categories ----------------------------- */

test("category filter keeps 全部 and drops the other sources", () => {
  const items = [builtinSkill("a"), agentSkill("b"), projectSkill("c")];

  assert.deepEqual(
    scopedCapabilityItems(items, "global")
      .filter((i) => matchesSkillCategory(i, "all"))
      .map((i) => i.name),
    ["a", "b"],
  );
  assert.deepEqual(
    items.filter((i) => matchesSkillCategory(i, "builtin")).map((i) => i.name),
    ["a"],
  );
  assert.deepEqual(
    items.filter((i) => matchesSkillCategory(i, "agent")).map((i) => i.name),
    ["b"],
  );
});

test("a source category never hides the other kinds", () => {
  // The category row only exists on the Skills tab; if the selection leaks over to
  // Packages, filtering by a skill source must not empty the list.
  assert.equal(matchesSkillCategory(userPackage("d"), "builtin"), true);
  assert.equal(matchesSkillCategory(userPackage("d"), "all"), true);
  assert.equal(matchesSkillCategory({ kind: "skill" }, "builtin"), false);
});

/* ---------------------------------- labels ------------------------------- */

test("cards label a skill by where it came from", () => {
  assert.equal(capabilitySourceLabel(builtinSkill("a")), "内置");
  assert.equal(capabilitySourceLabel(agentSkill("b")), "agent级");
  assert.equal(capabilitySourceLabel(projectSkill("c")), "项目级");
  assert.equal(capabilitySourceLabel({ kind: "skill" }), "已发现");
});

/* ------------------------------ App.tsx wiring --------------------------- */

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../src/i18n/zh.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../src/i18n/en.ts", import.meta.url), "utf8");

test("the page renders the global view and the context panel the project view", () => {
  assert.match(appSource, /scopedCapabilityItems\(rawItems,\s*"global"\)/);
  assert.match(appSource, /scopedCapabilityItems\(capabilities\.skills,\s*"project"\)/);
  assert.match(appSource, /scopedCapabilityItems\(capabilities\.packages,\s*"project"\)/);
});

test("the entry point is titled Global skills & packages", () => {
  assert.match(appSource, /Global skills &amp; packages/);
  assert.doesNotMatch(appSource, /专家[·、]技能/);
});

test("the page has no Extensions tab left", () => {
  assert.doesNotMatch(appSource, /\["extension",\s*"Extensions"/);
  assert.match(appSource, /CAPABILITY_TABS\.map/);
});

test("the pinned section is gated on there being pinned items", () => {
  assert.match(appSource, /\{pinnedItems\.length \? \(/);
  assert.doesNotMatch(appSource, /暂无置顶项/);
});

test("the context panel is dropped from the capabilities view", () => {
  assert.match(appSource, /const showContextPanel = activeMainView === "chat"/);
  assert.match(appSource, /"--right-panel-width": rightPanelCollapsed \|\| !showContextPanel/);
  assert.match(appSource, /\{showContextPanel \? \(/);
});

test("context panel switches reuse the page's default toggle handler", () => {
  assert.match(
    appSource,
    /<ProjectCapabilitiesPanel[\s\S]*?onSetDefault=\{setCapabilityDefault\}[\s\S]*?\/>/,
  );
  // Reused toggle: same endpoint as the cards, no session-scoped call.
  assert.match(appSource, /await onSetDefault\(item\.kind, item\.id, enabled\)/);
});

/* ------------------------- package command panel -------------------------- */

// A package can register any number of `/` commands; the old layout rendered
// one button per command inline on the card, which does not scale.

test("package `/` commands render through the shared panel, not an expanded row", () => {
  const menu = functionBody(appSource, "function CapabilityCommandMenu");

  // 2026-09-22：原来是 Radix DropdownMenu（一列到底，高处被视口截掉、macOS 又不画滚动条，
  // 用户实测「action 较多的时候显示不全」）。现在换成 Popover + 可滚动列表 + 搜索框，
  // 所以断言也从「存在 DropdownMenu」改成「面板按可用高度滚动、命令多时能搜」。
  assert.match(menu, /<Popover open=\{open\} onOpenChange=\{setOpen\}>/);
  assert.match(
    menu,
    /max-h-\[var\(--radix-popover-content-available-height/,
    "面板必须按 Radix 给的可用高度封顶，否则高窗口/低窗口都会截掉命令",
  );
  // 滚动与滚动条怎么做在 tests/capabilityCommandPanel.test.ts 里单独锁；这里只锁「命令不是平铺/菜单化的」。
  assert.match(menu, /<AutoHideScroll className="min-h-0 flex-1" thumbAlwaysVisible>/);
  assert.doesNotMatch(menu, /<DropdownMenu>/, "菜单式下拉放不下长列表，且里面塞不了输入框");

  // 搜索框只在长列表上出现，并且走共享的纯过滤函数。
  assert.match(menu, /const searchable = commands\.length > CAPABILITY_COMMAND_SEARCH_THRESHOLD/);
  assert.match(menu, /filterPackageCommands\(commands, query\)/);
  assert.match(menu, /\{searchable \? \(/);

  // 每一条命令都还是 `/name` + 描述，点/回车执行的是命令名。
  assert.match(menu, /\/\{command\.name\}/);
  assert.match(menu, /onClick=\{\(\) => run\(command\.name\)\}/);
  assert.match(menu, /onRun\(name\)/);

  // Both surfaces hand their commands to the same menu component.
  assert.match(appSource, /<CapabilityCommandMenu\n\s+commands=\{item\.commands\}/);
  assert.doesNotMatch(appSource, /aria-label="Package commands" onClick=\{\(event\) => event\.stopPropagation\(\)\}>\s*\{item\.commands\.map/);
});

test("the Packages tab card fills the composer instead of running the command", () => {
  const card = functionBody(appSource, "function CapabilityMarketCard");

  assert.doesNotMatch(card, /void onRunPackageCommand\(item\.id, command\.name\)/);
  // 2026-09-28 用户要求：能力卡右下角 action 点击只把命令填进 composer，执行留给回车提交。
  assert.match(card, /onRun=\{\(command\) => onInsertPackageCommand\(item\.id, command\)\}/);
  assert.doesNotMatch(card, /runPackageCommand/, "卡片不再直接执行命令");
});

/* --------------------------- context panel search ------------------------- */

test("the context panel has a search box filtering both Skills and Packages", () => {
  const panel = functionBody(appSource, "function ProjectCapabilitiesPanel");

  // 2026-09-20: the panel got more compact (search 32px, sections fold) — assert the search box
  // exists and is still the filtered source, not its old pixel class list.
  assert.match(panel, /<Input\n\s+className="mb-3 h-8 bg-background text-\[13px\]"\n\s+value=\{query\}/);
  assert.match(panel, /placeholder=\{t\("capability\.context\.searchPlaceholder"\)\}/);
  // Both sections filter through the shared pure matcher, not ad-hoc inline rules.
  assert.match(panel, /projectSkills\.filter\(\(item\) => matchesCapabilityQuery\(item, query\)\)/);
  assert.match(panel, /projectPackages\.filter\(\(item\) => matchesCapabilityQuery\(item, query\)\)/);
});

test("the context panel packages expose the same `/` command menu as the page", () => {
  const panel = functionBody(appSource, "function ProjectCapabilitiesPanel");

  assert.match(panel, /onInsertPackageCommand: \(packageId: string, command: string\) => void/);
  assert.match(
    appSource,
    /<ProjectCapabilitiesPanel[\s\S]*?onInsertPackageCommand=\{insertPackageCommandIntoComposer\}[\s\S]*?\/>/,
  );
  assert.match(panel, /<CapabilityCommandMenu\n\s+commands=\{item\.commands\}/);
  // 项目级 package 的 action 同样只填 composer，不再走 async 执行 + busy/error。
  assert.match(panel, /onRun=\{\(command\) => onInsertPackageCommand\(item\.id, command\)\}/);
  assert.doesNotMatch(panel, /onRunPackageCommand/, "项目面板不再直接执行命令");
});

/* --------------- card actions fill the composer, never execute -------------- */

// 2026-09-28 用户要求：Packages 页 / 项目面板右下角 actions（含项目级 package）
// 点击后「直接将命令输入到当前对话的 composer 里」，而不是立刻执行。

test("both capability surfaces hand package actions to the composer filler", () => {
  assert.match(
    appSource,
    /<CapabilitiesPage[\s\S]*?onInsertPackageCommand=\{insertPackageCommandIntoComposer\}[\s\S]*?customUiCancelVersion/,
    "全局 Packages 页的 action 要接 composer 填充器",
  );
  assert.match(
    appSource,
    /<ProjectCapabilitiesPanel[\s\S]*?onInsertPackageCommand=\{insertPackageCommandIntoComposer\}[\s\S]*?\/>/,
    "项目级能力面板的 action 也要接 composer 填充器",
  );
});

test("insertPackageCommandIntoComposer lands `/name ` in the composer, never executes", () => {
  const fill = functionBody(appSource, "function insertPackageCommandIntoComposer");

  assert.match(fill, /kind: "command"/);
  assert.match(fill, /hasArgumentCompletions: Boolean\(command\.hasArgumentCompletions\)/, "带上参数补全标记，填完才会自动弹参数列表");
  assert.match(fill, /insertCommandAtCursor\([\s\S]*?\{ atEnd: true, trailingSpace: false \}/, "从卡片点进来一律追加到末尾，且先不加尾随空格");
  assert.match(fill, /setActiveMainView\("chat"\)/, "在能力页点时先切回对话，composer 才可见");
  assert.doesNotMatch(fill, /runPackageCommand/, "绝不直接执行命令");
  // 用户要求：填进 composer 后光标要真的在 composer 里。
  assert.match(fill, /requestAnimationFrame\(\(\) => \{[\s\S]*?editor\.contains\(document\.activeElement\)[\s\S]*?editor\.focus\(\{ preventScroll: true \}\)/, "下一帧确保光标回到 composer");
});

test("a command inserted from the card waits for the user's space before listing arguments", () => {
  const body = functionBody(appSource, "insertCommandAtCursor");

  // trailingSpace=false 这条分支：不进参数模式，也不拉候选。
  assert.match(body, /\} else if \(!trailingSpace\) \{\n\s+setSlashCommandContext\(null\);\n\s+setSlashArgumentArmed\(false\);\n\s+setShowCapabilityPicker\(false\);/);
  // 用户自己敲下空格后，handleComposerInput 扫到 `/name ` 才会把实例列表拉出来。
  const input = functionBody(appSource, "handleComposerInput");
  assert.match(input, /matchSlashCommandArgs\(triggerText\)/);
});

test("closing the command panel does not yank focus back to the trigger button", () => {
  const menu = functionBody(appSource, "function CapabilityCommandMenu");

  assert.match(menu, /const keepComposerFocus = useRef\(false\)/);
  assert.match(menu, /function run\(name: string\) \{\n\s+keepComposerFocus\.current = true;/);
  assert.match(menu, /onCloseAutoFocus=\{\(event\) => \{[\s\S]*?keepComposerFocus\.current[\s\S]*?event\.preventDefault\(\)/, "Radix 默认 onCloseAutoFocus 会把焦点还给按钮，必须拦掉");
});

test("insertCommandAtCursor appends at the end when asked and keeps a separating space", () => {
  const insert = functionBody(appSource, "function insertCommandAtCursor");

  // 从卡片进来时按钮持有焦点，composer 缓存的选区可能过时 —— 不能再读它。
  assert.match(insert, /if \(!options\?\.atEnd\) \{\n\s+rememberComposerSelection\(\);/);
  assert.match(insert, /let range = options\?\.atEnd \? null : composerSelectionRef\.current\?\.cloneRange\(\)/);
  // 已有文本时补一个空格，避免接成 `note/mcp`。
  assert.match(insert, /const separator = beforeText\.length > 0 && !\/\\s\$\/u\.test\(beforeText\) \? " " : ""/);
  assert.match(insert, /`\$\{separator\}\//);
});

/* --------------------- context panel scope affordance ---------------------- */

// 面板的两个 section 叫 Skills / Packages，和全局页同名，光看标题分不出范围。
// 2026-09-21 用户反馈：「skills 和 packages 要有办法让用户知道这是项目级的」。

test("the context panel labels its scope above the search box", () => {
  const panel = functionBody(appSource, "function ProjectCapabilitiesPanel");

  // 一行常驻的「项目级」徽标 + 项目名，紧跟一句来源提示，然后才是搜索框。
  assert.match(
    panel,
    /\{t\("capability\.context\.scopeBadge"\)\}[\s\S]{0,240}projectName[\s\S]{0,240}\{t\("capability\.context\.scopeHint"\)\}[\s\S]{0,160}<Input/,
    "scope 行必须在搜索框之前渲染",
  );
  assert.match(panel, /projectName: string;/);
});

test("the panel's scope line names the project it belongs to", () => {
  assert.match(
    appSource,
    /<ProjectCapabilitiesPanel\n\s+capabilities=\{capabilities\}\n\s+projectName=\{activeProject\.name\}/,
  );
});

test("both language packs carry the scope copy and name the .pi source", () => {
  for (const [pack, source] of [
    ["zh", zhSource],
    ["en", enSource],
  ] as const) {
    for (const key of ["scopeBadge", "scopeHint", "scopeHintTitle"]) {
      assert.match(source, new RegExp(`"capability\\.context\\.${key}"`), `${pack} 缺 ${key}`);
    }
    assert.match(source, /"capability\.context\.scopeHint": "[^"]*\.pi[^"]*"/, `${pack} 的提示要写清来源是 .pi`);
  }
});

/* ------------------------- query matcher (pure) --------------------------- */

test("matchesCapabilityQuery searches name, description, source and path", () => {
  const pkg = { name: "meegle", description: "飞书项目操作", source: "npm:@scope/meegle" };
  const skill = { name: "docx", description: "Word 文档", path: "/Users/x/.pi/agent/skills/docx" };

  assert.equal(matchesCapabilityQuery(pkg, "meegle"), true);
  assert.equal(matchesCapabilityQuery(pkg, "飞书项目"), true);
  assert.equal(matchesCapabilityQuery(pkg, "npm:@scope"), true);
  assert.equal(matchesCapabilityQuery(skill, "agent/skills"), true);
  assert.equal(matchesCapabilityQuery(pkg, "不存在"), false);
});

test("matchesCapabilityQuery is case-insensitive and an empty query matches everything", () => {
  const pkg = { name: "Meegle", description: "Feishu project" };

  assert.equal(matchesCapabilityQuery(pkg, "meegle"), true);
  assert.equal(matchesCapabilityQuery(pkg, "FEISHU Project"), true);
  assert.equal(matchesCapabilityQuery(pkg, ""), true);
  assert.equal(matchesCapabilityQuery(pkg, "   "), true);
  assert.equal(matchesCapabilityQuery({ name: "x" }, ""), true);
});

function functionBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} not found`);
  // Skip the parameter list first: `function f({ a = 1 }: X) {` would otherwise
  // make the first `{` the destructured parameters and cut the body in half.
  let parenDepth = 0;
  let i = start + marker.length;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "{" && parenDepth === 0) break;
  }
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${marker}: unbalanced braces`);
}
