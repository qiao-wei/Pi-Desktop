import http from "node:http";
import { createBridgeDomains } from "./domains.mjs";





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
 * 各域工厂的依赖容器。**同一个对象引用**，组合区里逐域填满；工厂在创建时按名字解构走
 * （跨域引用则生成转发函数，调用时才取），所以组合区要排在非提升的 deps 之后。
 */
const deps = {};

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
 * 组合区：把各域工厂建起来（见 `server/domains.mjs`），只解构**入口自己用得到**的名字 ——
 * 域之间通过共享的 `deps` 互相取用，不经过这里。
 */
const { activeProject, createRuntime, handle_get_api_attachments, handle_get_api_bootstrap, handle_get_api_capabilities, handle_get_api_custom_models, handle_get_api_local_media, handle_get_api_model_providers, handle_get_api_model_providers_x, handle_get_api_models, handle_get_api_projects_commands, handle_get_api_projects_commands_status, handle_get_api_projects_commands_terminals, handle_get_api_projects_git, handle_get_api_protocol, handle_get_api_search, handle_get_api_sessions_worktree, handle_get_api_skills_content, handle_post, handle_post_api_builtin_command, handle_post_api_capabilities_default, handle_post_api_capabilities_extension_add, handle_post_api_capabilities_extension_remove, handle_post_api_capabilities_mcp_import, handle_post_api_capabilities_mcp_inspect, handle_post_api_capabilities_mcp_read, handle_post_api_capabilities_mcp_remove, handle_post_api_capabilities_mcp_save, handle_post_api_capabilities_package_command, handle_post_api_capabilities_package_command_arguments, handle_post_api_capabilities_package_file, handle_post_api_capabilities_package_install, handle_post_api_capabilities_package_remove, handle_post_api_capabilities_package_resources, handle_post_api_capabilities_package_update, handle_post_api_capabilities_pin, handle_post_api_capabilities_session_extension, handle_post_api_capabilities_session_package, handle_post_api_capabilities_session_skill, handle_post_api_capabilities_skills_delete, handle_post_api_capabilities_skills_import, handle_post_api_compact, handle_post_api_custom_models, handle_post_api_custom_models_key, handle_post_api_custom_models_reload, handle_post_api_custom_models_remove, handle_post_api_custom_models_test, handle_post_api_diagnostic, handle_post_api_extension_ui_response, handle_post_api_messages_edit, handle_post_api_model, handle_post_api_model_providers_discover, handle_post_api_model_providers_login_cancel, handle_post_api_model_providers_login_respond, handle_post_api_model_providers_update, handle_post_api_personalization, handle_post_api_projects, handle_post_api_projects_commands, handle_post_api_projects_commands_detect, handle_post_api_projects_commands_reveal_log, handle_post_api_projects_commands_run, handle_post_api_projects_commands_select, handle_post_api_projects_commands_stop, handle_post_api_projects_git_commit, handle_post_api_projects_git_commit_message, handle_post_api_projects_git_conflicts, handle_post_api_projects_git_create_branch, handle_post_api_projects_git_delete_branch, handle_post_api_projects_git_init, handle_post_api_projects_git_merge, handle_post_api_projects_git_open_diff, handle_post_api_projects_git_open_file, handle_post_api_projects_git_pull, handle_post_api_projects_git_push, handle_post_api_projects_git_rename_branch, handle_post_api_projects_git_switch, handle_post_api_projects_pin, handle_post_api_projects_remove, handle_post_api_projects_reorder, handle_post_api_projects_reveal, handle_post_api_projects_select, handle_post_api_projects_trust, handle_post_api_projects_update, handle_post_api_prompt, handle_post_api_sessions, handle_post_api_sessions_archive, handle_post_api_sessions_delete, handle_post_api_sessions_delete_archived, handle_post_api_sessions_pin, handle_post_api_sessions_select, handle_post_api_sessions_update, handle_post_api_sessions_worktree_branch, handle_post_api_sessions_worktree_remove, handle_post_api_sessions_worktree_reveal, handle_post_api_skills_reload, handle_post_api_stop, handle_post_api_thinking_level, handle_post_api_tools_settings, handle_post_x, handle_post_x_x, updateSessionStoreFromRuntime } = createBridgeDomains(state, deps, { activePackageCommands, agentSkillsDir, agentsSkillsDir, appCwd, appPackagesDir, appSkillsDir, authFile, capabilitiesConfigVersion, capabilitiesDefaultsFile, capabilitiesFile, commandRunsFile, directoryMimeType, extensionUiAnsiAccent, generatedTitleMaxChars, hostSystemPrompt, http429StatusPatterns, maxAttachmentBytes, maxAttachmentCount, maxAttachmentTotalBytes, mcpToolProbeTimeoutMs, modelLoginBroker, modelRuntime, modelsJsonFile, normalizeExtensionUiMode, normalizePersonalizationStyle, openRuntimes, personalizationFile, personalizationStyles, piDesktopCapabilitiesCustomType, projectAttachmentRoot, projectsFile, searchDocumentCache, searchDocumentCacheLimit, sessionStore });
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
    if (req.method === "GET" && url.pathname === "/api/protocol") return await handle_get_api_protocol(ctx);

    if (req.method === "GET" && url.pathname === "/api/bootstrap") return await handle_get_api_bootstrap(ctx);

    if (req.method === "GET" && url.pathname === "/api/search") return await handle_get_api_search(ctx);

    if (req.method === "POST" && url.pathname === "/api/diagnostic") return await handle_post_api_diagnostic(ctx);

    if (req.method === "GET" && url.pathname === "/api/models") return await handle_get_api_models(ctx);

    if (req.method === "GET" && url.pathname === "/api/capabilities") return await handle_get_api_capabilities(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/default") return await handle_post_api_capabilities_default(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/pin") return await handle_post_api_capabilities_pin(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/session/skill") return await handle_post_api_capabilities_session_skill(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/session/package") return await handle_post_api_capabilities_session_package(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/session/extension") return await handle_post_api_capabilities_session_extension(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/skills/import") return await handle_post_api_capabilities_skills_import(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/skills/delete") return await handle_post_api_capabilities_skills_delete(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/install") return await handle_post_api_capabilities_package_install(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/remove") return await handle_post_api_capabilities_package_remove(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/update") return await handle_post_api_capabilities_package_update(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/resources") return await handle_post_api_capabilities_package_resources(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/file") return await handle_post_api_capabilities_package_file(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/command/arguments") return await handle_post_api_capabilities_package_command_arguments(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/package/command") return await handle_post_api_capabilities_package_command(ctx);

    if (req.method === "POST" && url.pathname === "/api/builtin-command") return await handle_post_api_builtin_command(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/extension/add") return await handle_post_api_capabilities_extension_add(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/extension/remove") return await handle_post_api_capabilities_extension_remove(ctx);

    // MCP 的写路径：服务器定义进 pi 的 mcp.json（全局 / 项目），app 元数据进 capabilities.json。
    if (req.method === "POST" && url.pathname === "/api/capabilities/mcp/save") return await handle_post_api_capabilities_mcp_save(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/mcp/remove") return await handle_post_api_capabilities_mcp_remove(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/mcp/inspect") return await handle_post_api_capabilities_mcp_inspect(ctx);

    if (req.method === "POST" && url.pathname === "/api/capabilities/mcp/read") return await handle_post_api_capabilities_mcp_read(ctx);

    // 导入：把别家客户端的 JSON 形状（mcpServers / VS Code servers / Zed context_servers ...）
    // 翻译成表单字段回给前端，用户确认后走 /mcp/save 落盘。这里只解析，不写文件。
    if (req.method === "POST" && url.pathname === "/api/capabilities/mcp/import") return await handle_post_api_capabilities_mcp_import(ctx);

    // 「工具开关」（codemode）写的就是 pi 自己的 defaultTools，见 server/toolSettings.mjs。
    if (req.method === "POST" && url.pathname === "/api/tools/settings") return await handle_post_api_tools_settings(ctx);

    if (req.method === "GET" && url.pathname === "/api/skills/content") return await handle_get_api_skills_content(ctx);

    if (req.method === "GET" && url.pathname === "/api/attachments") return await handle_get_api_attachments(ctx);

    if (req.method === "GET" && url.pathname === "/api/local-media") return await handle_get_api_local_media(ctx);

    if (req.method === "POST" && url.pathname === "/api/skills/reload") return await handle_post_api_skills_reload(ctx);

    if (req.method === "POST" && url.pathname === "/api/extension-ui/response") return await handle_post_api_extension_ui_response(ctx);

    if (req.method === "GET" && url.pathname === "/api/custom-models") return await handle_get_api_custom_models(ctx);

    if (req.method === "POST" && url.pathname === "/api/custom-models") return await handle_post_api_custom_models(ctx);

    if (req.method === "POST" && url.pathname === "/api/custom-models/remove") return await handle_post_api_custom_models_remove(ctx);

    // 手改过 models.json 之后不用重启：重读文件 + 让 pi 的 runtime 整批重算 provider，
    // 再把新列表发回去（只读文件不管 runtime 的话，列表里的上下文/最大输出/cost 还是旧值）。
    if (req.method === "POST" && url.pathname === "/api/custom-models/reload") return await handle_post_api_custom_models_reload(ctx);

    if (req.method === "GET" && url.pathname === "/api/model-providers") return await handle_get_api_model_providers(ctx);

    // GET /api/model-providers/:id → 单个 provider 带本地模型列表（不联网）
    if (req.method === "GET" && url.pathname.startsWith("/api/model-providers/")) return await handle_get_api_model_providers_x(ctx);

    if (req.method === "POST" && url.pathname === "/api/model-providers/discover") return await handle_post_api_model_providers_discover(ctx);

    // POST /api/model-providers/:id/verify-key → 验证 API key 是否有效
    if (req.method === "POST" && url.pathname.endsWith("/verify-key")) return await handle_post(ctx);

    if (req.method === "POST" && url.pathname === "/api/model-providers/update") return await handle_post_api_model_providers_update(ctx);

    // POST /api/model-providers/:id/login → 跑一次 pi 的登录流程（NDJSON 流）。
    // 前端不传供应商名单：:id 支持什么由 provider.auth 决定，和 TUI 的 /login 同一套。
    // 形如 /api/model-providers/login/respond 的固定路由要排在前面，别被这里吞掉。
    if (req.method === "POST" && url.pathname === "/api/model-providers/login/respond") return await handle_post_api_model_providers_login_respond(ctx);

    if (req.method === "POST" && url.pathname === "/api/model-providers/login/cancel") return await handle_post_api_model_providers_login_cancel(ctx);

    // POST /api/model-providers/:id/logout → 删掉 auth.json 里这家存的那条凭证。
    if (req.method === "POST" && url.pathname.endsWith("/logout")) return await handle_post_x(ctx);

    if (req.method === "POST" && url.pathname.endsWith("/login")) return await handle_post_x_x(ctx);

    if (req.method === "POST" && url.pathname === "/api/custom-models/key") return await handle_post_api_custom_models_key(ctx);

    if (req.method === "POST" && url.pathname === "/api/custom-models/test") return await handle_post_api_custom_models_test(ctx);

    if (req.method === "POST" && url.pathname === "/api/model") return await handle_post_api_model(ctx);

    if (req.method === "POST" && url.pathname === "/api/personalization") return await handle_post_api_personalization(ctx);

    if (req.method === "POST" && url.pathname === "/api/thinking-level") return await handle_post_api_thinking_level(ctx);

    if (req.method === "POST" && url.pathname === "/api/projects") return await handle_post_api_projects(ctx);

    if (req.method === "POST" && url.pathname === "/api/projects/select") return await handle_post_api_projects_select(ctx);

    if (req.method === "POST" && url.pathname === "/api/projects/trust") return await handle_post_api_projects_trust(ctx);

    if (req.method === "POST" && url.pathname === "/api/projects/update") return await handle_post_api_projects_update(ctx);

    if (req.method === "POST" && url.pathname === "/api/projects/reorder") return await handle_post_api_projects_reorder(ctx);

    if (req.method === "POST" && url.pathname === "/api/projects/pin") return await handle_post_api_projects_pin(ctx);

    if (req.method === "POST" && url.pathname === "/api/projects/remove") return await handle_post_api_projects_remove(ctx);

    if (req.method === "POST" && url.pathname === "/api/projects/reveal") return await handle_post_api_projects_reveal(ctx);

    // 会话头部右侧的 git 徽标：只读，`projectId` 由服务端自己的项目表解析成 cwd
    // （渲染层拿不到、也不该传任意路径）。带 `sessionPath` 时读的是会话自己的 workspace ——
    // worktree 会话的徽标必须显示 worktree 的头部状态，而不是主检出。
    if (req.method === "GET" && url.pathname === "/api/projects/git") return await handle_get_api_projects_git(ctx);

    // 「项目还没有仓库」时那个初始化按钮：只在用户点击时到达的写操作。
    if (req.method === "POST" && url.pathname === "/api/projects/git/init") return await handle_post_api_projects_git_init(ctx);

    // 弹层里点某个分支 → 切过去（写操作）。目标分支必须是本地分支列表里的名字，
    // 由 `switchGitBranch` 自己再校验一次。带 `sessionPath` 时在会话的 worktree 里切。
    if (req.method === "POST" && url.pathname === "/api/projects/git/switch") return await handle_post_api_projects_git_switch(ctx);

    // 「从当前分支新建分支」：名字由 UI 给（起点固定是当前 HEAD，不是参数）。名字要过
    // `createGitBranch` 的安全校验与重名校验，之后再回一份新的 git 信息。
    if (req.method === "POST" && url.pathname === "/api/projects/git/create-branch") return await handle_post_api_projects_git_create_branch(ctx);

    // 「给当前分支改名」：只收一个新名字（旧名字就是 HEAD 所在的分支，不进参数）。名字要过
    // `renameGitBranch` 的安全校验与重名校验，之后再回一份新的 git 信息。
    if (req.method === "POST" && url.pathname === "/api/projects/git/rename-branch") return await handle_post_api_projects_git_rename_branch(ctx);

    // 「删除分支」：目标必须是本地分支列表里的名字，由 `deleteGitBranch` 再校验一次。用 git 的
    // 安全删除（`-d`）：还有未合并提交时 git 拒绝，原文当错误抛出。带 `sessionPath` 时在会话的
    // worktree 里删（它自带的分支可能就在那边检出的，由 git 自己判断能否删）。
    if (req.method === "POST" && url.pathname === "/api/projects/git/delete-branch") return await handle_post_api_projects_git_delete_branch(ctx);

    // 提交（写操作）：信息 + 勾选的文件路径由 UI 给，路径必须在刚刚的 status 里存在。
    if (req.method === "POST" && url.pathname === "/api/projects/git/commit") return await handle_post_api_projects_git_commit(ctx);

    // 「拉取」：`fetch` 上游远端后把它合并进当前分支（用户拍板：不要再叫 merge，pull 归 pull）。
    // 目标上游由 `pullGitBranch` 从 `status`/`for-each-ref` 自己读，不接收参数。
    if (req.method === "POST" && url.pathname === "/api/projects/git/pull") return await handle_post_api_projects_git_pull(ctx);

    // 「合并其它分支」：目标分支由 UI 在本地分支列表里选（服务端再拿 `for-each-ref` 对一遍）。
    // 冲突不是失败：返回 `{ conflict: true }` + 刷新后的 info，让 UI 把冲突文件摆出来。
    if (req.method === "POST" && url.pathname === "/api/projects/git/merge") return await handle_post_api_projects_git_merge(ctx);

    // 「自动解决冲突」：只读冲突清单与内容，拼成一条 prompt 交给前端（前端新建会话并填进
    // composer，用户自己点提交）。不启动模型、不落盘。
    if (req.method === "POST" && url.pathname === "/api/projects/git/conflicts") return await handle_post_api_projects_git_conflicts(ctx);

    // 「用 IDE 打开改动文件本身」（不是 diff）：冲突文件要靠它直接编辑冲突标记。
    if (req.method === "POST" && url.pathname === "/api/projects/git/open-file") return await handle_post_api_projects_git_open_file(ctx);

    // 「推送」：有上游直接推；没有上游则关联远端（优先 origin）再 `push -u`。远端与分支都由
    // `pushGitBranch` 从 git 自己报出来的东西里选，请求体里没有可伪造的目标。
    if (req.method === "POST" && url.pathname === "/api/projects/git/push") return await handle_post_api_projects_git_push(ctx);

    // 「双击改动文件 → 用宿主机的 IDE 看 diff」。只读：不动工作区，只往 tmpdir 写两侧的
    // 临时文件（左侧是 HEAD 的旧内容）；路径必须在刚刚的 status 里存在。
    if (req.method === "POST" && url.pathname === "/api/projects/git/open-diff") return await handle_post_api_projects_git_open_diff(ctx);

    // 会话头部「运行」按钮左边的命令列表。读：项目 + 选中的命令；写：整表替换（探测添加 /
    // 删除都是「前端有完整列表，把新列表整份交上来」），与 composerDefaults 一样存在
    // projects.json 里。
    if (req.method === "GET" && url.pathname === "/api/projects/commands") return await handle_get_api_projects_commands(ctx);

    if (req.method === "POST" && url.pathname === "/api/projects/commands") return await handle_post_api_projects_commands(ctx);

    if (req.method === "POST" && url.pathname === "/api/projects/commands/select") return await handle_post_api_projects_commands_select(ctx);

    // 「自动探测」：只读项目文件，不执行任何东西，也不落盘 —— 候选拿回前端让用户自己挑。
    // 探测目录取会话自己的工作区（worktree 会话看到的就是 worktree 的文件）。
    if (req.method === "POST" && url.pathname === "/api/projects/commands/detect") return await handle_post_api_projects_commands_detect(ctx);

    // 「运行方式」候选终端：只读扫描系统里装了哪些终端 app，给前端下拉用。返回形态
    // `{ platform, terminals }`；非 macOS 时 `terminals` 为空（只有「后台运行 / 系统默认终端」）。
    if (req.method === "GET" && url.pathname === "/api/projects/commands/terminals") return await handle_get_api_projects_commands_terminals(ctx);

    // 「运行」：在宿主机的终端里跑选中的那条命令。命令必须在项目自己的列表里，工作目录
    // 由服务端解析（项目根 + 命令自带的相对子目录），渲染层传不了任意路径。
    if (req.method === "POST" && url.pathname === "/api/projects/commands/run") return await handle_post_api_projects_commands_run(ctx);

    // 后台命令的存活状态：每次查询顺手清掉已经结束的记录。渲染层轮询它来决定「运行中」
    // 提示是否还在、以及「停止」按钮对应哪条命令。先扫一次系统进程表：有的子进程会 setsid
    // 出去另立会话（不在 leader 的进程组里），只能靠 ppid 关系把它们记进台账。
    if (req.method === "GET" && url.pathname === "/api/projects/commands/status") return await handle_get_api_projects_commands_status(ctx);

    // 「停止」：杀掉一条后台命令的进程（整棵进程树），并从台账里删掉。
    if (req.method === "POST" && url.pathname === "/api/projects/commands/stop") return await handle_post_api_projects_commands_stop(ctx);

    // 「查看日志」：后台运行把输出写进日志文件；这里用系统默认程序打开它。路径必须是服务端
    // 自己写日志的那个目录，渲染层传不了任意路径。
    if (req.method === "POST" && url.pathname === "/api/projects/commands/reveal-log") return await handle_post_api_projects_commands_reveal_log(ctx);

    // 「智能生成提交信息」：用**当前会话的模型**看一遍选中改动的 diff，只返回文本。
    // 不落盘、不提交 —— 生成的内容先进输入框，用户改完再点提交。
    if (req.method === "POST" && url.pathname === "/api/projects/git/commit-message") return await handle_post_api_projects_git_commit_message(ctx);
    if (req.method === "POST" && url.pathname === "/api/sessions") return await handle_post_api_sessions(ctx);

    // worktree 徽标的数据源（只读）。不在托管 worktree 里就回 `{ isWorktree: false }`。
    if (req.method === "GET" && url.pathname === "/api/sessions/worktree") return await handle_get_api_sessions_worktree(ctx);

    // 「在这里新建分支」：把 worktree 里 detached HEAD 上的提交落到一条真分支上，
    // 之后就算 worktree 被删，提交也不会变成孤儿。
    if (req.method === "POST" && url.pathname === "/api/sessions/worktree/branch") return await handle_post_api_sessions_worktree_branch(ctx);

    // 删除 worktree 并把会话退回主检出（写操作）。返回一份完整 bootstrap，客户端整体替换。
    if (req.method === "POST" && url.pathname === "/api/sessions/worktree/remove") return await handle_post_api_sessions_worktree_remove(ctx);

    // 「在访达中显示 worktree」：路径由服务端从会话解析，和项目的 reveal 一样不接受
    // 渲染层传任意路径。
    if (req.method === "POST" && url.pathname === "/api/sessions/worktree/reveal") return await handle_post_api_sessions_worktree_reveal(ctx);

    if (req.method === "POST" && url.pathname === "/api/sessions/select") return await handle_post_api_sessions_select(ctx);

    if (req.method === "POST" && url.pathname === "/api/sessions/update") return await handle_post_api_sessions_update(ctx);

    if (req.method === "POST" && url.pathname === "/api/sessions/pin") return await handle_post_api_sessions_pin(ctx);

    if (req.method === "POST" && url.pathname === "/api/sessions/archive") return await handle_post_api_sessions_archive(ctx);

    if (req.method === "POST" && url.pathname === "/api/sessions/delete") return await handle_post_api_sessions_delete(ctx);

    if (req.method === "POST" && url.pathname === "/api/sessions/delete-archived") return await handle_post_api_sessions_delete_archived(ctx);

    if (req.method === "POST" && url.pathname === "/api/compact") return await handle_post_api_compact(ctx);

    if (req.method === "POST" && url.pathname === "/api/stop") return await handle_post_api_stop(ctx);

    if (req.method === "POST" && url.pathname === "/api/prompt") return await handle_post_api_prompt(ctx);

    if (req.method === "POST" && url.pathname === "/api/messages/edit") return await handle_post_api_messages_edit(ctx);

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

