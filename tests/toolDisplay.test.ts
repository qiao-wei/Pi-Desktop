/**
 * `toolDisplay` is the one place that turns pi's tool result envelope into the
 * row/body model (see the module docblock). These tests use pi's real shapes:
 * the `edit` patch is `createTwoFilesPatch` output, `bash`'s exit code lives in
 * `structuredContent`, and `read`'s path only exists in the call arguments.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  callToolDisplay,
  deriveToolDisplay,
  editOperationOfTool,
  toolRowFolder,
  parseMcpToolName,
  parseUnifiedPatch,
  pathDirectory,
  pathLeaf,
  readToolEnvelope,
  toolDiffLines,
  toolResultText,
  toolRowFamily,
} from "../src/shared/toolDisplay.ts";

const EDIT_PATCH = [
  "--- src/app/App.tsx",
  "+++ src/app/App.tsx",
  "@@ -1,4 +1,5 @@",
  " import x from 'y';",
  "-const a = 1;",
  "+const a = 2;",
  "+const b = 3;",
  " export default a;",
].join("\n");

test("edit 的 details.patch 变成按文件计数的 diff", () => {
  const display = deriveToolDisplay({
    toolName: "edit",
    args: { path: "src/app/App.tsx" },
    result: {
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/app/App.tsx." }],
      details: { diff: "…", patch: EDIT_PATCH, firstChangedLine: 2 },
    },
  });
  assert.deepEqual(display, {
    kind: "fileDiff",
    files: [
      { path: "src/app/App.tsx", added: 2, removed: 1, patch: EDIT_PATCH },
    ],
  });
});

test("edit 没有 patch 时退化成 none，而不是猜 diff", () => {
  const display = deriveToolDisplay({
    toolName: "edit",
    args: { path: "a.ts" },
    result: { content: [{ type: "text", text: "ok" }] },
  });
  assert.deepEqual(display, { kind: "none" });
});

test("write 从参数合成整文件 patch（pi 的 write 不带 details）", () => {
  const display = deriveToolDisplay({
    toolName: "write",
    args: { path: "notes.md", content: "one\ntwo\nthree" },
    result: { content: [{ type: "text", text: "Successfully wrote notes.md." }] },
  });
  assert.equal(display.kind, "fileDiff");
  assert.deepEqual(display.kind === "fileDiff" ? display.files : null, [
    {
      path: "notes.md",
      added: 3,
      removed: 0,
      patch: ["--- notes.md", "+++ notes.md", "@@ -0,0 +1,3 @@", "+one", "+two", "+three"].join("\n"),
    },
  ]);
});

test("write 没有内容时不合成空 patch", () => {
  assert.deepEqual(
    deriveToolDisplay({ toolName: "write", args: { path: "a.ts" }, result: undefined }),
    { kind: "none" },
  );
});

test("bash 的退出码/截断来自 structuredContent", () => {
  const display = deriveToolDisplay({
    toolName: "bash",
    args: { command: "npm test" },
    result: {
      content: [{ type: "text", text: "1 failing" }],
      details: {},
      structuredContent: {
        output: "1 failing\n",
        truncated: true,
        full_output_path: "/tmp/pi-bash-x.txt",
        exit_code: 1,
        wall_time_seconds: 3.2,
      },
    },
  });
  assert.deepEqual(display, {
    kind: "terminal",
    output: "1 failing\n",
    exitCode: 1,
    truncated: true,
    fullOutputPath: "/tmp/pi-bash-x.txt",
  });
});

test("bash 运行中只有 partialResult 时仍给出 terminal 正文", () => {
  const display = deriveToolDisplay({
    toolName: "bash",
    args: { command: "sleep 4; echo STEP1" },
    result: undefined,
    partialResult: { content: [{ type: "text", text: "STEP1\n" }], details: {} },
  });
  assert.deepEqual(display, { kind: "terminal", output: "STEP1\n" });
});

test("bash 没有任何输出时是 none（行上仍是执行行）", () => {
  assert.deepEqual(
    deriveToolDisplay({ toolName: "bash", args: { command: "true" }, result: { content: [] } }),
    { kind: "none" },
  );
});

test("read 的路径只可能来自参数", () => {
  assert.deepEqual(
    deriveToolDisplay({
      toolName: "read",
      args: { path: "src/app/App.tsx" },
      result: { content: [{ type: "text", text: "1  import x" }] },
    }),
    { kind: "read", path: "src/app/App.tsx" },
  );
});

test("grep/ls/find 与未知工具都归到各自的行族", () => {
  assert.equal(toolRowFamily("grep"), "search");
  assert.equal(toolRowFamily("ls"), "search");
  assert.equal(toolRowFamily("find"), "search");
  assert.equal(toolRowFamily("tool_search"), "search");
  assert.equal(toolRowFamily("powershell"), "execute");
  assert.equal(toolRowFamily("codemode"), "other");
  assert.equal(toolRowFamily("mcp__docs__search"), "mcp");
});

test("MCP 工具名拆出 server 与 tool", () => {
  assert.deepEqual(parseMcpToolName("mcp__docs__search"), { server: "docs", tool: "search" });
  // 超过 64 字符会被截断加 hash，内层 `__` 可能没了 —— server 仍是首段。
  assert.deepEqual(parseMcpToolName("mcp__a-very-long-server-name__t"), {
    server: "a-very-long-server-name",
    tool: "t",
  });
  assert.equal(parseMcpToolName("mcp__server"), null);
  assert.equal(parseMcpToolName("mcp__server__"), null);
  assert.equal(parseMcpToolName("read"), null);
});

test("字符串化的 envelope 也按 envelope 读（录制的 fixture 是这种形状）", () => {
  const envelope = readToolEnvelope(
    '{"content": [{"type": "text", "text": "STEP1\\n"}]}',
  );
  assert.equal(envelope.text, "STEP1\n");
});

test("普通字符串结果不会被当成 envelope 解析", () => {
  assert.equal(toolResultText("total 8"), "total 8");
  assert.equal(toolResultText("{not json"), "{not json");
});

test("toolResultText 永远不返回原始 envelope JSON", () => {
  const text = toolResultText({
    content: [
      { type: "text", text: "first" },
      { type: "image", data: "…", mimeType: "image/png" },
      { type: "text", text: "second" },
    ],
  });
  assert.equal(text, "first\n[image]\nsecond");
});

test("null/undefined 结果落空文本而不是 'undefined'", () => {
  assert.equal(toolResultText(undefined), "");
  assert.equal(toolResultText(null), "");
  assert.equal(toolResultText(undefined, "fallback"), "fallback");
});

test("多文件 patch 拆成多条，重命名取新路径", () => {
  const files = parseUnifiedPatch(
    [
      "--- old/a.ts",
      "+++ new/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- c.ts",
      "+++ c.ts",
      "@@ -1 +1,2 @@",
      "+c",
      "+d",
    ].join("\n"),
  );
  assert.deepEqual(files, [
    {
      path: "new/a.ts",
      added: 1,
      removed: 1,
      patch: "--- old/a.ts\n+++ new/a.ts\n@@ -1 +1 @@\n-a\n+b",
    },
    {
      path: "c.ts",
      added: 2,
      removed: 0,
      patch: "--- c.ts\n+++ c.ts\n@@ -1 +1,2 @@\n+c\n+d",
    },
  ]);
});
/* -------------------------------------------------------------------------- */
/* Row text + diff rendering                                                  */
/* -------------------------------------------------------------------------- */

