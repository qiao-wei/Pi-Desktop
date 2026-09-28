/**
 * pi 内置斜杠命令（目前只有 `/reload`）在 Pi Desktop 里的支持面。
 *
 * 背景：pi 的完整内置表在 `@earendil-works/pi-coding-agent` 的
 * `dist/core/slash-commands.js`，但它没有从包根导出，而且内置命令的执行只存在于 pi 的
 * interactive/TUI mode —— Pi Desktop 走 SDK/RPC 拿不到。所以 Pi Desktop 只登记自己真的
 * 实现了的那几条，服务端下发到 capabilities 快照，提交时派发到 `/api/builtin-command`。
 *
 * 行为层：登记表与派发决策是纯模块（server/builtinCommands.mjs），直接跑；服务端/前端接线
 * 用限定在目标函数体内的结构性断言兜住（import server/index.mjs 会起服务，不能真 import）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PI_DESKTOP_BUILTIN_COMMANDS,
  findBuiltinCommand,
  planBuiltinCommand,
} from "../server/builtinCommands.mjs";
import { functionBody } from "./lib/sourceText.ts";

const server = readFileSync(join(import.meta.dirname, "../server/index.mjs"), "utf8");
const hook = readFileSync(join(import.meta.dirname, "../src/features/chat/usePiDesktopApp.ts"), "utf8");
const app = readFileSync(join(import.meta.dirname, "../src/app/App.tsx"), "utf8");

/* ---------------------------------------------------- builtinCommands.mjs */

test("the registry only ships commands Pi Desktop can actually run", () => {
  const names = PI_DESKTOP_BUILTIN_COMMANDS.map((command) => command.name);
  assert.ok(names.includes("reload"), "reload 是本轮唯一实现的内置命令");
  // `/model` 用户明确要求不接：它绝不能出现在下发列表里，否则菜单会给出点了没反应的项。
  assert.ok(!names.includes("model"));
  const reload = findBuiltinCommand("reload");
  assert.match(reload.description, /extensions, skills, prompts, themes/);
});

test("planBuiltinCommand: registered / bare / whitespace-only args run", () => {
  assert.equal(planBuiltinCommand("reload").kind, "run");
  assert.equal(planBuiltinCommand("reload", "").kind, "run");
  assert.equal(planBuiltinCommand("reload", "   ").kind, "run");
});

test("planBuiltinCommand: registered command with args is rejected, not silently ignored", () => {
  const plan = planBuiltinCommand("reload", "extensions");
  assert.equal(plan.kind, "invalid");
  assert.equal(plan.command.name, "reload");
  assert.match(plan.reason, /does not take arguments/);
});

test("planBuiltinCommand: unregistered names stay unknown so they go to chat", () => {
  // `/model`、`/help`、`/whatever` 都不是 Pi Desktop 命令，必须落回普通文本路径。
  assert.equal(planBuiltinCommand("model").kind, "unknown");
  assert.equal(planBuiltinCommand("help", "me").kind, "unknown");
  assert.equal(planBuiltinCommand("").kind, "unknown");
  assert.equal(planBuiltinCommand(null).kind, "unknown");
});

/* ---------------------------------------------------------- server wiring */

test("snapshot ships the built-in registry to the client", () => {
  const snapshot = functionBody(server, "buildCapabilitiesSnapshot");
  assert.match(snapshot, /builtinCommands: PI_DESKTOP_BUILTIN_COMMANDS/);
});

test("the bridge exposes POST /api/builtin-command", () => {
  assert.match(server, /url\.pathname === "\/api\/builtin-command"/);
  const route = server.slice(
    server.indexOf('url.pathname === "/api/builtin-command"'),
    server.indexOf('url.pathname === "/api/builtin-command"') + 220,
  );
  assert.match(route, /await readJson\(req\)/);
  assert.match(route, /sendJson\(res, 200, await runBuiltinCommand\(body\)\)/);
});

test("runBuiltinCommand: plans, refuses busy sessions, reloads the target runtime", () => {
  const body = functionBody(server, "runBuiltinCommand");

  assert.match(body, /getRuntimeForRequest\(body\)/);
  assert.match(body, /planBuiltinCommand\(body\?\.command, body\?\.args\)/);
  assert.match(body, /plan\.kind === "unknown"[\s\S]*?throw new Error\("Unknown built-in command\."\)/);
  assert.match(body, /plan\.kind === "invalid"[\s\S]*?throw new Error\(plan\.reason\)/);
  // 回合中途 reload 会在半途换掉工具/提示词，必须先停。
  assert.match(body, /isSessionBusy\(targetRuntime\.session\)[\s\S]*?throw new Error\("Stop the running response before reloading\."\)/);
  assert.match(body, /await reloadRuntimeTargets\(\[targetRuntime\]\)/);
  assert.match(body, /return \{ command: plan\.command\.name, snapshot: await buildSnapshot\(targetRuntime\) \}/);
});

/* ---------------------------------------------------------- client wiring */

