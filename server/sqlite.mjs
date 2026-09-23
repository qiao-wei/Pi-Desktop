import { existsSync } from "node:fs";

/**
 * SQLite access for the bridge, which has to run under both runtimes:
 *   - bun (dev: `bun server/index.mjs`, and the historical compiled sidecar), and
 *   - the app's bundled Node (production, once the bridge stopped being compiled into a
 *     single executable — extensions then resolve pi's modules from disk instead of from
 *     whatever symbol names the bundler happened to pick for this build).
 *
 * bun's `bun:sqlite` exposes two conveniences Node does not: `db.query(sql)` and
 * `db.transaction(fn)`. Everything else the bridge uses (`exec`, `prepare`, `run`, `get`,
 * `all`, `close`, `$name` parameters) exists in `node:sqlite` with the same shape.
 */

export function withBunSqliteCompat(db) {
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

/** Open a database with whichever runtime this is, always returning the bun-shaped API. */
export async function openSqliteDatabase(path, options) {
  try {
    const { Database } = await import("bun:sqlite");
    return new Database(path, options);
  } catch {
    // Not bun (or bun:sqlite unavailable): fall back to the platform sqlite binding.
  }
  const { DatabaseSync } = await import("node:sqlite");
  // `node:sqlite` opens the file inside the constructor, so bun's `{ create: false }` maps to
  // `readOnly: true` (which refuses a missing file) rather than to a check we could run later.
  const readOnly = options?.create === false;
  try {
    const db = new DatabaseSync(path, { readOnly, readBigInts: false });
    return withBunSqliteCompat(db);
  } catch (error) {
    if (readOnly && !existsSync(path)) {
      throw new Error(`database not found: ${path}`);
    }
    throw error;
  }
}
