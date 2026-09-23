/**
 * 归档功能的 SQL 层：旧库补列（幂等）+ 侧栏列表必须排除归档 + 归档清单的排序/字段映射。
 *
 * 「归档后会话凭空消失」这类 bug 只写源码字符串断言抓不到，所以这一层用内存 SQLite
 * 真跑：`server/sessionArchive.mjs` 就是为此从 index.mjs 拆出来的。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { openSqliteDatabase } from "../server/sqlite.mjs";
import {
  ensureSessionArchiveColumn,
  listArchivedSessionRows,
  listProjectSessionRows,
} from "../server/sessionArchive.mjs";

const LEGACY_SCHEMA = `
  CREATE TABLE session_index (
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
    PRIMARY KEY (project_id, path)
  );
`;

const CURRENT_SCHEMA = `${LEGACY_SCHEMA.replace(
  "pinned INTEGER NOT NULL DEFAULT 0,",
  "pinned INTEGER NOT NULL DEFAULT 0,\n    archived INTEGER NOT NULL DEFAULT 0,",
)}`;

const COLUMNS = `(project_id, path, id, name, title, cwd, created_at, updated_at, message_count, first_message, pinned, archived)`;

function insert(db, row) {
  db.prepare(`INSERT INTO session_index ${COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.projectId,
    row.path,
    row.id ?? row.path,
    row.name ?? null,
    row.title ?? "T",
    row.cwd ?? "/tmp/p",
    row.createdAt ?? 1,
    row.updatedAt ?? 1,
    row.messageCount ?? 1,
    row.firstMessage ?? "",
    row.pinned ? 1 : 0,
    row.archived ? 1 : 0,
  );
}

async function withDb(schema, body) {
  const db = await openSqliteDatabase(":memory:");
  db.exec(schema);
  try {
    return await body(db);
  } finally {
    db.close();
  }
}

test("旧库缺 archived 列时补上，且迁移可重复执行", async () => {
  await withDb(LEGACY_SCHEMA, async (db) => {
    db.prepare(
      `INSERT INTO session_index (project_id, path, id, title, cwd, created_at, updated_at, message_count, first_message, pinned)
       VALUES ('p1', '/old', 'old', 'Old chat', '/tmp/p', 1, 1, 3, 'hi', 0)`,
    ).run();

    assert.equal(ensureSessionArchiveColumn(db), true, "第一次应当真的补列");
    const columns = db.query("PRAGMA table_info(session_index)").all().map((column) => column.name);
    assert.ok(columns.includes("archived"));
    const row = { ...db.query("SELECT archived FROM session_index WHERE path = '/old'").get() };
    assert.equal(row.archived, 0, "存量会话默认未归档");

    assert.equal(ensureSessionArchiveColumn(db), false, "第二次应当是空操作（幂等）");
  });
});

test("新库已有 archived 列时不会被重复 ALTER", async () => {
  await withDb(CURRENT_SCHEMA, async (db) => {
    assert.equal(ensureSessionArchiveColumn(db), false);
  });
});

test("侧栏列表排除归档会话，且置顶在前、更新时间倒序", async () => {
  await withDb(CURRENT_SCHEMA, async (db) => {
    insert(db, { projectId: "p1", path: "/a", title: "A", updatedAt: 100 });
    insert(db, { projectId: "p1", path: "/b", title: "B", updatedAt: 300, pinned: true });
    insert(db, { projectId: "p1", path: "/archived", title: "Gone", updatedAt: 900, archived: true });
    insert(db, { projectId: "p2", path: "/other", title: "Other" });

    const rows = listProjectSessionRows(db, "p1", "/fallback");
    assert.deepEqual(rows.map((row) => row.path), ["/b", "/a"], "归档行不得回到侧栏");
    assert.equal(rows[0].pinned, true);
    assert.equal(rows[0].name, undefined);
  });
});

test("项目名与 cwd 缺失时有回退，message_count=0 显示 New session", async () => {
  await withDb(CURRENT_SCHEMA, async (db) => {
    insert(db, { projectId: "p1", path: "/empty", title: "whatever", messageCount: 0, cwd: "" });
    const [row] = listProjectSessionRows(db, "p1", "/fallback");
    assert.equal(row.title, "New session");
    assert.equal(row.cwd, "/fallback");
    assert.equal(row.messageCount, 0);
  });
});

test("归档清单跨项目、最近更新在前，并带上 projectId", async () => {
  await withDb(CURRENT_SCHEMA, async (db) => {
    insert(db, { projectId: "p1", path: "/a", title: "A", updatedAt: 100, archived: true });
    insert(db, { projectId: "p2", path: "/b", title: "B", updatedAt: 300, archived: true });
    insert(db, { projectId: "p1", path: "/live", title: "Live", updatedAt: 500 });

    const rows = listArchivedSessionRows(db);
    assert.deepEqual(rows.map((row) => row.path), ["/b", "/a"]);
    assert.deepEqual(rows.map((row) => row.projectId), ["p2", "p1"]);
    assert.equal(rows[0].pinned, false);
  });
});

test("归档清单为空时返回空数组（UI 走空状态）", async () => {
  await withDb(CURRENT_SCHEMA, async (db) => {
    insert(db, { projectId: "p1", path: "/live", title: "Live" });
    assert.deepEqual(listArchivedSessionRows(db), []);
  });
});