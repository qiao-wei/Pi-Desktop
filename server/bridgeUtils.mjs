import { deriveSessionTitle } from "../src/shared/sessionTitle.ts";
import { planBuiltinCommand } from "./builtinCommands.mjs";
import { describeLoadStatus, isUnhealthyLoadStatus } from "./capabilityHealth.mjs";
import { isManagedWorktreePath, removeManagedWorktree } from "./gitWorktree.mjs";
import { ProjectTrustStore } from "./piKernel.mjs";
import { persistSessionShell } from "./sessionHelpers.mjs";
import { normalizeComposerDefaults } from "./sessionModelPolicy.mjs";
import {
  agentDir,
  diagnosticLog,
  getProjectSessionDir,
  worktreesRoot,
} from "./sessionStoreFactory.mjs";
import { isSessionBusy, sessionRuntimeKey } from "./smallHelpers.mjs";
import { existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 其余叶子（诊断、git、附件、会话标题等工具）
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createBridgeUtils(state, deps) {
  const { agentSkillsDir, appSkillsDir, hostSystemPrompt, openRuntimes, sessionStore } = deps;
  const buildSnapshot = /** @type {any} */ ((...args) => deps.buildSnapshot(...args));
  const disposeRuntime = /** @type {any} */ ((...args) => deps.disposeRuntime(...args));
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));
  const listProjectSessions = /** @type {any} */ ((...args) => deps.listProjectSessions(...args));
  const refreshSnapshot = /** @type {any} */ ((...args) => deps.refreshSnapshot(...args));
  const reloadOpenRuntimeCapabilities = /** @type {any} */ (
    (...args) => deps.reloadOpenRuntimeCapabilities(...args)
  );
  const reloadRuntimeTargets = /** @type {any} */ ((...args) => deps.reloadRuntimeTargets(...args));
  const replaceRuntime = /** @type {any} */ ((...args) => deps.replaceRuntime(...args));
  const sessionWorkspaceCwdForPath = /** @type {any} */ (
    (...args) => deps.sessionWorkspaceCwdForPath(...args)
  );
  const touchProject = /** @type {any} */ ((...args) => deps.touchProject(...args));
  const updateSessionStoreFromRuntime = /** @type {any} */ (
    (...args) => deps.updateSessionStoreFromRuntime(...args)
  );

  function disposeProjectRuntimes(projectId) {
    const projectRuntimes = [...openRuntimes.values()].filter(
      (candidate) => candidate.projectId === projectId,
    );
    if (projectRuntimes.some((candidate) => isSessionBusy(candidate.session))) {
      throw new Error("Stop the project's running sessions before changing or removing it.");
    }

    for (const targetRuntime of projectRuntimes) {
      targetRuntime.unsubscribe?.();
      targetRuntime.session.dispose();
      openRuntimes.delete(sessionRuntimeKey(targetRuntime.session.sessionFile));
    }
  }

  function basePiDesktopResourceLoaderOptions(project, settingsManager) {
    return {
      cwd: project.cwd,
      agentDir,
      settingsManager,
      additionalSkillPaths: [appSkillsDir],
      appendSystemPromptOverride: (base) => [...base, hostSystemPrompt],
    };
  }

  function normalizeStringArray(value) {
    return Array.isArray(value)
      ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
      : [];
  }

  function reportUnhealthyLoads(health, packages) {
    const issues = packages
      .map((pkg) => ({ pkg, summary: health.packages[pkg.id] }))
      .filter((item) => item.summary && isUnhealthyLoadStatus(item.summary.status));
    const fingerprint = issues.map((item) => `${item.pkg.id}:${item.summary.status}`).join(",");
    if (deps.lastCapabilityLoadStatuses.get("fingerprint") === fingerprint) {
      return;
    }
    deps.lastCapabilityLoadStatuses.set("fingerprint", fingerprint);
    for (const item of issues) {
      const message = `[pi-desktop:capability] ${item.pkg.id} ${describeLoadStatus(item.summary.status, item.summary)}`;
      console.error(message);
      diagnosticLog("capability.load_issue", {
        package: item.pkg.id,
        status: item.summary.status,
        errors: item.summary.errors,
      });
    }
  }

  /**
   * 包命令的参数补全。走 pi 命令自己注册的 `getArgumentCompletions(prefix)` —— TUI 的
   * CombinedAutocompleteProvider 就是直接调它。没注册的命令返回空列表，composer 静默
   * 收起参数菜单，不当成错误。
   *
   ** 内置命令的唯一实现点（目前只有 `/reload`）。语义对齐 pi 的 `/reload`：重读 settings /
   * prompts / extensions / themes / context files —— `reloadRuntimeTargets` 就是 Pi Desktop
   * 安装/更新包之后走的那条全量重载路径。回合中途不能重载（pi 的 loader 会在半途换掉工具/
   * 提示词），先让用户停掉再试。
   */
  async function runBuiltinCommand(body) {
    const targetRuntime = getRuntimeForRequest(body);
    const plan = planBuiltinCommand(body?.command, body?.args);
    if (plan.kind === "unknown" || !plan.command) {
      throw new Error("Unknown built-in command.");
    }
    if (plan.kind === "invalid") {
      throw new Error(plan.reason);
    }
    if (isSessionBusy(targetRuntime.session)) {
      throw new Error("Stop the running response before reloading.");
    }

    await reloadRuntimeTargets([targetRuntime]);
    return { command: plan.command.name, snapshot: await buildSnapshot(targetRuntime) };
  }

  async function trustProject(projectId) {
    const project = findProject(projectId);
    const trustStore = new ProjectTrustStore(agentDir);
    trustStore.set(project.cwd, true);

    const targets = [...openRuntimes.values()].filter(
      (candidate) => candidate.projectId === project.id,
    );
    for (const target of targets) {
      target.settingsManager.setProjectTrusted(true);
    }

    await reloadOpenRuntimeCapabilities(project.id);
    return refreshSnapshot();
  }

  async function pinProjectSession(projectId, sessionPath, pinned) {
    const project = findProject(projectId);
    const resolvedPath = assertProjectSessionPath(project, sessionPath);
    const sessionPins = {
      ...(project.sessionPins && typeof project.sessionPins === "object"
        ? project.sessionPins
        : {}),
      [resolvedPath]: Boolean(pinned),
    };

    if (!pinned) {
      delete sessionPins[resolvedPath];
    }

    touchProject(project.id, { sessionPins });
    sessionStore.setPinned(project.id, resolvedPath, pinned);
    return refreshSnapshot();
  }

  async function deleteProjectSession(projectId, sessionPath) {
    const project = findProject(projectId);
    const resolvedPath = assertProjectSessionPath(project, sessionPath);
    const isActiveSession = resolvedPath === state.runtime.session.sessionFile;
    removeSessionRecord(project, resolvedPath);

    if (isActiveSession) {
      const sessions = listProjectSessions(findProject(project.id));
      return replaceRuntime(findProject(project.id), sessions[0]?.path);
    }

    return refreshSnapshot();
  }

  /**
   * Delete one session's file + index row. Shared by the sidebar's permanent delete and by
   * the archived page's bulk delete so the two cannot drift apart (pins must be dropped
   * either way, otherwise unarchiving later would resurrect a stale pin).
   */
  function removeSessionRecord(project, resolvedPath) {
    scheduleWorktreeCleanup(project, resolvedPath);
    disposeRuntime(resolvedPath);

    if (existsSync(resolvedPath)) {
      unlinkSync(resolvedPath);
    }
    sessionStore.remove(project.id, resolvedPath);

    const sessionPins = { ...(project.sessionPins ?? {}) };
    delete sessionPins[resolvedPath];
    touchProject(project.id, {
      sessionPins,
      lastSessionPath:
        project.lastSessionPath === resolvedPath ? undefined : project.lastSessionPath,
    });
  }

  function setSessionTitleIfEmpty(targetRuntime, title) {
    if (targetRuntime.session.sessionManager.getSessionName()) {
      return;
    }

    const cleanTitle = String(title ?? "")
      .replace(/[\r\n]+/g, " ")
      .trim();
    if (!cleanTitle) {
      return;
    }

    targetRuntime.session.setSessionName(cleanTitle);
    persistSessionShell(targetRuntime.session.sessionManager);
    updateSessionStoreFromRuntime(targetRuntime);
  }

  /**
   * The submit-time provisional title used when no summary title is available (no
   * usable model, or the title call failed). The rule lives in the shared module so
   * the client's optimistic title and this server fallback cannot drift apart.
   */
  function fallbackSessionTitle(input) {
    return deriveSessionTitle({ text: String(input ?? "") });
  }

  /**
   * Directories `GET /api/local-media` may read from. `/tmp` is listed next to
   * `tmpdir()` because on macOS the latter is the per-user `$TMPDIR` and agents keep
   * writing to the plain `/tmp` path that scripts use.
   */
  function localMediaRoots() {
    return [agentDir, homedir(), tmpdir(), "/tmp", activeProject()?.cwd].filter(Boolean);
  }

  function sanitizePathPart(value) {
    return value
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  function activeProject() {
    return (
      state.projects.find((candidate) => candidate.id === state.activeProjectId) ??
      state.projects[0]
    );
  }

  function findProject(projectId) {
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }

    return project;
  }

  /**
   * 把「新任务从哪个模型/思考等级开始」记到项目上（而不是 pi 的全局 settings）。
   *
   * 只在新建会话里改动时才调。半条记录（只有 provider 没有 model、或等级不认识）会被
   * `normalizeComposerDefaults` 丢掉对应字段，宁可不改也不写脏数据。
   */
  function rememberProjectComposerDefaults(projectId, patch = {}) {
    const project = findProject(projectId);
    const next = normalizeComposerDefaults({
      ...normalizeComposerDefaults(project.composerDefaults),
      ...patch,
    });
    if (next) {
      touchProject(projectId, { composerDefaults: next });
    }
  }

  /**
   * 归档会话清单：跨项目，按项目分组由前端完成；带上 projectName 是为了让设置页
   * 直接展示分组标题，不必再回项目列表里兜一圈。
   */
  function listArchivedSessions() {
    return sessionStore.listArchived().map((session) => ({
      ...session,
      projectName: state.projects.find((project) => project.id === session.projectId)?.name,
    }));
  }

  /** 请求体里带了 sessionPath 就按会话的 workspace 干活，没带就是项目目录。 */
  function requestWorkspaceCwd(project, body) {
    const sessionPath = String(body?.sessionPath ?? "").trim();
    return sessionPath ? sessionWorkspaceCwdForPath(project, sessionPath) : project.cwd;
  }

  /** 要求这条会话现在确实跑在一个活着的托管 worktree 里（建分支 / 删除的入口闸）。 */
  function requireSessionWorktreeCwd(project, sessionPath) {
    const cwd = sessionWorkspaceCwdForPath(project, sessionPath);
    if (!isManagedWorktreePath(worktreesRoot, cwd) || !existsSync(cwd)) {
      throw new Error("这条会话不在托管 worktree 里。");
    }
    return cwd;
  }

  /**
   * 删除会话时顺手回收它自己的托管 worktree。
   *
   * 只删“还干净的那个”：worktree 里还有未提交内容时保留原地（那是用户的活，不能因为删了
   * 个聊天就没了），只写一条诊断。异步、不 await —— 清理失败不该让删会话失败。
   */
  function scheduleWorktreeCleanup(project, resolvedPath) {
    const stored = sessionStore.findCwd(project.id, resolvedPath);
    if (!stored || !isManagedWorktreePath(worktreesRoot, stored)) {
      return;
    }

    void removeManagedWorktree(project.cwd, stored, { root: worktreesRoot })
      .then(() =>
        diagnosticLog("worktree.removed", {
          projectId: project.id,
          worktreePath: stored,
          reason: "session_deleted",
        }),
      )
      .catch((error) =>
        diagnosticLog("worktree.remove_skipped", {
          projectId: project.id,
          worktreePath: stored,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  function assertProjectSessionPath(project, sessionPath) {
    if (!sessionPath) {
      throw new Error("sessionPath is required");
    }

    const projectSessionDir = resolve(getProjectSessionDir(project));
    const resolvedPath = resolve(sessionPath);
    if (!resolvedPath.startsWith(projectSessionDir)) {
      throw new Error("Session does not belong to this project");
    }

    return resolvedPath;
  }

  function projectContextInstruction(project, workspaceCwd = project.cwd) {
    const inWorktree = workspaceCwd !== project.cwd;
    return [
      "## Active Project Context",
      `Project name: ${project.name}`,
      `Working directory: ${workspaceCwd}`,
      ...(inWorktree
        ? [
            `This session runs in an app-managed Git worktree (detached checkout) at the working directory above; the project's main checkout is ${project.cwd}.`,
            "Changes made here stay isolated from other sessions. Commit them in this worktree, or create a branch here, to keep the work.",
          ]
        : []),
      "When the user asks to read or write files without giving a concrete absolute path, interpret paths relative to the working directory above.",
      `Project skills directory: ${join(project.cwd, ".pi", "skills")}`,
      `User skills directory: ${agentSkillsDir}`,
      `System skills directory: ${appSkillsDir}`,
    ].join("\n");
  }

  return {
    activeProject,
    assertProjectSessionPath,
    basePiDesktopResourceLoaderOptions,
    deleteProjectSession,
    disposeProjectRuntimes,
    fallbackSessionTitle,
    findProject,
    listArchivedSessions,
    localMediaRoots,
    normalizeStringArray,
    pinProjectSession,
    projectContextInstruction,
    rememberProjectComposerDefaults,
    removeSessionRecord,
    reportUnhealthyLoads,
    requestWorkspaceCwd,
    requireSessionWorktreeCwd,
    runBuiltinCommand,
    sanitizePathPart,
    scheduleWorktreeCleanup,
    setSessionTitleIfEmpty,
    trustProject,
  };
}
