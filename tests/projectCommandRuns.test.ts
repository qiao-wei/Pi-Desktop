/**
 * 后台命令的「进程台账」（`server/projectCommandRuns.mjs`）。
 *
 * 关键契约：
 * - 存活 = leader 活着 **或** 它的进程组里还有成员 **或** 记下来的后代还有活着的（leader 常常先
 *   退出、子进程被 reparent 到 1 却还在跑）；
 * - 停进程 = 先扫进程树拿到后代（有的子进程 setsid 出去另立会话，杀进程组碰不到），再整组
 *   SIGTERM，宽限期后 SIGKILL 兜底，Windows 走 taskkill。
 *
 * 这里全部用假 kill / 假 spawn / 假进程表验证，绝不能真的去杀进程。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProjectCommandRuns,
  descendantPids,
  isProcessAlive,
  isProcessGroupAlive,
  isRunAlive,
  normalizeRunRecord,
  normalizeRunRecords,
  parseProcessTable,
  runIdFor,
  stopRunProcess,
  stopTargets,
  trackedPids,
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

/** 假的进程表行：`[pid, ppid, pgid]`。 */
function table(rows: [number, number, number][]) {
  return rows.map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
}

/**
 * 假 kill：用一张 `pid -> pgid` 表模拟系统里的进程。
 * - `signal 0` 只查存在性（负 pid 查进程组：组里还有成员才算在）；
 * - 正信号默认让目标消失，`ignoreSigterm` 时 SIGTERM 不生效（模拟赖着不走）；
 * - `noGroup` 模拟平台不支持负 pid（此时应该退回逐个 pid 发）。
 */
function fakeKill({ procs = new Map<number, number>([[1234, 1234]]), ignoreSigterm = false, noGroup = false } = {}) {
  const signals: [number, string | number][] = [];
  const probes: number[] = [];
  const killImpl = (pid: number, signal: string | number) => {
    if (signal === 0) {
      probes.push(pid);
    } else {
      signals.push([pid, signal]);
    }
    const group = pid < 0;
    const id = Math.abs(pid);
    if (group && noGroup) {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
    const exists = group ? [...procs.values()].includes(id) : procs.has(id);
    if (signal === 0) {
      if (!exists) {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }
      return;
    }
    if (signal === "SIGTERM" && ignoreSigterm) {
      return;
    }
    if (group) {
      for (const [member, pgid] of [...procs]) {
        if (pgid === id) {
          procs.delete(member);
        }
      }
      return;
    }
    procs.delete(id);
  };
  return { killImpl, signals, probes, procs };
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
    pids: [],
    startedAt: 1700,
    command: "npm run dev",
    projectId: "",
    commandId: "",
    cwd: "",
    logPath: "",
    sessionPath: "",
  });
});

