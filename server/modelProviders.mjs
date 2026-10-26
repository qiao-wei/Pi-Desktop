import { corsHeaders } from "./cors.mjs";
import { catalogSeedFromModel, chatCompletionsUrl, describeConnectionFailure, findCustomModel, isProbablyKeyValue, listCustomModels, listingPlan, mergeListingRows, normalizeBaseUrl, normalizeCustomModelInputs, normalizeProviderCatalog, prettifyModelId, removeCustomModel, requestModelListing, resolveProviderTarget, updateProviderSettings, upsertCustomModels } from "./customModels.mjs";
import { readJson, withTimeout } from "./httpHelpers.mjs";
import { describeModel, loginOauthMetadata, requestOpenAiJson } from "./modelHelpers.mjs";
import { normalizeLoginAuthType, providerLoginMethods } from "./modelLogin.mjs";
import { isFreshSession, silenceGlobalModelWrites } from "./sessionModelPolicy.mjs";
import { diagnosticLog } from "./sessionStoreFactory.mjs";
import { displayAgentPath, isSessionBusy, normalizeThinkingLevel } from "./smallHelpers.mjs";

/**
 * 模型与供应商（目录、自定义模型、登录、选择）
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createModelProviders(state, deps) {
  const { http429StatusPatterns, modelLoginBroker, modelRuntime, modelsJsonFile } = deps;
  const rememberProjectComposerDefaults = /** @type {any} */ ((...args) => deps.rememberProjectComposerDefaults(...args));
  const builtInProviderIds = /** @type {any} */ ((...args) => deps.builtInProviderIds(...args));
  const dropStoredApiKey = /** @type {any} */ ((...args) => deps.dropStoredApiKey(...args));
  const persistModelApiKey = /** @type {any} */ ((...args) => deps.persistModelApiKey(...args));
  const readCustomModelsConfig = /** @type {any} */ ((...args) => deps.readCustomModelsConfig(...args));
  const readStoredApiKey = /** @type {any} */ ((...args) => deps.readStoredApiKey(...args));
  const reloadCustomModelProviders = /** @type {any} */ ((...args) => deps.reloadCustomModelProviders(...args));
  const writeCustomModelsConfig = /** @type {any} */ ((...args) => deps.writeCustomModelsConfig(...args));
  const buildSnapshot = /** @type {any} */ ((...args) => deps.buildSnapshot(...args));
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));

function isHttp429ProviderError(errorMessage) {
  const message = String(errorMessage ?? "");
  return http429StatusPatterns.some((pattern) => pattern.test(message));
}

function findDefaultModel(settingsManager) {
  const providerId = settingsManager.getDefaultProvider();
  const modelId = settingsManager.getDefaultModel();
  if (!providerId || !modelId) {
    return undefined;
  }

  const candidate = modelRuntime.getModel(providerId, modelId);
  return candidate ?? undefined;
}

/**
 * 记住的默认模型现在还能不能真拿来对话。
 *
 * 「还认识」不等于「能用」：删掉内置供应商的最后一个模型时，models.json 的行没了、
 * auth.json 的 key 也跟着清了，但模型本身仍在 pi 的目录里 —— 这时候 `setModel()` 会抛
 * "No API key"，得当成没有默认值处理。
 */
function usableDefaultModel(settingsManager) {
  const model = findDefaultModel(settingsManager);
  return model && isUsableModel(model) && modelRuntime.hasConfiguredAuth(model.provider) ? model : undefined;
}

function listAvailableModels() {
  const available = new Set(
    modelRuntime
      .getAvailableSnapshot()
      .filter((model) => !model.provider.startsWith("qwen-token-plan"))
      .map((model) => `${model.provider}/${model.id}`),
  );
  return modelRuntime
    .getModels()
    .filter((model) => !model.provider.startsWith("qwen-token-plan"))
    .map((model) => describeModel(model, available.has(`${model.provider}/${model.id}`)));
}

