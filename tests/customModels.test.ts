/**
 * 自定义模型（`~/.pi/agent/models.json`）的读写规则。
 *
 * 这份文件是命令行 pi 和桥共用的唯一真相，所以测试盯的是三件事：
 *   1. 不认识的 provider / 字段必须原样保留（别人手写的配置不能被编辑器吃掉）；
 *   2. 表单校验的边界与桥自己的报错一致，坏输入不落盘；
 *   3. 加/删之后文件结构仍然合法，空 provider 不留僵尸。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  chatCompletionsUrl,
  describeConnectionFailure,
  describeTestFailure,
  emptyModelsConfig,
  findCustomModel,
  listCustomModels,
  listingPlan,
  mergeListingRows,
  modelsListUrl,
  normalizeBaseUrl,
  catalogSeedFromModel,
  normalizeCustomModelInput,
  normalizeCustomModelInputs,
  normalizeProviderCatalog,
  parseModelIds,
  parseModelListing,
  parseModelsConfig,
  prettifyModelId,
  providerIdFromName,
  removeCustomModel,
  requestModelListing,
  resolveListingApiKey,
  resolveProviderTarget,
  updateProviderSettings,
  upsertCustomModel,
  upsertCustomModels,
} from "../server/customModels.mjs";

const bailian = {
  name: "Bailian",
  baseUrl: "https://llm.example.com/compatible-mode/v1",
  api: "openai-completions",
  authHeader: true,
  compat: { thinkingFormat: "qwen" },
  models: [
    {
      id: "qwen3.7-plus",
      name: "Qwen3.7 Plus",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 8, cacheRead: 0.4, cacheWrite: 2.5 },
      contextWindow: 256000,
      maxTokens: 65536,
    },
  ],
};

/** 别人手写的配置：编辑器必须一个字节都不动它。 */
const handWritten = {
  providers: {
    bailian: bailian,
    "local-ollama": {
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      headers: { "x-team": "infra" },
      models: [{ id: "llama3", name: "Llama 3" }],
    },
  },
};

function draftInput(overrides = {}) {
  return normalizeCustomModelInput(
    {
      providerName: "我的百炼",
      baseUrl: "https://gateway.example.com/v1/",
      apiKey: "sk-test-123",
      model: "qwen3.8-flash",
      ...overrides,
    },
    { requireApiKey: true },
  );
}

/* ------------------------------------------------------------- 读取与解析 */

test("缺失/空文件按“还没有自定义模型”处理，而不是报错", () => {
  assert.deepEqual(parseModelsConfig(""), emptyModelsConfig());
  assert.deepEqual(parseModelsConfig("   "), { providers: {} });
});

test("models.json 里的注释被容忍（pi 自己也是这么读的）", () => {
  const config = parseModelsConfig(`{
    // 行注释
    "providers": { /* 块注释 */ "a": { "baseUrl": "https://a.dev/v1", "models": [] } }
  }`);
  assert.deepEqual(Object.keys(config.providers), ["a"]);
});

test("坏 JSON / 坏结构只报错，绝不返回空配置让人覆盖掉文件", () => {
  assert.throws(() => parseModelsConfig("{ not json", "~/.pi/agent/models.json"), /is not valid JSON/);
  assert.throws(() => parseModelsConfig("[]"), /must contain a top-level object/);
  assert.throws(() => parseModelsConfig('{"providers": []}'), /"providers" key in/);
  assert.throws(() => parseModelsConfig('{"providers": {"a": 1}}'), /The "a" provider in/);
});

test("列表按 provider × model 摊平，缺省字段补成默认值", () => {
  const entries = listCustomModels(handWritten);
  assert.deepEqual(
    entries.map((entry) => `${entry.providerId}/${entry.model}`),
    ["bailian/qwen3.7-plus", "local-ollama/llama3"],
  );

  const plus = entries[0];
  assert.equal(plus.providerName, "Bailian");
  assert.equal(plus.modelLabel, "Qwen3.7 Plus");
  assert.equal(plus.reasoning, true);
  assert.equal(plus.supportsImages, true);
  assert.equal(plus.contextWindow, 256000);

  // llama3 什么都没写：走默认值，且不算支持图片。
  const llama = entries[1];
  assert.equal(llama.contextWindow, 128_000);
  assert.equal(llama.maxTokens, 8_192);
  assert.equal(llama.reasoning, false);
  assert.equal(llama.supportsImages, false);
  assert.equal(llama.api, "openai-completions");
});

test("只有 modelOverrides 的条目列出来但标记为不可编辑", () => {
  const entries = listCustomModels({
    providers: { anthropic: { modelOverrides: { "claude-x": { name: "改名" } } } },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].managed, false);
  assert.equal(entries[0].model, "");
});

/* ------------------------------------------------------------------ 校验 */

test("归一化会整理地址、补展示名、把数字转成整数", () => {
  const entry = draftInput({ contextWindow: "200000.9", maxTokens: "" });
  assert.equal(entry.baseUrl, "https://gateway.example.com/v1");
  assert.equal(entry.model.name, "Qwen3.8 Flash");
  assert.equal(entry.model.contextWindow, 200000);
  assert.equal(entry.model.maxTokens, 8_192);
  assert.match(entry.providerId, /^model-/);
});

test("非 ASCII 的供应商名用稳定 hash 兜底，同名永远得到同一个 id", () => {
  const first = providerIdFromName("我的百炼");
  assert.match(first, /^model-[0-9a-z]{1,6}$/);
  assert.equal(providerIdFromName("我的百炼"), first);
  assert.equal(providerIdFromName("Bailian 国际站"), "bailian");
  assert.equal(providerIdFromName("Bailian", ["bailian"]), "bailian-2");
  // 内置目录里占用的名字不能拿来当自定义 provider id。
  assert.match(providerIdFromName("unknown"), /^model-/);
  assert.match(providerIdFromName("radius"), /^model-/);
});

for (const [name, input, expected] of [
  ["缺供应商名称", { providerName: "  " }, /Provider name is required/],
  ["缺 Base URL", { baseUrl: "" }, /Base URL/],
  ["非法 Base URL", { baseUrl: "gateway.example.com" }, /not a valid address/],
  ["非 http 协议", { baseUrl: "ftp://a.dev/v1" }, /must be http or https/],
  ["缺模型名称", { model: "  " }, /Model name is required/],
  ["模型名称含非法字符", { model: "qwen 3;rm" }, /may only contain letters/],
  ["上下文过小", { contextWindow: 10 }, /Context window/],
  ["最大输出超过上下文", { maxTokens: 999_999 }, /Max output/],
  ["新建时缺 API Key", { apiKey: "" }, /API key is required/],
] as const) {
  test(`校验拒绝：${name}`, () => {
    assert.throws(() => draftInput(input), expected);
  });
}

