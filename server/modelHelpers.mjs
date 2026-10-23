/**
 * 模型端点与用量的纯函数.
 *
 * OpenAI 兼容请求、模型描述、用量字段与 OAuth 元数据。
 *
 * 从 `server/index.mjs` 搬出来的纯函数（只依赖 import 进来的东西，不碰模块状态）——
 * 那个文件曾经 8.7k 行、棘轮不许它再长，所以按「一簇一文件」往外搬。
 */
import { supportedThinkingLevelsFor } from "./piKernel.mjs";

/**
 * @param {string} endpoint
 * @param {{
 *   apiKey?: string,
 *   payload?: unknown,
 *   signal?: AbortSignal,
 *   headers?: Record<string, string>,
 * }} [options]
 * @returns {Promise<{ payload: any }>}
 */
async function requestOpenAiJson(endpoint, { apiKey, payload, signal, headers } = {}) {
  const key = String(apiKey ?? "").trim();
  const response = await fetch(endpoint, {
    method: payload ? "POST" : "GET",
    headers: {
      // 没 key 就不发空头（同 listingPlan 的规矩）：`Bearer ` 会被严一点的服务端直接 400。
      ...(headers ?? (key ? { authorization: `Bearer ${key}` } : {})),
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal,
  });
  const text = await response.text().catch(() => "");
  /** @param {string} message @param {number} limit @returns {Error & { status: number, body: string }} */
  const httpError = (message, limit) => Object.assign(new Error(message), {
    status: response.status,
    body: text.slice(0, limit),
  });
  if (!response.ok) {
    throw httpError(`HTTP ${response.status}`, 300);
  }
  try {
    return { payload: JSON.parse(text) };
  } catch {
    throw httpError("端点返回的不是 JSON。", 200);
  }
}

function describeModel(model, available = true) {
  return {
    provider: model.provider,
    model: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    // 复用 pi 的按模型档位能力：composer 菜单显示几档，完全由模型的 thinkingLevelMap 决定
    // （null / 未声明 xhigh·max = 不存在；off..high 未声明 = pi 默认放行）。
    // 不再写“没映射表就按 off 处理”—— pi 对开了推理但没写映射表的模型给的是 off..high，
    // 前端按 off 渲染会让菜单与真实能力脱节。
    supportedThinkingLevels: supportedThinkingLevelsFor(model),
    supportsImages: model.input?.includes("image") ?? false,
    available,
  };
}

function usageFields(targetSession, prepared = {}) {
  const stats = prepared.stats ?? targetSession.getSessionStats();
  const entries = prepared.entries ?? targetSession.sessionManager.getEntries();
  const contextUsage = prepared.contextUsage ?? targetSession.getContextUsage();
  return {
    contextTokens: contextUsage?.tokens ?? null,
    contextWindow: contextUsage?.contextWindow,
    contextPercent: contextUsage?.percent ?? null,
    tokenUsage: stats.tokens
      ? {
          ...stats.tokens,
          estimatedCostUsd: stats.cost,
          reasoning: entries.reduce((total, entry) => {
            const usage = entry.usage ?? (entry.type === "message" ? entry.message?.usage : undefined);
            return total + Number(usage?.reasoning ?? 0);
          }, 0),
        }
      : undefined,
  };
}

function loginOauthMetadata(provider) {
  const oauth = provider?.auth?.oauth;
  if (!oauth || typeof oauth !== "object") {
    return null;
  }
  const name = String(oauth.name ?? "").trim();
  const label = String(oauth.loginLabel ?? "").trim();
  if (!name && !label) {
    return null;
  }
  return { name, label, subscription: oauth.isSubscription === true };
}

export { requestOpenAiJson, describeModel, usageFields, loginOauthMetadata };
