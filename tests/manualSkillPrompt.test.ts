/**
 * manual-only 技能（`disable-model-invocation: true`）在桌面版必须有办法真正生效。
 *
 * 背景（用户实测）：这类技能被 pi 的 `formatSkillsForPrompt` 从 `<available_skills>` 里过滤掉，
 * 所以 composer 的徽标（使能 + 让模型按需 read）对它们天然无效 —— 面板上显示"已启用"，
 * 对话里模型却看不到它。TUI 里靠 `/skill:<name>` 展开正文，而桌面版聊天路由刻意
 * `expandPromptTemplates: false`（挡住 `/run` 之类的扩展命令），那条路也走不通。
 *
 * 约定：服务端在提交时把**用户显式附上**的 manual-only 技能正文按 pi 的 skill block 格式
 * 拼进这条 prompt。不翻 `expandPromptTemplates`，也就不会把命令派发重新打开。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentSession, parseSkillBlock } from "@earendil-works/pi-coding-agent";

import { formatManualSkillBlock, manualSkillPromptPrefix } from "../server/manualSkillPrompt.mjs";
import { SKILL_COMMAND_PREFIX } from "../src/features/chat/slashMenu.ts";
import {
  ATTACHMENT_CONTEXT_END,
  ATTACHMENT_CONTEXT_START,
  parseAttachmentContext,
} from "../src/shared/chatBubbles.ts";
import { functionBody } from "./lib/sourceText.ts";
import { bridgeSource } from "./lib/bridgeSource.ts";

const server = bridgeSource();

const SKILL_MD = [
  "---",
  "name: grill-me",
  "description: A relentless interview to sharpen a plan or design.",
  "disable-model-invocation: true",
  "---",
  "",
  'Call the Skill tool with "grilling".',
  "",
].join("\n");

const ENTRY = {
  name: "grill-me",
  filePath: "/Users/q/.agents/skills/grill-me/SKILL.md",
  baseDir: "/Users/q/.agents/skills/grill-me",
  content: SKILL_MD,
};

/* ------------------------------- the block ------------------------------- */

test("block 与 pi 的格式逐字符同形，frontmatter 不掉进正文", () => {
  assert.equal(
    formatManualSkillBlock(ENTRY),
    '<skill name="grill-me" location="/Users/q/.agents/skills/grill-me/SKILL.md">\n' +
      "References are relative to /Users/q/.agents/skills/grill-me.\n" +
      "\n" +
      'Call the Skill tool with "grilling".\n' +
      "</skill>",
  );
});

test("上游格式漂移会被 pi 自己的解析器抓住（round-trip）", () => {
  // `parseSkillBlock` 是 pi 的公共 API（dist/index.d.ts 导出），也是 TUI 渲染技能调用气泡用的
  // 解析器。我们按它生成、它认我们的输出 —— 上游改包装格式时这条会红，而不是静默分叉。
  const parsed = parseSkillBlock(`${manualSkillPromptPrefix([ENTRY])}帮我把这个方案问一遍`);
  assert.notEqual(parsed, null, "pi 的 parseSkillBlock 认不出我们生成的 skill block");
  assert.equal(parsed?.name, "grill-me");
  assert.equal(parsed?.location, ENTRY.filePath);
  assert.match(parsed?.content ?? "", /Call the Skill tool with "grilling"/);
  assert.equal(parsed?.userMessage, "帮我把这个方案问一遍", "用户原文必须落在 userMessage 里");
});

