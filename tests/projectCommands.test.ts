/**
 * 项目命令列表：纯逻辑（归一化 / 合并 / 删除 / 选中回退）+ 接线（server 端点、会话头部
 * 把控件放在 git 徽标左边）。App.tsx 是 .tsx，`node --test` 不能 import，所以头部接线按
 * 仓库惯例从源码断言，并限定在 `<header className="conversation-header">` 块里。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PROJECT_COMMAND_LIMIT,
  PROJECT_COMMAND_MAX_ARGS_LENGTH,
  appendProjectCommand,
  commandEnvRecord,
  commandLine,
  filterProjectCommands,
  formatEnvText,
  isCommandSaved,
  mergeDetectedCommands,
  normalizeCommandArgs,
  normalizeCommandCwd,
  normalizeCommandEnv,
  normalizeProjectCommands,
  normalizeSelectedCommandId,
  parseEnvText,
  projectCommandId,
  projectCommandSignature,
  removeProjectCommand,
  runCommandDisabledReason,
  selectedProjectCommand,
  updateProjectCommand,
  type ProjectCommand,
} from "../src/shared/projectCommands.ts";
import { functionBody } from "./lib/sourceText.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const hookSource = readFileSync(new URL("../src/features/chat/useProjectCommands.ts", import.meta.url), "utf8");
const controlsSource = readFileSync(new URL("../src/components/ProjectCommandControls.tsx", import.meta.url), "utf8");
const dialogSource = readFileSync(new URL("../src/components/ProjectCommandDialog.tsx", import.meta.url), "utf8");

function conversationHeaderSource(): string {
  const start = appSource.indexOf('<header className="conversation-header');
  assert.notEqual(start, -1, "the conversation header is gone from App.tsx");
  const end = appSource.indexOf("</header>", start);
  assert.notEqual(end, -1, "the conversation header body could not be delimited");
  return appSource.slice(start, end);
}

function command(patch: Partial<ProjectCommand> = {}): ProjectCommand {
  const source = patch.source ?? "manual";
  const text = patch.command ?? "npm run dev";
  const cwd = patch.cwd ?? "";
  const args = patch.args ?? "";
  const env = patch.env ?? [];
  return {
    id: patch.id ?? projectCommandId(source, text, cwd),
    label: patch.label ?? text,
    command: text,
    args,
    env,
    cwd,
    source,
  };
}

/* ------------------------------------------------------------------ 纯逻辑 */

test("normalizeProjectCommands 丢脏数据、按 工作目录+命令 去重、封顶", () => {
  const normalized = normalizeProjectCommands([
    { label: "dev", command: "npm run dev", cwd: "", source: "package.json" },
    { command: "npm run dev", source: "Procfile" }, // 同 cwd + 同 command：去掉
    { command: "npm run dev", cwd: "apps/web", source: "workspace" }, // 不同 cwd：保留
    { command: "   " },
    { command: "x".repeat(600) },
    null,
    "not an object",
  ]);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0]?.source, "package.json");
  assert.equal(normalized[1]?.cwd, "apps/web");
  assert.ok(normalized.every((entry) => entry.id.startsWith("pc-")));

  const many = normalizeProjectCommands(
    Array.from({ length: PROJECT_COMMAND_LIMIT + 5 }, (_, index) => ({ command: `run-${index}` })),
  );
  assert.equal(many.length, PROJECT_COMMAND_LIMIT);
});

test("normalizeCommandCwd 只接受项目内的相对目录", () => {
  assert.equal(normalizeCommandCwd("apps/web"), "apps/web");
  assert.equal(normalizeCommandCwd("./apps/web/"), "apps/web");
  assert.equal(normalizeCommandCwd("..\\evil"), "");
  assert.equal(normalizeCommandCwd("/etc"), "");
  assert.equal(normalizeCommandCwd("C:\\Windows"), "");
  assert.equal(normalizeCommandCwd("."), "");
  assert.equal(normalizeCommandCwd(undefined), "");
});

