/**
 * 把整份转录切成"轮"的窗口：快照只带尾部，翻页按段往前取。
 *
 * 单独成模块有两个理由：
 * 1. **可测**：窗口是纯函数，边界（第 1 轮、超出总轮数、单轮会话）值得直接断言，
 *    而不是从 HTTP 响应里倒推。
 * 2. **同一套规则**：快照的尾部窗口和 `GET /api/sessions/messages` 的翻页必须按同一种
 *    方式切，否则边界处会重复一页或漏一轮。
 *
 * 约定：**轮次是绝对的 1 基编号**（第 n 条 user 消息 = 第 n 轮）。切出来的片段永远从该轮
 * 的第一条 user 消息开始，不会把回答和它的工具结果切开——切开会让 `buildChatBubbles`
 * 以为这一轮还没答完，渲染出一个假的"正在回答"。
 */
import { countTranscriptTurns } from "../src/shared/chatBubbles.ts";

/**
 * 快照里带多少轮对话（一轮 = 一条 user 消息 + 它的回答与工具往返）。
 *
 * 对齐 ZCode 的 `snapshotTailWindowRows: 60`：他们连渲染都只渲染窗口内的行。理由是
 * 一份快照的代价必须与**屏幕上的内容**成正比，而不是与会话活了多久成正比——否则打开
 * 一个 300 轮的会话和打开一个 20 轮的会话，代价差一个数量级，而这笔代价落在主线程的
 * `JSON.parse` 上（`src/lib/bridge/transport.ts`）。
 *
 * 注意窗口只截**内容**：气泡编号（`t{turn}#role`）仍按整份转录数，靠 `turnOffset` 保持绝对，
 * 见 `buildChatBubbles` 的选项注释。少了这一条，窗口一滑动整段历史就会 remount。
 */
export const CONVERSATION_TAIL_TURNS = (() => {
  // 测试/诊断用的覆盖：桥的集成测试不想为了验证"窗口生效"真的跑 61 轮对话。
  // 不设时就是 60（默认行为 = ZCode 的 60）。
  const configured = Number(process.env.PI_DESKTOP_CONVERSATION_TAIL_TURNS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 60;
})();
/** 往前翻一页的默认轮数（ZCode 的 `rowsRangeMaxLimit = 200` 是单页上限，这里默认取 60）。 */
export const CONVERSATION_PAGE_TURNS = 60;
/** 单页上限：客户端要多少都不给更多，避免"翻历史"变成一个变相的全量拉取。 */
export const CONVERSATION_PAGE_MAX_TURNS = 200;

/**
 * 按**轮**取一段转录：`fromTurn..toTurn`（含两端，1 基）。
 *
 * 返回的 `messages` 从该轮的第一条 user 消息开始，到下一轮之前为止。
 */
export function transcriptTurnWindow(messages, fromTurn, toTurn) {
  const totalTurns = countTranscriptTurns(messages);
  const startTurn = Math.max(1, Math.min(fromTurn, totalTurns || 1));
  const endTurn = Math.max(startTurn, Math.min(toTurn, totalTurns));
  const windowed = [];
  let turn = 0;
  for (const message of messages) {
    if (message.role === "user") {
      turn += 1;
      if (turn > endTurn) {
        break;
      }
    }
    if (turn >= startTurn) {
      windowed.push(message);
    }
  }
  return { messages: windowed, startTurn, endTurn, totalTurns };
}

/** 尾部窗口：最后 `tailTurns` 轮。`hasMoreBefore` 直接回答"还有没有更早的"。 */
export function transcriptTailWindow(messages, tailTurns = CONVERSATION_TAIL_TURNS) {
  const totalTurns = countTranscriptTurns(messages);
  const startTurn = Math.max(1, totalTurns - Math.max(1, tailTurns) + 1);
  const window = transcriptTurnWindow(messages, startTurn, totalTurns);
  return { ...window, hasMoreBefore: window.startTurn > 1 };
}

/**
 * 翻页窗口：客户端手里最老的一轮是 `beforeTurn`，给它**再往前**一页。
 *
 * `limit` 会被夹到 `1..CONVERSATION_PAGE_MAX_TURNS`；`beforeTurn <= 1` 时没有更早的内容，
 * 返回空页（`hasMoreBefore: false`）——不是报错。
 */
export function transcriptPageWindow(messages, beforeTurn, limit = CONVERSATION_PAGE_TURNS) {
  const totalTurns = countTranscriptTurns(messages);
  const requestedTurns = Number(limit ?? CONVERSATION_PAGE_TURNS);
  const pageTurns = Number.isFinite(requestedTurns) && requestedTurns > 0
    ? Math.min(Math.floor(requestedTurns), CONVERSATION_PAGE_MAX_TURNS)
    : CONVERSATION_PAGE_TURNS;
  const requestedBefore = Number(beforeTurn ?? 0);
  const endTurn = Number.isFinite(requestedBefore) && requestedBefore > 1
    ? Math.min(totalTurns, Math.floor(requestedBefore) - 1)
    : 0;
  if (endTurn < 1) {
    return {
      messages: [],
      startTurn: Math.max(1, totalTurns),
      endTurn: 0,
      totalTurns,
      hasMoreBefore: false,
    };
  }
  const window = transcriptTurnWindow(messages, Math.max(1, endTurn - pageTurns + 1), endTurn);
  return { ...window, hasMoreBefore: window.startTurn > 1 };
}