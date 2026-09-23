/**
 * 自定义模型（OpenAI 兼容端点）的读写规则。
 *
 * 落地文件就是 pi 自己的 `~/.pi/agent/models.json`：桥里的 `modelRuntime` 从这份文件读自定义
 * provider，命令行 pi 读的是同一份，所以「在 Pi Desktop 里添加模型」和「手改配置文件」是同一件事，
 * 不存在第二套真相。API key 不写进这份文件（它不是 0600 的），走 `auth.json`。
 *
 * 本模块只做纯数据变换，不碰磁盘也不碰 runtime，方便单测。
 */

export const CUSTOM_MODEL_API = "openai-completions";
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;
export const MAX_PROVIDERS = 40;
export const MAX_MODELS_PER_PROVIDER = 40;

const PROVIDER_NAME_MAX = 40;
const MODEL_ID_MAX = 100;
const MODEL_LABEL_MAX = 60;
/** 档位映射里「发给端点的值」的长度上限：就是个 effort 名（low/high/xhigh…），不该更长。 */
const THINKING_VALUE_MAX = 40;
const MIN_CONTEXT_WINDOW = 1_024;
const MAX_CONTEXT_WINDOW = 10_000_000;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

/**
 * 价格字段的上限与精度：单位就是「每 100 万 token 多少钱」，不做币种换算，页面上也只打个钱符号。
 * 真正花钱的是 pi 自己（`calculateCost(model, usage)` 拿这四个数除 1e6），这里只保证落进
 * models.json 的一定是合法数字 —— pi 的 schema 对 cost 四个字段都是 required number，
 * 写个字符串或 NaN 进去会让整份 models.json 加载失败，全家的模型一起没。
 */
const MAX_PRICE = 100_000;
const MAX_PRICE_TIERS = 8;
const PRICE_DECIMALS = 6;
const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function emptyModelsConfig() {
  return { providers: {} };
}

/**
 * 解析 models.json 文本。容忍注释和空文件（pi 自己用 `stripJsonComments` 读它），
 * 但结构不对时必须报错而不是静默覆盖 —— 这个文件里可能有人手写的其他 provider。
 */
export function parseModelsConfig(text, filePath = "models.json") {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return emptyModelsConfig();
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(trimmed));
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON. Refusing to write and overwrite it: ${error instanceof Error ? error.message : error}`);
  }

  return normalizeModelsConfig(parsed, filePath);
}

export function normalizeModelsConfig(parsed, filePath = "models.json") {
  if (parsed === null || parsed === undefined) {
    return emptyModelsConfig();
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`\`${filePath}\` must contain a top-level object.`);
  }

  const providers = parsed.providers;
  if (providers === undefined || providers === null) {
    return { ...parsed, providers: {} };
  }
  if (typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error(`The "providers" key in ${filePath} must be an object.`);
  }

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw new Error(`The "${providerId}" provider in ${filePath} is not an object.`);
    }
    if (provider.models !== undefined && !Array.isArray(provider.models)) {
      throw new Error(`The "models" of the "${providerId}" provider in ${filePath} must be an array.`);
    }
  }

  return { ...parsed, providers };
}

/** 去掉 JSON 注释（与 pi 的 `stripJsonComments` 行为一致的最小实现，字符串内的 // 不算注释）。 */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** pi 的 EXTENDED_THINKING_LEVELS（pi-ai 未导出，按同序本地固定）：thinkingLevelMap 的合法键。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 模型 → 它真实支持的思考档位。规则必须与 pi 的 `getSupportedThinkingLevels` 逐字一致
 * （`pi-ai/models.js`）：
 *   - 没开推理 = 只有 off（选择器只显示 off）；
 *   - `null` = 该档不存在（隐藏）；
 *   - `xhigh`/`max` 必须显式出现在映射表里才算支持；
 *   - off..high 未声明 = pi 走默认映射**放行**，所以不能当成「不支持」。
 * 编辑器里的三态（未声明 / 不支持 / 自定义值）看 `thinkingLevelMap` 原始表，不看这里。
 */
function describeThinkingLevels(model) {
  if (!model?.reasoning) {
    return ["off"];
  }
  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : {};
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined;
    }
    return true;
  });
}

/**
 * 模型 → 编辑器直接回填的那张表（7 个档位全给，值只可能是 string 或 null）。
 *
 * 这里不原样搬文件：pi 对「未声明的 off..high」是按默认映射放行的，效果就是发送档位同名 ——
 * 编辑器把这种档摊平成同名值，用户在框里看到什么就是要发什么；未声明的 xhigh/max 在 pi 里
 * 就是不支持，摊平成 null。所以「留空 = 该档不存在」能表达 pi 的全部状态，不需要第三个开关。
 */
function describeThinkingLevelMap(model) {
  const map = model?.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : {};
  const out = {};
  for (const level of THINKING_LEVELS) {
    const mapped = map[level];
    if (mapped === null) {
      out[level] = null;
    } else if (mapped !== undefined) {
      out[level] = String(mapped);
    } else {
      // 未声明：xhigh/max 在 pi 里算不支持；基础档会被放行（效果 = 同名）
      out[level] = level === "xhigh" || level === "max" ? null : level;
    }
  }
  return out;
}

/** 摊平成 UI 一行一个模型的结构，保留 provider 上我们不认识的字段（编辑时原样写回）。 */
export function listCustomModels(config) {
  const providers = config?.providers ?? {};
  const entries = [];

  for (const [providerId, provider] of Object.entries(providers)) {
    const models = Array.isArray(provider?.models) ? provider.models : [];
    for (const model of models) {
      if (!model || typeof model !== "object" || !model.id) {
        continue;
      }
      entries.push(describeCustomModel({ providerId, provider, model }));
    }
    if (!models.length) {
      // 只有 modelOverrides 的 provider（改内置供应商参数）也列出来，但不能当自定义模型编辑。
      entries.push({
        ...describeCustomModel({ providerId, provider, model: { id: "" } }),
        model: "",
        modelLabel: "",
        managed: false,
      });
    }
  }

  return entries;
}

