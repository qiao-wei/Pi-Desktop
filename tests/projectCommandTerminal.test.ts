/**
 * 「运行命令」运行方式的偏好归一化（`src/shared/projectCommandTerminal.ts`）。
 *
 * 这个值会原样进 `/api/projects/commands/run` 的请求体，所以形态卫生（空白、旧值、注入字符）
 * 必须在这里锁死：非法一律落回后台静默，而不是让桥拿着怪字符串去 `open -a`。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  findCommandRun,
  isProjectCommandBackground,
  normalizeProjectCommandRuns,
  normalizeProjectCommandTerminal,
  PROJECT_COMMAND_BACKGROUND,
  PROJECT_COMMAND_DEFAULT_TERMINAL,
  sameProjectCommandRuns,
} from "../src/shared/projectCommandTerminal.ts";

test("缺省 / 空白 / 非字符串落回后台静默", () => {
  assert.equal(normalizeProjectCommandTerminal(undefined), PROJECT_COMMAND_BACKGROUND);
  assert.equal(normalizeProjectCommandTerminal(null), PROJECT_COMMAND_BACKGROUND);
  assert.equal(normalizeProjectCommandTerminal("   "), PROJECT_COMMAND_BACKGROUND);
  assert.equal(normalizeProjectCommandTerminal(42), PROJECT_COMMAND_BACKGROUND);
});

test("保留两个内置 token", () => {
  assert.equal(normalizeProjectCommandTerminal(PROJECT_COMMAND_BACKGROUND), PROJECT_COMMAND_BACKGROUND);
  assert.equal(normalizeProjectCommandTerminal(PROJECT_COMMAND_DEFAULT_TERMINAL), PROJECT_COMMAND_DEFAULT_TERMINAL);
  assert.equal(normalizeProjectCommandTerminal(" background "), PROJECT_COMMAND_BACKGROUND);
});

test("终端 app 名去掉首尾空格后保留；带特殊字符的落回后台", () => {
  assert.equal(normalizeProjectCommandTerminal("iTerm"), "iTerm");
  assert.equal(normalizeProjectCommandTerminal(" WezTerm "), "WezTerm");
  assert.equal(normalizeProjectCommandTerminal("bad; rm -rf /"), PROJECT_COMMAND_BACKGROUND);
  assert.equal(normalizeProjectCommandTerminal("$(whoami)"), PROJECT_COMMAND_BACKGROUND);
});

test("isProjectCommandBackground 只认后台 token", () => {
  assert.equal(isProjectCommandBackground(PROJECT_COMMAND_BACKGROUND), true);
  assert.equal(isProjectCommandBackground(PROJECT_COMMAND_DEFAULT_TERMINAL), false);
  assert.equal(isProjectCommandBackground("iTerm"), false);
});

test("normalizeProjectCommandRuns 洗掉脏数据、补 id、按时间倒序", () => {
  const runs = normalizeProjectCommandRuns([
    { pid: 11, startedAt: 100, command: " npm run dev ", logPath: "/tmp/a.log", projectId: "p1" },
    { pid: 11, startedAt: 100, command: "npm run dev" }, // 同 id：去掉
    { pid: "nope", startedAt: 100, command: "x" },
    { pid: 22, startedAt: 0, command: "x" },
    { pid: 33, startedAt: 300, command: " " },
    { pid: 44, startedAt: 200, command: "pnpm build" },
    null,
    "x",
  ]);
  assert.deepEqual(
    runs.map((run) => run.id),
    ["44-200", "11-100"],
  );
  assert.equal(runs[1]?.command, "npm run dev");
  assert.equal(runs[1]?.logPath, "/tmp/a.log");
  assert.equal(runs[1]?.projectId, "p1");
  assert.equal(runs[0]?.commandId, "");
});

test("normalizeProjectCommandRuns：旧桥返回非数组 / 缺字段时给空数组", () => {
  assert.deepEqual(normalizeProjectCommandRuns(undefined), []);
  assert.deepEqual(normalizeProjectCommandRuns({ runs: [] }), []);
  assert.deepEqual(normalizeProjectCommandRuns([{ pid: 1 }]), []);
});

test("sameProjectCommandRuns：内容相同（新数组）也算相同，字段有差异就不算", () => {
  const runs = normalizeProjectCommandRuns([
    { pid: 11, startedAt: 100, command: "npm run dev", logPath: "/tmp/a.log" },
    { pid: 22, startedAt: 200, command: "pnpm build", logPath: "" },
  ]);
  const again = normalizeProjectCommandRuns([
    { pid: 22, startedAt: 200, command: "pnpm build", logPath: "" },
    { pid: 11, startedAt: 100, command: "npm run dev", logPath: "/tmp/a.log" },
  ]);
  assert.equal(sameProjectCommandRuns(runs, runs), true);
  assert.equal(sameProjectCommandRuns(runs, again), true);
  assert.equal(sameProjectCommandRuns(runs, [...runs]), true);

  assert.equal(sameProjectCommandRuns(runs, [runs[0] as (typeof runs)[number]]), false);
  assert.equal(sameProjectCommandRuns(runs, [runs[1] as (typeof runs)[number], runs[0] as (typeof runs)[number]]), false);
  // 条数、顺序、id 都一样，只有一个字段（日志路径）变了 → 也必须判为不同
  const changed = normalizeProjectCommandRuns([
    { pid: 22, startedAt: 200, command: "pnpm build", logPath: "" },
    { pid: 11, startedAt: 100, command: "npm run dev", logPath: "/tmp/b.log" },
  ]);
  assert.equal(sameProjectCommandRuns(runs, changed), false);
  assert.equal(sameProjectCommandRuns([], []), true);
});

test("findCommandRun：按 commandId 找最新一条，空 commandId / 没匹配为 null", () => {
  const runs = normalizeProjectCommandRuns([
    { pid: 11, startedAt: 100, command: "npm run dev", commandId: "c-dev" },
    { pid: 22, startedAt: 300, command: "npm run dev", commandId: "c-dev" },
    { pid: 33, startedAt: 200, command: "pnpm build", commandId: "c-build" },
  ]);
  // 同一条命令跑了两次：拿到最新那次（startedAt 大的）
  assert.equal(findCommandRun(runs, "c-dev")?.pid, 22);
  assert.equal(findCommandRun(runs, "c-build")?.pid, 33);
  assert.equal(findCommandRun(runs, "nope"), null);
  assert.equal(findCommandRun(runs, ""), null);
  assert.equal(findCommandRun([], "c-dev"), null);
});