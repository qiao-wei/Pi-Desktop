/**
 * Composer "/" autocomplete (slash menu).
 *
 * Behavior tests run against the real pure module (src/features/chat/slashMenu.ts).
 * The App wiring is asserted structurally, but every structural assertion is
 * scoped to the exact function body it claims (indexOf + slice, never a whole-file
 * match — a same-looking line elsewhere must not satisfy it).
 */
import assert from "node:assert/strict";

import test from "node:test";

import {
  buildSlashMenuItems,
  findBuiltinCommand,
  findSlashCommand,
  applyManualSkillCommand,
  matchManualSkillCommand,
  matchSlashCommandArgs,
  matchSlashTrigger,
  moveHighlight,
  findSlashStart,
  readTriggerText,
  SLASH_MENU_LIMIT,
  type SlashMenuItem,
  type CapabilitiesLike,
  type TriggerTextNode,
} from "../src/features/chat/slashMenu.ts";

const appSourceText = readAppSource();

/** Extract the body of a named function: skip the parameter list first, then
 *  count braces (a destructured `function F({ a }: P) {}` param would otherwise
 *  be mistaken for the body). */
function functionBody(source: string, name: string): string {
  const declaration = source.indexOf(`function ${name}`);
  assert.notEqual(declaration, -1, `function ${name} not found`);
  const openParen = source.indexOf("(", declaration);
  assert.notEqual(openParen, -1);
  let parenDepth = 0;
  let cursor = openParen;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") parenDepth += 1;
    if (source[cursor] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const openBrace = source.indexOf("{", cursor);
  assert.notEqual(openBrace, -1);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace, index + 1);
      }
    }
  }
  assert.fail(`function ${name} body never closes`);
}

/* --------------------------------------------------------------- fixtures */

const capabilities: CapabilitiesLike = {
  skills: [
    {
      id: "s1",
      kind: "skill",
      name: "browser-skill",
      description: "Browser automation",
      active: false,
    },
    { id: "s2", kind: "skill", name: "zskill", description: "Active one", active: true },
    { id: "s3", kind: "skill", name: "alpha", description: "Alpha skill", active: false },
  ],
  packages: [
    {
      id: "p1",
      kind: "package",
      name: "OpenAPI Tools",
      description: "OpenAPI helpers",
      commands: [
        { name: "openapi-fields", description: "Discover OpenAPI fields" },
        { name: "openapi-check", description: undefined },
      ],
    },
    {
      id: "p2",
      kind: "package",
      name: "Doc Pack",
      description: "Document helpers",
      commands: [{ name: "doc-lint", description: "Lint documents" }],
    },
  ],
};

/* ------------------------------------------------------- matchSlashTrigger */

test("matchSlashTrigger: bare slash at start opens with empty query", () => {
  assert.equal(matchSlashTrigger("/"), "");
});

test("matchSlashTrigger: slash after whitespace with query", () => {
  assert.equal(matchSlashTrigger("hey /ope"), "ope");
  assert.equal(matchSlashTrigger("/ope"), "ope");
});

test("matchSlashTrigger: slash mid-word does not trigger", () => {
  assert.equal(matchSlashTrigger("abc/def"), null);
  assert.equal(matchSlashTrigger("hello world"), null);
  assert.equal(matchSlashTrigger(""), null);
});

test("matchSlashTrigger: query cannot contain whitespace or another slash", () => {
  assert.equal(matchSlashTrigger("/ope n"), null);
  assert.equal(matchSlashTrigger("/ope/n"), null);
});

test("matchSlashTrigger: zero-width caret marker is ignored", () => {
  assert.equal(matchSlashTrigger("/ope​"), "ope");
});

/* ----------------------------------------------------- buildSlashMenuItems */

test("buildSlashMenuItems: empty query lists all skills and all package commands, skills first", () => {
  const items = buildSlashMenuItems(capabilities, "");
  assert.equal(items.filter((item) => item.kind === "skill").length, 3);
  assert.equal(items.filter((item) => item.kind === "command").length, 3);
  assert.equal(items[0].kind, "skill");
  assert.equal(items[items.length - 1].kind, "command");
});

test("buildSlashMenuItems: filters skills by name and description", () => {
  const items = buildSlashMenuItems(capabilities, "brow");
  assert.deepEqual(items, [
    {
      kind: "skill",
      id: "s1",
      name: "browser-skill",
      description: "Browser automation",
      active: false,
    },
  ]);

  const byDescription = buildSlashMenuItems(capabilities, "automation");
  assert.equal(byDescription.length, 1);
  assert.equal(byDescription[0].kind, "skill");
});

test("buildSlashMenuItems: filters commands by command name, package name and description", () => {
  const byCommand = buildSlashMenuItems(capabilities, "doc-lint");
  assert.deepEqual(
    byCommand.map((item) => (item.kind === "command" ? item.name : item.kind)),
    ["doc-lint"],
  );

  const byPackage = buildSlashMenuItems(capabilities, "openapi");
  assert.ok(byPackage.every((item) => item.kind === "command"));
  assert.equal(byPackage.length, 2);

  const byDescription = buildSlashMenuItems(capabilities, "discover");
  assert.equal(byDescription.length, 1);
  assert.equal(byDescription[0].kind, "command");
});

