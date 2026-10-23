import {
  commandLine,
  normalizeProjectCommands,
  normalizeSelectedCommandId,
  selectedProjectCommand,
} from "../src/shared/projectCommands.ts";
import { buildCommitMessagePrompt, normalizeGeneratedCommitMessage } from "./commitMessage.mjs";
import { buildConflictPrompt } from "./conflictPrompt.mjs";
import { commitGitChanges } from "./gitCommit.mjs";
import {
  createGitBranch,
  deleteGitBranch,
  initGitRepo,
  mergeGitBranchInto,
  pullGitBranch,
  pushGitBranch,
  readCommitDiff,
  readConflictContext,
  readGitInfo,
  renameGitBranch,
  switchGitBranch,
} from "./gitInfo.mjs";
import { readJson } from "./httpHelpers.mjs";
import { oneShotModelError, oneShotThinkingEffort } from "./oneShotModel.mjs";
import { openGitFileDiff, openGitFileInIde } from "./openDiff.mjs";
import { createProjectProbe, detectProjectCommands } from "./projectCommandDetect.mjs";
import { revealFolder } from "./revealFolder.mjs";
import { detectTerminalApps, revealRunLog, runProjectCommand } from "./runProjectCommand.mjs";
import { assistantContentText, resolveCommandCwd } from "./sessionHelpers.mjs";
import { diagnosticLog } from "./sessionStoreFactory.mjs";
import { projectCommandsPayload, sendJson } from "./smallHelpers.mjs";
import { randomUUID } from "node:crypto";