test("trackedPids 去重、只留正整数", () => {
  assert.deepEqual(trackedPids({ pids: [1, "2", 1, 0, -3, "x", null] }), [1, 2]);
  assert.deepEqual(trackedPids({}), []);
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

/* ------------------------------------------------------------ 进程树与打击计划 */

test("parseProcessTable 解析 ps 输出，坏行直接丢", () => {
  assert.deepEqual(parseProcessTable("  1   0   1\n 42  1  42\nPID PPID PGID\n\nx y z\n"), [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 42, ppid: 1, pgid: 42 },
  ]);
  assert.deepEqual(parseProcessTable(undefined), []);
});

test("descendantPids 沿 ppid 链取全部后代（含隔代），不吃环", () => {
  const rows = table([
    [10, 1, 10],
    [11, 10, 10],
    [12, 11, 12],
    [13, 99, 99],
  ]);
  assert.deepEqual(descendantPids(rows, 10), [11, 12]);
  assert.deepEqual(descendantPids(rows, 11), [12]);
  assert.deepEqual(descendantPids(rows, 13), []);
  assert.deepEqual(descendantPids(table([[10, 11, 10], [11, 10, 10]]), 10), [11]);
});

test("isRunAlive：leader 退了但进程组还在 → 仍算运行中（真实踩过的坑）", () => {
  // 82548 是 leader，已经退出；82584/82648 被 reparent 到 1，但仍在同一个进程组里。
  const { killImpl } = fakeKill({ procs: new Map([[82584, 82548], [82648, 82548]]) });
  assert.equal(isProcessAlive(82548, { killImpl }), false);
  assert.equal(isProcessGroupAlive(82548, { killImpl }), true);
  assert.equal(isRunAlive(record({ pid: 82548 }), { killImpl }), true);

  // leader 和整组都没了 → 才算结束。
  assert.equal(isRunAlive(record({ pid: 82548 }), { killImpl: fakeKill({ procs: new Map() }).killImpl }), false);
});

test("isRunAlive：进程组没了、但 setsid 出去的后代还活着 → 仍算运行中", () => {
  const { killImpl } = fakeKill({ procs: new Map([[9999, 9999]]) });
  assert.equal(isRunAlive(record({ pid: 1234 }), { killImpl }), false);
  assert.equal(isRunAlive(record({ pid: 1234, pids: [9999] }), { killImpl }), true);
});

test("stopTargets：把 setsid 出去的后代各自的进程组也算进来", () => {
  const targets = stopTargets(record({ pids: [9999] }), table([
    [1234, 1, 1234],
    [1235, 1234, 1234],
    [9999, 1235, 9999],
  ]));
  assert.deepEqual(targets.groups, [1234, 9999]);
  assert.deepEqual(targets.pids, [1234, 9999, 1235]);
});

test("stopTargets：进程表扫不到时（pgid 未知）只能靠单 pid", () => {
  const targets = stopTargets(record(), []);
  assert.deepEqual(targets.groups, [1234]);
  assert.deepEqual(targets.pids, [1234]);
  assert.deepEqual(targets.pgidByPid, new Map());
});

/* ------------------------------------------------------------------ 停进程 */

test("stopRunProcess：进程已经不在就不报错", async () => {
  const { killImpl } = fakeKill({ procs: new Map() });
  assert.deepEqual(await stopRunProcess(record(), { killImpl }), { stopped: false, reason: "notRunning" });
});

test("stopRunProcess：SIGTERM 到进程组，进程退出即返回", async () => {
  const { killImpl, signals } = fakeKill();
  const result = await stopRunProcess(record(), { killImpl, graceMs: 0, table: table([[1234, 1, 1234]]) });
  assert.deepEqual(result, { stopped: true, reason: "sigterm" });
  assert.deepEqual(signals, [[-1234, "SIGTERM"]]);
});

test("stopRunProcess：leader 已经退出、只剩进程组时也停得掉（并且不用杀单 pid）", async () => {
  const { killImpl, signals, procs } = fakeKill({ procs: new Map([[82584, 82548], [82648, 82548]]) });
  const run = record({ pid: 82548, command: "npm run start:dev" });
  const result = await stopRunProcess(run, { killImpl, graceMs: 0, table: table([[82584, 1, 82548], [82648, 82584, 82548]]) });
  assert.deepEqual(result, { stopped: true, reason: "sigterm" });
  assert.deepEqual(signals, [[-82548, "SIGTERM"], [82548, "SIGTERM"]]);
  assert.equal(procs.size, 0);
});

test("stopRunProcess：setsid 出去的后代单独发它的进程组（杀 -leader 碰不到它）", async () => {
  const { killImpl, signals, procs } = fakeKill({ procs: new Map([[1234, 1234], [9999, 9999]]) });
  const run = record({ pids: [9999] });
  const result = await stopRunProcess(run, {
    killImpl,
    graceMs: 0,
    table: table([[1234, 1, 1234], [9999, 1234, 9999]]),
  });
  assert.deepEqual(result, { stopped: true, reason: "sigterm" });
  assert.deepEqual(signals, [[-1234, "SIGTERM"], [-9999, "SIGTERM"]]);
  assert.equal(procs.size, 0);
});

test("stopRunProcess：进程组杀不掉时退回逐个 pid", async () => {
  const { killImpl, signals } = fakeKill({ noGroup: true });
  const result = await stopRunProcess(record(), { killImpl, graceMs: 0, table: table([[1234, 1, 1234]]) });
  assert.deepEqual(result, { stopped: true, reason: "sigterm" });
  assert.deepEqual(signals, [[-1234, "SIGTERM"], [1234, "SIGTERM"]]);
});

test("stopRunProcess：SIGTERM 赖着不走就 SIGKILL", async () => {
  const { killImpl, signals } = fakeKill({ ignoreSigterm: true });
  const result = await stopRunProcess(record(), { killImpl, graceMs: 0, table: table([[1234, 1, 1234]]) });
  assert.deepEqual(result, { stopped: true, reason: "sigkill" });
  assert.deepEqual(signals, [[-1234, "SIGTERM"], [-1234, "SIGKILL"]]);
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
  const { killImpl } = fakeKill({ procs: new Map([[1234, 1234], [5678, 5678]]) });
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
  const { killImpl, procs } = fakeKill();
  const runs = createProjectCommandRuns({ runsFile, killImpl });

  runs.register(record());
  assert.equal(JSON.parse(readFileSync(runsFile, "utf8")).runs.length, 1);

  procs.delete(1234);
  assert.deepEqual(runs.list(), []);
  assert.deepEqual(JSON.parse(readFileSync(runsFile, "utf8")).runs, []);

  // 桥重启：新实例从同一份文件读，也只看到存活的记录。
  runs.register(record({ pid: 4321, startedAt: 4322 }));
  const restarted = createProjectCommandRuns({ runsFile, killImpl: fakeKill({ procs: new Map([[4321, 4321]]) }).killImpl });
  assert.equal(restarted.list({ projectId: "p1" }).length, 1);
  assert.equal(restarted.list({ projectId: "p1" })[0].pid, 4321);
});

test("台账：leader 退出但进程组还在时记录必须留下（否则停止入口会消失）", () => {
  const dir = tempDir("pi-runs-");
  const runsFile = join(dir, "command-runs.json");
  const { killImpl } = fakeKill({ procs: new Map([[82548, 82548], [82584, 82548]]) });
  const runs = createProjectCommandRuns({ runsFile, killImpl });
  runs.register(record({ pid: 82548, command: "npm run start:dev" }));

  // leader 82548 退出，子进程 82584 还在同一进程组里。
  const live = fakeKill({ procs: new Map([[82584, 82548]]) }).killImpl;
  const after = createProjectCommandRuns({ runsFile, killImpl: live });
  assert.equal(after.list({ projectId: "p1" }).length, 1);
});

test("台账：list 把扫到的后代记进记录，进程组没了也还认得出逃逸的后代", () => {
  const dir = tempDir("pi-runs-");
  const runsFile = join(dir, "command-runs.json");
  const { killImpl } = fakeKill({ procs: new Map([[1234, 1234], [1235, 1234], [9999, 9999]]) });
  const runs = createProjectCommandRuns({ runsFile, killImpl });
  runs.register(record());

  // 1234 → 1235（同组）→ 9999（setsid 出去，自成一组）
  const rows = table([[1234, 1, 1234], [1235, 1234, 1234], [9999, 1235, 9999]]);
  assert.deepEqual(runs.list({ table: rows })[0].pids, [1235, 9999]);
  assert.deepEqual(JSON.parse(readFileSync(runsFile, "utf8")).runs[0].pids, [1235, 9999]);
});

test("台账：整组没了、只剩逃逸后代活着时，记录仍在（停止按钮不会凭空消失）", () => {
  const dir = tempDir("pi-runs-");
  const runsFile = join(dir, "command-runs.json");
  const { killImpl } = fakeKill({ procs: new Map([[1234, 1234], [9999, 9999]]) });
  const runs = createProjectCommandRuns({ runsFile, killImpl });
  runs.register(record());
  runs.list({ table: table([[1234, 1, 1234], [9999, 1234, 9999]]) });

  // leader 和进程组都没了，9999 还活着（Ada 的 dev server 就是这样活下来的）。
  const escapedOnly = fakeKill({ procs: new Map([[9999, 9999]]) }).killImpl;
  const after = createProjectCommandRuns({ runsFile, killImpl: escapedOnly });
  assert.deepEqual(after.list({ projectId: "p1" }).map((item: { pids: number[] }) => item.pids), [[9999]]);
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
  const runs = createProjectCommandRuns({
    runsFile: join(dir, "command-runs.json"),
    killImpl: fakeKill({ procs: new Map([[1234, 1234], [2222, 2222], [3333, 3333]]) }).killImpl,
    limit: 2,
  });
  runs.register(record({ command: "old" }));
  runs.register(record({ command: "new" }));
  assert.equal(runs.list().length, 1);
  assert.equal(runs.list()[0].command, "new");

  runs.register(record({ pid: 2222, startedAt: 2222 }));
  runs.register(record({ pid: 3333, startedAt: 3333 }));
  assert.equal(runs.list().length, 2);
});

test("台账：scanProcesses 只在有记录时才真去扫", async () => {
  const dir = tempDir("pi-runs-");
  let scans = 0;
  const runs = createProjectCommandRuns({
    runsFile: join(dir, "command-runs.json"),
    killImpl: fakeKill().killImpl,
    scanImpl: async () => {
      scans += 1;
      return [];
    },
  });

  assert.deepEqual(await runs.scanProcesses(), []);
  assert.equal(scans, 0);

  runs.register(record());
  await runs.scanProcesses();
  assert.equal(scans, 1);

  // 扫描本身炸了也不能让接口挂掉。
  const broken = createProjectCommandRuns({
    runsFile: join(dir, "command-runs.json"),
    killImpl: fakeKill().killImpl,
    scanImpl: async () => {
      throw new Error("ps 挂了");
    },
  });
  assert.deepEqual(await broken.scanProcesses(), []);
});

test("台账 stop：杀掉并从列表 / 文件里删掉；未知 id 返回 unknown", async () => {
  const dir = tempDir("pi-runs-");
  const runsFile = join(dir, "command-runs.json");
  const { killImpl } = fakeKill();
  const runs = createProjectCommandRuns({ runsFile, killImpl, scanImpl: async () => [] });
  const entry = runs.register(record());

  assert.deepEqual(await runs.stop("does-not-exist"), { stopped: false, reason: "unknown" });
  assert.deepEqual(await runs.stop(entry.id), { stopped: true, reason: "sigterm" });
  assert.deepEqual(runs.list(), []);
  assert.deepEqual(JSON.parse(readFileSync(runsFile, "utf8")).runs, []);
});

test("台账 stop：用扫描到的进程树一起杀掉 setsid 出去的后代", async () => {
  const dir = tempDir("pi-runs-");
  const { killImpl, procs, signals } = fakeKill({ procs: new Map([[1234, 1234], [9999, 9999]]) });
  const runs = createProjectCommandRuns({
    runsFile: join(dir, "command-runs.json"),
    killImpl,
    scanImpl: async () => table([[1234, 1, 1234], [9999, 1234, 9999]]),
  });
  const entry = runs.register(record());

  assert.deepEqual(await runs.stop(entry.id), { stopped: true, reason: "sigterm" });
  assert.equal(procs.size, 0);
  assert.deepEqual(signals, [[-1234, "SIGTERM"], [-9999, "SIGTERM"]]);
});