async function setModelConfiguration(body) {
  const targetRuntime = getRuntimeForRequest(body);
  const provider = String(body?.provider ?? "").trim();
  const modelId = String(body?.model ?? "").trim();
  const thinkingLevel = normalizeThinkingLevel(body?.thinkingLevel ?? targetRuntime.session.thinkingLevel ?? "off");
  const apiKey = String(body?.apiKey ?? "").trim();
  if (!provider || !modelId) {
    throw new Error("provider and model are required");
  }

  if (isSessionBusy(targetRuntime.session)) {
    throw new Error("The current reply is still running — stop it before switching models.");
  }

  if (apiKey) {
    persistModelApiKey(provider, apiKey);
    await modelRuntime.setRuntimeApiKey(provider, apiKey);
  }

  const model = resolveModel(provider, modelId);
  if (!model) {
    throw new Error(`Unknown model: ${provider}/${modelId}`);
  }

  // 新任务从哪个模型/等级开始 = 按项目记在 projects.json（composerDefaults），且只有「还没提交过
  // 消息」的新会话里改才算数；历史会话里切模型只管这条会话自己。pi 的 setModel()/setThinkingLevel()
  // 都会顺手写全局 settings，一律挡掉，改由 rememberProjectComposerDefaults 记到项目上。
  const remember = isFreshSession(targetRuntime.session);
  const restore = silenceGlobalModelWrites(targetRuntime.settingsManager);
  try {
    await targetRuntime.session.setModel(model);
    targetRuntime.session.setThinkingLevel(thinkingLevel);
  } finally {
    restore();
  }
  if (remember) {
    rememberProjectComposerDefaults(targetRuntime.projectId, {
      provider: model.provider,
      model: model.id,
      thinkingLevel: targetRuntime.session.thinkingLevel,
    });
  }
  await targetRuntime.settingsManager.flush();
  return buildSnapshot(targetRuntime);
}