/**
 * 项目/会话/worktree/git/命令 路由处理器
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createRoutesProjects(state, deps) {
  const { modelRuntime } = deps;
  const archiveProjectSession = /** @type {any} */ (
    (...args) => deps.archiveProjectSession(...args)
  );
  const createProject = /** @type {any} */ ((...args) => deps.createProject(...args));
  const createProjectSession = /** @type {any} */ ((...args) => deps.createProjectSession(...args));
  const deleteArchivedSessions = /** @type {any} */ (
    (...args) => deps.deleteArchivedSessions(...args)
  );
  const deleteProjectSession = /** @type {any} */ ((...args) => deps.deleteProjectSession(...args));
  const findProject = /** @type {any} */ ((...args) => deps.findProject(...args));
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));
  const isUsableModel = /** @type {any} */ ((...args) => deps.isUsableModel(...args));
  const pinProject = /** @type {any} */ ((...args) => deps.pinProject(...args));
  const pinProjectSession = /** @type {any} */ ((...args) => deps.pinProjectSession(...args));
  const readSessionWorktreeInfo = /** @type {any} */ (
    (...args) => deps.readSessionWorktreeInfo(...args)
  );
  const removeProject = /** @type {any} */ ((...args) => deps.removeProject(...args));
  const removeSessionWorktree = /** @type {any} */ (
    (...args) => deps.removeSessionWorktree(...args)
  );
  const reorderProjects = /** @type {any} */ ((...args) => deps.reorderProjects(...args));
  const requestWorkspaceCwd = /** @type {any} */ ((...args) => deps.requestWorkspaceCwd(...args));
  const requireSessionWorktreeCwd = /** @type {any} */ (
    (...args) => deps.requireSessionWorktreeCwd(...args)
  );
  const revealProject = /** @type {any} */ ((...args) => deps.revealProject(...args));
  const selectProject = /** @type {any} */ ((...args) => deps.selectProject(...args));
  const selectProjectSession = /** @type {any} */ ((...args) => deps.selectProjectSession(...args));
  const touchProject = /** @type {any} */ ((...args) => deps.touchProject(...args));
  const trustProject = /** @type {any} */ ((...args) => deps.trustProject(...args));
  const updateProject = /** @type {any} */ ((...args) => deps.updateProject(...args));
  const updateProjectSession = /** @type {any} */ ((...args) => deps.updateProjectSession(...args));

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects(ctx) {
    const body = await readJson(ctx.req);
    const result = await createProject(body);
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/select"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_select(ctx) {
    const body = await readJson(ctx.req);
    const result = await selectProject(String(body?.projectId ?? ""));
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/trust"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_trust(ctx) {
    const body = await readJson(ctx.req);
    const result = await trustProject(String(body?.projectId ?? state.activeProjectId));
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/update"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_update(ctx) {
    const body = await readJson(ctx.req);
    const result = await updateProject(body);
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/reorder"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_reorder(ctx) {
    const body = await readJson(ctx.req);
    const result = await reorderProjects(body);
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/pin"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_pin(ctx) {
    const body = await readJson(ctx.req);
    const result = await pinProject(String(body?.projectId ?? ""), Boolean(body?.pinned));
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/remove"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_remove(ctx) {
    const body = await readJson(ctx.req);
    const result = await removeProject(String(body?.projectId ?? ""));
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/reveal"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_reveal(ctx) {
    const body = await readJson(ctx.req);
    const result = await revealProject(String(body?.projectId ?? ""));
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "GET" && url.pathname === "/api/projects/git"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_get_api_projects_git(ctx) {
    const project = findProject(String(ctx.url.searchParams.get("projectId") ?? ""));
    const sessionPath = String(ctx.url.searchParams.get("sessionPath") ?? "").trim();
    sendJson(ctx.res, 200, await readGitInfo(requestWorkspaceCwd(project, { sessionPath })));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/init"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_init(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    await initGitRepo(project.cwd);
    sendJson(ctx.res, 200, await readGitInfo(project.cwd));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/switch"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_switch(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const cwd = requestWorkspaceCwd(project, body);
    await switchGitBranch(cwd, String(body?.branch ?? ""));
    sendJson(ctx.res, 200, await readGitInfo(cwd));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/create-branch"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_create_branch(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const cwd = requestWorkspaceCwd(project, body);
    await createGitBranch(cwd, String(body?.name ?? ""));
    sendJson(ctx.res, 200, await readGitInfo(cwd));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/rename-branch"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_rename_branch(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    await renameGitBranch(project.cwd, String(body?.name ?? ""));
    sendJson(ctx.res, 200, await readGitInfo(project.cwd));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/delete-branch"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_delete_branch(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const cwd = requestWorkspaceCwd(project, body);
    await deleteGitBranch(cwd, String(body?.branch ?? ""));
    sendJson(ctx.res, 200, await readGitInfo(cwd));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/commit"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_commit(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const cwd = requestWorkspaceCwd(project, body);
    await commitGitChanges(cwd, { message: body?.message, paths: body?.paths });
    sendJson(ctx.res, 200, await readGitInfo(cwd));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/pull"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_pull(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const cwd = requestWorkspaceCwd(project, body);
    await pullGitBranch(cwd);
    sendJson(ctx.res, 200, await readGitInfo(cwd));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/merge"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_merge(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const cwd = requestWorkspaceCwd(project, body);
    const result = await mergeGitBranchInto(cwd, String(body?.branch ?? ""));
    sendJson(ctx.res, 200, { ...result, info: await readGitInfo(cwd) });
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/conflicts"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_conflicts(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const cwd = requestWorkspaceCwd(project, body);
    const context = await readConflictContext(cwd);
    sendJson(ctx.res, 200, {
      prompt: buildConflictPrompt({ locale: body?.locale, context: { ...context, projectCwd: project.cwd } }),
      paths: context.files.map((file) => file.path),
      cwd,
    });
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/open-file"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_open_file(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const cwd = requestWorkspaceCwd(project, body);
    sendJson(ctx.res, 200, await openGitFileInIde(cwd, String(body?.path ?? "")));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/push"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_push(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const cwd = requestWorkspaceCwd(project, body);
    await pushGitBranch(cwd);
    sendJson(ctx.res, 200, await readGitInfo(cwd));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/open-diff"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_open_diff(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    sendJson(ctx.res, 200, await openGitFileDiff(project.cwd, String(body?.path ?? "")));
    return;
  }

  /** 路由处理器：req.method === "GET" && url.pathname === "/api/projects/commands"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_get_api_projects_commands(ctx) {
    const project = findProject(String(ctx.url.searchParams.get("projectId") ?? ""));
    sendJson(ctx.res, 200, projectCommandsPayload(project));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/commands"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_commands(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const commands = normalizeProjectCommands(body?.commands);
    const selectedCommandId = normalizeSelectedCommandId(body?.selectedCommandId, commands);
    touchProject(project.id, { commands, selectedCommandId });
    sendJson(ctx.res, 200, projectCommandsPayload(findProject(project.id)));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/commands/select"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_commands_select(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const selectedCommandId = normalizeSelectedCommandId(body?.commandId, project.commands ?? []);
    touchProject(project.id, { selectedCommandId });
    sendJson(ctx.res, 200, projectCommandsPayload(findProject(project.id)));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/commands/detect"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_commands_detect(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const cwd = requestWorkspaceCwd(project, body);
    sendJson(ctx.res, 200, { candidates: detectProjectCommands(createProjectProbe(cwd)) });
    return;
  }

  /** 路由处理器：req.method === "GET" && url.pathname === "/api/projects/commands/terminals"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_get_api_projects_commands_terminals(ctx) {
    sendJson(ctx.res, 200, { platform: process.platform, terminals: detectTerminalApps() });
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/commands/run"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_commands_run(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const command = selectedProjectCommand(project.commands ?? [], String(body?.commandId ?? ""));
    if (!command) {
      throw new Error("这条命令已经不在列表里了，请重新选择。");
    }
    const cwd = resolveCommandCwd(requestWorkspaceCwd(project, body), command.cwd);
    const terminalApp = typeof body?.terminal === "string" ? body.terminal : "";
    const background = body?.background === true || terminalApp === "background";
    const result = await runProjectCommand(command.command, cwd, {
      background,
      terminalApp:
        terminalApp && terminalApp !== "default" && terminalApp !== "background" ? terminalApp : "",
      // 参数 / 环境变量存在命令自己身上（服务端从 projects.json 读，不信请求体）。
      args: command.args,
      commandEnv: command.env,
    });
    const line = commandLine(command.command, command.args);
    // 后台运行能跟踪：登记进程，界面据此持续显示「运行中」并提供停止入口。
    if (result.logPath !== undefined) {
      const background = result;
      deps.projectCommandRuns.register({
        pid: (await background.pid) ?? null,
        startedAt: Date.now(),
        command: line,
        projectId: project.id,
        commandId: command.id,
        cwd,
        logPath: background.logPath,
        sessionPath: typeof body?.sessionPath === "string" ? body.sessionPath : "",
      });
    }
    sendJson(ctx.res, 200, {
      ok: true,
      launcher: result.launcher,
      logPath: result.logPath ?? null,
      pid: (await result.pid) ?? null,
      command: line,
      cwd,
    });
    return;
  }

  /** 路由处理器：req.method === "GET" && url.pathname === "/api/projects/commands/status"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_get_api_projects_commands_status(ctx) {
    const projectId = String(ctx.url.searchParams.get("projectId") ?? "");
    const table = await deps.projectCommandRuns.scanProcesses();
    sendJson(ctx.res, 200, { runs: deps.projectCommandRuns.list({ projectId, table }) });
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/commands/stop"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_commands_stop(ctx) {
    const body = await readJson(ctx.req);
    const result = await deps.projectCommandRuns.stop(String(body?.runId ?? ""));
    sendJson(ctx.res, 200, { ok: true, ...result });
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/commands/reveal-log"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_commands_reveal_log(ctx) {
    const body = await readJson(ctx.req);
    await revealRunLog(String(body?.logPath ?? ""));
    sendJson(ctx.res, 200, { ok: true });
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/projects/git/commit-message"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_projects_git_commit_message(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const cwd = requestWorkspaceCwd(project, body);
    const context = await readCommitDiff(cwd, body?.paths);
    const model = getRuntimeForRequest(body).session.model;
    if (!isUsableModel(model)) {
      throw new Error("请先选择 provider 和 model。");
    }
    if (!modelRuntime.hasConfiguredAuth(model.provider)) {
      throw new Error(`请先配置 ${model.provider} 的 API key。`);
    }

    const { systemPrompt, userText } = buildCommitMessagePrompt({ locale: body?.locale, context });
    const response = await modelRuntime.complete(
      model,
      {
        systemPrompt,
        messages: [
          { role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
        ],
      },
      // maxTokens 留出思考模型的 reasoning 消耗；「始终思考」型模型必须显式给档位，
      // 否则 pi-ai 发 enable_thinking:false 会被端点 400（见 server/oneShotModel.mjs）。
      {
        maxTokens: 1024,
        cacheRetention: "none",
        sessionId: randomUUID(),
        reasoningEffort: oneShotThinkingEffort(model),
      },
    );
    const oneShotError = oneShotModelError(response);
    if (oneShotError) {
      throw new Error(oneShotError);
    }
    const message = normalizeGeneratedCommitMessage(assistantContentText(response));
    if (!message) {
      throw new Error(
        response.stopReason === "length"
          ? "模型在输出预算内没有给出提交信息，请重试。"
          : "模型没有返回可用的提交信息，请重试。",
      );
    }

    sendJson(ctx.res, 200, { message, model: `${model.provider}/${model.id}` });
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/sessions"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_sessions(ctx) {
    const body = await readJson(ctx.req);
    const result = await createProjectSession(
      String(body?.projectId ?? state.activeProjectId),
      body?.name,
      body?.worktree,
    );
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "GET" && url.pathname === "/api/sessions/worktree"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_get_api_sessions_worktree(ctx) {
    const project = findProject(String(ctx.url.searchParams.get("projectId") ?? ""));
    sendJson(
      ctx.res,
      200,
      await readSessionWorktreeInfo(project, String(ctx.url.searchParams.get("sessionPath") ?? "")),
    );
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/sessions/worktree/branch"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_sessions_worktree_branch(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    const sessionPath = String(body?.sessionPath ?? "");
    const cwd = requireSessionWorktreeCwd(project, sessionPath);
    await createGitBranch(cwd, String(body?.name ?? ""));
    sendJson(ctx.res, 200, await readSessionWorktreeInfo(project, sessionPath));
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/sessions/worktree/remove"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_sessions_worktree_remove(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    sendJson(
      ctx.res,
      200,
      await removeSessionWorktree(project, String(body?.sessionPath ?? ""), body?.force),
    );
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/sessions/worktree/reveal"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_sessions_worktree_reveal(ctx) {
    const body = await readJson(ctx.req);
    const project = findProject(String(body?.projectId ?? ""));
    await revealFolder(requireSessionWorktreeCwd(project, String(body?.sessionPath ?? "")));
    sendJson(ctx.res, 200, { ok: true });
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/sessions/select"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_sessions_select(ctx) {
    const body = await readJson(ctx.req);
    const traceId = String(body?.traceId ?? ctx.clientTraceId ?? "").trim() || undefined;
    const result = await selectProjectSession(
      String(body?.projectId ?? state.activeProjectId),
      String(body?.sessionPath ?? ""),
      ctx.requestId,
      traceId,
    );
    diagnosticLog("session.select.response", {
      requestId: ctx.requestId,
      clientTraceId: traceId,
      durationMs: Date.now() - ctx.requestStartedAt,
      sessionPath: result.activeSessionPath,
      messageCount: result.snapshot?.conversation?.messages?.length,
    });
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/sessions/update"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_sessions_update(ctx) {
    const body = await readJson(ctx.req);
    const result = await updateProjectSession(
      String(body?.projectId ?? state.activeProjectId),
      String(body?.sessionPath ?? ""),
      body?.name,
    );
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/sessions/pin"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_sessions_pin(ctx) {
    const body = await readJson(ctx.req);
    const result = await pinProjectSession(
      String(body?.projectId ?? state.activeProjectId),
      String(body?.sessionPath ?? ""),
      Boolean(body?.pinned),
    );
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/sessions/archive"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_sessions_archive(ctx) {
    const body = await readJson(ctx.req);
    const result = await archiveProjectSession(
      String(body?.projectId ?? state.activeProjectId),
      String(body?.sessionPath ?? ""),
      body?.archived !== false,
    );
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/sessions/delete"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_sessions_delete(ctx) {
    const body = await readJson(ctx.req);
    const result = await deleteProjectSession(
      String(body?.projectId ?? state.activeProjectId),
      String(body?.sessionPath ?? ""),
    );
    sendJson(ctx.res, 200, result);
    return;
  }

  /** 路由处理器：req.method === "POST" && url.pathname === "/api/sessions/delete-archived"（原 server 回调内联分支，见 .scratch/branch-to-handlers.mjs） */
  async function handle_post_api_sessions_delete_archived(ctx) {
    const body = await readJson(ctx.req);
    const result = await deleteArchivedSessions(body?.projectId ? String(body.projectId) : "");
    sendJson(ctx.res, 200, result);
    return;
  }

  return {
    handle_get_api_projects_commands,
    handle_get_api_projects_commands_status,
    handle_get_api_projects_commands_terminals,
    handle_get_api_projects_git,
    handle_get_api_sessions_worktree,
    handle_post_api_projects,
    handle_post_api_projects_commands,
    handle_post_api_projects_commands_detect,
    handle_post_api_projects_commands_reveal_log,
    handle_post_api_projects_commands_run,
    handle_post_api_projects_commands_select,
    handle_post_api_projects_commands_stop,
    handle_post_api_projects_git_commit,
    handle_post_api_projects_git_commit_message,
    handle_post_api_projects_git_conflicts,
    handle_post_api_projects_git_create_branch,
    handle_post_api_projects_git_delete_branch,
    handle_post_api_projects_git_init,
    handle_post_api_projects_git_merge,
    handle_post_api_projects_git_open_diff,
    handle_post_api_projects_git_open_file,
    handle_post_api_projects_git_pull,
    handle_post_api_projects_git_push,
    handle_post_api_projects_git_rename_branch,
    handle_post_api_projects_git_switch,
    handle_post_api_projects_pin,
    handle_post_api_projects_remove,
    handle_post_api_projects_reorder,
    handle_post_api_projects_reveal,
    handle_post_api_projects_select,
    handle_post_api_projects_trust,
    handle_post_api_projects_update,
    handle_post_api_sessions,
    handle_post_api_sessions_archive,
    handle_post_api_sessions_delete,
    handle_post_api_sessions_delete_archived,
    handle_post_api_sessions_pin,
    handle_post_api_sessions_select,
    handle_post_api_sessions_update,
    handle_post_api_sessions_worktree_branch,
    handle_post_api_sessions_worktree_remove,
    handle_post_api_sessions_worktree_reveal,
  };
}
