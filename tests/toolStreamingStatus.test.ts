import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chatThread = readFileSync(new URL("../src/features/chat/ChatThread.tsx", import.meta.url), "utf8");
const threadAui = readFileSync(
  new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url),
  "utf8",
);

/**
 * 工具卡片必须"执行中可见、结束后收起"。
 *
 * assistant-ui 用 result 是否存在推断工具状态（core/runtime/utils/auto-status.js:
 * `isPendingToolCall = type === "tool-call" && result === undefined`）。
 * 一旦把执行中的部分输出塞进 `result`，第一块输出一到 aui 就判定工具已完成：
 * loading 动画消失、卡片提前折叠，用户只能等工具跑完再一次性看全部输出
 * （表现就是"卡一会儿，然后突然工具都输出了"）。
 *
 * 所以这条契约不能被改回去：执行中 `result` 必须保持 undefined，部分输出走
 * `partialResult` 这个独立字段，由渲染层兜底显示。
 */
test("tool parts keep result undefined while the tool is still executing", () => {
  const toolPart = chatThread.slice(
    chatThread.indexOf("const toolSettled"),
    chatThread.indexOf("function userMessageText"),
  );
  assert.ok(toolPart.length > 0, "tool part mapping not found");
  assert.match(
    toolPart,
    /result:\s*toolSettled\s*\?\s*block\.resultText\s*:\s*undefined/,
    "result must stay undefined until the tool settles",
  );
  assert.match(toolPart, /partialResult:\s*block\.resultText/, "partial output needs its own field");
  assert.match(
    toolPart,
    /block\.status === "done"\s*\|\|\s*!isStreaming/,
    "settling also needs the bubble-finishing fallback (tools without an end event)",
  );
});

test("tool card renders the partial output and stays open while running", () => {
  assert.match(
    threadAui,
    /toolResult\(result \?\? artifact \?\? partialResult/,
    "renderer must fall back to the streamed partial output",
  );
  // 运行中自动展开、结束自动收起（和 reasoning 组同一套规则）。
  // running 决定的是*意图*；渲染出的 open 还要经过折叠闸门（见 collapseGate.test.ts），
  // 所以这里的名字是 intentOpen —— 别把它改回直接写 DOM 的 setOpen。
  assert.match(threadAui, /useState\(running\)/, "card starts open when running");
  assert.match(threadAui, /setIntentOpen\(running\);/, "card follows the running flag");
});

/**
 * reasoning 面板的“还在想”同样必须是数据里的显式标记。
 *
 * 之前它靠位置猜：“这块 thinking 是不是气泡的最后一块”。位置猜是双向的错：
 * 往前错——工具块追到 thinking 后面，thinking 不再是最后一块 → 面板被判完成、
 * 内容停在半路（“推理突然卡住”）；往后错——对账/重建出来的无标记块恰好排在
 * 最后 → 被判还在输出（“工具卡都出来了，上面的 thinking 还在输出”）。
 * 契约：只有显式 `open === true` 能声称还在输出；无标记的块一律是已完成的历史。
 * （健康流式里的活块由 thinking_delta 每条置 open:true，不受影响。）
 */
test("reasoning part status comes from the explicit open flag, not from being the last part", () => {
  const thinkingPart = chatThread.slice(
    chatThread.indexOf('if (block.kind === "thinking")'),
    chatThread.indexOf("// Notices are narrative text"),
  );
  assert.ok(thinkingPart.length > 0, "thinking part mapping not found");
  assert.match(
    thinkingPart,
    /isStreaming && block\.open === true/,
    "only the explicit open flag may claim still-outputting",
  );
  assert.equal(
    /partIndex === partCount|open \?\?/.test(thinkingPart),
    false,
    "the positional guess must stay gone - it is the false still-outputting source",
  );
});
