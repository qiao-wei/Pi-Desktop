/**
 * The bridge has to speak to SQLite from both runtimes: bun (dev) and the app's bundled Node
 * (production, once the bridge is no longer compiled into a single executable). `node:sqlite`
 * lacks bun's `db.query()` and `db.transaction()` conveniences, so the compat shim is the only
 * thing standing between the session index and a crash on startup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { openSqliteDatabase, withBunSqliteCompat } from "../server/sqlite.mjs";

const ROOT = resolve(import.meta.dirname, "..");

// node:sqlite returns null-prototype rows, so strict deepEqual needs a plain copy first.
const plain = (row) => (row == null ? row : { ...row });
const plainAll = (rows) => (rows ?? []).map(plain);

async function memoryDb() {
  const db = await openSqliteDatabase(":memory:");
  db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)");
  return db;
}

test("node:sqlite gets bun's query() shape", async () => {
  const db = await memoryDb();
  db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(1, "one");

  assert.deepEqual(plain(db.query("SELECT b FROM t WHERE a = 1").get()), { b: "one" });
  assert.deepEqual(plainAll(db.query("SELECT a FROM t").all()), [{ a: 1 }]);
  db.close();
});

test("transactions commit, and roll back when the body throws", async () => {
  const db = await memoryDb();
  const insert = db.prepare("INSERT INTO t (a, b) VALUES ($a, $b)");

  db.transaction(() => {
    insert.run({ a: 1, b: "kept" });
  })();

  assert.throws(() => {
    db.transaction(() => {
      insert.run({ a: 2, b: "doomed" });
      throw new Error("boom");
    })();
  }, /boom/);

  assert.deepEqual(plainAll(db.query("SELECT a FROM t ORDER BY a").all()), [{ a: 1 }]);
  db.close();
});

test("a failing inner transaction rolls back only itself", async () => {
  const db = await memoryDb();
  const insert = db.prepare("INSERT INTO t (a, b) VALUES ($a, $b)");

  assert.throws(() => {
    db.transaction(() => {
      insert.run({ a: 1, b: "outer" });
      db.transaction(() => {
        insert.run({ a: 2, b: "inner" });
        throw new Error("inner boom");
      })();
    })();
  }, /inner boom/);

  // The outer transaction was aborted by the rethrow, so nothing survives.
  assert.deepEqual(plainAll(db.query("SELECT a FROM t").all()), []);

  db.transaction(() => {
    insert.run({ a: 3, b: "outer-ok" });
    db.transaction(() => {
      insert.run({ a: 4, b: "inner-ok" });
    })();
  })();

  assert.deepEqual(plainAll(db.query("SELECT a FROM t ORDER BY a").all()), [{ a: 3 }, { a: 4 }]);
  db.close();
});

test("a file database opens, persists and closes", async () => {
  const dir = join(tmpdir(), `pi-desktop-sqlite-${Date.now()}-${process.pid}`);
  const file = join(dir, "sessions.sqlite");
  mkdirSync(dir, { recursive: true });
  assert.equal(existsSync(file), false);

  const db = await openSqliteDatabase(file);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta VALUES (?, ?)").run("version", "3");
  db.close();

  const reopened = await openSqliteDatabase(file);
  assert.deepEqual(plain(reopened.query("SELECT value FROM meta WHERE key = 'version'").get()), { value: "3" });
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("open read-only refuses a database that is not there", async () => {
  const missing = join(tmpdir(), `pi-desktop-missing-${Date.now()}-${process.pid}.sqlite`);
  await assert.rejects(openSqliteDatabase(missing, { create: false }), /database not found/);
});

test("the shim is idempotent and never clobbers a real bun implementation", () => {
  const seen = [];
  const fakeBun = {
    prepare: () => ({}),
    query: (sql) => seen.push(sql),
    transaction: () => () => "original",
  };
  const patched = withBunSqliteCompat(fakeBun);

  patched.query("SELECT 1");
  assert.deepEqual(seen, ["SELECT 1"]);
  assert.equal(patched.transaction(() => {})(), "original");
});

test("the bridge no longer imports bun-only modules", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");

  assert.ok(!/from "bun:/.test(source), "bun: imports would make the bridge bun-only");
  assert.match(source, /import \{ openSqliteDatabase \} from "\.\/sqlite\.mjs"/);
  assert.match(source, /await openSqliteDatabase\(sessionsDatabaseFile\)/);
});
