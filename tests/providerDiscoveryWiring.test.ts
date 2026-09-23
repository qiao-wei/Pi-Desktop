/**
 * 「选择已有供应商 → 取模型列表」的接线（`server/index.mjs` 的 `discoverProviderModels`）。
 *
 * 桥没法在单测里整个起来（会拉起 runtime + 监听端口），所以这里盯的是路由决定：
 * models.json 里自定义的 provider，runtime 的 `refresh()` 对它是静默 no-op ——
 * 只把文件里已存的那几行原样吐回去，用户看到的就是「列表永远只有那几个」。
 * 拉不了就必须自己去打端点的 `/models`，而不是继续报「已刷新」。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(join(import.meta.dirname, "..", "server", "index.mjs"), "utf8");

function functionBody(name) {
  const start = source.indexOf(`async function ${name}(`) === -1
    ? source.indexOf(`function ${name}(`)
    : source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `找不到 ${name}，桥的实现被挪走了？`);
  // 先跳过参数表：解构参数里的 `{ withModelsFor = "" }` 不是函数体的开头。
  let paren = source.indexOf("(", start);
  let depth = 0;
  for (; paren < source.length; paren += 1) {
    if (source[paren] === "(") depth += 1;
    else if (source[paren] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  let brace = 0;
  for (let index = source.indexOf("{", paren); index < source.length; index += 1) {
    if (source[index] === "{") brace += 1;
    else if (source[index] === "}") {
      brace -= 1;
      if (brace === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error("函数体没闭合");
}

test("discover：能不能让 runtime 拉列表按 provider 的 refreshModels 判，不按“像不像内置”", () => {
  const body = functionBody("discoverProviderModels");
  assert.match(body, /providerSupportsRuntimeListing\(/, "要先问 runtime 会不会替这家拉");
  assert.match(body, /if \(!runtimeCanList\) \{/, "拉不了的 provider 要有自己的取数分支");
});

test("discover：自定义 provider 走端点实时列表，key 没填就用已存的那份", () => {
  const body = functionBody("discoverProviderModels");
  assert.match(body, /await requestModelListing\(\{/, "非动态 provider 要自己去 GET 列表端点");
  assert.match(body, /apiKey: apiKey \|\| readStoredApiKey\(providerId\)/, "用户没重填 key 时应复用存好的 key");
  assert.match(body, /models = mergeListingRows\(/, "端点列表要和文件里已存的行合并，别把老模型变隐形");
});

test("discover：只有 runtime 真的联网拉过才叫 refreshed，回退本地目录时给出原因", () => {
  const body = functionBody("discoverProviderModels");
  assert.match(body, /refreshed = runtimeCanList;/, "自定义 provider 的空跑 refresh 不能再报「已刷新」");
  assert.match(body, /warning = listing\.error;/, "列表拉失败要把原因带回去，而不是静默显示旧目录");
});

/* 内置供应商里 Bedrock / Vertex 这类没有 HTTP 端点（鉴权也不走 API key）：
   三个入口（加模型 / 刷新列表 / 验 key）都不能把一句 “Base URL is required.” 当答案甲给用户。 */

