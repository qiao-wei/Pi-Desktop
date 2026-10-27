import http from "node:http";
import { createBridgeDomains } from "./domains.mjs";
import { ROUTES, matchRoute } from "./routeTable.mjs";





import { randomUUID } from "node:crypto";

















































import { respondToPreflight, setCors } from "./cors.mjs";

import {
  bridgeUrlAnnouncement,
  bridgeUrlFor,
  shouldRetryWithEphemeralPort,
} from "./bridgeListen.mjs";
// 桥对内核的每一次引用都走这一个门（见 server/piKernel.mjs 与 docs/architecture/protocols.md）。
// 其中两个入口不在内核的公共 exports 里，只能按相对路径进 dist；把它们锁在这个文件里，
// 版本升级时失败会发生在启动那一刻，而不是某个请求处理器深处。











import { errorDetails, sessionRuntimeKey, sendJson } from "./smallHelpers.mjs";
import { diagnosticLog } from "./sessionStoreFactory.mjs";
import { createBridgeBoot } from "./boot.mjs";
// 已抽到: server/boot.mjs
// The bridge owns its port: prefer 6474, take any free one when that is taken. Hosts discover the
// result on stdout instead of each inventing their own port policy.
// 已抽到: server/boot.mjs
/**
 * 各域工厂的依赖袋由 `server/domainContainer.mjs` 自己持有（外部注入的常量作为初始袋），
 * 入口不再维护这个对象：装配时按名字解构、跨域引用生成转发函数这些事都在容器里。
 */

/**
 * 启动块：路径/环境常量 + `state` + PI 运行时装配。
 *
 * **必须在组合区之前调用** —— 组合区的域工厂在建立时就要注入这些值（`agentDir`、`openRuntimes`…），
 * 而它们自己又只能排在这些值之后。启动工厂只返回这些东西；共享的 `deps` 容器在下面才声明。
 */
const boot = await createBridgeBoot();
const { state } = boot;
const { sessionStore, activePackageCommands, agentSkillsDir, agentsSkillsDir, appCwd, appPackagesDir, appSkillsDir, authFile, capabilitiesConfigVersion, capabilitiesDefaultsFile, capabilitiesFile, commandRunsFile, directoryMimeType, extensionUiAnsiAccent, generatedTitleMaxChars, host, hostSystemPrompt, http429StatusPatterns, maxAttachmentBytes, maxAttachmentCount, maxAttachmentTotalBytes, mcpToolProbeTimeoutMs, modelLoginBroker, modelRuntime, modelsJsonFile, normalizeExtensionUiMode, normalizePersonalizationStyle, openRuntimes, personalizationFile, personalizationStyles, piDesktopCapabilitiesCustomType, portWasRequested, projectAttachmentRoot, projectsFile, requestedPort, searchDocumentCache, searchDocumentCacheLimit } = boot;

// 会话搜索缓存（纯内存结构）+ 上限：同样因为组合区在前面而提前声明。
// 已抽到: server/boot.mjs
// 探针超时（纯环境变量表达式）：域工厂的组合区在文件中部就创建了，所以提到前面来。
// 已抽到: server/boot.mjs
// pi 的交互模式组件在无头宿主里也会碰模块级 theme 代理：/end-review 的总结加载器
// （BorderedLoader 构造函数 → keyHint → theme.fg）一碰就抛
// "Theme not initialized. Call initTheme() first."。TUI 启动时会 initTheme()，
// 桥是无头宿主，必须自己补上；enableWatcher 关掉（没有终端可监听背景色）。
/* deps 声明已上移到文件顶部的启动块处（组合区要填的就是那一个对象）。 */

// 已打开的运行时（Map 本身要在组合区之前存在：多个域会注入它），内容等组合区之后再填。
// 已抽到: server/boot.mjs
// 包命令注册表（纯内存结构）：要早于组合区，因为技能/包域在组合时就注入它。
// 已抽到: server/boot.mjs
/**
 * 组合区：把各域工厂建起来（见 `server/domains.mjs` / `server/domainContainer.mjs`），
 * 只解构**入口自己用得到**的名字 —— 域之间通过容器里的共享袋互相取用，不经过这里。
 */
const domains = createBridgeDomains(state, { activePackageCommands, agentSkillsDir, agentsSkillsDir, appCwd, appPackagesDir, appSkillsDir, authFile, capabilitiesConfigVersion, capabilitiesDefaultsFile, capabilitiesFile, commandRunsFile, directoryMimeType, extensionUiAnsiAccent, generatedTitleMaxChars, hostSystemPrompt, http429StatusPatterns, maxAttachmentBytes, maxAttachmentCount, maxAttachmentTotalBytes, mcpToolProbeTimeoutMs, modelLoginBroker, modelRuntime, modelsJsonFile, normalizeExtensionUiMode, normalizePersonalizationStyle, openRuntimes, personalizationFile, personalizationStyles, piDesktopCapabilitiesCustomType, projectAttachmentRoot, projectsFile, searchDocumentCache, searchDocumentCacheLimit, sessionStore });
/* 入口自己用得到的导出（路由处理器不在这里解构：路由表按名字从 `domains` 取）。 */
const { activeProject, createRuntime, updateSessionStoreFromRuntime } = domains;

