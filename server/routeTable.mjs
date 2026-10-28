/**
 * 桥的路由表：**路由是数据**，不再是 `server/index.mjs` 里的一长串 `if`。
 *
 * 为什么：那张 `if` 链把三件事混在书写顺序里 —— 有哪些路由（协议表面）、哪条先匹配（
 * 固定路径必须排在 `endsWith("/login")` 这类参数化规则前面）、每条路由交给谁处理。
 * 顺序一旦成为语义，改一行就可能悄悄吞掉另一条路由，而冻结表面只能靠正则去源码文本里
 * 扒（扒不到就静默少一条）。
 *
 * 现在：
 * - 路由的**唯一真源**是这张表；`architecture/generated/bridge-surface.json` 由它生成，
 *   架构检查器也读它（`scripts/architecture/lib/extractors.mjs` 的 `routesFromTable`）。
 * - 匹配优先级是**显式字段**：`exact` = 0，参数化（`prefix`/`suffix`） = 10，
 *   所以固定路径永远先于参数化规则，与书写顺序无关（`tests/routeTable.test.ts` 逐条钉住）。
 * - `handler` 写的是**名字**（表是纯数据，不 import 处理器）；组合区建好之后由
 *   `server/index.mjs` 按名字取。
 *
 * 新增一条路由 = 在表里加一行 + 在 `src/shared/protocol/bridgeEndpoints.ts` 里声明它
 * （客户端要能读到它的形状）+ `npm run architecture:write`。
 */

/** 匹配语义。`exact` 是整个路径；`prefix`/`suffix` 是参数化路由（id 由处理器自己从 URL 里取）。 */
export const ROUTE_KINDS = ["exact", "prefix", "suffix"];

/** 优先级越小越先试。固定路径必须先于参数化 —— 这是语义，不是书写顺序。 */
export const ROUTE_PRIORITY = { exact: 0, prefix: 10, suffix: 10 };

