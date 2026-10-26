import { existsSync } from "node:fs";

/**
 * SQLite access for the bridge. There is exactly one runtime in play: the Node that boots the
 * bridge (dev: the dev stack's own `node`; packaged: the app's bundled `node-runtime` through the
 * `pi-desktop-server` launcher). `node:sqlite` is therefore the binding, not a fallback.
 *
 * `node:sqlite` lacks two conveniences the bridge's callers are written against - `db.query(sql)`
 * and `db.transaction(fn)`. Everything else used here (`exec`, `prepare`, `run`, `get`, `all`,
 * `close`, `$name` parameters) exists with the same shape, so the shim below is the only thing
 * standing between the session index and a crash on startup.
 */

export function withSqliteConveniences(db) {
  if (typeof db.query !== "function") {
    db.query = (sql) => db.prepare(sql);
  }
  if (typeof db.transaction !== "function") {
    let depth = 0;
    db.transaction = (fn) => (...args) => {
      if (depth === 0) {
        db.exec("BEGIN");
      } else {
        db.exec(`SAVEPOINT pi_desktop_tx_${depth}`);
      }
      depth += 1;
      try {
        const result = fn(...args);
        depth -= 1;
        if (depth === 0) {
          db.exec("COMMIT");
        } else {
          db.exec(`RELEASE SAVEPOINT pi_desktop_tx_${depth}`);
        }
        return result;
      } catch (error) {
        depth -= 1;
        if (depth === 0) {
          db.exec("ROLLBACK");
        } else {
          db.exec(`ROLLBACK TO SAVEPOINT pi_desktop_tx_${depth}`);
          db.exec(`RELEASE SAVEPOINT pi_desktop_tx_${depth}`);
        }
        throw error;
      }
    };
  }
  return db;
}

/**
 * 驱动插槽。`node:sqlite` 只在本文件被命名；`setSqliteFactory()` 是换驱动的那扇门。
 *
 * 为什么需要它：`openSqliteDatabase()` 以前直接 `import("node:sqlite")`，于是「可替换性」只是
 * 一句注释——调用方拿到的是写死的实现，换驱动只能改文件。装上插槽后，宿主或测试都能给出另一个
 * 驱动，而 `createSessionStore` 这类调用点一行不改。
 */
let openDatabase = openWithNodeSqlite;

/** 装上 `openSqliteDatabase()` 要用的驱动；传 `null` 恢复内置的 `node:sqlite`。 */
export function setSqliteFactory(factory) {
  openDatabase = typeof factory === "function" ? factory : openWithNodeSqlite;
}

/** Open a database and hand back the API shape the rest of the bridge expects. */
export async function openSqliteDatabase(path, options) {
  return withSqliteConveniences(await openDatabase(path, options));
}

async function openWithNodeSqlite(path, options) {
  const { DatabaseSync } = await import("node:sqlite");
  // `node:sqlite` opens the file inside the constructor, so a read-only open maps to
  // `readOnly: true` (which refuses a missing file) rather than to a check we could run later.
  const readOnly = options?.create === false;
  try {
    const db = new DatabaseSync(path, { readOnly, readBigInts: false });
    // 不在这里补 convenience：补的地方只有一个（`openSqliteDatabase`），否则换驱动时会漏。
    return db;
  } catch (error) {
    if (readOnly && !existsSync(path)) {
      throw new Error(`database not found: ${path}`);
    }
    throw error;
  }
}