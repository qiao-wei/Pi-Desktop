/**
 * 「会话忙不忙」的客户端口径守卫。
 *
 * 背景（2026-09-17 真机反馈）：两个并行会话里，切到历史会话再切回来，有时会报
 * `Stop the running response before switching thinking.`。根因是服务端
 * `isSessionBusy()` 把 `pendingMessageCount > 0`（pi 队列里还压着插话/跟进）也算忙，
 * 客户端却只用 `isStreaming || isCompacting` 禁用思考下拉 —— 于是「停止中/队列未消化」
 * 这两类空闲态上选择器仍可点，点下去必被服务端拒绝。
 *
 * 这一层只测纯函数 + 接线，确保两端口径绑在一起。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isSessionBusy, pendingQueuedCount, sessionControlsDisabled } from "../src/shared/sessionBusy.ts";

const appTsx = readFileSync(join(import.meta.dirname, "../src/app/App.tsx"), "utf8");
const hook = readFileSync(join(import.meta.dirname, "../src/features/chat/usePiDesktopApp.ts"), "utf8");
const server = readFileSync(join(import.meta.dirname, "../server/index.mjs"), "utf8");

test("pendingQueuedCount：steering + follow-up 一起数，缺字段当 0", () => {
  assert.equal(pendingQueuedCount(undefined), 0);
  assert.equal(pendingQueuedCount(null), 0);
  assert.equal(pendingQueuedCount({}), 0);
  assert.equal(pendingQueuedCount({ steering: [], followUp: [] }), 0);
  assert.equal(pendingQueuedCount({ steering: ["插话"] }), 1);
  assert.equal(pendingQueuedCount({ steering: ["a", "b"], followUp: ["c"] }), 3);
});

test("isSessionBusy：流式 / 压缩 / 停止中 / 队列未消化都算忙", () => {
  assert.equal(isSessionBusy({}), false, "空闲会话不能算忙");
  assert.equal(isSessionBusy({ isStreaming: true }), true);
  assert.equal(isSessionBusy({ isCompacting: true }), true);
  // 这两个是本次修的漏网之鱼：服务端算忙，客户端过去没算。
  assert.equal(isSessionBusy({ isStopping: true }), true, "点了停止但服务端还在 abort");
  assert.equal(isSessionBusy({ pendingQueues: { followUp: ["继续"] } }), true, "pi 队列里还压着消息");
  assert.equal(isSessionBusy({ pendingQueues: { steering: ["先看日志"] } }), true);
});

test("sessionControlsDisabled：换会话（isBootstrapping）时也禁用", () => {
  assert.equal(sessionControlsDisabled({ isBootstrapping: true }), true);
  assert.equal(sessionControlsDisabled({ isBootstrapping: true, isStreaming: true }), true);
  assert.equal(sessionControlsDisabled({}), false);
});

test("服务端 isSessionBusy 的定义仍是三条（改这里必须同步客户端）", () => {
  assert.match(
    server,
    /function isSessionBusy\(session\) \{\s*return session\.isStreaming \|\| session\.isCompacting \|\| session\.pendingMessageCount > 0;\s*\}/,
    "服务端忙的定义变了：客户端 src/shared/sessionBusy.ts 要跟着改",
  );
});

test("输入框旁三个控件都用 composerSessionBusy（不再各自手写三连判断）", () => {
  assert.match(appTsx, /const composerSessionBusy = sessionControlsDisabled\(\{/, "App 缺 composerSessionBusy 派生");
  assert.match(
    appTsx,
    /composerSessionBusy = sessionControlsDisabled\(\{[\s\S]{0,200}pendingQueues: bootstrap\.pendingQueues/,
    "composerSessionBusy 必须把 bootstrap.pendingQueues 算进去",
  );
  assert.equal(
    (appTsx.match(/disabled=\{composerSessionBusy\}/g) ?? []).length,
    3,
    "思考下拉 / ⋯ 收纳菜单 / 模型下拉 三处都要用同一个禁用条件",
  );
  assert.doesNotMatch(
    appTsx,
    /disabled=\{state\.isStreaming \|\| state\.isCompacting \|\| state\.isBootstrapping\}/,
    "不允许再留手写的三连判断（会漏掉 isStopping 与队列）",
  );
});

test("桥调用前有同一口径的竞态守卫（禁用态落地前点进来也拦得住）", () => {
  // 两处：换模型与改思考等级。
  assert.equal(
    (hook.match(/isSessionBusy\(\{/g) ?? []).length,
    2,
    "selectComposerModel / updateSessionThinkingLevel 都要用 isSessionBusy 兜底",
  );
  assert.match(hook, /import \{ isSessionBusy \} from "\.\.\/\.\.\/shared\/sessionBusy";/);
});