/**
 * 模型价格（四个单价 + 阶梯档）的规则与接线。
 *
 * 价格只干一件事：喂给 pi 的 `calculateCost()` 算「预计费用」。单位是每 100 万 token，
 * 不做币种换算、不存币种。所以测试盯四点：
 *   1. 落进 models.json 的一定是合法数字（pi 的 schema 四个价都是 required number，
 *      写进字符串/NaN 会让整份文件加载失败，全家模型一起没）；
 *   2. 手填的价格优先，不能被目录 seed 或「表单没带这个字段」抹掉；
 *   3. 前后端同一套校验，前端拦下的桥也拦；
 *   4. 真 pi 认我们写出来的行，并且阶梯档真的生效。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { t } from "../src/i18n/index.ts";

import {
  catalogSeedFromModel,
  emptyModelsConfig,
  listCustomModels,
  normalizeCustomModelInput,
  normalizeCostInput,
  parseModelsConfig,
  upsertCustomModel,
  upsertCustomModels,
} from "../server/customModels.mjs";

import {
  buildCostPayload,
  costDraftFromConfig,
  emptyCostDraft,
  MAX_PRICE,
  MAX_PRICE_TIERS,
  newCostTier,
  priceSummary,
  toPriceNumber,
  validateCostDraft,
  costRateErrorKey,
  costThresholdErrorKey,
} from "../src/features/models/customModelForm.ts";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { calculateCost } from "@earendil-works/pi-ai";

const baseInput = (overrides = {}) => ({
  providerName: "我的百炼",
  baseUrl: "https://gw.example.com/v1",
  apiKey: "sk-test-123",
  model: "qwen3.8-max",
  ...overrides,
});

const draftCost = (overrides = {}) => ({ ...emptyCostDraft(), ...overrides });

const pricedRow = {
  id: "qwen3.8-max",
  name: "Qwen3.8 Max",
  contextWindow: 256000,
  maxTokens: 131072,
  cost: { input: 2, output: 8, cacheRead: 0.4, cacheWrite: 2.5 },
};

const handWritten = {
  providers: {
    bailian: {
      name: "Bailian",
      baseUrl: "https://llm.example.com/compatible-mode/v1",
      api: "openai-completions",
      models: [pricedRow],
    },
  },
};

/* --------------------------------------------------------- A. 桥侧校验与归一 */

test("价格四个字段都收：小数照收、空算 0、多余键丢掉", () => {
  const entry = normalizeCustomModelInput(
    baseInput({ cost: { input: "2", output: "8.5", cacheRead: "", cacheWrite: 0, bogus: 7 } }),
    { requireApiKey: true },
  );

  assert.deepEqual(entry.model.cost, { input: 2, output: 8.5, cacheRead: 0, cacheWrite: 0 });
  assert.equal(entry.model.given.cost, true);
  assert.equal(entry.model.cost.bogus, undefined, "未知字段不该被写进文件");
});

test("一个价都没填 = 没给价格，绝不要把已存的价格洗成 0", () => {
  for (const cost of [undefined, null, "", {}, { input: "", output: "", cacheRead: "", cacheWrite: "" }]) {
    const entry = normalizeCustomModelInput(baseInput({ cost }), { requireApiKey: true });
    assert.equal(entry.model.given.cost, false, `空 cost 被判成“给了”：${JSON.stringify(cost)}`);
    assert.equal(entry.model.cost, undefined);
  }
  // 形状不对（数字/数组）同样算没给：一个脏值不该有能力清掉价格。
  for (const cost of [5, "abc", [], ["x"]]) {
    assert.equal(normalizeCustomModelInput(baseInput({ cost }), { requireApiKey: true }).model.given.cost, false);
  }
});

test("只填一个价也算给了：其余按 0 补齐（pi 要求四个价齐全）", () => {
  const entry = normalizeCustomModelInput(baseInput({ cost: { output: 3 } }), { requireApiKey: true });
  assert.deepEqual(entry.model.cost, { input: 0, output: 3, cacheRead: 0, cacheWrite: 0 });
});

