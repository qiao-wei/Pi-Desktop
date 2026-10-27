import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const parts = readFileSync(
  new URL("../src/features/chat/assistantUiParts.ts", import.meta.url),
  "utf8",
);
const toolRow = readFileSync(
  new URL("../src/components/assistant-ui/elements/tool-row.tsx", import.meta.url),
  "utf8",
);

/**
 * 工具行的两条运行期契约。
 *
 * 一、**状态不能靠猜**。assistant-ui 用 result 是否存在推断工具状态
 * （core/runtime/utils/auto-status.js: `isPendingToolCall = type === "tool-call" && result === undefined`），
 * 所以执行中的部分输出绝不能塞进 `result`：第一块输出一到 aui 就判定工具已完成。
 * 部分输出走 `partialResult` 这个独立字段。
 *
 * 二、**运行中不自动展开**（2026-10-27 改为对齐 ZCode 的行为）。ZCode 的 ToolLayout
 * `autoOpen` 默认 false，唯一的自动收起只属于它的 Agent 渲染器；所以这里也不能有
 * 「开始跑就展开、结束就收起」那套。渲染层仍然要显示 partialResult —— 展开后看得见，
 * 不展开时那行本身也仍然是「正在跑」。
 */
test("tool parts keep result undefined while the tool is still executing", () => {
  const toolPart = parts.slice(
    parts.indexOf("const toolSettled"),
    parts.indexOf("export function userMessageText"),
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

test("运行中的工具行用 partialResult 兜底，但不会自己展开/收起", () => {
  assert.match(
    toolRow,
    /const resultText = result \?\? partialResult \?\? ""/,
    "renderer must fall back to the streamed partial output",
  );
  // 上一版是 `useState(running)` + `setIntentOpen(running)`（运行中自动展开、
  // 结束自动收起、还要过折叠闸门）。ZCode 没有这套，行只在用户点击时开。
  assert.doesNotMatch(toolRow, /useState\(running\)/, "工具行不能随运行态自动展开");
  assert.doesNotMatch(toolRow, /setIntentOpen\(/, "工具行不再有「意图态」这层");
  assert.doesNotMatch(toolRow, /useDeferredCollapse/, "自动收起没了，折叠闸门也就不该再出现在行里");
  assert.match(toolRow, /const \[open, setOpen\] = useState\(false\)/, "默认收起，只由读者打开");
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
  const thinkingPart = parts.slice(
    parts.indexOf('if (block.kind === "thinking")'),
    parts.indexOf("// Notices are narrative text"),
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