test("文件名取最后一段，目录取它前面的部分（两者都不猜路径是否在项目内）", () => {
  assert.equal(pathLeaf("/Users/x/proj/src/a.ts"), "a.ts");
  assert.equal(pathDirectory("/Users/x/proj/src/a.ts"), "/Users/x/proj/src");
  assert.equal(pathLeaf("a.ts"), "a.ts");
  assert.equal(pathDirectory("a.ts"), "", "光一个文件名没有目录可显示");
  // 目录尾部斜杠不该变成空叶子（编辑一个目录路径时会出现）。
  assert.equal(pathLeaf("src/components/"), "components");
  assert.equal(pathDirectory("src/components/"), "src");
});

test("edit 的动词只看工具名，不看 diff 形状", () => {
  // 用户实测的回归：给已有文件插入几行（没有 - 行）时，行说成了「Write」。
  // diff 分不出「write 覆盖成超集」与「edit 只插不改」，所以形状不能当证据。
  assert.equal(editOperationOfTool("edit"), "edit");
  assert.equal(editOperationOfTool("write"), "write");
  assert.equal(editOperationOfTool(" Write "), "write");
  assert.equal(editOperationOfTool("mcp__fs__write"), "edit", "MCP 工具不走这一族");
  assert.equal(editOperationOfTool(""), "edit");
});

