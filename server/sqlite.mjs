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

/** Open a database and hand back the API shape the rest of the bridge expects. */
export async function openSqliteDatabase(path, options) {
  const { DatabaseSync } = await import("node:sqlite");
  // `node:sqlite` opens the file inside the constructor, so a read-only open maps to
  // `readOnly: true` (which refuses a missing file) rather than to a check we could run later.
  const readOnly = options?.create === false;
  try {
    const db = new DatabaseSync(path, { readOnly, readBigInts: false });
    return withSqliteConveniences(db);
  } catch (error) {
    if (readOnly && !existsSync(path)) {
      throw new Error(`database not found: ${path}`);
    }
    throw error;
  }
}