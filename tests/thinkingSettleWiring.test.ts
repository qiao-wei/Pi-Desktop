import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Wiring guard for the "推理面板一直转圈" fix.
 *
 * Some providers (`openai-completions` and friends) finalize *every* content block
 * only after the whole message stream has ended - measured 0.4-4.1s after the last
 * thinking token on a real session, by which time the tool card below is already
 * running. pi still streams the blocks in order, so the adapter settles the thinking
 * block at the first structural edge that proves it is over, instead of waiting for
 * the provider. These assertions keep that wiring in place; the behavioural half of
 * the contract ("a textless close must not touch streamed text") lives in
 * `chatStreamProjection.test.ts`.
 */

const server = readFileSync(join(import.meta.dirname, "../server/index.mjs"), "utf8");

test("the adapter synthesizes a textless settle instead of waiting for the provider", () => {
  assert.match(
    server,
    /const settleThinking = \(\) => \{[\s\S]{0,400}type: "assistant_partial"[\s\S]{0,160}closeThinking: true/,
    "settleThinking 必须还在发 assistant_partial + closeThinking",
  );
  // Carrying the cumulative text here is exactly the duplicate-first-chunk bug.
  assert.match(
    server,
    /closeThinking: true,\s*blocks: \[\{ type: "thinking", thinking: "", streamKey: key \}\]/,
    "合成关圈只能带身份、不能带正文",
  );
  assert.match(
    server,
    /const key = openThinkingKey;\s*if \(!key\) \{\s*return;\s*\}/,
    "没有未闭合的块时必须什么都不发",
  );
});

test("every structural edge that proves the thinking block ended settles it", () => {
  // Answer text can only follow a finished thinking block in the same message.
  assert.match(
    server,
    /assistantEvent\.type === "text_delta"[\s\S]{0,120}settleThinking\(\)/,
    "正文 delta 前要关圈",
  );
  // A tool call is the next content block.
  assert.match(
    server,
    /assistantEvent\.type === "toolcall_start"[\s\S]{0,160}settleThinking\(\)/,
    "工具调用开始前要关圈",
  );
  // The next thinking round begins where the previous one ended; tracked from the
  // deltas because some providers never name the block before its first token.
  assert.match(
    server,
    /if \(openThinkingKey && openThinkingKey !== thinkingKey\) \{\s*settleThinking\(\);/,
    "换一个 key 的 delta 要先关掉上一块",
  );
  // An assistant message that ends with the key still open means the provider
  // never closed the block (openai-completions tail-finish, abort skips).
  assert.match(
    server,
    /event\.message\.role === "assistant"\) \{\s*settleThinking\(\);/,
    "assistant message_end 要兑掉残留的 open key",
  );
  // Tool execution only happens between assistant messages, so any open key
  // there is stale; these edges are the last line of defense for a lost settle.
  assert.match(
    server,
    /event\.type === "tool_execution_start"\) \{[\s\S]{0,400}settleThinking\(\);/,
    "tool_execution_start 要兑掉残留的 open key",
  );
  assert.match(
    server,
    /event\.type === "tool_execution_update"\) \{\s*settleThinking\(\);/,
    "tool_execution_update 要兑掉残留的 open key",
  );
  assert.match(
    server,
    /event\.type === "tool_execution_end"\) \{\s*settleThinking\(\);/,
    "tool_execution_end 要兑掉残留的 open key",
  );
  // toolcall_delta/end stay INSIDE the message stream: settling there would
  // kill a genuinely live thinking panel that some providers interleave after
  // the first tool call of the same message.
  assert.equal(
    /assistantEvent\.type === "toolcall_delta"[\s\S]{0,160}settleThinking\(\)/.test(server),
    false,
    "toolcall_delta 不得关圈（同一条消息内 thinking 可能还在流）",
  );
});

test("the provider's own thinking_end still publishes the authoritative text", () => {
  assert.match(
    server,
    /assistantEvent\.type === "thinking_end"[\s\S]{0,700}closeThinking: true,[\s\S]{0,200}assistantThinkingBlocks\(/,
    "真收尾仍要带全量正文（逐 token 丢包时靠它纠正）",
  );
  assert.match(
    server,
    /if \(openThinkingKey === thinkingStreamKeyOf\(assistantEvent\.contentIndex\)\) \{\s*openThinkingKey = null;/,
    "真收尾之后不要对同一块再合成一次",
  );
  // Opening snapshot is dead traffic and the source of the duplicated first chunk.
  assert.equal(
    /assistantEvent\.type === "thinking_start"[\s\S]{0,300}type: "assistant_partial"/.test(server),
    false,
    "不得在 thinking_start 发累计快照",
  );
});

/**
 * 交错 provider（DeepSeek/DashScope 实测 `R C R C T`，约一半的 run）在服务端**不**切段：
 * pi 每条 assistant 消息只维护一块 thinking，回流 delta 复用同一个 key，收尾快照就是那
 * 一块的全文。位置与正文都由客户端保证——同一 key 的 delta 并回原块，而不是在末尾另开
 * 一块（否则一段思考变两个面板，夹在中间的正文被劈成两句）。行为见
 * `chatStreamProjection.test.ts` 的「交错思考不得把正文劈成两句」。
 */
test("回流思考不在服务端切段：delta 与收尾都走块自己的 key", () => {
  assert.match(
    server,
    /thinkingStreamKey: thinkingKey,\s*\n\s*delta: assistantEvent\.delta,/,
    "delta 必须下发块 key（回流沿用同一 key，由客户端并回原块）",
  );
  assert.equal(server.includes("thinkingSegments"), false, "不得再有段状态表");
  assert.equal(server.includes("thinkingSegmentBlocks"), false, "不得在服务端切段");
  // 收尾快照原样下发整块正文：客户端同一 key 只有一块，写进去就是最终正文
  assert.match(
    server,
    /closeThinking: true,\s*blocks: assistantThinkingBlocks\(assistantEvent\.partial\.content, thinkingStreamKeyOf\),/,
    "收尾按块下发权威正文",
  );
  assert.match(
    server,
    /closeThinking: true,\s*blocks: \[\{ type: "thinking", thinking: "", streamKey: key \}\]/,
    "合成关圈关的是块自己的 key",
  );
});
