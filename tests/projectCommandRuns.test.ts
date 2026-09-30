/**
 * 后台命令的「进程台账」（`server/projectCommandRuns.mjs`）。
 *
 * 关键契约：台账只认「还活着」的记录（`kill(pid, 0)` 探测），停进程时 POSIX 先 SIGTERM 整个
 * 进程组、宽限期后 SIGKILL，Windows 走 taskkill。这里全部用假 kill / 假 spawn 验证，绝不能
 * 真的去杀进程。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProjectCommandRuns,
  isProcessAlive,
  normalizeRunRecord,
  normalizeRunRecords,
  runIdFor,
  stopRunProcess,
} from "../server/projectCommandRuns.mjs";

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function record(patch: Record<string, unknown> = {}) {
  return {
    pid: 1234,
    startedAt: 1_700_000_000_000,
    command: "npm run dev",
    projectId: "p1",
    commandId: "cmd-1",
    cwd: "/tmp/app",
    logPath: "/tmp/logs/run-1.log",
    sessionPath: "/tmp/session",
    ...patch,
  };
}

/**
 * 假 kill：维护一个「活着的 pid 集合」。
 * `signal 0` 只查存活；正信号默认删掉目标，`ignoreSigterm` 时 SIGTERM 不删（模拟赖着不走）。
 */
function fakeKill({ alive = new Set<number>([1234]), ignoreSigterm = false, noGroup = false } = {}) {
  const signals: [number, string | number][] = [];
  const killImpl = (pid: number, signal: string | number) => {
    signals.push([pid, signal]);
    if (signal === 0) {
      if (!alive.has(pid)) {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }
      return;
    }
    const target = pid < 0 ? -pid : pid;
    if (pid < 0 && noGroup) {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
    if (signal === "SIGTERM" && ignoreSigterm) {
      return;
    }
    alive.delete(target);
  };
  return { killImpl, signals, alive };
}

function fakeSpawn() {
  const calls: { command: string; args: string[] }[] = [];
  const spawnImpl = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    setImmediate(() => child.emit("close", 0));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, spawnImpl };
}

/* ------------------------------------------------------------------ 纯逻辑 */

test("runIdFor 由 pid + 启动时间拼成", () => {
  assert.equal(runIdFor({ pid: 42, startedAt: 1700 }), "42-1700");
});

test("normalizeRunRecord 丢掉缺 pid / 命令 / 启动时间的记录", () => {
  assert.equal(normalizeRunRecord(null), null);
  assert.equal(normalizeRunRecord({}), null);
  assert.equal(normalizeRunRecord(record({ pid: 0 })), null);
  assert.equal(normalizeRunRecord(record({ pid: "abc" })), null);
  assert.equal(normalizeRunRecord(record({ startedAt: 0 })), null);
  assert.equal(normalizeRunRecord(record({ command: "   " })), null);
});

test("normalizeRunRecord 补 id 并把字符串字段归一化", () => {
  const normalized = normalizeRunRecord({ pid: "99", startedAt: "1700", command: " npm run dev " });
  assert.deepEqual(normalized, {
    id: "99-1700",
    pid: 99,
    startedAt: 1700,
    command: "npm run dev",
    projectId: "",
    commandId: "",
    cwd: "",
    logPath: "",
    sessionPath: "",
  });
});

test("normalizeRunRecords 去重、封顶、丢脏数据", () => {
  const records = normalizeRunRecords(
    [record(), record(), { pid: "nope" }, "x", record({ pid: 2000, startedAt: 2000 })],
    2,
  );
  assert.equal(records.length, 2);
  assert.equal(records[0]?.pid, 1234);
  assert.equal(records[1]?.pid, 2000);
});

test("isProcessAlive：ESRCH = 没了，EPERM = 还在，非法 pid = 没了", () => {
  const esrch = () => {
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  };
  const eperm = () => {
    throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  };
  assert.equal(isProcessAlive(1, { killImpl: () => {} }), true);
  assert.equal(isProcessAlive(1, { killImpl: esrch }), false);
  assert.equal(isProcessAlive(1, { killImpl: eperm }), true);
  assert.equal(isProcessAlive(0, { killImpl: () => {} }), false);
  assert.equal(isProcessAlive(-3, { killImpl: () => {} }), false);
});

/* ------------------------------------------------------------------ 停进程 */

test("stopRunProcess：进程已经不在就不报错", async () => {
  const { killImpl } = fakeKill({ alive: new Set() });
  assert.deepEqual(await stopRunProcess(record(), { killImpl }), { stopped: false, reason: "notRunning" });
});

test("stopRunProcess：SIGTERM 到进程组，进程退出即返回", async () => {
  const { killImpl, signals } = fakeKill();
  const result = await stopRunProcess(record(), { killImpl, graceMs: 0 });
  assert.deepEqual(result, { stopped: true, reason: "sigterm" });
  assert.deepEqual(signals, [
    [1234, 0],
    [-1234, "SIGTERM"],
    [1234, 0],
  ]);
});

