/**
 * 后台运行的「进程台账」。
 *
 * 后台命令是 detached spawn 出来的（见 `runProjectCommand.mjs`），桥重启、渲染层刷新都不会
 * 带走它。所以「运行中」不能靠 React state 记着 —— 得有一份落盘的记录（pid / 命令 / 日志），
 * 每次查询时探测存活：还活着就继续显示，死了就顺手把记录清掉。
 *
 * 为什么不监听子进程的 `exit`：detached + unref 之后桥自己也可能退出，内存里的 handle 靠不住；
 * 落盘 + 存活探测是唯一能跨桥重启成立的做法。代价是进程结束后记录会多留到下一次轮询。
 *
 * 探测存活有两层，缺一不可（真实踩过的坑，见下）：
 *   1. `kill(pid, 0)` —— leader 还在。
 *   2. `kill(-pid, 0)` —— leader 退了，但**进程组里还有别的成员**在跑。`npm run start:dev`
 *      这种树（sh → npm → node launch.js → {vite, electron}）里，leader 先退出、子进程被
 *      reparent 到 1，但仍在同一个进程组里。只看 leader 会误判「已结束」，把记录清掉，
 *      界面上停止入口消失，而 vite 还占着端口。
 *
 * 停进程时还有一层：**有子进程会 setsid 出去另立会话**，例如 Ada 的 `desktop/main.cjs`
 * 用 `spawn(..., { detached: true })` 起的 dev server 子进程（pgid = 它自己），`kill(-leader)`
 * 根本碰不到它。所以要在**发信号之前**扫一次系统进程表，把 ppid 链上的后代都记下来 —— 那个
 * 时刻父子关系还在，setsid 出来的孙子也还在树上 —— 然后连同它们各自的进程组一起杀。
 * 这些 pid 也会累积进台账（`pids` 字段），这样即使 leader 和整组都没了，只要还有逃逸出去
 * 的后代活着，这条 run 依然算「运行中」，停止按钮不会凭空消失。
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 台账最多记几条；同时跑这么多后台服务的可能性为零，纯粹是防文件无限长大。 */
export const RUN_RECORD_LIMIT = 20;
/** SIGTERM 之后等多久再 SIGKILL。 */
export const RUN_STOP_GRACE_MS = 3000;
/** 宽限期内探测存活的时间片。 */
const RUN_STOP_POLL_MS = 100;

/** run 的稳定标识：pid + 启动时间，重启桥之后重新读文件仍是同一个 id。 */
export function runIdFor(value) {
  const pid = Number(value?.pid) || 0;
  const startedAt = Number(value?.startedAt) || 0;
  return `${pid}-${startedAt}`;
}

/** 记录里累积的「非 leader 后代」pid：去重、只留正整数、保持出现顺序。 */
export function trackedPids(record) {
  const list = Array.isArray(record?.pids) ? record.pids : [];
  const pids = [];
  for (const item of list) {
    const pid = Number(item);
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) {
      pids.push(pid);
    }
  }
  return pids;
}

/** 一条记录的形态卫生；缺 pid / 命令 / 启动时间的一律丢掉（读旧文件、坏 JSON 兜底）。 */
export function normalizeRunRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const pid = Number(raw.pid);
  const startedAt = Number(raw.startedAt);
  const command = String(raw.command ?? "").trim();
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startedAt) || startedAt <= 0 || !command) {
    return null;
  }
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : runIdFor({ pid, startedAt }),
    pid,
    pids: trackedPids(raw),
    startedAt,
    command,
    projectId: String(raw.projectId ?? ""),
    commandId: String(raw.commandId ?? ""),
    cwd: String(raw.cwd ?? ""),
    logPath: typeof raw.logPath === "string" ? raw.logPath : "",
    sessionPath: typeof raw.sessionPath === "string" ? raw.sessionPath : "",
  };
}