function describeCustomModel({ providerId, provider, model }) {
  const input = Array.isArray(model.input) ? model.input : [];
  return {
    providerId,
    providerName: String(provider?.name ?? providerId),
    baseUrl: String(provider?.baseUrl ?? model.baseUrl ?? ""),
    api: String(provider?.api ?? model.api ?? CUSTOM_MODEL_API),
    model: String(model.id),
    modelLabel: String(model.name ?? model.id),
    contextWindow: Number(model.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    maxTokens: Number(model.maxTokens ?? DEFAULT_MAX_TOKENS),
    reasoning: Boolean(model.reasoning),
    thinkingLevels: describeThinkingLevels(model),
    /** 编辑器直接回填的档位表（7 档全给）；留空 = 该档不存在。 */
    thinkingLevelMap: describeThinkingLevelMap(model),
    supportsImages: input.includes("image"),
    // 编辑弹窗要把已存的价格回填，不回传就等于「一打开就是空的、一保存就把价格抹成 0」。
    cost: describeCost(model.cost),
    managed: true,
  };
}

/**
 * 把文件里手写的 cost 摊成表单能直接用的形状。
 *
 * 不校验（那由 `normalizeCostInput` 在写入时做）：文件里可能是人手写的、可能是旧版本留下的，
 * 读的时候宁可兜 0 也不能报错。`tiers` 只收能用的行，整条为空时干脆不给这个键。
 */
export function describeCost(cost) {
  // 顶层价与档价必须各自读自己的对象：拿顶层 rates 去填阶梯行，会把所有档都洗成顶层价。
  const readRates = (source) => Object.fromEntries(PRICE_FIELDS.map((field) => {
    const value = Number(source?.[field]);
    return [field, Number.isFinite(value) && value >= 0 ? value : 0];
  }));
  const tiers = (Array.isArray(cost?.tiers) ? cost.tiers : [])
    .map((tier) => {
      const threshold = Number(tier?.inputTokensAbove);
      return Number.isFinite(threshold) && threshold > 0
        ? { inputTokensAbove: Math.trunc(threshold), ...readRates(tier) }
        : undefined;
    })
    .filter(Boolean)
    .sort((left, right) => left.inputTokensAbove - right.inputTokensAbove);
  const described = readRates(cost);
  return tiers.length ? { ...described, tiers } : described;
}

/** 找到某个 provider 条目（大小写不敏感地按 id 匹配）。 */
export function findProvider(config, providerId) {
  const providers = config?.providers ?? {};
  const exact = providers[providerId];
  if (exact) {
    return { providerId, provider: exact };
  }
  const lowered = String(providerId ?? "").toLowerCase();
  for (const [id, provider] of Object.entries(providers)) {
    if (id.toLowerCase() === lowered) {
      return { providerId: id, provider };
    }
  }
  return undefined;
}

export function findCustomModel(config, providerId, modelId) {
  const found = findProvider(config, providerId);
  if (!found) {
    return undefined;
  }
  const model = (found.provider?.models ?? []).find((candidate) => candidate?.id === modelId);
  return model ? describeCustomModel({ providerId: found.providerId, provider: found.provider, model }) : undefined;
}

/**
 * 校验并归一化「添加/编辑模型」表单。
 *
 * `hasStoredKey` = 该 provider 已经存过 key（编辑时留空表示不改）；
 * `requireApiKey` = 新建时必须有 key。
 */
export function normalizeCustomModelInput(input, { hasStoredKey = false, requireApiKey = true } = {}) {
  const source = input && typeof input === "object" ? input : {};

  const providerName = clip(String(source.providerName ?? "").trim(), PROVIDER_NAME_MAX);
  if (!providerName) {
    throw new Error("Provider name is required.");
  }

  // "builtin" = 往 pi 已有的供应商里挑模型，只补模型行；"custom" = 自己填的 OpenAI 兼容端点。
  const providerMode = source.providerMode === "builtin" ? "builtin" : "custom";
  // 内置供应商在 models.json 里故意不写 baseUrl（provider 级的地址会盖到该家每个模型上），
  // Bedrock / Vertex 这类连端点都没有 —— 目录行给不出 baseUrl。这时候不能拿它当必填，
  // 否则“往内置供应商加模型”整条路都被一句 Base URL is required 打死。
  const baseUrlRaw = String(source.baseUrl ?? "").trim();
  const baseUrl = providerMode === "builtin" && !baseUrlRaw ? "" : normalizeBaseUrl(baseUrlRaw);
  const model = normalizeModelInput(source);
  const apiKey = String(source.apiKey ?? "").trim();
  if (apiKey && !isProbablyKeyValue(apiKey)) {
    throw new Error("The API key must not contain spaces or line breaks.");
  }
  if (!apiKey && !hasStoredKey && requireApiKey) {
    throw new Error("API key is required.");
  }

  const providerIdInput = clip(String(source.providerId ?? "").trim(), 64);

  return {
    providerId: providerIdInput || providerIdFromName(providerName),
    providerName,
    baseUrl,
    apiKey,
    providerMode,
    model,
  };
}

export const MAX_MODELS_PER_BATCH = 40;

/**
 * 一次添加多条模型：provider 字段共用，`models` 里每项是一个模型（平铺或 `{model:{...}}` 嵌套）。
 * 同一批里重复的模型 id 只留一条，顺序按用户勾选顺序。
 */
export function normalizeCustomModelInputs(body, options = {}) {
  const source = body && typeof body === "object" ? body : {};
  const shared = {
    providerId: source.providerId,
    providerName: source.providerName,
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    providerMode: source.providerMode,
  };
  const items = Array.isArray(source.models) && source.models.length ? source.models : [source];
  if (items.length > MAX_MODELS_PER_BATCH) {
    throw new Error(`You can add at most ${MAX_MODELS_PER_BATCH} models at once.`);
  }

  const seen = new Set();
  const entries = [];
  for (const item of items) {
    const entry = normalizeCustomModelInput(
      { ...shared, ...(item && typeof item === "object" ? item : {}) },
      options,
    );
    if (seen.has(entry.model.id)) {
      continue;
    }
    seen.add(entry.model.id);
    entries.push(entry);
  }
  return entries;
}

/**
 * 批量写入：整批在内存里折叠完再交给调用方落盘，中途报错就什么都不写。
 * `target`（编辑某一行）只对单条有意义，批量新增时不要传。
 */
export function upsertCustomModels(config, entries, { target, seeds } = {}) {
  let next = config;
  const touched = [];
  for (const [index, entry] of entries.entries()) {
    const result = upsertCustomModel(next, entry, {
      target: entries.length === 1 ? target : undefined,
      seed: seeds?.[entry.model.id],
    });
    next = result.config;
    touched.push({
      providerId: result.providerId,
      modelId: result.modelId,
      previousProviderId: index === 0 ? result.previousProviderId : undefined,
      previousModelId: index === 0 ? result.previousModelId : undefined,
    });
  }
  return {
    config: next,
    providerIds: [...new Set(touched.map((item) => item.providerId))],
    models: touched.map((item) => item.modelId),
    ...touched[0],
  };
}

function normalizeModelInput(source) {
  const parts = modelInputParts(source);
  const id = clip(String(parts.id ?? "").trim(), MODEL_ID_MAX);
  if (!id) {
    throw new Error("Model name is required.");
  }
  if (!MODEL_ID_PATTERN.test(id)) {
    throw new Error("Model name may only contain letters, digits and . _ : / + - and must start with a letter or digit.");
  }

  const label = clip(String(parts.name ?? "").trim(), MODEL_LABEL_MAX) || prettifyModelId(id);

  const thinkingMapInput = parts.thinkingLevelMap;
  if (thinkingMapInput !== undefined
    && (thinkingMapInput === null || typeof thinkingMapInput !== "object" || Array.isArray(thinkingMapInput))) {
    throw new Error("Thinking level map must be an object.");
  }
  const thinkingLevelMap = thinkingMapInput === undefined ? undefined : normalizeThinkingLevelMap(thinkingMapInput);

  // 兼容旧写法：一维档位数组 = 「勾中的档同名、其余档 null」的整表重写。
  // 新编辑器一律发 `thinkingLevelMap`（能表达任意映射值、也能保留「未声明」）。
  const thinkingLevelsInput = Array.isArray(parts.thinkingLevels) ? parts.thinkingLevels : undefined;
  if (thinkingLevelsInput) {
    const invalid = thinkingLevelsInput.filter((level) => !THINKING_LEVELS.includes(level));
    if (invalid.length) {
      throw new Error(`Unknown thinking levels: ${invalid.join(", ")}`);
    }
  }
  const thinkingLevels = thinkingLevelsInput ? [...new Set(thinkingLevelsInput)] : undefined;

  // 哪些字段是调用方真给了值的：没给的不能拿默认值去盖掉目录里的真值。
  const given = {
    name: parts.name !== undefined,
    contextWindow: parts.contextWindow !== undefined && parts.contextWindow !== "",
    maxTokens: parts.maxTokens !== undefined && parts.maxTokens !== "",
    reasoning: parts.reasoning !== undefined,
    supportsImages: parts.supportsImages !== undefined,
    api: parts.api !== undefined,
    modelBaseUrl: parts.baseUrl !== undefined,
    cost: isCostGiven(parts.cost),
    thinkingLevels: thinkingLevelsInput !== undefined,
    thinkingLevelMap: thinkingMapInput !== undefined,
  };
  const contextWindow = clampInt(
    parts.contextWindow,
    MIN_CONTEXT_WINDOW,
    MAX_CONTEXT_WINDOW,
    DEFAULT_CONTEXT_WINDOW,
    "Context window",
  );
  const maxTokens = clampInt(
    parts.maxTokens,
    1,
    contextWindow,
    Math.min(DEFAULT_MAX_TOKENS, contextWindow),
    "Max output tokens",
  );

  return {
    id,
    name: label,
    nameWasGiven: Boolean(String(parts.name ?? "").trim()),
    reasoning: Boolean(parts.reasoning),
    supportsImages: Boolean(parts.supportsImages),
    api: safeApi(parts.api),
    modelBaseUrl: safeBaseUrl(parts.baseUrl),
    given,
    contextWindow,
    maxTokens,
    // 没给价格就是 undefined：下面 buildModelRecord 会留着文件里原有的 / 目录 seed 的那份。
    cost: given.cost ? normalizeCostInput(parts.cost) : undefined,
    thinkingLevels,
    thinkingLevelMap,
  };
}

/**
 * 编辑器发来的档位映射归一：键必须是 pi 的档位名，值是 `null`（该档不存在）或要发给端点的
 * 字符串。空串 / 纯空白当「没声明」直接丢掉 —— 这样「留空 = 走 pi 默认」不用另造状态。
 * 值带空格或超长一律报错，而不是截断：截断后发出去的是另一个 effort，排查起来是噩梦。
 */
function normalizeThinkingLevelMap(raw) {
  const out = {};
  const unknown = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!THINKING_LEVELS.includes(key)) {
      unknown.push(key);
      continue;
    }
    if (value === null) {
      out[key] = null;
      continue;
    }
    const text = String(value ?? "").trim();
    if (!text) {
      continue;
    }
    if (/\s/.test(text)) {
      throw new Error(`Thinking level "${key}" must not contain spaces.`);
    }
    if (text.length > THINKING_VALUE_MAX) {
      throw new Error(`Thinking level "${key}" must be at most ${THINKING_VALUE_MAX} characters.`);
    }
    out[key] = text;
  }
  if (unknown.length) {
    throw new Error(`Unknown thinking levels: ${unknown.join(", ")}`);
  }
  return out;
}

