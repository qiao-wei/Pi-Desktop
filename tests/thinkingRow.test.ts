import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { lastReasoningLine, reasoningSeconds } from "../src/shared/reasoningText.ts";

const thinkingRow = readFileSync(
  new URL("../src/components/assistant-ui/elements/thinking-row.tsx", import.meta.url),
  "utf8",
);

/**
 * 思考行的回归测试。
 *
 * 折叠的思考行在收起态要回答两个问题：还在想吗？想了多久？这两件事在 ZCode 里都是
 * 客户端算出来的，规则很细（最后一行非空文本、向上取整且下限 1 秒、重建出来的历史块
 * 没有起点就退化成「持续了几秒」）。计算是纯函数，先逐条钉住；接线部分只钉两条旧 bug
 * 不许回来：
 *   1. 「整条消息在跑」不等于「这块在想」（旧版 panels 靠消息级 running 一起闪）；
 *   2. 不能靠位置猜（「是不是最后一块」），流式标志只能来自这一块自己的状态。
 */
test("收起态展示的是最后一行非空文本，而不是开头", () => {
  assert.equal(lastReasoningLine("第一行\n第二行")?.text, "第二行");
  // 流式里尾部常常是空行/空白行：往回找到最后一条有内容的。
  assert.equal(lastReasoningLine("甲\n\n   \n乙\n\n")?.text, "乙");
  assert.equal(lastReasoningLine("  单行  ")?.text, "单行");
  // 行号作为 key：同一个内容跨 chunk 不变，动画不会每帧重放。
  assert.equal(lastReasoningLine("甲\n乙")?.key, "1");
  assert.equal(lastReasoningLine(""), null, "空思考没有摘要行");
  assert.equal(lastReasoningLine("\n \n"), null, "只有空白的思考同样没有摘要");
});

test("时长向上取整、下限一秒；没有起点就不编一个时长", () => {
  assert.equal(reasoningSeconds(0, 1), 1, "0.001 秒也算 1 秒，不能显示 0");
  assert.equal(reasoningSeconds(0, 1000), 1);
  assert.equal(reasoningSeconds(0, 1001), 2, "过了 1 秒就要进位");
  assert.equal(reasoningSeconds(null, 5000), undefined, "重放出来的历史块没有起点");
});

test("流式标志只来自这一块自己的状态，不看整条消息有没有在跑", () => {
  // 旧版把 messageRunning 与 ownStreaming 或在一起，于是文本早就写完的思考块
  // 会一直闪、一直吸底，直到整轮结束。
  assert.doesNotMatch(thinkingRow, /useAuiState/, "思考行不该订阅消息级运行状态");
  assert.match(
    thinkingRow,
    /const streaming = status\?\.type === "running"/,
    "运行态必须来自这一块 part 自己的 status",
  );
  assert.doesNotMatch(thinkingRow, /parts\.length|isLastPart|partIndex ===/, "位置猜必须保持消失");
});

test("默认收起，且没有自动展开/自动收起", () => {
  assert.match(thinkingRow, /const \[open, setOpen\] = useState\(false\)/, "思考行默认收起");
  // ZCode 的 autoCollapseKey 只做「输出边界再收一次」，对默认收起的行是空操作；
  // 旧版这里会随 holdOpen 自己开合，来回推动下面的内容。
  assert.doesNotMatch(thinkingRow, /useState\(holdOpen\)/, "不能随消息状态自动开合");
  assert.doesNotMatch(thinkingRow, /setOpen\(!(?:true|false)\)/, "只有读者能改 open");
  assert.doesNotMatch(thinkingRow, /useDeferredCollapse/, "自动收起没了，折叠闸门不该再被引用");
});

test("正文是纯文本左导轨，不是 markdown、也不是面板", () => {
  // 逐 chunk 重跑 markdown 解析是旧版流式卡顿的来源之一；思考正文保持 pre-wrap。
  assert.match(thinkingRow, /whitespace-pre-wrap/, "思考正文按纯文本保留换行");
  assert.match(
    thinkingRow,
    /ml-2 max-h-60 space-y-2 overflow-auto border-border border-l pl-3\.5/,
    "正文样式对齐 ZCode 的 ReasoningContent（左导轨 + 限高）",
  );
  assert.doesNotMatch(thinkingRow, /MarkdownText|MessageResponse/, "思考正文不走 markdown 渲染");
});