/**
 * 归档会话的 SQL（迁移 + 两条列表查询）。
 *
 * 从 server/index.mjs 里拆出来的唯一原因是可测：index.mjs 一 import 就起服务，而这几句
 * 是「归档功能坏掉会静默丢会话」的地方 —— 旧库缺 archived 列、或侧栏列表忘了过滤归档行，
 * 都只会表现为会话凭空消失。用内存 SQLite 真跑一遍，比在源码上做字符串断言可靠。
 *
 * 注意：`listProjectSessionRows` 与 `listArchivedSessionRows` 的 SELECT 列 / 映射必须保持一致，
 * 前端的 ArchivedSessionSummary 直接复用 ProjectSessionSummary 的字段。
 */

/** @returns {boolean} 是否真的补了列（false = 本来就存在，迁移幂等）。 */
export function ensureSessionArchiveColumn(db) {
  // CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，只能显式 ALTER。
  // 归档只改索引不改会话文件，所以不重扫磁盘（重扫会把删掉的会话又加回来）。
  const columns = db.query("PRAGMA table_info(session_index)").all();
  if (columns.some((column) => column.name === "archived")) {
    return false;
  }
  db.exec("ALTER TABLE session_index ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  return true;
}

function toSessionSummary(row, fallbackCwd) {
  return {
    path: row.path,
    id: row.id,
    name: row.name || undefined,
    title: Number(row.message_count) > 0 ? row.title : "New session",
    cwd: row.cwd || fallbackCwd,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: Number(row.message_count),
    firstMessage: row.first_message || "",
    pinned: Boolean(row.pinned),
  };
}

/** 侧栏用的会话列表：必须排除已归档的行，否则归档等于没归档。 */
export function listProjectSessionRows(db, projectId, fallbackCwd) {
  return db.query(`
    SELECT path, id, name, title, cwd, created_at, updated_at,
      message_count, first_message, pinned
    FROM session_index
    WHERE project_id = ? AND archived = 0
    ORDER BY pinned DESC, updated_at DESC
  `).all(projectId).map((row) => toSessionSummary(row, fallbackCwd));
}

/** 设置页「归档聊天」用的跨项目列表，最近更新的在前。 */
export function listArchivedSessionRows(db) {
  return db.query(`
    SELECT project_id, path, id, name, title, cwd, created_at, updated_at,
      message_count, first_message, pinned
    FROM session_index
    WHERE archived = 1
    ORDER BY updated_at DESC
  `).all().map((row) => ({
    ...toSessionSummary(row, ""),
    projectId: row.project_id,
  }));
}