/**
 * 「一次性小任务」模型调用（生成提交信息、生成会话标题这类辅助请求）的公共规则。
 *
 * 背景：pi-ai 对 thinkingFormat 为 qwen 的 reasoning 模型，在没有传 reasoningEffort 时会发
 * `enable_thinking: false`。bailian 上的「始终思考」型模型（GLM 5.3 系列）不支持关闭思考，
 * 会直接 400（「该模型始终思考，不支持关闭思考；请使用 low、high 或 max」）。而且 pi-ai 的
 * stream 不抛异常，而是返回 `stopReason: "error"` 的消息，调用方若只取文本就会把真实错误
 * 吞成「模型没有返回内容」。
 *
 * 因此一次性调用要：
 * 1. 对不支持关闭思考的模型显式给一档可用的思考等级（`oneShotThinkingEffort`）；
 * 2. 拿到结果后先检查 `stopReason`，把真实错误抛出来（`oneShotModelError`）。
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

/**
 * 一次性调用应使用的思考档位：
 * - 非 reasoning 模型：不传（维持原行为）；
 * - 支持关闭思考（thinkingLevelMap 的 off 不是 null）的模型：不传，保持「关思考、快且省」；
 * - 始终思考的模型：取最低可用档（如 GLM 5.3 Flash → "low"）。
 */
export function oneShotThinkingEffort(model) {
  if (!model?.reasoning) {
    return undefined;
  }
  const levels = getSupportedThinkingLevels(model);
  if (levels.includes("off")) {
    return undefined;
  }
  return levels[0];
}

/**
 * pi-ai 的 stream/complete 不 throw：请求失败时返回 `stopReason: "error"` 的消息，
 * 文本内容为空。这里把真实错误信息抽出来给调用方抛，避免被「没有返回内容」误导。
 * 返回 null 表示不是错误响应。
 */
export function oneShotModelError(response) {
  if (response?.stopReason !== "error") {
    return null;
  }
  return String(response.errorMessage ?? "").trim() || "模型调用失败，请重试。";
}