test("与内核自己的展开逐字节一致（拿 `_expandSkillCommand` 当 oracle）", () => {
  // 生产代码不碰这个方法（私有）；这里只是**测试期 oracle**：pi 的 `/skill:<name> args`
  // 展开出来的原文，必须和我们拼出来的 prompt 一模一样。内核改格式（或改了 block 与 args
  // 之间的空行）这条会红，而不是让模型收到一份和 TUI 不同的提示词。
  const dir = mkdtempSync(join(tmpdir(), "pi-skill-oracle-"));
  const filePath = join(dir, "SKILL.md");
  writeFileSync(filePath, SKILL_MD);
  try {
    const skill = { name: "grill-me", filePath, baseDir: dir };
    const expand = (text) =>
      AgentSession.prototype._expandSkillCommand.call(
        {
          resourceLoader: { getSkills: () => ({ skills: [skill] }) },
          _extensionRunner: { emitError: () => {} },
        },
        text,
      );
    const ours = manualSkillPromptPrefix([{ ...skill, content: SKILL_MD }]);
    // 用**我们 composer 里那个常量**去调内核：它必须还是内核认识的命令前缀
    // （上游改名 → 内核原样返回 → 这条直接红）。
    assert.equal(
      `${ours}帮我把这个方案问一遍`,
      expand(`${SKILL_COMMAND_PREFIX}grill-me 帮我把这个方案问一遍`),
    );
    // 无参数形态：内核不补那句 args，我们也不补（前缀本身就够）。
    assert.equal(ours.trimEnd(), expand(`${SKILL_COMMAND_PREFIX}grill-me`).trimEnd());
    // 打错的名字：内核原样返回 → 我们也不该认识它（这条保障的是「两边一起 fall through」）。
    assert.equal(expand(`${SKILL_COMMAND_PREFIX}nope x`), `${SKILL_COMMAND_PREFIX}nope x`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("baseDir 用内核给的那个字段，不是 dirname(filePath)", () => {
  // 包里的技能两者可以不同，而 `References are relative to …` 必须写内核认的那个。
  const entry = {
    name: "pkg-skill",
    filePath: "/pkg/skills/pkg-skill/SKILL.md",
    baseDir: "/pkg",
    content: SKILL_MD,
  };
  assert.match(formatManualSkillBlock(entry), /References are relative to \/pkg\./);
});

test("多个 manual-only 技能各成一个 block，用户原文跟在最后", () => {
  const second = {
    ...ENTRY,
    name: "loop-me",
    filePath: "/x/loop-me/SKILL.md",
    baseDir: "/x/loop-me",
  };
  const prefix = manualSkillPromptPrefix([ENTRY, second]);
  assert.equal(prefix.match(/<skill name=/gu)?.length, 2);
  assert.ok(prefix.endsWith("\n\n"), "前缀要把用户原文隔开，不能和 block 黏在一行");
  assert.ok(prefix.includes('<skill name="grill-me"') && prefix.includes('<skill name="loop-me"'));
});

test("没有可用 block 时前缀是空串（prompt 保持原样）", () => {
  assert.equal(manualSkillPromptPrefix([]), "");
  assert.equal(manualSkillPromptPrefix(undefined), "");
  // 只有 frontmatter / 缺名字 / 缺路径 —— 展开了也是空 block，宁可不动 prompt。
  assert.equal(manualSkillPromptPrefix([{ ...ENTRY, content: "---\nname: x\n---\n" }]), "");
  assert.equal(manualSkillPromptPrefix([{ ...ENTRY, name: "  " }]), "");
  assert.equal(manualSkillPromptPrefix([{ ...ENTRY, filePath: "" }]), "");
});

/* ------------------------------- the wiring ------------------------------- */

test("拼好之后界面拿到的仍是用户原文 + 徽标（pi 那边多了 skill block 也不漏出来）", () => {
  // pi 侧的用户消息 = 我们拼的前缀 + 用户原文 + 附件/能力 metadata。
  // 气泡走的是 metadata 里的 displayInput（chatBubbles.parseAttachmentContext），
  // 所以展开的技能正文不会变成用户消息显示出来。
  const metadata = JSON.stringify({
    displayInput: "帮我把这个方案问一遍",
    attachments: [],
    messageParts: [
      { kind: "capability", capability: { id: "grill-me", kind: "skill", name: "grill-me" } },
    ],
  });
  const piMessage =
    `${manualSkillPromptPrefix([ENTRY])}帮我把这个方案问一遍\n\n` +
    `${ATTACHMENT_CONTEXT_START}\n${metadata}\n${ATTACHMENT_CONTEXT_END}`;
  const parsed = parseAttachmentContext(piMessage);
  assert.equal(parsed.text, "帮我把这个方案问一遍");
  assert.equal(parsed.messageParts.length, 1, "徽标还要能重新渲染出来");
});

test("服务端喂给预览器的 baseDir 是内核字段，不是自己 dirname 出来的", () => {
  const body = functionBody(server, "manualSkillPrefixFor");
  assert.match(body, /baseDir: skill\.baseDir \|\| dirname\(skill\.filePath\)/);
  assert.match(body, /skill\.disableModelInvocation !== true/);
  assert.match(
    body,
    /readFileSync\(skill\.filePath, "utf8"\)/,
    "自己读文件：不依赖 pi 已加载的那一份",
  );
});

test("只有 disable-model-invocation 的技能被内联，且服务端自己读文件", () => {
  const select = functionBody(server, "manualSkillPrefixFor");
  assert.match(
    select,
    /skill\.disableModelInvocation !== true/,
    "判断条件变了：别的技能不该被硬塞正文",
  );
  assert.match(
    select,
    /readFileSync\(skill\.filePath, "utf8"\)/,
    "正文要现读，不能靠 pi 的 loaded skills 列表",
  );
  assert.match(select, /manualSkillPromptPrefix\(entries\)/);
  // 读不到文件只跳过这一个（pi 的 _expandSkillCommand 也是放弃展开 + 上报），别打挂整次提交。
  assert.match(select, /prompt\.manual_skill_read_failed/);
});

test("prompt 组装把前缀拼在用户原文前，metadata 仍用原文", () => {
  const prompt = functionBody(server, "streamPrompt");
  assert.match(
    prompt,
    /const \{ parts: messageParts, manualSkillPrefix \} = await normalizePromptMessageParts\(/,
  );
  assert.match(prompt, /manualSkillPrefix \? `\$\{manualSkillPrefix\}\$\{baseInput\}` : baseInput/);
  assert.match(
    prompt,
    /appendAttachmentContext\(\s*manualSkillPrefix[\s\S]*?displayInput,\s*attachments,\s*messageParts,/,
    "气泡文本取的是 metadata 里的 displayInput，拼了前缀也不能把它换掉",
  );
});

test("内联技能正文不许把命令派发重新打开", () => {
  const prompt = functionBody(server, "streamPrompt");
  const call = /await activeSession\.prompt\(input, \{([\s\S]*?)\}\);/.exec(prompt);
  assert.notEqual(call, null, "找不到聊天路由的 prompt() 调用");
  assert.match(
    call?.[1] ?? "",
    /expandPromptTemplates: false/,
    "manual-only 技能的内联不该翻这个开关",
  );
  // 只能看 `prompt()` 的实参：函数体里的注释也写着 `expandPromptTemplates: true`（包命令走的那条路）。
  assert.doesNotMatch(call?.[1] ?? "", /expandPromptTemplates: true/);
});

test("normalizePromptMessageParts 两条出口都带上 manualSkillPrefix", () => {
  const normalize = functionBody(server, "normalizePromptMessageParts");
  assert.match(
    normalize,
    /\{ parts: normalized, manualSkillPrefix: "" \}/,
    "没有 capability part 时也要给出空前缀，否则调用方解构出 undefined",
  );
  assert.match(
    normalize,
    /manualSkillPrefix: manualSkillPrefixFor\(context\.allSkills, requestedSkills\)/,
  );
});
