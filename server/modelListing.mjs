/** 模型 id 的形态（与 `customModels.mjs` 共用；随这一簇一起搬过来，避免反向依赖）。 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

/** 端点没报出来时表单里用的默认值（与 `customModels.mjs` 同一口径；随这一簇搬来）。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

/**
 * 端点探测与列表合并：模型设置页那条「点一下看端点真实有哪些模型」的链路。
 *
 * 为什么从 `customModels.mjs` 拆出来（2026-10-22）：那个文件写着脏数据校验与会话无关的纯变换，
 * 而这一簇是**网络 + 报文解析**（自己 GET 一次端点的列表接口、把结果与文件里已存的行并成表单形状）。
 * 两者只有「都服务于模型设置页」这一个共同点，拆开后各自的测试与改动互不牵连。
 *
 * 依赖方向是单向的：本模块不 import `customModels.mjs`（否则就成了环）；`normalizeBaseUrl` /
 * `prettifyModelId` / `toPositiveInt` 这三个小工具随本文档一起搬过来，由 `customModels.mjs` 反向 import。
 *
 ** 拉列表/验 key 用哪个 key：这一轮填的优先，留空就退到已存的那一份。
 *
 * “留空 = 用存的那份”这件事散在几个入口里写过好几遍，抽出来才测得到（也才有机会一致）。
 */
/** @param {{ apiKey?: string, storedKey?: string }} [input] */
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
export const LISTING_ENDPOINTS = {
  "openai-completions": { segment: "models", auth: "bearer" },
  "openai-responses": { segment: "models", auth: "bearer" },
  "openai-codex-responses": { segment: "models", auth: "bearer" },
  "mistral-conversations": { segment: "models", auth: "bearer" },
  // Anthropic 不认 Bearer：要 x-api-key + anthropic-version，列表在 /v1/models。
  "anthropic-messages": { segment: "v1/models", auth: "anthropic" },
  // Google 的列表在 /v1beta/models，key 走 x-goog-api-key。
  "google-generative-ai": { segment: "v1beta/models", auth: "google" },
};

export const ANTHROPIC_VERSION = "2023-06-01";

/** 拿不了列表的类型和给用户的说法（Bedrock 是 SigV4、Azure 要 api-version、Vertex 要 ADC）。 */
export const LISTING_UNSUPPORTED = {
  "azure-openai-responses":
    "Azure OpenAI lists models through its deployments API, which needs an api-version. Type the model name instead.",
  "google-vertex":
    "Vertex AI lists models with Google credentials (ADC), not an API key. Type the model name instead.",
  "bedrock-converse-stream":
    "Bedrock lists models through AWS SigV4, not an API key. Type the model name instead.",
};

/** 拼列表地址：base 里常常已经带了 `/v1`、`/v1beta`，那就只补最后一段，别拼出 `/v1/v1/models`。 */
export function joinSegment(base, segment) {
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
 *
 * 两支都把对方的字段标成 `undefined`，调用方才能靠 `if (plan.unsupported)` 收窄 ——
 * 否则 `plan.url` / `plan.extract` 在类型上永远「可能不存在」，每个调用点都要重复判。
 *
 * @param {string} [api] 没给 / 给了空串都按 `openai-completions` 处理（函数体自己归一）
 * @param {string} [baseUrl]
 * @param {string} [apiKey]
 * @returns {{ api: string, url: string, headers: Record<string, string>, extract: (payload: unknown) => any[], unsupported?: undefined }
 *   | { api: string, unsupported: string, url?: undefined, headers?: undefined, extract?: undefined }}
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
  /** @type {Record<string, string>} */
  const headers = !hasKey
    ? {}
    : endpoint.auth === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }
      : endpoint.auth === "google"
        ? { "x-goog-api-key": apiKey }
        : { authorization: `Bearer ${apiKey}` };
  return { api: kind, url: joinSegment(base, endpoint.segment), headers, extract: (payload) => parseModelListing(payload, kind) };
}

export function toInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function listingEntries(payload) {
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
export function readableFailureBody(body) {
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

export function safeHost(baseUrl) {
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
 *
 * @param {{ api?: string, baseUrl?: string, apiKey?: string, fetchImpl?: typeof globalThis.fetch, timeoutMs?: number }} [options]
 * @returns {Promise<
 *   | { ok: true, api: string, endpoint: string, models: { id: string, name?: string }[], listing?: any[] }
 *   | { ok: false, api: string, endpoint: string, models: any[], error: string, status?: number }
 * >} 判别字段是 `ok`：失败那支的 `error` 一定是字符串，调用方判过就不必再补默认值。
 */
export async function requestModelListing({
  api,
  baseUrl,
  apiKey = "",
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  // 地址缺失/写坏时 `listingPlan` 会抛。这里把它兑成一句 `{ok:false, error}`：
  // 报 500 的话前端红框里就是一整串 `"error":"..."` 的 JSON，跟“拉不到列表”看不出关系。
  /** @type {any} */
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
  if (plan.unsupported !== undefined) {
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
    const response = await fetchImpl(String(plan.url ?? ""), { headers: plan.headers ?? {}, signal: AbortSignal.timeout(timeoutMs) });
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
    if (typeof plan.extract !== "function") {
      // 走到这里说明 `listingPlan` 给了 `{unsupported}`，上面的 catch 分支没拦住 —— 报出来而不是静默。
      return { ok: false, api: String(api ?? ""), endpoint: "", models: [], error: plan.unsupported ?? "unsupported endpoint" };
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
 *
 *@param {{ listing?: any, localModels?: any[], api?: string, baseUrl?: string }} [input] */
export function mergeListingRows({ listing, localModels, api = "", baseUrl = "" } = {}) {
  const localById = new Map(
    /** @type {[string, any][]} */ (
      (Array.isArray(localModels) ? localModels : [])
        .map((model) => [String(model?.id ?? "").trim(), model])
        .filter(([id]) => id)
    ),
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

export function prettifyModelId(id) {
  return String(id ?? "")
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function toPositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined;
}