test("buildSlashMenuItems: skills sort active first, then by name; commands sort by name", () => {
  const items = buildSlashMenuItems(capabilities, "");
  const skillNames = items
    .filter((item): item is Extract<SlashMenuItem, { kind: "skill" }> => item.kind === "skill")
    .map((item) => item.name);
  assert.deepEqual(skillNames, ["zskill", "alpha", "browser-skill"]);

  const commandNames = items
    .filter((item): item is Extract<SlashMenuItem, { kind: "command" }> => item.kind === "command")
    .map((item) => item.name);
  assert.deepEqual(commandNames, ["doc-lint", "openapi-check", "openapi-fields"]);
});

test("buildSlashMenuItems: command description falls back to the package description", () => {
  const items = buildSlashMenuItems(capabilities, "");
  const fallback = items.find((item) => item.kind === "command" && item.name === "openapi-check");
  assert.ok(fallback && fallback.kind === "command");
  assert.equal(fallback.description, "OpenAPI helpers");
  assert.equal(fallback.packageName, "OpenAPI Tools");
});

test("buildSlashMenuItems: result is capped at SLASH_MENU_LIMIT per section", () => {
  const manySkills: CapabilitiesLike = {
    skills: Array.from({ length: 60 }, (_, index) => ({
      id: `s${index}`,
      kind: "skill" as const,
      name: `skill-${index}`,
      description: "",
      active: false,
    })),
    packages: capabilities.packages,
  };
  const items = buildSlashMenuItems(manySkills, "");
  // 47 个技能也不能把指令挤出菜单：每个分组各自截断。
  assert.equal(items.filter((item) => item.kind === "skill").length, SLASH_MENU_LIMIT);
  assert.equal(items.filter((item) => item.kind === "command").length, 3);

  const manyCommands: CapabilitiesLike = {
    skills: [],
    packages: [
      {
        id: "p",
        name: "P",
        description: "",
        commands: Array.from({ length: 60 }, (_, index) => ({
          name: `cmd-${index}`,
          description: "",
        })),
      },
    ],
  };
  const commandOnly = buildSlashMenuItems(manyCommands, "");
  assert.equal(commandOnly.length, SLASH_MENU_LIMIT);
});

test("buildSlashMenuItems: prefix matches rank first so '/end' lands on end-review", () => {
  // 真实场景：/end 也命中描述里含 "end" 的无关技能（attendance/calendar…），
  // 高亮必须落在名字以 end 开头的命令上，而不是让用户多打一个 "-"。
  const fixture: CapabilitiesLike = {
    skills: [
      { id: "s1", name: "lark-attendance", description: "考勤打卡记录", active: true },
      { id: "s2", name: "zskill", description: "the record ends here", active: false },
    ],
    packages: [
      {
        id: "p1",
        name: "@earendil-works/pi-review",
        description: "review tools",
        commands: [
          // blend-check 字母序在 end-review 之前，但只是名字包含 "end"（rank 1）；
          // 若排序不考虑 rank，它会被排到 prefix 命中的 end-review 前面。
          { name: "blend-check", description: "" },
          { name: "end-review", description: "Complete review" },
        ],
      },
    ],
  };
  const items = buildSlashMenuItems(fixture, "end");
  const first = items[0];
  assert.ok(
    first?.kind === "command" && first.name === "end-review",
    `first item should be end-review, got ${JSON.stringify(items[0])}`,
  );
  assert.ok(
    items[1]?.kind === "command" && items[1]?.name === "blend-check",
    `second should be blend-check, got ${JSON.stringify(items[1])}`,
  );

  // 名字包含 > 描述包含
  const ranked = buildSlashMenuItems(
    {
      skills: [
        { id: "a", name: "alpha", description: "contains needle-word here", active: false },
        { id: "b", name: "needle-tool", description: "", active: false },
      ],
      packages: [],
    },
    "needle",
  );
  assert.equal(ranked[0]?.name, "needle-tool");
  assert.equal(ranked[1]?.name, "alpha");
});

/* ------------------------------------------------- matchSlashCommandArgs */

test("matchSlashCommandArgs: whole-line /command and /command args", () => {
  assert.deepEqual(matchSlashCommandArgs("/review"), { name: "review", prefix: "" });
  assert.deepEqual(matchSlashCommandArgs("/end-review focus on tests"), {
    name: "end-review",
    prefix: "focus on tests",
  });
  // `/review ` 里的空格只是分隔符（prefix 为空）；但 `/mcp disable ` 的尾随空格要保留，
  // 因为扩展靠它区分下一级 token（server 实例列表）。
  assert.deepEqual(matchSlashCommandArgs("/review "), { name: "review", prefix: "" });
  assert.deepEqual(matchSlashCommandArgs("/mcp disable "), { name: "mcp", prefix: "disable " });
  // 多空格同样保留在参数前缀里（getArgumentCompletions 收到的就是这段）。
  assert.deepEqual(matchSlashCommandArgs("/review  a b"), { name: "review", prefix: " a b" });
});

