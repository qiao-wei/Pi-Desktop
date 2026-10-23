import { collectExtensionEntries } from "./capabilityMetadata.mjs";
import { isProbablyKeyValue, normalizeProviderCatalog, parseModelsConfig } from "./customModels.mjs";
import { statMaybeDirectory } from "./packageHelpers.mjs";
import { builtinProviders } from "./piKernel.mjs";
import { agentDir } from "./sessionStoreFactory.mjs";
import { displayAgentPath, normalizePersonalizationText, writeJsonFile } from "./smallHelpers.mjs";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 模型/供应商/扩展路径叶子（凭证、目录、个性化片段）
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createModelLeaves(state, deps) {
  const { authFile, modelRuntime, modelsJsonFile, normalizeExtensionUiMode, normalizePersonalizationStyle, personalizationFile, personalizationStyles } = deps;
  const activeProject = /** @type {any} */ ((...args) => deps.activeProject(...args));
  const projectContextInstruction = /** @type {any} */ ((...args) => deps.projectContextInstruction(...args));
  const buildSnapshot = /** @type {any} */ ((...args) => deps.buildSnapshot(...args));
  const customModelsPayload = /** @type {any} */ ((...args) => deps.customModelsPayload(...args));
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));
  const providerRows = /** @type {any} */ ((...args) => deps.providerRows(...args));

function createPiDesktopRuntimeExtension(project, workspaceCwd = project.cwd) {
  return {
    name: "pi-desktop-runtime",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        return {
          systemPrompt: [
            event.systemPrompt,
            projectContextInstruction(project, workspaceCwd),
            personalizationInstruction(),
          ].filter(Boolean).join("\n\n"),
        };
      });
    },
  };
}

function extensionDefaultEnabled(config, id) {
  return config.extensions[id]?.defaultEnabled !== false;
}

function extensionPathsForSettings(project, settingsManager) {
  const result = [];
  const global = settingsManager.getGlobalSettings();
  const projectSettings = settingsManager.getProjectSettings();
  for (const path of global.extensions ?? []) {
    if (String(path).startsWith("!")) continue;
    const resolved = resolve(agentDir, String(path));
    result.push(...(statMaybeDirectory(resolved) ? collectExtensionEntries(resolved) : [resolved]));
  }
  for (const path of projectSettings.extensions ?? []) {
    if (String(path).startsWith("!")) continue;
    const resolved = resolve(project.cwd, ".pi", String(path));
    result.push(...(statMaybeDirectory(resolved) ? collectExtensionEntries(resolved) : [resolved]));
  }
  return result;
}

function discoverStandaloneExtensionPaths(project = activeProject(), settingsManager = state.runtime?.settingsManager) {
  const roots = [join(agentDir, "extensions")];
  if (settingsManager?.isProjectTrusted?.() !== false) {
    roots.push(join(project.cwd, ".pi", "extensions"));
  }
  const paths = roots.flatMap(collectExtensionEntries);
  if (settingsManager) paths.push(...extensionPathsForSettings(project, settingsManager));
  return [...new Set(paths.map((path) => resolve(path)).filter((path) => existsSync(path)))];
}

function loadedExtensionReport(targetRuntime = state.runtime) {
  const result = targetRuntime.resourceLoader?.getExtensions?.();
  return {
    loaded: (result?.extensions ?? []).map((extension) => ({
      path: extension.path,
      resolvedPath: extension.resolvedPath,
      tools: [...(extension.tools?.keys?.() ?? [])],
      commands: [...(extension.commands?.keys?.() ?? [])],
    })),
    errors: (result?.errors ?? []).map((error) => ({ path: error.path, error: error.error })),
  };
}

/**
 * 自定义模型读写。文件唯一真相是 `~/.pi/agent/models.json`，这里只负责：
 * 读T解析T只改目标 providerT原子写回T让 runtime 重新加载，不丢注释以外的字段。
 */
function readCustomModelsConfig() {
  const raw = existsSync(modelsJsonFile) ? readFileSync(modelsJsonFile, "utf8") : "";
  return parseModelsConfig(raw, displayAgentPath(modelsJsonFile));
}

