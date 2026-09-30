/**
 * 「自动解决冲突」的提示词组装（纯函数，`server/conflictPrompt.mjs`）。
 *
 * 这里只验文案本身：冲突清单、带标记的内容、以及「冲突不在本会话工作目录」的显式提醒。
 * 真正的读取（`readConflictContext`）在 `tests/gitInfo.test.ts` 里测。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildConflictPrompt } from "../server/conflictPrompt.mjs";

const CONTEXT = {
  branch: "feature/x",
  cwd: "/tmp/repo",
  projectCwd: "/tmp/repo",
  files: [{ path: "src/app.ts", text: "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> main\n", truncated: false }],
  skipped: 0,
  truncated: false,
};

test("中文提示词：列出冲突文件与带标记的内容，并明确不要提交", () => {
  const prompt = buildConflictPrompt({ locale: "zh", context: CONTEXT });

  assert.match(prompt, /未解决的合并冲突/);
  assert.match(prompt, /当前分支：feature\/x/);
  assert.match(prompt, /- src\/app\.ts/);
  assert.match(prompt, /<<<<<<< HEAD/);
  assert.match(prompt, /不要执行 git commit/);
});

test("英文提示词给英文文案；缺省 locale 走英文", () => {
  const prompt = buildConflictPrompt({ context: CONTEXT });
  assert.match(prompt, /unresolved merge conflicts/);
  assert.match(prompt, /Do not run git commit/);
  assert.doesNotMatch(prompt, /未解决/);
});

test("冲突不在会话工作目录时要显式提醒（worktree 会话的情况）", () => {
  const prompt = buildConflictPrompt({
    locale: "zh",
    context: { ...CONTEXT, cwd: "/tmp/worktrees/abc", projectCwd: "/tmp/repo" },
  });
  assert.match(prompt, /\/tmp\/worktrees\/abc/);
  assert.match(prompt, /不是本会话的工作目录/);

  const same = buildConflictPrompt({ locale: "zh", context: { ...CONTEXT, cwd: "/tmp/repo", projectCwd: "/tmp/repo" } });
  assert.doesNotMatch(same, /不是本会话的工作目录/);
});

test("截断 / 跳过的文件在提示词里要说明，二进制文件带占位说明", () => {
  const prompt = buildConflictPrompt({
    locale: "zh",
    context: {
      ...CONTEXT,
      skipped: 2,
      files: [
        { path: "big.ts", text: "x".repeat(10), truncated: true },
        { path: "logo.png", text: "", truncated: true },
      ],
    },
  });

  assert.match(prompt, /- big\.ts（内容过长，仅展示片段）/);
  assert.match(prompt, /另有 2 个冲突文件未列出/);
  assert.match(prompt, /### logo\.png/);
  assert.match(prompt, /二进制或过大/);
});

test("空冲突清单也不崩（报错发生在 readConflictContext，这里只保证组装安全）", () => {
  const prompt = buildConflictPrompt({ locale: "zh", context: { files: [] } });
  assert.match(prompt, /- \(none\)/);
  assert.match(prompt, /\(unknown\)/);
});