function customModelsPayload() {
  const config = readCustomModelsConfig();
  const available = new Set(modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
  return {
    modelsPath: displayAgentPath(modelsJsonFile),
    customModels: listCustomModels(config).map((entry) => {
      // 从内置目录挑的模型只写了 id + 少量字段，cost/compat/上下文这些由 pi 继承内置目录，
      // 所以展示时要拿 runtime 的“合并后”值，否则列表里会显示成默认 128k。
      const runtime = modelRuntime.getModel(entry.providerId, entry.model);
      return {
        ...entry,
        ...(runtime ? {
          modelLabel: entry.modelLabel === entry.model ? (runtime.name || entry.modelLabel) : entry.modelLabel,
          contextWindow: runtime.contextWindow ?? entry.contextWindow,
          maxTokens: runtime.maxTokens ?? entry.maxTokens,
          reasoning: Boolean(runtime.reasoning),
          supportsImages: Array.isArray(runtime.input) ? runtime.input.includes("image") : entry.supportsImages,
          baseUrl: runtime.baseUrl || entry.baseUrl,
          api: runtime.api || entry.api,
        } : {}),
        apiKeyConfigured: modelRuntime.hasConfiguredAuth(entry.providerId),
        builtin: builtInProviderIds().has(entry.providerId),
        available: available.has(`${entry.providerId}/${entry.model}`),
      };
    }),
  };
}

/**
 * 单家供应商的详情（带模型列表）。
 *
 * 只有这一个口回传明文 apiKey：弹窗要把已存的 key 填回输入框（默认密文、点眼睛看明文）。
 * 列表口 `/api/model-providers` 不带 key —— 一次把 40 多家的 key 全吐出去没必要，也不该留在那个
 * 会被别处复用的形状里。OAuth 鉴权的供应商没有 key 可给，readStoredApiKey 自己会回空串。
 */
function providerCatalogRow(providerId) {
  const row = providerRows({ withModelsFor: providerId }).find((candidate) => candidate.id === providerId);
  if (!row) {
    return null;
  }
  const normalized = normalizeProviderCatalog([row], { withModels: true })[0];
  return normalized ? { ...normalized, apiKey: readStoredApiKey(row.id) } : null;
}

/**
 * runtime 的 provider 只告诉我们「有哪些」，两种「来源」得自己标：
 * models.json 里存过 = 用户加的；pi 内置目录里有 = 内置供应商。
 * 模型列表按 `withModelsFor` 只展开需要的那一家，41 家全展开一次就是上千条。
 */
function providerRows({ withModelsFor = "" } = {}) {
  const configProviders = readCustomModelsConfig().providers ?? {};
  const inModelsJson = new Set(Object.keys(configProviders));
  const builtins = builtInProviderIds();
  return modelRuntime.getProviders().map((provider) => {
    const authConfigured = modelRuntime.hasConfiguredAuth(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      // runtime 的 provider 不暴露 api，只能从 models.json 拿（内置的没有，行级 api 已经够了）。
      api: String(configProviders[provider.id]?.api ?? "").trim(),
      models: provider.id === withModelsFor ? modelRuntime.getModels(provider.id) ?? [] : [],
      modelCount: modelRuntime.getModels(provider.id)?.length ?? 0,
      authConfigured,
      authKind: modelRuntime.isUsingOAuth(provider.id) ? "oauth" : authConfigured ? "api_key" : "none",
      authMethods: Object.keys(provider.auth ?? {}),
      // 登录方式的元数据（名单来自 pi 的 provider.auth，不是这里写死的）：设置页靠它
      // 决定显示哪几个登录入口、入口叫什么，和 TUI 的 /login 选择器同一套依据。
      oauth: loginOauthMetadata(provider),
      apiKeyLogin: typeof provider.auth?.apiKey?.login === "function",
      registered: inModelsJson.has(provider.id),
      builtin: builtins.has(provider.id),
    };
  });
}

/**
 * 填了 key 就把它存下来，然后把这个供应商的模型列表端出来。
 *
 * 两家供应商的“列表在哪”不一样：
 *   · pi 内置供应商：provider 自己带了远端列表能力，`modelRuntime.refresh({ allowNetwork: true })` 就能拿到；
 *   · `models.json` 里用户自己加的：runtime 里没有这个能力（provider 没 `refreshModels`），
 *     refresh 是静默 no-op，只能我们按 api 类型自己 GET 一次端点的列表接口。
 * 拉不动就退回本地已知目录 —— 目录里有的模型 pi 本来就能调用，不该因为网络抖动加不了。
 */
async function discoverProviderModels(body) {
  const providerId = String(body?.providerId ?? "").trim();
  if (!providerId) {
    throw new Error("Pick a provider first.");
  }
  if (!modelRuntime.getProvider(providerId)) {
    throw new Error("Unknown provider. Pick it again.");
  }

  const apiKey = String(body?.apiKey ?? "").trim();
  if (apiKey) {
    if (!isProbablyKeyValue(apiKey)) {
      throw new Error("The API key must not contain spaces or line breaks.");
    }
    persistModelApiKey(providerId, apiKey);
    await modelRuntime.setRuntimeApiKey(providerId, apiKey).catch(() => undefined);
  }

  // 能不能让 runtime 拉，看的是 provider 有没有实现 refreshModels，不看它“像不像内置”。
  const runtimeCanList = providerSupportsRuntimeListing(providerId);

  let refreshed = false;
  let warning = "";
  try {
    const result = await withTimeout(
      modelRuntime.refresh({ providers: [providerId], allowNetwork: true, force: true }),
      12_000,
      "Timed out fetching the model list; using the local catalog.",
    );
    const errors = result?.errors;
    if (errors && typeof errors[Symbol.iterator] === "function" && errors.size !== 0) {
      const first = [...errors.values()][0];
      warning = first?.message ?? String(first);
    } else {
      // 只有 runtime 真的会联网拉的供应商，才配说“已刷新”；自定义 provider 这里什么都没发生。
      refreshed = runtimeCanList;
    }
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
  }

  const row = providerCatalogRow(providerId);
  let models = row?.models ?? [];

  if (!runtimeCanList) {
    const listingBaseUrl = String(row?.baseUrl || providerConfigBaseUrl(providerId) || "").trim();
    if (!listingBaseUrl) {
      // 内置供应商里 Bedrock / Vertex 这类根本没有 HTTP 端点（鉴权也不走 API key）。
      // 目录就是它们能给出的最新列表，别拿一句 “Base URL is required.” 去砸用户。
      warning = "This provider is built into pi and has no endpoint to refresh from \u2014 the list below is pi's catalog.";
    } else {
      const listing = await requestModelListing({
        api: providerListingApi(providerId, models),
        baseUrl: listingBaseUrl,
        apiKey: apiKey || readStoredApiKey(providerId),
      });
      if (listing.ok) {
        models = mergeListingRows({
          listing: listing.models,
          localModels: row?.models ?? [],
          api: listing.api,
          baseUrl: normalizeBaseUrl(listingBaseUrl),
        });
        refreshed = true;
        warning = "";
      } else if (!warning) {
        warning = listing.error;
      }
    }
  }

  return {
    ok: true,
    providerId,
    // discover 的响应里不带 key：key 只从「单家详情」那个口出去。
    provider: row ? { ...row, models: undefined, apiKey: undefined } : null,
    models,
    authConfigured: modelRuntime.hasConfiguredAuth(providerId),
    refreshed,
    warning,
  };
}

/**
 * 跑一次 pi 的登录流程，把交互事件转成 NDJSON 写给设置页。
 *
 * 支持什么登录方式由 `provider.auth` 决定（`oauth` / `apiKey`），不写死任何供应商；
 * 用户中途关弹窗 = 客户端断开 → 这里 abort 掉正在跑的登录，别把回调端口和轮询留在后台。
 */
async function streamModelLogin(req, res, providerId, requestId) {
  const body = await readJson(req);
  const authType = normalizeLoginAuthType(body?.authType);
  const provider = modelRuntime.getProvider(providerId);
  if (!provider) {
    throw new Error("Unknown provider. Pick it again.");
  }
  const methods = providerLoginMethods(provider);
  if (authType === "oauth" ? !methods.oauth : !methods.apiKey) {
    throw new Error(`${provider.name ?? providerId} does not support ${authType === "oauth" ? "account sign-in" : "an API key"}.`);
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...corsHeaders(),
  });
  diagnosticLog("model.login.start", { requestId, providerId, authType });
  const { sessionId, done } = modelLoginBroker.start({
    providerId,
    authType,
    onEvent: (payload) => {
      if (!res.destroyed) {
        res.write(`${JSON.stringify(payload)}\n`);
      }
    },
    login: (interaction) => modelRuntime.login(providerId, authType, interaction, {
      // OpenAI 的订阅登录靠这个稳定 UUID 认「这台安装」；写的是 pi 自己的
      // settings.json（`deviceId`），所以和终端 TUI 共用同一个值。
      getDeviceId: () => state.runtime.settingsManager.getOrCreateDeviceId(),
    }),
  });
  // 弹窗关了 / 网络断了：这次登录已经没人看，取消它。
  res.on("close", () => modelLoginBroker.cancel(sessionId));
  await done;
  if (!res.destroyed) {
    res.end();
  }
  diagnosticLog("model.login.end", { requestId, providerId, authType, sessionId });
}

