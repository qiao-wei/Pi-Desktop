/**
 * 会话存储工厂.
 *
 * SessionStore 的构造与配套的会话目录/数据库路径、记录适配。
 *
 * 从 `server/index.mjs` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import { messageToText } from "../src/shared/chatBubbles.ts";
import { deriveSessionTitle } from "../src/shared/sessionTitle.ts";
import { sanitizeDiagnosticDetails } from "./diagnosticsHelpers.mjs";
import { worktreeRootFor } from "./gitWorktree.mjs";
import { SessionManager } from "./piKernel.mjs";
import { ensureSessionArchiveColumn, listArchivedSessionRows, listProjectSessionRows } from "./sessionArchive.mjs";
import { resolveSessionWorkspaceCwd } from "./sessionWorkspace.mjs";
import { parseTime } from "./smallHelpers.mjs";
import { openSqliteDatabase } from "./sqlite.mjs";
import { appendFile as appendFileAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

const DIAGNOSTIC_FLUSH_MS = 250;

const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

const agentSessionsDir = join(agentDir, "sessions");

async function createSessionStore(projectList) {
  const db = await openSqliteDatabase(sessionsDatabaseFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS session_index (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      first_message TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, path)
    );
    CREATE INDEX IF NOT EXISTS session_index_project_sort
      ON session_index (project_id, pinned DESC, updated_at DESC);
    CREATE TABLE IF NOT EXISTS session_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 旧库没有 archived 列：CREATE TABLE IF NOT EXISTS 对已存在的表是空操作，只能显式补列。
  // 详见 server/sessionArchive.mjs（可测、幂等）。
  ensureSessionArchiveColumn(db);

  const versionRow = db.query("SELECT value FROM session_index_meta WHERE key = 'version'").get();
  if (Number(versionRow?.value ?? 0) < sessionsDatabaseVersion) {
    const insert = db.prepare(`
      INSERT INTO session_index (
        project_id, path, id, name, title, cwd, created_at, updated_at,
        message_count, first_message, pinned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET
        id = excluded.id,
        name = excluded.name,
        title = excluded.title,
        cwd = excluded.cwd,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        message_count = excluded.message_count,
        first_message = excluded.first_message
    `);
    const migratedRows = [];
    for (const project of projectList) {
      const sessions = await SessionManager.list(project.cwd, getProjectSessionDir(project));
      for (const session of sessions) {
        if (session.messageCount <= 0) {
          continue;
        }
        const path = resolve(session.path);
        const pins = project.sessionPins && typeof project.sessionPins === "object" ? project.sessionPins : {};
        migratedRows.push([
          project.id,
          path,
          String(session.id ?? basename(path, extname(path))),
          session.name || null,
          session.name || deriveSessionTitle({ text: session.firstMessage }) || "New session",
          session.cwd || project.cwd,
          session.created?.getTime?.() || Date.now(),
          session.modified?.getTime?.() || Date.now(),
          session.messageCount,
          session.firstMessage || "(no messages)",
          pins[path] ? 1 : 0,
        ]);
      }
    }
    db.transaction(() => {
      for (const row of migratedRows) {
        insert.run(...row);
      }
      db.query(`
        INSERT INTO session_index_meta (key, value) VALUES ('version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(sessionsDatabaseVersion));
    })();
  }

  const selectByPath = db.prepare("SELECT pinned, archived FROM session_index WHERE project_id = ? AND path = ?");
  const insert = db.prepare(`
    INSERT INTO session_index (
      project_id, path, id, name, title, cwd, created_at, updated_at,
      message_count, first_message, pinned, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, path) DO UPDATE SET
      id = excluded.id,
      name = excluded.name,
      title = excluded.title,
      cwd = excluded.cwd,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      message_count = excluded.message_count,
      first_message = excluded.first_message
  `);

  return {
    upsert(project, sessionManager, options = {}) {
      const record = sessionRecordFromManager(project, sessionManager);
      const existing = selectByPath.get(project.id, record.path);
      if (record.messageCount <= 0 && !options.includeEmpty && !existing) {
        db.query("DELETE FROM session_index WHERE project_id = ? AND path = ?").run(project.id, record.path);
        return;
      }
      const pins = project.sessionPins && typeof project.sessionPins === "object" ? project.sessionPins : {};
      insert.run(
        record.projectId,
        record.path,
        record.id,
        record.name,
        record.title,
        record.cwd,
        record.createdAt,
        record.updatedAt,
        record.messageCount,
        record.firstMessage,
        existing ? Number(existing.pinned) : (pins[record.path] ? 1 : 0),
        // 归档位只由用户动作切换：会话被重新打开/续写（upsert）时不能把它悄悄取消。
        existing ? Number(existing.archived) : 0,
      );
    },
    remove(projectId, path) {
      db.query("DELETE FROM session_index WHERE project_id = ? AND path = ?").run(projectId, resolve(path));
    },
    setPinned(projectId, path, pinned) {
      db.query("UPDATE session_index SET pinned = ? WHERE project_id = ? AND path = ?")
        .run(pinned ? 1 : 0, projectId, resolve(path));
    },
    setArchived(projectId, path, archived) {
      db.query("UPDATE session_index SET archived = ? WHERE project_id = ? AND path = ?")
        .run(archived ? 1 : 0, projectId, resolve(path));
    },
    /** 归档会话不能当会话打开（项目 lastSessionPath 可能还指着它）。 */
    isArchived(projectId, path) {
      const row = db.query("SELECT archived FROM session_index WHERE project_id = ? AND path = ?")
        .get(projectId, resolve(path));
      return Boolean(row?.archived);
    },
    /** 会话索引里的 cwd（会话可能没打开，但 worktree 清理需要知道它当时在哪）。 */
    findCwd(projectId, path) {
      const row = db.query("SELECT cwd FROM session_index WHERE project_id = ? AND path = ?")
        .get(projectId, resolve(path));
      return String(row?.cwd ?? "");
    },
    deleteProject(projectId) {
      db.query("DELETE FROM session_index WHERE project_id = ?").run(projectId);
    },
    list(project) {
      return listProjectSessionRows(db, project.id, project.cwd);
    },
    /**
     * 归档清单是跨项目的（设置页把它们按项目分组展示），所以这里不按 project 过滤，
     * 由调用方补上 projectName。
     */
    listArchived() {
      return listArchivedSessionRows(db);
    },
    close() {
      db.close();
    },
  };
}