test("projectCommandId 对 来源+目录+命令 稳定，任一项不同就不同", () => {
  assert.equal(projectCommandId("package.json", "npm run dev"), projectCommandId("package.json", "npm run dev"));
  assert.notEqual(projectCommandId("package.json", "npm run dev"), projectCommandId("package.json", "npm run dev", "apps/web"));
  assert.notEqual(projectCommandId("package.json", "npm run dev"), projectCommandId("Procfile", "npm run dev"));
});

test("选中项必须真的在列表里，否则退回第一条", () => {
  const list = [command({ command: "a" }), command({ command: "b" })];
  assert.equal(normalizeSelectedCommandId(list[1].id, list), list[1].id);
  assert.equal(normalizeSelectedCommandId("missing", list), list[0].id);
  assert.equal(normalizeSelectedCommandId("", list), list[0].id);
  assert.equal(normalizeSelectedCommandId("anything", []), "");
  assert.equal(selectedProjectCommand(list, list[0].id)?.command, "a");
  assert.equal(selectedProjectCommand(list, "missing"), null);
});

test("mergeDetectedCommands 只并新命令，空列表时自动选中第一条新加的", () => {
  const existing = [command({ command: "npm run dev", source: "package.json" })];
  const duplicate = command({ command: "npm run dev", source: "Procfile" }); // 同命令同目录
  const fresh = command({ command: "make dev", source: "Makefile" });

  const merged = mergeDetectedCommands(existing, existing[0].id, [duplicate, fresh]);
  assert.deepEqual(merged.commands.map((entry) => entry.command), ["npm run dev", "make dev"]);
  assert.equal(merged.selectedCommandId, existing[0].id, "列表非空时不该改选中项");

  const empty = mergeDetectedCommands([], "", [fresh]);
  assert.equal(empty.selectedCommandId, fresh.id);
});

test("removeProjectCommand 删掉选中项时选中回退到新列表第一条", () => {
  const first = command({ command: "a" });
  const second = command({ command: "b" });
  const removed = removeProjectCommand([first, second], second.id, second.id);
  assert.deepEqual(removed.commands.map((entry) => entry.command), ["a"]);
  assert.equal(removed.selectedCommandId, first.id);

  const kept = removeProjectCommand([first, second], first.id, second.id);
  assert.equal(kept.selectedCommandId, first.id);
});

test("runCommandDisabledReason：没选中 or 正在运行就不能点", () => {
  const selected = command();
  assert.equal(runCommandDisabledReason(selected, false), null);
  assert.equal(runCommandDisabledReason(null, false), "none");
  assert.equal(runCommandDisabledReason(selected, true), "running");
  assert.equal(runCommandDisabledReason(null, true), "none");
});

/* ------------------------------------------------------------------ 参数 / 环境变量 */

test("commandLine：参数非空才拼在后面", () => {
  assert.equal(commandLine("npm run dev", ""), "npm run dev");
  assert.equal(commandLine("npm run dev", "   "), "npm run dev");
  assert.equal(commandLine("npm run dev", "  -- --port 3000 "), "npm run dev -- --port 3000");
  assert.equal(commandLine("", "--x"), "--x");
});

test("normalizeCommandArgs / normalizeCommandEnv 的形态卫生", () => {
  assert.equal(normalizeCommandArgs("  --a "), "--a");
  assert.equal(normalizeCommandArgs(undefined), "");
  assert.equal(normalizeCommandArgs("x".repeat(600)).length, PROJECT_COMMAND_MAX_ARGS_LENGTH);

  assert.deepEqual(
    normalizeCommandEnv([
      { key: "PORT", value: "3000" },
      { key: "PORT", value: "4000" }, // 重复键：保留先出现的
      { key: "1bad", value: "x" },
      { key: "HAS DASH", value: "x" },
      { key: "OK_2", value: "v" },
      null,
      "nope",
    ]),
    [
      { key: "PORT", value: "3000" },
      { key: "OK_2", value: "v" },
    ],
  );
  assert.deepEqual(normalizeCommandEnv("not an array"), []);
});