test("内置供应商没有 baseUrl：照样能加模型（Bedrock / Vertex 没端点）", () => {
  // 回归：以前 normalizeCustomModelInput 不管三七二十一先过 normalizeBaseUrl，
  // 目录行给不出地址的内置供应商就整家加不了模型（红框一句 Base URL is required.）。
  const entry = normalizeCustomModelInput(
    {
      providerName: "Amazon Bedrock",
      providerId: "amazon-bedrock",
      providerMode: "builtin",
      baseUrl: "",
      apiKey: "sk-test-123",
      model: "amazon.nova-2-lite-v1:0",
    },
    { requireApiKey: false },
  );
  assert.equal(entry.baseUrl, "");
  assert.equal(entry.providerMode, "builtin");
});

test("内置模式给了坏地址照样拦：空可以，错不行", () => {
  assert.throws(
    () => normalizeCustomModelInput(
      { providerName: "Amazon Bedrock", providerMode: "builtin", baseUrl: "ftp://a.dev", apiKey: "k", model: "m1" },
      { requireApiKey: false },
    ),
    /must be http or https/,
  );
});

test("自定义端点没 baseUrl 仍然必须报：不能把空地址当合法写进文件", () => {
  assert.throws(
    () => normalizeCustomModelInput({ providerName: "GW", baseUrl: "", apiKey: "k", model: "m1" }, { requireApiKey: true }),
    /Base URL is required/,
  );
});

test("往内置供应商里补行：不会因为没地址给自己造个 amazon-bedrock-2", () => {
  const config = {
    providers: {
      "amazon-bedrock": { name: "Amazon Bedrock", models: [{ id: "amazon.nova-lite-v1:0", name: "Nova Lite" }] },
    },
  };
  const entry = normalizeCustomModelInput(
    {
      providerName: "Amazon Bedrock",
      providerId: "amazon-bedrock",
      providerMode: "builtin",
      baseUrl: "",
      apiKey: "k",
      model: "amazon.nova-2-lite-v1:0",
      name: "Nova 2 Lite",
    },
    { requireApiKey: false },
  );
  const result = upsertCustomModel(config, entry);
  assert.equal(result.providerId, "amazon-bedrock");
  assert.deepEqual(result.config.providers["amazon-bedrock"].models.map((model) => model.id), [
    "amazon.nova-lite-v1:0",
    "amazon.nova-2-lite-v1:0",
  ]);
  // 内置供应商不落 provider 级 baseUrl：它会盖到该家每个模型上。
  assert.equal(result.config.providers["amazon-bedrock"].baseUrl, undefined);
});

test("编辑时留空 API Key 表示沿用已存的那份", () => {
  const entry = normalizeCustomModelInput(
    { providerName: "Bailian", baseUrl: "https://a.dev/v1", apiKey: "  ", model: "m1" },
    { hasStoredKey: true, requireApiKey: false },
  );
  assert.equal(entry.apiKey, "");
});

test("接受设置页发来的平铺字段（model 就是模型 id）", () => {
  const entry = normalizeCustomModelInput(
    {
      providerName: "Bailian",
      baseUrl: "https://a.dev/v1",
      apiKey: "sk-1",
      model: "gpt-x",
      name: "GPT X",
      contextWindow: "200000",
      maxTokens: "4096",
      reasoning: true,
      supportsImages: false,
    },
    { requireApiKey: true },
  );

  assert.equal(entry.model.id, "gpt-x");
  assert.equal(entry.model.name, "GPT X");
  assert.equal(entry.model.contextWindow, 200000);
  assert.equal(entry.model.maxTokens, 4096);
  assert.equal(entry.model.reasoning, true);
  assert.equal(entry.model.supportsImages, false, "false 不能被当成“没填”而掉回默认值");
});

test("normalizeBaseUrl 只裁掉多余的斜杠", () => {
  assert.equal(normalizeBaseUrl(" https://a.dev/v1/// "), "https://a.dev/v1");
});

/* ------------------------------------------------------------------ 写入 */

test("新增模型只动目标 provider，别人的 provider 与未知字段原样保留", () => {
  const before = structuredClone(handWritten);
  const entry = draftInput();
  const result = upsertCustomModel(handWritten, entry);

  assert.deepEqual(handWritten, before, "入参不能被就地修改");
  assert.equal(Object.keys(result.config.providers).length, 3);
  assert.deepEqual(result.config.providers.bailian, bailian);
  assert.deepEqual(result.config.providers["local-ollama"], before.providers["local-ollama"]);

  const created = result.config.providers[result.providerId];
  assert.equal(created.baseUrl, "https://gateway.example.com/v1");
  assert.equal(created.api, "openai-completions");
  assert.equal(created.authHeader, true);
  assert.equal(created.models[0].input.join(","), "text");
  assert.deepEqual(created.models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.ok(!("apiKey" in created), "key 不进 models.json");
});

test("同名的第二个模型并进同一个 provider", () => {
  const first = upsertCustomModel(emptyModelsConfig(), draftInput());
  const second = upsertCustomModel(first.config, draftInput({ model: "qwen3.8-max" }));

  assert.equal(second.providerId, first.providerId);
  assert.equal(Object.keys(second.config.providers).length, 1);
  assert.deepEqual(
    second.config.providers[first.providerId].models.map((model) => model.id),
    ["qwen3.8-flash", "qwen3.8-max"],
  );
});

test("同名但地址不同就是另一个供应商，不能覆盖别人的 baseUrl", () => {
  const first = upsertCustomModel(emptyModelsConfig(), draftInput());
  const second = upsertCustomModel(first.config, draftInput({ model: "other" , baseUrl: "https://elsewhere.dev/v1" }));

  assert.notEqual(second.providerId, first.providerId);
  assert.equal(first.config.providers[first.providerId].baseUrl, "https://gateway.example.com/v1");
  assert.equal(second.config.providers[second.providerId].baseUrl, "https://elsewhere.dev/v1");
});

test("编辑同一行：改模型 id 会换掉旧记录，并保留原 cost", () => {
  const created = upsertCustomModel(handWritten, draftInput(), {
    target: { providerId: "bailian", model: "qwen3.7-plus" },
  });

  assert.equal(created.providerId, "bailian");
  assert.equal(created.previousModelId, "qwen3.7-plus");
  const models = created.config.providers.bailian.models;
  assert.deepEqual(models.map((model) => model.id), ["qwen3.8-flash"]);
  assert.deepEqual(models[0].cost, bailian.models[0].cost, "价格不是表单字段，编辑时不该被清掉");
  assert.deepEqual(created.config.providers.bailian.compat, bailian.compat);
  assert.equal(created.config.providers.bailian.name, "我的百炼");
});

test("编辑时没改模型 id 就是原地替换", () => {
  const created = upsertCustomModel(handWritten, draftInput({ model: "qwen3.7-plus", providerName: "Bailian" }), {
    target: { providerId: "bailian", model: "qwen3.7-plus" },
  });
  const models = created.config.providers.bailian.models;
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "qwen3.7-plus");
  assert.equal(created.previousModelId, undefined);
});

test("findCustomModel 按 provider+model 定位，provider id 大小写不敏感", () => {
  assert.equal(findCustomModel(handWritten, "Bailian", "qwen3.7-plus")?.modelLabel, "Qwen3.7 Plus");
  assert.equal(findCustomModel(handWritten, "bailian", "nope"), undefined);
  assert.equal(findCustomModel(handWritten, "missing", "qwen3.7-plus"), undefined);
});