test("the hook routes /api/builtin-command through the snapshot-reconciling helper", () => {
  const declaration = hook.indexOf("const runBuiltinCommand = useCallback(");
  assert.notEqual(declaration, -1, "runBuiltinCommand must exist");
  const body = hook.slice(declaration, hook.indexOf(");", declaration) + 2);
  // 复用 updateCapability：POST 后回整份 snapshot，客户端 replaceBootstrap 一起刷新。
  assert.match(body, /updateCapability\("\/api\/builtin-command", \{ command, args \}\)/);
  assert.match(hook, /^\s+runBuiltinCommand,$/m, "hook 必须把 runBuiltinCommand 暴露给 App");
});

test("selectSlashItem: built-ins insert /name and never execute", () => {
  const select = functionBody(app, "selectSlashItem");
  assert.match(select, /item\.kind === "builtin"[\s\S]*?insertBuiltinCommandAtCursor\(item\)/);
  assert.doesNotMatch(select, /runBuiltinCommand/);

  const insert = functionBody(app, "insertBuiltinCommandAtCursor");
  assert.match(insert, /hasArgumentCompletions: false/, "内置命令不拉参数补全");
  assert.match(insert, /\{ trailingSpace: false \}/, "先填 /name，不带尾随空格");
  assert.doesNotMatch(insert, /runBuiltinCommand|runPackageCommand/);
});

test("slashMenuItemKey: built-ins get their own key space", () => {
  const key = functionBody(app, "slashMenuItemKey");
  assert.match(key, /item\.kind === "builtin"[\s\S]*?return `builtin:\$\{item\.name\}`/);
});
/* ------------------------------------------------- 内置命令的状态带（无聊天回复也有反馈） */

test("提交内置命令会亮状态带：running 先出，成功换 done", () => {
  const submit = functionBody(app, "handleSubmit");
  assert.match(submit, /if \(builtinCommand\) \{\s*showBuiltinNotice\(builtinCommand\.name, "running"\);/);
  assert.match(submit, /showBuiltinNotice\(builtinCommand\.name, "done"\)/);
});

test("失败时状态带让位给 composer 错误带（不能让 spinner 一直转）", () => {
  const submit = functionBody(app, "handleSubmit");
  // 失败分支：先 clearBuiltinNotice()，再 setComposerError(具体原因)
  assert.match(submit, /\(error\) => \{[\s\S]*?clearBuiltinNotice\(\);[\s\S]*?setComposerError\(/);
});

test("状态带是「内置命令」这一类操作的通用机制，不是 /reload 特判", () => {
  const submit = functionBody(app, "handleSubmit");
  assert.doesNotMatch(submit, /["'`]reload["'`]/, "handleSubmit 不该认识具体命令名");

  const show = functionBody(app, "showBuiltinNotice");
  assert.match(show, /builtinCommandNoticeText\(name, phase\)/, "文案必须由通用模块按命令名选");
  assert.doesNotMatch(show, /reload/, "showBuiltinNotice 不该认识具体命令名");
});

test("running 留到出结果，done 停留一会儿后自动收掉", () => {
  const show = functionBody(app, "showBuiltinNotice");
  assert.match(show, /phase === "done"[\s\S]*?window\.setTimeout/);
  assert.match(show, /BUILTIN_COMMAND_DONE_DISMISS_MS/);
});

test("状态带渲染在 composer 里，done 复用 compaction 的条但有自己的 tone", () => {
  const formStart = app.indexOf('<form className="composer"');
  const noticeAt = app.indexOf("data-tone={builtinNotice.tone}");
  const fileInputAt = app.indexOf('className="composer-file-input"');
  assert.ok(formStart >= 0 && noticeAt > formStart && noticeAt < fileInputAt, "状态带要在 composer 表单内、文件输入之前");

  assert.match(
    app,
    /\) : builtinNotice \? \(\s*<div className="compaction-notice" data-tone=\{builtinNotice\.tone\} role="status">/,
  );
  assert.match(app, /\{builtinNotice\.tone === "running" \? <Loader2 className="compaction-notice-spin" \/> : null\}/);
  // 两条带互斥：compaction 优先（reload 要求会话空闲，理论上不会同时出现，但别叠起来）
  assert.match(app, /\{compactionNoticeView \? \([\s\S]*?\) : builtinNotice \? \(/);
});

test("done 的配色有 CSS 兜底（否则绿色回执会露出 warning 底色）", () => {
  const css = readFileSync(join(import.meta.dirname, "../src/app/styles.css"), "utf8");
  assert.match(css, /\.composer > \.compaction-notice\[data-tone="done"\] \{/);
});

test("卸载时清掉状态带定时器，免得组件没了之后才 setState", () => {
  assert.match(
    app,
    /useEffect\(\(\) => \(\) => \{\s*if \(builtinNoticeTimerRef\.current != null\) \{\s*window\.clearTimeout\(builtinNoticeTimerRef\.current\);\s*builtinNoticeTimerRef\.current = null;\s*\}\s*\}, \[\]\);/,
  );
});
