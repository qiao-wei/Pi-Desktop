import { readGitInfo } from "./gitInfo.mjs";
import { createManagedWorktree, isManagedWorktreePath, linkProjectPiIntoWorktree, listManagedWorktrees, managedWorktreeId, readWorktreeChanges, removeManagedWorktree, worktreeDisplayName } from "./gitWorktree.mjs";
import { SessionManager } from "./piKernel.mjs";
import { createProjectCommandRuns } from "./projectCommandRuns.mjs";
import { findProjectByFolder } from "./projectFolders.mjs";
import { revealFolder } from "./revealFolder.mjs";
import { createProjectId, persistSessionShell } from "./sessionHelpers.mjs";
import { isFreshSession, silenceGlobalModelWrites } from "./sessionModelPolicy.mjs";
import { diagnosticLog, getProjectSessionDir, worktreesRoot } from "./sessionStoreFactory.mjs";
import { resolveSessionWorkspaceCwd } from "./sessionWorkspace.mjs";
import { isSessionBusy, normalizeThinkingLevel, sessionRuntimeKey, writeJsonFile } from "./smallHelpers.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * 项目与会话（增删改、worktree 生命周期）
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createProjectSessions(state, deps) {
  const { appCwd, commandRunsFile, openRuntimes, projectsFile, sessionStore } = deps;
  const activeProject = /** @type {any} */ ((...args) => deps.activeProject(...args));
  const assertProjectSessionPath = /** @type {any} */ ((...args) => deps.assertProjectSessionPath(...args));
  const disposeProjectRuntimes = /** @type {any} */ ((...args) => deps.disposeProjectRuntimes(...args));
  const findProject = /** @type {any} */ ((...args) => deps.findProject(...args));
  const rememberProjectComposerDefaults = /** @type {any} */ ((...args) => deps.rememberProjectComposerDefaults(...args));
  const removeSessionRecord = /** @type {any} */ ((...args) => deps.removeSessionRecord(...args));
  const buildSnapshot = /** @type {any} */ ((...args) => deps.buildSnapshot(...args));
  const disposeRuntime = /** @type {any} */ ((...args) => deps.disposeRuntime(...args));
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));
  const projectToolToggleState = /** @type {any} */ ((...args) => deps.projectToolToggleState(...args));
  const refreshSnapshot = /** @type {any} */ ((...args) => deps.refreshSnapshot(...args));
  const replaceRuntime = /** @type {any} */ ((...args) => deps.replaceRuntime(...args));
  const updateSessionStoreFromRuntime = /** @type {any} */ ((...args) => deps.updateSessionStoreFromRuntime(...args));
  const updateSessionStoreFromSession = /** @type {any} */ ((...args) => deps.updateSessionStoreFromSession(...args));

const projectCommandRuns = createProjectCommandRuns({ runsFile: commandRunsFile });

async function setSessionThinkingLevel(body) {
  const targetRuntime = getRuntimeForRequest(body);
  if (isSessionBusy(targetRuntime.session)) {
    throw new Error("Stop the running response before switching thinking.");
  }

  const thinkingLevel = normalizeThinkingLevel(body?.thinkingLevel ?? targetRuntime.session.thinkingLevel ?? "off");
  // 只有「还没提交过消息」的新会话里改，才算改写「新任务从哪个等级开始」；历史会话里改只管
  // 这条会话自己。pi 的 setThinkingLevel() 会顺手写全局 settings，一律挡掉（见 sessionModelPolicy）。
  const remember = isFreshSession(targetRuntime.session);
  const restore = silenceGlobalModelWrites(targetRuntime.settingsManager);
  try {
    targetRuntime.session.setThinkingLevel(thinkingLevel);
  } finally {
    restore();
  }
  if (remember) {
    rememberProjectComposerDefaults(targetRuntime.projectId, { thinkingLevel: targetRuntime.session.thinkingLevel });
  }
  await targetRuntime.settingsManager.flush();
  return buildSnapshot(targetRuntime);
}