test("非法价格当场报错，绝不落盘", () => {
  const cases = [
    [{ input: "abc" }, /Price · input must be a number/],
    [{ input: "-1" }, /Price · input cannot be negative/],
    [{ output: "Infinity" }, /Price · output must be a number/],
    [{ cacheRead: MAX_PRICE + 1 }, /Price · cache read in must be at most/],
    [{ cacheWrite: "1e99" }, /Price · cache write must be at most/],
  ];
  for (const [cost, expected] of cases) {
    assert.throws(() => normalizeCostInput(cost), expected, JSON.stringify(cost));
    assert.throws(
      () => normalizeCustomModelInput(baseInput({ cost }), { requireApiKey: true }),
      expected,
      `表单口没拦住：${JSON.stringify(cost)}`,
    );
  }
});

test("浮点尾数被洗掉，文件里不会出现 0.30000000000000004", () => {
  assert.equal(normalizeCostInput({ input: 0.1 + 0.2 }).input, 0.3);
  // 契约是「最多 6 位小数」：6 位内原样留住，更细的报价格式化掉（没人按 1e-7/百万 token 报价）。
  assert.equal(normalizeCostInput({ input: "1.000004" }).input, 1.000004);
  assert.equal(normalizeCostInput({ input: "0.0040001" }).input, 0.004);
  assert.equal(normalizeCostInput({ output: "8.0000000" }).output, 8);
});

