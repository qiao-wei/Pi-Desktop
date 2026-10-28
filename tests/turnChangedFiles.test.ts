/**
 * 每轮「改了哪些文件」（`src/shared/turnChangedFiles.ts`）。
 *
 * 这份数据是纯展示，但错法很难看：多列一个文件，用户就会去右面板找一个不存在的改动；
 * 少列或列串（把 A 的参数读成 B）会让人以为 agent 没动过那个文件。所以三类都钉住：
 * 只认写文件工具、路径从哪来、去重保序。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  FILE_MUTATING_TOOLS,
  collectTurnChangedFiles,
  collectTurnChangedFilesWithCounts,
  isFileMutatingTool,
  toolCallChangedPath,
  toWorkspaceRelativePath,
} from "../src/shared/turnChangedFiles.ts";

test("只有写文件的两个工具算数（大小写、空格都容忍）", () => {
  assert.deepEqual([...FILE_MUTATING_TOOLS], ["write", "edit"]);
  for (const name of ["write", "edit", " Write ", "EDIT"]) {
    assert.equal(isFileMutatingTool(name), true, name);
  }
  for (const name of ["read", "bash", "grep", "glob", "ls", "todo", "", null, undefined, 7]) {
    assert.equal(isFileMutatingTool(name as unknown), false, String(name));
  }
});

test("路径从 args.path 取；不是写文件工具 / 不是 tool-call part 都是空串", () => {
  assert.equal(toolCallChangedPath({ type: "tool-call", toolName: "write", args: { path: "src/a.ts" } }), "src/a.ts");
  assert.equal(toolCallChangedPath({ type: "tool-call", toolName: "edit", args: { path: "  src/b.ts  " } }), "src/b.ts");
  // 读文件工具虽然也有 path，但它没改任何东西。
  assert.equal(toolCallChangedPath({ type: "tool-call", toolName: "read", args: { path: "src/a.ts" } }), "");
  // 文本 block / reasoning block 不是工具调用。
  assert.equal(toolCallChangedPath({ type: "text", toolName: "write", args: { path: "a.ts" } }), "");
  // bash 没有可靠的路径参数：宁可不列。
  assert.equal(toolCallChangedPath({ type: "tool-call", toolName: "bash", args: { command: "rm a.ts" } }), "");
  assert.equal(toolCallChangedPath(null), "");
  assert.equal(toolCallChangedPath(undefined), "");
});

test("args 拿不到时退回 argsText（流式途中参数可能还是字符串）", () => {
  assert.equal(
    toolCallChangedPath({ type: "tool-call", toolName: "write", argsText: '{"path":"src/a.ts","content":"x"}' }),
    "src/a.ts",
  );
  // 参数还没拼完：不许抛，也不许猜一个路径出来。
  assert.equal(toolCallChangedPath({ type: "tool-call", toolName: "write", argsText: '{"path":"src/a' }), "");
  assert.equal(toolCallChangedPath({ type: "tool-call", toolName: "write", argsText: "" }), "");
  assert.equal(toolCallChangedPath({ type: "tool-call", toolName: "write", argsText: "not json" }), "");
  // args 是坏形状（数组 / 字符串 / path 不是字符串）也走同一个出口。
  assert.equal(toolCallChangedPath({ type: "tool-call", toolName: "write", args: ["a.ts"] }), "");
  assert.equal(toolCallChangedPath({ type: "tool-call", toolName: "write", args: { path: 42 } }), "");
  assert.equal(toolCallChangedPath({ type: "tool-call", toolName: "write", args: { path: "   " } }), "");
});

test("一轮里去重且保序：同一个文件改多次只列一行，顺序按工具调用顺序", () => {
  const parts = [
    { type: "reasoning" },
    { type: "tool-call", toolName: "read", args: { path: "src/read-only.ts" } },
    { type: "tool-call", toolName: "write", args: { path: "src/b.ts" } },
    { type: "text" },
    { type: "tool-call", toolName: "edit", args: { path: "src/a.ts" } },
    { type: "tool-call", toolName: "edit", args: { path: "src/a.ts" } },
    { type: "tool-call", toolName: "bash", args: { command: "touch src/c.ts" } },
  ];

  assert.deepEqual(collectTurnChangedFiles(parts), ["src/b.ts", "src/a.ts"]);
});

test("空输入 / 非数组输入都是空列表（没有工具调用的轮次不该出现面板）", () => {
  for (const value of [[], null, undefined, "x", {}, 7]) {
    assert.deepEqual(collectTurnChangedFiles(value as never), []);
  }
});
test("折相对路径：项目内的绝对路径折掉前缀，项目外的原样保留", () => {
  const root = "/Users/x/proj";
  assert.equal(toWorkspaceRelativePath("/Users/x/proj/src/a.ts", root), "src/a.ts");
  assert.equal(toWorkspaceRelativePath("src/a.ts", root), "src/a.ts", "已经是相对路径，别动");
  assert.equal(toWorkspaceRelativePath("/Users/x/proj", root), "");
  assert.equal(toWorkspaceRelativePath("/Users/x/other/a.ts", root), "/Users/x/other/a.ts", "项目外不许假装在项目里");
  // 前缀相似但不是子目录：`/Users/x/proj-2/a.ts` 不能被折成 `-2/a.ts`。
  assert.equal(toWorkspaceRelativePath("/Users/x/proj-2/a.ts", root), "/Users/x/proj-2/a.ts");
  assert.equal(toWorkspaceRelativePath("/Users/x/proj/src/a.ts", `${root}/`), "src/a.ts", "根带尾斜杠也要认");
  assert.equal(toWorkspaceRelativePath("  /Users/x/proj/a.ts  ", root), "a.ts");
  assert.equal(toWorkspaceRelativePath(null, root), "");
  assert.equal(toWorkspaceRelativePath("/Users/x/proj/a.ts", ""), "/Users/x/proj/a.ts", "没有根就原样");
});

/**
 * 卡片要显示的**行数**：`display.files` 是投影层算好的真实 patch 统计。
 *
 * 三条规则各自都容易被"想当然"实现错：
 * - **同一个文件取最后一次**：`edit` 的 display 只描述那一次补丁，相加会把同一段代码算两遍。
 * - **顺序按第一次出现**：读者按"agent 先动哪个文件"理解这一轮。
 * - **没有 diff 就说数不出来**（`counted: false`）：正文被预算裁掉时 patch 是空的，
 *   把它显示成「没有增删」是编数字。
 */
