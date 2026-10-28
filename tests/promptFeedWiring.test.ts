/**
 * 「流坏了 ≠ 这一轮失败了」的接线守卫。
 *
 * 背景（2026-10-28）：帧写入器的 4 MiB 待发上限开火时只发一帧 `transport_error`，
 * 而渲染侧把它和业务错误 `error` 一视同仁 —— 于是气泡提前落定、弹一条「本轮已完成」的
 * 通知、停止按钮消失，可桥上的 run 还在跑（只有 owner 请求 close 才中止）。
 *
 * 行为在这次事故之前就缺了：`streamSeq` 与 `POST /api/runs/stream` 是 2026-10-26 就有的
 * affordance，但渲染侧没有任何调用点。现在由 `src/features/chat/promptFeed.ts` 接上：
 * 先续订、续不上才追加快照。这里钉三件容易悄悄退回原样的事：
 *
 * 1. `transport_error` 不许再进 `apply*Event` 的「本轮结束」分支；
 * 2. 每一帧都必须先过 `feed.accept`（否则续订与游标就形同虚设）；
 * 3. 追平快照之后，**只有快照说它不在跑了**才落定这一轮。
 *
 * `promptFeed.test.ts` 覆盖续订/跳号/重试的行为；这里只咬接线本身。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { functionBody } from "./lib/sourceText.ts";

const read = (path: string): string => readFileSync(join(import.meta.dirname, "..", path), "utf8");

const hook = read("src/features/chat/usePiDesktopApp.ts");
const feedSource = read("src/features/chat/promptFeed.ts");

/** 截一段源码：从 `from` 到其后第一个 `to`。这两段都是箭头函数，`functionBody` 切不了。 */
function slice(from: string, to: string): string {
  const start = hook.indexOf(from);
  const end = hook.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `切不出 ${from} … ${to}`);
  return hook.slice(start, end);
}

test("prompt / edit 的逐帧处理不许把传输故障当业务失败", () => {
  // 事故时的写法（两条提交路径各一份）：把「桥把流掐了」当成「这一轮失败了」。
  const promptApply = slice("const applyPromptEvent", "const handlePromptEvent");
  const editApply = slice("const applyEditEvent", "const editFeed = openPromptFeed(");
  for (const [label, body] of [["prompt", promptApply], ["edit", editApply]] as const) {
    assert.doesNotMatch(
      body,
      /transport_error/,
      `${label} 路径的 transport_error 必须交给 promptFeed 续订，不能在这里收尾`,
    );
  }
  // 传输故障的收尾必须是「续订或追平」，不是写错误横幅。
  assert.match(feedSource, /event\.type === "transport_error"/, "promptFeed 是 prompt 流的唯一去处");
});

test("能力包操作仍然把传输故障当失败（那条流没有 run 可续）", () => {
  const capability = slice("const streamCapabilityOperation", "const installPackage");
  assert.match(capability, /event\.type === "error" \|\| event\.type === "transport_error"/);
});

test("每一帧都先过 feed：三个提交路径都不许绕开游标", () => {
  assert.match(hook, /feed\.accept\(event\)/);
  assert.match(hook, /editFeed\.accept\(event\)/);
  assert.match(hook, /steerFeed\.accept\(event\)|handlePromptEvent\(event, requestGeneration, null, steerFeed\)/);
  // 三条路径都建 feed，缺一条就有一类轮次永远接不回来。
  const feeds = hook.match(/openPromptFeed\(\{/g) ?? [];
  assert.equal(feeds.length, 3, "新会话 / 插话 / 编辑重发各一条 feed");
});

test("追平快照之后才收尾，而且要看快照说它还在不在跑", () => {
  const reconcile = functionBody(hook, "reconcileLostFeed");
  // 先被续订判死 → 强制快照 → 只有 !busy 才落定。
  assert.match(reconcile, /streamLost = true/);
  assert.match(reconcile, /fetchBootstrap\(\{ force: true \}\)/);
  assert.match(reconcile, /if \(!busy\) \{\s*finishLocalStreamingTurn\(/, "忙着的 run 不许落定");
  assert.match(reconcile, /chat\.stream\.lostBusy/);
  assert.match(reconcile, /chat\.stream\.lostDone/);
  // 追平失败也必须说话，不能静默留着一个永远转的停止按钮。
  assert.match(reconcile, /chat\.stream\.lostUnreachable/);
});

test("流死了之后看门狗改走 full 轮询（ambient 不带转录，追不平）", () => {
  assert.match(hook, /ownsStream: Boolean\(streamState\?\.controller\) && !streamState\?\.streamLost/);
});