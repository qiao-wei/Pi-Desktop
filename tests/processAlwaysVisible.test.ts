/**
 * 「取消 header 上的眼睛开关，process 过程一直显示」的结构回归。
 *
 * 契约：① App 不再有 showProcess 状态 / 不再渲染那个切换按钮；
 * ② ChatThread 无条件带上 message.processBlocks（不再取决于任何开关）；
 * ③ 该开关也不再出现在持久化的 UI 偏好里。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appTsx = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const chatThreadTsx = readFileSync(new URL("../src/features/chat/ChatThread.tsx", import.meta.url), "utf8");
const uiPreferencesTs = readFileSync(new URL("../src/lib/ui-preferences.ts", import.meta.url), "utf8");

test("App no longer has the showProcess toggle", () => {
  assert.doesNotMatch(appTsx, /showProcess/);
  assert.doesNotMatch(appTsx, /Hide process|Show process/);
  // 眼睛图标只服务于这个开关；顺手删掉 import，避免死代码。
  assert.doesNotMatch(appTsx, /\bEyeOff?\b/);
});

test("ChatThread always renders the recorded process blocks", () => {
  assert.doesNotMatch(chatThreadTsx, /showProcess/);
  assert.ok(
    chatThreadTsx.includes("const processBlocks = liveBlocks.length ? liveBlocks : message.processBlocks ?? [];"),
    "processBlocks 必须无条件取自消息本身（liveBlocks 优先，历史块兜底）",
  );
});

test("ui-preferences no longer stores the process visibility flag", () => {
  assert.doesNotMatch(uiPreferencesTs, /showProcess/);
});