test("阶梯档：阈值必须正整数、不能重复、最多 8 档，落盘按阈值升序", () => {
  const tier = (inputTokensAbove, extra = {}) => ({ inputTokensAbove, input: 5, output: 16, cacheRead: 0.8, cacheWrite: 0, ...extra });

  const normalized = normalizeCostInput({
    input: 2, output: 8, cacheRead: 0.4, cacheWrite: 2.5,
    tiers: [tier(64000), tier(32000)],
  });
  assert.deepEqual(normalized.tiers.map((row) => row.inputTokensAbove), [32000, 64000], "写进文件的档要排好");
  assert.deepEqual(normalized.tiers[0], { inputTokensAbove: 32000, input: 5, output: 16, cacheRead: 0.8, cacheWrite: 0 });

  assert.throws(() => normalizeCostInput({ tiers: [tier(0)] }), /positive whole number/, "阈值 0 等于永远盖掉顶层价");
  assert.throws(() => normalizeCostInput({ tiers: [tier("32.5")] }), /positive whole number/);
  assert.throws(() => normalizeCostInput({ tiers: [tier("abc")] }), /positive whole number/);
  assert.throws(() => normalizeCostInput({ tiers: [tier(32000), tier("32000")] }), /already starts at 32,000/);
  assert.throws(
    () => normalizeCostInput({ tiers: Array.from({ length: MAX_PRICE_TIERS + 1 }, (_, index) => tier((index + 1) * 1000)) }),
    /at most 8 pricing tiers/,
  );
  // 档里也要四个价：非法值报错，没填的补 0。
  assert.throws(() => normalizeCostInput({ tiers: [{ inputTokensAbove: 32000, input: "-3" }] }), /tier 1 · input cannot be negative/);
  assert.deepEqual(
    normalizeCostInput({ tiers: [{ inputTokensAbove: 32000 }] }).tiers[0],
    { inputTokensAbove: 32000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
});

test("没有档位时干脆不给 tiers 键（空数组写进文件是噪音）", () => {
  assert.deepEqual(Object.keys(normalizeCostInput({ input: 1, tiers: [] })), ["input", "output", "cacheRead", "cacheWrite"]);
});

/* ------------------------------------------------------------- B. 落盘优先级 */

test("手填的价格盖在目录 seed 之上", () => {
  const seed = catalogSeedFromModel({ id: "m", cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } });
  const entry = normalizeCustomModelInput(
    { providerName: "Seed", baseUrl: "https://seed.dev/v1", providerMode: "builtin", model: "m", cost: { input: 1, output: 2 } },
    { requireApiKey: false },
  );

  const { config } = upsertCustomModels(emptyModelsConfig(), [entry], { seeds: { m: seed } });
  assert.deepEqual(config.providers.seed.models[0].cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test("表单没带价格时，编辑别的字段不会把已存价格（含阶梯）抹掉", () => {
  const withTiers = {
    providers: {
      bailian: {
        ...handWritten.providers.bailian,
        models: [{ ...pricedRow, cost: { ...pricedRow.cost, tiers: [{ inputTokensAbove: 32000, input: 4, output: 16, cacheRead: 0.8, cacheWrite: 0 }] } }],
      },
    },
  };

  const edited = upsertCustomModel(withTiers, normalizeCustomModelInput(baseInput({ model: "qwen3.8-max", reasoning: true }), { requireApiKey: true }), {
    target: { providerId: "bailian", model: "qwen3.8-max" },
  });
  const row = edited.config.providers.bailian.models[0];
  assert.equal(row.reasoning, true);
  assert.deepEqual(row.cost, withTiers.providers.bailian.models[0].cost, "没填价格 = 保持原样");
});

test("显式提交价格就是整条替换：不带档 = 撤掉阶梯", () => {
  const withTiers = {
    providers: {
      bailian: {
        ...handWritten.providers.bailian,
        models: [{ ...pricedRow, cost: { ...pricedRow.cost, tiers: [{ inputTokensAbove: 32000, input: 4, output: 16, cacheRead: 0.8, cacheWrite: 0 }] } }],
      },
    },
  };

  const entry = normalizeCustomModelInput(baseInput({ cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }), { requireApiKey: true });
  const edited = upsertCustomModel(withTiers, entry, { target: { providerId: "bailian", model: "qwen3.8-max" } });
  assert.deepEqual(edited.config.providers.bailian.models[0].cost, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
});

test("列表口回传价格（编辑弹窗要回填，不然一保存就把价洗成 0）", () => {
  const [entry] = listCustomModels(handWritten);
  assert.deepEqual(entry.cost, pricedRow.cost);

  // 人手写的脏 cost 不能报错：认不出的值兜 0，没用的行丢掉。
  const [dirty] = listCustomModels({
    providers: {
      p: {
        baseUrl: "https://p.dev/v1",
        models: [{ id: "m", cost: { input: "two", output: 3, cacheWrite: -5, tiers: [{ inputTokensAbove: 0 }, { inputTokensAbove: 2000, output: 1 }] } }],
      },
    },
  });
  assert.deepEqual(dirty.cost, { input: 0, output: 3, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 2000, input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }] });

  // 完全没有 cost 的行：补四个 0，不给 tiers 键。
  const [bare] = listCustomModels({ providers: { p: { baseUrl: "https://p.dev/v1", models: [{ id: "m" }] } } });
  assert.deepEqual(bare.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

/* --------------------------------------------------------- C. 前端纯规则 */

test("草稿与配置来回换算：0 显示成空框，阶梯行不丢", () => {
  assert.deepEqual(costDraftFromConfig({ input: 2, output: 0, cacheRead: 0.4, cacheWrite: 0 }), {
    input: "2", output: "", cacheRead: "0.4", cacheWrite: "", tiers: [],
  });
  const priced = costDraftFromConfig({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 32000, input: 4, output: 16, cacheRead: 0, cacheWrite: 0 }] });
  assert.deepEqual(priced.tiers, [{ inputTokensAbove: "32000", input: "4", output: "16", cacheRead: "", cacheWrite: "" }]);
  assert.deepEqual(buildCostPayload(priced), {
    input: 2, output: 8, cacheRead: 0, cacheWrite: 0,
    tiers: [{ inputTokensAbove: 32000, input: 4, output: 16, cacheRead: 0, cacheWrite: 0 }],
  });
});

test("toPriceNumber：空=0，负数/非数/超上限=非法", () => {
  assert.equal(toPriceNumber(""), 0);
  assert.equal(toPriceNumber(" 2.5 "), 2.5);
  assert.equal(toPriceNumber(0), 0);
  assert.equal(toPriceNumber("1e-3"), 0.001);
  assert.equal(toPriceNumber("-1"), null);
  assert.equal(toPriceNumber("abc"), null);
  assert.equal(toPriceNumber(String(MAX_PRICE + 1)), null);
});

test("校验报错的键由函数拼，弹窗只认这两个拼法", () => {
  assert.equal(costRateErrorKey("cacheRead"), "costCacheRead");
  assert.equal(costRateErrorKey("input", 1), "tier1CostInput");
  assert.equal(costThresholdErrorKey(0), "tier0Threshold");
});

test("前端校验：非法价、阈值、重复档、档数上限都有报错", () => {
  assert.deepEqual(validateCostDraft(draftCost()), {});
  assert.equal(validateCostDraft(draftCost({ input: "x" })).costInput, `Price must be a number between 0 and ${MAX_PRICE.toLocaleString("en-US")}.`);
  assert.equal(validateCostDraft(draftCost({ cacheWrite: "-2" })).costCacheWrite.includes("Price must be"), true);

  const badThreshold = validateCostDraft(draftCost({ tiers: [{ inputTokensAbove: "0", input: "", output: "", cacheRead: "", cacheWrite: "" }] }));
  assert.match(badThreshold.tier0Threshold, /positive whole number/);
  // 小数阈值桥会拒，前端不能“静静截成整数”就交上去。
  assert.match(validateCostDraft(draftCost({ tiers: [{ inputTokensAbove: "32.5", input: "", output: "", cacheRead: "", cacheWrite: "" }] })).tier0Threshold, /positive whole number/);

  const dup = validateCostDraft(draftCost({
    tiers: [
      { inputTokensAbove: "32000", input: "", output: "", cacheRead: "", cacheWrite: "" },
      { inputTokensAbove: "32000", input: "", output: "", cacheRead: "", cacheWrite: "" },
    ],
  }));
  assert.match(dup.tier1Threshold, /already starts at this threshold/);

  const tooMany = validateCostDraft(draftCost({
    tiers: Array.from({ length: MAX_PRICE_TIERS + 1 }, (_, index) => ({
      inputTokensAbove: String((index + 1) * 1000), input: "", output: "", cacheRead: "", cacheWrite: "",
    })),
  }));
  assert.match(tooMany.costTiers, /At most 8 pricing tiers/);

  // 档里的价也校验，报错键带着行号。
  assert.match(validateCostDraft(draftCost({ tiers: [{ inputTokensAbove: "32000", input: "-1", output: "", cacheRead: "", cacheWrite: "" }] })).tier0CostInput, /Price must be/);
});

test("buildCostPayload：非法阈值那档丢掉、按升序排、没档就不给 tiers 键", () => {
  const payload = buildCostPayload(draftCost({
    input: "2", output: "8",
    tiers: [
      { inputTokensAbove: "64000", input: "5", output: "20", cacheRead: "", cacheWrite: "" },
      { inputTokensAbove: "abc", input: "9", output: "9", cacheRead: "9", cacheWrite: "9" },
      { inputTokensAbove: "32000", input: "4", output: "16", cacheRead: "", cacheWrite: "" },
    ],
  }));
  assert.equal(payload.input, 2);
  assert.equal(payload.output, 8);
  assert.equal(payload.cacheRead, 0);
  assert.deepEqual(payload.tiers.map((row) => row.inputTokensAbove), [32000, 64000]);
  assert.deepEqual(payload.tiers[0], { inputTokensAbove: 32000, input: 4, output: 16, cacheRead: 0, cacheWrite: 0 });

  assert.equal(buildCostPayload(undefined), undefined);
  assert.deepEqual(buildCostPayload(draftCost()), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("新加一档默认给上一档 2 倍的阈值；第一档留空", () => {
  assert.equal(newCostTier().inputTokensAbove, "");
  assert.equal(newCostTier([{ inputTokensAbove: "32000", input: "", output: "", cacheRead: "", cacheWrite: "" }]).inputTokensAbove, "64000");
});

test("列表 chip：全 0 不显示，只有四个价真填了才报", () => {
  assert.equal(priceSummary(undefined), "");
  assert.equal(priceSummary({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), "");
  assert.equal(priceSummary({ input: 0, output: 8, cacheRead: 0, cacheWrite: 0 }), t("models.priceSummary.rates", { input: "0", output: "8" }));
  assert.equal(
    priceSummary({ input: 2, output: 8, cacheRead: 0.4, cacheWrite: 0 }),
    `${t("models.priceSummary.rates", { input: "2", output: "8" })}${t("common.dotSeparator")}${t("models.priceSummary.cache")}`,
  );
  assert.equal(
    priceSummary({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }] }),
    `${t("models.priceSummary.rates", { input: "2", output: "8" })}${t("common.dotSeparator")}${t("models.priceSummary.tiers.one", { count: 1 })}`,
  );
  assert.equal(priceSummary({ input: 2.5, output: 8, cacheRead: 0, cacheWrite: 0 }), t("models.priceSummary.rates", { input: "2.5", output: "8" }));
});

/* ------------------------------------------------------- D. 两边同一套规则 */

test("价格校验：前端拦下的桥也拦，前端放过的桥也放过", () => {
  const cases = [
    undefined,
    {},
    { input: "", output: "", cacheRead: "", cacheWrite: "" },
    { input: "2", output: "8", cacheRead: "0.4", cacheWrite: "2.5" },
    { input: "-1", output: "8" },
    { input: "abc" },
    { input: String(MAX_PRICE + 1) },
    { input: "2", tiers: [{ inputTokensAbove: "32000", input: "4", output: "16" }] },
    { input: "2", tiers: [{ inputTokensAbove: "0", input: "4" }] },
    { input: "2", tiers: [{ inputTokensAbove: "32000" }, { inputTokensAbove: "32000" }] },
    { input: "2", tiers: [{ inputTokensAbove: "32000", input: "-1" }] },
    { input: "2", tiers: [{ inputTokensAbove: "32.5" }] },
  ];

  for (const cost of cases) {
    if (!cost) {
      continue;
    }
    const clientOk = Object.keys(validateCostDraft(cost)).length === 0;
    let serverOk = true;
    let serverError = "";
    try {
      normalizeCostInput(cost);
    } catch (error) {
      serverOk = false;
      serverError = error.message;
    }
    assert.equal(clientOk, serverOk, `${JSON.stringify(cost)}: 前端=${clientOk ? "通过" : "拒绝"} 桥=${serverOk ? "通过" : `拒绝(${serverError})`}`);
  }
});

test("前后端的上限常量是同一个数", () => {
  assert.equal(normalizeCostInput({ input: MAX_PRICE }).input, MAX_PRICE);
  assert.throws(() => normalizeCostInput({ input: MAX_PRICE + 0.0001 }), /at most/);
  assert.equal(newCostTier().inputTokensAbove, "");
  assert.match(String(validateCostDraft(draftCost({ tiers: Array.from({ length: MAX_PRICE_TIERS + 1 }, (_, index) => ({ inputTokensAbove: String(index + 1), input: "", output: "", cacheRead: "", cacheWrite: "" })) })).costTiers), /At most/);
});

/* ------------------------------------------------------- E. 真 pi 认这个形状 */

test("写出来的价格行 pi 认，阶梯档真的按输入总量换价", async () => {
  const entry = normalizeCustomModelInput(
    baseInput({
      cost: {
        input: 2, output: 8, cacheRead: 0.4, cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 32000, input: 5, output: 20, cacheRead: 0.8, cacheWrite: 5 }],
      },
    }),
    { requireApiKey: true },
  );
  const { config } = upsertCustomModel(handWritten, entry, { target: { providerId: "bailian", model: "qwen3.8-max" } });

  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-price-"));
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify(config, null, 2));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath });
  await runtime.refresh({ allowNetwork: false });

  const model = runtime.getModel("bailian", "qwen3.8-max");
  assert.ok(model, "pi 没把这条行认进来（schema 没过）");
  assert.equal(model.cost.tiers[0].inputTokensAbove, 32000, "阶梯档没能从文件里活下来");

  // 阈值口径：本单输入 = input + cacheRead + cacheWrite，20000 < 32000 → 用顶层价。
  const small = calculateCost(model, { input: 10000, output: 1000, cacheRead: 8000, cacheWrite: 2000, cost: {} });
  assert.equal(Number(small.input.toFixed(6)), 0.02, "2/1M × 10000");
  assert.equal(Number(small.output.toFixed(6)), 0.008, "8/1M × 1000");
  assert.equal(Number(small.cacheRead.toFixed(6)), 0.0032, "0.4/1M × 8000");
  assert.equal(Number(small.cacheWrite.toFixed(6)), 0.005, "2.5/1M × 2000");

  // 40000 > 32000 → 整单换成档价（不是超出部分才贵）。
  const large = calculateCost(model, { input: 30000, output: 1000, cacheRead: 8000, cacheWrite: 2000, cost: {} });
  assert.equal(Number(large.input.toFixed(6)), 0.15, "超出阈值后仍按顶层价算：档没生效");
  assert.equal(Number(large.output.toFixed(6)), 0.02);
  assert.equal(Number(large.cacheRead.toFixed(6)), 0.0064);
  assert.equal(Number(large.cacheWrite.toFixed(6)), 0.01);
  assert.equal(
    Number(large.total.toFixed(6)),
    Number((large.input + large.output + large.cacheRead + large.cacheWrite).toFixed(6)),
    "total 不等于四项之和",
  );

  // 桥那边 parse 出来的形状与 runtime 一致（同一份文件，两个读法不该打架）。
  const [listed] = listCustomModels(parseModelsConfig(readFileSync(modelsPath, "utf8"), modelsPath));
  assert.deepEqual(
    listed.cost.tiers,
    model.cost.tiers.map((tier) => ({
      inputTokensAbove: tier.inputTokensAbove,
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead,
      cacheWrite: tier.cacheWrite,
    })),
  );
});

/* ------------------------------------------------------------- F. 接线契约 */

const apiSource = readFileSync(new URL("../src/features/models/customModelsApi.ts", import.meta.url), "utf8");
const dialogSource = readFileSync(new URL("../src/features/models/CustomModelsSettings.tsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server/customModels.mjs", import.meta.url), "utf8");

/** 抠函数体并抽干注释：注释里出现同名文本会把「不许出现某写法」的断言打成假红。 */
function functionBody(source, name) {
  const at = source.indexOf(`function ${name}(`) === 0 || source.includes(`function ${name}(`)
    ? source.indexOf(`function ${name}(`)
    : -1;
  assert.notEqual(at, -1, `找不到 ${name}`);
  let paren = source.indexOf("(", at);
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
      if (brace === 0) return source.slice(at, index + 1).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    }
  }
  throw new Error(`${name} 函数体没闭合`);
}