test("matchSlashCommandArgs: only a leading slash counts, and args stay on one line", () => {
  assert.equal(matchSlashCommandArgs("run /review"), null);
  assert.equal(matchSlashCommandArgs(""), null);
  assert.equal(matchSlashCommandArgs("/"), null);
  assert.equal(matchSlashCommandArgs("/a/b"), null);
  assert.equal(matchSlashCommandArgs("/review\nmore"), null);
});

test("matchSlashCommandArgs: zero-width caret markers are ignored", () => {
  assert.deepEqual(matchSlashCommandArgs("\u200b/review x"), { name: "review", prefix: "x" });
});

/* ------------------------------------------------------- findSlashCommand */

test("findSlashCommand: resolves a loaded command to its package and completion support", () => {
  const fixture: CapabilitiesLike = {
    skills: [],
    packages: [
      {
        id: "p1",
        name: "Review Pack",
        description: "",
        commands: [
          { name: "end-review", description: "Finish review", hasArgumentCompletions: true },
          { name: "plain", description: undefined },
        ],
      },
      { id: "p2", name: "Other", description: "Other pack", commands: [{ name: "go" }] },
    ],
  };
  assert.deepEqual(findSlashCommand(fixture, "end-review"), {
    packageId: "p1",
    packageName: "Review Pack",
    name: "end-review",
    description: "Finish review",
    hasArgumentCompletions: true,
  });
  // 无描述时回退包描述；未注册补全时为 false。
  assert.deepEqual(findSlashCommand(fixture, "plain"), {
    packageId: "p1",
    packageName: "Review Pack",
    name: "plain",
    description: "",
    hasArgumentCompletions: false,
  });
  assert.equal(findSlashCommand(fixture, "missing"), null);
});

test("buildSlashMenuItems: command items carry hasArgumentCompletions", () => {
  const fixture: CapabilitiesLike = {
    skills: [],
    packages: [
      {
        id: "p",
        name: "P",
        description: "",
        commands: [{ name: "with-args", hasArgumentCompletions: true }, { name: "without-args" }],
      },
    ],
  };
  const items = buildSlashMenuItems(fixture, "");
  const withArgs = items.find((item) => item.kind === "command" && item.name === "with-args");
  const withoutArgs = items.find((item) => item.kind === "command" && item.name === "without-args");
  assert.equal(withArgs?.kind === "command" && withArgs.hasArgumentCompletions, true);
  assert.equal(withoutArgs?.kind === "command" && withoutArgs.hasArgumentCompletions, false);
});

/* ------------------------------------------------- pi 内置命令（/reload） */

const withBuiltins: CapabilitiesLike = {
  ...capabilities,
  builtinCommands: [
    {
      name: "reload",
      description: "Reload extensions, skills, prompts, themes, and context files",
    },
  ],
};

test("buildSlashMenuItems: built-in commands come first on an empty query", () => {
  const items = buildSlashMenuItems(withBuiltins, "");
  assert.equal(items[0].kind, "builtin");
  assert.equal(items[0].kind === "builtin" && items[0].name, "reload");
  // 技能/包命令照旧都在，不能被内置项挤掉。
  assert.equal(items.filter((item) => item.kind === "skill").length, 3);
  assert.equal(items.filter((item) => item.kind === "command").length, 3);
});

test("buildSlashMenuItems: built-ins rank by name/description and filter like the rest", () => {
  assert.deepEqual(
    buildSlashMenuItems(withBuiltins, "relo").map((item) =>
      item.kind === "builtin" ? item.name : item.kind,
    ),
    ["reload"],
  );
  assert.equal(buildSlashMenuItems(withBuiltins, "themes")[0].kind, "builtin");
  assert.equal(buildSlashMenuItems(withBuiltins, "zzz").length, 0);
});

test("findBuiltinCommand: only the shipped, executable subset resolves", () => {
  assert.equal(findBuiltinCommand(withBuiltins, "reload")?.name, "reload");
  // 未登记的内置命令（如 /model）服务端不下发，绝不当作可执行命令。
  assert.equal(findBuiltinCommand(withBuiltins, "model"), null);
  assert.equal(findBuiltinCommand({}, "reload"), null);
});

/* ------------------------------------------------------------ moveHighlight */

test("moveHighlight wraps around at both ends", () => {
  assert.equal(moveHighlight(0, 1, 3), 1);
  assert.equal(moveHighlight(2, 1, 3), 0);
  assert.equal(moveHighlight(0, -1, 3), 2);
  assert.equal(moveHighlight(1, -1, 3), 0);
  assert.equal(moveHighlight(0, 1, 0), 0);
});

/* --------------------------------------------------------- readTriggerText */

const TEXT = 3;
const ELEMENT = 1;

function textNode(value: string): TriggerTextNode {
  return { nodeType: TEXT, textContent: value };
}

