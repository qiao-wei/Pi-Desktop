/**
 * 「运行命令」运行方式的偏好归一化（`src/shared/projectCommandTerminal.ts`）。
 *
 * 这个值会原样进 `/api/projects/commands/run` 的请求体，所以形态卫生（空白、旧值、注入字符）
 * 必须在这里锁死：非法一律落回后台静默，而不是让桥拿着怪字符串去 `open -a`。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  isProjectCommandBackground,
  normalizeProjectCommandTerminal,
  PROJECT_COMMAND_BACKGROUND,
  PROJECT_COMMAND_DEFAULT_TERMINAL,
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