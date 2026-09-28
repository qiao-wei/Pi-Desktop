/**
 * 包命令参数补全（TUI 的 getArgumentCompletions）在桥侧的接线守卫。
 *
 * 背景：composer 要能像 pi TUI 一样 `/command <args>` 补参数，服务端必须把命令自己注册的
 * `getArgumentCompletions(prefix)` 暴露出来。pi 的扩展命令只有函数、没有可序列化的提示，
 * 所以做成按需请求：`POST /api/capabilities/package/command/arguments`。
 *
 * 行为层：候选的清洗是纯函数（server/commandArguments.mjs），直接跑；服务端/前端接线用
 * 限定在目标函数体内的结构性断言兜住（import server/index.mjs 会起服务，不能真 import）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeCommandArgumentItems } from "../server/commandArguments.mjs";
import { functionBody } from "./lib/sourceText.ts";

const server = readFileSync(join(import.meta.dirname, "../server/index.mjs"), "utf8");
const hook = readFileSync(join(import.meta.dirname, "../src/features/chat/usePiDesktopApp.ts"), "utf8");
const app = readFileSync(join(import.meta.dirname, "../src/app/App.tsx"), "utf8");

/* ------------------------------------------------ normalizeCommandArgumentItems */

test("normalizeCommandArgumentItems: keeps value/label/description as strings", () => {
  assert.deepEqual(
    normalizeCommandArgumentItems([
      { value: "alpha", label: "Alpha", description: "First" },
      { value: 42, label: 42 },
    ]),
    [
      { value: "alpha", label: "Alpha", description: "First" },
      { value: "42", label: "42" },
    ],
  );
});

test("normalizeCommandArgumentItems: label falls back to value, empty values are dropped", () => {
  assert.deepEqual(
    normalizeCommandArgumentItems([
      { value: "x" },
      { value: "" },
      { label: "no value" },
      { value: null },
      null,
    ]),
    [{ value: "x", label: "x" }],
  );
});

test("normalizeCommandArgumentItems: non-array (null command / dirty extension) yields []", () => {
  assert.deepEqual(normalizeCommandArgumentItems(null), []);
  assert.deepEqual(normalizeCommandArgumentItems(undefined), []);
  assert.deepEqual(normalizeCommandArgumentItems("nope"), []);
});

/* -------------------------------------------------------- server wiring */

test("snapshot exposes hasArgumentCompletions from the command's getArgumentCompletions", () => {
  const snapshot = functionBody(server, "buildCapabilitiesSnapshot");
  assert.match(
    snapshot,
    /hasArgumentCompletions: typeof command\.getArgumentCompletions === "function"/,
    "只有注册了参数补全的命令才让前端去拉候选",
  );
});

test("the arguments endpoint is registered and reads the command's own completions", () => {
  assert.match(
    server,
    /url\.pathname === "\/api\/capabilities\/package\/command\/arguments"[\s\S]{0,120}readCapabilityCommandArguments\(req, res\)/,
    "路由必须先于 /package/command 匹配，且指向 readCapabilityCommandArguments",
  );

  const handler = functionBody(server, "readCapabilityCommandArguments");
  assert.match(handler, /const prefix = typeof body\?\.prefix === "string" \? body\.prefix : ""/);
  assert.match(handler, /await command\.getArgumentCompletions\(prefix\)/);
  assert.match(handler, /normalizeCommandArgumentItems\(raw\)/);
});

test("both command execution and completion resolve through the same exact package-command lookup", () => {
  const find = functionBody(server, "findCapabilityPackageCommand");
  assert.match(find, /candidate\.invocationName === commandName \|\| candidate\.name === commandName/);
  assert.match(functionBody(server, "resolveCapabilityPackageCommand"), /findCapabilityPackageCommand\(/);
  assert.match(functionBody(server, "readCapabilityCommandArguments"), /findCapabilityPackageCommand\(/);
});

/* --------------------------------------------------------- hook / App wiring */

test("hook exports loadPackageCommandArguments and App consumes it", () => {
  assert.match(hook, /const loadPackageCommandArguments = useCallback\(/);
  assert.match(hook, /"\/api\/capabilities\/package\/command\/arguments"/);
  assert.match(hook, /return Array\.isArray\(response\?\.items\) \? response\.items : \[\]/);
  assert.match(hook, /\n    loadPackageCommandArguments,\n/);
  assert.match(app, /loadPackageCommandArguments,\n/);
  assert.match(app, /loadPackageCommandArguments\(slashCommandContext\.packageId, slashCommandContext\.name, slashCommandContext\.prefix\)/);
});