/** 表单会发 `{ input: "", output: "" }` 这种“四格全空”的占位，那也算“没给价格”。 */
function isCostGiven(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  if (typeof value !== "object") {
    // 形状不对（数字/字符串）当“没给”，不能让一个脏字段把已存的价格洗成 0。
    return false;
  }
  return PRICE_FIELDS.some((field) => value[field] !== undefined && value[field] !== null && String(value[field]).trim() !== "")
    || (Array.isArray(value.tiers) && value.tiers.length > 0);
}

/**
 * 价格行归一：顶层四个价必填（缺的补 0），`tiers` 可选；阶梯价按阈值升序排好再落盘。
 *
 * 报错文案要能直接给用户看，所以带上字段名。注意 `inputTokensAbove: 0` 在 pi 里意思是
 * 「输入 > 0 就换档」，顶层价永远不再生效 —— 那是手滑而不是意图，直接拒。
 */
export function normalizeCostInput(value, { label = "Price" } = {}) {
  const source = value && typeof value === "object" ? value : {};
  const rates = {};
  for (const field of PRICE_FIELDS) {
    rates[field] = toPrice(source[field], `${label} · ${priceFieldLabel(field)}`);
  }

  const tiersRaw = Array.isArray(source.tiers) ? source.tiers : [];
  if (tiersRaw.length > MAX_PRICE_TIERS) {
    throw new Error(`${label}: at most ${MAX_PRICE_TIERS} pricing tiers.`);
  }
  const seen = new Set();
  const tiers = tiersRaw.map((tier, index) => {
    const rowLabel = `${label} · tier ${index + 1}`;
    const threshold = Number(String(tier?.inputTokensAbove ?? "").trim());
    if (!Number.isFinite(threshold) || !Number.isInteger(threshold) || threshold <= 0) {
      throw new Error(`${rowLabel}: input threshold must be a positive whole number of tokens.`);
    }
    if (seen.has(threshold)) {
      throw new Error(`${rowLabel}: another tier already starts at ${threshold.toLocaleString("en-US")} input tokens.`);
    }
    seen.add(threshold);
    const row = { inputTokensAbove: threshold };
    for (const field of PRICE_FIELDS) {
      row[field] = toPrice(tier?.[field], `${rowLabel} · ${priceFieldLabel(field)}`);
    }
    return row;
  }).sort((left, right) => left.inputTokensAbove - right.inputTokensAbove);

  return tiers.length ? { ...rates, tiers } : rates;
}

