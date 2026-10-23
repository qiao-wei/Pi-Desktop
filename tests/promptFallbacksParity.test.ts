/**
 * 空消息兜底提示词：渲染进程与服务端**逐字对照**。
 *
 * 只挂附件 / 只挂技能徽标时两边都要能拼出一句话，而这句话是同一个承诺的两半：
 * 渲染进程先把它填进请求的 `input`，服务端只在 `input` 为空时才自己补。两边写歪一个字，
 * 用户看到的气泡与模型收到的提示词就不是同一件事（因此 `PromptMessagePartInput` 的
 * `capability` 分支也无 h 兜底：服务端会先判 `input`）。
 *
 * 服务端是进程内 `.mjs`（直接 import 会拉起整个 server），所以那边按仓库惯例做源码级断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  attachmentOnlyPrompt,
  capabilityOnlyPrompt,
  hasCapabilityPart,
  promptFallback,
} from "../src/features/chat/promptFallbacks.ts";
import { functionBody } from "./lib/sourceText.ts";

const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");

const attachment = { kind: "file", name: "notes.md" };
const folder = { kind: "directory", name: "src" };
const skillPart = (name) => ({ kind: "capability", capability: { kind: "skill", id: name, name, description: "", active: true } });

test("附件兜底：单条点名文件和目录，多条只报数量", () => {
  assert.equal(attachmentOnlyPrompt([attachment]), "Please review the attached file: notes.md");
  assert.equal(attachmentOnlyPrompt([folder]), "Please review the attached folder: src");
  assert.equal(attachmentOnlyPrompt([attachment, folder]), "Please review these 2 attached files.");
});

test("技能兜底：点名技能（等价于 TUI 的 /skill:<name> 无参数）", () => {
  assert.equal(capabilityOnlyPrompt([skillPart("grill-me")]), "Please use the attached skill: grill-me");
  assert.equal(capabilityOnlyPrompt([skillPart("a"), skillPart("b")]), "Please use the attached skill: a, b");
  // 名字拿不到时也要给一句不空的话，不能把空消息丢给模型。
  assert.equal(capabilityOnlyPrompt([{ kind: "capability", capability: { name: "  " } }]), "Please use the attached capability.");
  assert.equal(capabilityOnlyPrompt([]), "Please use the attached capability.");
});

test("attachmentOnlyPrompt / capabilityOnlyPrompt 与服务端逐字一致", () => {
  const serverAttachment = functionBody(serverSource, "attachmentOnlyPrompt");
  const serverCapability = functionBody(serverSource, "capabilityOnlyPrompt");
  for (const literal of [
    "`Please review the attached ${only?.kind === \"directory\" ? \"folder\" : \"file\"}: ${only?.name}`",
    "`Please review these ${attachments.length} attached files.`",
  ]) {
    assert.ok(serverAttachment.includes(literal), `服务端附件兜底少了：${literal}`);
  }
  for (const literal of [
    "`Please use the attached skill: ${names.join(\", \")}`",
    '"Please use the attached capability."',
  ]) {
    assert.ok(serverCapability.includes(literal), `服务端技能兜底少了：${literal}`);
  }
  // 渲染进程算出来的整句必须能在服务端那份源码里找到（模板拼法可以不同，结果必须一样）。
  assert.ok(serverAttachment.includes("`Please review the attached"), "两边都认「单条点名」这一句");
  assert.ok(serverCapability.includes("`Please use the attached skill: "), "两边都认「点名技能」这一句");
  assert.equal(attachmentOnlyPrompt([attachment]), "Please review the attached file: notes.md");
});

test("promptFallback：有文字用文字，没有文字按附件→技能的优先级补", () => {
  assert.equal(promptFallback("hi", [attachment], [skillPart("a")]), "hi");
  assert.equal(promptFallback("", [attachment], [skillPart("a")]), "Please review the attached file: notes.md");
  assert.equal(promptFallback("", [], [skillPart("a")]), "Please use the attached skill: a");
});

test("hasCapabilityPart：只认 capability 分支（附件/文字都算「没挂技能」）", () => {
  assert.equal(hasCapabilityPart([skillPart("a")]), true);
  assert.equal(hasCapabilityPart([{ kind: "text", text: "x" }, { kind: "attachment", attachmentId: "1" }]), false);
  assert.equal(hasCapabilityPart([]), false);
});

test("服务端的 capabilityOnlyPrompt 用的就是同一组字段（capability.name）", () => {
  const serverCapability = functionBody(serverSource, "capabilityOnlyPrompt");
  assert.ok(serverCapability.includes("part?.capability?.name"), "服务端读取的字段名必须和渲染进程一致");
  // 服务端传进来的已经是筛好的技能徽标（渲染进程在函数内部筛）。
  assert.match(
    serverSource,
    /const requestedCapabilities = messageParts\.filter\(\(part\) => part\?\.kind === "capability"\);/,
  );
});