import assert from "node:assert/strict";
import test from "node:test";

import {
  parseJsonPrefix,
  readPartialFileToolArgs,
  streamedArgsDisplay,
} from "../src/shared/toolArgsPreview.ts";
import { deriveToolDisplay } from "../src/shared/toolDisplay.ts";
import type { MessageProcessBlock } from "../src/types/domain.ts";

/**
 * 工具调用的参数是**边流边到**的 JSON 文本（`tool_call_stream_delta` 的 `argsText`），
 * 到 `tool_call_stream_end` 才被解析。ZCode 的「写大文件时 +/− 一路涨」靠的就是读这段
 * 已经到手的文本 —— 所以这里钉的是一条前缀解析器：它必须能容忍半截 JSON，同时**不许猜**：
 * 还没开始到达的字段是「没有」，不是空串。
 */
const WRITE = JSON.stringify({ path: "notes.md", content: "一\n二\n三\n" });

test("前缀解析：字符串被截断时返回已解码的部分（那正是用户在看的增长）", () => {
  assert.deepEqual(readPartialFileToolArgs(WRITE.slice(0, 20)), { path: "notes.md" });
  const partial = readPartialFileToolArgs(WRITE.slice(0, WRITE.indexOf("三")));
  assert.equal(partial?.content, "一\n二\n");
  // 半截的正文永远是完整正文的前缀 —— 这是「已到达」的定义。
  const whole = readPartialFileToolArgs(WRITE)?.content ?? "\u0000";
  assert.equal(whole.startsWith(partial?.content ?? "\u0000"), true);
  assert.equal(partial?.content!.length < whole.length, true, "确实只到了一部分");
});

test("前缀解析：对象/数组截断时保留已解析的成员，悬空的 key 与尾逗号都丢掉", () => {
  assert.deepEqual(parseJsonPrefix('{"a":1,"b":[1,2,{"c":"x"}],"d":'), { a: 1, b: [1, 2, { c: "x" }] });
  assert.deepEqual(parseJsonPrefix('{"a":1,'), { a: 1 });
  assert.deepEqual(parseJsonPrefix('{"a":[1,2,'), { a: [1, 2] });
  assert.equal(parseJsonPrefix("not json"), undefined);
});

test("前缀解析：转义不会被半个转义符号骗到", () => {
  assert.deepEqual(parseJsonPrefix('{"p":"a\\"b"}'), { p: 'a"b' });
  assert.deepEqual(parseJsonPrefix('{"p":"a\\\\"}'), { p: "a\\" });
  assert.deepEqual(parseJsonPrefix('{"p":"tab\\there"}'), { p: "tab\there" });
  assert.deepEqual(parseJsonPrefix('{"p":"\\u4e2d\\u6587"}'), { p: "中文" });
  // 末尾正好是反斜杠：那个转义还没到，只能给出它之前的正文。
  assert.deepEqual(parseJsonPrefix('{"p":"abc\\'), { p: "abc" });
});

test("前缀解析：edits 里的 oldText / newText 一前一后各自长出来", () => {
  const full = JSON.stringify({ path: "a.ts", edits: [{ oldText: "旧一\n旧二", newText: "新一\n新二\n新三" }] });
  const onlyOld = readPartialFileToolArgs(full.slice(0, full.indexOf("新")));
  // `newText` 的 key 已经到了、正文一个字都还没有：空串是真实读数，不是缺失。
  assert.deepEqual(onlyOld?.edits, [{ oldText: "旧一\n旧二", newText: "" }]);
  assert.deepEqual(readPartialFileToolArgs(full)?.edits, [{ oldText: "旧一\n旧二", newText: "新一\n新二\n新三" }]);
  // edits 是 JSON 字符串（有些模型这么发）时也认得。
  assert.deepEqual(
    readPartialFileToolArgs(JSON.stringify({ edits: JSON.stringify([{ oldText: "a", newText: "b" }]) }))?.edits,
    [{ oldText: "a", newText: "b" }],
  );
});

test("write：参数流到一半，行数就已经在涨（不需要工具结果）", () => {
  const cuts = [WRITE.indexOf("二"), WRITE.indexOf("三"), WRITE.indexOf("\\n\"") , WRITE.length];
  const counts = cuts.map((cut) => {
    const display = deriveToolDisplay({
      toolName: "write",
      args: readPartialFileToolArgs(WRITE.slice(0, cut)),
      result: undefined,
    });
    return display.kind === "fileDiff" ? display.files[0]!.added : 0;
  });
  assert.deepEqual(counts, [1, 2, 3, 3], "随着 content 到达，+N 一格格长上去");
  const final = deriveToolDisplay({ toolName: "write", args: readPartialFileToolArgs(WRITE), result: undefined });
  assert.equal(final.kind === "fileDiff" ? final.files[0]!.patch.includes("+++ notes.md") : false, true);
});

test("edit：参数流到一半就有 +/−，落定后以真实 patch 为准", () => {
  const args = JSON.stringify({ path: "a.ts", edits: [{ oldText: "旧", newText: "新一\n新二" }] });
  const preview = deriveToolDisplay({ toolName: "edit", args: readPartialFileToolArgs(args), result: undefined });
  assert.equal(preview.kind, "fileDiff");
  if (preview.kind === "fileDiff") {
    assert.deepEqual([preview.files[0]!.added, preview.files[0]!.removed], [2, 1]);
  }

  // 真实结果一到，`details.patch`（带上下文行）必须盖掉预览。
  const result = {
    content: [{ type: "text", text: "ok" }],
    details: { patch: "--- a.ts\n+++ a.ts\n@@ -1 +1,2 @@\n-旧\n+新一\n+新二" },
  };
  const settled = deriveToolDisplay({ toolName: "edit", args: { path: "a.ts" }, result });
  assert.equal(settled.kind, "fileDiff");
  if (settled.kind === "fileDiff") {
    assert.equal(settled.files[0]!.patch.includes("@@ -1 +1,2 @@"), true, "带 hunk 头 = 来自真实 patch");
  }
});

test("节流：同一段参数文本里不重算，跨过 128 字符才更新一次", () => {
  const toolBlock = {
    kind: "tool",
    toolCallId: "c1",
    toolName: "write",
    callText: "",
    status: "streaming",
  } as Extract<MessageProcessBlock, { kind: "tool" }>;

  const short = '{"path":"a.md","content":"x"}';
  assert.equal(streamedArgsDisplay(toolBlock, short), undefined, "不足一档：这次不读参数");

  const long = `{"path":"a.md","content":"${"y".repeat(200)}"}`;
  const display = streamedArgsDisplay(toolBlock, long);
  assert.equal(display?.kind, "fileDiff", "跨档后立刻出预览");

  // 已有权威 patch 的块（status 已 done）不许被预览覆盖。
  const settled = { ...toolBlock, status: "done" as const, callText: "" };
  const authoritative = { kind: "fileDiff" as const, files: [{ path: "a.md", added: 1, removed: 9, patch: "p" }] };
  assert.equal(streamedArgsDisplay({ ...settled, display: authoritative }, long), authoritative);
});