test("保存请求带 cost：不带的字段桥按“没给”处理（所以前端必须发整条）", () => {
  assert.match(functionBody(apiSource, "saveCustomModel"), /cost: buildCostPayload\(draft\.cost\)/);
});

test("弹窗里四个价与阶梯行都在，且报错键走同一套拼法", () => {
  const body = functionBody(dialogSource, "CustomModelDialog");
  assert.match(body, /\{PRICE_FIELDS\.map\(\(\{ key, labelKey \}\)/, "顶层四价没按同一张表渲染");
  assert.match(body, /errors\[costRateErrorKey\(key\)\]/);
  assert.match(body, /errors\[costRateErrorKey\(key, index\)\]/);
  assert.match(body, /errors\[costThresholdErrorKey\(index\)\]/);
  assert.match(body, /newCostTier\(cost\.tiers\)/);
  assert.match(body, /disabled=\{cost\.tiers\.length >= MAX_PRICE_TIERS\}/);
  assert.match(body, /models\.cost\.addTier/);
  // 半截行不能提交：校验必须挂在提交路径上（validateDraft 里合并 cost 错误）。
  assert.match(functionBody(dialogSource, "submit"), /validateDraft\(draft, \{ requireApiKey: isNew \}\)/);
});

test("列表行上报价格 chip", () => {
  assert.match(dialogSource, /priceSummary\(entry\.cost\)/);
});

test("阶梯块在窄窗口里能收缩（长内容不顶破弹窗）", () => {
  assert.match(cssSource, /\.cost-tier \{[^}]*min-width:\s*0;/);
  assert.match(cssSource, /\.cost-tier-head \{[^}]*min-width:\s*0;/);
  assert.match(cssSource, /\.cost-tier \{[^}]*border:/);
});

test("桥读 cost 的两处接线：入参收 cost、写盘时 given.cost 才覆盖", () => {
  assert.match(functionBody(serverSource, "modelInputParts"), /cost: pick\(\["cost"\]\)/);
  assert.match(functionBody(serverSource, "buildModelRecord"), /if \(given\.cost && model\.cost\) \{\s*record\.cost = model\.cost;\s*\}/);
});
