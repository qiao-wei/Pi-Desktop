import type { ModelSummary } from "../../types";
import { fetchJson, postJson } from "../../lib/api";
import { buildCostPayload, buildThinkingLevelMap } from "./customModelForm";
import type { ThinkingLevelDraftMap } from "./customModelForm";

/**
 * 自定义模型接口。真相只有一份：桥把这些条目写进 `~/.pi/agent/models.json`，
 * 前端不另存副本，每次打开设置都重新拉一次，避免和手改文件的人打架。
 */

export interface CustomModelEntry {
  providerId: string;
  providerName: string;
  baseUrl: string;
  api: string;
  /** 模型 id，也就是发给端点的 `model` 字段。 */
  model: string;
  /** 展示名，缺省时由 id 推导。 */
  modelLabel: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** 该模型真实支持的思考档位（桥按 pi 的规则算：null/未声明的 xhigh·max 不算）；空 = 关掉推理。 */
  thinkingLevels?: string[];
  /** 原始档位映射表（编辑器回填用）；undefined = 文件里没这个键。 */
  thinkingLevelMap?: Record<string, string | null>;
  supportsImages: boolean;
  /** 每 100 万 token 的单价（不换算币种，就是个数字）；阶梯价在 `tiers` 里。 */
  cost?: ModelCostConfig;
  /** false = 只有 modelOverrides 的条目，不是这里能编辑的自定义模型。 */
  managed: boolean;
  /** 该 provider 是 pi 内置的：只能改 key，模型字段不能编辑。 */
  builtin?: boolean;
  apiKeyConfigured: boolean;
  available: boolean;
}

export interface CustomModelsResponse {
  modelsPath: string;
  customModels: CustomModelEntry[];
  availableModels?: ModelSummary[];
}

/**
 * 落进 models.json 的价格行。四个顶层价是必填数字（pi 的 schema 要求），`tiers` 可选。
 *
 * 语义由 pi 的 `calculateCost()` 定：本单「输入 + 缓存读 + 缓存写」总量超过某一档的
 * `inputTokensAbove` 时，**整单**按那一档的四个价重算（不是分段累进）。
 */
export interface ModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCostTier extends ModelCostRates {
  inputTokensAbove: number;
}

export interface ModelCostConfig extends ModelCostRates {
  tiers?: ModelCostTier[];
}

/** 表单里的价格：数字按字符串存（跟 contextWindow 同一套，否则打不出“2.”这种中间态）。 */
export interface CostRatesDraft {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

export interface CostTierDraft extends CostRatesDraft {
  inputTokensAbove: string;
}

export interface CostDraft extends CostRatesDraft {
  tiers: CostTierDraft[];
}

/** 表单草稿：数字先按字符串存，否则输入框里打不出"12"这种中间态。 */
export interface CustomModelDraft {
  /** 编辑已有行时定位用；新增时留空。 */
  targetProviderId: string;
  targetModel: string;
  /** 该草稿对应的 provider id（有则测试连接可以复用已存的 key）。 */
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelLabel: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  supportsImages: boolean;
  /** 每档三态草稿（不支持 / 留空走默认 / 自定义值）；只有 reasoning 打开才能配。 */
  thinkingLevels: ThinkingLevelDraftMap;
  /** 价格：四个顶层价 + 可选阶梯行，留空算 0。 */
  cost: CostDraft;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** 只有 id 的兼容形状；带元信息的用 `listing`。 */
  models?: string[];
  /** 按 api 类型解析出来的列表（名字、上下文、最大输出等，能拿到的都带上）。 */
  listing?: ModelListingEntry[];
  api?: string;
  endpoint?: string;
  error?: string;
}

/** 桥按 api 类型解析后的原始行：字段能拿到多少算多少，缺的由表单补默认。 */
export interface ModelListingEntry {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
}

export function fetchCustomModels(): Promise<CustomModelsResponse> {
  return fetchJson<CustomModelsResponse>("/api/custom-models");
}

export function saveCustomModel(draft: CustomModelDraft): Promise<CustomModelsResponse> {
  return postJson<CustomModelsResponse>("/api/custom-models", {
    targetProviderId: draft.targetProviderId || undefined,
    targetModel: draft.targetModel || undefined,
    providerId: draft.providerId || undefined,
    providerName: draft.providerName,
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey || undefined,
    model: draft.model,
    name: draft.modelLabel || undefined,
    contextWindow: draft.contextWindow,
    maxTokens: draft.maxTokens,
    reasoning: draft.reasoning,
    supportsImages: draft.supportsImages,
    // 只有思考开着才回传映射表（关掉思考时不动文件里的旧表，下次打开还能接着用）。
    thinkingLevelMap: draft.reasoning ? buildThinkingLevelMap(draft.thinkingLevels) : undefined,
    cost: buildCostPayload(draft.cost),
  });
}

export function removeCustomModel(providerId: string, model: string): Promise<CustomModelsResponse> {
  return postJson<CustomModelsResponse>("/api/custom-models/remove", { providerId, model });
}

/**
 * 重读磁盘上的 models.json（并让 pi 的 runtime 重算自定义 provider）。
 * 只有手改过文件才需要它 —— 应用自己保存/删除时桥已经把两边都同步好了。
 */
export function reloadCustomModels(): Promise<CustomModelsResponse> {
  return postJson<CustomModelsResponse>("/api/custom-models/reload", {});
}

export function testCustomModelConnection(input: {
  providerId?: string;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /** 列表端点/鉴权头按它分派（openai-completions / anthropic-messages / google-generative-ai…）。 */
  api?: string;
}): Promise<ConnectionTestResult> {
  return postJson<ConnectionTestResult>("/api/custom-models/test", input);
}

/** 「选择已有供应商」里的一行。 */
export interface ModelProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  /** provider 级的 api（只来自 models.json）：内置供应商为空，模型行自己带。 */
  api?: string;
  modelCount: number;
  authConfigured: boolean;
  /** "api_key" | "oauth" | "none"：当前用的是哪种鉴权。 */
  authKind: string;
  /** pi 侧支持的登录方式，如 ["apiKey"] / ["apiKey","oauth"]。 */
  authMethods?: string[];
  /** 该 provider 已经在 models.json 里了。 */
  registered?: boolean;
  /**
   * 已存的明文 key：**只有单家详情接口 `GET /api/model-providers/:id` 会带**（供应商列表里没有）。
   * 弹窗拿它回填输入框，默认按密文显示、点眼睛看明文。
   */
  apiKey?: string;
  /** pi 内置供应商（不是用户自己加的）。 */
  builtin?: boolean;
}

