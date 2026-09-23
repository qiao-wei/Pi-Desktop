/**
 * Regression test for 「工具前面的正文尾部一直保留着一个黑点」.
 *
 * assistant-ui's markdown stylesheet (`@assistant-ui/react-markdown/styles/dot.css`)
 * appends a pulsing `●` caret to `.aui-md[data-status="running"]`. Every answer
 * text block used to be tagged `running` for the whole turn (`isStreaming` alone
 * decided), so the caret stayed parked at the end of each earlier paragraph while
 * the run kept going — the reported shape is 正文 → 工具, where the caret sits on
 * the sentence above the tool cards and never leaves.
 *
 * The fix narrows `running` to the one block that can still be growing. Both
 * halves are asserted here: the pure decision (`liveTextTailIndex`) and the
 * wiring in `ChatThread` that turns it into the part status.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { liveTextTailIndex } from "../src/shared/liveTextTail.ts";

const text = { kind: "text" } as const;
const tool = { kind: "tool" } as const;
const think = { kind: "thinking" } as const;
const notice = { kind: "notice" } as const;

/* -------------------------------------------------------------------------- */
/* Which block owns the caret                                                 */
/* -------------------------------------------------------------------------- */

test("text followed by a tool call is settled — the reported shape", () => {
  // 正文 → 工具：the caret must not belong to the sentence above the cards.
  assert.equal(liveTextTailIndex([text, tool, tool], true), -1);
});

test("the trailing text block is the live tail", () => {
  assert.equal(liveTextTailIndex([tool, tool, text], true), 2);
});

test("only the last of several trailing text blocks is live", () => {
  assert.equal(liveTextTailIndex([tool, text, text, text], true), 3);
});

test("a thinking block after text settles the text too", () => {
  assert.equal(liveTextTailIndex([text, think], true), -1);
});

test("a message ending on a tool has no live text tail", () => {
  assert.equal(liveTextTailIndex([tool, tool], true), -1);
});

test("an empty message has no tail", () => {
  assert.equal(liveTextTailIndex([], true), -1);
});

test("a notice block at the end is not a text tail", () => {
  // Notices are narrative text between process parts; they are never the block
  // still being typed, and `toAssistantUiParts` gives them no status anyway.
  assert.equal(liveTextTailIndex([tool, notice], true), -1);
});

test("nothing is live once the run settles", () => {
  // 静默后所有正文块都是 complete，圆点必须消失。
  for (const blocks of [[text], [tool, text], [text, tool], []] as const) {
    assert.equal(liveTextTailIndex(blocks, false), -1, JSON.stringify(blocks));
  }
});

/* -------------------------------------------------------------------------- */
/* What `running` does upstream                                               */
/* -------------------------------------------------------------------------- */

test("the upstream caret really is keyed on data-status=running", () => {
  // If this assumption ever changes, the reason `running` is narrowed is gone —
  // this is the contract, not an implementation guess.
  const dotCss = readFileSync(
    new URL(
      "../node_modules/@assistant-ui/react-markdown/styles/dot.css",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(dotCss, /\.aui-md\[data-status="running"\]/, "上游删了 running 选择器");
  assert.match(dotCss, /content:\s*var\(--aui-content\)/, "上游不再插入插入符");
});

/* -------------------------------------------------------------------------- */
/* Wiring guards                                                              */
/* -------------------------------------------------------------------------- */

test("ChatThread tags only the computed tail block as running", () => {
  const source = readFileSync(
    new URL("../src/features/chat/ChatThread.tsx", import.meta.url),
    "utf8",
  );
  // The text branch must decide status from `isLiveTail`, never from `isStreaming`
  // alone — that was the bug.
  assert.match(
    source,
    /status: isLiveTail \? \{ type: "running" \} : \{ type: "complete" \}/,
  );
  assert.equal(
    /type: "text",[\s\S]{0,200}?status: isStreaming \? \{ type: "running" \}/.test(source),
    false,
    "正文块不得只看 isStreaming 就标 running",
  );
  assert.match(
    source,
    /const liveTailIndex = liveTextTailIndex\(processBlocks, isStreaming\);/,
    "必须用 liveTextTailIndex 找尾块",
  );
  // The per-block call has to pass the flag through, or nothing is tagged at all.
  assert.match(
    source,
    /toAssistantUiParts\(block, isStreaming, index, index === liveTailIndex\)/,
  );
});