test("stopRunProcess：进程组杀不掉时退回单个 pid", async () => {
  const { killImpl, signals } = fakeKill({ noGroup: true });
  const result = await stopRunProcess(record(), { killImpl, graceMs: 0 });
  assert.deepEqual(result, { stopped: true, reason: "sigterm" });
  assert.deepEqual(signals, [
    [1234, 0],
    [-1234, "SIGTERM"],
    [1234, "SIGTERM"],
    [1234, 0],
  ]);
});

test("stopRunProcess：SIGTERM 赖着不走就 SIGKILL", async () => {
  const { killImpl, signals } = fakeKill({ ignoreSigterm: true });
  const result = await stopRunProcess(record(), { killImpl, graceMs: 0 });
  assert.deepEqual(result, { stopped: true, reason: "sigkill" });
  assert.deepEqual(signals, [
    [1234, 0],
    [-1234, "SIGTERM"],
    [1234, 0],
    [-1234, "SIGKILL"],
  ]);
});

test("stopRunProcess：Windows 用 taskkill 杀进程树", async () => {
  const { killImpl } = fakeKill();
  const { calls, spawnImpl } = fakeSpawn();
  const result = await stopRunProcess(record(), { killImpl, spawnImpl, platform: "win32" });
  assert.deepEqual(result, { stopped: true, reason: "taskkill" });
  assert.deepEqual(calls, [{ command: "taskkill", args: ["/pid", "1234", "/T", "/F"] }]);
});

/* ------------------------------------------------------------------ 台账 */

test("台账：登记后 list 返回存活记录，并按项目过滤", () => {
  const dir = tempDir("pi-runs-");
  const { killImpl } = fakeKill({ alive: new Set([1234, 5678]) });
  const runs = createProjectCommandRuns({ runsFile: join(dir, "command-runs.json"), killImpl });

  runs.register(record());
  runs.register(record({ pid: 5678, projectId: "p2", command: "pnpm build" }));

  assert.equal(runs.list().length, 2);
  assert.deepEqual(runs.list({ projectId: "p1" }).map((item: { pid: number }) => item.pid), [1234]);
  assert.deepEqual(runs.list({ projectId: "nope" }), []);
});

test("台账：进程退出后 list 自动清掉，并写回文件", () => {
  const dir = tempDir("pi-runs-");
  const runsFile = join(dir, "command-runs.json");
  const { killImpl, alive } = fakeKill();
  const runs = createProjectCommandRuns({ runsFile, killImpl });

  runs.register(record());
  assert.equal(JSON.parse(readFileSync(runsFile, "utf8")).runs.length, 1);

  alive.delete(1234);
  assert.deepEqual(runs.list(), []);
  assert.deepEqual(JSON.parse(readFileSync(runsFile, "utf8")).runs, []);

  // 桥重启：新实例从同一份文件读，也只看到存活的记录。
  runs.register(record({ pid: 4321, startedAt: 4322 }));
  const restarted = createProjectCommandRuns({ runsFile: join(dir, "command-runs.json"), killImpl: fakeKill({ alive: new Set([4321]) }).killImpl });
  assert.equal(restarted.list({ projectId: "p1" }).length, 1);
  assert.equal(restarted.list({ projectId: "p1" })[0].pid, 4321);
});

test("台账：坏 JSON / 脏记录不会让构造炸掉", () => {
  const dir = tempDir("pi-runs-");
  const runsFile = join(dir, "command-runs.json");
  writeFileSync(runsFile, "{ not json");
  const runs = createProjectCommandRuns({ runsFile, killImpl: fakeKill().killImpl });
  assert.deepEqual(runs.list(), []);

  writeFileSync(runsFile, JSON.stringify({ runs: [record(), { pid: "x" }, null] }));
  const second = createProjectCommandRuns({ runsFile, killImpl: fakeKill().killImpl });
  assert.equal(second.list().length, 1);
});

test("台账：同 pid 覆盖登记，且封顶", () => {
  const dir = tempDir("pi-runs-");
  const runs = createProjectCommandRuns({ runsFile: join(dir, "command-runs.json"), killImpl: fakeKill({ alive: new Set([1234, 2222, 3333]) }).killImpl, limit: 2 });
  runs.register(record({ command: "old" }));
  runs.register(record({ command: "new" }));
  assert.equal(runs.list().length, 1);
  assert.equal(runs.list()[0].command, "new");

  runs.register(record({ pid: 2222, startedAt: 2222 }));
  runs.register(record({ pid: 3333, startedAt: 3333 }));
  assert.equal(runs.list().length, 2);
});

test("台账 stop：杀掉并从列表 / 文件里删掉；未知 id 返回 unknown", async () => {
  const dir = tempDir("pi-runs-");
  const runsFile = join(dir, "command-runs.json");
  const { killImpl } = fakeKill();
  const runs = createProjectCommandRuns({ runsFile, killImpl });
  const entry = runs.register(record());

  assert.deepEqual(await runs.stop("does-not-exist"), { stopped: false, reason: "unknown" });
  assert.deepEqual(await runs.stop(entry.id), { stopped: true, reason: "sigterm" });
  assert.deepEqual(runs.list(), []);
  assert.deepEqual(JSON.parse(readFileSync(runsFile, "utf8")).runs, []);
});