/** 某个供应商的一个可选模型（来自 pi 目录或端点实时列表）。 */
export interface ProviderModelOption {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  supportsImages: boolean;
}

export interface ProviderDiscoveryResult {
  ok: boolean;
  providerId: string;
  provider?: ModelProviderRow | null;
  models: ProviderModelOption[];
  authConfigured: boolean;
  /** 是否真的联网刷新过列表（false = 用的本地目录）。 */
  refreshed: boolean;
  warning?: string;
}

export function fetchModelProviders(): Promise<{ providers: ModelProviderRow[] }> {
  return fetchJson<{ providers: ModelProviderRow[] }>("/api/model-providers");
}

/**
 * 取单个 provider 的本地模型列表 + 已存的 key（不联网）。
 *
 * 要 key 的弹窗（改 key / 测试连接 / 拉列表）都从这里回填，别在前端另存一份。
 */
export function fetchProviderModels(providerId: string): Promise<ModelProviderRow & { models?: ProviderModelOption[] }> {
  return fetchJson<ModelProviderRow & { models?: ProviderModelOption[] }>(`/api/model-providers/${encodeURIComponent(providerId)}`);
}

/** 验证 API key：留空 = 验已存的那份，填了 = 验新填的。 */
export function verifyProviderKey(providerId: string, apiKey = ""): Promise<{
  ok: boolean;
  error?: string;
  models?: { id: string; name?: string }[];
}> {
  return postJson(`/api/model-providers/${encodeURIComponent(providerId)}/verify-key`, { apiKey });
}

/** 改自定义供应商的 provider 级设置（名字 / 端点 / api 类型），apiKey 留空表示不动 key。 */
export function updateProvider(input: {
  providerId: string;
  name: string;
  baseUrl: string;
  api?: string;
  apiKey?: string;
}): Promise<CustomModelsResponse> {
  return postJson<CustomModelsResponse>("/api/model-providers/update", input);
}

/** 内置供应商只能改 key：不碰 models.json 里的任何模型字段。 */
export function saveProviderApiKey(providerId: string, apiKey: string): Promise<CustomModelsResponse> {
  return postJson<CustomModelsResponse>("/api/custom-models/key", { providerId, apiKey });
}

/** 填了 key 就顺手存下来并列出该供应商的模型；失败由调用方提示。 */
export function discoverProviderModels(input: { providerId: string; apiKey?: string }): Promise<ProviderDiscoveryResult> {
  return postJson<ProviderDiscoveryResult>("/api/model-providers/discover", input);
}

/** 一次添加多个模型（同一供应商）。`models` 里的对象会原样作为嵌套模型条目发给桥。 */
export function addCustomModels(input: {
  providerName: string;
  baseUrl: string;
  providerId?: string;
  apiKey?: string;
  models: Array<{ model: Record<string, unknown> }>;
}): Promise<CustomModelsResponse> {
  return postJson<CustomModelsResponse>("/api/custom-models", input);
}

/**
 * 端点自己列出来的模型：把它报的展示名与 token 上限一起发回去。
 *
 * 只发真的拿到的字段（>0 / 非默认），剩下的交给桥补默认值 —— 不然网关明明报了
 * 200k 上下文，落盘还是 128k，等于白问一次。
 */
export function listingModelPayload(model: ProviderModelOption): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name && model.name !== model.id ? model.name : undefined,
    contextWindow: model.contextWindow > 0 ? model.contextWindow : undefined,
    maxTokens: model.maxTokens > 0 ? model.maxTokens : undefined,
    reasoning: model.reasoning || undefined,
    input: model.supportsImages ? ["text", "image"] : undefined,
  };
}

/**
 * 从目录记录拼一条要发给桥的模型项。
 *
 * 只带标量就够：cost / compat / thinkingLevelMap 由桥从 runtime 的目录记录整条抄进
 * models.json（文件里的行会整条盖掉内置目录，漏一个字段就等于砸一个字段）。
 */
export function catalogModelPayload(model: ProviderModelOption): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    api: model.api || undefined,
    baseUrl: model.baseUrl || undefined,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: model.supportsImages ? ["text", "image"] : ["text"],
  };
}
