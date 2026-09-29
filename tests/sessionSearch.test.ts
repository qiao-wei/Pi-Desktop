/**
 * 会话搜索纯逻辑的回归测试。
 *
 * 这些规则两端共用：服务端扫文件时决定「算不算命中、给什么片段」，前端拿片段再
 * 做一次同样的大小写不敏感高亮。规则错了，用户看到的就是「明明搜到了却不高亮」
 * 或者「高亮的字根本不在结果里」。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildSnippet,
  clampMatchIndex,
  findMatchRanges,
  findSequenceMatches,
  hasMatch,
  normalizeSearchQuery,
  searchDocuments,
  splitByMatches,
  stepMatchIndex,
  type SessionSearchDocument,
} from "../src/shared/sessionSearch.ts";

const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");

test("normalizeSearchQuery 只去首尾空白，空查询视为不搜", () => {
  assert.equal(normalizeSearchQuery("  hello  "), "hello");
  assert.equal(normalizeSearchQuery(null), "");
  assert.equal(normalizeSearchQuery(undefined), "");
  assert.equal(normalizeSearchQuery("   "), "");
});

test("findMatchRanges 大小写不敏感且命中不重叠", () => {
  assert.deepEqual(findMatchRanges("Foo foo FOO", "foo"), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: 11 },
  ]);
  // 重叠命中只算一处：`aaaa` 里搜 `aa` 是两处，不是三处。
  assert.deepEqual(findMatchRanges("aaaa", "aa"), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
});

test("findMatchRanges 边界：空文本 / 空查询 / limit", () => {
  assert.deepEqual(findMatchRanges("", "a"), []);
  assert.deepEqual(findMatchRanges("abc", ""), []);
  assert.deepEqual(findMatchRanges("abc", "  "), []);
  assert.deepEqual(findMatchRanges("abcabc", "abc", 1), [{ start: 0, end: 3 }]);
});

test("hasMatch 就是 findMatchRanges 的快捷判断", () => {
  assert.equal(hasMatch("Hello World", "world"), true);
  assert.equal(hasMatch("Hello World", "nope"), false);
});

test("buildSnippet 保留命中两侧上下文，并在截断处加省略号", () => {
  const text = "0123456789abcdefghij";
  const range = { start: 10, end: 13 };
  assert.equal(buildSnippet(text, range, 5), "…56789abcdefgh…");
  // 命中在开头 / 结尾时不该多出省略号。
  assert.equal(buildSnippet(text, { start: 0, end: 2 }, 3), "01234…");
  assert.equal(buildSnippet(text, { start: 18, end: 20 }, 3), "…fghij");
});

test("buildSnippet 把换行与连续空白折成单个空格，偏移仍按原文算", () => {
  const text = "第一行\n\n第二行 命中 之后";
  const range = findMatchRanges(text, "命中")[0];
  assert.equal(buildSnippet(text, range), "第一行 第二行 命中 之后");
});

test("splitByMatches 把文本切成普通 / 命中片段", () => {
  assert.deepEqual(splitByMatches("aXbXc", "x"), [
    { text: "a", match: false },
    { text: "X", match: true },
    { text: "b", match: false },
    { text: "X", match: true },
    { text: "c", match: false },
  ]);
  assert.deepEqual(splitByMatches("no hit", "zzz"), [{ text: "no hit", match: false }]);
  assert.deepEqual(splitByMatches("", "a"), []);
});

const doc = (overrides: Partial<SessionSearchDocument> = {}): SessionSearchDocument => ({
  projectId: "p1",
  projectName: "Code",
  sessionPath: "/p/s1.jsonl",
  sessionTitle: "Refactor search",
  updatedAt: 100,
  messages: [
    { bubbleId: "t1#user", role: "user", text: "please add a SEARCH box" },
    { bubbleId: "t1#assistant", role: "assistant", text: "added the search box and tests" },
    { bubbleId: "t2#user", role: "user", text: "unrelated" },
  ],
  ...overrides,
});

test("searchDocuments 同时命中标题与消息，标题在先", () => {
  const { results } = searchDocuments([doc()], "search");
  assert.equal(results.length, 3);
  assert.equal(results[0].kind, "title");
  assert.equal(results[0].messageId, null);
  assert.equal(results[1].kind, "message");
  assert.equal(results[1].messageId, "t1#user");
  assert.equal(results[1].role, "user");
  assert.equal(results[2].messageId, "t1#assistant");
});

test("searchDocuments 同一消息里的多次命中只出一行", () => {
  const { results } = searchDocuments(
    [doc({ messages: [{ bubbleId: "t1#user", role: "user", text: "search search search" }] })],
    "search",
  );
  assert.equal(results.filter((result) => result.kind === "message").length, 1);
});

test("searchDocuments 空查询没结果，limit 截断并回报 truncated", () => {
  assert.deepEqual(searchDocuments([doc()], "   "), { results: [], truncated: false });
  const { results, truncated } = searchDocuments([doc(), doc({ projectId: "p2" })], "search", { limit: 2 });
  assert.equal(results.length, 2);
  assert.equal(truncated, true);
});

test("searchDocuments 保留项目 / 会话元数据，供前端显示层级", () => {
  const { results } = searchDocuments([doc()], "refactor");
  assert.equal(results[0].projectName, "Code");
  assert.equal(results[0].sessionTitle, "Refactor search");
  assert.equal(results[0].sessionPath, "/p/s1.jsonl");
  assert.equal(results[0].updatedAt, 100);
});

test("findSequenceMatches 按文本块顺序编号，块内偏移对得上", () => {
  const matches = findSequenceMatches(["no", "aXbXc", "X"], "x");
  assert.deepEqual(matches, [
    { index: 1, start: 1, end: 2 },
    { index: 1, start: 3, end: 4 },
    { index: 2, start: 0, end: 1 },
  ]);
  assert.deepEqual(findSequenceMatches(["no"], ""), []);
});

test("任务内导航：上下跳回绕，结果清空回到 -1", () => {
  assert.equal(stepMatchIndex(0, 3, 1), 1);
  assert.equal(stepMatchIndex(2, 3, 1), 0);
  assert.equal(stepMatchIndex(0, 3, -1), 2);
  assert.equal(stepMatchIndex(-1, 0, 1), -1);
  assert.equal(clampMatchIndex(-1, 3), 0);
  assert.equal(clampMatchIndex(5, 3), 2);
  assert.equal(clampMatchIndex(0, 0), -1);
});

test("服务端确实挂了 /api/search 且用共用的 searchDocuments", () => {
  assert.match(serverSource, /url\.pathname === "\/api\/search"/);
  assert.match(serverSource, /from "\.\.\/src\/shared\/sessionSearch\.ts"/);
  assert.match(serverSource, /searchDocuments\(/);
});