/**
 * 路由表里写的是处理器的**名字**（表是纯数据，不 import 处理器）。名字对不上就是一条
 * 永远 404 的死路由 —— 所以在启动时一次性核对，宁可起不来也不要等用户点到它。
 */
const unrouted = ROUTES.filter((route) => typeof domains[route.handler] !== "function");
if (unrouted.length > 0) {
  throw new Error(
    `路由表指向了组合区没有的处理器：${unrouted
      .map((route) => `${route.method} ${route.path} → ${route.handler}`)
      .join("、")}`,
  );
}
/* ── 组合区结束 ── */
/* ── 组合区之后：这些急切调用会用上刚建好的域 ─────────────────────────────
 * `createRuntime` 内部要调能力域的函数（解析能力路径等），所以必须等工厂建完再跑；
 * `updateSessionStoreFromRuntime` 同理（它本身就是会话快照域的导出）。
 */
state.runtime = await createRuntime(activeProject());
openRuntimes.set(sessionRuntimeKey(state.runtime.session.sessionFile), state.runtime);
updateSessionStoreFromRuntime(state.runtime);

// 已抽到: server/sessionSnapshots.mjs
/** @type {Promise<unknown>} 串行化队列；自身值不重要，重要的是 then 的排队语义 */
state.skillReloadQueue = Promise.resolve();
const server = http.createServer(async (req, res) => {
  setCors(res);

  if (respondToPreflight(req, res)) {
    return;
  }

  const url = new URL(req.url ?? "/", state.apiBase);
  const requestId = randomUUID();
  const clientTraceId = String(req.headers["x-pi-desktop-trace-id"] ?? "").trim() || undefined;
  const requestStartedAt = Date.now();
  // 请求级上下文：这些量在整条回调里只读，处理器函数通过它拿到（见 .scratch/branch-to-handlers.mjs）。
  const ctx = { clientTraceId, req, requestId, requestStartedAt, res, url };
  const shouldTraceRequest = url.pathname === "/api/bootstrap" || url.pathname === "/api/stop" || url.pathname === "/api/prompt" || url.pathname === "/api/sessions/select";

  if (shouldTraceRequest) {
    diagnosticLog("http.request.start", {
      requestId,
      clientTraceId,
      method: req.method,
      path: url.pathname,
    });
  }

  try {
    // 路由是数据（`server/routeTable.mjs`）：先按方法 + 路径匹配，再按名字从组合区取处理器。
    const route = matchRoute(req.method, url.pathname);
    if (route) return await domains[route.handler](ctx);

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (shouldTraceRequest) {
      diagnosticLog("http.request.error", {
        requestId,
        method: req.method,
        path: url.pathname,
        durationMs: Date.now() - requestStartedAt,
        ...errorDetails(error),
      });
    }
    if (!res.headersSent) {
      sendJson(res, 500, { error: message, requestId: shouldTraceRequest ? requestId : undefined });
      return;
    }
    res.write(`${JSON.stringify({ type: "error", message })}\n`);
    res.end();
  }
});

function startListening(listenPort) {
  server.listen(listenPort, host, () => {
    // The OS-assigned port is only known after binding; everything downstream (URLs handed to the
    // renderer, attachment links, WebSocket origins) reads apiBase, so it must say the truth.
    const bound = server.address();
    state.port = typeof bound === "object" && bound ? bound.port : listenPort;
    state.apiBase = bridgeUrlFor(host, state.port);
    diagnosticLog("server.listening", { apiBase: state.apiBase, port: state.port });
    console.log(`Pi Desktop bridge running at ${state.apiBase}`);
    console.log(bridgeUrlAnnouncement(state.apiBase));
  });
}

server.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  diagnosticLog("server.listen.error", { ...errorDetails(error), port: state.port });
  if (shouldRetryWithEphemeralPort(error, portWasRequested)) {
    console.error(`Pi Desktop bridge: port ${state.port} is in use; listening on any free port instead`);
    startListening(0);
    return;
  }
  console.error(`Pi Desktop bridge failed to listen on ${state.apiBase}: ${message}`);
  process.exit(1);
});

startListening(requestedPort);

process.on("SIGINT", () => {
  diagnosticLog("process.signal", { signal: "SIGINT" });
  sessionStore.close();
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  diagnosticLog("process.signal", { signal: "SIGTERM" });
  sessionStore.close();
  server.close(() => process.exit(0));
});

// 已抽到: server/runtimeDomain.mjs
/* ------------------------------- 工具开关 ------------------------------- */

// 已抽到: server/mcpServers.mjs
// pi never fails loudly when a configured package silently does not reach the session, so
// the panel used to report "loaded" off the selection set alone. Diff the real load result
// against the previous one and shout once per change instead of storing it in a log nobody reads.
// 已抽到: server/skillLeaves.mjs
// A managed skill can only be judged against the pre-resolved inventory. If pi's loader
// discovers one that pass never saw, the two disagree; keep it (fail open) and say so
// once, instead of letting the override silently delete a capability.
// 已抽到: server/skillLeaves.mjs
// 内置 provider id 只认 pi 自己的目录，models.json 里的条目不算。
// 构造 40 多个 provider 对象不便宜，算一次记住；失败也不重算（下次重启进程才有新目录）。
state.builtInProviderIdCache = null;
// ↓ 已抽到 server/modelLeaves.mjs
// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesProjects.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs


// ↓ 已抽到 server/routesApp.mjs