/** 整份台账的归一化：去脏数据、按 id 去重、封顶。 */
export function normalizeRunRecords(value, limit = RUN_RECORD_LIMIT) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const records = [];
  for (const raw of list) {
    const record = normalizeRunRecord(raw);
    if (!record || seen.has(record.id)) {
      continue;
    }
    seen.add(record.id);
    records.push(record);
    if (records.length >= limit) {
      break;
    }
  }
  return records;
}

/**
 * 这个 pid 还活着吗。
 *
 * `signal 0` 不发信号，只做存在性检查：ESRCH = 已经没了；EPERM = 进程在，只是不属于我们
 * （也可能是一个被复用的 pid，概率极低且下次轮询就会清掉，这里不追）。
 */
export function isProcessAlive(pid, { killImpl = process.kill } = {}) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) {
    return false;
  }
  return probeAlive(value, killImpl);
}

/** 这个进程组里还有成员吗（`kill(-pgid, 0)`；组里最后一个成员退出时组就不存在了）。 */
export function isProcessGroupAlive(pgid, { killImpl = process.kill } = {}) {
  const value = Number(pgid);
  if (!Number.isInteger(value) || value <= 0) {
    return false;
  }
  return probeAlive(-value, killImpl);
}

function probeAlive(target, killImpl) {
  try {
    killImpl(target, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * 这条 run 还在跑吗：leader 活着、或者它的进程组里还有成员、或者记下来的后代里还有活着的。
 *
 * 只看 leader 是不够的（leader 经常先走），只看到进程组也不太够（setsid 出去的后代不在组里），
 * 三者取或才是「这棵进程树还在」。
 */
export function isRunAlive(record, { killImpl = process.kill } = {}) {
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (probeAlive(pid, killImpl) || probeAlive(-pid, killImpl)) {
    return true;
  }
  return trackedPids(record).some((candidate) => probeAlive(candidate, killImpl));
}

/* --------------------------------------------------------------- 进程树扫描 */

/**
 * `ps -ax -o pid=,ppid=,pgid=` 的输出 → `[{pid, ppid, pgid}]`。
 * 解析失败的行直接丢（ps 的列格式各平台略有差异，不能因此炸掉）。
 */
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
  }
  return rows;
}

/** 进程表里 rootPid 的全部后代（沿 ppid 链 BFS，不含 root 自己）。 */
export function descendantPids(table, rootPid) {
  const root = Number(rootPid);
  const childrenByParent = new Map();
  for (const row of Array.isArray(table) ? table : []) {
    const parent = Number(row?.ppid);
    const pid = Number(row?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parent)) {
      continue;
    }
    const children = childrenByParent.get(parent);
    if (children) {
      children.push(pid);
    } else {
      childrenByParent.set(parent, [pid]);
    }
  }
  const found = [];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of childrenByParent.get(queue.shift()) ?? []) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** 异步扫一次系统进程表（10ms 量级的子进程，别用同步版卡住桥的事件循环）。 */
export function scanProcessTable({ execFileImpl = execFile } = {}) {
  return new Promise((resolvePromise) => {
    try {
      execFileImpl("ps", ["-ax", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 3000 }, (error, stdout) => {
        resolvePromise(error ? [] : parseProcessTable(stdout));
      });
    } catch {
      // 平台没有 ps（Windows）/ 参数不对：当成「扫不到」，退回到只看 leader + 进程组。
      resolvePromise([]);
    }
  });
}

/**
 * 停这棵树的「打击计划」：要发的进程组、要兜底的 pid、以及判断「死透了没」要看哪些 pid。
 *
 * - `groups`：leader 自己的组 + 后代里那些 setsid 出去另立的组（pgid ≠ leader pid）。
 * - `pids`：所有关心的 pid（宽限期里用来判断是否还需要 SIGKILL；组信号发不出去时逐个兜底）。
 * - `pgidByPid`：pid → pgid，决定哪些 pid 已经被进程组信号覆盖了。
 */
