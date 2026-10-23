import { parseChatBubbleId } from "../src/shared/chatBubbles.ts";
import { assertBridgePayload } from "../src/shared/protocol/bridgeMessages.ts";
import { normalizeSearchQuery } from "../src/shared/sessionSearch.ts";
import { parseMcpImportRequest } from "./capabilityMetadata.mjs";
import { requestModelListing, resolveListingApiKey } from "./customModels.mjs";
import { sanitizeDiagnosticDetails, sessionDetails } from "./diagnosticsHelpers.mjs";
import { readJson, sendBootstrapJson } from "./httpHelpers.mjs";
import { PROTOCOL_VERSION } from "./protocolVersion.mjs";
import { diagnosticLog } from "./sessionStoreFactory.mjs";
import { searchResultLimit, sendJson } from "./smallHelpers.mjs";

/**
 * 能力/技能/模型/供应商/附件等 路由处理器
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createRoutesApp(state, deps) {
  const { modelLoginBroker, modelRuntime } = deps;
  const addCapabilityExtension = /** @type {any} */ ((...args) => deps.addCapabilityExtension(...args));
  const buildAmbientSnapshot = /** @type {any} */ ((...args) => deps.buildAmbientSnapshot(...args));
  const buildCapabilitiesSnapshot = /** @type {any} */ ((...args) => deps.buildCapabilitiesSnapshot(...args));
  const buildSnapshot = /** @type {any} */ ((...args) => deps.buildSnapshot(...args));
  const customModelsPayload = /** @type {any} */ ((...args) => deps.customModelsPayload(...args));
  const deleteCustomModel = /** @type {any} */ ((...args) => deps.deleteCustomModel(...args));
  const deleteSkillFromCapabilityPage = /** @type {any} */ ((...args) => deps.deleteSkillFromCapabilityPage(...args));
  const discoverProviderModels = /** @type {any} */ ((...args) => deps.discoverProviderModels(...args));
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));
  const importSkillFromCapabilityPage = /** @type {any} */ ((...args) => deps.importSkillFromCapabilityPage(...args));
  const inspectMcpServerCapability = /** @type {any} */ ((...args) => deps.inspectMcpServerCapability(...args));
  const installCapabilityPackage = /** @type {any} */ ((...args) => deps.installCapabilityPackage(...args));
  const listAvailableModels = /** @type {any} */ ((...args) => deps.listAvailableModels(...args));
  const modelProviderCatalog = /** @type {any} */ ((...args) => deps.modelProviderCatalog(...args));
  const providerCatalogRow = /** @type {any} */ ((...args) => deps.providerCatalogRow(...args));
  const readCapabilityCommandArguments = /** @type {any} */ ((...args) => deps.readCapabilityCommandArguments(...args));
  const readCapabilityPackageFile = /** @type {any} */ ((...args) => deps.readCapabilityPackageFile(...args));
  const readCapabilityPackageResources = /** @type {any} */ ((...args) => deps.readCapabilityPackageResources(...args));
  const readMcpServerCapability = /** @type {any} */ ((...args) => deps.readMcpServerCapability(...args));
  const readSkillContent = /** @type {any} */ ((...args) => deps.readSkillContent(...args));
  const readStoredApiKey = /** @type {any} */ ((...args) => deps.readStoredApiKey(...args));
  const refreshSnapshot = /** @type {any} */ ((...args) => deps.refreshSnapshot(...args));
  const reloadCustomModelProviders = /** @type {any} */ ((...args) => deps.reloadCustomModelProviders(...args));
  const reloadPiDesktopSkills = /** @type {any} */ ((...args) => deps.reloadPiDesktopSkills(...args));
  const removeCapabilityExtension = /** @type {any} */ ((...args) => deps.removeCapabilityExtension(...args));
  const removeCapabilityPackage = /** @type {any} */ ((...args) => deps.removeCapabilityPackage(...args));
  const removeMcpServer = /** @type {any} */ ((...args) => deps.removeMcpServer(...args));
  const repairDefaultModelAfterRemoval = /** @type {any} */ ((...args) => deps.repairDefaultModelAfterRemoval(...args));
  const respondToExtensionUiRequest = /** @type {any} */ ((...args) => deps.respondToExtensionUiRequest(...args));
  const runBuiltinCommand = /** @type {any} */ ((...args) => deps.runBuiltinCommand(...args));
  const saveCustomModel = /** @type {any} */ ((...args) => deps.saveCustomModel(...args));
  const saveMcpServer = /** @type {any} */ ((...args) => deps.saveMcpServer(...args));
  const saveProviderApiKey = /** @type {any} */ ((...args) => deps.saveProviderApiKey(...args));
  const saveToolSettings = /** @type {any} */ ((...args) => deps.saveToolSettings(...args));
  const searchSessionDocuments = /** @type {any} */ ((...args) => deps.searchSessionDocuments(...args));
  const sendAttachment = /** @type {any} */ ((...args) => deps.sendAttachment(...args));
  const sendLocalMedia = /** @type {any} */ ((...args) => deps.sendLocalMedia(...args));
  const setCapabilityPinned = /** @type {any} */ ((...args) => deps.setCapabilityPinned(...args));
  const setDefaultCapability = /** @type {any} */ ((...args) => deps.setDefaultCapability(...args));
  const setModelConfiguration = /** @type {any} */ ((...args) => deps.setModelConfiguration(...args));
  const setPersonalization = /** @type {any} */ ((...args) => deps.setPersonalization(...args));
  const setSessionExtensionCapability = /** @type {any} */ ((...args) => deps.setSessionExtensionCapability(...args));
  const setSessionPackageCapability = /** @type {any} */ ((...args) => deps.setSessionPackageCapability(...args));
  const setSessionSkillCapability = /** @type {any} */ ((...args) => deps.setSessionSkillCapability(...args));
  const setSessionThinkingLevel = /** @type {any} */ ((...args) => deps.setSessionThinkingLevel(...args));
  const stopSession = /** @type {any} */ ((...args) => deps.stopSession(...args));
  const streamCapabilityPackageAction = /** @type {any} */ ((...args) => deps.streamCapabilityPackageAction(...args));
  const streamCapabilityPackageCommand = /** @type {any} */ ((...args) => deps.streamCapabilityPackageCommand(...args));
  const streamModelLogin = /** @type {any} */ ((...args) => deps.streamModelLogin(...args));
  const streamPrompt = /** @type {any} */ ((...args) => deps.streamPrompt(...args));
  const testCustomModelConnection = /** @type {any} */ ((...args) => deps.testCustomModelConnection(...args));
  const updateCapabilityPackage = /** @type {any} */ ((...args) => deps.updateCapabilityPackage(...args));
  const updateProvider = /** @type {any} */ ((...args) => deps.updateProvider(...args));

