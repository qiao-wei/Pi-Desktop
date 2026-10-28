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
/**
 * 展开态的两个行为（用户 2026-10-27 实测的 bug）：正文是个限高滚动区，所以
 *   1. 流式追加时必须**吸底跟随**，否则新 token 全在视野外；
 *   2. 但读者自己往上滚之后必须**停止跟随**（继续拉回去等于抢滚动条），滚回底部恢复。
 * 两条都是 ZCode `ReasoningContent` 的语义（它的 `autoFollowBottomRef`）。
 */
test("展开的正文吸底跟随，读者上滚后暂停、回到底部再恢复", () => {
  assert.match(thinkingRow, /const autoFollow = useRef\(true\)/, "默认吸底");
  assert.match(
    thinkingRow,
    /autoFollow\.current = isScrolledToBottom\(viewport\)/,
    "跟随与否由读者当前的滚动位置决定",
  );
  assert.match(thinkingRow, /if \(autoFollow\.current\) \{\s*scrollToBottom\(\);/, "在底部时把新内容推到视野内");
  // 内容增长有两个来源（新 token / 展开动画后的重测），两个节点都要观察。
  assert.match(thinkingRow, /new ResizeObserver\(sync\)/);
  assert.match(thinkingRow, /observer\.observe\(viewport\)/);
  assert.match(thinkingRow, /observer\.observe\(contentRef\.current\)/);
  // 折叠态卸载后回到「下次展开从最新一行开始」。
  assert.match(thinkingRow, /autoFollow\.current = true;/, "重新打开时恢复跟随");
});

test("正文的上下渐隐跟着滚动位置走（ZCode 的 scroll mask）", () => {
  assert.match(thinkingRow, /data-scroll-mask=\{/);
  assert.match(thinkingRow, /style=\{scrollMaskStyle\(mask\)\}/);
  assert.match(thinkingRow, /onScroll=\{handleScroll\}/);
});

/**
 * 运行态标签的**可见性**。
 *
 * `tw-shimmer` 是拿 `currentColor` 派生扫光的（亮档 = currentColor，暗档 = 20%）。
 * 之前这里同时挂了 `text-foreground-subtlest`（40%），于是亮档只有 40%、暗档 8% ——
 * 一行几乎不动的淡灰字，读者看到的是"没有效果"。ZCode 的 `ThinkingShimmer` 不设颜色。
 */
test("正在思考的扫光不被淡色压掉（亮档走全强度前景色）", () => {
  assert.match(
    thinkingRow,
    /<ShimmerLabel className="shimmer-spread-30 shimmer-angle-0 font-medium">/,
    "运行态标签只带 font-medium（外加窄扫光带）",
  );
  assert.doesNotMatch(
    thinkingRow,
    /<ShimmerLabel className="[^"]*text-foreground-subtlest/,
    "不能给扫光再叠一档淡色：那会把扫光压到看不见",
  );
});