/** 空 = 0（不收费也是价格），其余必须是 0..MAX_PRICE 的有限数；存进文件前洗成纯 number。 */
function toPrice(raw, label) {
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (text === undefined || text === null || text === "") {
    return 0;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a number.`);
  }
  if (value < 0) {
    throw new Error(`${label} cannot be negative.`);
  }
  if (value > MAX_PRICE) {
    throw new Error(`${label} must be at most ${MAX_PRICE.toLocaleString("en-US")} per million tokens.`);
  }
  // 洗掉浮点尾数（0.1+0.2 这种），否则文件里会出现 0.30000000000000004。
  return Number(value.toFixed(PRICE_DECIMALS));
}

const PRICE_LABELS = { input: "input", output: "output", cacheRead: "cache read in", cacheWrite: "cache write" };

function priceFieldLabel(field) {
  return PRICE_LABELS[field] ?? field;
}

/**
 * 表单是平铺的（`model` 就是模型 id，其余字段在同一层），`{ model: {...} }` 的嵌套写法也收。
 * 两种形状都读，否则“前端发平铺、服务端读嵌套”会变成永远报“请填写模型名称”。
 */
function modelInputParts(source) {
  const nested = source?.model && typeof source.model === "object" ? source.model : {};
  const pick = (keys) => {
    for (const key of keys) {
      const value = nested[key] ?? source?.[key];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
    return undefined;
  };

  return {
    id: pick(["id", "modelId", "model"]),
    name: pick(["name", "modelLabel"]),
    contextWindow: pick(["contextWindow"]),
    maxTokens: pick(["maxTokens"]),
    reasoning: pick(["reasoning"]),
    supportsImages:
      nested.input !== undefined
        ? Array.isArray(nested.input) && nested.input.includes("image")
        : pick(["supportsImages"]),
    api: pick(["api"]),
    baseUrl: pick(["modelBaseUrl"]),
    cost: pick(["cost"]),
    thinkingLevels: pick(["thinkingLevels"]),
    thinkingLevelMap: pick(["thinkingLevelMap"]),
  };
}

/** api id 直接进 pi 的 schema 校验，脏值会让整个 models.json 加载失败，先收紧。 */
function safeApi(value) {
  const text = String(value ?? "").trim();
  return /^[a-z0-9][a-z0-9._-]*$/.test(text) ? text : undefined;
}

function safeBaseUrl(value) {
  try {
    return normalizeBaseUrl(value);
  } catch {
    return undefined;
  }
}

function clampInt(raw, min, max, fallback, label) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a number.`);
  }
  const clamped = Math.trunc(value);
  if (clamped < min || clamped > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return clamped;
}

function clip(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

export function isProbablyKeyValue(value) {
  return !/\s/.test(value);
}

export function normalizeBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("Base URL is required.");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Base URL is not a valid address, e.g. https://api.example.com/v1.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must be http or https.");
  }
  return raw.replace(/\/+$/, "");
}

