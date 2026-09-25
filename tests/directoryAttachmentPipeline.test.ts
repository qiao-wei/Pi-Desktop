/**
 * 目录附件的跨端契约：客户端把文件夹当「引用」送出去，服务端照着原样交给模型。
 *
 * 三件事必须同时成立，否则目录这条链会在某一端退化成「一个空文件」：
 * ① 服务端认出目录后不复制、不当字节读，直接返回客户端给的绝对路径；
 * ② 两端认的是同一个 MIME（客户端 `DIRECTORY_MIME_TYPE` ↔ 服务端 `directoryMimeType`）；
 * ③ 徽标的 kind / sourcePath 能过剪贴板回环，否则复制一条带目录的消息再粘回编辑器就丢了。
 *
 * 服务端是脚本、import 起来会起服务，所以按仓库惯例做「区域限定」的结构断言
 * （见 tests/panelDivider.test.ts 开头那段说明）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { attachmentBadgeAttributes, readBadgeDescriptor, userMessageClipboardHtml } from "../src/features/chat/badgeClipboard.ts";
import { DIRECTORY_MIME_TYPE } from "../src/shared/attachmentKind.ts";
import { functionBody } from "./lib/sourceText.ts";
import type { ChatAttachment } from "../src/types/index.ts";

const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const sharedSource = readFileSync(new URL("../src/shared/attachmentKind.ts", import.meta.url), "utf8");

const directoryAttachment: ChatAttachment = {
  id: "a1",
  name: "tender",
  mimeType: DIRECTORY_MIME_TYPE,
  size: 0,
  kind: "directory",
  sourcePath: "/Users/me/tender",
};

test("服务端认目录：在写盘之前返回，路径原样交给模型", () => {
  const body = functionBody(serverSource, "persistPromptAttachments");
  const branchStart = body.indexOf("directoryMimeType");
  assert.ok(branchStart >= 0, "persistPromptAttachments 里找不到目录分支");

  const branchEnd = body.indexOf("const reusablePath", branchStart);
  assert.ok(branchEnd > branchStart, "目录分支后面应当直接进入原来的字节校验");
  const branch = body.slice(branchStart, branchEnd);

  assert.match(branch, /isDirectory\(\)/, "必须先确认它现在还是个目录，否则会把文件当目录引用送出去");
  assert.match(branch, /path: resolvedSource/, "给模型的必须是客户端那条绝对路径，不是 attachments 目录里的副本");
  assert.match(branch, /kind: "directory"/);
  assert.match(branch, /size: 0/);
  assert.doesNotMatch(branch, /readFileSync|writeFileSync|Buffer\./, "目录不能走字节：不读不写不 base64");
  assert.doesNotMatch(branch, /maxAttachmentBytes|maxAttachmentTotalBytes/, "目录没有大小概念，不该占用 25MB / 50MB 额度");
});

test("服务端也认「目录没了」：校验不过就报清楚，而不是塞一个空文件给模型", () => {
  const body = functionBody(serverSource, "persistPromptAttachments");
  const branch = body.slice(body.indexOf("directoryMimeType"), body.indexOf("const reusablePath", body.indexOf("directoryMimeType")));
  assert.match(branch, /existsSync\(resolvedSource\)/);
  assert.match(branch, /throw new Error\(/);
});

test("两端认的是同一条 MIME 常量", () => {
  assert.match(sharedSource, new RegExp(`DIRECTORY_MIME_TYPE = "${DIRECTORY_MIME_TYPE}"`));
  assert.match(serverSource, new RegExp(`directoryMimeType = "${DIRECTORY_MIME_TYPE}"`));
});

test("会话快照不把目录降级成 file（否则气泡显示成文件 + 0 B）", () => {
  const body = functionBody(serverSource, "toConversationAttachment");
  const kindExpression = body.slice(body.indexOf("const kind ="), body.indexOf("const path ="));
  assert.ok(kindExpression.length > 0, "toConversationAttachment 里找不到 kind 的推导");
  assert.match(kindExpression, /"directory"/);
  assert.match(kindExpression, /directoryMimeType/, "旧消息只有 image/file 两种 kind，没有 MIME 兜底就会漏");
  // 目录不能被当成可下载的附件：`/api/attachments` 只服务 attachments 目录里的文件。
  assert.match(body, /previewUrl: kind === "image" && path/);
});

test("目录徽标过剪贴板回环：kind 与绝对路径都不丢", () => {
  const descriptor = readBadgeDescriptor({ dataset: datasetOf(attachmentBadgeAttributes(directoryAttachment)) });
  assert.equal(descriptor?.kind, "attachment");
  if (descriptor?.kind !== "attachment") {
    return;
  }
  assert.equal(descriptor.attachment.kind, "directory");
  assert.equal(descriptor.attachment.sourcePath, "/Users/me/tender");
  assert.equal(descriptor.attachment.mimeType, DIRECTORY_MIME_TYPE);
});

test("目录徽标的老 HTML（没有 data-attachment-kind）按 MIME 兜底成 directory", () => {
  const attributes = attachmentBadgeAttributes(directoryAttachment);
  delete attributes["data-attachment-kind"];
  const descriptor = readBadgeDescriptor({ dataset: datasetOf(attributes) });
  assert.equal(descriptor?.kind === "attachment" ? descriptor.attachment.kind : null, "directory");
});

test("复制一条带目录的消息：徽标副标题是 Folder，不是 0 B", () => {
  const html = userMessageClipboardHtml(
    [{ kind: "attachment", attachmentId: "a1" }],
    [directoryAttachment],
  );

  assert.match(html, /<strong>tender<\/strong><small>Folder<\/small>/);
  assert.doesNotMatch(html, /0 B/);
  assert.match(html, /data-attachment-source-path="\/Users\/me\/tender"/);
});

/** `data-x-y` → `xY`：剪贴板属性解析成 `dataset`，与 `readBadgeDescriptor` 的读法一致。 */
function datasetOf(attributes: Record<string, string>): Record<string, string> {
  const dataset: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) {
    dataset[name.replace(/^data-/, "").replace(/-([a-z])/g, (_, character: string) => character.toUpperCase())] = value;
  }
  return dataset;
}