async function createProject(body) {
  const cwd = resolve(String(body?.cwd ?? "").trim() || appCwd);
  mkdirSync(cwd, { recursive: true });
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Project folder is not a directory: ${cwd}`);
  }

  const existing = findProjectByFolder(state.projects, cwd);
  if (existing) {
    // That folder is already tracked: switch to the existing project instead of
    // adding a second one for it, and say so — the dialog reads this field to
    // tell the user the folder was opened, not created.
    const snapshot = await selectProject(existing.id);
    return {
      ...snapshot,
      existingProject: { id: existing.id, name: existing.name, cwd: existing.cwd },
    };
  }

  const now = Date.now();
  const name = String(body?.name ?? "").trim() || basename(cwd) || "Project";
  const project = {
    id: createProjectId(name),
    name,
    cwd,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    sessionPins: {},
    commands: [],
    selectedCommandId: "",
  };

  state.projects = [...state.projects, project];
  state.activeProjectId = project.id;
  saveProjects();
  return replaceRuntime(project);
}

async function selectProject(projectId) {
  const project = findProject(projectId);
  state.activeProjectId = project.id;
  saveProjects();
  return replaceRuntime(project, project.lastSessionPath);
}

async function updateProject(body) {
  const project = findProject(String(body?.projectId ?? ""));
  const name = String(body?.name ?? "").trim() || project.name;
  const cwdInput = String(body?.cwd ?? project.cwd).trim();
  const cwd = resolve(cwdInput || project.cwd);

  mkdirSync(cwd, { recursive: true });
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Project folder is not a directory: ${cwd}`);
  }

  const cwdChanged = cwd !== project.cwd;
  if (cwdChanged) {
    disposeProjectRuntimes(project.id);
  }

  state.projects = state.projects.map((candidate) =>
    candidate.id === project.id
      ? {
          ...candidate,
          name,
          cwd,
          updatedAt: Date.now(),
        }
      : candidate,
  );
  saveProjects();

  const updated = findProject(project.id);
  if (cwdChanged && updated.id === state.activeProjectId) {
    return replaceRuntime(updated, updated.lastSessionPath);
  }

  return refreshSnapshot();
}

async function reorderProjects(body) {
  const requestedIds = Array.isArray(body?.projectIds)
    ? body.projectIds.map((projectId) => String(projectId ?? "").trim()).filter(Boolean)
    : [];
  const knownIds = new Set(state.projects.map((project) => project.id));
  const reorderedIds = [
    ...requestedIds.filter((projectId, index) => knownIds.has(projectId) && requestedIds.indexOf(projectId) === index),
    ...state.projects.map((project) => project.id).filter((projectId) => !requestedIds.includes(projectId)),
  ];

  if (reorderedIds.length !== state.projects.length) {
    throw new Error("Invalid project order");
  }

  const projectsById = new Map(state.projects.map((project) => [project.id, project]));
  state.projects = reorderedIds.map((projectId) => projectsById.get(projectId));
  saveProjects();
  return refreshSnapshot();
}

async function pinProject(projectId, pinned) {
  const project = findProject(projectId);
  touchProject(project.id, { pinned: Boolean(pinned) });
  return refreshSnapshot();
}

async function removeProject(projectId) {
  const project = findProject(projectId);
  if (state.projects.length <= 1) {
    throw new Error("Cannot remove the last project");
  }

  disposeProjectRuntimes(project.id);
  state.projects = state.projects.filter((candidate) => candidate.id !== project.id);
  sessionStore.deleteProject(project.id);
  state.activeProjectId = state.activeProjectId === project.id ? state.projects[0].id : state.activeProjectId;
  saveProjects();

  if (project.id === state.runtime.projectId) {
    return replaceRuntime(activeProject(), activeProject().lastSessionPath);
  }

  return refreshSnapshot();
}

async function revealProject(projectId) {
  const project = findProject(projectId);
  await revealFolder(project.cwd);
  return refreshSnapshot();
}

async function createProjectSession(projectId, nameValue, worktreeRequest) {
  const project = findProject(projectId);
  state.activeProjectId = project.id;
  saveProjects();

  // worktree 必须在建会话之前建好：会话文件头里的 cwd 就是 worktree 路径（pi 的
  // `SessionManager.create(cwd, dir)` 会写进去），所以建失败就不建会话，不留半条记录。
  const worktree = worktreeRequest?.enabled ? await createSessionWorktree(project, worktreeRequest) : null;
  const sessionManager = SessionManager.create(worktree?.path ?? project.cwd, getProjectSessionDir(project));
  const name = String(nameValue ?? "").trim();
  if (name) {
    sessionManager.appendSessionInfo(name);
  }
  // Persist the shell immediately so a newly-created empty session can be
  // selected while its first prompt is still streaming.
  persistSessionShell(sessionManager);
  updateSessionStoreFromSession(project, sessionManager, { includeEmpty: true });
  return replaceRuntime(project, sessionManager.getSessionFile());
}

