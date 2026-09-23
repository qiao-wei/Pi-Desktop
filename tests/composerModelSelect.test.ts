/**
 * 输入框旁模型切换 + 自定义模型表单规则。
 *
 * 分三层：
 *   A. 纯规则（校验、列表构建、"要不要记住"）——行为契约，改实现不该改这里；
 *   B. 与服务端同规则的部分做跨语言比对，防止两边各改一半；
 *   C. 跨进程/跨文件的接线契约（路由注册、组件挂载位置）——这类没有任何单元测试
 *      能覆盖，只能钉源码结构，改的时候必须一起改这里。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { t } from "../src/i18n/index.ts";

import {
  buildComposerModelOptions,
  draftFromEntry,
  emptyDraft,
  formatTokenCount,
  groupComposerOptionsByProvider,
  groupCustomEntriesByProvider,
  isHttpUrl,
  mergeListingInto,
  modelKey,
  staleListMessage,
  prettifyModelId,
  sameBaseUrl,
  summaryLabel,
  planModelChanges,
  toPositiveInt,
  validateDraft,
} from "../src/features/models/customModelForm.ts";
import * as serverRules from "../server/customModels.mjs";

const customEntry = {
  providerId: "bailian",
  providerName: "百炼",
  baseUrl: "https://a.dev/v1",
  api: "openai-completions",
  model: "qwen3.8-flash",
  modelLabel: "Qwen3.8 Flash",
  contextWindow: 256000,
  maxTokens: 65536,
  reasoning: true,
  supportsImages: false,
  managed: true,
  apiKeyConfigured: true,
  available: true,
};

const summary = (provider: string, model: string, available = true) => ({
  provider,
  model,
  name: model,
  available,
});

/* --------------------------------------------------------------- A. 纯规则 */

test("validateDraft：填齐了就没有错误", () => {
  const draft = {
    ...emptyDraft(),
    providerName: "百炼",
    baseUrl: "https://a.dev/v1",
    apiKey: "sk-1",
    model: "qwen3.8-flash",
  };
  assert.deepEqual(validateDraft(draft), {});
});

test("validateDraft：每个字段各自报错，不用提交才知道", () => {
  const errors = validateDraft({ ...emptyDraft(), providerName: "x" });
  assert.deepEqual(Object.keys(errors).sort(), ["apiKey", "baseUrl", "model"]);
  assert.match(errors.baseUrl, /Base URL/);
  assert.match(errors.model, /Model name is required/);

  assert.match(
    validateDraft({
      ...emptyDraft(),
      providerName: "p",
      baseUrl: "https://a.dev",
      apiKey: "sk 1",
      model: "m",
    }).apiKey,
    /must not contain spaces/,
  );
});

test("validateDraft：编辑态（已有 key）不逼用户重填密钥", () => {
  const draft = { ...emptyDraft(), providerName: "p", baseUrl: "https://a.dev/v1", model: "m" };
  assert.ok(validateDraft(draft, { requireApiKey: true }).apiKey);
  assert.equal(validateDraft(draft, { requireApiKey: false }).apiKey, undefined);
});

test("validateDraft：最大输出超过上下文要报错", () => {
  const errors = validateDraft({
    ...emptyDraft(),
    providerName: "p",
    baseUrl: "https://a.dev/v1",
    apiKey: "k",
    model: "m",
    contextWindow: "4096",
    maxTokens: "8192",
  });
  assert.match(errors.maxTokens, /Max output/);
});

test("toPositiveInt 把空串/0/负数/垃圾都判成“没给值”", () => {
  assert.equal(toPositiveInt(""), null);
  assert.equal(toPositiveInt("0"), null);
  assert.equal(toPositiveInt("-5"), null);
  assert.equal(toPositiveInt("abc"), null);
  assert.equal(toPositiveInt("1234.9"), 1234);
});

test("formatTokenCount 用 k/M，0 与缺失说“unknown”", () => {
  assert.equal(formatTokenCount(128000), "128k");
  assert.equal(formatTokenCount(1500000), "1.5M");
  assert.equal(formatTokenCount(2000000), "2M");
  assert.equal(formatTokenCount(0), "unknown");
  assert.equal(formatTokenCount(undefined), "unknown");
});

test("下拉列表：自定义模型在前，内置模型只放已就绪的", () => {
  const options = buildComposerModelOptions({
    availableModels: [
      summary("anthropic", "claude-a"),
      summary("nokey", "model-x", false),
      summary("bailian", "qwen3.8-flash"),
    ],
    customModels: [customEntry],
    currentProvider: "anthropic",
    currentModel: "claude-a",
  });

  assert.deepEqual(
    options.map((option) => option.key),
    ["bailian/qwen3.8-flash", "anthropic/claude-a"],
  );
  assert.equal(options[0].custom, true);
  assert.equal(options[0].detail, "百炼");
  assert.ok(!options.some((option) => option.provider === "nokey"), "没配鉴权的不进列表");
});

test("下拉列表：当前会话用的模型即使没鉴权也必须在里面", () => {
  const options = buildComposerModelOptions({
    availableModels: [summary("anthropic", "claude-a")],
    customModels: [],
    currentProvider: "ghost",
    currentModel: "gone",
  });
  assert.equal(options.at(-1)?.key, "ghost/gone");
  assert.equal(options.at(-1)?.available, false);
});

test("下拉列表：同一模型同时出现在两份数据里也只有一项", () => {
  const options = buildComposerModelOptions({
    availableModels: [summary("bailian", "qwen3.8-flash")],
    customModels: [customEntry],
    currentProvider: "bailian",
    currentModel: "qwen3.8-flash",
  });
  assert.equal(options.length, 1);
  assert.equal(options[0].custom, true, "自定义那份的信息优先");
});

test("下拉列表：只有 modelOverrides 的条目、空模型行都不进列表", () => {
  const options = buildComposerModelOptions({
    availableModels: [],
    customModels: [
      { ...customEntry, managed: false, model: "" },
      { ...customEntry, model: "" },
    ],
  });
  assert.deepEqual(options, []);
});

test("编辑草稿：自动生成的展示名不回填，用户自己起的名字留着", () => {
  assert.equal(draftFromEntry(customEntry).modelLabel, "");
  assert.equal(draftFromEntry({ ...customEntry, modelLabel: "主力模型" }).modelLabel, "主力模型");
  assert.equal(draftFromEntry({ ...customEntry, modelLabel: customEntry.model }).modelLabel, "");
  assert.equal(draftFromEntry(customEntry).targetModel, "qwen3.8-flash");
});

test("modelKey 是下拉框与 bootstrap 共同的连接键", () => {
  assert.equal(modelKey("a", "b"), "a/b");
});

/* ------------------------------------------------------------- B. 两边同规则 */

test("prettifyModelId：前端与桥逐字相同", () => {
  for (const id of ["qwen3.8-flash", "gpt-4o-mini", "deepseek_r1", "kimi.k2", "a", ""]) {
    assert.equal(prettifyModelId(id), serverRules.prettifyModelId(id), id);
  }
});

test("校验边界：前端拦下的桥也拦，前端放过的桥也放过", () => {
  const cases = [
    { providerName: "p", baseUrl: "https://a.dev/v1", apiKey: "k", model: "ok" },
    { providerName: "", baseUrl: "https://a.dev/v1", apiKey: "k", model: "ok" },
    { providerName: "p", baseUrl: "not a url", apiKey: "k", model: "ok" },
    { providerName: "p", baseUrl: "https://a.dev/v1", apiKey: "k", model: "bad id" },
    { providerName: "p", baseUrl: "https://a.dev/v1", apiKey: "k", model: "ok", contextWindow: 10 },
    { providerName: "p", baseUrl: "https://a.dev/v1", apiKey: "k", model: "ok", maxTokens: 99999999 },
  ];

  for (const input of cases) {
    const clientErrors = validateDraft({ ...emptyDraft(), ...input });
    const clientOk = !Object.keys(clientErrors).length;
    let serverOk = true;
    try {
      serverRules.normalizeCustomModelInput(input, { requireApiKey: true });
    } catch {
      serverOk = false;
    }
    assert.equal(clientOk, serverOk, `${JSON.stringify(input)}: 前端=${clientOk ? "通过" : "拒绝"} 桥=${serverOk ? "通过" : "拒绝"}`);
  }
});