/** runtime 会不会替这家供应商联网拉列表（内置 provider 有 `refreshModels`，models.json 里没有）。 */
function providerSupportsRuntimeListing(providerId) {
  try {
    return typeof modelRuntime.getProvider(providerId)?.refreshModels === "function";
  } catch {
    return false;
  }
}

/** 列表按哪种 api 拼：文件里 provider 级优先，其次看已有的模型行，最后才按 OpenAI 兼容猜。 */
function providerListingApi(providerId, models = []) {
  return providerConfigValue(providerId, "api")
    || String(models.find((model) => model?.api)?.api ?? "").trim()
    || "openai-completions";
}

function providerConfigBaseUrl(providerId) {
  return String(providerConfigValue(providerId, "baseUrl") ?? "").trim();
}

function providerConfigValue(providerId, key) {
  const providers = readCustomModelsConfig().providers ?? {};
  const id = Object.keys(providers).find((candidate) => candidate.toLowerCase() === providerId.toLowerCase());
  const value = id ? providers[id]?.[key] : undefined;
  return value === undefined || value === null ? "" : String(value).trim();
}

/**
 * 改一个自定义供应商的 provider 级设置（名字 / 端点 / api 类型），可选顺手换 key。
 *
 * 内置供应商不给改：models.json 里给内置 id 写 baseUrl 会把那家所有模型都盖到同一个地址上
 * （xai / azure 这种一家多地址的会被改坏），它们的鉴权也是 pi 自己的事。
 */
