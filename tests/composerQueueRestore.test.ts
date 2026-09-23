import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  combineQueuedComposerText,
  mergeQueuedWithCurrentText,
} from "../src/features/chat/queuedComposerText.ts";

const ROOT = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// combineQueuedComposerText：clearedQueue → 编辑器文本
// ---------------------------------------------------------------------------

test("combineQueuedComposerText：steering 在前、follow-up 在后，条目间空行连接", () => {
  const text = combineQueuedComposerText(
    ["先看下报错日志", "顺便改下样式"],
    ["跑完测试再提交"],
  );
  assert.equal(text, "先看下报错日志\n\n顺便改下样式\n\n跑完测试再提交");
});

test("combineQueuedComposerText：空队列返回空串（不往编辑器塞东西）", () => {
  assert.equal(combineQueuedComposerText([], []), "");
  assert.equal(combineQueuedComposerText([""], []), "");
  assert.equal(combineQueuedComposerText(["   "], ["\n"]), "");
});

test("combineQueuedComposerText：条目前后空白被裁掉，非空内容保留", () => {
  const text = combineQueuedComposerText(["  带空白的插话  "], []);
  assert.equal(text, "带空白的插话");
});

test("combineQueuedComposerText：只 steering / 只 follow-up 都可用", () => {
  assert.equal(combineQueuedComposerText(["a"], []), "a");
  assert.equal(combineQueuedComposerText([], ["b"]), "b");
});

// ---------------------------------------------------------------------------
// mergeQueuedWithCurrentText：排队文本与编辑器已有文本合并
// ---------------------------------------------------------------------------

test("mergeQueuedWithCurrentText：排队文本在前，编辑器已有文本在后（对齐 TUI）", () => {
  assert.equal(
    mergeQueuedWithCurrentText("退回的插话", "我正在打的新内容"),
    "退回的插话\n\n我正在打的新内容",
  );
});

test("mergeQueuedWithCurrentText：编辑器为空时只留排队文本，不产生空行开头", () => {
  assert.equal(mergeQueuedWithCurrentText("退回的插话", ""), "退回的插话");
  assert.equal(mergeQueuedWithCurrentText("退回的插话", "   "), "退回的插话");
});

test("mergeQueuedWithCurrentText：两边都空返回空串", () => {
  assert.equal(mergeQueuedWithCurrentText("", ""), "");
});

// ---------------------------------------------------------------------------
// 接线（窄断言，限定在目标函数/区域内，避免全文件级结构性断言的假绿）
// ---------------------------------------------------------------------------

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `找不到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, `找不到结束标记：${endMarker}`);
  return source.slice(start, end);
}

test("usePiDesktopApp.stopTurn：/api/stop 响应一到就把 clearedQueue 交给回调，不等 idle 轮询", () => {
  const source = readFileSync(join(ROOT, "src/features/chat/usePiDesktopApp.ts"), "utf8");
  const stopTurnBody = sliceBetween(source, "async function stopTurn(", "输入框旁切换模型");
  assert.match(stopTurnBody, /clearedQueue\?: \{ steering\?: string\[\]; followUp\?: string\[\] \}/);
  assert.match(
    stopTurnBody,
    /onClearedQueue\?\.\(\{\s*steering: next\.clearedQueue\?\.steering \?\? \[\],\s*followUp: next\.clearedQueue\?\.followUp \?\? \[\],\s*\}\);/,
  );
});

test("App：停止按钮走 handleStopTurn，恢复逻辑消费 combineQueuedComposerText 且保留已有内容", () => {
  const source = readFileSync(join(ROOT, "src/app/App.tsx"), "utf8");

  // 停止按钮区域（限定在 stop-button 附近）必须用 handleStopTurn
  const buttonRegion = sliceBetween(source, 'className="icon-button stop-button"', "send-button");
  assert.match(buttonRegion, /onClick=\{\(\) => void handleStopTurn\(\)\}/);

  // 恢复函数必须调用 combine 函数，且 handleStopTurn 把回调传给 stopTurn
  const restoreBody = sliceBetween(source, "function restoreQueuedComposerMessages", "function handleStopTurn");
  assert.match(restoreBody, /combineQueuedComposerText\(cleared\.steering \?\? \[\], cleared\.followUp \?\? \[\]\)/);
  assert.match(restoreBody, /mergeQueuedWithCurrentText\(queuedText, currentText\)/);
  const handleBody = sliceBetween(source, "function handleStopTurn", restoreBody ? "function insertAttachmentsAtCursor" : "");
  assert.match(handleBody, /stopTurn\(\(cleared\) => restoreQueuedComposerMessages\(cleared\)\)/);
});

test("服务端契约：/api/stop 的 stopSession 必须把 clearQueue() 取出的原文放进响应（退回编辑器的数据来源）", () => {
  const source = readFileSync(join(ROOT, "server/index.mjs"), "utf8");
  const stopSessionBody = sliceBetween(
    source,
    "async function stopSession(targetRuntime, options = {})",
    "async function abortSession(session, { requestId, reason })",
  );
  assert.match(stopSessionBody, /activeSession\.clearQueue\(\)/);
  assert.match(stopSessionBody, /clearedQueue,/);
});