/**
 * 给新会话建一个托管 worktree（参考 Codex 桌面端：一个会话一个隔离检出、detached HEAD）。
 *
 * `baseRef` 默认 `HEAD`（当前分支的当前提交），非 Git 仓库 / 空仓库都给可读错误；
 * 建之前先 `readGitInfo` 查一次仓库，是为了把“不是仓库”和“还没有提交”分开说清楚。
 */
async function createSessionWorktree(project, request = {}) {
  const info = await readGitInfo(project.cwd);
  if (!info.isRepo) {
    throw new Error("只有 Git 仓库才能创建 worktree：先在这个项目里初始化仓库。");
  }

  const baseRef = String(request?.baseRef ?? "").trim() || "HEAD";
  const created = await createManagedWorktree(project.cwd, {
    root: worktreesRoot,
    id: managedWorktreeId(project.name, randomUUID().slice(0, 8)),
    baseRef,
  });
  diagnosticLog("worktree.created", {
    projectId: project.id,
    worktreePath: created.path,
    base: created.base,
    includedFiles: created.included.copied.length,
    skippedIncludeFiles: created.included.skipped,
    piLink: created.piLink?.reason ?? "",
  });
  return created;
}

async function selectProjectSession(projectId, sessionPath, requestId, clientTraceId) {
  const startedAt = Date.now();
  diagnosticLog("session.select.start", { requestId, clientTraceId, projectId, sessionPath });
  const project = findProject(projectId);
  if (!sessionPath) {
    throw new Error("sessionPath is required");
  }

  const projectSessionDir = getProjectSessionDir(project);
  const resolvedPath = resolve(sessionPath);
  if (!resolvedPath.startsWith(resolve(projectSessionDir))) {
    throw new Error("Session does not belong to this project");
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`Session file does not exist: ${resolvedPath}`);
  }

  state.activeProjectId = project.id;
  saveProjects();
  diagnosticLog("session.select.before_runtime", {
    requestId,
    clientTraceId,
    projectId: project.id,
    sessionPath: resolvedPath,
    durationMs: Date.now() - startedAt,
  });
  const response = await replaceRuntime(project, resolvedPath, { requestId, clientTraceId });
  diagnosticLog("session.select.snapshot_ready", {
    requestId,
    clientTraceId,
    projectId: project.id,
    sessionPath: resolvedPath,
    durationMs: Date.now() - startedAt,
    messageCount: response.snapshot?.conversation?.messages?.length,
  });
  return response;
}

async function updateProjectSession(projectId, sessionPath, nameValue) {
  const project = findProject(projectId);
  const resolvedPath = assertProjectSessionPath(project, sessionPath);
  const name = String(nameValue ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!name) {
    throw new Error("Session title is required");
  }

  const openRuntime = openRuntimes.get(sessionRuntimeKey(resolvedPath));
  if (openRuntime) {
    openRuntime.session.setSessionName(name);
    persistSessionShell(openRuntime.session.sessionManager);
    updateSessionStoreFromRuntime(openRuntime);
  } else {
    const sessionManager = SessionManager.open(resolvedPath, getProjectSessionDir(project));
    sessionManager.appendSessionInfo(name);
    persistSessionShell(sessionManager);
    updateSessionStoreFromSession(project, sessionManager);
  }

  return refreshSnapshot();
}

/**
 * 归档 / 取消归档一条会话。
 *
 * 归档只是会话索引上的一个标记，会话文件原样留在磁盘上（所以可恢复）；被归档的会话
 * 从项目的会话列表里消失，改由设置页的「归档聊天」列出。归档当前正在打开的会话时，
 * 跳回列表里的第一条未归档会话（没有就新建一条），否则活动会话会“挂着”一个不可见的会话。
 */
async function archiveProjectSession(projectId, sessionPath, archived = true) {
  const project = findProject(projectId);
  const resolvedPath = assertProjectSessionPath(project, sessionPath);
  const isActiveSession = resolvedPath === state.runtime.session.sessionFile;

  // 先确保索引里有这条记录：索引是归档清单的唯一来源，没登记的话归档后就找不回来了。
  const openRuntime = openRuntimes.get(sessionRuntimeKey(resolvedPath));
  if (openRuntime) {
    updateSessionStoreFromRuntime(openRuntime);
  } else if (existsSync(resolvedPath)) {
    // 不传 cwdOverride：会话文件头里的 cwd 才是它真正的工作目录（worktree 会话不能在这里
    // 被改回项目目录）。
    const sessionManager = SessionManager.open(resolvedPath, getProjectSessionDir(project));
    updateSessionStoreFromSession(project, sessionManager);
  }
  sessionStore.setArchived(project.id, resolvedPath, archived);

  if (archived && isActiveSession) {
    disposeRuntime(resolvedPath);
    const sessions = listProjectSessions(findProject(project.id));
    return replaceRuntime(findProject(project.id), sessions[0]?.path);
  }

  return refreshSnapshot();
}