async function updateProvider(body) {
  const providerId = String(body?.providerId ?? "").trim();
  if (!providerId) {
    throw new Error("Pick a provider first.");
  }
  if (builtInProviderIds().has(providerId)) {
    throw new Error("Built-in providers are managed by pi — only the API key can be changed.");
  }
  // key 格式先校：不然报错之前已经把 models.json 写了半截。
  const apiKey = String(body?.apiKey ?? "").trim();
  if (apiKey && !isProbablyKeyValue(apiKey)) {
    throw new Error("The API key must not contain spaces or line breaks.");
  }
  const result = updateProviderSettings(readCustomModelsConfig(), {
    providerId,
    name: body?.name,
    baseUrl: body?.baseUrl,
    api: body?.api,
  });
  writeCustomModelsConfig(result.config);
  if (apiKey) {
    persistModelApiKey(result.providerId, apiKey);
    await modelRuntime.setRuntimeApiKey(result.providerId, apiKey).catch(() => undefined);
  }
  await reloadCustomModelProviders([result.providerId]);
  return {
    ...customModelsPayload(),
    providerId: result.providerId,
    baseUrl: result.baseUrl,
    api: result.api,
    availableModels: listAvailableModels(),
  };
}

function currentDefaultModel() {
  const provider = state.runtime.settingsManager.getDefaultProvider() ?? "";
  const model = state.runtime.settingsManager.getDefaultModel() ?? "";
  return provider && model ? { provider, model } : null;
}

/** 删掉的模型正好是默认模型时，把默认值换到一个还能用的模型上，别留个断链。 */
function repairDefaultModelAfterRemoval() {
  const current = currentDefaultModel();
  if (!current || usableDefaultModel(state.runtime.settingsManager)) {
    return;
  }
  const fallback = defaultComposerModel();
  if (!fallback) {
    return;
  }
  state.runtime.settingsManager.setDefaultProvider(fallback.provider);
  state.runtime.settingsManager.setDefaultModel(fallback.id);
  void state.runtime.settingsManager.flush().catch(() => undefined);
}

/**
 * 输入框下拉列表的“第一个模型”，也是没记住任何选择时新会话的起点。
 *
 * 顺序必须和 `buildComposerModelOptions` 一致：自定义模型在前（按 models.json 里的顺序），
 * 其后是已配好鉴权的内置模型。两边各排各的会出现“下拉框选中第一项、实际用的是另一项”。
 */