test("commandEnvRecord 不会让 __proto__ 污染原型", () => {
  const record = commandEnvRecord([
    { key: "A", value: "1" },
    { key: "__proto__", value: "evil" },
  ]);
  assert.equal(record.A, "1");
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(record, "__proto__"), true);
});

test("parseEnvText 解析多行；formatEnvText 是它的逆", () => {
  assert.deepEqual(
    parseEnvText("# 注释\nPORT=3000\n\nNODE_ENV=development\nBAD_LINE\n=empty_key\n  "),
    [
      { key: "PORT", value: "3000" },
      { key: "NODE_ENV", value: "development" },
    ],
  );
  // 值里可以有 =（从第一个 = 切开）；重复键后者覆盖前者
  assert.deepEqual(parseEnvText("URL=https://x?a=1"), [{ key: "URL", value: "https://x?a=1" }]);
  assert.deepEqual(parseEnvText("A=1\nA=2"), [{ key: "A", value: "2" }]);
  assert.deepEqual(parseEnvText(undefined as unknown as string), []);

  const env = [{ key: "A", value: "1" }, { key: "B", value: "2" }];
  assert.equal(formatEnvText(env), "A=1\nB=2");
  assert.deepEqual(parseEnvText(formatEnvText(env)), env);
  assert.equal(formatEnvText([]), "");
});

test("projectCommandSignature：没参数时为空（老 id 不变），有参数才非空", () => {
  assert.equal(projectCommandSignature("", []), "");
  assert.notEqual(projectCommandSignature("--x", []), "");
  assert.notEqual(projectCommandSignature("", [{ key: "A", value: "1" }]), "");

  // 向后兼容：没有参数的命令 id 与旧版完全一致（projects.json 里的选中项不会失效）
  assert.equal(projectCommandId("package.json", "npm run dev", ""), "pc-oauwhklvqbmu");
  assert.equal(projectCommandId("manual", "make serve", "apps/api"), "pc-5lx9s31aq8gx9");
  assert.notEqual(
    projectCommandId("package.json", "npm run dev", "", projectCommandSignature("--x", [])),
    "pc-oauwhklvqbmu",
  );
});

test("normalizeProjectCommands 保留参数 / 环境变量，并按参数区分去重", () => {
  const normalized = normalizeProjectCommands([
    { command: "npm run dev", args: "-- --port 3000", env: [{ key: "A", value: "1" }], source: "package.json" },
    { command: "npm run dev", args: "-- --port 3000", env: [{ key: "A", value: "1" }] }, // 完全一样：去掉
    { command: "npm run dev", args: "-- --port 4000" }, // 参数不同：保留
    { command: "npm run dev" }, // 没参数：也保留
  ]);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0]?.args, "-- --port 3000");
  assert.deepEqual(normalized[0]?.env, [{ key: "A", value: "1" }]);
  assert.equal(normalized[1]?.args, "-- --port 4000");
  assert.equal(normalized[2]?.args, "");
  assert.deepEqual(normalized[2]?.env, []);
  // 三条同命令但参数不同，id 必须互不相同
  assert.equal(new Set(normalized.map((entry) => entry.id)).size, 3);
  // 老数据（无 args / env）读进来补默认值
  const legacy = normalizeProjectCommands([{ command: "npm run dev", cwd: "", source: "package.json" }]);
  assert.deepEqual(legacy[0]?.env, []);
  assert.equal(legacy[0]?.args, "");
});

test("updateProjectCommand：改参数会换 id 并把选中指过去；空命令拒绝", () => {
  const first = command({ command: "npm run dev" });
  const second = command({ command: "npm run build" });
  const state = { commands: [first, second], selectedCommandId: first.id };

  const updated = updateProjectCommand(state.commands, state.selectedCommandId, first.id, {
    args: "-- --port 3000",
    env: [{ key: "NODE_ENV", value: "development" }],
  });
  assert.equal(updated.commands.length, 2);
  const next = updated.commands[0]!;
  assert.notEqual(next.id, first.id, "参数变了 id 应该变");
  assert.equal(next.args, "-- --port 3000");
  assert.deepEqual(next.env, [{ key: "NODE_ENV", value: "development" }]);
  assert.equal(updated.selectedCommandId, next.id, "选中项要跟到新 id");
  assert.equal(updated.commands[1]?.id, second.id, "别的条目不受影响");

  // 改成空命令：整个操作被忽略
  const rejected = updateProjectCommand(state.commands, state.selectedCommandId, first.id, { command: "   " });
  assert.deepEqual(rejected.commands.map((entry) => entry.id), [first.id, second.id]);
  assert.equal(rejected.selectedCommandId, first.id);

  // 改不存在的 id：原样返回
  const missing = updateProjectCommand(state.commands, state.selectedCommandId, "nope", { args: "x" });
  assert.equal(missing.selectedCommandId, first.id);
});

