import { t } from "../../i18n/index.ts";
import type { ModelSummary } from "../../types";
import type {
  CostDraft,
  CostRatesDraft,
  CostTierDraft,
  CustomModelDraft,
  CustomModelEntry,
  ModelCostConfig,
  ModelCostRates,
} from "./customModelsApi";

/**
 * 自定义模型表单/列表的纯规则。
 *
 * 校验规则和 `server/customModels.mjs` 保持同一套：前端先拦一遍是为了立刻反馈，
 * 真正的写入仍然由桥再校验一次，两边都不能只留一半。
 */

export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;
export const MIN_CONTEXT_WINDOW = 1_024;
export const MAX_CONTEXT_WINDOW = 10_000_000;

/** 价格上限与最多几档阶梯 —— 与 `server/customModels.mjs` 逐字同一口径。 */
export const MAX_PRICE = 100_000;
export const MAX_PRICE_TIERS = 8;

/** 四个价的字段顺序/标签：表单、校验、列表 chip 共用一张表，不再四处各写一份。 */
export const PRICE_FIELDS = [
  { key: "input", labelKey: "models.price.input" },
  { key: "output", labelKey: "models.price.output" },
  { key: "cacheRead", labelKey: "models.price.cacheRead" },
  { key: "cacheWrite", labelKey: "models.price.cacheWrite" },
] as const satisfies ReadonlyArray<{ key: keyof ModelCostRates; labelKey: string }>;

/** pi 的思考档位全集（与桥 THINKING_LEVELS 同序同值）；编辑弹窗用它渲染档位映射表。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * 档位映射草稿：每档一个字符串，**留空 = 该档不存在**（落盘 `null`）。
 * 填的值就是选中该档时发给端点的 effort —— 可以和档位同名，也可以改名（high → xhigh）。
 * pi 那边「未声明的档」只有两种效果：基础档按同名放行、xhigh/max 算不支持，都能用这两个状态表达。
 */
export type ThinkingLevelDraftMap = Record<ThinkingLevel, string>;

export function emptyThinkingLevels(): ThinkingLevelDraftMap {
  return Object.fromEntries(
    THINKING_LEVELS.map((level) => [level, level === "xhigh" || level === "max" ? "" : level]),
  ) as ThinkingLevelDraftMap;
}

/** 桥下发的档位表 → 草稿；null/缺失都显示成空框（= 该档不存在）。 */
export function thinkingLevelsFromMap(map?: Record<string, string | null>): ThinkingLevelDraftMap {
  const draft = emptyThinkingLevels();
  for (const level of THINKING_LEVELS) {
    const value = map?.[level];
    draft[level] = value === null || value === undefined ? "" : String(value);
  }
  return draft;
}

/** 草稿 → 落盘映射表：七档全写（空 = `null`），所见即所发。 */
export function buildThinkingLevelMap(draft: ThinkingLevelDraftMap): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    map[level] = draft[level]?.trim() ? draft[level].trim() : null;
  }
  return map;
}

/** 档位值的字符集：就是个 effort 名，不接受空白/控制字符（桥也会再拦一次）。 */
export const THINKING_VALUE_MAX = 40;

/**
 * 列表端点按 api 类型分派：OpenAI 兼容是 `GET {base}/models` + Bearer，
 * Anthropic 要 `x-api-key` + `/v1/models`，Google 要 `x-goog-api-key` + `/v1beta/models`，
 * 剩下几种（Bedrock/Vertex/Azure）拿不了列表，只能手填 —— 所以选项里写清楚。
 */
export const API_TYPES = [
  { value: "openai-completions", labelKey: "models.apiType.openai-completions" },
  { value: "openai-responses", labelKey: "models.apiType.openai-responses" },
  { value: "mistral-conversations", labelKey: "models.apiType.mistral-conversations" },
  { value: "anthropic-messages", labelKey: "models.apiType.anthropic-messages" },
  { value: "google-generative-ai", labelKey: "models.apiType.google-generative-ai" },
  { value: "azure-openai-responses", labelKey: "models.apiType.azure-openai-responses" },
  { value: "google-vertex", labelKey: "models.apiType.google-vertex" },
  { value: "bedrock-converse-stream", labelKey: "models.apiType.bedrock-converse-stream" },
];