function defaultComposerModel() {
  const available = new Set(modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
  for (const entry of listCustomModels(readCustomModelsConfig())) {
    if (!entry.managed || !entry.model) {
      continue;
    }
    const model = resolveModel(entry.providerId, entry.model);
    if (model && available.has(`${model.provider}/${model.id}`)) {
      return model;
    }
  }
  return modelRuntime.getAvailableSnapshot()[0];
}

async function saveCustomModel(body) {
  const config = readCustomModelsConfig();
  const targetProviderId = String(body?.targetProviderId ?? "").trim();
  const targetModel = String(body?.targetModel ?? "").trim();
  const existing = targetProviderId && targetModel
    ? findCustomModel(config, targetProviderId, targetModel)
    : undefined;
  if (targetProviderId && targetModel && !existing) {
    throw new Error("That model is no longer there. Reopen settings.");
  }

  // 先按 upsert 的同一套规则算出这条草稿会落到哪个 provider，再决定“没 key 行不行”：
  // 往已有供应商里加第二个模型时，key 早就存过了，不该再逼用户填一遍。
  const target = existing ? { providerId: targetProviderId, model: targetModel } : undefined;
  // 探一次“这条草稿会落到哪家”：内置供应商在 models.json 里根本没有 baseUrl，probe 不能拿它当
  // 必填 —— 否则“往内置供应商加模型”在这步就 500（真正的 builtin/custom 判定仍在下面按 resolvedId 做）。
  const probeBody = builtInProviderIds().has(String(body?.providerId ?? "").trim())
    ? { ...body, providerMode: "builtin" }
    : body;
  const probe = normalizeCustomModelInputs(probeBody, { requireApiKey: false })[0];
  const resolvedId = resolveProviderTarget(config, probe, target).providerId;
  const hasStoredKey = Boolean(readStoredApiKey(resolvedId)) || modelRuntime.hasConfiguredAuth(resolvedId);
  // 落到 pi 内置供应商上时只补模型行，baseUrl/authHeader 由内置 provider 自己管。
  const builtinTarget = builtInProviderIds().has(resolvedId);
  const bodyWithMode = { ...body, providerMode: builtinTarget ? "builtin" : "custom" };
  // 内置供应商的鉴权是 pi 自己的事（env / OAuth / 之后 /login 都行），没 key 也允许先把模型加进来，
  // 列表里会标成 "no API key"。自定义端点没 key 就什么都调不了，必须填。
  const requireApiKey = !hasStoredKey && !builtinTarget;
  const entries = normalizeCustomModelInputs(bodyWithMode, { hasStoredKey, requireApiKey });
  // models.json 的模型行会整条盖掉内置目录，所以写之前先把目录里的 cost/compat/thinkingLevelMap
  // 抄进新行 —— 不然加一个 Claude 进去就变成免费模型、思考等级映射也没了。
  const seeds = {};
  for (const entry of entries) {
    const seed = catalogSeedFromModel(modelRuntime.getModel(resolvedId, entry.model.id));
    if (seed) {
      seeds[entry.model.id] = seed;
    }
  }
  const result = upsertCustomModels(config, entries, { target, seeds });

  writeCustomModelsConfig(result.config);
  const apiKey = entries[0]?.apiKey.trim() ?? "";
  if (apiKey) {
    for (const providerId of result.providerIds) {
      persistModelApiKey(providerId, apiKey);
      await modelRuntime.setRuntimeApiKey(providerId, apiKey).catch(() => undefined);
    }
  }
  await reloadCustomModelProviders([...result.providerIds, result.previousProviderId]);

  return {
    ...customModelsPayload(),
    providerId: result.providerId,
    model: result.modelId,
    models: result.models,
    availableModels: listAvailableModels(),
  };
}

async function deleteCustomModel(body) {
  const config = readCustomModelsConfig();
  const result = removeCustomModel(config, {
    providerId: String(body?.providerId ?? "").trim(),
    model: String(body?.model ?? "").trim(),
  });

  writeCustomModelsConfig(result.config);
  if (result.providerRemoved) {
    await modelRuntime.removeRuntimeApiKey(result.providerId).catch(() => undefined);
    dropStoredApiKey(result.providerId);
  }
  await reloadCustomModelProviders([result.providerId]);
  repairDefaultModelAfterRemoval();

  return { ...customModelsPayload(), availableModels: listAvailableModels() };
}

async function testCustomModelConnection(body) {
  const baseUrl = normalizeBaseUrl(body?.baseUrl);
  const providerId = String(body?.providerId ?? body?.targetProviderId ?? "").trim();
  // 没填就用已存的那份；两边都没有也不是错：拉列表本身可以不带鉴权（本地网关），
  // 真需要 key 的端点会回 401，那句报错比在门口拦下来更说得清。以前这里空 key 直接报错，
  // 结果用户填完地址也按不动 Fetch，看上去就像这个弹窗干不了事。
  const apiKey = String(body?.apiKey ?? "").trim() || readStoredApiKey(providerId);

  // 不同 api 类型的列表端点/鉴权头都不一样（Anthropic 不认 Bearer，Google 走 x-goog-api-key）。
  const plan = listingPlan(body?.api, baseUrl, apiKey);
  if (plan.unsupported !== undefined) {
    return { ok: false, error: plan.unsupported, endpoint: "" };
  }

  const modelId = String(body?.model ?? "").trim();
  const openAiFamily = ["openai-completions", "openai-responses", "openai-codex-responses", "mistral-conversations"]
    .includes(plan.api);
  try {
    const listed = await requestOpenAiJson(plan.url, { headers: plan.headers, signal: AbortSignal.timeout(10_000) });
    const listing = plan.extract(listed.payload);
    const models = listing.map((model) => model.id);
    return {
      ok: true,
      api: plan.api,
      endpoint: plan.url,
      models: modelId && !models.includes(modelId) ? [modelId, ...models] : models,
      listing: modelId && !models.includes(modelId) ? [{ id: modelId, name: prettifyModelId(modelId) }, ...listing] : listing,
    };
  } catch (/** @type {any} */ error) {
    const status = error?.status;
    // 不少 OpenAI 兼容网关不实现 /models，404 时用一次最小对话请求探测真实性。
    if (status === 404 && modelId && openAiFamily) {
      try {
        await requestOpenAiJson(chatCompletionsUrl(baseUrl), {
          apiKey,
          signal: AbortSignal.timeout(15_000),
          payload: { model: modelId, messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
        });
        return { ok: true, api: plan.api, endpoint: chatCompletionsUrl(baseUrl), models: [modelId], listing: [{ id: modelId, name: prettifyModelId(modelId) }] };
      } catch (probeError) {
        return { ok: false, error: describeConnectionFailure(baseUrl, probeError) };
      }
    }
    return { ok: false, error: describeConnectionFailure(baseUrl, error) };
  }
}

function resolveModel(provider, modelId) {
  const exact = modelRuntime.getModel(provider, modelId);
  if (exact) {
    return exact;
  }

  const matches = modelRuntime.getModels(provider).find((model) =>
    model.id.toLowerCase() === modelId.toLowerCase() || String(model.name ?? "").toLowerCase() === modelId.toLowerCase(),
  );
  return matches ?? undefined;
}

function isUsableModel(model) {
  return Boolean(model && model.provider && model.id && model.provider !== "unknown" && model.id !== "unknown");
}

  return { currentDefaultModel, customModelsPayload, defaultComposerModel, deleteCustomModel, discoverProviderModels, findDefaultModel, isHttp429ProviderError, isUsableModel, listAvailableModels, providerCatalogRow, providerConfigBaseUrl, providerConfigValue, providerListingApi, providerRows, providerSupportsRuntimeListing, repairDefaultModelAfterRemoval, resolveModel, saveCustomModel, setModelConfiguration, streamModelLogin, testCustomModelConnection, updateProvider, usableDefaultModel };
}