export function stopTargets(record, table) {
  const rootPid = Number(record?.pid);
  const rows = Array.isArray(table) ? table : [];
  const pgidByPid = new Map();
  for (const row of rows) {
    const pid = Number(row?.pid);
    const pgid = Number(row?.pgid);
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(pgid) && pgid > 0) {
      pgidByPid.set(pid, pgid);
    }
  }
  const pids = [];
  for (const pid of [rootPid, ...trackedPids(record), ...descendantPids(rows, rootPid)]) {
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) {
      pids.push(pid);
    }
  }
  const groups = [];
  if (Number.isInteger(rootPid) && rootPid > 0) {
    groups.push(rootPid);
  }
  for (const pid of pids) {
    const pgid = pgidByPid.get(pid);
    if (pgid && !groups.includes(pgid)) {
      groups.push(pgid);
    }
  }
  return { groups, pids, pgidByPid };
}

/* -------------------------------------------------------------------- 停进程 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 目标里还有活着的吗（进程组 + 单个 pid 都要看）。 */
function anyTargetAlive(targets, killImpl) {
  return (
    targets.pids.some((pid) => isProcessAlive(pid, { killImpl })) ||
    targets.groups.some((group) => isProcessGroupAlive(group, { killImpl }))
  );
}

/**
 * 给整组 + 漏网的单个 pid 发信号。
 *
 * 进程组是首选（一次带走整棵树，包括 `sh -lc` 拉起的 chain）；组信号**发得出去**时就不必再
 * 逐个 pid 发了。发不出去的（平台不支持负 pid / 组刚好被回收）才退回单 pid —— 否则那些进程
 * 会一个都杀不掉。目标已经没了就跳过（ESRCH 不是错误）。
 */
function signalTargets(targets, signal, killImpl) {
  const failedGroups = new Set();
  for (const group of targets.groups) {
    try {
      killImpl(-group, signal);
    } catch {
      failedGroups.add(group);
    }
  }
  for (const pid of targets.pids) {
    const pgid = targets.pgidByPid.get(pid);
    if (pgid && targets.groups.includes(pgid) && !failedGroups.has(pgid)) {
      continue;
    }
    try {
      killImpl(pid, signal);
    } catch {
      // 已经没了。
    }
  }
}

function spawnOnce(spawnImpl, command, args) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { stdio: "ignore" });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("close", () => resolvePromise(undefined));
  });
}

/**
 * 停掉一条后台 run。
 *
 * 返回 `{ stopped, reason }`：`stopped:false` 表示探测时它已经不在（用户看不到「停止」被点掉
 * 的报错，只会发现提示消失）。注入 `killImpl` / `spawnImpl` / `table` / `graceMs` 供测试用。
 *
 * `table` 是调用方扫好的进程表（见 `scanProcessTable`）。必须在**发第一个信号之前**拿到它：
 * 一旦开始杀，父子关系就断了，setsid 出去的后代再也找不回来。
 */