test("diff 正文只剩内容行：文件头、git prelude、hunk 头都不出现", () => {
  const { head, tail, omitted } = toolDiffLines(
    [
      "diff --git a/a.ts b/a.ts",
      "index 1234567..89abcde 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "\\ No newline at end of file",
    ].join("\n"),
  );
  assert.deepEqual(head, [
    { kind: "context", text: "keep" },
    { kind: "removed", text: "old" },
    { kind: "added", text: "new" },
    { kind: "context", text: "\\ No newline at end of file" },
  ]);
  assert.deepEqual(tail, []);
  assert.equal(omitted, 0);
  // `+++ b.ts` 不能当成「新增了一行 +++ b.ts」，`@@` 也不该作为标题出现
  //（ZCode 的行注释：不把 unified diff 的协议 marker 当代码内容显示）。
  assert.equal(
    head.some((line) => line.text.includes("+++") || line.text.startsWith("@@")),
    false,
  );
});

test("多处 hunk 都只留内容行", () => {
  const { head } = toolDiffLines(
    [
      "--- a/a.ts",
      "+++ a/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "@@ -9 +9 @@",
      "-c",
      "+d",
    ].join("\n"),
  );
  assert.deepEqual(head, [
    { kind: "removed", text: "a" },
    { kind: "added", text: "b" },
    { kind: "removed", text: "c" },
    { kind: "added", text: "d" },
  ]);
});

test("超长 patch 掐中间：头和尾都留下，中间报出漏了多少行", () => {
  const patch = [
    "--- a.ts",
    "+++ a.ts",
    "@@ -0,0 +1,6 @@",
    "+first",
    "+second",
    "+third",
    "+fourth",
    "+fifth",
    "+last",
  ].join("\n");
  const { head, tail, omitted } = toolDiffLines(patch, 4);
  // 预算 4 行 = 1 行提示 + 头 2 + 尾 1（与 ZCode 的 ceil(keep/2) 一致）。
  assert.deepEqual(
    head.map((line) => line.text),
    ["first", "second"],
  );
  assert.deepEqual(
    tail.map((line) => line.text),
    ["last"],
  );
  assert.equal(omitted, 3, "漏掉的行数要能报给读者（ZCode：diff.preview.truncatedLines）");
});

test("刚好到上限时不分段（不在末尾留一个空的尾巴）", () => {
  const { head, tail, omitted } = toolDiffLines(
    ["--- a.ts", "+++ a.ts", "@@ -0,0 +1,2 @@", "+a", "+b"].join("\n"),
    2,
  );
  assert.equal(head.length, 2);
  assert.deepEqual(tail, []);
  assert.equal(omitted, 0);
});

test("git 自己的 prelude 行不进正文", () => {
  const { head } = toolDiffLines(
    [
      "diff --git a/a.ts b/a.ts",
      "index 1234567..89abcde 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n"),
  );
  assert.deepEqual(head, [
    { kind: "removed", text: "a" },
    { kind: "added", text: "b" },
  ]);
});

test("调用还没有结果时也能给出 read 的路径（行要在跑的时候就说出文件名）", () => {
  assert.deepEqual(callToolDisplay("read", { path: "src/a.ts" }), {
    kind: "read",
    path: "src/a.ts",
  });
  assert.equal(callToolDisplay("bash", { command: "ls" }), undefined, "只有 read 有前置正文");
  assert.equal(callToolDisplay("read", {}), undefined, "{kind:'read'} 没有路径时等于没有正文");
});

test("文件行的路径永远非空：有目录用目录，没有就用项目文件夹名", () => {
  const root = "/Users/me/iej";
  assert.equal(toolRowFolder("src/notes/demo.ts", root), "src/notes/");
  assert.equal(toolRowFolder("src/demo.ts", root), "src/");
  // 用户实测：「编辑 hello.py」后面什么都没有 —— 文件就在项目根时，位置由项目文件夹名回答。
  assert.equal(toolRowFolder("hello.py", root), "iej/");
  // 项目外的绝对路径保持它自己的目录（不做假的相对化）。
  assert.equal(toolRowFolder("/elsewhere/x/a.ts", root), "/elsewhere/x/");
  // 连工作区都不知道时就别编一个（空 = 不渲染那段）。
  assert.equal(toolRowFolder("hello.py", ""), "");
});