/**
 * 永久删除归档会话：全部，或限某个项目。
 *
 * 归档会话不在侧栏里，但它可能仍是当前活动会话（归档那一刻起就没再切过会话），
 * 所以这里要像 deleteProjectSession 一样处理“删到活动会话”的情况。
 */
async function deleteArchivedSessions(projectId = "") {
  const archived = sessionStore.listArchived().filter((session) => !projectId || session.projectId === projectId);
  let activeSessionDeleted = false;

  for (const session of archived) {
    const project = findProject(session.projectId);
    if (!project) {
      sessionStore.remove(session.projectId, session.path);
      continue;
    }
    const resolvedPath = assertProjectSessionPath(project, session.path);
    if (resolvedPath === state.runtime.session.sessionFile) {
      activeSessionDeleted = true;
    }
    removeSessionRecord(project, resolvedPath);
  }

  if (activeSessionDeleted) {
    const project = findProject(state.runtime.projectId);
    const sessions = listProjectSessions(project);
    return replaceRuntime(project, sessions[0]?.path);
  }

  return refreshSnapshot();
}

function saveProjects() {
  writeJsonFile(projectsFile, {
    activeProjectId: state.activeProjectId,
    projects: state.projects,
  });
}

function touchProject(projectId, patch = {}) {
  const now = Date.now();
  state.projects = state.projects.map((project) => (project.id === projectId ? { ...project, ...patch, updatedAt: now } : project));
  saveProjects();
}

function listProjectsWithSessions() {
  return state.projects.map((project) => ({
    ...project,
    // 计算出来的，不是存的项目字段：`saveProjects()` 写盘时不会带上它。
    codemode: projectToolToggleState(project),
    sessions: listProjectSessions(project),
  }));
}

function listProjectSessions(project) {
  // 侧栏会话行末尾那枚 worktree 徽标：摘要里带一个布尔即可，不必逐会话再去问一次 git。
  // 判定复用「这条会话跑在哪个目录」的唯一规则（`resolveSessionWorkspaceCwd`，reason
  // `worktree` = 落在托管根目录里且目录还在）—— 目录已被移除/外部删掉时会话已经退回项目
  // 目录，列表徽标必须跟着消失，否则移除后还会留着一个点不掉的标记。
  return sessionStore.list(project).map((session) => ({
    ...session,
    inWorktree:
      resolveSessionWorkspaceCwd({
        projectCwd: project.cwd,
        worktreeRoot: worktreesRoot,
        sessionCwd: session.cwd,
      }).reason === "worktree",
  }));
}

/**
 * 保证 worktree 会话能看到项目根的 `.pi`（项目级 skills / extensions / 包配置）。
 *
 * 幂等、不抛错：差的是「项目级能力看不见」，不该让开会话 / 重载失败，诊断里留 reason 即可。
 * 只在 workspace 真的落在托管 worktree 里时动手；普通会话和其它目录一律不碰（绝不在项目
 * 子目录里凭空造出一个 `.pi` 软链）。
 */
function ensureWorktreePiLink(project, workspaceCwd, trace = {}) {
  if (!project || !workspaceCwd || workspaceCwd === project.cwd) {
    return null;
  }
  if (!isManagedWorktreePath(worktreesRoot, workspaceCwd)) {
    return null;
  }
  const piLink = linkProjectPiIntoWorktree(project.cwd, workspaceCwd);
  if (piLink.reason === "error") {
    console.error(
      `[pi-desktop:worktree] 项目 .pi 无法链进 worktree：${piLink.error instanceof Error ? piLink.error.message : String(piLink.error ?? "")}`,
    );
  }
  if (piLink.reason !== "already" && piLink.reason !== "no-project-pi" && piLink.reason !== "existing-pi") {
    diagnosticLog("worktree.pi_link", {
      projectId: project.id,
      worktreePath: workspaceCwd,
      linked: piLink.linked,
      reason: piLink.reason,
      ...trace,
    });
  }
  return piLink;
}

