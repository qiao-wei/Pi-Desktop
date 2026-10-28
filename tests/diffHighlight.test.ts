import assert from "node:assert/strict";
import test from "node:test";

import {
  diffHighlightRuns,
  mapHighlightTokens,
  shouldHighlightLanguage,
  type HighlightTokenLike,
} from "../src/shared/diffHighlight.ts";

/**
 * 内联 diff 的第二遍高亮：这里只钉**计划**（纯函数）。真实 token 从 shiki 来，但「哪段一起
 * tokenize」「token 怎么贴回行」「贴不上怎么办」是规则，值得逐条钉住 —— 尤其是「贴不上就
 * 不着色」：颜色错行比没有颜色糟得多。
 */
const line = (kind: "added" | "removed" | "context", text: string) => ({ kind, text });
const tokens = (...content: string[]): HighlightTokenLike[] =>
  content.map((entry) => ({ content: entry, color: "#abc" }));

test("按同一种行切段：一段一次 tokenize，跨行语法才连得上", () => {
  const lines = [
    line("context", "const a = 1;"),
    line("removed", "const b = 2;"),
    line("added", "const b = 3;"),
    line("added", "const c = 4;"),
  ];
  assert.deepEqual(
    diffHighlightRuns(lines).map((run) => [run.start, run.kind, run.lineCount, run.text]),
    [
      [0, "context", 1, "const a = 1;"],
      [1, "removed", 1, "const b = 2;"],
      [2, "added", 2, "const b = 3;\nconst c = 4;"],
    ],
  );
});

test("token 贴回整篇行号，保留颜色", () => {
  const lines = [line("context", "let a = 1;"), line("added", "let b = 2;")];
  const runs = diffHighlightRuns(lines);
  const map = mapHighlightTokens(lines, runs, [
    [tokens("let", " ", "a", " = ", "1;")],
    [tokens("let", " ", "b", " = ", "2;")],
  ]);
  assert.deepEqual(map.get(0)?.map((span) => span.text), ["let", " ", "a", " = ", "1;"]);
  assert.equal(map.get(1)?.[0]?.color, "#abc");
  assert.equal(map.size, 2);
});

test("行数对不上就整段丢弃（不能只画前几行）", () => {
  const lines = [line("added", "a"), line("added", "b"), line("added", "c")];
  const runs = diffHighlightRuns(lines);
  const map = mapHighlightTokens(lines, runs, [[tokens("a"), tokens("b")]]);
  assert.equal(map.size, 0, "少一行 ⇒ 这一段的颜色一律不画");
});

test("正文对不上就整段丢弃（颜色会画到别的行上）", () => {
  const lines = [line("added", "const a = 1;"), line("added", "const b = 2;")];
  const runs = diffHighlightRuns(lines);
  const map = mapHighlightTokens(lines, runs, [
    [tokens("const a = 1;"), tokens("const c = 2;")],
  ]);
  assert.equal(map.size, 0);
});

test("整段失败只丢那一段，其它段照常", () => {
  const lines = [line("removed", "old"), line("added", "new")];
  const runs = diffHighlightRuns(lines);
  const map = mapHighlightTokens(lines, runs, [undefined, [tokens("new")]]);
  assert.equal(map.has(0), false, "undefined 的段不画");
  assert.equal(map.get(1)?.[0]?.text, "new");
});

test("一个没有颜色的 token 不值得包 span（纯文本就是最终形态）", () => {
  const lines = [line("context", "plain text")];
  const runs = diffHighlightRuns(lines);
  const map = mapHighlightTokens(lines, runs, [[[{ content: "plain text" }]]]);
  assert.equal(map.size, 0);
});

test("空格子行也能对上（token 是空数组）", () => {
  const lines = [line("context", ""), line("added", "")];
  const runs = diffHighlightRuns(lines);
  const map = mapHighlightTokens(lines, runs, [[[]], [[]]]);
  assert.equal(map.size, 0, "空行没什么可画的，但不许因此丢掉别的段");
});

test("纯文本语言不必跑第二遍（`log` 在 shiki 里没有语法规则）", () => {
  assert.equal(shouldHighlightLanguage("log", "log"), false);
  assert.equal(shouldHighlightLanguage("", "log"), false);
  assert.equal(shouldHighlightLanguage("typescript", "log"), true);
});