/** 路由处理器：req.method === "GET" && url.pathname === "/api/protocol"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_get_api_protocol(ctx) {
      // 握手：哪个协议版本的 bridge 在应答。刻意不构建快照（那要几百 KB 和一次 md5），
      // 所以渲染进程可以在接管任何状态之前、用最便宜的一条请求先问清楚。
      sendJson(ctx.res, 200, { protocolVersion: PROTOCOL_VERSION, pid: process.pid });
      return;
}

/** 路由处理器：req.method === "GET" && url.pathname === "/api/bootstrap"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_get_api_bootstrap(ctx) {
      // `?view=ambient` is the watchdog shape: everything that moves independently of
      // the transcript, and none of the transcript. See `buildAmbientSnapshot`.
      if (ctx.url.searchParams.get("view") === "ambient") {
        sendJson(ctx.res, 200, assertBridgePayload(buildAmbientSnapshot(state.runtime), "ambient"));
        return;
      }
      diagnosticLog("bootstrap.start", { requestId: ctx.requestId, sessionPath: state.runtime.session.sessionFile, ...sessionDetails(state.runtime) });
      const snapshot = await refreshSnapshot();
      diagnosticLog("bootstrap.success", {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.requestStartedAt,
        ...sessionDetails(state.runtime),
        streamingSessionPaths: snapshot.streamingSessionPaths,
        compactingSessionPaths: snapshot.compactingSessionPaths,
      });
      sendBootstrapJson(ctx.res, ctx.req, snapshot);
      return;
}

/** 路由处理器：req.method === "GET" && url.pathname === "/api/search"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_get_api_search(ctx) {
      const startedAt = Date.now();
      const query = normalizeSearchQuery(ctx.url.searchParams.get("q"));
      const limit = searchResultLimit(ctx.url.searchParams.get("limit"));
      // 空查询直接短路：扫全部会话文件是这个接口最贵的部分，不该被“清空输入框”触发。
      const payload = query
        ? await searchSessionDocuments(query, limit)
        : { results: [], truncated: false };
      diagnosticLog("search.query", {
        requestId: ctx.requestId,
        query,
        resultCount: payload.results.length,
        truncated: payload.truncated,
        durationMs: Date.now() - startedAt,
      });
      sendJson(ctx.res, 200, { query, ...payload });
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/diagnostic"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_diagnostic(ctx) {
      const body = await readJson(ctx.req);
      diagnosticLog("client.report", {
        requestId: ctx.requestId,
        clientEvent: String(body?.event ?? "unknown").slice(0, 120),
        details: sanitizeDiagnosticDetails(body?.details),
      });
      sendJson(ctx.res, 200, { ok: true });
      return;
}

/** 路由处理器：req.method === "GET" && url.pathname === "/api/models"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_get_api_models(ctx) {
      sendJson(ctx.res, 200, {
        availableModels: listAvailableModels(),
        providerIds: modelRuntime.getRegisteredProviderIds(),
      });
      return;
}

/** 路由处理器：req.method === "GET" && url.pathname === "/api/capabilities"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_get_api_capabilities(ctx) {
      sendJson(ctx.res, 200, await buildCapabilitiesSnapshot(state.runtime));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/default"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_default(ctx) {
      const body = await readJson(ctx.req);
      const result = await setDefaultCapability(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/pin"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_pin(ctx) {
      const body = await readJson(ctx.req);
      const result = await setCapabilityPinned(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/session/skill"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_session_skill(ctx) {
      const body = await readJson(ctx.req);
      const result = await setSessionSkillCapability(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/session/package"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_session_package(ctx) {
      const body = await readJson(ctx.req);
      const result = await setSessionPackageCapability(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/session/extension"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_session_extension(ctx) {
      const body = await readJson(ctx.req);
      const result = await setSessionExtensionCapability(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/skills/import"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_skills_import(ctx) {
      const body = await readJson(ctx.req);
      const result = await importSkillFromCapabilityPage(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/skills/delete"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_skills_delete(ctx) {
      const body = await readJson(ctx.req);
      const result = await deleteSkillFromCapabilityPage(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/package/install"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_package_install(ctx) {
      await streamCapabilityPackageAction(ctx.req, ctx.res, (body, onProgress) => installCapabilityPackage(body, onProgress));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/package/remove"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_package_remove(ctx) {
      const body = await readJson(ctx.req);
      const result = await removeCapabilityPackage(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/package/update"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_package_update(ctx) {
      await streamCapabilityPackageAction(ctx.req, ctx.res, (body, onProgress) => updateCapabilityPackage(body, onProgress));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/package/resources"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_package_resources(ctx) {
      const body = await readJson(ctx.req);
      const result = await readCapabilityPackageResources(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/package/file"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_package_file(ctx) {
      const body = await readJson(ctx.req);
      const result = await readCapabilityPackageFile(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/package/command/arguments"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_package_command_arguments(ctx) {
      await readCapabilityCommandArguments(ctx.req, ctx.res);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/package/command"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_package_command(ctx) {
      await streamCapabilityPackageCommand(ctx.req, ctx.res);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/builtin-command"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_builtin_command(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, await runBuiltinCommand(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/extension/add"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_extension_add(ctx) {
      const body = await readJson(ctx.req);
      const result = await addCapabilityExtension(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/extension/remove"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_extension_remove(ctx) {
      const body = await readJson(ctx.req);
      const result = await removeCapabilityExtension(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/mcp/save"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_mcp_save(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, await saveMcpServer(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/mcp/remove"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_mcp_remove(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, await removeMcpServer(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/mcp/inspect"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_mcp_inspect(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, await inspectMcpServerCapability(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/mcp/read"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_mcp_read(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, readMcpServerCapability(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/capabilities/mcp/import"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_capabilities_mcp_import(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, parseMcpImportRequest(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/tools/settings"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_tools_settings(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, await saveToolSettings(body));
      return;
}

/** 路由处理器：req.method === "GET" && url.pathname === "/api/skills/content"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_get_api_skills_content(ctx) {
      const result = readSkillContent(String(ctx.url.searchParams.get("path") ?? ""));
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "GET" && url.pathname === "/api/attachments"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_get_api_attachments(ctx) {
      sendAttachment(ctx.res, String(ctx.url.searchParams.get("path") ?? ""));
      return;
}

/** 路由处理器：req.method === "GET" && url.pathname === "/api/local-media"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_get_api_local_media(ctx) {
      sendLocalMedia(ctx.res, String(ctx.url.searchParams.get("path") ?? ""), ctx.req.headers.range);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/skills/reload"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_skills_reload(ctx) {
      const result = await reloadPiDesktopSkills({ scope: "all" });
      sendJson(ctx.res, 200, {
        ...result,
        snapshot: await refreshSnapshot(),
      });
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/extension-ui/response"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_extension_ui_response(ctx) {
      const body = await readJson(ctx.req);
      const result = await respondToExtensionUiRequest(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "GET" && url.pathname === "/api/custom-models"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_get_api_custom_models(ctx) {
      sendJson(ctx.res, 200, customModelsPayload());
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/custom-models"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_custom_models(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, await saveCustomModel(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/custom-models/remove"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_custom_models_remove(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, await deleteCustomModel(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/custom-models/reload"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_custom_models_reload(ctx) {
      await readJson(ctx.req);
      // 不列 provider = 全量重建：手删掉的供应商也能从 runtime 里清出去。
      await reloadCustomModelProviders([]);
      repairDefaultModelAfterRemoval();
      sendJson(ctx.res, 200, { ...customModelsPayload(), availableModels: listAvailableModels() });
      return;
}

/** 路由处理器：req.method === "GET" && url.pathname === "/api/model-providers"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_get_api_model_providers(ctx) {
      sendJson(ctx.res, 200, { providers: modelProviderCatalog() });
      return;
}

/** 路由处理器：req.method === "GET" && url.pathname.startsWith("/api/model-providers/")（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_get_api_model_providers_x(ctx) {
      const pathParts = ctx.url.pathname.split("/").filter(Boolean);
      if (pathParts.length === 3) {
        const providerId = decodeURIComponent(pathParts[2]);
        const row = providerCatalogRow(providerId);
        if (!row) {
          sendJson(ctx.res, 404, { error: "Provider not found." });
          return;
        }
        sendJson(ctx.res, 200, row);
        return;
      }
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/model-providers/discover"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_model_providers_discover(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, await discoverProviderModels(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname.endsWith("/verify-key")（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post(ctx) {
      const pathParts = ctx.url.pathname.split("/").filter(Boolean);
      if (pathParts.length === 4 && pathParts[1] === "model-providers" && pathParts[3] === "verify-key") {
        const providerId = decodeURIComponent(pathParts[2]);
        const body = await readJson(ctx.req);
        // 留空 = 验已存的那份（“我存的还能用吗”），填了 = 验新填的。
        const apiKey = resolveListingApiKey({ apiKey: body?.apiKey, storedKey: readStoredApiKey(providerId) });
        if (!apiKey) {
          sendJson(ctx.res, 200, { ok: false, error: "Enter an API key first." });
          return;
        }
        const row = providerCatalogRow(providerId);
        if (!row) {
          sendJson(ctx.res, 200, { ok: false, error: "Unknown provider." });
          return;
        }
        const api = row.api || row.models?.[0]?.api || "openai-completions";
        // 没端点可探（Bedrock / Vertex 这类）就别假装在验 key，说清楚它靠 pi 自己的凭证。
        if (!String(row.baseUrl ?? "").trim()) {
          sendJson(ctx.res, 200, {
            ok: false,
            api,
            models: [],
            error: "This provider is built into pi and has no endpoint to check a key against \u2014 pi signs its requests itself.",
          });
          return;
        }
        const result = await requestModelListing({ api, baseUrl: row.baseUrl, apiKey });
        sendJson(ctx.res, 200, result);
        return;
      }
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/model-providers/update"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_model_providers_update(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, await updateProvider(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/model-providers/login/respond"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_model_providers_login_respond(ctx) {
      const body = await readJson(ctx.req);
      const ok = modelLoginBroker.respond(body?.promptId, body?.value, { cancelled: Boolean(body?.cancelled) });
      sendJson(ctx.res, 200, { ok });
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/model-providers/login/cancel"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_model_providers_login_cancel(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, { ok: modelLoginBroker.cancel(body?.sessionId) });
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname.endsWith("/logout")（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_x(ctx) {
      const pathParts = ctx.url.pathname.split("/").filter(Boolean);
      if (pathParts.length === 4 && pathParts[1] === "model-providers" && pathParts[3] === "logout") {
        const providerId = decodeURIComponent(pathParts[2]);
        if (!modelRuntime.getProvider(providerId)) {
          sendJson(ctx.res, 200, { ok: false, error: "Unknown provider." });
          return;
        }
        await modelRuntime.logout(providerId, { signal: AbortSignal.timeout(15_000) });
        sendJson(ctx.res, 200, { ok: true, providers: modelProviderCatalog() });
        return;
      }
}

/** 路由处理器：req.method === "POST" && url.pathname.endsWith("/login")（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_x_x(ctx) {
      const pathParts = ctx.url.pathname.split("/").filter(Boolean);
      if (pathParts.length === 4 && pathParts[1] === "model-providers" && pathParts[3] === "login") {
        const providerId = decodeURIComponent(pathParts[2]);
        await streamModelLogin(ctx.req, ctx.res, providerId, ctx.requestId);
        return;
      }
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/custom-models/key"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_custom_models_key(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, await saveProviderApiKey(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/custom-models/test"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_custom_models_test(ctx) {
      const body = await readJson(ctx.req);
      sendJson(ctx.res, 200, await testCustomModelConnection(body));
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/model"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_model(ctx) {
      const body = await readJson(ctx.req);
      const result = await setModelConfiguration(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/personalization"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_personalization(ctx) {
      const body = await readJson(ctx.req);
      const result = await setPersonalization(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/thinking-level"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_thinking_level(ctx) {
      const body = await readJson(ctx.req);
      const result = await setSessionThinkingLevel(body);
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/compact"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_compact(ctx) {
      const body = await readJson(ctx.req);
      const targetRuntime = getRuntimeForRequest(body);
      if (targetRuntime.session.isStreaming || targetRuntime.session.isCompacting) {
        throw new Error("Stop the running response before compacting context.");
      }
      const result = await targetRuntime.session.compact(body?.instructions?.trim() || undefined);
      sendJson(ctx.res, 200, {
        result,
        snapshot: await buildSnapshot(targetRuntime),
      });
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/stop"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_stop(ctx) {
      const body = await readJson(ctx.req);
      const targetRuntime = getRuntimeForRequest(body);
      const result = await stopSession(targetRuntime, {
        clearQueues: body?.clearQueues !== false,
        requestId: ctx.requestId,
      });
      diagnosticLog("http.request.success", {
        requestId: ctx.requestId,
        path: ctx.url.pathname,
        durationMs: Date.now() - ctx.requestStartedAt,
        ...sessionDetails(targetRuntime),
      });
      sendJson(ctx.res, 200, result);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/prompt"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_prompt(ctx) {
      await streamPrompt(ctx.req, ctx.res, ctx.requestId);
      return;
}

/** 路由处理器：req.method === "POST" && url.pathname === "/api/messages/edit"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
async function handle_post_api_messages_edit(ctx) {
      // 编辑重发 = 先把 pi 的分支 leaf 退回该轮之前（`navigateTree`，append-only，
      // 旧条目留在会话文件里所以用量累计不受影响），再用新内容正常 prompt。
      const body = await readJson(ctx.req);
      const ref = parseChatBubbleId(String(body?.targetMessageId ?? ""));
      if (!ref || ref.role !== "user") {
        throw new Error("targetMessageId must be a user bubble id like t3#user.");
      }
      await streamPrompt(ctx.req, ctx.res, ctx.requestId, { body, rewindTurn: ref.turn });
      return;
}

  return { handle_get_api_attachments, handle_get_api_bootstrap, handle_get_api_capabilities, handle_get_api_custom_models, handle_get_api_local_media, handle_get_api_model_providers, handle_get_api_model_providers_x, handle_get_api_models, handle_get_api_protocol, handle_get_api_search, handle_get_api_skills_content, handle_post, handle_post_api_builtin_command, handle_post_api_capabilities_default, handle_post_api_capabilities_extension_add, handle_post_api_capabilities_extension_remove, handle_post_api_capabilities_mcp_import, handle_post_api_capabilities_mcp_inspect, handle_post_api_capabilities_mcp_read, handle_post_api_capabilities_mcp_remove, handle_post_api_capabilities_mcp_save, handle_post_api_capabilities_package_command, handle_post_api_capabilities_package_command_arguments, handle_post_api_capabilities_package_file, handle_post_api_capabilities_package_install, handle_post_api_capabilities_package_remove, handle_post_api_capabilities_package_resources, handle_post_api_capabilities_package_update, handle_post_api_capabilities_pin, handle_post_api_capabilities_session_extension, handle_post_api_capabilities_session_package, handle_post_api_capabilities_session_skill, handle_post_api_capabilities_skills_delete, handle_post_api_capabilities_skills_import, handle_post_api_compact, handle_post_api_custom_models, handle_post_api_custom_models_key, handle_post_api_custom_models_reload, handle_post_api_custom_models_remove, handle_post_api_custom_models_test, handle_post_api_diagnostic, handle_post_api_extension_ui_response, handle_post_api_messages_edit, handle_post_api_model, handle_post_api_model_providers_discover, handle_post_api_model_providers_login_cancel, handle_post_api_model_providers_login_respond, handle_post_api_model_providers_update, handle_post_api_personalization, handle_post_api_prompt, handle_post_api_skills_reload, handle_post_api_stop, handle_post_api_thinking_level, handle_post_api_tools_settings, handle_post_x, handle_post_x_x };
}