export function emptyDraft(): CustomModelDraft {
  return {
    targetProviderId: "",
    targetModel: "",
    providerId: "",
    providerName: "",
    baseUrl: "",
    apiKey: "",
    model: "",
    modelLabel: "",
    contextWindow: String(DEFAULT_CONTEXT_WINDOW),
    maxTokens: String(DEFAULT_MAX_TOKENS),
    reasoning: false,
    supportsImages: false,
    thinkingLevels: emptyThinkingLevels(),
    cost: emptyCostDraft(),
  };
}

export function draftFromEntry(entry: CustomModelEntry, apiKey = ""): CustomModelDraft {
  const label = entry.modelLabel ?? "";
  return {
    targetProviderId: entry.providerId,
    targetModel: entry.model,
    providerId: entry.providerId,
    providerName: entry.providerName,
    baseUrl: entry.baseUrl,
    apiKey,
    model: entry.model,
    // 展示名本来就是从 id 推出来的，就别再回写到输入框里占地方。
    modelLabel: label && label !== entry.model && label !== prettifyModelId(entry.model) ? label : "",
    contextWindow: String(entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    maxTokens: String(entry.maxTokens ?? DEFAULT_MAX_TOKENS),
    reasoning: Boolean(entry.reasoning),
    supportsImages: Boolean(entry.supportsImages),
    // 档位映射按原表回填：没声明的档保持留空（不是 null），否则一保存就把 pi 的默认档位扭成不存在。
    thinkingLevels: thinkingLevelsFromMap(entry.thinkingLevelMap),
    cost: costDraftFromConfig(entry.cost),
  };
}

/** 返回 `字段 -> 错误文案`；空对象表示可以提交。 */
export function validateDraft(draft: CustomModelDraft, { requireApiKey = true } = {}): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!draft.providerName.trim()) {
    errors.providerName = "Provider name is required.";
  } else if (draft.providerName.trim().length > 40) {
    errors.providerName = "Provider name must be at most 40 characters.";
  }

  const baseUrl = draft.baseUrl.trim();
  if (!baseUrl) {
    errors.baseUrl = "Base URL is required.";
  } else if (!isHttpUrl(baseUrl)) {
    errors.baseUrl = "Base URL is not a valid address, e.g. https://api.example.com/v1.";
  }

  const model = draft.model.trim();
  if (!model) {
    errors.model = "Model name is required.";
  } else if (!MODEL_ID_PATTERN.test(model)) {
    errors.model = "Model name may only contain letters, digits and . _ : / + - and must start with a letter or digit.";
  }

  const contextWindow = toPositiveInt(draft.contextWindow);
  if (contextWindow == null || contextWindow < MIN_CONTEXT_WINDOW || contextWindow > MAX_CONTEXT_WINDOW) {
    errors.contextWindow = `Context window must be between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW.toLocaleString("en-US")}.`;
  }

  const maxTokens = toPositiveInt(draft.maxTokens);
  if (maxTokens == null || (contextWindow != null && maxTokens > contextWindow)) {
    errors.maxTokens = `Max output must be between 1 and ${contextWindow ?? "the context window"}.`;
  }

  if (requireApiKey && !draft.apiKey.trim()) {
    errors.apiKey = "API key is required.";
  }
  if (draft.apiKey.trim() && /\s/.test(draft.apiKey.trim())) {
    errors.apiKey = "The API key must not contain spaces or line breaks.";
  }

  if (draft.reasoning) {
    for (const level of THINKING_LEVELS) {
      const value = draft.thinkingLevels[level]?.trim() ?? "";
      if (!value) {
        continue;
      }
      if (/\s/.test(value)) {
        errors.thinkingLevels = `Thinking level "${level}" must not contain spaces.`;
        break;
      }
      if (value.length > THINKING_VALUE_MAX) {
        errors.thinkingLevels = `Thinking level "${level}" must be at most ${THINKING_VALUE_MAX} characters.`;
        break;
      }
    }
  }

  Object.assign(errors, validateCostDraft(draft.cost));

  return errors;
}

