/**
 * 侧栏会话行末尾的 worktree 徽标。
 *
 * 显示规则在 `src/shared/sessionWorktree.ts` 的纯函数里（这里直接覆盖），React/服务端接线
 * 按仓库惯例从源码断言 —— `App.tsx` 是 .tsx，`server/index.mjs` 一 import 就起服务，两者都
 * 只能读源码。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { worktreeSessionBadgeKind } from "../src/shared/sessionWorktree.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const domainSource = readFileSync(new URL("../src/types/domain.ts", import.meta.url), "utf8");

/** 取一个顶层函数的源码段（到下一个顶层 `function ` 为止）。 */
function functionSection(name: string): string {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = appSource.indexOf("\nfunction ", start + 1);
  return end === -1 ? appSource.slice(start) : appSource.slice(start, end);
}

test("only sessions flagged as worktrees get the list badge", () => {
  assert.equal(worktreeSessionBadgeKind(undefined), "hidden");
  assert.equal(worktreeSessionBadgeKind(null), "hidden");
  assert.equal(worktreeSessionBadgeKind({}), "hidden");
  assert.equal(worktreeSessionBadgeKind({ inWorktree: false }), "hidden");
  assert.equal(worktreeSessionBadgeKind({ inWorktree: true }), "worktree");
});

test("the badge rule ignores anything but the flag (no per-session git lookup)", () => {
  // 传入额外字段（cwd / exists 之类）也不该改变判断。
  assert.equal(worktreeSessionBadgeKind({ inWorktree: true, cwd: "/tmp/x", exists: false }), "worktree");
  assert.equal(worktreeSessionBadgeKind({ inWorktree: false, cwd: "/tmp/x" }), "hidden");
});

test("the sidebar session row renders a worktree glyph after the title", () => {
  const body = functionSection("SidebarSessionRow");
  assert.match(body, /worktreeSessionBadgeKind\(session\)/, "行内要用纯规则决定显不显示");
  assert.match(body, /<GitFork/, "徽标用 GitFork，和会话头部一致");
  assert.match(body, /t\("worktree\.badge"\)/, "无障碍文案走语言包");
});

test("the session summary carries the inWorktree flag", () => {
  assert.match(domainSource, /inWorktree\?: boolean/, "ProjectSessionSummary 要有 inWorktree");
});

test("the server derives inWorktree from the same workspace rule the header badge uses", () => {
  const start = serverSource.indexOf("function listProjectSessions(");
  assert.notEqual(start, -1, "listProjectSessions is gone from server/index.mjs");
  const end = serverSource.indexOf("\nfunction ", start + 1);
  const body = serverSource.slice(start, end === -1 ? serverSource.length : end);
  assert.match(body, /resolveSessionWorkspaceCwd\(/, "判定要复用 workspace 唯一规则");
  assert.match(body, /reason === "worktree"/, "只有真的还在 worktree 里才算（目录没了要消失）");
  assert.match(body, /inWorktree:/, "结果要写进会话摘要");
});