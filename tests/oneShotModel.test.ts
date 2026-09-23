/**
 * 「一次性小任务」模型调用的公共规则（server/oneShotModel.mjs）：
 * - 始终思考型模型（如 bailian 的 GLM 5.3 系列）必须显式给思考档位，否则 pi-ai 发
 *   `enable_thinking:false` 会被端点 400；
 * - pi-ai 请求失败时不抛异常，而是返回 stopReason:"error" 的消息，必须把真实错误抽出来。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { oneShotModelError, oneShotThinkingEffort } from "../server/oneShotModel.mjs";

/** bailian 上 Qwen 系列：支持关闭思考（thinkingLevelMap 没有 off:null）。 */
const qwenLikeModel = {
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
};

/** bailian 上 GLM 5.3 系列：始终思考，off/minimal/medium 都映射为 null。 */
const glmAlwaysThinkingModel = {
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, medium: null, low: "low", high: "high", max: "max" },
};

test("非 reasoning 模型不传思考档位", () => {
  assert.equal(oneShotThinkingEffort({ reasoning: false }), undefined);
  assert.equal(oneShotThinkingEffort(undefined), undefined);
  assert.equal(oneShotThinkingEffort(null), undefined);
});

test("支持关闭思考的模型保持原行为（不传档位）", () => {
  assert.equal(oneShotThinkingEffort(qwenLikeModel), undefined);
});

test("始终思考的模型取最低可用档（GLM 5.3 → low）", () => {
  assert.equal(oneShotThinkingEffort(glmAlwaysThinkingModel), "low");
});

test("没有 thinkingLevelMap 的 reasoning 模型按 off 可用处理", () => {
  assert.equal(oneShotThinkingEffort({ reasoning: true }), undefined);
});

test("oneShotModelError：pi-ai 的错误响应要抽出真实 errorMessage", () => {
  const response = {
    stopReason: "error",
    errorMessage: '400: {"message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}',
    content: [],
  };
  assert.equal(
    oneShotModelError(response),
    '400: {"message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}',
  );
});

test("oneShotModelError：errorMessage 为空时给兜底文案", () => {
  assert.equal(oneShotModelError({ stopReason: "error", errorMessage: "", content: [] }), "模型调用失败，请重试。");
  assert.equal(oneShotModelError({ stopReason: "error", content: [] }), "模型调用失败，请重试。");
});

test("oneShotModelError：正常/截断响应不是错误", () => {
  assert.equal(oneShotModelError({ stopReason: "stop", content: [] }), null);
  assert.equal(oneShotModelError({ stopReason: "length", content: [] }), null);
  assert.equal(oneShotModelError(undefined), null);
});