/** 比较两个 Base URL 是不是同一个端点（忽略大小写与结尾斜杠）。 */
export function sameBaseUrl(left: string, right: string) {
  const strip = (value: string) => String(value ?? "").trim().toLowerCase().replace(/\/+$/, "");
  const a = strip(left);
  const b = strip(right);
  return Boolean(a) && Boolean(b) && a === b;
}

/** 参与合并的模型行：只要求有 id，其余字段两边各自不同也无所谓。 */
export type ListingModel = { id: string };

/**
 * 把端点刚报回来的一批模型并回当前列表。
 *
 * 顺序以端点为准，但**已经在列表里的行原样留着**：里面可能有用户手填的模型（端点根本不报它），
 * 也可能有上一轮从目录/配置里拿到的上下文、模态信息——直接 `setModels(list)` 会让这些行凭空消失，
 * 用户手填的东西一按 Fetch 就没了。新行才用端点给的信息。
 */
export function mergeListingInto<T extends ListingModel>(current: T[], incoming: T[]): T[] {
  const kept = new Map(current.map((model) => [model.id, model]));
  const merged: T[] = [];
  const seen = new Set<string>();
  for (const model of incoming) {
    if (seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    merged.push(kept.get(model.id) ?? model);
  }
  for (const model of current) {
    if (!seen.has(model.id)) {
      merged.push(model);
    }
  }
  return merged;
}

/**
 * 一轮拉取结束后留在屏上的那句提示。
 *
 * 拉取成功时上一轮的「拉不到列表」错误已经过时了，该换成结果；拉取失败时**保留原错误**再说
 * 「配置照常生效」——否则只剩一句「端点现在没有模型」，用户会以为刚才那条错误是误报，
 * 而实际上该修的还是没修。
 */
export function staleListMessage(options: { error: string; list: ListingModel[] }): string | undefined {
  if (options.error) {
    return options.list.length
      ? t("models.stale.withList", { error: options.error, count: options.list.length })
      : t("models.stale.noList", { error: options.error })
  }
  return options.list.length ? undefined : t("models.stale.empty");
}

export function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 空串/非法数字都回落到默认值，和桥的 `clampInt` 语义一致。 */
export function toPositiveInt(value: string | number): number | null {
  const raw = typeof value === "number" ? value : String(value ?? "").trim();
  if (raw === "") {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : null;
}

export function formatTokenCount(value: number | undefined): string {
  const tokens = Number(value ?? 0);
  if (!tokens) {
    return "unknown";
  }
  if (tokens >= 1_000_000) {
    return `${trimZero(tokens / 1_000_000)}M`;
  }
  return `${trimZero(tokens / 1_000)}k`;
}

function trimZero(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** `qwen3.7-plus` -> `Qwen3.7 Plus`，和桥的 `prettifyModelId` 同规则。 */
export function prettifyModelId(id: string): string {
  return String(id ?? "")
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export interface ComposerModelOption {
  key: string;
  provider: string;
  model: string;
  /** 下拉里的主标题。 */
  label: string;
  /** 副标题：供应商名，自定义行用它区分同名模型。 */
  detail: string;
  custom: boolean;
  available: boolean;
}

/**
 * 输入框旁的可切换模型列表。
 *
 * 内置目录有几百个模型，全塞进下拉框等于没有列表，所以这里只放：
 * 用户自己加的模型（永远放，缺 key 也要放，否则刚加完就找不到）+ 已经配好鉴权的内置模型
 * + 当前会话正在用的那个（可能既不是自定义也没有鉴权）。
 */
export function buildComposerModelOptions({
  availableModels = [],
  customModels = [],
  currentProvider = "",
  currentModel = "",
}: {
  availableModels?: ModelSummary[];
  customModels?: CustomModelEntry[];
  currentProvider?: string;
  currentModel?: string;
}): ComposerModelOption[] {
  const options: ComposerModelOption[] = [];
  const seen = new Set<string>();

  const push = (option: ComposerModelOption) => {
    if (seen.has(option.key)) {
      return;
    }
    seen.add(option.key);
    options.push(option);
  };

  for (const entry of customModels) {
    if (!entry.managed || !entry.model) {
      continue;
    }
    push({
      key: modelKey(entry.providerId, entry.model),
      provider: entry.providerId,
      model: entry.model,
      label: entry.modelLabel || prettifyModelId(entry.model),
      detail: entry.providerName,
      custom: true,
      available: Boolean(entry.available),
    });
  }

  const builtIn = availableModels
    .filter((model) => model.available && !seen.has(modelKey(model.provider, model.model)))
    .map((model) => ({
      key: modelKey(model.provider, model.model),
      provider: model.provider,
      model: model.model,
      label: model.name || prettifyModelId(model.model),
      detail: model.provider,
      custom: false,
      available: true,
    }))
    .sort((left, right) => left.detail.localeCompare(right.detail) || left.label.localeCompare(right.label));

  for (const option of builtIn) {
    push(option);
  }

  if (currentProvider && currentModel && !seen.has(modelKey(currentProvider, currentModel))) {
    const summary = availableModels.find((model) => model.provider === currentProvider && model.model === currentModel);
    push({
      key: modelKey(currentProvider, currentModel),
      provider: currentProvider,
      model: currentModel,
      label: summary?.name || prettifyModelId(currentModel),
      detail: summary?.provider ?? currentProvider,
      custom: false,
      available: Boolean(summary?.available),
    });
  }

  return options;
}

export interface ComposerModelGroup {
  /** provider id，作为分组 key。 */
  key: string;
  /** 分组标题：供应商展示名。 */
  label: string;
  custom: boolean;
  options: ComposerModelOption[];
}

/**
 * 下拉框按供应商分组。
 *
 * 顺序沿用列表本身的顺序（自定义在前），组内不变；自定义组按首次出现排，
 * 内置组按名字排，这样几十个模型不至于糊成一条平铺的长列表。
 */
export function groupComposerOptionsByProvider(options: ComposerModelOption[]): ComposerModelGroup[] {
  const groups = new Map<string, ComposerModelGroup>();
  for (const option of options) {
    const existing = groups.get(option.provider);
    if (existing) {
      existing.options.push(option);
      continue;
    }
    groups.set(option.provider, {
      key: option.provider,
      label: option.detail || option.provider,
      custom: option.custom,
      options: [option],
    });
  }

  const list = [...groups.values()];
  const rank = (group: ComposerModelGroup) => (group.custom ? 0 : 1);
  return list.sort(
    (left, right) => rank(left) - rank(right) ||
      (rank(left) === 1 ? left.label.localeCompare(right.label) : 0),
  );
}

export interface CustomEntryGroup {
  providerId: string;
  providerName: string;
  baseUrl: string;
  entries: CustomModelEntry[];
}

/** 设置页按供应商分组：同名 provider 的行挨在一起，组按名字排。 */
export function groupCustomEntriesByProvider(entries: CustomModelEntry[]): CustomEntryGroup[] {
  const groups = new Map<string, CustomEntryGroup>();
  for (const entry of entries) {
    const key = entry.providerId || entry.providerName;
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(entry);
      existing.baseUrl ||= entry.baseUrl;
      continue;
    }
    groups.set(key, {
      providerId: key,
      providerName: entry.providerName || entry.providerId,
      baseUrl: entry.baseUrl,
      entries: [entry],
    });
  }
  return [...groups.values()].sort((left, right) => left.providerName.localeCompare(right.providerName, "zh-CN"));
}

/**
 * 底部那行说清楚这次会加几条、会删几条 —— 取消勾选是会真删文件里的行的，
 * 所以不能只写「N selected」。
 */
export function summaryLabel(addCount: number, removeCount: number): string {
  if (!addCount && !removeCount) {
    return t("models.summary.none");
  }
  const parts: string[] = [];
  if (addCount) {
    parts.push(t("models.summary.add", { count: addCount }));
  }
  if (removeCount) {
    parts.push(t("models.summary.remove", { count: removeCount }));
  }
  return parts.join(t("common.dotSeparator"));
}

/**
 * 一次提交要改哪几行模型：加哪些、删哪些。
 *
 * 账只按「**打开时**文件里有没有」（`savedIds`）算，不按这一轮从端点拉到了什么算：
 * 拉回来的列表只是候选，勾上了、且文件里没有的新行才是「要加」；本来勾着、现在取消/被撤掉的旧行才是「要删」。
 * 拿当前列表当基准的话，取消勾选一条再 Fetch 一次就能把这次删除悄悄抹平。
 *
 * `removesEverything` = 这次会把这家最后一条模型也删掉（桥会顺手把整个供应商删了），得先告诉用户。
 */
export function planModelChanges({
  savedIds = [],
  listedIds = [],
  selectedIds = [],
}: {
  /** 打开时 models.json 里已有的模型 id。 */
  savedIds?: Iterable<string>;
  /** 现在列在屏上的模型 id（含刚从端点拉回来的）。 */
  listedIds?: Iterable<string>;
  /** 当前勾着的模型 id。 */
  selectedIds?: Iterable<string>;
} = {}): { toAdd: string[]; toRemove: string[]; removesEverything: boolean } {
  const saved = new Set(savedIds);
  const selected = new Set(selectedIds);
  const seen = new Set<string>();
  const toAdd: string[] = [];
  for (const id of listedIds) {
    if (seen.has(id) || saved.has(id) || !selected.has(id)) {
      continue;
    }
    seen.add(id);
    toAdd.push(id);
  }
  const toRemove = [...saved].filter((id) => !selected.has(id));
  return {
    toAdd,
    toRemove,
    removesEverything: toRemove.length > 0 && !toAdd.length && toRemove.length >= saved.size,
  };
}

/* ------------------------------------------------------- 价格（含阶梯计费） */

/**
 * 价格规则的落点在 `server/customModels.mjs`，这里只做「表单里的字符串草稿」⇄
 * 「能进 models.json 的数字」两边换算，规则与桥同一套（桥那边会再校验一次）。
 *
 * 语义提醒：单位是「每 100 万 token 多少钱」，不做币种换算；四个价留空 = 0。
 * 阶梯档由 pi 的 `calculateCost()` 解释：本单「输入 + 缓存读 + 缓存写」总量超过某档
 * `inputTokensAbove` 时，整单换用那一档的四个价（不是分段累进）。
 */

export function emptyCostDraft(): CostDraft {
  return { input: "", output: "", cacheRead: "", cacheWrite: "", tiers: [] };
}

/** 0 显示成空框：这样「没收费」和「还没填」在界面上是同一个样子，也不会满屏的 0。 */
export function costDraftFromConfig(cost?: ModelCostConfig): CostDraft {
  const rate = (value: number | undefined) => (Number(value ?? 0) ? String(value) : "");
  return {
    input: rate(cost?.input),
    output: rate(cost?.output),
    cacheRead: rate(cost?.cacheRead),
    cacheWrite: rate(cost?.cacheWrite),
    tiers: (cost?.tiers ?? []).map((tier) => ({
      inputTokensAbove: String(tier.inputTokensAbove ?? ""),
      input: rate(tier.input),
      output: rate(tier.output),
      cacheRead: rate(tier.cacheRead),
      cacheWrite: rate(tier.cacheWrite),
    })),
  };
}

export function newCostTier(existing: CostTierDraft[] = []): CostTierDraft {
  // 阈值默认给上一档的 2 倍：绝大多数阶梯价就是「输入翻倍贵一档」，比让人每次从空白敲省事。
  const last = existing.at(-1);
  const previous = last ? toPositiveInt(last.inputTokensAbove) : null;
  return { inputTokensAbove: previous ? String(previous * 2) : "", input: "", output: "", cacheRead: "", cacheWrite: "" };
}

/** 空 = 0（免费也是价格）；不是数、负数、超过上限都算非法。 */
export function toPriceNumber(raw: string | number | undefined): number | null {
  const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim();
  if (text === "") {
    return 0;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE) {
    return null;
  }
  return value;
}

/** 错误键的拼法只有这一处：`validateCostDraft` 写、弹窗读，两边不可能各编一套。 */
export function costRateErrorKey(field: keyof ModelCostRates, tierIndex?: number): string {
  const capitalized = field.charAt(0).toUpperCase() + field.slice(1);
  return tierIndex === undefined ? `cost${capitalized}` : `tier${tierIndex}Cost${capitalized}`;
}

export function costThresholdErrorKey(tierIndex: number): string {
  return `tier${tierIndex}Threshold`;
}

export function validateCostDraft(cost?: CostDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!cost) {
    return errors;
  }

  const priceMessage = `Price must be a number between 0 and ${MAX_PRICE.toLocaleString("en-US")}.`;
  for (const { key } of PRICE_FIELDS) {
    if (toPriceNumber(cost[key]) === null) {
      errors[costRateErrorKey(key)] = priceMessage;
    }
  }

  const tiers = cost.tiers ?? [];
  if (tiers.length > MAX_PRICE_TIERS) {
    errors.costTiers = `At most ${MAX_PRICE_TIERS} pricing tiers.`;
  }
  const seen = new Set<number>();
  tiers.forEach((tier, index) => {
    const raw = String(tier?.inputTokensAbove ?? "").trim();
    const threshold = toPositiveInt(raw);
    // 不卡整数：桥会把 32.5 拒掉，前端截成 32 就变成“前端能交、桥报错”。
    if (threshold === null || !Number.isInteger(Number(raw))) {
      errors[costThresholdErrorKey(index)] = "Threshold must be a positive whole number of input tokens.";
    } else if (seen.has(threshold)) {
      errors[costThresholdErrorKey(index)] = "Another tier already starts at this threshold.";
    } else {
      seen.add(threshold);
    }
    for (const { key } of PRICE_FIELDS) {
      if (toPriceNumber(tier?.[key]) === null) {
        errors[costRateErrorKey(key, index)] = priceMessage;
      }
    }
  });

  return errors;
}

/**
 * 草稿 → 进文件的形状。校验已经在 `validateCostDraft` 里拦过，这里只兜底：
 * 非法数按 0 算、阈值非法的档丢掉、按阈值升序排好（pi 不依赖顺序，纯粹为了写进文件可读）。
 */
export function buildCostPayload(cost?: CostDraft): ModelCostConfig | undefined {
  if (!cost) {
    return undefined;
  }
  const rates = (source: CostRatesDraft | CostTierDraft): ModelCostRates => {
    const priced = {} as ModelCostRates;
    for (const { key } of PRICE_FIELDS) {
      priced[key] = toPriceNumber(source?.[key]) ?? 0;
    }
    return priced;
  };

  const tiers: ModelCostConfig["tiers"] = [];
  for (const tier of Array.isArray(cost.tiers) ? cost.tiers : []) {
    const raw = String(tier?.inputTokensAbove ?? "").trim();
    const threshold = toPositiveInt(raw);
    // 阈值非法的档丢掉：宁可不写这一档，也不要写个「输面 0 就换档」把顶层价盖掉。
    if (threshold === null || !Number.isInteger(Number(raw))) {
      continue;
    }
    tiers.push({ inputTokensAbove: threshold, ...rates(tier) });
  }
  // pi 不依赖数组顺序（它取「最大且仍低于本单输面的阈值」），排序只是为了文件可读、diff 干净。
  tiers.sort((left, right) => (left?.inputTokensAbove ?? 0) - (right?.inputTokensAbove ?? 0));

  const base = rates(cost);
  return tiers.length ? { ...base, tiers } : base;
}

/** 去掉浮点尾数与无用的 0：2.5 → "2.5"，2 → "2"，0.0000004 → "0.0000004"。 */
export function formatPrice(value: number | undefined): string {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    return "0";
  }
  return String(Number(number.toFixed(6)));
}

/** 列表行上的一枚 chip：`¥2/¥8 · +cache · 2 tiers`；全 0 就没得显示。 */
export function priceSummary(cost?: ModelCostConfig): string {
  if (!cost) {
    return "";
  }
  if (!PRICE_FIELDS.some(({ key }) => Number(cost[key] ?? 0) > 0)) {
    return "";
  }
  const parts = [t("models.priceSummary.rates", { input: formatPrice(cost.input), output: formatPrice(cost.output) })];
  if (Number(cost.cacheRead ?? 0) > 0 || Number(cost.cacheWrite ?? 0) > 0) {
    parts.push(t("models.priceSummary.cache"));
  }
  if (cost.tiers?.length) {
    parts.push(t(cost.tiers.length > 1 ? "models.priceSummary.tiers.other" : "models.priceSummary.tiers.one", { count: cost.tiers.length }));
  }
  return parts.join(t("common.dotSeparator"));
}