test("删除模型：provider 还有别的模型就留着，空了就整体删掉", () => {
  const two = upsertCustomModel(handWritten, draftInput({ providerName: "Bailian", baseUrl: bailian.baseUrl }));
  const models = two.config.providers.bailian.models;
  assert.equal(models.length, 2, "同名同地址就是往同一个供应商里加一行");

  const oneLeft = removeCustomModel(two.config, { providerId: "bailian", model: "qwen3.8-flash" });
  assert.equal(oneLeft.providerRemoved, false);
  assert.deepEqual(oneLeft.config.providers.bailian.models.map((model) => model.id), ["qwen3.7-plus"]);

  const noneLeft = removeCustomModel(oneLeft.config, { providerId: "bailian", model: "qwen3.7-plus" });
  assert.equal(noneLeft.providerRemoved, true);
  assert.ok(!("bailian" in noneLeft.config.providers));
  assert.ok("local-ollama" in noneLeft.config.providers);
});

test("删除不存在的模型报错而不是静默成功", () => {
  assert.throws(() => removeCustomModel(handWritten, { providerId: "nope", model: "x" }), /no longer there/);
  assert.throws(
    () => removeCustomModel(handWritten, { providerId: "bailian", model: "ghost" }),
    /no longer there/,
  );
});

test("加完再删回到原点", () => {
  const added = upsertCustomModel(handWritten, draftInput());
  const removed = removeCustomModel(added.config, { providerId: added.providerId, model: "qwen3.8-flash" });
  assert.deepEqual(removed.config, handWritten);
});

test("resolveProviderTarget 与 upsert 落在同一个 provider 上（决定要不要再问用户要 key）", () => {
  const sameEndpoint = draftInput({ providerName: "Bailian", baseUrl: bailian.baseUrl });
  assert.equal(resolveProviderTarget(handWritten, sameEndpoint, undefined).providerId, "bailian");
  assert.equal(upsertCustomModel(handWritten, sameEndpoint).providerId, "bailian");

  // 同名但地址不同 = 另一个供应商，不能借用 bailian 已存的 key。
  const other = draftInput({ providerName: "Bailian", baseUrl: "https://elsewhere.dev/v1" });
  const resolved = resolveProviderTarget(handWritten, other, undefined);
  assert.notEqual(resolved.providerId, "bailian");
  assert.equal(upsertCustomModel(handWritten, other).providerId, resolved.providerId);
});

/* ------------------------------------------------------------- 连接探测 */

test("OpenAI 兼容端点的两个地址", () => {
  assert.equal(modelsListUrl("https://a.dev/v1/"), "https://a.dev/v1/models");
  assert.equal(chatCompletionsUrl("https://a.dev/v1"), "https://a.dev/v1/chat/completions");
});

for (const [name, payload, expected] of [
  ["标准 data 包装", { data: [{ id: "a" }, { id: "b" }] }, ["a", "b"]],
  ["裸数组", ["a", "b"], ["a", "b"]],
  ["models 字段", { models: [{ name: "a" }] }, ["a"]],
  ["垃圾输入", null, []],
  ["缺 id 的条目被丢掉", { data: [{ name: "" }, { id: "x" }] }, ["x"]],
] as const) {
  test(`parseModelIds：${name}`, () => {
    assert.deepEqual(parseModelIds(payload), expected);
  });
}

test("探测失败时给出人能照做的文案，401 不写成 404", () => {
  assert.match(describeTestFailure(401, ""), /Authentication failed/);
  assert.match(describeTestFailure(403, ""), /Authentication failed/);
  assert.match(describeTestFailure(404, ""), /\/v1/);
  assert.equal(describeTestFailure(500, "upstream exploded"), "upstream exploded");
  // 404 的报错体是一段 JSON：贴原文等于没说。要把 message 挑出来，同时留住 /v1 那条提示。
  assert.equal(
    describeTestFailure(404, JSON.stringify({ error: { message: "no such route" } })),
    'The endpoint returned no model list (404): no such route. Check whether the Base URL should end with /v1.',
  );
  // 报体不是合法 JSON：原文贴回去也比什么都没有强
  assert.equal(
    describeTestFailure(404, "{ not json"),
    "The endpoint returned no model list (404): { not json. Check whether the Base URL should end with /v1.",
  );
  // 非 JSON 的短原文照旧直接给
  assert.equal(describeTestFailure(400, "bad gateway"), "bad gateway");
});

test("没连上时报“访问不了哪里”，而不是 fetch failed", () => {
  const dns = Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND a.dev") });
  assert.equal(describeConnectionFailure("https://a.dev/v1", dns), "Cannot reach a.dev: getaddrinfo ENOTFOUND a.dev");

  assert.match(describeConnectionFailure("https://a.dev/v1", { name: "TimeoutError" }), /Connection to a\.dev timed out/);
  // 带状态码的交给 describeTestFailure，别把 HTTP 错说成网络错。
  assert.match(describeConnectionFailure("https://a.dev/v1", { status: 401, body: "bad key" }), /Authentication failed/);
  // 地址本身不合法时也不能抛。
  assert.match(describeConnectionFailure("not a url", new Error("boom")), /not a url/);
});

test("prettifyModelId 只按分隔符断词", () => {
  assert.equal(prettifyModelId("qwen3.7-plus"), "Qwen3.7 Plus");
  assert.equal(prettifyModelId("gpt-4o_mini"), "Gpt 4o Mini");
  assert.equal(prettifyModelId(""), "");
});

/* ----------------------------------------------- 批量添加 / 内置供应商 */

const catalogModel = (id, extra = {}) => ({ model: { id, name: `Cat ${id}`, api: "openai-completions", ...extra } });

test("批量：一次把多个模型写进同一个 provider，重复勾选只留一条", () => {
  const entries = normalizeCustomModelInputs({
    providerName: "Bailian",
    baseUrl: bailian.baseUrl,
    models: [catalogModel("qwen-a"), catalogModel("qwen-b"), catalogModel("qwen-a")],
  }, { requireApiKey: false });
  assert.deepEqual(entries.map((entry) => entry.model.id), ["qwen-a", "qwen-b"]);

  const result = upsertCustomModels(handWritten, entries);
  assert.deepEqual(result.providerIds, ["bailian"]);
  assert.deepEqual(result.models, ["qwen-a", "qwen-b"]);
  assert.deepEqual(
    result.config.providers.bailian.models.map((model) => model.id),
    ["qwen3.7-plus", "qwen-a", "qwen-b"],
  );
  // 其余 provider 一个字节都不动。
  assert.deepEqual(result.config.providers["local-ollama"], handWritten.providers["local-ollama"]);
});