/* ------------------------------------------------------------ C. 接线契约 */

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const hookSource = readFileSync(new URL("../src/features/chat/usePiDesktopApp.ts", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../src/features/models/CustomModelsSettings.tsx", import.meta.url), "utf8");

test("切换器挂在提交按钮同一个动作区里", () => {
  const actions = appSource.slice(appSource.indexOf('<div className="composer-actions">'));
  const block = actions.slice(0, actions.indexOf("</div>"));
  assert.match(block, /<ComposerModelSelect/, "ComposerModelSelect 必须在 .composer-actions 内");
  assert.match(block, /onChange=\{handleComposerModelChange\}/);
});

test("设置 → 模型 这一页只剩自定义模型编辑器", () => {
  const tab = appSource.slice(appSource.indexOf('<TabsContent value="models">'));
  assert.match(tab.slice(0, tab.indexOf("</TabsContent>")), /<CustomModelsSettings/);
});

test("切换模型只发一个请求：记不记由桥按会话新旧 + 项目记录定，客户端不另存一份", () => {
  assert.match(hookSource, /postJson<BootstrapResponse>\("\/api\/model",[\s\S]{0,200}sessionPath,[\s\S]{0,80}\}\);/);
  assert.ok(!/rememberAsDefault/.test(hookSource), "客户端不再假装能决定要不要记住");
  assert.ok(!/rememberAsDefault/.test(bridgeSource), "桥也不接受这个开关：记不记由会话新旧 + 项目记录定（见 sessionModelPolicy）");
});

test("会话在跑时桥直接拒绝切换，而不是把模型换到一半", () => {
  assert.match(
    bridgeSource,
    /if \(isSessionBusy\(targetRuntime\.session\)\) \{\s*throw new Error\("The current reply is still running/,
  );
});

test("自定义模型的五个端点都注册了", () => {
  for (const [method, path] of [
    ["GET", "/api/custom-models"],
    ["POST", "/api/custom-models"],
    ["POST", "/api/custom-models/remove"],
    ["POST", "/api/custom-models/reload"],
    ["POST", "/api/custom-models/test"],
  ] as const) {
    const needle = `req.method === "${method}" && url.pathname === "${path}"`;
    assert.ok(bridgeSource.includes(needle), `缺少路由 ${method} ${path}`);
  }
});

test("「重新读取 models.json」是重读盘 + 重算 runtime，而不是只重发一次 GET", () => {
  const reloadBody = bridgeFunctionBody("reloadCustomModelProviders");
  assert.match(
    bridgeSource,
    /if \(req.method === "POST" && url.pathname === "\/api\/custom-models\/reload"\) \{[\s\S]{0,400}?await reloadCustomModelProviders\(\[\]\)/,
    "reload 路由必须让 runtime 重算 provider（全量重建才能把手删的供应商清掉）",
  );
  assert.match(reloadBody, /modelRuntime\.refresh\(\{ providers:/, "重算走 pi 的 modelRuntime.refresh");
  assert.ok(
    !/allowNetwork: true/.test(reloadBody),
    "重读本地文件不该顺手联网拉模型列表",
  );

  // 前端：按钮走新接口，并把结果同步给可用模型列表。
  assert.match(panelSource, /onClick=\{\(\) => void handleReloadModels\(\)\}/, "刷新按钮要接 handleReloadModels");
  assert.match(
    panelSource,
    /apply\(await reloadCustomModels\(\)\);[\s\S]{0,120}?onModelsChanged\?\.\(\);/, 
    "重读后要应用新列表并刷新可用模型（否则 composer 菜单还是旧的）",
  );
  assert.match(
    panelSource,
    /aria-label=\{t\("models\.reload"\)\}/,
    "按钮要有可读的名字（图标按钮）",
  );
  assert.match(
    apiSource,
    /export function reloadCustomModels\([\s\S]{0,160}?postJson<CustomModelsResponse>\("\/api\/custom-models\/reload", \{\}\)/,
    "reloadCustomModels 必须打 reload 端点",
  );
});

test("卡片头的动作组垂直居中（标题/说明多行时不再贴顶）", () => {
  const rule = /\n\.settings-card-header\s*\{([^}]*)\}/.exec(cssSource)?.[1] ?? "";
  assert.match(rule, /align-items:\s*center;/, ".settings-card-header 要用 align-items: center");
});

test("没记住过选择时，新会话从列表第一个模型开始（两端同一口径）", () => {
  assert.match(bridgeSource, /function defaultComposerModel\(\)/);
  const ensureBody = bridgeFunctionBody("ensureModelSelection");
  assert.match(
    ensureBody,
    /model: usableDefaultModel\(settingsManager\) \?\? defaultComposerModel\(\),/,
  );
  assert.match(ensureBody, /const defaults = usableDefaultModel\(settingsManager\);[\s\S]{0,400}const available = defaultComposerModel\(\);/);
  // 记住的默认值临时用不了（key 被删等）不能当成“没有默认值”，得先试能用的默认再退到列表第一项。
  assert.match(
    bridgeSource,
    /return model && isUsableModel\(model\) && modelRuntime\.hasConfiguredAuth\(model\.provider\) \? model : undefined;/,
  );
  // 前端兜底：会话没有模型时取第一个可用的。
  assert.match(appSource, /composerModelOptions\.find\(\(option\) => option\.available\)/);
});

/**
 * 语义接线：已有会话各自独立、重开各回各的模型；只有新建任务继承“最后一次选择”。
 *
 * 记账规则本身在 server/sessionModelPolicy.mjs 里逐条行为测试，这里只钉“桥的两条路径
 * 真的各自走对了理由”：这类没有任何单测能覆盖，改一半就会默默退回旧行为。
 *
 * 2026-09-20 起“最后一次选择”按项目记在 projects.json（composerDefaults），pi 的全局
 * settings 只当没记过时的兜底，所以桥里不再有“记全局”的入口。
 */
test("打开会话不许改写起点；只有新建会话里改才记到项目上", () => {
  assert.match(bridgeSource, /from "\.\/sessionModelPolicy\.mjs"/);
  for (const symbol of [
    "applyModelToSession",
    "isFreshSession",
    "MODEL_APPLY_REASONS",
    "normalizeComposerDefaults",
    "silenceGlobalModelWrites",
  ]) {
    assert.ok(bridgeSource.includes(symbol), `桥没导入 ${symbol}`);
  }

  // 会话打开：全部走 session-open（不记），且不得绕过策略直接动 setModel。
  const ensureBody = bridgeFunctionBody("ensureModelSelection");
  assert.equal(
    (ensureBody.match(/MODEL_APPLY_REASONS\.sessionOpen/g) ?? []).length,
    3,
    "三条应用路径都得标成 session-open",
  );
  assert.ok(!ensureBody.includes("setModel("), "不许绕过策略直接 session.setModel()");

  // 换模型 / 换等级：pi 的全局写一律挡掉，改记录到项目（composerDefaults），且只有新会话才算数。
  for (const name of ["setModelConfiguration", "setSessionThinkingLevel"]) {
    const body = bridgeFunctionBody(name);
    assert.match(body, /silenceGlobalModelWrites\(targetRuntime\.settingsManager\)/, `${name} 必须挡住 pi 的全局写入`);
    assert.match(body, /isFreshSession\(targetRuntime\.session\)/, `${name} 要用「新会话」判定`);
    assert.match(body, /rememberProjectComposerDefaults\(targetRuntime\.projectId/, `${name} 要把选择记到项目上`);
    assert.ok(!body.includes("setDefaultThinkingLevel"), `${name} 不许再写全局 defaultThinkingLevel`);
  }
  // 桥里不再有「记全局」的入口。
  assert.equal((bridgeSource.match(/MODEL_APPLY_REASONS\.userSwitch/g) ?? []).length, 0, "user-switch 已不再由桥使用");
});

/** 从桥源码抠函数体（结构性断言必须限定在目标函数内，否则别处的同名写法会让它永久假绿）。 */
function bridgeFunctionBody(name: string): string {
  const body = componentFunctionBody(bridgeSource, name);
  assert.ok(body.length > 40, `桥里的 ${name} 函数体太短，扇不到`);
  // 抽干注释：否则“注释里提到 session.setModel()”会让「没绕过策略」这条断言假绿，
  // 反过来一删注释就假红。
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("保存/删除后就地刷新控制器：设置页与输入框共用同一份列表", () => {
  assert.match(panelSource, /apply\(await saveCustomModel\(/);
  assert.match(panelSource, /apply\(await removeCustomModel\(/);
  assert.match(appSource, /<CustomModelsSettings models=\{models\}/);
});

test("列表拉不下来时要在面板上吼出来，不能静默显示空列表", () => {
  assert.match(panelSource, /const shownError = loadError \|\| error;/);
  assert.match(panelSource, /\{shownError \? \(/);
});

/* ------------------------------------------- D. 按供应商分组 / 窄窗口布局 */

test("下拉框按供应商分组：自定义在前，内置按名字排，组内保持原顺序", () => {
  const options = buildComposerModelOptions({
    availableModels: [summary("zeta", "z1"), summary("alpha", "a1"), summary("bailian", "qwen3.8-flash")],
    customModels: [customEntry, { ...customEntry, model: "qwen3.7-plus", modelLabel: "Qwen3.7 Plus" }],
    currentProvider: "bailian",
    currentModel: "qwen3.8-flash",
  });
  const groups = groupComposerOptionsByProvider(options);
  assert.deepEqual(groups.map((group) => group.key), ["bailian", "alpha", "zeta"]);
  assert.equal(groups[0].custom, true);
  assert.equal(groups[0].label, "百炼");
  assert.deepEqual(groups[0].options.map((option) => option.model), ["qwen3.8-flash", "qwen3.7-plus"]);
  assert.equal(groups.every((group) => group.options.length >= 1), true);
});

test("设置页按供应商分组：同名 provider 归一组，空 baseUrl 不清掉已有的", () => {
  const groups = groupCustomEntriesByProvider([
    { ...customEntry, providerId: "bailian", providerName: "Bailian" },
    { ...customEntry, providerId: "bailian", providerName: "Bailian", model: "qwen3.7-plus" },
    { ...customEntry, providerId: "anthropic", providerName: "Anthropic", baseUrl: "" },
    { ...customEntry, providerId: "bailian", providerName: "Bailian", model: "qwen3.6", baseUrl: "" },
  ]);
  assert.deepEqual(groups.map((group) => group.providerId), ["anthropic", "bailian"]);
  assert.equal(groups[1].entries.length, 3);
  assert.equal(groups[1].baseUrl, customEntry.baseUrl);
  assert.equal(groups[0].baseUrl, "");
});

test("空列表不分组，也不炸", () => {
  assert.deepEqual(groupCustomEntriesByProvider([]), []);
  assert.deepEqual(groupComposerOptionsByProvider([]), []);
});

const cssSource = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");

test("窄窗口里模型列表不再被长地址撑破：每一层都允许收缩", () => {
  // 长 URL 的 min-content 就是它自己，grid/flex 子项默认 min-width:auto 会顶破弹窗边界。
  const guarded = new Set<string>();
  // 注释里也可能出现逗号，先去掉再按规则块切。
  const declarationsOnly = cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of declarationsOnly.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/min-width:\s*0;/.test(match[2])) {
      continue;
    }
    for (const selector of match[1].split(",")) {
      guarded.add(selector.trim());
    }
  }
  for (const selector of [
    ".settings-card",
    ".settings-card-body",
    ".settings-card-header",
    ".settings-groups",
    ".settings-group",
    ".settings-list",
    ".settings-row",
    ".settings-row > div",
    ".add-model-options",
    ".add-model-option",
    ".provider-picker",
    ".provider-picker-list",
    ".provider-picker-row",
    ".provider-picker-current",
    ".provider-picker-trigger",
    ".provider-picker-trigger-name",
    ".provider-picker-trigger-meta",
  ]) {
    assert.ok(guarded.has(selector), `${selector} 缺 min-width: 0`);
  }
  // 元信息（上下文/推理/图片）要能换行，而不是被截掉。
  assert.match(cssSource, /\.settings-row-meta\s*\{[^}]*flex-wrap:\s*wrap;/);
  // 下拉宽度跟着视窗收。
  assert.match(cssSource, /\.composer-model-content\s*\{[^}]*width:\s*min\(/);
});

const addDialogSource = readFileSync(new URL("../src/features/models/AddModelsDialog.tsx", import.meta.url), "utf8");
const providerDialogSource = readFileSync(new URL("../src/features/models/ProviderDialog.tsx", import.meta.url), "utf8");
const apiKeyFieldSource = readFileSync(new URL("../src/features/models/ApiKeyField.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/features/models/customModelsApi.ts", import.meta.url), "utf8");

test("添加模型只看已有供应商；provider 的建/改在另一个弹窗", () => {
  assert.match(panelSource, /<AddModelsDialog/);
  assert.match(panelSource, /<ProviderDialog/);
  assert.match(addDialogSource, /fetchModelProviders\(\)/);
  assert.match(addDialogSource, /fetchProviderModels\(/);
  assert.match(addDialogSource, /discoverProviderModels\(\{ providerId/);
  // 端点注册 + 批量落盘 + provider 级修改都在新弹窗里
  assert.match(providerDialogSource, /testCustomModelConnection\(\{[\s\S]{0,300}api: apiType/);
  assert.match(providerDialogSource, /addCustomModels\(\{/);
  assert.match(providerDialogSource, /updateProvider\(\{/);
  // 旧的两用形态不该回来：加模型弹窗里不再有“自定义来源”那套
  assert.doesNotMatch(addDialogSource, /OpenAI-compatible endpoint|SourceToggle|apiType/);
});

test("供应商是一个 dropdown：展开后第一排就是搜索框", () => {
  // trigger 收起整张列表，展开态由 providerOpen 决定（40+ 家摊开会顶满弹窗）。
  assert.match(addDialogSource, /id="add-model-provider-trigger"/);
  assert.match(addDialogSource, /aria-haspopup="listbox"/);
  assert.match(addDialogSource, /aria-expanded=\{providerOpen\}/);
  assert.match(addDialogSource, /<Popover open=\{providerOpen\} onOpenChange=\{setProviderOpen\}>/);
  // 面板宽度跟 trigger（shadcn 的 w-72 会盖掉 CSS 里的 width，所以用工具类写）。
  assert.match(
    addDialogSource,
    /className="provider-picker-content w-\(--radix-popover-trigger-width\) max-w-\(--radix-popover-content-available-width\) p-0"/,
  );
  // 面板里搜索在前、列表在后。
  assert.ok(
    addDialogSource.indexOf("provider-picker-search") < addDialogSource.indexOf('className="provider-picker-list"'),
    "搜索框必须是 dropdown 的第一排",
  );
  assert.match(addDialogSource, /placeholder=\{t\("models\.add\.searchProviders", \{ count: providers\.length \}\)\}/);
  assert.match(addDialogSource, /aria-label=\{t\("models\.add\.searchProvidersAria"\)\}/);
  assert.match(addDialogSource, /role="listbox"/);
  // 展开即聚焦搜索：少一次点击。
  assert.match(addDialogSource, /useEffect\(\(\) => \{[\s\S]{0,240}providerSearchRef\.current\?\.focus\(\)[\s\S]{0,120}\}, \[providerOpen\]\);/);
  // 收起的三条路：点外面、Escape、选中项。
  assert.match(addDialogSource, /onOpenChange=\{setProviderOpen\}/);
  // Escape 只收 dropdown：Radix 的监听在 document 捕获阶段，光靠 React 事件挡不住，
  // 必须让 DialogContent 在 dropdown 开着时放行 Escape。
  assert.match(
    addDialogSource,
    /onEscapeKeyDown=\{\(event\) => \{[\s\S]{0,120}if \(providerOpen\) \{\s*event\.preventDefault\(\);/,
  );
  assert.match(addDialogSource, /if \(event\.key === "Escape"\) \{[\s\S]{0,120}closeProviderPicker\(\);/);
  assert.match(addDialogSource, /function pickProvider\(row: ModelProviderRow\) \{[\s\S]{0,400}setProviderOpen\(false\);/);
  // 搜索框里回车 = 选第一个匹配。
  assert.match(addDialogSource, /if \(event\.key === "Enter"\) \{[\s\S]{0,200}pickProvider\(first\);/);
  // 面板必须走 portal 定位：弹窗里那层 overflow-y-auto 会裁掉绝对定位的子元素。
  assert.match(cssSource, /\.provider-picker-content \{[^}]*background:\s*var\(--popover\);/);
  assert.match(cssSource, /\.provider-picker-list \{[^}]*overflow-y:\s*auto;/);
});

test("dropdown 列表要能滚：捕获阶段拦 wheel，别让 modal 弹窗的滚动锁 preventDefault", () => {
  // 本 dropdown portal 到 body，在「添加模型」modal 弹窗的 react-remove-scroll 锁外；
  // 锁对锁外 target 一律 preventDefault，列表就永远滚不动。守卫必须在列表元素自身的
  // 捕获阶段 stopPropagation，且随元素挂载/卸载进出（effect 会在 portal 挂载前跑空）。
  const swallowStart = addDialogSource.indexOf("const swallowForScrollGuard");
  assert.ok(swallowStart > 0, "缺 swallowForScrollGuard");
  assert.match(
    addDialogSource.slice(swallowStart, swallowStart + 160),
    /const swallowForScrollGuard = \(event: Event\) => \{\s*event\.stopPropagation\(\);\s*\};/,
  );
  const refStart = addDialogSource.indexOf("function attachProviderListRef");
  assert.ok(refStart > 0, "缺 attachProviderListRef（ref 回调挂监听）");
  // 函数体：从签名到第一个两空格缩进的收花括号（内部块都是 4/6 空格，不会提前命中）。
  const guardBody = addDialogSource.slice(refStart, addDialogSource.indexOf("\n  }", refStart));
  assert.match(guardBody, /addEventListener\("wheel", swallowForScrollGuard, \{ capture: true, passive: true \}\)/);
  assert.match(guardBody, /addEventListener\("touchmove", swallowForScrollGuard, \{ capture: true, passive: true \}\)/);
  // 守卫必须长在 provider-picker-list 元素上（而不是别的节点）。
  assert.match(
    addDialogSource,
    /className="provider-picker-list"[\s\S]{0,120}ref=\{attachProviderListRef\}/,
  );
});

test("能就地跳去添加 / 编辑 provider（另开弹窗）", () => {
  assert.match(addDialogSource, /t\("models\.provider\.addTitle"\)/);
  assert.match(addDialogSource, /t\("models\.provider\.editTitle"\)/);
  // 两个入口都是回调，让外层开弹窗；本弹窗不再就地变身成“新建供应商”。
  assert.match(addDialogSource, /onClick=\{onRequestAddProvider\}/);
  assert.match(addDialogSource, /onClick=\{\(\) => onRequestEditProvider\(provider\.id\)\}/);
  // 只能改用户自己登记在 models.json 里、且不是内置的那家（内置的 baseUrl 会盖到该家所有模型上）。
  assert.match(addDialogSource, /const canEditProvider = Boolean\(provider && !provider\.builtin && provider\.registered\);/);
  assert.match(addDialogSource, /provider && canEditProvider/);
  assert.match(panelSource, /onRequestAddProvider=\{openAddProvider\}/);
  assert.match(panelSource, /onRequestEditProvider=\{\(providerId\) => openAddProvider\(\{ mode: "edit", providerId \}\)\}/);
  // 开 provider 弹窗时先记下「是谁把我压住的」，不靠渲染时的 adding（开窗后底下那层会短暂不可见）
  assert.match(panelSource, /function openAddProvider\([^)]*\) \{\s*setProviderHost\(adding\);\s*setProviderDialog\(next\);/);
});

test("勾选多个模型走一次批量请求；目录里带的标量原样发，cost/compat 由桥补", () => {
  assert.match(apiSource, /postJson<CustomModelsResponse>\("\/api\/custom-models", input\)/);
  assert.match(addDialogSource, /catalogModelPayload\(model\)/);
  assert.match(apiSource, /api: model\.api \|\| undefined/);
  assert.ok(!/fromCatalog/.test(apiSource), "fromCatalog 已经没用了：整条种子由桥从 runtime 抄");
});

test("桥暴露 provider 目录与模型发现", () => {
  for (const [method, path] of [
    ["GET", "/api/model-providers"],
    ["POST", "/api/model-providers/discover"],
  ] as const) {
    const needle = `req.method === "${method}" && url.pathname === "${path}"`;
    assert.ok(bridgeSource.includes(needle), `缺少路由 ${method} ${path}`);
  }
  // 动态供应商允许联网刷新列表，拉不动时退回本地目录而不是报错。
  assert.match(bridgeSource, /modelRuntime\.refresh\(\{ providers: \[providerId\], allowNetwork: true, force: true \}\)/);
  assert.match(bridgeSource, /warning = error instanceof Error \? error\.message : String\(error\);/);
  // 内置供应商 id 只认 pi 的目录，models.json 里的条目不算；这个判定同时决定要不要逼用户填 key。
  if (!/const builtinTarget = builtInProviderIds\(\)\.has\(resolvedId\);/.test(bridgeSource)) {
    // 别把 20 万字符的源码打进失败输出里。
    assert.fail('桥里没有 `const builtinTarget = builtInProviderIds().has(resolvedId);`');
  }
  assert.ok(bridgeSource.includes('providerMode: builtinTarget ? "builtin" : "custom"'), "providerMode 不再由 builtinTarget 决定");
});

/* ------------------------------------------- 添加弹窗：自动取列表 + 勾选即同步 */

const formSource = readFileSync(new URL("../src/features/models/customModelForm.ts", import.meta.url), "utf8");

test("sameBaseUrl：只在两边都有值且归一后相等时算同一个端点", () => {
  assert.equal(sameBaseUrl("https://A.dev/v1/", "https://a.dev/v1"), true);
  assert.equal(sameBaseUrl("https://a.dev/v1", "https://a.dev/v2"), false);
  assert.equal(sameBaseUrl("", ""), false, "空值不算匹配：否则所有没填的都会互相匹配");
  assert.equal(sameBaseUrl("https://a.dev", ""), false);
});

test("summaryLabel：说清楚会加几条、会删几条", () => {
  assert.equal(summaryLabel(0, 0), t("models.summary.none"));
  assert.equal(summaryLabel(2, 0), t("models.summary.add", { count: 2 }));
  assert.equal(summaryLabel(0, 1), t("models.summary.remove", { count: 1 }));
  assert.equal(summaryLabel(3, 2), `${t("models.summary.add", { count: 3 })}${t("common.dotSeparator")}${t("models.summary.remove", { count: 2 })}`);
});

test("isHttpUrl：只认 http/https 的绝对地址", () => {
  assert.equal(isHttpUrl("https://a.dev/v1"), true);
  assert.equal(isHttpUrl("http://127.0.0.1:9/v1"), true);
  assert.equal(isHttpUrl("a.dev/v1"), false);
  assert.equal(isHttpUrl("ftp://a.dev"), false);
  assert.equal(isHttpUrl(""), false);
});

test("选完 provider 只读配置里的模型列表，不自动打端点", () => {
  assert.match(addDialogSource, /const canRefresh = Boolean\(providerId\);/);
  assert.match(addDialogSource, /void loadConfiguredModels\(providerId\)/);
  assert.match(addDialogSource, /await fetchProviderModels\(id\)/);
  // 列表提示要说清这是配置值，点 Refresh 才是端点真值
  assert.match(addDialogSource, /models\.add\.configuredNotice/);
  assert.match(addDialogSource, /models\.add\.configuredEmpty/);
  // 新弹窗里的 Fetch models 是手点的（不自动拉）
  assert.match(providerDialogSource, /async function fetchModels\(\)/);
});

test("模型列表上方有 Refresh（唯一的手动拉取入口），拉之前先清掉过时提示", () => {
  assert.match(addDialogSource, /aria-label=\{t\("models\.add\.fetchAria"\)\}/);
  assert.match(addDialogSource, /aria-label=\{t\("models\.add\.fetchAria"\)\}[\s\S]{0,220}disabled=\{busy \|\| !canRefresh\}[\s\S]{0,120}onClick=\{\(\) => void fetchList\(\)\}/);
  // 两条拉列表路径开始时都先撤掉上一轮提示，否则重取期间挂着的是过时的 “Fetched …”。
  assert.match(addDialogSource, /setError\(""\);\s*\n\s*setNotice\(""\);\s*\n\s*setStatus\("discovering"\);/);
  assert.match(providerDialogSource, /setError\(""\);\s*\n\s*setNotice\(""\);/);
});

test("已经在 models.json 里的模型默认勾上，取消勾选就是提交时删掉", () => {
  assert.match(addDialogSource, /function syncSelection\(list: ProviderModelOption\[\]\) \{[\s\S]{0,320}setAddedEntries\(existing\);\s*setSelected\(existing\.map\(\(entry\) => entry\.model\)\);/);
  assert.match(addDialogSource, /const toAdd = useMemo\([\s\S]{0,300}!addedIds\.has\(model\.id\)/);
  assert.match(addDialogSource, /const toRemove = useMemo\([\s\S]{0,200}addedEntries\.filter\(\(entry\) => !selected\.includes\(entry\.model\)\)/);
  assert.match(addDialogSource, /for \(const entry of toRemove\) \{\s*response = await removeCustomModel\(entry\.providerId, entry\.model\);/);
  // 已经加过的那行要标出来，否则用户不知道为什么一上来就是勾着的。
  assert.match(addDialogSource, /already \? <span className="settings-row-chip">\{t\("models\.add\.inModelsJsonChip"\)\}<\/span>/);
  assert.match(addDialogSource, /\{toRemove\.length \? t\("models\.add\.applyChanges"\) : t\("models\.add\.addSelected"\)\}/);
  assert.match(panelSource, /<AddModelsDialog[\s\S]{0,240}entries=\{managed\}/);
});

test("内置供应商没 key 也允许先加模型，自定义端点必须有 key", () => {
  // 内置的鉴权由 pi 自己管（env / OAuth / 之后 /login），不该在加模型这一步卡住。
  assert.match(bridgeSource, /const requireApiKey = !hasStoredKey && !builtinTarget;/);
  assert.match(bridgeSource, /normalizeCustomModelInputs\(bodyWithMode, \{ hasStoredKey, requireApiKey \}\)/);
});

test("添加 provider 时 key 必填、至少一个模型，拉不到列表要吼出来", () => {
  // 建供应商落盘必须有 key；拉列表也要有 key（框里填的或这家存过的），但报错都发生在点击之后，不灰按钮。
  assert.match(providerDialogSource, /const canFetch = isHttpUrl\(base\);/);
  assert.match(providerDialogSource, /if \(!apiKey\.trim\(\)\) \{\s*setError\(t\("models\.provider\.keyRequired"\)\);/);
  assert.match(providerDialogSource, /if \(!chosenModels\.length\) \{/);
  assert.match(providerDialogSource, /models\.provider\.selectOrType/);
  // 上一轮拉取失败过 → 提交时把真正的原因（地址/密钥错）再顶出来一次，而不是只说一句“没选模型”
  assert.match(providerDialogSource, /models\.provider\.noListAddByName[\s\S]{0,120}\{ error: fetchErrorRef\.current \}/);
  assert.match(providerDialogSource, /models\.provider\.keyPlaceholder/);
  // 拉不到列表时既给出路（手填）也不吃掉已有列表
  assert.match(providerDialogSource, /models\.provider\.orAddByName/);
  assert.match(providerDialogSource, /models\.provider\.staleScreenList/);
});

test("provider 弹窗能选 api 类型，列表按类型分派", () => {
  assert.match(providerDialogSource, /id="provider-api"/);
  for (const needle of ["openai-completions", "anthropic-messages", "google-generative-ai", "bedrock-converse-stream"]) {
    assert.ok(formSource.includes(`"${needle}"`), `API_TYPES 里少了 ${needle}`);
  }
  // 拿不了列表的类型在标签里就说清楚，别让用户对着转圈的按钮猜（文案在语言包里）。
  const enPackSource = readFileSync(new URL("../src/i18n/en.ts", import.meta.url), "utf8");
  assert.match(enPackSource, /no listing \(type the name\)/);
  const zhPackSource = readFileSync(new URL("../src/i18n/zh.ts", import.meta.url), "utf8");
  assert.match(zhPackSource, /无法拉取列表（手填名称）/);
  // 桥侧真的按 api 分派。
  assert.match(bridgeSource, /listingPlan\(body\?\.api, baseUrl, apiKey\)/);
  assert.match(bridgeSource, /if \(plan\.unsupported\)/);
  assert.match(bridgeSource, /listing: modelId && !models\.includes\(modelId\)/);
});

test("内置供应商只能改 key，自定义 provider 全字段可编辑", () => {
  assert.match(panelSource, /aria-label=\{entry\.builtin[\s\S]{0,120}t\("models\.row\.editKeyAria", \{ name: entry\.providerName \}\)/);
  // 两条入口各走各的开窗函数，两边都要把已存的 key 回填进框里
  assert.match(panelSource, /if \(entry\.builtin\) \{\s*openKeyDialog\(entry\);\s*\} else \{\s*openModelDraft\(entry\);/);
  assert.match(panelSource, /function openKeyDialog\(entry: CustomModelEntry\) \{[\s\S]{0,400}setKeyTarget\(entry\);[\s\S]{0,300}loadStoredKey\(entry\.providerId\)/);
  assert.match(panelSource, /function openModelDraft\(entry: CustomModelEntry\) \{[\s\S]{0,500}loadStoredKey\(entry\.providerId\)/);
  // 回填是异步的：迟到的响应不能塞错地方（拿 ref 记住这会儿开着的是哪家/哪条），也不能盖掉用户正在打的字
  assert.match(panelSource, /keyTargetRef\.current\?\.providerId !== entry\.providerId/);
  assert.match(panelSource, /current\.targetModel === base\.targetModel[\s\S]{0,80}!current\.apiKey\.trim\(\)/);
  assert.match(panelSource, /await saveProviderApiKey\(keyTarget\.providerId, key\)/);
  assert.match(apiSource, /postJson<CustomModelsResponse>\("\/api\/custom-models\/key", \{ providerId, apiKey \}\)/);
  assert.match(bridgeSource, /url\.pathname === "\/api\/custom-models\/key"/);
  // 桥告诉前端哪条是内置的。
  assert.match(bridgeSource, /builtin: builtInProviderIds\(\)\.has\(entry\.providerId\)/);
  assert.match(apiSource, /builtin\?: boolean;/);
});

test("端点列表带回来的元信息会预填，不再一律 128k", () => {
  assert.match(providerDialogSource, /contextWindow: entry\.contextWindow \?\? 0/);
  assert.match(providerDialogSource, /supportsImages: Array\.isArray\(entry\.input\) \? entry\.input\.includes\("image"\) : false/);
  assert.match(apiSource, /listing\?: ModelListingEntry\[\]/);
});

test("API key 输入统一走 ApiKeyField：眼睛切明文，空就是空（不拿 •••• 当占位符）", () => {
  assert.match(apiKeyFieldSource, /type=\{visible \? "text" : "password"\}/);
  assert.match(apiKeyFieldSource, /aria-label=\{visible \? "Hide API key" : "Show API key"\}/);
  // 关键：不能拿假圆点当 placeholder —— 那是“眼睛点了没反应”的元凶。
  assert.doesNotMatch(apiKeyFieldSource, /\u2022/);
  assert.doesNotMatch(apiKeyFieldSource, /•/);
  // 框里空着 = 真没填（已存的 key 由调用方回填真值），说明行说清「空着等于继续用存的那份」
  assert.match(apiKeyFieldSource, /No key in the box: the saved one stays in use/);
  // 三处都用同一个组件，不再各写一份
  assert.match(addDialogSource, /<ApiKeyField/);
  assert.match(providerDialogSource, /<ApiKeyField/);
  assert.match(panelSource, /<ApiKeyField/);
  // Verify key（验 key）与 Refresh（拉列表）各司其职，而且拉列表只留一颗按钮
  assert.match(addDialogSource, /models\.add\.verifyKey/);
  assert.match(providerDialogSource, /models\.add\.verifyKey/);
  assert.equal((providerDialogSource.match(/t\("models\.add\.fetchAria"\)/g) ?? []).length, 1,
    "Fetch models 与 Refresh 调的是同一个函数，不该留两颗按钮");
  assert.doesNotMatch(providerDialogSource, />Fetch models</);
  // 退回上一层那颗按钮就叫 Cancel：弹窗栈的事不该写在按钮文案上
  assert.doesNotMatch(providerDialogSource, /Back to Add model/);
  assert.match(providerDialogSource, /onClick=\{back\} disabled=\{busy\}>\s*\{t\("common\.cancel"\)\}/);
});

test("添加模型不卡 key（内置供应商可以之后 /login），但必须真有改动", () => {
  // 加模型这一步不该逼 key：内置供应商的鉴权是 pi 的事（env / OAuth / 之后 /login）。
  assert.doesNotMatch(addDialogSource, /API key is required/);
  assert.match(addDialogSource, /if \(!toAdd\.length && !toRemove\.length\) \{\s*setError\(t\("models\.add\.selectAtLeastOne"\)\);/);
});


/* ------------------------------------------- provider 弹窗：叠在加模型之上 + 列表常驻 */

test("mergeListingInto：端点列表并进来，已有行原样留着", () => {
  const manual = { id: "mine", name: "Mine", contextWindow: 0 };
  const fetched = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  const merged = mergeListingInto([manual], fetched);
  assert.deepEqual(merged.map((m) => m.id), ["a", "b", "mine"], "端点顺序在前，手填的兜底在后面");
  assert.equal(merged[2], manual, "已有行必须是同一个对象：换个壳就把用户改过的字段吃掉了");
  // 同名行以已有为准（可能带着端点没报的上下文/模态）
  assert.equal(mergeListingInto([{ id: "a", name: "我改过名" }], [{ id: "a", name: "A" }])[0].name, "我改过名");
  // 端点重复报同一个 id 不去重就会出双行，checkbox 的 key 也撞
  assert.equal(mergeListingInto([], [{ id: "a" }, { id: "a" }]).length, 1);
  assert.deepEqual(mergeListingInto([], []), []);
  assert.deepEqual(mergeListingInto([{ id: "a" }], []), [{ id: "a" }], "端点报空不能把已有列表清掉");
});

test("staleListMessage：拉成功了撤掉旧报错，拉失败了留着旧报错", () => {
  assert.equal(staleListMessage({ error: "", list: [{ id: "a" }] }), undefined);
  assert.equal(staleListMessage({ error: "", list: [] }), t("models.stale.empty"));
  // 报错 + 列表里还有东西（配置的行/手填的行）：说清哪些照常生效
  assert.equal(
    staleListMessage({ error: "401", list: [{ id: "a" }, { id: "b" }] }),
    t("models.stale.withList", { error: "401", count: 2 }),
  );
  // 报错 + 空列表：别再假称「配置照常生效」
  assert.equal(
    staleListMessage({ error: "401", list: [] }),
    t("models.stale.noList", { error: "401" }),
  );
});

test("设置页不再直接挂 Add provider：它只是 Add model 里的一步", () => {
  assert.doesNotMatch(panelSource, /onClick=\{\(\) => setProviderDialog\(\{ mode: "add" \}\)\}/);
  assert.doesNotMatch(panelSource, /^\s*Add provider$/m);
  // 入口只在一个地方：加模型弹窗里那颗按钮
  assert.match(addDialogSource, /onClick=\{onRequestAddProvider\}/);
});

test("provider 弹窗保存/取消后退回 Add model，而不是整个关掉", () => {
  // 底下压着加模型弹窗时，两层都算开着：加模型只是被盖住，状态不丢
  assert.match(panelSource, /open=\{adding && !providerDialog\}/);
  assert.match(panelSource, /overlayOpen=\{Boolean\(adding && providerDialog\)\}/);
  assert.match(panelSource, /onOverlayBack=\{\(\) => setProviderDialog\(null\)\}/);
  assert.match(panelSource, /<ProviderDialog[\s\S]{0,200}overlayOpen=\{providerHost\}/);
  assert.match(panelSource, /<ProviderDialog[\s\S]{0,400}onBack=\{\(\) => \{[\s\S]{0,120}setProviderHost\(false\);[\s\S]{0,120}setProviderDialog\(null\);/);
  // 弹窗自己按 overlayOpen 分流：有底就 onBack，没底才 onClose
  assert.match(providerDialogSource, /if \(onBack && overlayOpen\) \{\s*onBack\(\);\s*\} else \{\s*onClose\(\);/);
  // 交还焦点时底下的加模型弹窗还在（open || overlayOpen），否则 Escape 会一次关掉整个流程
  assert.match(addDialogSource, /open=\{open \|\| overlayOpen\}/);
  assert.match(addDialogSource, /if \(overlayOpen\) \{\s*onOverlayBack\?\.\(\);/);
  // 被盖住期间不能把状态清一遍，否则回来时 provider/勾选/搜索全没了
  assert.match(addDialogSource, /if \(!open && !overlayOpen\) \{/);
  // footer 计数跟实际提交的集合是同一个（手填没回车的那串不算）
  assert.match(providerDialogSource, /models\.provider\.footerWillSave[\s\S]{0,80}count: selected\.length/);
  assert.match(providerDialogSource, /models: chosenModels\.map/);
});

test("拉列表只有一颗常驻的 Refresh：地址没填对 / 没 key 都要点了给话，不是按成灰的", () => {
  // 模型区常驻（以前拉到列表才渲染，于是 fetch 失败 = 整栏消失）
  assert.match(providerDialogSource, /<Label className="min-w-0 flex-1" htmlFor="provider-model-search">/);
  // 拉取入口一直在头上，不藏进 key 那一行
  assert.match(providerDialogSource, /aria-label=\{t\("models\.add\.fetchAria"\)\}/);
  assert.match(providerDialogSource, /aria-label=\{t\("models\.add\.fetchAria"\)\}[\s\S]{0,220}disabled=\{busy\}[\s\S]{0,120}onClick=\{\(\) => void fetchModels\(\)\}/);
  // disabled 只看 busy：地址与 key 的门槛在 fetchModels 里报错（灰按钮会把原因咽掉）
  assert.doesNotMatch(providerDialogSource, /disabled=\{busy \|\| !canFetch\}/);
  assert.match(providerDialogSource, /if \(!canFetch\) \{\s*setError\(t\("models\.provider\.badBaseUrl"\)/);
  assert.match(providerDialogSource, /if \(noKeyAtAll\) \{\s*setError\(t\("models\.add\.noKeyFetch"\)/);
  assert.match(providerDialogSource, /const noKeyAtAll = !apiKey\.trim\(\) && !savedKeyConfigured;/);
  // 加模型弹窗同一条规则：框里没填、这家又没存过 key，就别白跑一趟
  assert.match(addDialogSource, /if \(!apiKey\.trim\(\) && !provider\?\.authConfigured\) \{\s*setError\(t\("models\.add\.noKeyFetch"\)\)/);
  // fetch 前先报空手填的名字，端点 404 时也能拿到那一条
  assert.match(providerDialogSource, /model: typedModel \|\| undefined/);
  // 拉回来的列表并进已有行（手填那条不能被冲掉）
  assert.match(providerDialogSource, /const list = mergeListingInto\(models, incoming\);/);
  // 只把**本轮新出现**的行补进勾选（已在屏上的行保留用户自己勾/取消的结果），函数式更新避开 stale state
  assert.match(providerDialogSource, /function selectNewRows\(list: ListedModel\[\], previousIds: Set<string>\) \{[\s\S]{0,240}Array\.from\(new Set\(\[[\s\S]{0,120}!previousIds\.has\(model\.id\)/);
  // 编辑时拉列表带上 providerId：没填 key 也能用文件里已存的那一份
  assert.match(providerDialogSource, /providerId: mode === "edit" \? providerId : undefined/);
});

test("Add provider 里能手填模型：显式加一条、标出来、可删", () => {
  assert.match(providerDialogSource, /id="provider-manual"/);
  assert.match(providerDialogSource, /<Plus size=\{14\}/);
assert.match(providerDialogSource, /\{t\("models\.provider\.add"\)\}\s*<\/Button>/);
  // 回车即加一条
  assert.match(providerDialogSource, /if \(event\.key === "Enter"\) \{[\s\S]{0,160}addManualModel\(\);/);
  assert.match(providerDialogSource, /function addManualModel\(\) \{[\s\S]{0,700}setModels\(next\);\s*setSelected\(\(current\) => \[\.\.\.current, id\]\);/);
  // 校验在组件自己这一层（桥的 MODEL_ID_RE 比它宽），并且有可见报错
  assert.match(providerDialogSource, /if \(!MODEL_ID_PATTERN\.test\(id\)\) \{[\s\S]{0,160}models\.provider\.modelNamePattern/);
  assert.match(providerDialogSource, /aria-invalid=\{manualInvalid \|\| manualDuplicated\}/);
  // 手填的行要能看出来，也要能撤掉（在 label 里，不拦住点击会连带切勾选）
  assert.match(providerDialogSource, /models\.provider\.addedByNameChip/);
  assert.match(providerDialogSource, /aria-label=\{t\("models\.provider\.removeRowAria", \{ id: model\.id \}\)\}/);
  assert.match(providerDialogSource, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*dropModel\(model\.id\);/);
  // 原生 button 不自带边框，不清一遍就是个灰色块
  assert.match(cssSource, /\.add-model-option button \{[^}]*background:\s*none;/);
  assert.match(cssSource, /\.provider-model-remove \{[^}]*cursor:\s*pointer;/);
});

/* ------------------------------------------- 编辑 provider：模型区不再是只读展示 */

/** 从组件源码里抠出一个函数体（结构性断言必须限定在目标函数内，否则别处的同名写法会让它永久假绿）。 */
function componentFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`) === -1
    ? source.indexOf(`function ${name}(`)
    : source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `找不到 ${name}，实现被挪走了？`);
  // 先跳过参数表：解构参数里的 `{ a = 1 }` 不是函数体的开头。
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

test("planModelChanges：加/删的账只按「打开时文件里有没有」算", () => {
  const saved = ["a", "b"];
  // 新行勾上才算要加；旧行取消勾选才算要删
  assert.deepEqual(
    planModelChanges({ savedIds: saved, listedIds: ["a", "b", "c"], selectedIds: ["a", "c"] }),
    { toAdd: ["c"], toRemove: ["b"], removesEverything: false },
  );
  // 只想改个名字：Fetch 回来 200 条但一条没勾 → 不加不删（自动全勾会把网关的整个目录灌进文件）
  const flood = ["a", "b", ...Array.from({ length: 200 }, (_, index) => `m${index}`)];
  assert.deepEqual(
    planModelChanges({ savedIds: saved, listedIds: flood, selectedIds: saved }),
    { toAdd: [], toRemove: [], removesEverything: false },
  );
  // 全取消 = 最后一条也删了：桥会顺手把整个供应商删掉，必须标出来
  assert.deepEqual(
    planModelChanges({ savedIds: saved, listedIds: saved, selectedIds: [] }),
    { toAdd: [], toRemove: ["a", "b"], removesEverything: true },
  );
  // 删空旧的但同批补了新的：不算把这家删干净
  assert.equal(
    planModelChanges({ savedIds: saved, listedIds: ["a", "z"], selectedIds: ["z"] }).removesEverything,
    false,
  );
  // 端点自己重复报同一个 id：不加两遍（否则提交时撞 key）
  assert.deepEqual(planModelChanges({ savedIds: [], listedIds: ["x", "x"], selectedIds: ["x"] }).toAdd, ["x"]);
  // 一家还没模型的（刚建好、或文件里被清空过）勾一条：要加，但不算删空
  assert.deepEqual(
    planModelChanges({ savedIds: [], listedIds: ["x"], selectedIds: ["x"] }),
    { toAdd: ["x"], toRemove: [], removesEverything: false },
  );
  // 空输入不炸
  assert.deepEqual(planModelChanges({}), { toAdd: [], toRemove: [], removesEverything: false });
});

test("编辑 provider 时模型区可以操作：Fetch / Refresh / 手填 / 勾选都不再分模式", () => {
  // 以前这些控件整个包在 mode === "add" 里，编辑弹窗只剩一句「请回 Add model」
  assert.doesNotMatch(providerDialogSource, /\{mode === "add" \? \(\n\s*<>\n\s*<Button/);
  assert.doesNotMatch(providerDialogSource, /disabled=\{mode === "edit"\}/);
  assert.doesNotMatch(providerDialogSource, /Add or remove models from/);
  // 钉得更死一点：从 Models 标题到 footer 之间不允许再出现任何「按模式包一层 JSX」的写法
  // （光看 `mode === "add" ? (\n<>\n<Button` 这种字面排版，换个缩进/写成一行就逃过去了）
  const modelsSection = providerDialogSource.slice(
    providerDialogSource.indexOf('<Label className="min-w-0 flex-1" htmlFor="provider-model-search">'),
    providerDialogSource.indexOf("<DialogFooter>"),
  );
  assert.ok(modelsSection.length > 500, "Models 标题到 footer 的区间没抽出来：结构被改得找不着北了");
  for (const gate of ['{mode === "add" ? (', '{mode === "edit" ? (', "mode === \"add\" ? <", "mode === \"edit\" ? <"]) {
    assert.ok(!modelsSection.includes(gate), `模型区又被按模式包了一层：${gate}`);
  }
  // 勾选是真勾选：勾着 = 保留，取消 = 保存时删
  assert.match(providerDialogSource, /const checked = selected\.includes\(model\.id\);/);
  // 「文件里已有」和「刚手填」两枚 chip：不标出来没人知道哪行取消会真删、哪行是自己敲的
  assert.match(providerDialogSource, /model\.origin === "saved" \? <span className="settings-row-chip">\{t\("models\.add\.inModelsJsonChip"\)\}<\/span>/);
  assert.match(providerDialogSource, /model\.origin === "manual" \? <span className="settings-row-chip">\{t\("models\.provider\.addedByNameChip"\)\}<\/span>/);
  // 撤掉已存的行要说清「保存时真删」，别让人以为只是取消选择
  assert.match(providerDialogSource, /models\.provider\.savedRowWarning/);
  assert.match(providerDialogSource, /title=\{model\.origin === "saved" \? t\("models\.provider\.removeSavedRow"\)/);
  // 编辑模式拉回来的新行不自动勾：提示里得说清楚要点勾才算要加，代码里也得真的提前 return
  assert.match(providerDialogSource, /function selectNewRows\(list: ListedModel\[\], previousIds: Set<string>\) \{\s*if \(mode !== "add"\) \{\s*return;\s*\}/);
  assert.match(providerDialogSource, /models\.provider\.fetchedPick/);
  // 账的口径：基准是打开时文件里的那份 id，不是屏上现在的列表
  assert.match(providerDialogSource, /planModelChanges\(\{\s*savedIds: savedModelIds,\s*listedIds: models\.map\(\(model\) => model\.id\),\s*selectedIds: selected,\s*\}\)/);
});

test("编辑 provider 保存：先改 provider，再加勾上的新行，最后删取消勾选的旧行", () => {
  const body = componentFunctionBody(providerDialogSource, "submit");
  assert.match(body, /await updateProvider\(\{/);
  assert.match(body, /response = await addCustomModels\(\{[\s\S]{0,400}models: toAdd\.map/);
  assert.match(body, /for \(const modelId of toRemove\) \{\s*response = await removeCustomModel\(providerId, modelId\);/);
  // 顺序要紧：桥认「同一家」看的是 baseUrl，先把地址改掉，新加的模型才不会落到一个同名的新供应商上
  assert.ok(body.indexOf("await updateProvider(") < body.indexOf("await addCustomModels("), "updateProvider 必须排在加模型之前");
  // 编辑时 key 留空 = 沿用已存的那一份，加模型这步不该再逼一遍
  assert.equal((body.match(/apiKey: apiKey\.trim\(\) \|\| undefined/g) ?? []).length, 2, "update 与 add 两处都该是「留空即沿用」");
  // 但从未存过 key 的一家（手改 models.json 建出来的）要加模型，桥会拒 —— 发请求前先把话说清
  assert.match(body, /if \(toAdd\.length && !apiKey\.trim\(\) && !savedKeyConfigured\) \{\s*setError\(t\("models\.provider\.noKeyBeforeAdd"\)/);
});

test("编辑 provider 的 footer 报明会加几条删几条，删空整家会先警告", () => {
  assert.match(providerDialogSource, /models\.provider\.footerWithChanges/);
  assert.match(providerDialogSource, /summary: summaryLabel\(toAdd\.length, toRemove\.length\)/);
  assert.match(providerDialogSource, /toAdd\.length \|\| toRemove\.length \? t\("models\.add\.applyChanges"\) : t\("models\.provider\.saveChanges"\)/);
  assert.match(providerDialogSource, /removesWholeProvider \? \(\n\s*<p className="settings-card-error"/);
  assert.match(providerDialogSource, /const removesWholeProvider = mode === "edit" && plan\.removesEverything;/);
  assert.match(providerDialogSource, /models\.provider\.removesWholeProvider/);
});

/* ------------------------------------------- 已存的 API key 回填进输入框 */

test("已存的 key 回填到框里（默认密文，点眼睛看明文），且只有单家详情口回传", () => {
  // 桥：单家详情带明文 key；供应商列表口 / discover 都不带（一次吐 40 多家的 key 没必要也不安全）
  assert.match(bridgeSource, /\{ \.\.\.normalized, apiKey: readStoredApiKey\(row\.id\) \}/);
  assert.match(bridgeSource, /provider: row \? \{ \.\.\.row, models: undefined, apiKey: undefined \} : null/);
  // 列表口自己不去读 key（providerCatalogRow 的注释里写着 readStoredApiKey，别把整段注释算进来）
  const catalogStart = bridgeSource.indexOf("function modelProviderCatalog()");
  const catalogBody = bridgeSource.slice(catalogStart, bridgeSource.indexOf("\n}", catalogStart) + 2);
  assert.ok(catalogBody.length > 30, "没抽出 modelProviderCatalog 这一段");
  assert.ok(!catalogBody.includes("readStoredApiKey"), "列表口不该回传明文 key");
  // 前端：类型上有这个字段，两个弹窗都拿它回填（且不清掉用户已经手打的那串）
  assert.match(apiSource, /apiKey\?: string;/);
  assert.match(providerDialogSource, /setApiKey\(row\.apiKey \?\? ""\);/);
  assert.match(addDialogSource, /setApiKey\(\(current\) => \(current\.trim\(\) \? current : row\.apiKey \?\? ""\)\);/);
  // 回填之后默认仍是密文：visible 初值 false，眼睛只负责切 visible
  assert.match(apiKeyFieldSource, /const \[visible, setVisible\] = useState\(false\);/);
  assert.match(apiKeyFieldSource, /type=\{visible \? "text" : "password"\}/);
});

/* ------------------------------------------- 设置页每一家的 Add / Edit / Delete */

test("每一家供应商的组头只有 Edit / Delete：Edit 进 Add model 弹窗并选好这一家，Delete 走应用内确认弹窗", () => {
  // 组头不再单独放 Add（用户定的）：加模型、改供应商都在「Add model」那一屏里，一颗 Edit 就够。
  assert.match(panelSource, /function openModelPicker\(providerId: string\) \{\s*setPickerProviderId\(providerId\);\s*setAdding\(true\);/);
  assert.doesNotMatch(panelSource, /aria-label=\{`Add models to /, "组头不该再有单独的 Add（和 Edit 是同一个去处）");
  assert.equal((panelSource.match(/onClick=\{\(\) => openModelPicker\(group\.providerId\)\}/g) ?? []).length, 1,
    "只有 Edit 走 openModelPicker");
  assert.match(panelSource, /aria-label=\{t\("models\.row\.editGroupAria", \{ name: group\.providerName \}\)\}/);
  assert.match(panelSource, /aria-label=\{t\("models\.row\.deleteGroupAria", \{ name: group\.providerName \}\)\}/);
  assert.match(panelSource, /onClick=\{\(\) => setPendingGroupRemoval\(group\)\}/);
  // 删整家 = 这一家所有模型行一起走；最后一条删完时桥连供应商一起收走
  assert.match(panelSource, /async function handleRemoveGroup\(group: CustomEntryGroup\) \{[\s\S]{0,500}for \(const entry of group\.entries\) \{\s*response = await removeCustomModel\(entry\.providerId, entry\.model\);/);
  // 确认是弹窗（就地换按钮会让组头忽长忽短），标题写清删哪家几条、描述写清动哪个文件
  assert.match(panelSource, /open=\{Boolean\(pendingGroupRemoval \|\| pendingRemoval\)\}/);
  assert.match(panelSource, /models\.delete\.groupTitle[\s\S]{0,200}\{ name: pendingGroupRemoval\.providerName, count: pendingGroupRemoval\.entries\.length \}\)/);
  assert.match(panelSource, /models\.delete\.groupDesc[\s\S]{0,240}path: modelsPath \}\)/);
  assert.match(panelSource, /if \(pendingGroupRemoval\) \{\s*void handleRemoveGroup\(pendingGroupRemoval\);/);
  // 取消不能留半个待删状态：两条 pending 一起清
  assert.match(panelSource, /onClick=\{\(\) => \{\s*setPendingGroupRemoval\(null\);\s*setPendingRemoval\(null\);\s*\}\}/);
  assert.match(cssSource, /\.settings-group-actions \{[^}]*margin-left:\s*auto;/);
});

test("Add model 弹窗能被带着供应商打开（从某一组点进来不用再挑一遍）", () => {
  assert.match(addDialogSource, /initialProviderId = ""/);
  assert.match(addDialogSource, /initialProviderId\?: string;/);
  assert.match(addDialogSource, /useEffect\(\(\) => \{[\s\S]{0,400}setProviderId\(initialProviderId\);/);
  assert.match(panelSource, /initialProviderId=\{pickerProviderId \?\? ""\}/);
  // 关掉弹窗要把它清掉：否则下次从顶上「Add model」进来还停在上一家
  assert.match(panelSource, /setAdding\(false\);\s*setPickerProviderId\(null\);/);
});
