/**
 * 后台运行的「进程台账」。
 *
 * 后台命令是 detached spawn 出来的（见 `runProjectCommand.mjs`），桥重启、渲染层刷新都不会
 * 带走它。所以「运行中」不能靠 React state 记着 —— 得有一份落盘的记录（pid / 命令 / 日志），
 * 每次查询时用 `kill(pid, 0)` 探测存活：还活着就继续显示，死了就顺手把记录清掉。
 *
 * 为什么不监听子进程的 `exit`：detached + unref 之后桥自己也可能退出，内存里的 handle 靠不住；
 * 落盘 + 存活探测是唯一能跨桥重启成立的做法。代价是进程结束后记录会多留到下一次轮询。
 *
 * 停进程：POSIX 上 detached 子进程自成进程组（pgid = pid），先 SIGTERM 整个组（`-pid` 能一次
 * 带走 `sh -lc` 拉起的整棵树），宽限期后还在就 SIGKILL；Windows 走 `taskkill /T /F`。
 */
import { spawn } from "node:child_process";
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
  try {
    killImpl(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 尽量杀进程组，不行再退回到单个 pid（进程组可能已被回收 / 平台不支持负 pid）。 */
function signalRun(pid, signal, killImpl) {
  try {
    killImpl(-pid, signal);
    return true;
  } catch {
    // 继续试单个 pid。
  }
  try {
    killImpl(pid, signal);
    return true;
  } catch {
    return false;
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
 * 的报错，只会发现提示消失）。注入 `killImpl` / `spawnImpl` / `graceMs` 供测试用。
 */
export async function stopRunProcess(record, {
  platform = process.platform,
  killImpl = process.kill,
  spawnImpl = spawn,
  graceMs = RUN_STOP_GRACE_MS,
} = {}) {
  const pid = Number(record?.pid);
  if (!isProcessAlive(pid, { killImpl })) {
    return { stopped: false, reason: "notRunning" };
  }

  if (platform === "win32") {
    await spawnOnce(spawnImpl, "taskkill", ["/pid", String(pid), "/T", "/F"]);
    return { stopped: true, reason: "taskkill" };
  }

  signalRun(pid, "SIGTERM", killImpl);
  const deadline = Date.now() + Math.max(0, graceMs);
  let alive = true;
  for (;;) {
    alive = isProcessAlive(pid, { killImpl });
    if (!alive || Date.now() >= deadline) {
      break;
    }
    await sleep(Math.min(RUN_STOP_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  if (alive) {
    signalRun(pid, "SIGKILL", killImpl);
    return { stopped: true, reason: "sigkill" };
  }
  return { stopped: true, reason: "sigterm" };
}

/**
 * 台账实例：桥里只建一个（和 `projects` 一样是进程级状态），落盘到 agentDir 下。
 *
 * `list()` 只返回**还活着**的记录，并顺手把死掉的从文件里删掉（只在真的有变化时写盘，
 * 免得每 3 秒轮询都写一次磁盘）。
 */
export function createProjectCommandRuns({
  runsFile,
  limit = RUN_RECORD_LIMIT,
  killImpl = process.kill,
  spawnImpl = spawn,
  platform = process.platform,
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

  return {
    /** 还活着的 run（可选按项目过滤），最新的在前。 */
    list({ projectId = "" } = {}) {
      const alive = records.filter((record) => isProcessAlive(record.pid, { killImpl }));
      if (alive.length !== records.length) {
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
      const result = await stopRunProcess(record, { platform, killImpl, spawnImpl });
      records = records.filter((candidate) => candidate.id !== id);
      persist();
      return result;
    },
  };
}