/** 按会话路径解析 workspace：优先已打开的 runtime，其次会话索引里的 cwd。 */
function sessionWorkspaceCwdForPath(project, sessionPath) {
  const resolvedPath = resolve(String(sessionPath ?? ""));
  const openRuntime = openRuntimes.get(sessionRuntimeKey(resolvedPath));
  if (openRuntime?.workspaceCwd) {
    return openRuntime.workspaceCwd;
  }

  const stored = sessionStore.findCwd(project.id, resolvedPath);
  if (stored && isManagedWorktreePath(worktreesRoot, stored) && existsSync(stored)) {
    return stored;
  }
  return project.cwd;
}

/**
 * 读取一条会话的 worktree 信息（会话头部那枚 worktree 徽标的数据源）。
 * 不在托管 worktree 里就是 `{ isWorktree: false }`，UI 据此不显示徽标。
 */
async function readSessionWorktreeInfo(project, sessionPath) {
  const resolvedPath = assertProjectSessionPath(project, sessionPath);
  const cwd = sessionWorkspaceCwdForPath(project, resolvedPath);
  if (!isManagedWorktreePath(worktreesRoot, cwd)) {
    return { isWorktree: false };
  }

  const exists = existsSync(cwd);
  const changes = exists ? await readWorktreeChanges(cwd) : { changed: [], untracked: [], ignored: [] };
  const entries = await listManagedWorktrees(project.cwd, { root: worktreesRoot });
  const entry = entries.find((candidate) => resolve(candidate.path) === resolve(cwd));
  return {
    isWorktree: true,
    path: cwd,
    displayName: worktreeDisplayName(cwd),
    exists,
    branch: entry?.branchName ?? "",
    detached: entry ? entry.detached : true,
    changes: {
      changed: changes.changed.length,
      untracked: changes.untracked.length,
      ignored: changes.ignored.length,
    },
  };
}

/**
 * 删除一条会话的托管 worktree：清掉检出、把会话退回主检出。
 *
 * 三道闸：回答生成中不能删（会话还指着这个目录）；git 侧还有一道（有未提交内容且没 `force`
 * 就拒绝，见 `removeManagedWorktree`）；路由层只负责把用户二次确认后的 `force` 传下来。
 *
 * 目录已经被外部删掉时这里仍然放行：此时移除唯一的作用就是清掉 git 里的注册信息（在
 * `removeManagedWorktree` 里走 prune），不然那个红徽标永远点不掉。
 */
async function removeSessionWorktree(project, sessionPath, force) {
  const resolvedPath = assertProjectSessionPath(project, sessionPath);
  const cwd = sessionWorkspaceCwdForPath(project, resolvedPath);
  if (!isManagedWorktreePath(worktreesRoot, cwd)) {
    throw new Error("这条会话不在托管 worktree 里。");
  }
  const wasActive = resolvedPath === state.runtime.session.sessionFile;
  const openRuntime = openRuntimes.get(sessionRuntimeKey(resolvedPath));
  if (openRuntime && isSessionBusy(openRuntime.session)) {
    throw new Error("回答生成中，先等它结束再移除 worktree。");
  }

  await removeManagedWorktree(project.cwd, cwd, { root: worktreesRoot, force: Boolean(force) });
  diagnosticLog("worktree.removed", { projectId: project.id, worktreePath: cwd, reason: "user" });

  // 会话文件头里的 cwd 改不了（pi 不提供 setter），但目录已经没了 —— `sessionWorkspaceCwd`
  // 下一次就会退回项目目录，索引里的 cwd 也会在 upsert 时跟着改回项目目录。
  if (wasActive) {
    disposeRuntime(resolvedPath);
    return { result: await replaceRuntime(project, resolvedPath), worktree: await readSessionWorktreeInfo(project, resolvedPath) };
  }

  return { result: await refreshSnapshot(), worktree: await readSessionWorktreeInfo(project, resolvedPath) };
}

  return { archiveProjectSession, createProject, createProjectSession, createSessionWorktree, deleteArchivedSessions, ensureWorktreePiLink, listProjectSessions, listProjectsWithSessions, pinProject, projectCommandRuns, readSessionWorktreeInfo, removeProject, removeSessionWorktree, reorderProjects, revealProject, saveProjects, selectProject, selectProjectSession, sessionWorkspaceCwdForPath, setSessionThinkingLevel, touchProject, updateProject, updateProjectSession };
}