test("discover：这家没端点时直说，不去打一个空地址", () => {
  const body = functionBody("discoverProviderModels");
  assert.match(body, /const listingBaseUrl = String\(row\?\.baseUrl \|\| providerConfigBaseUrl\(providerId\) \|\| ""\)\.trim\(\);/);
  assert.match(body, /if \(!listingBaseUrl\) \{[\s\S]{0,260}no endpoint to refresh from/, "没地址要给人话，不是抛异常");
  const guardAt = body.indexOf("if (!listingBaseUrl)");
  const fetchAt = body.indexOf("await requestModelListing(");
  assert.ok(guardAt >= 0 && fetchAt > guardAt, "取数必须排在“有没有地址”的判断之后（空地址曾漏出一个 500）");
});

test("verify-key：没端点的内置供应商不假装在验 key", () => {
  // 断言限定在这段路由里：全文件搜会得到别处的同名写法，那是假绿。
  const at = source.indexOf("/verify-key");
  assert.ok(at > 0, "verify-key 路由不在了");
  const route = source.slice(at, source.indexOf('"/api/model-providers/update"', at));
  assert.match(route, /if \(!String\(row\.baseUrl \?\? ""\)\.trim\(\)\) \{/);
  assert.match(route, /no endpoint to check a key against/);
  assert.ok(route.indexOf("no endpoint to check a key against") < route.indexOf("await requestModelListing("),
    "先判有没有端点，再去打网络");
});

test("runtime 的能力判断读的是 provider.refreshModels", () => {
  const body = functionBody("providerSupportsRuntimeListing");
  assert.match(body, /modelRuntime\.getProvider\(providerId\)\?\.refreshModels === "function"/);
});

test("新增 GET /api/model-providers/:id 端点：返回单个 provider 带本地模型列表", () => {
  assert.match(source, /GET.*\/api\/model-providers\//);
  assert.match(source, /providerCatalogRow\(providerId\)/);
});

test("新增 POST /api/model-providers/:id/verify-key 端点：验证 API key", () => {
  assert.match(source, /\/verify-key/);
  assert.match(source, /requestModelListing\(\{ api, baseUrl: row\.baseUrl, apiKey \}\)/);
});

test("saveCustomModel：probe 那一步也得放过内置供应商的空 baseUrl", () => {
  // 回归：路由先要 probe 一次“这条草稿落到哪家”，而这次 probe 发生在 builtinTarget 判出来之前。
  // 它依旧要求 baseUrl 的话，“往内置供应商加模型”第一步就 500（用户红框里看到的就是这句）。
  const body = functionBody("saveCustomModel");
  assert.match(body, /const probeBody = builtInProviderIds\(\)\.has\(String\(body\?\.providerId \?\? ""\)\.trim\(\)\)[\s\S]{0,160}providerMode: "builtin"/);
  assert.match(body, /normalizeCustomModelInputs\(probeBody, \{ requireApiKey: false \}\)/);
  assert.ok(body.indexOf("normalizeCustomModelInputs(probeBody") < body.indexOf("const builtinTarget ="),
    "probe 排在 builtinTarget 判定之前，所以它自己得先对 baseUrl 放行");
});

/* ------------------------------------------------- 单个 provider 的读与改 */

test("GET /api/model-providers/:id 只读配置，不联网", () => {
  assert.match(source, /\/api\/model-providers\/"\)\) \{\s*\n\s*const pathParts/);
  const body = functionBody("providerCatalogRow");
  assert.doesNotMatch(body, /requestModelListing|refresh\(/, "读单个 provider 不该打网络");
});

test("POST /api/model-providers/update 走 updateProviderSettings，内置供应商直接拒", () => {
  const body = functionBody("updateProvider");
  assert.match(body, /builtInProviderIds\(\)\.has\(providerId\)/, "内置供应商的 baseUrl 会盖到该家所有模型上，不许改");
  assert.match(body, /updateProviderSettings\(readCustomModelsConfig\(\)/);
  assert.match(body, /writeCustomModelsConfig\(result\.config\)/);
  assert.match(body, /await reloadCustomModelProviders\(\[result\.providerId\]\)/);
});

test("编辑 provider 时 key 格式先校验，别写了半截 models.json 才报错", () => {
  const body = functionBody("updateProvider");
  const validateAt = body.indexOf("isProbablyKeyValue(apiKey)");
  const writeAt = body.indexOf("writeCustomModelsConfig");
  assert.ok(validateAt >= 0 && writeAt >= 0 && validateAt < writeAt, "校验必须排在写盘之前");
});

test("verify-key：key 留空 = 验已存的那一份", () => {
  // 断言必须落在 verify-key 这段路由里：整个文件搜会得到别处的同名写法，那是假绿。
  const at = source.indexOf("/verify-key");
  assert.ok(at > 0, "verify-key 路由不在了");
  assert.match(source.slice(at, at + 900), /resolveListingApiKey\(\{ apiKey: body\?\.apiKey, storedKey: readStoredApiKey\(providerId\) \}\)/);
});

test("provider 目录带 provider 级 api，编辑弹窗才回显得出来", () => {
  const body = functionBody("providerRows");
  assert.match(body, /api: String\(configProviders\[provider\.id\]\?\.api \?\? ""\)\.trim\(\)/);
});

test("拉列表不再被“先填 key”拦住：没 key 也放它去打端点", () => {
  const body = functionBody("testCustomModelConnection");
  // 这条 throw 就是「Add provider 里按了 Fetch 什么也没有」的根因之一：
  // 本地网关（Ollama / vLLM / LM Studio）的 /models 根本不要 key。
  assert.doesNotMatch(body, /Enter an API key first/, "桥不能替端点决定要不要 key");
  assert.match(body, /String\(body\?\.apiKey \?\? ""\)\.trim\(\) \|\| readStoredApiKey\(providerId\)/);
  // 拉不到时仍然要按 api 类型分派，并把可读的报错交回去（前端直接贴这句）
  assert.match(body, /listingPlan\(body\?\.api, baseUrl, apiKey\)/);
  assert.match(body, /describeConnectionFailure\(baseUrl, error\)/);
});

test("requestOpenAiJson：空 key 不发 `Bearer ` 空头", () => {
  const body = functionBody("requestOpenAiJson");
  assert.match(body, /key \? \{ authorization: `Bearer \$\{key\}` \} : \{\}/);
  assert.doesNotMatch(body, /headers \?\? \{ authorization: `Bearer \$\{apiKey\}` \}/);
});
