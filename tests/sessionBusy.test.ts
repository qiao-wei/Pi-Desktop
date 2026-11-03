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
import { bridgeSource } from "./lib/bridgeSource.ts";
import { appSource } from "./lib/appSource.ts";

const appTsx = appSource();
const hook = readFileSync(join(import.meta.dirname, "../src/features/chat/usePiDesktopApp.ts"), "utf8");
const server = bridgeSource();

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
  // 一个 sessionBusyNow()，三处桥调用共用：换模型、改思考等级、技能会话开关。
  assert.equal(
    (hook.match(/isSessionBusy\(\{/g) ?? []).length,
    1,
    "口径快照应只有一份（sessionBusyNow），不要在每处再手写一遍",
  );
  assert.match(hook, /const sessionBusyNow = useCallback\(\(\) => isSessionBusy\(\{/);
  assert.equal(
    (hook.match(/if \(sessionBusyNow\(\)\)/g) ?? []).length,
    3,
    "selectComposerModel / updateSessionThinkingLevel / setSessionSkill 都要用它兜底",
  );
  assert.match(hook, /import \{ isSessionBusy \} from "\.\.\/\.\.\/shared\/sessionBusy";/);
});

// 2026-10-31 真机反馈：对话进行中在 composer 里选技能，输入框里立刻出现
// 「Stop the running response before changing this session's skills.」。徽标已经插进去了，
// 报错的只是那一刻的会话开关。忙时不该发这个请求：徽标是「这条消息要用这个技能」的意图，
// 提交时由服务端统一处理（空闲→使能；流式中途→展开正文）。
test("会话忙时技能徽标不发会话开关，红字不再挂在输入框里", () => {
  assert.match(
    appTsx,
    /const sessionRuntimeLocked = isSessionBusy\(\{/,
    "App 缺 sessionRuntimeLocked 派生（必须包含 pendingQueues，和服务端 isSessionBusy 同口径）",
  );
  assert.match(
    appTsx,
    /sessionRuntimeLocked = isSessionBusy\(\{[\s\S]{0,200}pendingQueues: bootstrap\.pendingQueues/,
    "sessionRuntimeLocked 必须把 bootstrap.pendingQueues 算进去",
  );
  // 技能插入 / 退格删除 / 徽标删除 / 粘贴徽标 四处都要上同一道闸。
  const guards = [
    /if \(selectedCapability\.kind === "skill" && !sessionRuntimeLocked\)/,
    /if \(capability\?\.kind === "skill" && !sessionRuntimeLocked && !deps\.hasComposerCapability\(capability\)\)/,
    /if \(capability\.kind === "skill" && !sessionRuntimeLocked\)/,
    /if \(!sessionRuntimeLocked\) \{\n\s+const capabilityUpdate = setSessionSkill\(capability\.id, true\);/,
  ];
  for (const guard of guards) {
    assert.match(appTsx, guard, `技能开关少了忙时闸：${guard}`);
  }
  assert.equal(
    (appTsx.match(/setSessionSkill\(/g) ?? []).length,
    4,
    "插入 / 退格删除 / 徽标删除 / 粘贴 共四处调用 setSessionSkill；多出来的地方很可能没上闸",
  );
});