function elementNode(
  children: TriggerTextNode[],
  dataset?: Record<string, string | undefined>,
): TriggerTextNode {
  return { nodeType: ELEMENT, childNodes: children, dataset };
}

const ZERO_WIDTH = "\u200b";

// 徽章 span 结构近似 createCapabilityBadgeNode / createAttachmentBadgeNode。
const badge = (kind: "capability" | "attachment", inner: string): TriggerTextNode =>
  elementNode(
    [textNode(inner)],
    kind === "capability"
      ? { capabilityId: "s1", capabilityKind: "skill" }
      : { attachmentId: "a1" },
  );

test("readTriggerText: text after a badge triggers like after a space", () => {
  const editor = elementNode([
    badge("capability", `Sbrowser-skillSkill×`),
    textNode(ZERO_WIDTH),
    textNode("/e"),
  ]);
  const text = readTriggerText(editor);
  assert.equal(text, `${ZERO_WIDTH}/e`);
  assert.equal(matchSlashTrigger(text), "e");
});

test("readTriggerText: attachment badges and nested elements are handled", () => {
  const editor = elementNode([
    textNode("note "),
    badge("attachment", "photo.png×"),
    elementNode([textNode("tail ")]),
    textNode("/"),
  ]);
  // 徽章内部文字被跳过，非徽章元素的子文本保留。
  assert.equal(readTriggerText(editor), `note tail /`);
});

test("readTriggerText: badge between words keeps the slash mid-word", () => {
  const editor = elementNode([textNode("abc"), badge("capability", "SxSkill×"), textNode("/e")]);
  assert.equal(matchSlashTrigger(readTriggerText(editor)), null);
});

/* --------------------------------------------------------- pasteSanitize */

import { htmlToSanitizedMarkup, type SanitizeNode } from "../src/features/chat/pasteSanitize.ts";
import { appSource as readAppSource } from "./lib/appSource.ts";
import { bridgeSource } from "./lib/bridgeSource.ts";

function el(name: string, children: SanitizeNode[] = [], text?: string): SanitizeNode {
  return { nodeName: name, childNodes: children, textContent: text };
}

const text = (value: string): SanitizeNode => ({ nodeName: "#text", textContent: value });

test("htmlToSanitizedMarkup: table is flattened to lines, cells space-joined", () => {
  const table = el("TABLE", [
    el("TBODY", [
      el("TR", [el("TD", [text("模型级别")]), el("TD", [text("思考表现")])]),
      el("TR", [el("TD", [el("B", [text("Qwen-Max")])]), el("TD", [text("旗舰主力\n第二行")])]),
    ]),
  ]);
  const markup = htmlToSanitizedMarkup(el("BODY", [table]));
  // 表格完全拍平：单元格内只留文本（样式一并去掉），行间 <br>、单元格空格分隔。
  assert.equal(markup, "模型级别  思考表现<br>Qwen-Max  旗舰主力 第二行");
});

test("htmlToSanitizedMarkup: keeps b/i/u/code, drops spans, styles and scripts", () => {
  const markup = htmlToSanitizedMarkup(
    el("BODY", [
      el("P", [
        el(
          "SPAN",
          [text("plain "), el("STRONG", [text("bold")]), text(" "), el("EM", [text("italic")])],
          undefined,
        ),
      ]),
      el("SCRIPT", [text("alert(1)")]),
      el("STYLE", [text(".x{color:red}")]),
    ]),
  );
  assert.equal(markup, "plain <b>bold</b> <i>italic</i>");
});

test("htmlToSanitizedMarkup: block boundaries and br become line breaks, excess collapsed", () => {
  const markup = htmlToSanitizedMarkup(
    el("BODY", [
      el("DIV", [text("line1")]),
      el("DIV", [text("line2"), el("BR"), text("line3")]),
      el("DIV", [el("BR"), el("BR"), el("BR"), text("after")]),
    ]),
  );
  assert.equal(markup, "line1<br>line2<br>line3<br><br>after");
});

test("htmlToSanitizedMarkup: leading and trailing breaks are trimmed", () => {
  const markup = htmlToSanitizedMarkup(
    el("BODY", [el("DIV", [el("BR")]), el("DIV", [text("only")])]),
  );
  assert.equal(markup, "only");
});

/* ------------------------------------------------- App wiring (structural) */

test("App: composer input does two-phase detection — /query then /command args", () => {
  const body = functionBody(appSourceText, "handleComposerInput");
  assert.match(body, /const query = matchSlashTrigger\(triggerText\)/);
  assert.match(body, /const commandArgs = editor \? matchSlashCommandArgs\(triggerText\) : null/);
  assert.match(body, /findSlashCommand\(capabilities, commandArgs\.name\)/);
  assert.match(body, /setShowCapabilityPicker\(true\)/);
  // 命令名阶段先于参数阶段；参数阶段只在命令真的注册了补全时切换菜单。
  const queryBranch = body.indexOf("if (query != null)");
  const argsBranch = body.indexOf("commandArgs && command?.hasArgumentCompletions");
  assert.ok(queryBranch !== -1 && argsBranch !== -1 && queryBranch < argsBranch);
});