test("appendProjectCommand：新增并选中；重复的命令直接选中已有项；非法命令拒绝", () => {
  const existing = command({ command: "npm run dev" });
  const added = appendProjectCommand([existing], existing.id, { command: "npm run worker", args: "--queue mail" });
  assert.equal(added.commands.length, 2);
  assert.equal(added.commands[1]?.source, "manual");
  assert.equal(added.selectedCommandId, added.commands[1]?.id);

  // 与已有项完全一样：不重复添加，直接把选中指过去
  const duplicate = appendProjectCommand([existing], "", { command: "npm run dev" });
  assert.equal(duplicate.commands.length, 1);
  assert.equal(duplicate.selectedCommandId, existing.id);

  // 同命令、不同参数：算两条
  const variant = appendProjectCommand([existing], existing.id, { command: "npm run dev", args: "-- --port 4000" });
  assert.equal(variant.commands.length, 2);
  assert.equal(variant.commands[1]?.args, "-- --port 4000");

  const rejected = appendProjectCommand([existing], existing.id, { command: "  " });
  assert.equal(rejected.commands.length, 1);
  assert.equal(rejected.selectedCommandId, existing.id);
});

/* ------------------------------------------------------------------ server 接线 */

test("projects.json 里的命令列表在 loadProjects 里归一化", () => {
  const body = functionBody(serverSource, "loadProjects");
  assert.match(body, /normalizeProjectCommands\(project\?\.commands\)/);
  assert.match(body, /normalizeSelectedCommandId\(project\?\.selectedCommandId, commands\)/);
});