test("行数从 display.files 读：路径精确匹配，同一文件取最后一次调用", () => {
  const parts = [
    {
      type: "tool-call",
      toolName: "edit",
      args: { path: "src/a.ts" },
      display: { kind: "fileDiff", files: [{ path: "src/a.ts", added: 3, removed: 1 }] },
    },
    {
      type: "tool-call",
      toolName: "write",
      args: { path: "src/b.ts" },
      display: { kind: "fileDiff", files: [{ path: "src/b.ts", added: 20, removed: 5 }] },
    },
    {
      type: "tool-call",
      toolName: "edit",
      args: { path: "src/a.ts" },
      display: { kind: "fileDiff", files: [{ path: "src/a.ts", added: 7, removed: 2 }] },
    },
  ];

  assert.deepEqual(collectTurnChangedFilesWithCounts(parts), [
    // 顺序是第一次出现的顺序；数字是 a.ts 最后一次编辑的（7/2），不是 3+7=10。
    { path: "src/a.ts", added: 7, removed: 2, counted: true },
    { path: "src/b.ts", added: 20, removed: 5, counted: true },
  ]);
});

test("display 只有一个文件时也认它（edit 的 display 可能不带完整路径）", () => {
  const parts = [
    {
      type: "tool-call",
      toolName: "edit",
      args: { path: "/Users/x/proj/src/a.ts" },
      display: { kind: "fileDiff", files: [{ path: "src/a.ts", added: 1, removed: 1 }] },
    },
  ];
  assert.deepEqual(collectTurnChangedFilesWithCounts(parts), [
    { path: "/Users/x/proj/src/a.ts", added: 1, removed: 1, counted: true },
  ]);
});

test("没有 fileDiff display（读工具 / 没 diff / 大文件省略）都是 counted:false", () => {
  const parts = [
    { type: "tool-call", toolName: "write", args: { path: "src/a.ts" } },
    {
      type: "tool-call",
      toolName: "bash",
      args: { command: "touch src/b.ts" },
      display: { kind: "terminal" },
    },
    {
      type: "tool-call",
      toolName: "write",
      args: { path: "src/c.ts" },
      display: { kind: "none" },
    },
  ];
  assert.deepEqual(collectTurnChangedFilesWithCounts(parts), [
    { path: "src/a.ts", added: 0, removed: 0, counted: false },
    { path: "src/c.ts", added: 0, removed: 0, counted: false },
  ]);
});

test("行数统计也吃空输入", () => {
  for (const value of [[], null, undefined, "x", {}, 7]) {
    assert.deepEqual(collectTurnChangedFilesWithCounts(value as never), []);
  }
});