/** 桥回答的每一条路由。 */
export const ROUTES = [
  { method: "GET", kind: "exact", priority: 0, path: "/api/protocol", handler: "handle_get_api_protocol" },
  { method: "GET", kind: "exact", priority: 0, path: "/api/bootstrap", handler: "handle_get_api_bootstrap" },
  { method: "GET", kind: "exact", priority: 0, path: "/api/search", handler: "handle_get_api_search" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/diagnostic", handler: "handle_post_api_diagnostic" },
  { method: "GET", kind: "exact", priority: 0, path: "/api/models", handler: "handle_get_api_models" },
  { method: "GET", kind: "exact", priority: 0, path: "/api/capabilities", handler: "handle_get_api_capabilities" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/default", handler: "handle_post_api_capabilities_default" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/pin", handler: "handle_post_api_capabilities_pin" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/session/skill", handler: "handle_post_api_capabilities_session_skill" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/session/package", handler: "handle_post_api_capabilities_session_package" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/session/extension", handler: "handle_post_api_capabilities_session_extension" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/skills/import", handler: "handle_post_api_capabilities_skills_import" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/skills/delete", handler: "handle_post_api_capabilities_skills_delete" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/package/install", handler: "handle_post_api_capabilities_package_install" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/package/remove", handler: "handle_post_api_capabilities_package_remove" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/package/update", handler: "handle_post_api_capabilities_package_update" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/package/resources", handler: "handle_post_api_capabilities_package_resources" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/package/file", handler: "handle_post_api_capabilities_package_file" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/package/command/arguments", handler: "handle_post_api_capabilities_package_command_arguments" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/package/command", handler: "handle_post_api_capabilities_package_command" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/builtin-command", handler: "handle_post_api_builtin_command" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/extension/add", handler: "handle_post_api_capabilities_extension_add" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/extension/remove", handler: "handle_post_api_capabilities_extension_remove" },
  // MCP 的写路径：服务器定义进 pi 的 mcp.json（全局 / 项目），app 元数据进 capabilities.json。
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/mcp/save", handler: "handle_post_api_capabilities_mcp_save" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/mcp/remove", handler: "handle_post_api_capabilities_mcp_remove" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/mcp/inspect", handler: "handle_post_api_capabilities_mcp_inspect" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/mcp/read", handler: "handle_post_api_capabilities_mcp_read" },
  // 导入：把别家客户端的 JSON 形状（mcpServers / VS Code servers / Zed context_servers ...）
  // 翻译成表单字段回给前端，用户确认后走 /mcp/save 落盘。这里只解析，不写文件。
  { method: "POST", kind: "exact", priority: 0, path: "/api/capabilities/mcp/import", handler: "handle_post_api_capabilities_mcp_import" },
  // 「工具开关」（codemode）写的就是 pi 自己的 defaultTools，见 server/toolSettings.mjs。
  { method: "POST", kind: "exact", priority: 0, path: "/api/tools/settings", handler: "handle_post_api_tools_settings" },
  { method: "GET", kind: "exact", priority: 0, path: "/api/skills/content", handler: "handle_get_api_skills_content" },
  { method: "GET", kind: "exact", priority: 0, path: "/api/attachments", handler: "handle_get_api_attachments" },
  { method: "GET", kind: "exact", priority: 0, path: "/api/local-media", handler: "handle_get_api_local_media" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/skills/reload", handler: "handle_post_api_skills_reload" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/extension-ui/response", handler: "handle_post_api_extension_ui_response" },
  { method: "GET", kind: "exact", priority: 0, path: "/api/custom-models", handler: "handle_get_api_custom_models" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/custom-models", handler: "handle_post_api_custom_models" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/custom-models/remove", handler: "handle_post_api_custom_models_remove" },
  // 手改过 models.json 之后不用重启：重读文件 + 让 pi 的 runtime 整批重算 provider，
  // 再把新列表发回去（只读文件不管 runtime 的话，列表里的上下文/最大输出/cost 还是旧值）。
  { method: "POST", kind: "exact", priority: 0, path: "/api/custom-models/reload", handler: "handle_post_api_custom_models_reload" },
  { method: "GET", kind: "exact", priority: 0, path: "/api/model-providers", handler: "handle_get_api_model_providers" },
  // GET /api/model-providers/:id → 单个 provider 带本地模型列表（不联网）
  { method: "GET", kind: "prefix", priority: 10, path: "/api/model-providers/", handler: "handle_get_api_model_providers_x" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/model-providers/discover", handler: "handle_post_api_model_providers_discover" },
  // POST /api/model-providers/:id/verify-key → 验证 API key 是否有效
  { method: "POST", kind: "suffix", priority: 10, path: "/verify-key", handler: "handle_post" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/model-providers/update", handler: "handle_post_api_model_providers_update" },
  // POST /api/model-providers/:id/login → 跑一次 pi 的登录流程（NDJSON 流）。
  // 前端不传供应商名单：:id 支持什么由 provider.auth 决定，和 TUI 的 /login 同一套。
  // 形如 /api/model-providers/login/respond 的固定路由要排在前面，别被这里吞掉。
  { method: "POST", kind: "exact", priority: 0, path: "/api/model-providers/login/respond", handler: "handle_post_api_model_providers_login_respond" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/model-providers/login/cancel", handler: "handle_post_api_model_providers_login_cancel" },
  // POST /api/model-providers/:id/logout → 删掉 auth.json 里这家存的那条凭证。
  { method: "POST", kind: "suffix", priority: 10, path: "/logout", handler: "handle_post_x" },
  { method: "POST", kind: "suffix", priority: 10, path: "/login", handler: "handle_post_x_x" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/custom-models/key", handler: "handle_post_api_custom_models_key" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/custom-models/test", handler: "handle_post_api_custom_models_test" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/model", handler: "handle_post_api_model" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/personalization", handler: "handle_post_api_personalization" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/thinking-level", handler: "handle_post_api_thinking_level" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects", handler: "handle_post_api_projects" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/select", handler: "handle_post_api_projects_select" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/trust", handler: "handle_post_api_projects_trust" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/update", handler: "handle_post_api_projects_update" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/reorder", handler: "handle_post_api_projects_reorder" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/pin", handler: "handle_post_api_projects_pin" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/remove", handler: "handle_post_api_projects_remove" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/reveal", handler: "handle_post_api_projects_reveal" },
  // 会话头部右侧的 git 徽标：只读，`projectId` 由服务端自己的项目表解析成 cwd
  // （渲染层拿不到、也不该传任意路径）。带 `sessionPath` 时读的是会话自己的 workspace ——
  // worktree 会话的徽标必须显示 worktree 的头部状态，而不是主检出。
  { method: "GET", kind: "exact", priority: 0, path: "/api/projects/git", handler: "handle_get_api_projects_git" },
  // 右面板 Files 视图：列一层目录（懒加载，不递归）。只读，路径必须落在项目根内。
  { method: "GET", kind: "exact", priority: 0, path: "/api/projects/files", handler: "handle_get_api_projects_files" },
  // 右面板内置的文件内容预览（同样是只读 + 有界）。
  { method: "GET", kind: "exact", priority: 0, path: "/api/projects/file", handler: "handle_get_api_projects_file" },
  // 「改动」面板切到「对比分支」时那一列文件（底座是 merge-base，和读单个文件 diff 同源）。
  // 未暂存/已暂存不需要这条路由：那两份清单本来就在 /api/projects/git 的 porcelain 里。
  { method: "GET", kind: "exact", priority: 0, path: "/api/projects/git/files", handler: "handle_get_api_projects_git_files" },
  // 右面板里点开某个文件看改动（纯读：不写工作区、不弹 IDE）。
  { method: "GET", kind: "exact", priority: 0, path: "/api/projects/git/diff", handler: "handle_get_api_projects_git_diff" },
  // 「项目还没有仓库」时那个初始化按钮：只在用户点击时到达的写操作。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/init", handler: "handle_post_api_projects_git_init" },
  // 弹层里点某个分支 → 切过去（写操作）。目标分支必须是本地分支列表里的名字，
  // 由 `switchGitBranch` 自己再校验一次。带 `sessionPath` 时在会话的 worktree 里切。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/switch", handler: "handle_post_api_projects_git_switch" },
  // 「从当前分支新建分支」：名字由 UI 给（起点固定是当前 HEAD，不是参数）。名字要过
  // `createGitBranch` 的安全校验与重名校验，之后再回一份新的 git 信息。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/create-branch", handler: "handle_post_api_projects_git_create_branch" },
  // 「给当前分支改名」：只收一个新名字（旧名字就是 HEAD 所在的分支，不进参数）。名字要过
  // `renameGitBranch` 的安全校验与重名校验，之后再回一份新的 git 信息。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/rename-branch", handler: "handle_post_api_projects_git_rename_branch" },
  // 「删除分支」：目标必须是本地分支列表里的名字，由 `deleteGitBranch` 再校验一次。用 git 的
  // 安全删除（`-d`）：还有未合并提交时 git 拒绝，原文当错误抛出。带 `sessionPath` 时在会话的
  // worktree 里删（它自带的分支可能就在那边检出的，由 git 自己判断能否删）。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/delete-branch", handler: "handle_post_api_projects_git_delete_branch" },
  // 提交（写操作）：信息 + 勾选的文件路径由 UI 给，路径必须在刚刚的 status 里存在。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/commit", handler: "handle_post_api_projects_git_commit" },
  // 「拉取」：`fetch` 上游远端后把它合并进当前分支（用户拍板：不要再叫 merge，pull 归 pull）。
  // 目标上游由 `pullGitBranch` 从 `status`/`for-each-ref` 自己读，不接收参数。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/pull", handler: "handle_post_api_projects_git_pull" },
  // 「合并其它分支」：目标分支由 UI 在本地分支列表里选（服务端再拿 `for-each-ref` 对一遍）。
  // 冲突不是失败：返回 `{ conflict: true }` + 刷新后的 info，让 UI 把冲突文件摆出来。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/merge", handler: "handle_post_api_projects_git_merge" },
  // 「自动解决冲突」：只读冲突清单与内容，拼成一条 prompt 交给前端（前端新建会话并填进
  // composer，用户自己点提交）。不启动模型、不落盘。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/conflicts", handler: "handle_post_api_projects_git_conflicts" },
  // 「用 IDE 打开改动文件本身」（不是 diff）：冲突文件要靠它直接编辑冲突标记。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/open-file", handler: "handle_post_api_projects_git_open_file" },
  // 「推送」：有上游直接推；没有上游则关联远端（优先 origin）再 `push -u`。远端与分支都由
  // `pushGitBranch` 从 git 自己报出来的东西里选，请求体里没有可伪造的目标。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/push", handler: "handle_post_api_projects_git_push" },
  // 「双击改动文件 → 用宿主机的 IDE 看 diff」。只读：不动工作区，只往 tmpdir 写两侧的
  // 临时文件（左侧是 HEAD 的旧内容）；路径必须在刚刚的 status 里存在。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/open-diff", handler: "handle_post_api_projects_git_open_diff" },
  // 会话头部「运行」按钮左边的命令列表。读：项目 + 选中的命令；写：整表替换（探测添加 /
  // 删除都是「前端有完整列表，把新列表整份交上来」），与 composerDefaults 一样存在
  // projects.json 里。
  { method: "GET", kind: "exact", priority: 0, path: "/api/projects/commands", handler: "handle_get_api_projects_commands" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/commands", handler: "handle_post_api_projects_commands" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/commands/select", handler: "handle_post_api_projects_commands_select" },
  // 「自动探测」：只读项目文件，不执行任何东西，也不落盘 —— 候选拿回前端让用户自己挑。
  // 探测目录取会话自己的工作区（worktree 会话看到的就是 worktree 的文件）。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/commands/detect", handler: "handle_post_api_projects_commands_detect" },
  // 「运行方式」候选终端：只读扫描系统里装了哪些终端 app，给前端下拉用。返回形态
  // `{ platform, terminals }`；非 macOS 时 `terminals` 为空（只有「后台运行 / 系统默认终端」）。
  { method: "GET", kind: "exact", priority: 0, path: "/api/projects/commands/terminals", handler: "handle_get_api_projects_commands_terminals" },
  // 「运行」：在宿主机的终端里跑选中的那条命令。命令必须在项目自己的列表里，工作目录
  // 由服务端解析（项目根 + 命令自带的相对子目录），渲染层传不了任意路径。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/commands/run", handler: "handle_post_api_projects_commands_run" },
  // 后台命令的存活状态：每次查询顺手清掉已经结束的记录。渲染层轮询它来决定「运行中」
  // 提示是否还在、以及「停止」按钮对应哪条命令。先扫一次系统进程表：有的子进程会 setsid
  // 出去另立会话（不在 leader 的进程组里），只能靠 ppid 关系把它们记进台账。
  { method: "GET", kind: "exact", priority: 0, path: "/api/projects/commands/status", handler: "handle_get_api_projects_commands_status" },
  // 「停止」：杀掉一条后台命令的进程（整棵进程树），并从台账里删掉。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/commands/stop", handler: "handle_post_api_projects_commands_stop" },
  // 「查看日志」：后台运行把输出写进日志文件；这里用系统默认程序打开它。路径必须是服务端
  // 自己写日志的那个目录，渲染层传不了任意路径。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/commands/reveal-log", handler: "handle_post_api_projects_commands_reveal_log" },
  // 「智能生成提交信息」：用**当前会话的模型**看一遍选中改动的 diff，只返回文本。
  // 不落盘、不提交 —— 生成的内容先进输入框，用户改完再点提交。
  { method: "POST", kind: "exact", priority: 0, path: "/api/projects/git/commit-message", handler: "handle_post_api_projects_git_commit_message" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/sessions", handler: "handle_post_api_sessions" },
  // worktree 徽标的数据源（只读）。不在托管 worktree 里就回 `{ isWorktree: false }`。
  { method: "GET", kind: "exact", priority: 0, path: "/api/sessions/worktree", handler: "handle_get_api_sessions_worktree" },
  // 「在这里新建分支」：把 worktree 里 detached HEAD 上的提交落到一条真分支上，
  // 之后就算 worktree 被删，提交也不会变成孤儿。
  { method: "POST", kind: "exact", priority: 0, path: "/api/sessions/worktree/branch", handler: "handle_post_api_sessions_worktree_branch" },
  // 删除 worktree 并把会话退回主检出（写操作）。返回一份完整 bootstrap，客户端整体替换。
  { method: "POST", kind: "exact", priority: 0, path: "/api/sessions/worktree/remove", handler: "handle_post_api_sessions_worktree_remove" },
  // 「在访达中显示 worktree」：路径由服务端从会话解析，和项目的 reveal 一样不接受
  // 渲染层传任意路径。
  { method: "POST", kind: "exact", priority: 0, path: "/api/sessions/worktree/reveal", handler: "handle_post_api_sessions_worktree_reveal" },
  { method: "GET", kind: "exact", priority: 0, path: "/api/sessions/messages", handler: "handle_get_api_sessions_messages" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/sessions/select", handler: "handle_post_api_sessions_select" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/sessions/update", handler: "handle_post_api_sessions_update" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/sessions/pin", handler: "handle_post_api_sessions_pin" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/sessions/archive", handler: "handle_post_api_sessions_archive" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/sessions/delete", handler: "handle_post_api_sessions_delete" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/sessions/delete-archived", handler: "handle_post_api_sessions_delete_archived" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/compact", handler: "handle_post_api_compact" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/stop", handler: "handle_post_api_stop" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/prompt", handler: "handle_post_api_prompt" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/runs/stream", handler: "handle_post_api_runs_stream" },
  { method: "POST", kind: "exact", priority: 0, path: "/api/messages/edit", handler: "handle_post_api_messages_edit" },];
/** 按优先级排好（`sort` 稳定：同优先级保持表里的顺序）。真表只排一次。 */
const byPriority = (a, b) => a.priority - b.priority;
let orderedRoutes = null;

/**
 * 这条请求交给哪一行？（没有匹配就是 `null` → 404。）
 *
 * `routes` 只是为了测匹配语义时可以喂一张局部表；真表是默认值。
 *
 * @param {string | undefined} method HTTP 方法（`req.method` 理论上可能缺失 → 匹配不上）
 * @param {string} pathname URL 路径（不含查询串）
 * @param {typeof ROUTES} [routes] 要匹配的表
 * @returns {(typeof ROUTES)[number] | null}
 */
export function matchRoute(method, pathname, routes = ROUTES) {
  if (routes === ROUTES) orderedRoutes ??= [...ROUTES].sort(byPriority);
  const ordered = routes === ROUTES ? orderedRoutes : [...routes].sort(byPriority);
  for (const route of ordered) {
    if (route.method !== method) continue;
    if (route.kind === "exact") {
      if (pathname === route.path) return route;
      continue;
    }
    if (route.kind === "prefix") {
      if (pathname.startsWith(route.path)) return route;
      continue;
    }
    if (pathname.endsWith(route.path)) return route;
  }
  return null;
}