export async function stopRunProcess(record, {
  platform = process.platform,
  killImpl = process.kill,
  spawnImpl = spawn,
  table = [],
  graceMs = RUN_STOP_GRACE_MS,
} = {}) {
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !isRunAlive(record, { killImpl })) {
    return { stopped: false, reason: "notRunning" };
  }

  if (platform === "win32") {
    // Windows 没有进程组信号；taskkill /T 沿父子关系杀整棵树（含 detached 的子进程）。
    await spawnOnce(spawnImpl, "taskkill", ["/pid", String(pid), "/T", "/F"]);
    return { stopped: true, reason: "taskkill" };
  }

  const targets = stopTargets(record, table);
  signalTargets(targets, "SIGTERM", killImpl);

  const deadline = Date.now() + Math.max(0, graceMs);
  while (anyTargetAlive(targets, killImpl) && Date.now() < deadline) {
    await sleep(Math.min(RUN_STOP_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  if (anyTargetAlive(targets, killImpl)) {
    signalTargets(targets, "SIGKILL", killImpl);
    return { stopped: true, reason: "sigkill" };
  }
  return { stopped: true, reason: "sigterm" };
}

/* --------------------------------------------------------------------- 台账 */

/**
 * 台账实例：桥里只建一个（和 `projects` 一样是进程级状态），落盘到 agentDir 下。
 *
 * `list()` 只返回**还活着**的记录，并顺手把死掉的从文件里删掉（只在真的有变化时写盘，
 * 免得每 3 秒轮询都写一次磁盘）。传入 `table` 时会顺便把进程树里发现的后代并进记录。
 */
export function createProjectCommandRuns({
  runsFile,
  limit = RUN_RECORD_LIMIT,
  killImpl = process.kill,
  spawnImpl = spawn,
  platform = process.platform,
  scanImpl = scanProcessTable,
  exists = existsSync,
  readFile = readFileSync,
  writeFile = writeFileSync,
  rename = renameSync,
} = {}) {
  let records = readRecords();

  function readRecords() {
    if (!runsFile || !exists(runsFile)) {
      return [];
    }
    try {
      return normalizeRunRecords(JSON.parse(String(readFile(runsFile, "utf8")))?.runs, limit);
    } catch {
      return [];
    }
  }

  function persist() {
    if (!runsFile) {
      return;
    }
    try {
      mkdirSync(dirname(runsFile), { recursive: true });
      const temp = `${runsFile}.tmp`;
      writeFile(temp, `${JSON.stringify({ runs: records }, null, 2)}\n`);
      rename(temp, runsFile);
    } catch {
      // 写不进去（权限 / 磁盘）不影响这次运行，下次查询重新探测即可。
      try {
        rmSync(`${runsFile}.tmp`, { force: true });
      } catch {
        // 清不掉临时文件也无所谓。
      }
    }
  }

  /** 本轮该记的后代：已有的 + 新扫到的，都探活一遍（死了的顺手丢掉，免得文件无限长大）。 */
  function mergeTrackedPids(record, table) {
    const pids = [];
    for (const pid of [...trackedPids(record), ...descendantPids(table, record.pid)]) {
      if (!pids.includes(pid) && isProcessAlive(pid, { killImpl })) {
        pids.push(pid);
      }
    }
    return pids;
  }

  async function scanProcesses() {
    if (records.length === 0) {
      return [];
    }
    try {
      return await scanImpl();
    } catch {
      return [];
    }
  }

  return {
    /** 扫一次系统进程表（没有记录时直接返回空，省掉一个子进程）。 */
    scanProcesses,

    /** 还活着的 run（可选按项目过滤），最新的在前。 */
    list({ projectId = "", table = null } = {}) {
      const rows = Array.isArray(table) ? table : [];
      const alive = [];
      let changed = false;
      for (const record of records) {
        const pids = mergeTrackedPids(record, rows);
        const current = trackedPids(record);
        const samePids = pids.length === current.length && pids.every((pid, index) => pid === current[index]);
        const candidate = samePids ? record : { ...record, pids };
        if (!samePids) {
          changed = true;
        }
        if (isRunAlive(candidate, { killImpl })) {
          alive.push(candidate);
        } else {
          changed = true;
        }
      }
      if (changed) {
        records = alive;
        persist();
      }
      return alive.filter((record) => !projectId || record.projectId === projectId).map((record) => ({ ...record }));
    },

    /** 记一条刚启动的后台 run；同 pid 覆盖（极少见，防重复登记）。 */
    register(raw) {
      const record = normalizeRunRecord(raw);
      if (!record) {
        return null;
      }
      records = [record, ...records.filter((candidate) => candidate.pid !== record.pid)].slice(0, limit);
      persist();
      return { ...record };
    },

    /** 停掉一条：先停进程，再从台账里删掉（不管停没停成功都删，避免死记录反复出现）。 */
    async stop(runId) {
      const id = String(runId ?? "");
      const record = records.find((candidate) => candidate.id === id);
      if (!record) {
        return { stopped: false, reason: "unknown" };
      }
      const result = await stopRunProcess(record, {
        platform,
        killImpl,
        spawnImpl,
        table: platform === "win32" ? [] : await scanProcesses(),
      });
      records = records.filter((candidate) => candidate.id !== id);
      persist();
      return result;
    },
  };
}