test("四个命令端点在 server 上都有实现，运行只跑项目列表里的命令", () => {
  for (const route of [
    'url.pathname === "/api/projects/commands"',
    'url.pathname === "/api/projects/commands/select"',
    'url.pathname === "/api/projects/commands/detect"',
    'url.pathname === "/api/projects/commands/run"',
  ]) {
    assert.ok(serverSource.includes(route), `server 少了端点 ${route}`);
  }

  const runBody = serverSource.slice(
    serverSource.indexOf('url.pathname === "/api/projects/commands/run"'),
    serverSource.indexOf('url.pathname === "/api/projects/git/commit-message"'),
  );
  assert.match(runBody, /selectedProjectCommand\(project\.commands \?\? \[\], String\(body\?\.commandId/);
  assert.match(runBody, /resolveCommandCwd\(requestWorkspaceCwd\(project, body\), command\.cwd\)/);
  // 运行方式（后台静默 / 指定终端）从请求体进入 `runProjectCommand`；断言不再锁死旧的两参调用。
  assert.match(runBody, /runProjectCommand\(command\.command, cwd, \{/);
  assert.match(runBody, /background/);
  assert.match(runBody, /terminalApp/);
});

test("命令的工作目录不许跑出项目范围", () => {
  const body = functionBody(serverSource, "resolveCommandCwd");
  assert.match(body, /isPathInside\(baseCwd, resolved\)/);
});

/* ------------------------------------------------------------------ 会话头部接线 */

test("命令控件渲染在 git 徽标左边，且整条链路都接上了", () => {
  const header = conversationHeaderSource();
  const controlsAt = header.indexOf("<ProjectCommandControls");
  const gitAt = header.indexOf("<GitStatusBadge");
  assert.notEqual(controlsAt, -1, "会话头部没有 ProjectCommandControls");
  assert.notEqual(gitAt, -1, "会话头部没有 GitStatusBadge");
  assert.ok(controlsAt < gitAt, "命令控件必须在 git 徽标的左边");

  for (const prop of [
    "commands={projectCommands.commands}",
    "selectedCommandId={projectCommands.selectedCommandId}",
    "candidates={projectCommands.candidates}",
    "error={projectCommands.error}",
    "loadError={projectCommands.loadError}",
    "runs={projectCommands.runs}",
    "isStoppingRun={projectCommands.isStoppingRun}",
    "onStopRun={(runId) => void projectCommands.stopRun(runId)}",
    "onRun={() => void projectCommands.run()}",
    "onSelect={(id) => void projectCommands.selectCommand(id)}",
    "onRemove={(id) => void projectCommands.removeCommand(id)}",
    "onUpdate={(id, patch) => void projectCommands.updateCommand(id, patch)}",
    "onAddManual={(draft) => void projectCommands.addManualCommand(draft)}",
    "onDetect={() => void projectCommands.detect()}",
    "onAdd={(candidate) => void projectCommands.addCommand(candidate)}",
  ]) {
    assert.ok(header.includes(prop), `会话头部少了 ${prop}`);
  }
});

test("App 用当前项目 + 会话工作区实例化 useProjectCommands", () => {
  assert.match(
    appSource,
    /useProjectCommands\(\{\s*projectId: bootstrap\.activeProjectId,\s*sessionPath: visibleSessionPath,/,
  );
});

/* ------------------------------------------------------------------ 健康状态 */

test("列表上限足够大，不会把真实项目的命令截掉", () => {
  assert.ok(PROJECT_COMMAND_LIMIT >= 100, `候选上限太小会截掉真实项目（NextClaw 一次就 76 条）: ${PROJECT_COMMAND_LIMIT}`);
});

test("filterProjectCommands：按 名字/命令/子目录/来源 做 AND 搜索", () => {
  const commands: ProjectCommand[] = [
    { id: "a", label: "frontend · npm run dev", command: "npm run dev", cwd: "frontend", source: "package" },
    { id: "b", label: "npm run start:dev", command: "npm run start:dev", cwd: "", source: "package.json" },
    { id: "c", label: "packages/plugin-sdk · npm run build", command: "npm run build", cwd: "packages/plugin-sdk", source: "package" },
  ];

  assert.equal(filterProjectCommands(commands, "").length, 3, "空搜索不动列表");
  assert.deepEqual(filterProjectCommands(commands, "start").map((c) => c.id), ["b"]);
  assert.deepEqual(filterProjectCommands(commands, "frontend").map((c) => c.id), ["a"], "子目录/名字能搜到");
  assert.deepEqual(filterProjectCommands(commands, "plugin build").map((c) => c.id), ["c"], "多个 token 是 AND");
  assert.deepEqual(filterProjectCommands(commands, "DEV").map((c) => c.id), ["a", "b"], "大小写不敏感");
  assert.deepEqual(filterProjectCommands(commands, "/start").map((c) => c.id), ["b"], "前导 / 不算搜索词");
  assert.deepEqual(filterProjectCommands(commands, "webpack"), []);
});

test("isCommandSaved：按 id 或「目录+命令」判已加过", () => {
  const commands: ProjectCommand[] = [
    { id: "a", label: "npm run dev", command: "npm run dev", cwd: "", source: "package.json" },
    { id: "b", label: "web · npm run dev", command: "npm run dev", cwd: "web", source: "workspace" },
  ];

  assert.equal(isCommandSaved(commands, { ...commands[0]! }), true, "同 id");
  // 同一条命令但不同目录是两条，不能误判
  assert.equal(isCommandSaved(commands, { ...commands[0]!, id: "other", cwd: "apps/api" }), false);
  assert.equal(isCommandSaved(commands, { id: "new", label: "x", command: "npm run build", cwd: "", source: "package.json" }), false);
  assert.equal(isCommandSaved([], commands[0]!), false);
});

test("下拉里可以连着加多条：加完不关面板，加过的候选变成勾", () => {
  // add() 里不能有关面板的 setOpen(false) —— 探测一次几十条，用户往往要连着加好几条
  const addBody = controlsSource.slice(controlsSource.indexOf("const add = (candidate"), controlsSource.indexOf("return (", controlsSource.indexOf("const add = (candidate")));
  assert.match(addBody, /onAdd\(candidate\)/);
  assert.ok(!/setOpen\(false\)/.test(addBody), "点「+」不该把面板关掉");

  // 已加过的候选渲染成勾（不可再点），没用到的还是「+」按钮
  assert.match(controlsSource, /const saved = isCommandSaved\(commands, candidate\)/);
  assert.match(controlsSource, /t\("projectCommand\.added"\)/);
  assert.match(controlsSource, /t\("projectCommand\.add"\)/);

  // 候选不再从探测结果里删掉（删掉就看不到勾了），只靠 isCommandSaved 标记
  const addCommandBody = hookSource.slice(hookSource.indexOf("const addCommand = useCallback"));
  assert.ok(!/setCandidates\(\(current\)/.test(addCommandBody), "加过的不该从探测结果里移除");
  assert.match(addCommandBody, /selectedCommandId: candidate\.id/, "加进来的这条要变成选中项");
});

test("命令很多时下拉里带搜索框，搜完两个列表都过滤", () => {
  assert.match(controlsSource, /filterProjectCommands\(commands, query\)/);
  assert.match(controlsSource, /filterProjectCommands\(candidates, query\)/);
  assert.match(controlsSource, /const showSearch = commands\.length \+ \(candidates\?\.length \?\? 0\) > 8/);
  assert.match(controlsSource, /placeholder=\{t\("projectCommand\.search"\)\}/);
  assert.match(controlsSource, /visibleCommands\.map\(/);
  assert.match(controlsSource, /visibleCandidates\.map\(/);
});

test("只读加载失败只进 loadError，不把「运行」按钮染红", () => {
  // 运行按钮的 destructive 只认用户主动操作的 error
  assert.match(controlsSource, /error && "text-destructive[^"]*"/);
  assert.ok(!/loadError && "text-destructive/.test(controlsSource), "loadError 不该影响运行按钮的颜色");
  // 面板里两者都显示，但加载失败用弱化的 muted 颜色
  assert.match(controlsSource, /\{error \? <p className="shrink-0 border-t px-3 py-2 text-destructive">\{error\}/);
  assert.match(controlsSource, /loadError \? <p className="shrink-0 border-t px-3 py-2 text-muted-foreground">\{loadError\}/);
});

test("加载失败会重试（窗口重新聚焦），且不报给会话错误横幅", () => {
  const refreshBody = hookSource.slice(hookSource.indexOf("const refresh = useCallback"), hookSource.indexOf("const persist = useCallback"));
  assert.match(refreshBody, /setLoadError\(messageOf\(failure\)\)/);
  assert.ok(!/onError\?/.test(refreshBody), "只读加载失败不该弹会话错误横幅");
  assert.match(hookSource, /window\.addEventListener\("focus", handleFocus\)/);
});

test("运行方式：后台静默 / 系统默认终端 / 指定终端 app", () => {
  // 控件里有运行方式下拉，终端候选来自服务端探测；后台运行给一个「查看日志」入口
  assert.match(controlsSource, /runTarget/);
  assert.match(controlsSource, /projectCommand\.runTargetBackground/);
  assert.match(controlsSource, /\/api\/projects\/commands\/terminals/);
  assert.match(controlsSource, /projectCommand\.viewLog/);

  // 运行请求把方式带给桥：后台 = background 标记 + terminal token（缺省读 UI 偏好）
  const runBody = hookSource.slice(hookSource.indexOf("const run = useCallback"), hookSource.indexOf("const clearLastRun = useCallback"));
  assert.match(runBody, /background: target === PROJECT_COMMAND_BACKGROUND/);
  assert.match(runBody, /terminal: target/);
  assert.match(runBody, /loadUiPreferences\(\)\.projectCommandTerminal/);

  // 桥上有「终端探测」与「查看日志」两个端点
  assert.ok(serverSource.includes('url.pathname === "/api/projects/commands/terminals"'));
  assert.ok(serverSource.includes('url.pathname === "/api/projects/commands/reveal-log"'));
});

test("后台命令：进程还活着就一直显示运行中，并且能点「停止」", () => {
  // 桥：运行成功后登记进程，另给「存活状态」与「停止」两个端点
  assert.match(serverSource, /projectCommandRuns\.register\(/);
  assert.ok(serverSource.includes('url.pathname === "/api/projects/commands/status"'), "桥少了存活状态端点");
  assert.ok(serverSource.includes('url.pathname === "/api/projects/commands/stop"'), "桥少了停止端点");
  assert.match(serverSource, /projectCommandRuns\.stop\(String\(body\?\.runId/);

  // hook：有运行中的命令时轮询状态，进程退出 / 停止后列表清空、轮询自然停
  assert.match(hookSource, /PROJECT_COMMAND_RUN_POLL_MS/);
  assert.match(hookSource, /setInterval\(\(\) => void refreshRuns\(\)/);
  assert.match(hookSource, /window\.setInterval/);
  assert.match(hookSource, /const stopRun = useCallback/);
  assert.match(hookSource, /\/api\/projects\/commands\/status/);
  assert.match(hookSource, /\/api\/projects\/commands\/stop/);
  assert.match(hookSource, /normalizeProjectCommandRuns\(payload\?\.runs\)/);
  // 轮询内容没变时必须返回旧引用，否则整个 App 每 3 秒白重渲染
  assert.match(hookSource, /sameProjectCommandRuns\(current, next\) \? current : next/);

  // 控件：选中的命令在跑时，「运行」按钮本身变成「停止」（不再是单独一条运行中小条）
  assert.match(controlsSource, /findCommandRun\(runs, selected\.id\)/);
  assert.match(controlsSource, /projectCommand\.stop/);
  assert.match(controlsSource, /onClick=\{\(\) => onStopRun\(runningSelected\.id\)\}/);
  // 切到别的命令后，还在跑的那条用常驻小条保留停止入口
  assert.match(controlsSource, /projectCommand\.running/);
  assert.match(controlsSource, /onClick=\{\(\) => onStopRun\(otherRun\.id\)\}/);
});

test("命令的参数 / 环境变量：弹窗编辑 + 全链路透传", () => {
  // 弹窗读写环境变量走共享的 parse / format
  assert.match(dialogSource, /parseEnvText\(envText\)/);
  assert.match(dialogSource, /formatEnvText\(initial\?\.env/);
  assert.match(dialogSource, /commandLine\(trimmedCommand, args\)/);
  assert.match(dialogSource, /fieldArgs/);
  assert.match(dialogSource, /fieldEnv/);

  // 控件：每行有「编辑」入口，面板头部有「手动添加」
  assert.match(controlsSource, /ProjectCommandDialog/);
  assert.match(controlsSource, /onClick=\{\(\) => startEdit\(command\.id\)\}/);
  assert.match(controlsSource, /onClick=\{startAdd\}/);
  assert.match(controlsSource, /commandLine\(command\.command, command\.args\)/);
  assert.match(controlsSource, /command\.env\.length/);

  // hook：两条保存路径都走整表替换
  assert.match(hookSource, /updateProjectCommand\(commands, selectedCommandId, id, patch\)/);
  assert.match(hookSource, /appendProjectCommand\(commands, selectedCommandId, input\)/);
  assert.match(hookSource, /commandLine\(command\.command, command\.args\)/);

  // server：运行端点从 projects.json 命令上读 args / env，登记与返回用带参数的命令行
  const runBody = serverSource.slice(
    serverSource.indexOf('url.pathname === "/api/projects/commands/run"'),
    serverSource.indexOf('url.pathname === "/api/projects/git/commit-message"'),
  );
  assert.match(runBody, /args: command\.args/);
  assert.match(runBody, /commandEnv: command\.env/);
  assert.match(runBody, /commandLine\(command\.command, command\.args\)/);
});