function writeCustomModelsConfig(config) {
  mkdirSync(dirname(modelsJsonFile), { recursive: true });
  // 先写同目录临时文件再 rename：中途崩了不会把用户唯一的模型配置留成半截 JSON。
  const tempFile = `${modelsJsonFile}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tempFile, 0o600);
  renameSync(tempFile, modelsJsonFile);
}

function builtInProviderIds() {
  if (state.builtInProviderIdCache) {
    return state.builtInProviderIdCache;
  }
  try {
    state.builtInProviderIdCache = new Set(builtinProviders().map((provider) => provider.id));
  } catch {
    state.builtInProviderIdCache = new Set();
  }
  return state.builtInProviderIdCache;
}

/** 「选择已有供应商」的列表：pi 内置的 + models.json 里已经存过的。 */
function modelProviderCatalog() {
  return normalizeProviderCatalog(providerRows());
}

async function reloadCustomModelProviders(providerIds) {
  const targets = [...new Set(providerIds.filter(Boolean))];
  try {
    await modelRuntime.refresh({ providers: targets.length ? targets : undefined, allowNetwork: false });
  } catch {
    // 加载失败不能吞掉已写入的配置：下一次 bootstrap 会重新拼出可用列表。
  }
}

/** 内置供应商只能改 key：单独一个口，不碰 models.json 里的任何字段。 */
async function saveProviderApiKey(body) {
  const providerId = String(body?.providerId ?? "").trim();
  if (!providerId) {
    throw new Error("Pick a provider first.");
  }
  const apiKey = String(body?.apiKey ?? "").trim();
  if (!apiKey) {
    throw new Error("API key is required.");
  }
  if (!isProbablyKeyValue(apiKey)) {
    throw new Error("The API key must not contain spaces or line breaks.");
  }
  persistModelApiKey(providerId, apiKey);
  return customModelsPayload();
}

function readAuthCredentials() {
  if (!existsSync(authFile)) {
    return {};
  }
  const raw = readFileSync(authFile, "utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid model auth storage.");
  }
  return parsed;
}

function readStoredApiKey(provider) {
  if (!provider) {
    return "";
  }
  const credential = readAuthCredentials()[provider];
  return credential?.type === "api_key" ? String(credential.key ?? "") : "";
}

function dropStoredApiKey(provider) {
  if (!provider || !existsSync(authFile)) {
    return;
  }
  const credentials = readAuthCredentials();
  if (!Object.hasOwn(credentials, provider)) {
    return;
  }
  delete credentials[provider];
  writeFileSync(authFile, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(authFile, 0o600);
}

async function setPersonalization(body) {
  const style = normalizePersonalizationStyle(body?.style);
  const customInstructions = normalizePersonalizationText(body?.customInstructions, 1500, "customInstructions");
  const persona = normalizePersonalizationText(body?.persona, 1000, "persona");
  const extensionUi = normalizeExtensionUiMode(body?.extensionUi);
  state.personalization = { style, customInstructions, persona, extensionUi };
  writeJsonFile(personalizationFile, state.personalization);
  return buildSnapshot(getRuntimeForRequest(body));
}

function persistModelApiKey(provider, apiKey) {
  const credentials = readAuthCredentials();

  credentials[provider] = { type: "api_key", key: apiKey };
  mkdirSync(dirname(authFile), { recursive: true });
  writeFileSync(authFile, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(authFile, 0o600);
}

function personalizationInstruction() {
  const sections = [
    "## User Personalization",
    `Response style: ${personalizationStyles[state.personalization.style]}`,
  ];

  if (state.personalization.persona) {
    sections.push("Persona:", state.personalization.persona);
  }
  if (state.personalization.customInstructions) {
    sections.push("Custom instructions that apply to every conversation:", state.personalization.customInstructions);
  }

  return sections.join("\n");
}

  return { builtInProviderIds, createPiDesktopRuntimeExtension, discoverStandaloneExtensionPaths, dropStoredApiKey, extensionDefaultEnabled, extensionPathsForSettings, loadedExtensionReport, modelProviderCatalog, persistModelApiKey, personalizationInstruction, readAuthCredentials, readCustomModelsConfig, readStoredApiKey, reloadCustomModelProviders, saveProviderApiKey, setPersonalization, writeCustomModelsConfig };
}