test("内置供应商：只补模型行，不写 baseUrl/api/authHeader", () => {
  // models.json 的 provider baseUrl 会盖到该 provider 的每个模型上，一家多地址
  // （xai / azure）会被改坏；鉴权也该由内置 provider 自己决定。
  const [entry] = normalizeCustomModelInputs({
    providerName: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    providerMode: "builtin",
    models: [{ model: { id: "claude-x", name: "Claude X", api: "anthropic-messages" } }],
  }, { requireApiKey: false });
  const { config } = upsertCustomModels(emptyModelsConfig(), [entry]);
  const provider = config.providers.anthropic;
  assert.equal(provider.baseUrl, undefined);
  assert.equal(provider.api, undefined);
  assert.equal(provider.authHeader, undefined);
  assert.equal(provider.name, "Anthropic");
  assert.deepEqual(provider.models[0], {
    id: "claude-x",
    name: "Claude X",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    api: "anthropic-messages",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
});

test("写内置模型必须整条抄目录：cost / compat / thinkingLevelMap 一个都不能漏", () => {
  // models.json 的模型行是最高一层，pi 只从目录补 api/baseUrl，其余用文件里的值或硬编码兜底。
  // 漏写 cost 会把 Claude 标成免费，漏写 compat/thinkingLevelMap 会丢掉思考等级映射和严格工具。
  const seed = catalogSeedFromModel({
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5 (latest)",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    compat: { supportsStrictTools: true },
    thinkingLevelMap: { off: null, max: "max" },
    contextWindow: 1000000,
    maxTokens: 64000,
  });
  assert.equal(seed.provider, undefined, "runtime 内部字段不能进文件");
  assert.equal(seed.id, undefined);

  const [entry] = normalizeCustomModelInputs({
    providerName: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    providerMode: "builtin",
    models: [{ model: { id: "claude-sonnet-4-5" } }],
  }, { requireApiKey: false });
  const { config } = upsertCustomModels(emptyModelsConfig(), [entry], { seeds: { "claude-sonnet-4-5": seed } });
  assert.deepEqual(config.providers.anthropic.models[0], {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 (latest)",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    compat: { supportsStrictTools: true },
    thinkingLevelMap: { off: null, max: "max" },
    contextWindow: 1000000,
    maxTokens: 64000,
  });
});

test("用户显式给的字段盖在目录之上，没给的沿用目录", () => {
  const seed = catalogSeedFromModel({
    id: "m", name: "目录名", api: "openai-completions", baseUrl: "https://seed.dev/v1",
    contextWindow: 400000, maxTokens: 8000, reasoning: true, input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  });
  const [entry] = normalizeCustomModelInputs({
    providerName: "Seed", baseUrl: "https://seed.dev/v1", providerMode: "builtin",
    models: [{ model: { id: "m", name: "我自己起的名字", contextWindow: 128000 } }],
  }, { requireApiKey: false });
  const model = upsertCustomModels(emptyModelsConfig(), [entry], { seeds: { m: seed } }).config.providers.seed.models[0];
  assert.equal(model.name, "我自己起的名字");
  assert.equal(model.contextWindow, 128000);
  assert.equal(model.maxTokens, 8000, "没改的字段不能被默认值 8192 盖掉");
  assert.equal(model.reasoning, true, "没勾的开关不能倒回 false");
  assert.deepEqual(model.cost, seed.cost);
});

test("编辑已有行时，文件里原有的值优先于目录", () => {
  const seeded = catalogSeedFromModel({ id: "m", name: "目录名", api: "openai-completions", baseUrl: "https://seed.dev/v1", contextWindow: 400000, maxTokens: 8000, cost: { input: 7, output: 8, cacheRead: 1, cacheWrite: 2 } });
  const first = normalizeCustomModelInputs({
    providerName: "Seed", baseUrl: "https://seed.dev/v1", providerMode: "builtin",
    models: [{ model: { id: "m", name: "手改的名" } }],
  }, { requireApiKey: false });
  const config = upsertCustomModels(emptyModelsConfig(), first, { seeds: { m: seeded } }).config;

  const second = normalizeCustomModelInputs({
    providerName: "Seed", baseUrl: "https://seed.dev/v1", providerMode: "builtin",
    models: [{ model: { id: "m" } }],
  }, { requireApiKey: false });
  const again = upsertCustomModels(config, second, { seeds: { m: seeded } }).config.providers.seed.models[0];
  assert.equal(again.name, "手改的名", "第二次保存不该把用户改过的展示名冲掉");
  assert.deepEqual(again.cost, seeded.cost);
});

test("批量往内置供应商里加：第二条不能变成 anthropic-2", () => {
  // 内置 provider 在文件里没有 baseUrl（写了会盖到该家所有模型上），第二条只能按 id 认。
  const builtinEntries = (ids) => normalizeCustomModelInputs({
    providerName: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    providerMode: "builtin",
    models: ids.map((id) => ({ model: { id, name: id, api: "anthropic-messages" } })),
  }, { requireApiKey: false });
  const { config } = upsertCustomModels(emptyModelsConfig(), builtinEntries(["claude-a", "claude-b", "claude-c"]));
  assert.deepEqual(Object.keys(config.providers), ["anthropic"]);
  assert.deepEqual(config.providers.anthropic.models.map((model) => model.id), ["claude-a", "claude-b", "claude-c"]);

  // 自定义端点没这个豁免：同名不同地址仍然是两家。
  const clash = normalizeCustomModelInputs({
    providerName: "Anthropic",
    baseUrl: "https://proxy.example.com/v1",
    models: [{ model: "x" }],
  }, { requireApiKey: false });
  assert.notEqual(upsertCustomModels(emptyModelsConfig(), [...builtinEntries(["claude-a"]), ...clash]).providerIds.length, 1);
});

test("自定义端点仍然写全 baseUrl/api/authHeader 并补零价", () => {
  const [entry] = normalizeCustomModelInputs({
    providerName: "My Gateway",
    baseUrl: "https://gw.example.com/v1/",
    models: [{ model: "chat-large" }],
  }, { requireApiKey: false });
  const { config } = upsertCustomModels(emptyModelsConfig(), [entry]);
  const provider = config.providers["my-gateway"];
  assert.equal(provider.baseUrl, "https://gw.example.com/v1");
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.authHeader, true);
  assert.deepEqual(provider.models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(provider.models[0].name, "Chat Large");
});

test("脏 api / 脏 baseUrl 不进模型行，别让整个 models.json 加载失败", () => {
  const [entry] = normalizeCustomModelInputs({
    providerName: "X",
    baseUrl: "https://x.dev/v1",
    models: [{ model: { id: "m", api: "HTTP GET; rm -rf", baseUrl: "javascript:alert(1)" } }],
  }, { requireApiKey: false });
  const { config } = upsertCustomModels(emptyModelsConfig(), [entry]);
  const model = config.providers.x.models[0];
  assert.equal(model.api, undefined);
  assert.equal(model.baseUrl, undefined);
});

test("批量条数有上限，超了整批拒绝（不落半批）", () => {
  const models = Array.from({ length: 41 }, (_, index) => ({ model: `m-${index}` }));
  assert.throws(
    () => normalizeCustomModelInputs({ providerName: "X", baseUrl: "https://x.dev/v1", models }, { requireApiKey: false }),
    /at most/,
  );
});

test("单条编辑仍然走同一套：批量入口只有一条时等价于旧行为", () => {
  const [entry] = normalizeCustomModelInputs({
    providerName: "Bailian",
    baseUrl: bailian.baseUrl,
    models: [{ model: { id: "qwen3.7-plus", name: "Qwen3.7 Plus", contextWindow: 128000, maxTokens: 4096 } }],
  }, { requireApiKey: false });
  const batched = upsertCustomModels(handWritten, [entry], {
    target: { providerId: "bailian", model: "qwen3.7-plus" },
  });
  const single = upsertCustomModel(handWritten, entry, {
    target: { providerId: "bailian", model: "qwen3.7-plus" },
  });
  assert.deepEqual(batched.config, single.config);
});

/* ------------------------------------------------------ provider 目录 */

test("provider 目录：脏模型丢掉、按名字排序、默认不带列表", () => {
  const rows = normalizeProviderCatalog([
    { id: "zeta", name: "Zeta", baseUrl: "https://z.dev", modelCount: 77, models: [{ id: "ok-1" }, { id: "bad id!" }, { id: "" }] },
    { id: "alpha", name: "Alpha", models: [{ id: "a", contextWindow: 0, maxTokens: -1, input: ["text", "image"], reasoning: true }] },
    { id: "  ", name: "没人要", models: [] },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ["alpha", "zeta"]);
  // 没展开列表时数量听调用方的（runtime 目录里数出来的），展开了才按实际算。
  assert.deepEqual(rows.map((row) => row.modelCount), [1, 77]);
  assert.deepEqual(rows.map((row) => row.builtin), [false, false]);
  assert.deepEqual(rows.map((row) => row.authMethods), [[], []]);
  assert.equal(rows[0].models, undefined);
  assert.equal(rows[0].authKind, "none");
  assert.equal(rows[0].name, "Alpha");

test("供应商目录归一化不透出 key：列表口再怎么改都带不出明文", () => {
  const row = normalizeProviderCatalog([{ id: "alpha", name: "Alpha", apiKey: "sk-secret", authConfigured: true }])[0];
  assert.equal(row.apiKey, undefined);
  assert.equal("apiKey" in row, false);
});

  const detailed = normalizeProviderCatalog(
    [{ id: "alpha", name: "Alpha", authConfigured: true, models: [{ id: "a", contextWindow: 0, maxTokens: -1, input: ["text", "image"], reasoning: true }] }],
    { withModels: true },
  )[0];
  assert.deepEqual(detailed.models, [{
    id: "a",
    name: "A",
    api: "",
    baseUrl: "",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: true,
    supportsImages: true,
  }]);
  assert.equal(detailed.authKind, "api_key");
});

/* ------------------------------------------------- 按 api 类型取模型列表 */

test("listingPlan：Anthropic 用 x-api-key + /v1/models，不带 Bearer", () => {
  const plan = listingPlan("anthropic-messages", "https://gw.example.com", "sk-ant-x");
  assert.equal(plan.url, "https://gw.example.com/v1/models");
  assert.equal(plan.headers["x-api-key"], "sk-ant-x");
  assert.equal(plan.headers["anthropic-version"], "2023-06-01");
  assert.equal(plan.headers.authorization, undefined);
});

test("listingPlan：base 里已经带了版本段就不重复拼", () => {
  assert.equal(listingPlan("anthropic-messages", "https://gw.example.com/v1", "k").url, "https://gw.example.com/v1/models");
  assert.equal(
    listingPlan("google-generative-ai", "https://generativelanguage.googleapis.com/v1beta", "k").url,
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  assert.equal(listingPlan("openai-completions", "https://gw.example.com/v1/", "k").url, "https://gw.example.com/v1/models");
});

test("listingPlan：Google 用 x-goog-api-key，OpenAI 家族用 Bearer，留空按 openai-completions", () => {
  assert.deepEqual(listingPlan("google-generative-ai", "https://a.dev", "k").headers, { "x-goog-api-key": "k" });
  assert.deepEqual(listingPlan("", "https://a.dev", "k").headers, { authorization: "Bearer k" });
  // 没 key：一个鉴权头都别发。`Bearer ` 这种空头会被严一点的网关直接 400，看着像“拉不到列表”。
  assert.deepEqual(listingPlan("", "https://a.dev", "").headers, {});
  assert.deepEqual(listingPlan("anthropic-messages", "https://a.dev", "").headers, {});
  assert.deepEqual(listingPlan("google-generative-ai", "https://a.dev", "  ").headers, {});
  assert.deepEqual(listingPlan("anthropic-messages", "https://a.dev", "k").headers["x-api-key"], "k");
  assert.equal(listingPlan("", "https://a.dev", "k").url, "https://a.dev/models");
  assert.equal(listingPlan("mistral-conversations", "https://a.dev/v1", "k").url, "https://a.dev/v1/models");
});

test("listingPlan：拿不了列表的类型说清楚为什么，而不是硬打一个 404", () => {
  for (const [api, needle] of [
    ["bedrock-converse-stream", /SigV4/],
    ["google-vertex", /ADC/],
    ["azure-openai-responses", /api-version/],
    ["totally-made-up", /not supported/],
  ]) {
    const plan = listingPlan(api, "https://a.dev", "k");
    assert.ok(plan.unsupported, `${api} 应该标成不支持`);
    assert.match(plan.unsupported, needle);
  }
});

test("parseModelListing：Anthropic 的 display_name 当展示名", () => {
  const models = parseModelListing({ data: [
    { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", type: "model" },
  ] }, "anthropic-messages");
  assert.deepEqual(models.map((model) => [model.id, model.name]), [["claude-sonnet-4-5", "Claude Sonnet 4.5"]]);
});

test("parseModelListing：Google 去掉 models/ 前缀、带上 token 限制、滤掉不能对话的资源", () => {
  const models = parseModelListing({ models: [
    { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 1048576,
      outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
    { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemini-2.5-flash", inputTypes: ["TEXT", "IMAGE"],
      supportedGenerationMethods: ["streamGenerateContent"] },
  ] }, "google-generative-ai");
  assert.deepEqual(models.map((model) => model.id), ["gemini-2.5-pro", "gemini-2.5-flash"]);
  assert.equal(models[0].contextWindow, 1048576);
  assert.equal(models[0].maxTokens, 65536);
  assert.equal(models[0].name, "Gemini 2.5 Pro");
  assert.deepEqual(models[1].input, ["text", "image"]);
});

test("parseModelListing：OpenAI 兼容网关顺手带的 context_window/max_tokens 也收下", () => {
  const models = parseModelListing({ data: [
    { id: "qwen3.7-plus", context_window: 131072, max_tokens: 8192 },
    { id: "bad id", context_window: 1 },
    { id: "qwen3.7-plus" },
  ] });
  assert.deepEqual(models.map((model) => model.id), ["qwen3.7-plus"], "非法 id 与重复项都不该进来");
  assert.equal(models[0].contextWindow, 131072);
  assert.equal(models[0].maxTokens, 8192);
  assert.equal(models[0].name, "Qwen3.7 Plus");
});

test("parseModelListing：空响应/怪响应不炸，摊成空列表", () => {
  for (const payload of [undefined, null, {}, [], "string", { data: {} }]) {
    assert.deepEqual(parseModelListing(payload), []);
  }
});

/* ------------------------------------------- 端点实时列表（自定义 provider） */

/** 假 fetch：记下被调用的请求，返回预设响应。 */
function fakeFetch(response, calls = []) {
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => (typeof response.body === "string" ? response.body : JSON.stringify(response.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const liveFetchBase = "https://llm.example.com/compatible-mode/v1";

test("requestModelListing：自定义 provider 按 api 类型 GET 列表端点，带 Bearer", async () => {
  const calls = [];
  const result = await requestModelListing({
    api: "openai-completions",
    baseUrl: liveFetchBase,
    apiKey: "sk-test-123",
    fetchImpl: fakeFetch({ status: 200, body: { data: [{ id: "qwen3.8-max" }, { id: "kimi-k3" }] } }, calls),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((model) => model.id), ["qwen3.8-max", "kimi-k3"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${liveFetchBase}/models`);
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-test-123");
});

test("requestModelListing：没 key / 拿不了列表的类型都不硬发请求", async () => {
  const noKey = fakeFetch({ status: 200, body: { data: [] } });
  const noKeyCalls = [];
  const missing = await requestModelListing({
    api: "openai-completions", baseUrl: liveFetchBase, apiKey: "", fetchImpl: ((...a) => noKey(...a)),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /API key/i);

  const calls = [];
  const unsupported = await requestModelListing({
    api: "bedrock-converse-stream", baseUrl: liveFetchBase, apiKey: "sk-test-123",
    fetchImpl: fakeFetch({ status: 200, body: { data: [] } }, calls),
  });
  assert.equal(unsupported.ok, false);
  assert.equal(calls.length, 0, "不支持列表的类型不该去打网络");
});

test("requestModelListing：没地址时兑成 {ok:false}，不把异常抛成 500", async () => {
  // listingPlan 里的 normalizeBaseUrl 会抛；以前这个抛直接冲出路由，
  // 前端红框里就是一整串 {"error":"Base URL is required."}。
  const calls = [];
  const result = await requestModelListing({
    api: "openai-completions",
    baseUrl: "",
    apiKey: "sk-test-123",
    fetchImpl: fakeFetch({ status: 200, body: { data: [] } }, calls),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Base URL is required/);
  assert.equal(calls.length, 0, "没地址就不该发请求");
});

test("requestModelListing：401/404/非 JSON/空列表都说清原因，不假装成功", async () => {
  const unauthorized = await requestModelListing({
    baseUrl: liveFetchBase, apiKey: "sk-x",
    fetchImpl: fakeFetch({ status: 401, body: { error: "bad key" } }),
  });
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.error, /Authentication failed/);

  const notFound = await requestModelListing({
    baseUrl: liveFetchBase, apiKey: "sk-x",
    fetchImpl: fakeFetch({ status: 404, body: "nope" }),
  });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.status, 404);

  const garbage = await requestModelListing({
    baseUrl: liveFetchBase, apiKey: "sk-x",
    fetchImpl: fakeFetch({ status: 200, body: "<html>proxy said</html>" }),
  });
  assert.equal(garbage.ok, false);
  assert.match(garbage.error, /JSON/);

  const empty = await requestModelListing({
    baseUrl: liveFetchBase, apiKey: "sk-x",
    fetchImpl: fakeFetch({ status: 200, body: { data: [] } }),
  });
  assert.equal(empty.ok, false, "空列表是“没拿到”，不是“这个端点只有这些”");
});

test("requestModelListing：连不上时给“访问不了哪里”，不是 fetch failed", async () => {
  const result = await requestModelListing({
    baseUrl: liveFetchBase, apiKey: "sk-x",
    fetchImpl: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /llm.example.com/);
});

test("mergeListingRows：端点列表 + 文件里已存的行合并，重复项以端点为准", () => {
  const rows = mergeListingRows({
    listing: [
      { id: "qwen3.8-max", name: "Qwen3.8 Max", contextWindow: 0, maxTokens: 0, input: ["text"] },
      { id: "kimi-k3", name: "Kimi K3", contextWindow: 262144, maxTokens: 32768, input: ["text", "image"] },
    ],
    localModels: [{
      id: "qwen3.7-plus", name: "Qwen3.7 Plus", api: "openai-completions", baseUrl: liveFetchBase,
      contextWindow: 256000, maxTokens: 65536, reasoning: true, supportsImages: true,
    }, {
      id: "qwen3.8-max", name: "旧名字", contextWindow: 128000, maxTokens: 8192, reasoning: false, supportsImages: false,
    }],
    api: "openai-completions",
    baseUrl: liveFetchBase,
  });
  assert.deepEqual(rows.map((row) => row.id), ["kimi-k3", "qwen3.7-plus", "qwen3.8-max"], "按 id 排，顺序不随供应商变");
  // 端点没报数值 → 本地手调过的值优先，不能把 256k 冲成默认 128k
  assert.deepEqual(
    rows.find((row) => row.id === "qwen3.7-plus").contextWindow, 256000,
  );
  const overlap = rows.find((row) => row.id === "qwen3.8-max");
  assert.equal(overlap.name, "Qwen3.8 Max", "同 id 以端点报的名字为准");
  assert.equal(overlap.contextWindow, 128000, "端点没报上下文时保留本地值，而不是盖成默认");
  assert.equal(overlap.reasoning, false);
  assert.equal(rows.find((row) => row.id === "kimi-k3").supportsImages, true);
  assert.ok(rows.every((row) => row.api === "openai-completions" && row.baseUrl === liveFetchBase));
});

test("mergeListingRows：脏 id 丢掉、空输入也不炸", () => {
  assert.deepEqual(mergeListingRows({ listing: [{ id: "bad id" }, { id: "" }, null], localModels: undefined }), []);
  assert.deepEqual(mergeListingRows({}), []);
  const onlyLocal = mergeListingRows({ listing: [], localModels: [{ id: "llama3" }] });
  assert.deepEqual(onlyLocal.map((row) => row.id), ["llama3"]);
  assert.equal(onlyLocal[0].contextWindow, DEFAULT_CONTEXT_WINDOW, "两边都没给时补默认值，别让表单里出现 0");
});

/* ------------------------------------------------------------- 编辑 provider */

test("编辑 provider：改名字/端点/api 只动这一家，别人的配置一个字节都不碰", () => {
  const config = { providers: JSON.parse(JSON.stringify(handWritten.providers)) };
  const result = updateProviderSettings(config, {
    providerId: "bailian",
    name: "我的百炼",
    baseUrl: "https://new.example.com/v1/",
    api: "openai-responses",
  });
  const provider = result.config.providers.bailian;
  assert.equal(provider.name, "我的百炼");
  assert.equal(provider.baseUrl, "https://new.example.com/v1", "尾斜杠要被裁掉");
  assert.equal(provider.api, "openai-responses");
  // 没让改的字段（compat/authHeader）与另一家 provider 原样留着
  assert.deepEqual(provider.compat, bailian.compat);
  assert.equal(provider.authHeader, true);
  assert.deepEqual(result.config.providers["local-ollama"], handWritten.providers["local-ollama"]);
  assert.deepEqual(result.config.providers.bailian.models, bailian.models, "编辑 provider 不该动模型行");
});

test("编辑 provider：模型行里显式写了 baseUrl/api 的必须跟着改，没写的别凭空补", () => {
  const config = {
    providers: {
      gateway: {
        name: "Gateway",
        baseUrl: "https://old.example.com/v1",
        api: "openai-completions",
        models: [
          { id: "explicit", api: "openai-completions", baseUrl: "https://old.example.com/v1" },
          { id: "inherits" },
        ],
      },
    },
  };
  const provider = updateProviderSettings(config, {
    providerId: "gateway",
    name: "Gateway",
    baseUrl: "https://new.example.com/v1",
  }).config.providers.gateway;
  assert.equal(provider.baseUrl, "https://new.example.com/v1");
  assert.equal(provider.api, "openai-completions", "没传 api 就保留原值");
  assert.deepEqual(
    provider.models.find((model) => model.id === "explicit"),
    { id: "explicit", api: "openai-completions", baseUrl: "https://new.example.com/v1" },
    "行级 baseUrl 会盖过 provider 级（pi 是 definition.baseUrl 优先），不跟着改就是继续打老地址",
  );
  assert.deepEqual(provider.models.find((model) => model.id === "inherits"), { id: "inherits" });
});

test("编辑 provider：脏 api 不落盘（脏值会让整个 models.json 加载失败）", () => {
  const config = { providers: { bailian: JSON.parse(JSON.stringify(bailian)) } };
  const provider = updateProviderSettings(config, {
    providerId: "bailian",
    name: "Bailian",
    baseUrl: "https://x.example.com/v1",
    api: "not an api!!",
  }).config.providers.bailian;
  assert.equal(provider.api, bailian.api, "非法 api 当没改，而不是写进去炸掉 pi 的 schema 校验");
});

test("编辑 provider：不存在的供应商 / 空名字 / 坏地址都报错，不静默成功", () => {
  const config = { providers: { bailian: JSON.parse(JSON.stringify(bailian)) } };
  assert.throws(() => updateProviderSettings(config, { providerId: "nope", name: "X", baseUrl: "https://x.dev/v1" }), /no longer there/);
  assert.throws(() => updateProviderSettings(config, { providerId: "bailian", name: "  ", baseUrl: "https://x.dev/v1" }), /name is required/);
  assert.throws(() => updateProviderSettings(config, { providerId: "bailian", name: "Bailian", baseUrl: "ftp://x.dev" }), /http or https/);
  assert.throws(() => updateProviderSettings(config, { providerId: "bailian", name: "Bailian", baseUrl: "" }), /Base URL is required/);
});

test("编辑 provider：provider id 大小写不敏感，改完也不会多出一个新 provider", () => {
  const config = { providers: { bailian: JSON.parse(JSON.stringify(bailian)) } };
  const result = updateProviderSettings(config, {
    providerId: "BaiLian",
    name: "Bailian 2",
    baseUrl: "https://y.example.com/v1",
  });
  assert.deepEqual(Object.keys(result.config.providers), ["bailian"], "不能因为大小写写错就复制出一家");
  assert.equal(result.providerId, "bailian");
  assert.equal(result.config.providers.bailian.name, "Bailian 2");
});

test("resolveListingApiKey：这一轮填的优先，留空才退到已存的那份", () => {
  assert.equal(resolveListingApiKey({ apiKey: " sk-a ", storedKey: "sk-b" }), "sk-a");
  assert.equal(resolveListingApiKey({ apiKey: "", storedKey: "sk-b" }), "sk-b");
  assert.equal(resolveListingApiKey({ apiKey: "   ", storedKey: "sk-b" }), "sk-b", "只有空白也算没填");
  assert.equal(resolveListingApiKey({}), "");
});

/* --------------------------------------------------------- 思考档位(编辑弹窗) */

test("思考档位:选档写映射表并自动开 effort,换档整表重写", () => {
  const created = draftInput({ model: "m1", reasoning: true, thinkingLevels: ["low"] });
  const first = upsertCustomModel(emptyModelsConfig(), created);
  const pid = first.providerId;
  let row = findCustomModel(first.config, pid, "m1");
  assert.deepEqual(row.thinkingLevels, ["low"], "列表按 pi 档位顺序回传选中的档");
  const rawRow = first.config.providers[pid].models[0];
  assert.equal(rawRow.thinkingLevelMap.low, "low");
  assert.equal(rawRow.thinkingLevelMap.off, null, "没勾的档必须显式写成 null(否则 pi 默认放行基础档)");
  assert.equal(rawRow.compat.supportsReasoningEffort, true, "选了非 off 档位要自动开强度参数");

  const edited = draftInput({
    providerId: pid,
    model: "m1",
    reasoning: true,
    thinkingLevels: ["high", "max"],
  });
  const second = upsertCustomModel(first.config, edited, { target: { providerId: pid, model: "m1" } });
  row = findCustomModel(second.config, pid, "m1");
  assert.deepEqual(row.thinkingLevels, ["high", "max"], "换档后整表重写,回传新选的档");
  assert.deepEqual(second.config.providers[pid].models[0].thinkingLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  });
});

test("思考档位:空选=清除映射;不给字段=保留原值;非法档报错", () => {
  let current = upsertCustomModel(emptyModelsConfig(), draftInput({ model: "m1", reasoning: true, thinkingLevels: ["low"] }));
  const pid = current.providerId;

  // 空数组 = 明确清掉映射表，退回 pi 默认
  current = upsertCustomModel(
    current.config,
    draftInput({ providerId: pid, model: "m1", reasoning: true, thinkingLevels: [] }),
    { target: { providerId: pid, model: "m1" } },
  ).config;
  assert.equal(
    "thinkingLevelMap" in current.providers[pid].models[0],
    false,
    "空选必须清掉旧映射表(文件里不留空表)",
  );
  // 清掉映射表 ≠ 选择器隐藏：pi 对「开了推理但没写映射表」的模型给的是默认基础档
  // (off..high 未声明 = 按默认映射放行)，所以描述层必须回传这五档，不能回传 []。
  assert.deepEqual(
    findCustomModel(current, pid, "m1").thinkingLevels,
    ["off", "minimal", "low", "medium", "high"],
    "没映射表时按 pi 的默认档位回传(而不是空)",
  );

  // 不给 thinkingLevels 字段 = 不碰档位配置(留文件/目录原值)
  current = upsertCustomModel(
    current.config,
    draftInput({ providerId: pid, model: "m1", reasoning: true, thinkingLevels: ["low"] }),
    { target: { providerId: pid, model: "m1" } },
  ).config;
  current = upsertCustomModel(
    current,
    draftInput({ providerId: pid, model: "m1", reasoning: true }),
    { target: { providerId: pid, model: "m1" } },
  ).config;
  assert.deepEqual(
    current.providers[pid].models[0].thinkingLevelMap,
    { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null },
    "字段缺失时不能动已有映射表",
  );

  assert.throws(
    () => draftInput({ model: "m2", reasoning: true, thinkingLevels: ["bogus"] }),
    /Unknown thinking levels/,
  );
});

/* ------------------------------------------- 思考档位映射(编辑器三态写法) */

/** 编辑器发的是逐档三态：不支持(null) / 留空(未声明) / 填值(发给端点的 effort)。 */
function mapDraft(overrides = {}) {
  return draftInput({ model: "m1", reasoning: true, ...overrides });
}

test("档位映射:填值就是发的值，留空 = 该档不存在", () => {
  const saved = upsertCustomModel(emptyModelsConfig(), mapDraft({
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: "xhigh", max: null },
  }));
  const pid = saved.providerId;
  const raw = saved.config.providers[pid].models[0].thinkingLevelMap;
  assert.deepEqual(raw, { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: "xhigh", max: null });
  assert.equal(saved.config.providers[pid].models[0].compat.supportsReasoningEffort, true, "有非 off 档位就自动开强度参数");
  assert.deepEqual(
    findCustomModel(saved.config, pid, "m1").thinkingLevels,
    ["low", "xhigh"],
    "composer 菜单 = 映射里非 null 的档位",
  );

  // 编辑器回填的表是七档全给的（这里给的本来就是全表，null 原样保留）
  assert.deepEqual(listCustomModels(saved.config).find((e) => e.model === "m1").thinkingLevelMap, {
    off: null, minimal: null, low: "low", medium: null, high: null, xhigh: "xhigh", max: null,
  });
  // 把手写的「未声明」摊平后原样写回：行为不变（pi 原本就按同名放行 off..high）
  const partial = upsertCustomModel(emptyModelsConfig(), mapDraft({
    model: "m2",
    thinkingLevelMap: { high: "xhigh" },
  }));
  assert.deepEqual(findCustomModel(partial.config, partial.providerId, "m2").thinkingLevels,
    ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(listCustomModels(partial.config).find((e) => e.model === "m2").thinkingLevelMap, {
    off: "off", minimal: "minimal", low: "low", medium: "medium", high: "xhigh", xhigh: null, max: null,
  });
});

test("档位映射:高→xhigh 这种改名映射往返编辑不丢(语义不变)", () => {
  const first = upsertCustomModel(emptyModelsConfig(), mapDraft({
    model: "qwen3.8-max",
    thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null },
  }));
  const pid = first.providerId;

  // 复刻编辑器的一次保存：回填桥下发的表 → 用户没动 → 原样写回。
  const entry = listCustomModels(first.config).find((e) => e.model === "qwen3.8-max");
  const second = upsertCustomModel(
    first.config,
    mapDraft({ providerId: pid, model: "qwen3.8-max", thinkingLevelMap: entry.thinkingLevelMap }),
    { target: { providerId: pid, model: "qwen3.8-max" } },
  );
  assert.equal(second.config.providers[pid].models[0].thinkingLevelMap.high, null, "high 仍然是不存在");
  assert.equal(second.config.providers[pid].models[0].thinkingLevelMap.xhigh, "xhigh", "换名映射保留");
  assert.deepEqual(
    findCustomModel(second.config, pid, "qwen3.8-max").thinkingLevels,
    ["off", "low", "medium", "xhigh"],
    "往返编辑后 composer 档位不变（off 原本就默认放行，现在显式写成同名）",
  );
});

test("档位映射:全部留空 = 该模型没有思考档位", () => {
  const cleared = upsertCustomModel(emptyModelsConfig(), mapDraft({
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
  }));
  assert.deepEqual(findCustomModel(cleared.config, cleared.providerId, "m1").thinkingLevels, [], "一档都不显示");
});

test("档位映射:空对象=清掉映射表;不给字段=保留;关掉推理时不动它", () => {
  const withMap = upsertCustomModel(emptyModelsConfig(), mapDraft({ thinkingLevelMap: { high: "high", max: "max" } }));
  const pid = withMap.providerId;

  const cleared = upsertCustomModel(
    withMap.config,
    mapDraft({ providerId: pid, thinkingLevelMap: {} }),
    { target: { providerId: pid, model: "m1" } },
  ).config;
  assert.equal("thinkingLevelMap" in cleared.providers[pid].models[0], false, "空对象 = 明确清掉映射表");

  // 关掉推理再保存：编辑器不回传 thinkingLevelMap ⇒ 文件里的旧表要活着（下次打开思考还能接着用）。
  const off = upsertCustomModel(
    withMap.config,
    draftInput({ providerId: pid, model: "m1", reasoning: false }),
    { target: { providerId: pid, model: "m1" } },
  ).config;
  assert.deepEqual(off.providers[pid].models[0].thinkingLevelMap, { high: "high", max: "max" }, "关掉推理不该抹掉映射表");
  assert.deepEqual(findCustomModel(off, pid, "m1").thinkingLevels, ["off"], "关掉推理后只剩 off");
});

test("档位映射:坏输入报错而不是截断/静默丢", () => {
  assert.throws(() => mapDraft({ thinkingLevelMap: { high: "x high" } }), /must not contain spaces/);
  assert.throws(() => mapDraft({ thinkingLevelMap: { high: "x".repeat(41) } }), /at most 40 characters/);
  assert.throws(() => mapDraft({ thinkingLevelMap: { bogus: "high" } }), /Unknown thinking levels/);
  assert.throws(() => mapDraft({ thinkingLevelMap: ["high"] }), /must be an object/);
  // 空串/纯空白当「未声明」丢掉（编辑器发的是 null，这条只管手写的 payload）
  const saved = upsertCustomModel(emptyModelsConfig(), mapDraft({ thinkingLevelMap: { high: "  ", low: "low" } }));
  assert.deepEqual(saved.config.providers[saved.providerId].models[0].thinkingLevelMap, { low: "low" });
});

test("描述层档位与 pi 的 getSupportedThinkingLevels 完全一致", async () => {
  const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
  const cases = [
    { reasoning: true, thinkingLevelMap: undefined },
    { reasoning: true, thinkingLevelMap: { off: null, high: "high", max: "max" } },
    { reasoning: true, thinkingLevelMap: { minimal: null, low: "low", medium: null, high: null, xhigh: "xhigh", max: null } },
    { reasoning: false, thinkingLevelMap: { high: "high" } },
  ];
  for (const model of cases) {
    const saved = upsertCustomModel(emptyModelsConfig(), mapDraft({ model: "m", ...model }));
    const row = findCustomModel(saved.config, saved.providerId, "m");
    assert.deepEqual(
      row.thinkingLevels,
      getSupportedThinkingLevels({ ...model, provider: "x", id: "m", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }),
      `档位表必须与 pi 同规则: ${JSON.stringify(model)}`,
    );
  }
});