let diagnosticFlushTimer = null;

const diagnosticLines = [];

function diagnosticLog(event, fields = {}) {
  if (!diagnosticsEnabled) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    event,
    ...sanitizeDiagnosticDetails(fields),
  };
  const line = JSON.stringify(entry);
  diagnosticLines.push(line);
  scheduleDiagnosticFlush();
  if (diagnosticToStderr) {
    console.warn(`[pi-desktop-diagnostic] ${line}`);
  }
}

const diagnosticLogFile = process.env.PI_DESKTOP_DIAGNOSTIC_LOG?.trim() || join(agentDir, "pi-desktop-runtime.ndjson");

const diagnosticToStderr = process.env.PI_DESKTOP_DIAGNOSTICS_STDERR === "1";

let diagnosticWriting = false;

const diagnosticsEnabled = process.env.PI_DESKTOP_DIAGNOSTICS_ENABLED === "1";

async function flushDiagnostics() {
  if (diagnosticWriting || diagnosticLines.length === 0) {
    return;
  }
  diagnosticWriting = true;
  const batch = `${diagnosticLines.splice(0).join("\n")}\n`;
  try {
    await appendFileAsync(diagnosticLogFile, batch, "utf8");
  } catch (error) {
    console.error(`[pi-desktop-diagnostic] failed to write ${diagnosticLogFile}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    diagnosticWriting = false;
    if (diagnosticLines.length > 0) {
      scheduleDiagnosticFlush();
    }
  }
}

function getProjectSessionDir(project) {
  return join(projectSessionRoot, project.id);
}

const projectSessionRoot = agentSessionsDir;

function scheduleDiagnosticFlush() {
  if (diagnosticFlushTimer !== null) {
    return;
  }
  diagnosticFlushTimer = setTimeout(() => {
    diagnosticFlushTimer = null;
    void flushDiagnostics();
  }, DIAGNOSTIC_FLUSH_MS);
  diagnosticFlushTimer?.unref?.();
}

function sessionRecordFromManager(project, sessionManager) {
  const path = resolve(sessionManager.getSessionFile());
  const entries = sessionManager.getEntries();
  const messageEntries = entries.filter((entry) => entry?.type === "message" && entry.message);
  const firstUserMessage = messageEntries.find((entry) => entry.message?.role === "user");
  const firstMessage = firstUserMessage ? messageToText(firstUserMessage.message) : "";
  const header = sessionManager.getHeader();
  const createdAt = parseTime(header?.timestamp) ?? Date.now();
  const updatedAt = messageEntries.reduce((latest, entry) => {
    const timestamp = typeof entry.message?.timestamp === "number"
      ? entry.message.timestamp
      : parseTime(entry.timestamp);
    return timestamp && timestamp > latest ? timestamp : latest;
  }, createdAt);
  const name = sessionManager.getSessionName() || null;
  return {
    projectId: project.id,
    path,
    id: sessionManager.getSessionId() || basename(path, extname(path)),
    name,
    title: name || (firstMessage ? deriveSessionTitle({ text: firstMessage }) : "New session") || "New session",
    cwd: sessionWorkspaceCwd(project, sessionManager),
    createdAt,
    updatedAt,
    messageCount: messageEntries.length,
    firstMessage,
  };
}

/**
 * 会话自己的工作目录，唯一判定口（规则本身在 `sessionWorkspace.mjs`，可测）。
 *
 * 只有同时满足「落在托管 worktree 根目录里」+「目录还在」才采信 worktree 路径；否则退回
 * 项目目录 —— 项目被移动、会话文件被手改、worktree 被外部删掉时都不会让 agent 跑错地方。
 */
function sessionWorkspaceCwd(project, sessionManager) {
  const resolved = resolveSessionWorkspaceCwd({
    projectCwd: project.cwd,
    worktreeRoot: worktreesRoot,
    sessionCwd: sessionManager?.getCwd?.(),
  });
  if (resolved.reason === "missing") {
    diagnosticLog("worktree.missing", { projectId: project.id, worktreePath: String(sessionManager?.getCwd?.() ?? "") });
  }
  return resolved.cwd;
}

const sessionsDatabaseFile = join(agentDir, "sessions.sqlite");

const sessionsDatabaseVersion = 1;

const worktreesRoot = worktreeRootFor(agentDir);

export { DIAGNOSTIC_FLUSH_MS, agentDir, agentSessionsDir, createSessionStore, diagnosticFlushTimer, diagnosticLines, diagnosticLog, diagnosticLogFile, diagnosticToStderr, diagnosticWriting, diagnosticsEnabled, flushDiagnostics, getProjectSessionDir, projectSessionRoot, scheduleDiagnosticFlush, sessionRecordFromManager, sessionWorkspaceCwd, sessionsDatabaseFile, sessionsDatabaseVersion, worktreesRoot };