test("App: keydown intercepts arrows, Tab and enter only while the menu is open", () => {
  const body = functionBody(appSourceText, "handleComposerKeyDown");
  const guard = body.indexOf("if (showCapabilityPicker)");
  assert.ok(guard !== -1, "slash handling must be gated on the menu being open");
  assert.ok(guard < body.indexOf("removeAttachmentBeforeCaret()"), "slash handling comes first");
  assert.match(body, /ArrowDown/);
  assert.match(body, /ArrowUp/);
  assert.match(body, /moveHighlight\(current, 1, slashItems\.length\)/);
  assert.match(body, /moveHighlight\(current, -1, slashItems\.length\)/);
  // Tab / Enter 都只把选中项落进编辑器（命令不执行）。
  const tabBranch = body.indexOf('event.key === "Tab"');
  const enterBranch = body.indexOf('event.key === "Enter" && !event.shiftKey');
  assert.ok(tabBranch !== -1 && enterBranch !== -1 && tabBranch < enterBranch);
  assert.equal(
    (body.match(/selectSlashItem\(item\)/g) ?? []).length,
    2,
    "Tab 和 Enter 的默认分支都只 select",
  );
  assert.doesNotMatch(body, /runPackageCommand/);
  assert.match(body, /!event\.nativeEvent\.isComposing/);
});

test("App: unarmed argument menu submits the command on Enter; arrows/click arm selection", () => {
  const body = functionBody(appSourceText, "handleComposerKeyDown");
  // 参数菜单弹出但用户没动过选择 → 回车直接提交（参数可空）。
  assert.match(body, /if \(item\?\.kind === "argument" && !slashArgumentArmed\)/);
  const submitBranch = body.indexOf('if (item?.kind === "argument" && !slashArgumentArmed)');
  const submit = body.indexOf("requestSubmit()");
  assert.ok(submitBranch !== -1 && submit !== -1 && submitBranch < submit);
  // ↑↓ 才把选择“武装”起来；第一次 ↓/↑ 分别落到首项/末项（默认无高亮）。
  assert.equal((body.match(/setSlashArgumentArmed\(true\)/g) ?? []).length, 2);
  assert.match(body, /if \(argumentMenu && !slashArgumentArmed\)/);
  assert.match(body, /setSlashHighlight\(slashItems\.length - 1\)/);
});

test("App: enter selection must come before form submit", () => {
  const keyDown = functionBody(appSourceText, "handleComposerKeyDown");
  const selectIndex = keyDown.indexOf("selectSlashItem(item)");
  const submitIndex = keyDown.indexOf("requestSubmit()");
  assert.ok(selectIndex !== -1 && submitIndex !== -1 && selectIndex < submitIndex);
});