/** 模型 id → 展示名：`qwen3.7-plus` → `Qwen3.7 Plus`。 */
export function prettifyModelId(id) {
  return String(id ?? "")
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const RESERVED_PROVIDER_IDS = new Set(["unknown", "radius"]);

/**
 * provider id：小写短横线，去重后加数字后缀。
 *
 * 中文名会被剔成空串，这时用名字本身的稳定 hash而不是计数器：同一个名字重进一次
 * 还是落在同一个 id 上，`auth.json` 里的 key 才不会成为孤儿。
 */
export function providerIdFromName(name, taken = []) {
  const base = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const seed = base && !RESERVED_PROVIDER_IDS.has(base) ? base : `model-${stableHash(String(name ?? ""))}`;
  const used = new Set(taken.map((id) => String(id).toLowerCase()));

  let candidate = seed;
  let suffix = 2;
  while (used.has(candidate.toLowerCase()) || RESERVED_PROVIDER_IDS.has(candidate)) {
    candidate = `${seed}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).slice(0, 6);
}

/**
 * 写入/更新一个自定义模型。
 *
 * `entry` 是 `normalizeCustomModelInput` 的结果；`target` = `{ providerId, model }` 表示编辑已有行。
 * 只动目标 provider，其余 provider 原样保留；provider 上不认识的字段（headers/compat/oauth…）也原样保留。
 */
/**
 * 这条草稿最终落到哪个 provider 上。`upsertCustomModel` 和路由共用它，否则
 * “要不要填 API Key”按一个 id 判、写入却落在另一个 id 上。
 *
 * 只有「编辑已有行」或「同名同地址」才允许落到同一个 provider 上；地址不同就是另一个
 * 供应商，直接新建一个 id —— 不然改个模型会把人家手写的 baseUrl 一起覆盖掉。
 */
export function resolveProviderTarget(config, entry, target) {
  const providers = config?.providers ?? {};
  const requestedId = String(target?.providerId || entry.providerId || "").trim();
  const found = requestedId ? findProvider({ providers }, requestedId) : undefined;
  const sameEndpoint = Boolean(found)
    && String(found.provider?.baseUrl ?? "").replace(/\/+$/, "") === entry.baseUrl;
  // 内置供应商在 models.json 里故意不写 baseUrl（写了会盖到该家所有模型上），
  // 所以第二条只能按 id 认，否则批量添加会给自己造出一个 anthropic-2。
  const matches = Boolean(found) && (target?.providerId || entry.providerMode === "builtin" || sameEndpoint);
  const existing = matches ? found : undefined;
  return {
    providerId: existing?.providerId ?? providerIdFromName(entry.providerName || entry.providerId, Object.keys(providers)),
    existing,
  };
}

export function upsertCustomModel(config, entry, { target, seed } = {}) {
  const providers = { ...(config?.providers ?? {}) };
  const next = { ...config, providers };

  const { providerId, existing } = resolveProviderTarget(next, entry, target);
  const editing = Boolean(target?.providerId && existing);

  if (!existing && Object.keys(providers).length >= MAX_PROVIDERS) {
    throw new Error(`At most ${MAX_PROVIDERS} custom providers are supported.`);
  }

  const previousProvider = existing?.provider ?? {};
  const previousModels = Array.isArray(previousProvider.models) ? [...previousProvider.models] : [];
  // 同 id 再添加一次 = 覆盖那一行，得把行里已有的值当底子（否则用户改过的展示名会被目录名冲掉）。
  const editedFrom = (target?.model ? findModelRecord(existing?.provider, target.model) : undefined)
    ?? findModelRecord(existing?.provider, entry.model.id);

  const model = buildModelRecord(entry.model, editedFrom, seed ?? findModelRecord(existing?.provider, entry.model.id));
  const modelIndex = previousModels.findIndex((candidate) => candidate?.id === model.id);
  if (modelIndex >= 0) {
    previousModels[modelIndex] = model;
  } else {
    if (previousModels.length >= MAX_MODELS_PER_PROVIDER) {
      throw new Error(`A single provider supports at most ${MAX_MODELS_PER_PROVIDER} models.`);
    }
    previousModels.push(model);
  }

  // 编辑且改了模型 id：旧 id 的那一行不再需要留在文件里。
  const renamedFrom = target?.model && target.model !== model.id
    ? previousModels.filter((candidate) => candidate?.id !== target.model)
    : previousModels;

  const builtIn = entry.providerMode === "builtin";
  providers[providerId] = {
    ...previousProvider,
    name: entry.providerName,
    // 内置供应商：不写 baseUrl/api/authHeader。models.json 的 baseUrl 会盖到该 provider
    // 所有模型上（xai/azure 这类一家多地址的会被改坏），鉴权也应由内置 provider 自己决定。
    ...(builtIn ? {} : {
      baseUrl: entry.baseUrl,
      api: previousProvider.api || model.api || CUSTOM_MODEL_API,
      authHeader: previousProvider.authHeader ?? entry.authHeader ?? true,
    }),
    models: renamedFrom,
  };

  return {
    config: next,
    providerId,
    modelId: model.id,
    previousProviderId: existing?.providerId,
    previousModelId: target?.model && target.model !== model.id ? target.model : undefined,
  };
}

// models.json 的模型行是最高一层：pi 只会从目录里补 api/baseUrl，其余字段一律用文件里的值，
// 文件没写就用硬编码兜底（cost 0、contextWindow 128000、compat/thinkingLevelMap 直接没了）。
// 所以往内置供应商里写模型时，必须把目录里的整条抄下来，否则 Claude 变成免费、思考等级映射丢失。
const CATALOG_ONLY_FIELDS = ["cost", "compat", "thinkingLevelMap", "samplingParams"];
const MERGED_MODEL_FIELDS = ["name", "api", "baseUrl", "reasoning", "input", "contextWindow", "maxTokens"];

/**
 * 把 runtime 里的模型记录削成 models.json 能收的形状。
 *
 * 只抄 schema 认的字段：`provider`/`id` 由写入方决定，别把 runtime 的内部字段带进文件。
 */
export function catalogSeedFromModel(model) {
  if (!model || typeof model !== "object") {
    return undefined;
  }
  const seed = {};
  for (const field of [...MERGED_MODEL_FIELDS, ...CATALOG_ONLY_FIELDS]) {
    if (model[field] !== undefined) {
      seed[field] = model[field];
    }
  }
  return Object.keys(seed).length ? seed : undefined;
}

function findModelRecord(provider, modelId) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  return models.find((candidate) => candidate?.id === modelId);
}

function buildModelRecord(model, previous, seed) {
  // 用户在弹窗里配了非 off 档位 = 声明模型支持强度参数；只自动开、不自动关。
  // 新映射表优先：有值（字符串）的档才算声明，`null` 是「该档不存在」，不算。
  const wantsEffort = model.given?.thinkingLevelMap
    ? Object.entries(model.thinkingLevelMap ?? {}).some(([level, value]) => level !== "off" && typeof value === "string")
    : Array.isArray(model.thinkingLevels) && model.thinkingLevels.some((level) => level !== "off");
  const previousWithEffort = wantsEffort
    ? { ...(previous ?? {}), compat: { ...(previous?.compat ?? {}), supportsReasoningEffort: true } }
    : previous;
  const record = { id: model.id };
  // 顺序 = 优先级从低到高：目录 → 文件里已有的行 → 这次请求真给了值的字段。
  // 后面的覆盖前面的：目录 < 文件里已有的行（用户改过的优先）。
  for (const source of [seed, previousWithEffort]) {
    if (!source) {
      continue;
    }
    for (const field of MERGED_MODEL_FIELDS) {
      if (source[field] !== undefined) {
        record[field] = source[field];
      }
    }
  }
  for (const field of CATALOG_ONLY_FIELDS) {
    const value = previousWithEffort?.[field] ?? seed?.[field];
    if (value !== undefined) {
      record[field] = value;
    }
  }

  const given = model.given ?? {};
  if (given.name || record.name === undefined) {
    record.name = model.name;
  }
  if (given.contextWindow || record.contextWindow === undefined) {
    record.contextWindow = model.contextWindow;
  }
  if (given.maxTokens || record.maxTokens === undefined) {
    record.maxTokens = model.maxTokens;
  }
  if (given.reasoning || record.reasoning === undefined) {
    record.reasoning = model.reasoning;
  }
  if (given.supportsImages || record.input === undefined) {
    record.input = model.supportsImages ? ["text", "image"] : ["text"];
  }
  if (given.api || record.api === undefined) {
    if (model.api) {
      record.api = model.api;
    }
  }
  if (given.modelBaseUrl || record.baseUrl === undefined) {
    if (model.modelBaseUrl) {
      record.baseUrl = model.modelBaseUrl;
    }
  }
  // 价格：这次真给了就整条按给的算（阶梯行以新为准，删掉的行就没了），没给才留文件/目录的。
  if (given.cost && model.cost) {
    record.cost = model.cost;
  }
  // 档位映射（新写法）：真给了就整表按给的算 —— 键在 = 声明（`null` 该档不存在，字符串 = 发给
  // 端点的值），键不在 = 未声明（pi 对 off..high 按默认映射放行，对 xhigh/max 视为不支持）。
  // 给空对象 = 明确清掉映射表（退回 pi 默认）；没给这个字段就保留文件/目录原值。
  if (given.thinkingLevelMap) {
    const map = model.thinkingLevelMap ?? {};
    if (Object.keys(map).length > 0) {
      record.thinkingLevelMap = map;
    } else {
      delete record.thinkingLevelMap;
    }
  }

  // 档位映射（旧写法，兼容一维数组）：真给了就整表重写（选中的档 → 同名，没选的 → null）；
  // 空选 = 清掉映射表。只给老客户端留着，新编辑器不再走这条。
  if (given.thinkingLevels) {
    if (model.thinkingLevels.length > 0) {
      record.thinkingLevelMap = Object.fromEntries(
        THINKING_LEVELS.map((level) => [level, model.thinkingLevels.includes(level) ? level : null]),
      );
    } else {
      delete record.thinkingLevelMap;
    }
  }
  if (record.cost === undefined) {
    record.cost = { ...ZERO_COST };
  }
  return record;
}

/** 删除一行；provider 的模型清空后连 provider 一起删。 */
export function removeCustomModel(config, { providerId, model }) {
  const providers = { ...(config?.providers ?? {}) };
  const next = { ...config, providers };
  const existing = providerId ? findProvider(next, providerId) : undefined;
  if (!existing) {
    throw new Error("That model is no longer there.");
  }

  const [id, provider] = [existing.providerId, existing.provider];
  const models = Array.isArray(provider.models) ? provider.models : [];
  if (!model) {
    delete providers[id];
    return { config: next, providerId: id, removedModelId: undefined, providerRemoved: true };
  }

  const kept = models.filter((candidate) => candidate?.id !== model);
  if (kept.length === models.length) {
    throw new Error("That model is no longer there.");
  }

  if (!kept.length) {
    delete providers[id];
    return { config: next, providerId: id, removedModelId: model, providerRemoved: true };
  }

  providers[id] = { ...provider, models: kept };
  return { config: next, providerId: id, removedModelId: model, providerRemoved: false };
}

/**
 * 改 provider 级的设置（名字 / 端点 / api 类型）：不碰模型行的其它字段，也不增删模型。
 *
 * 模型行里显式写了 baseUrl/api 的（从目录批加过来那种）必须跟着改，否则 provider 换了地址、
 * 那些行仍打老地址 —— pi 是 `definition.baseUrl ?? providerConfig.baseUrl`，行级优先。
 */
export function updateProviderSettings(config, { providerId, name, baseUrl, api } = {}) {
  const providers = { ...(config?.providers ?? {}) };
  const next = { ...config, providers };
  const existing = providerId ? findProvider(next, providerId) : undefined;
  if (!existing) {
    throw new Error("That provider is no longer there. Reopen settings.");
  }
  const [id, provider] = [existing.providerId, existing.provider];
  const nextName = String(name ?? "").trim();
  if (!nextName) {
    throw new Error("Provider name is required.");
  }
  const nextBaseUrl = normalizeBaseUrl(baseUrl);
  // 脏 api 会让整个 models.json 加载失败，所以不合法就当“没改”。
  const nextApi = safeApi(api) || String(provider.api ?? "").trim() || CUSTOM_MODEL_API;
  const models = (Array.isArray(provider.models) ? provider.models : []).map((model) => {
    const patched = { ...(model ?? {}) };
    if (patched.baseUrl) {
      patched.baseUrl = nextBaseUrl;
    }
    if (patched.api) {
      patched.api = nextApi;
    }
    return patched;
  });

  providers[id] = {
    ...provider,
    name: nextName,
    baseUrl: nextBaseUrl,
    api: nextApi,
    authHeader: provider.authHeader ?? true,
    models,
  };
  return { config: next, providerId: id, name: nextName, baseUrl: nextBaseUrl, api: nextApi };
}

/**
 * 拉列表/验 key 用哪个 key：这一轮填的优先，留空就退到已存的那一份。
 *
 * “留空 = 用存的那份”这件事散在几个入口里写过好几遍，抽出来才测得到（也才有机会一致）。
 */
export function resolveListingApiKey({ apiKey, storedKey } = {}) {
  const typed = String(apiKey ?? "").trim();
  return typed || String(storedKey ?? "").trim();
}

/** `GET {baseUrl}/models` —— OpenAI 兼容端点的模型列表地址。 */
export function modelsListUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

/** pi 认的 api 类型（见 pi.dev/docs/latest/custom-provider 的 API Types 表）。 */
export const LISTING_API_TYPES = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "anthropic-messages",
  "google-generative-ai",
  "azure-openai-responses",
  "google-vertex",
  "bedrock-converse-stream",
];

/** 能靠一个 HTTP GET 拿到列表的类型 → 列表端点的那一段路径（base 里已经有了就不重复拼）。 */
const LISTING_ENDPOINTS = {
  "openai-completions": { segment: "models", auth: "bearer" },
  "openai-responses": { segment: "models", auth: "bearer" },
  "openai-codex-responses": { segment: "models", auth: "bearer" },
  "mistral-conversations": { segment: "models", auth: "bearer" },
  // Anthropic 不认 Bearer：要 x-api-key + anthropic-version，列表在 /v1/models。
  "anthropic-messages": { segment: "v1/models", auth: "anthropic" },
  // Google 的列表在 /v1beta/models，key 走 x-goog-api-key。
  "google-generative-ai": { segment: "v1beta/models", auth: "google" },
};

const ANTHROPIC_VERSION = "2023-06-01";

/** 拿不了列表的类型和给用户的说法（Bedrock 是 SigV4、Azure 要 api-version、Vertex 要 ADC）。 */
const LISTING_UNSUPPORTED = {
  "azure-openai-responses":
    "Azure OpenAI lists models through its deployments API, which needs an api-version. Type the model name instead.",
  "google-vertex":
    "Vertex AI lists models with Google credentials (ADC), not an API key. Type the model name instead.",
  "bedrock-converse-stream":
    "Bedrock lists models through AWS SigV4, not an API key. Type the model name instead.",
};

/** 拼列表地址：base 里常常已经带了 `/v1`、`/v1beta`，那就只补最后一段，别拼出 `/v1/v1/models`。 */
function joinSegment(base, segment) {
  if (base.endsWith(`/${segment}`) || base === segment) {
    return base;
  }
  const parts = segment.split("/");
  const last = parts[parts.length - 1];
  const prefix = parts.slice(0, -1).join("/");
  if (prefix && base.endsWith(`/${prefix}`)) {
    return `${base}/${last}`;
  }
  return `${base}/${segment}`;
}

/**
 * 按 api 类型算出「怎么取模型列表」：URL、鉴权头、解析器。
 * 返回 `{ url, headers, extract }`，或者 `{ unsupported: "人话" }`。
 */
export function listingPlan(api, baseUrl, apiKey = "") {
  const kind = String(api ?? "").trim() || "openai-completions";
  const base = normalizeBaseUrl(baseUrl);
  const endpoint = LISTING_ENDPOINTS[kind];
  if (!endpoint) {
    return { api: kind, unsupported: LISTING_UNSUPPORTED[kind] ?? `Model listing is not supported for api "${kind}".` };
  }
  const hasKey = Boolean(String(apiKey ?? "").trim());
  // 没 key 就不发鉴权头：本地网关（Ollama / vLLM / LM Studio）的 `/models` 不要 key，
  // 而 `Bearer ` 这种空头会被相实的服务端一句 400 打回来，看起来像“拉不到列表”。
  const headers = !hasKey
    ? {}
    : endpoint.auth === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }
      : endpoint.auth === "google"
        ? { "x-goog-api-key": apiKey }
        : { authorization: `Bearer ${apiKey}` };
  return { api: kind, url: joinSegment(base, endpoint.segment), headers, extract: (payload) => parseModelListing(payload, kind) };
}

function toInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function listingEntries(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "models", "result", "deployments", "foundationModels"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

/** 各家 `/models` 的形状都不一样，统一摊成 `{id,name,contextWindow,maxTokens,reasoning,input}`。 */
export function parseModelListing(payload, api = "openai-completions") {
  const seen = new Set();
  const models = [];
  for (const raw of listingEntries(payload)) {
    const entry = typeof raw === "string" ? { id: raw } : (raw ?? {});
    const nameField = typeof entry.name === "string" ? entry.name : "";
    // Google 用 `models/gemini-x` 当资源名，写进 models.json 的得是去掉前缀的 id。
    const rawId = String(entry.id ?? entry.model ?? (nameField.includes("/") ? nameField.split("/").pop() : nameField) ?? "").trim();
    if (!rawId || !MODEL_ID_PATTERN.test(rawId) || seen.has(rawId)) continue;
    // Vertex/Bedrock 的列表里会混进没有推理版本的东西，Google 用 supportedGenerationMethods 标。
    const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : null;
    if (methods && !methods.some((method) => method === "generateContent" || method === "streamGenerateContent")) {
      continue;
    }
    seen.add(rawId);
    const inputTypes = Array.isArray(entry.inputTypes) ? entry.inputTypes : (Array.isArray(entry.input_types) ? entry.input_types : null);
    const display = String(entry.displayName ?? entry.display_name ?? entry.name ?? "").trim();
    models.push({
      id: rawId,
      name: display && display !== rawId ? display : prettifyModelId(rawId),
      contextWindow: toInt(entry.contextWindow ?? entry.context_window ?? entry.inputTokenLimit ?? entry.input_token_limit),
      maxTokens: toInt(entry.maxTokens ?? entry.max_tokens ?? entry.outputTokenLimit ?? entry.output_token_limit),
      reasoning: entry.reasoning === true || entry.supports_reasoning === true,
      input: inputTypes ? inputTypes.map((type) => String(type).toLowerCase()) : (Array.isArray(entry.input) ? entry.input : ["text"]),
      api: String(entry.api ?? (api || "")),
    });
  }
  return models;
}

/** `POST {baseUrl}/chat/completions` —— 探测用的最小请求地址。 */
export function chatCompletionsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

/** 从 `/models` 的响应里只取 id 列表（老调用方还在用，形状判断都并到 parseModelListing 里了）。 */
export function parseModelIds(payload) {
  return parseModelListing(payload).map((model) => model.id);
}

/** 测试连接时，端点报的错直接给用户看，别翻译成第二种语言。 */
export function describeTestFailure(status, body) {
  const detail = readableFailureBody(body);
  if (status === 401 || status === 403) {
    return "Authentication failed. Check the API key.";
  }
  if (status === 404) {
    // 404 最常见的错法是 Base URL 少了 /v1；把两边的话都说上，比只贴一堆 JSON 强。
    return detail
      ? `The endpoint returned no model list (404): ${detail}. Check whether the Base URL should end with /v1.`
      : "The endpoint returned no model list (404). Check whether the Base URL should end with /v1.";
  }
  return detail || `Request failed (HTTP ${status}).`;
}

/** 服务端报错体里能看的那一句话：`{"error":{"message":"..."}}` 比整挡 JSON 有用。 */
function readableFailureBody(body) {
  const raw = String(body ?? "").trim().slice(0, 200);
  if (!raw || (!raw.startsWith("{") && !raw.startsWith("["))) {
    return raw;
  }
  try {
    const parsed = JSON.parse(raw);
    const error = parsed?.error ?? parsed;
    const message = typeof error === "string" ? error : (error?.message ?? error?.msg ?? parsed?.message ?? "");
    return String(message ?? "").trim() || raw;
  } catch {
    return raw;
  }
}

/**
 * 探测失败的统一文案。
 *
 * 没拿到状态码就是没连上：undici 只会报一个 `fetch failed`，真正的原因在 `error.cause` 里
 * （ENOTFOUND / ECONNREFUSED / 证书…），不拼上去用户根本无从下手。
 */
export function describeConnectionFailure(baseUrl, error) {
  if (error?.status) {
    return describeTestFailure(error.status, error.body);
  }
  const host = safeHost(baseUrl);
  if (error?.name === "TimeoutError") {
    return `Connection to ${host} timed out.`;
  }
  const reason = error?.cause?.message || error?.message || "network unreachable";
  return `Cannot reach ${host}: ${reason}`;
}

function safeHost(baseUrl) {
  try {
    return new URL(String(baseUrl)).host;
  } catch {
    return String(baseUrl ?? "该地址");
  }
}

/**
 * 自己打一次端点的列表接口。
 *
 * pi 的 runtime 只会替**内置**供应商拉远端列表（它们的 provider 带了 `refreshModels`），
 * `models.json` 里用户自己加的 provider 没这个能力 —— 那种情况下想看到端点真实有哪些模型，
 * 只能按 api 类型 GET 一次。`fetchImpl` 留着给测试注入假响应。
 */
export async function requestModelListing({
  api,
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  // 地址缺失/写坏时 `listingPlan` 会抛。这里把它兑成一句 `{ok:false, error}`：
  // 报 500 的话前端红框里就是一整串 `"error":"..."` 的 JSON，跟“拉不到列表”看不出关系。
  let plan;
  try {
    plan = listingPlan(api, baseUrl, apiKey);
  } catch (planError) {
    return {
      ok: false,
      api: String(api ?? "").trim() || "openai-completions",
      endpoint: "",
      models: [],
      error: planError instanceof Error ? planError.message : String(planError),
    };
  }
  if (plan.unsupported) {
    return { ok: false, api: plan.api, endpoint: "", models: [], error: plan.unsupported };
  }
  if (!String(apiKey ?? "").trim()) {
    return {
      ok: false,
      api: plan.api,
      endpoint: plan.url,
      models: [],
      error: "No API key saved for this provider yet.",
    };
  }
  try {
    const response = await fetchImpl(plan.url, { headers: plan.headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return {
        ok: false,
        api: plan.api,
        endpoint: plan.url,
        models: [],
        status: response.status,
        error: describeTestFailure(response.status, text),
      };
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return {
        ok: false,
        api: plan.api,
        endpoint: plan.url,
        models: [],
        error: "The model listing endpoint did not return JSON.",
      };
    }
    const models = plan.extract(payload);
    if (!models.length) {
      // 空列表不算成功：多半是网关不实现这个接口，直接显示空会让用户以为端点什么都没给。
      return {
        ok: false,
        api: plan.api,
        endpoint: plan.url,
        models: [],
        error: "The model listing endpoint returned no models.",
      };
    }
    return { ok: true, api: plan.api, endpoint: plan.url, models };
  } catch (error) {
    return { ok: false, api: plan.api, endpoint: plan.url, models: [], error: describeConnectionFailure(baseUrl, error) };
  }
}

/**
 * 把端点报的列表和文件里已经存着的行并成弹窗要的形状。
 *
 * 两端都没给的字段用默认值补，否则表单里会出现 0；端点没报出来的老模型也必须留着 ——
 * 看不见就勾不掉，等于凭空消失。
 */
export function mergeListingRows({ listing, localModels, api = "", baseUrl = "" } = {}) {
  const localById = new Map(
    (Array.isArray(localModels) ? localModels : [])
      .map((model) => [String(model?.id ?? "").trim(), model])
      .filter(([id]) => id),
  );
  const seen = new Set();
  const rows = [];
  const build = (source, local) => {
    const id = String(source?.id ?? local?.id ?? "").trim();
    if (!id || !MODEL_ID_PATTERN.test(id) || seen.has(id)) {
      return;
    }
    seen.add(id);
    const contextWindow = toPositiveInt(source?.contextWindow) ?? toPositiveInt(local?.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
    const maxTokens = Math.min(
      toPositiveInt(source?.maxTokens) ?? toPositiveInt(local?.maxTokens) ?? DEFAULT_MAX_TOKENS,
      contextWindow,
    );
    const input = Array.isArray(source?.input) ? source.input : (Array.isArray(local?.input) ? local.input : null);
    const name = String(source?.name ?? "").trim() || String(local?.name ?? "").trim() || prettifyModelId(id);
    rows.push({
      id,
      name,
      api: String(source?.api ?? "").trim() || String(local?.api ?? "").trim() || api,
      baseUrl: String(source?.baseUrl ?? "").trim() || String(local?.baseUrl ?? "").trim() || baseUrl,
      contextWindow,
      maxTokens,
      reasoning: source?.reasoning === true || local?.reasoning === true,
      supportsImages: input ? input.some((type) => String(type).toLowerCase().includes("image")) : Boolean(local?.supportsImages),
    });
  };
  for (const model of Array.isArray(listing) ? listing : []) {
    build(model, localById.get(String(model?.id ?? "").trim()));
  }
  for (const model of Array.isArray(localModels) ? localModels : []) {
    build(null, model);
  }
  // 和 normalizeProviderCatalog 一样按 id 排：两家供应商切来切去时列表顺序不该变。
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

/* ------------------------------------------------------- 内置供应商目录 */

/**
 * 把 runtime 里的 provider 摊成接口能返回的形状。
 *
 * 这里只做“能安全进 JSON”的裁剪：模型 id 不合法的丢掉、缺字段给默认值。
 * `withModels: false` 时只给数量——列表页只想知道有哪些供应商，模型是选中之后再拉的，
 * 否则一次要回上千条。
 */
export function normalizeProviderCatalog(providers, { withModels = false } = {}) {
  const list = [];
  for (const provider of providers ?? []) {
    const id = String(provider?.id ?? "").trim();
    if (!id) {
      continue;
    }
    const models = (Array.isArray(provider?.models) ? provider.models : [])
      .map((model) => {
        const modelId = String(model?.id ?? "").trim();
        return {
          id: modelId,
          name: String(model?.name ?? "").trim() || prettifyModelId(modelId),
          api: String(model?.api ?? "").trim(),
          baseUrl: String(model?.baseUrl ?? "").trim(),
          contextWindow: toPositiveInt(model?.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
          maxTokens: toPositiveInt(model?.maxTokens) ?? DEFAULT_MAX_TOKENS,
          reasoning: Boolean(model?.reasoning),
          supportsImages: Array.isArray(model?.input) ? model.input.includes("image") : false,
        };
      })
      .filter((model) => model.id && MODEL_ID_PATTERN.test(model.id))
      .sort((a, b) => a.id.localeCompare(b.id));

    list.push({
      id,
      name: String(provider.name ?? "").trim() || prettifyModelId(id),
      baseUrl: String(provider.baseUrl ?? "").trim(),
      // provider 级的 api（只可能来自 models.json）：编辑自定义供应商时要把它回显给用户。
      api: String(provider.api ?? "").trim(),
      authConfigured: Boolean(provider.authConfigured),
      authKind: String(provider.authKind ?? "").trim() || (provider.authConfigured ? "api_key" : "none"),
      registered: Boolean(provider.registered),
      builtin: Boolean(provider.builtin),
      authMethods: Array.isArray(provider.authMethods) ? provider.authMethods.map(String) : [],
      // withModels=false 时没展开列表，数量听调用方的（runtime 目录里数出来的）。
      modelCount: withModels ? models.length : nonNegativeInt(provider.modelCount, models.length),
      ...(withModels ? { models } : {}),
    });
  }

  return list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function toPositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined;
}