test("App: menu renders grouped items with the live highlight and selection handler", () => {
  const renderIndex = appSourceText.indexOf("<SlashMenu\n");
  assert.notEqual(renderIndex, -1, "SlashMenu must be rendered");
  const renderBlock = appSourceText.slice(renderIndex, renderIndex + 400);
  assert.match(renderBlock, /items=\{slashItems\}/);
  assert.match(renderBlock, /highlightIndex=\{visibleSlashHighlight\}/);
  assert.match(renderBlock, /onSelect=\{selectSlashItem\}/);

  const menuBody = functionBody(appSourceText, "SlashMenu");
  // 分组标题/占位文案走 i18n（zh 基准包的措辞在 i18n.test.ts 里锁），这里只钉接线。
  assert.match(menuBody, /renderSection\("capability\.slashMenu\.skills", skills\)/);
  assert.match(menuBody, /renderSection\("capability\.slashMenu\.commands", commands\)/);
  assert.match(menuBody, /renderSection\("capability\.slashMenu\.builtins", builtins\)/);
  assert.match(menuBody, /aria-label=\{t\("capability\.slashMenu\.aria"\)\}/);
  assert.match(menuBody, /t\("capability\.slashMenu\.empty"\)/);
  assert.doesNotMatch(menuBody, /技能 \(/, "硬编码中文分组标题应已移入语言包");
});

test("App: slash removal covers the full /query, not just a bare slash", () => {
  const body = functionBody(appSourceText, "removeSlashBeforeRange");
  // 定位逻辑抽到了纯函数 findSlashStart（对零宽标记不可见），这里只验接线。
  assert.match(body, /findSlashStart\(text\.slice\(0, range\.startOffset\)\)/);
  assert.ok(!body.includes('before.endsWith("/")'), "legacy single-char removal must not survive");
});

test("App: paste sanitizes rich HTML and preserves newlines for plain text", () => {
  const body = functionBody(appSourceText, "handlePaste");
  assert.match(body, /htmlToSanitizedMarkup\(parsedBody\(html\), \{ badges \}\)/);
  assert.match(body, /insertPastedMarkup\(markup, badges\)/);
  // 纯文本路径：换行转 <br>，避免浏览器默认粘贴丢结构。
  assert.match(body, /escapeHtml\(plain\)\.replaceAll\("\\n", "<br>"\)/);
  assert.match(body, /event\.preventDefault\(\)/);
});

test("App: submission serialization keeps line breaks from br and block boundaries", () => {
  const append = functionBody(appSourceText, "appendComposerParts");
  assert.match(append, /tagName === "BR" \|\| COMPOSER_BLOCK_TAGS\.has\(tagName\)/);
  assert.match(append, /kind: "text", text: "\\n"/);

  const read = functionBody(appSourceText, "readComposerParts");
  assert.match(read, /normalizeComposerTextParts\(compactComposerParts\(parts\)\)/);

  const normalize = functionBody(appSourceText, "normalizeComposerTextParts");
  assert.match(normalize, /\\n\{3,\}/); // collapse runs of 3+ newlines
  assert.match(normalize, /\\s\+\$\/u/);
});

test("App: deleting an attachment dismisses its hover preview card", () => {
  // 徽章移除时 mouseleave 不会触发，必须主动收预览卡，否则悬浮大图残留。
  assert.match(functionBody(appSourceText, "removeAttachment"), /hideAttachmentHover\(\)/);
  assert.match(functionBody(appSourceText, "clearComposer"), /hideAttachmentHover\(\)/);
});

/* ------------------------------------------------------------- findSlashStart */

test("findSlashStart: plain and whitespace-prefixed slashes", () => {
  assert.equal(findSlashStart("/"), 0);
  assert.equal(findSlashStart("/end"), 0);
  assert.equal(findSlashStart("a /end"), 2);
  assert.equal(findSlashStart("hey /"), 4);
});

test("findSlashStart: zero-width caret marker before the slash is skipped", () => {
  // 选完技能后的真实形态：光标标记和打的 / 在同一个文本节点里。
  assert.equal(findSlashStart("\u200b/"), 1);
  assert.equal(findSlashStart("\u200b/end"), 1);
  assert.equal(findSlashStart("a \u200b/end"), 3);
});

test("findSlashStart: mid-word slash and empty text find nothing", () => {
  assert.equal(findSlashStart("abc/e"), null);
  assert.equal(findSlashStart(""), null);
  assert.equal(findSlashStart("no slash"), null);
});

test("App: selecting a command item only inserts /name — never executes", () => {
  const select = functionBody(appSourceText, "selectSlashItem");
  assert.doesNotMatch(select, /runPackageCommand/, "菜单点选/回车不得直接执行命令");
  assert.match(select, /insertCommandAtCursor\(item\)/);
  const insert = functionBody(appSourceText, "insertCommandAtCursor");
  assert.doesNotMatch(insert, /runPackageCommand/);
});

test("App: Tab/Enter completing a command drops /name text and opens arg completion", () => {
  const body = functionBody(appSourceText, "insertCommandAtCursor");
  assert.match(body, /const trailingSpace = options\?\.trailingSpace \?\? true/);
  assert.match(
    body,
    /document\.createTextNode\(`\$\{separator\}\/\$\{item\.name\}\$\{trailingSpace \? " " : ""\}`\)/,
  );
  assert.match(body, /removeSlashBeforeRange\(range\)/);
  assert.match(body, /if \(trailingSpace && item\.hasArgumentCompletions\)/);
  assert.match(
    body,
    /setSlashCommandContext\(\{ packageId: item\.packageId, name: item\.name, prefix: "" \}\)/,
  );
});

test("App: applying an argument candidate appends a space and chains the next level", () => {
  const body = functionBody(appSourceText, "applyArgumentCompletion");
  assert.match(body, /lastIndexOf\(`\/\$\{context\.name\}`\)/);
  assert.match(body, /const trailing = \/\\s\$\/u\.test\(item\.value\) \? "" : " "/);
  assert.match(body, /const replacement = `\/\$\{context\.name\} \$\{item\.value\}\$\{trailing\}`/);
  // 下一级候选（实例列表）用「已填入的值 + 空格」重新拉。
  assert.match(
    body,
    /setSlashCommandContext\(\{ packageId: context\.packageId, name: context\.name, prefix: `\$\{item\.value\} ` \}\)/,
  );
  assert.match(body, /setShowCapabilityPicker\(false\)/);
});

test("App: form submit dispatches an exact known package command instead of chatting", () => {
  const body = functionBody(appSourceText, "handleSubmit");
  // 命令识别跑在提示词文本（promptText）上：`/skill:<名字>` 已被解析成技能徽标，
  // 剩下的字才是命令候选，所以这里不会再看到 `/skill:` 前缀。
  assert.match(body, /const submittedCommand = matchSlashCommandArgs\(promptText\)/);
  assert.match(body, /const slashCommand = submittedCommand && !builtinCommand/);
  assert.match(body, /findSlashCommand\(capabilities, submittedCommand\.name\)/);
  assert.match(
    body,
    /runPackageCommand\(slashCommand\.packageId, slashCommand\.name, submittedCommand\?\.prefix \?\? ""\)/,
  );
  // 派发必须发生在聊天提交（submitTurn）之前，且不走 canSubmitPrompt 的模型门槛。
  const dispatch = body.indexOf("matchSlashCommandArgs(promptText)");
  const chatSubmit = body.indexOf("submitTurn(promptText");
  const modelGate = body.indexOf("if (!canSubmitPrompt)");
  assert.ok(dispatch !== -1 && chatSubmit !== -1 && modelGate !== -1);
  assert.ok(dispatch < modelGate && dispatch < chatSubmit);
});

test("App: form submit dispatches a known built-in command to /api/builtin-command", () => {
  const body = functionBody(appSourceText, "handleSubmit");

  assert.match(
    body,
    /const builtinCommand = submittedCommand \? findBuiltinCommand\(capabilities, submittedCommand\.name\) : null/,
  );
  // 内置命令优先于同名包命令（和 pi 一样，内置遮蔽扩展命令）。
  assert.match(body, /const slashCommand = submittedCommand && !builtinCommand/);
  assert.match(
    body,
    /runBuiltinCommand\(builtinCommand!\.name, submittedCommand\?\.prefix \?\? ""\)/,
  );
  // `!manualSkill` 是手打 `/skill:<名字>` 的闸：那是技能调用，不是扩展/内置命令，
  // 不能被同名包命令抢走（见 matchManualSkillCommand）。
  assert.match(body, /if \(\s*!manualSkill\s*&& \(slashCommand \|\| builtinCommand\)/);
  // 同样在 submitTurn 之前、不走模型门槛。
  const dispatch = body.indexOf("findBuiltinCommand(capabilities");
  assert.ok(dispatch !== -1 && dispatch < body.indexOf("submitTurn(promptText"));
});

test("App: argument items render in their own labeled section", () => {
  const menuBody = functionBody(appSourceText, "SlashMenu");
  assert.match(menuBody, /renderSection\("capability\.slashMenu\.arguments", argumentEntries\)/);
  assert.match(menuBody, /item\.kind === "argument" \? item\.label : item\.name/);
  assert.match(menuBody, /t\("capability\.slashMenu\.argumentHint"\)/);
});

test("App: unarmed argument menu renders no active row", () => {
  assert.match(
    appSourceText,
    /const visibleSlashHighlight = slashItems\[0\]\?\.kind === "argument" && !slashArgumentArmed \? -1 : activeSlashIndex;/,
  );
});

test("App: command menu shows the Tab/Enter hint", () => {
  const menuBody = functionBody(appSourceText, "SlashMenu");
  assert.match(menuBody, /t\("capability\.slashMenu\.commandHint"\)/);
  assert.match(
    menuBody,
    /commands\.length \|\| builtins\.length \? <p className="slash-menu-hint"/,
  );
});

test("App: selecting a skill keeps the badge + session-enable path", () => {
  const body = functionBody(appSourceText, "selectSlashItem");
  const skillBranch = body.indexOf('item.kind === "skill"');
  assert.ok(skillBranch !== -1);
  assert.match(body, /insertCapabilityAtCursor\(/);
});

/* ------------------------------------------- 手打 /skill:<name>（TUI 语义） */

test("matchManualSkillCommand: 名字后的文字是参数，名字精确命中", () => {
  const skills = capabilities.skills;
  assert.deepEqual(matchManualSkillCommand("/skill:alpha 帮我看一下这个方案", skills), {
    capability: {
      id: "s3",
      kind: "skill",
      name: "alpha",
      description: "Alpha skill",
      active: false,
    },
    args: "帮我看一下这个方案",
  });
  // 无参数（TUI 的 `/skill:name`）：args 是空串，正文由服务端顶在最前面。
  assert.equal(matchManualSkillCommand("/skill:alpha", skills)?.args, "");
  assert.equal(matchManualSkillCommand("/skill:alpha\nsecond line", skills)?.args, "second line");
});

test("matchManualSkillCommand: 打错的名字 / 别的斜杠命令原样落空（和 pi 一样 fall through）", () => {
  const skills = capabilities.skills;
  assert.equal(
    matchManualSkillCommand("/skill:alp", skills),
    null,
    "不做前缀匹配：pi 只认精确名字",
  );
  assert.equal(matchManualSkillCommand("/skill:ALPHA", skills), null, "大小写不同就是另一个命令");
  assert.equal(matchManualSkillCommand("/skill:", skills), null);
  assert.equal(matchManualSkillCommand("/ope", skills), null);
  assert.equal(matchManualSkillCommand("请看 /skill:alpha", skills), null, "必须是消息开头");
  assert.equal(matchManualSkillCommand("/skill:alpha", []), null, "技能没加载时不认识这个名字");
});

test("matchManualSkillCommand: 零宽占位符（光标标记）不参与匹配", () => {
  assert.equal(
    matchManualSkillCommand("/skill:alpha\u200b", capabilities.skills)?.capability.name,
    "alpha",
  );
});

test("applyManualSkillCommand: 翻译成徽标 + args，其它徽标/附件原样保留", () => {
  const parts = [
    { kind: "attachment", attachmentId: "att-1" },
    { kind: "text", text: "/skill:alpha 帮我看一下" },
  ];
  const applied = applyManualSkillCommand("/skill:alpha 帮我看一下", capabilities.skills, parts);
  assert.equal(applied.matched, true);
  assert.equal(applied.text, "帮我看一下");
  assert.deepEqual(applied.parts, [
    { kind: "attachment", attachmentId: "att-1" },
    {
      kind: "capability",
      capability: {
        id: "s3",
        kind: "skill",
        name: "alpha",
        description: "Alpha skill",
        active: false,
      },
    },
    { kind: "text", text: "帮我看一下" },
  ]);
});

test("applyManualSkillCommand: 无参数时不补 text 段；同一个技能已挂徽标时不重复挂", () => {
  const bare = applyManualSkillCommand("/skill:alpha", capabilities.skills, []);
  assert.deepEqual(bare.parts, [
    {
      kind: "capability",
      capability: {
        id: "s3",
        kind: "skill",
        name: "alpha",
        description: "Alpha skill",
        active: false,
      },
    },
  ]);
  const already = applyManualSkillCommand("/skill:alpha 再来一次", capabilities.skills, [
    {
      kind: "capability",
      capability: {
        id: "s3",
        kind: "skill",
        name: "alpha",
        description: "Alpha skill",
        active: false,
      },
    },
  ]);
  assert.equal(
    already.parts.filter((part) => part.kind === "capability").length,
    1,
    "不能挂两遍同一个技能",
  );
  assert.deepEqual(already.parts.at(-1), { kind: "text", text: "再来一次" });
});

test("applyManualSkillCommand: 没命中就原样返回（普通提问路径不受影响）", () => {
  const parts = [{ kind: "text", text: "/skill:nope 你好" }];
  const applied = applyManualSkillCommand("/skill:nope 你好", capabilities.skills, parts);
  assert.equal(applied.matched, false);
  assert.equal(applied.text, "/skill:nope 你好");
  assert.deepEqual(applied.parts, parts);
});

test("buildSlashMenuItems: pi 关掉 enableSkillCommands 后不列技能（手打入口仍在）", () => {
  const items = buildSlashMenuItems({ ...capabilities, skillCommandsEnabled: false }, "");
  assert.equal(
    items.some((item) => item.kind === "skill"),
    false,
  );
  // 命令还是照列：被关掉的只是「技能当命令注册」这件事。
  assert.ok(items.some((item) => item.kind === "command"));
  // 旧快照没有这个字段 → 视为开启，兼容。
  assert.ok(buildSlashMenuItems(capabilities, "").some((item) => item.kind === "skill"));
  assert.ok(
    buildSlashMenuItems({ ...capabilities, skillCommandsEnabled: true }, "").some(
      (item) => item.kind === "skill",
    ),
  );
});

test("App: 关掉技能命令时菜单要说出来，不能静默少一栏", () => {
  const menuBody = functionBody(appSourceText, "SlashMenu");
  // 提示行在 menu body 里；prop 默认值在参数表里（functionBody 不含参数）。
  assert.match(
    menuBody,
    /skillCommandsHidden \? <p className="slash-menu-hint">\{t\("capability\.slashMenu\.skillCommandsDisabled"\)\}/,
  );
  assert.match(appSourceText, /skillCommandsHidden = false,\n\}: \{/);
  assert.match(appSourceText, /skillCommandsHidden=\{skillCommandsDisabled\(capabilities\)\}/);
});

test("App: handleSubmit 把 /skill:<name> 翻译成徽标 + 参数，且不让它落到命令派发", () => {
  const body = functionBody(appSourceText, "handleSubmit");
  // 规则本身是纯函数（上面有行为测试）；这里只钉 App 真的走那条路。
  assert.match(
    body,
    /const manualSkillCommand = applyManualSkillCommand\(orderedText, capabilities\.skills, messageParts\)/,
  );
  assert.match(body, /const promptText = manualSkillCommand\.text/);
  assert.match(body, /const promptParts = manualSkillCommand\.parts/);
  // 翻译之后的文本/徽标才是这条消息的正文（`submitTurn(promptText, payload, promptParts)`）。
  assert.match(body, /submitTurn\(promptText, payload, promptParts\)/);
});

test("App: 聊天路径绝不打开 expandPromptTemplates（/run 之类的命令派发不能被重新打开）", () => {
  // 桥已拆成多模块：读整棵树，「这段代码在桥里」才不会因为一次合法拆分而假红。
  const streamPrompt = functionBody(bridgeSource(), "streamPrompt");
  assert.match(streamPrompt, /\n\s*expandPromptTemplates: false,/);
  // 只认真的选项行：那条注释（"// expandPromptTemplates: true），技能走徽标激活"）不算。
  assert.doesNotMatch(streamPrompt, /\n\s*expandPromptTemplates: true,/);
  // manual-only 技能的正文由我们自己拼（server/manualSkillPrompt.mjs），不靠内核展开。
  assert.match(streamPrompt, /manualSkillPrefix/);
});
