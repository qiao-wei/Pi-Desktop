/**
 * `ctx.ui.setWidget` 桥接守卫。
 *
 * 背景:关掉 pi-monitor（或任何用 `ctx.ui.setWidget(key, undefined)` 清 widget 的扩展）后，
 * 编辑器上方那块两行文本还在。根因:桥写的是 `if (!Array.isArray(content)) return;`，
 * 把「清除」（`content === undefined`）也一起丢了 —— 前端只认空/缺失的 `widgetLines` 才删除，
 * 于是只收到 set、永远收不到 clear。pi 自己的 RPC 出口是
 * `if (content === undefined || Array.isArray(content))`，Bridge 当初抄漏了 `undefined` 分支。
 *
 * 行为层直接测纯函数 `server/extensionUiRequests.mjs`；接线层断言 pair（桥调用它、前端删除路径）
 * 仍然存在，防止 helper 被写成但没人用（假绿）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { extensionWidgetRequest } from "../server/extensionUiRequests.mjs";
import { functionBody } from "./lib/sourceText.ts";

const server = readFileSync(join(import.meta.dirname, "../server/index.mjs"), "utf8");
const hook = readFileSync(join(import.meta.dirname, "../src/features/chat/usePiDesktopApp.ts"), "utf8");

test("纯文本行原样透传，默认放在编辑器上方", () => {
  const request = extensionWidgetRequest("pi-monitor", ["line 1", "line 2"]);
  assert.deepEqual(request, {
    widgetKey: "pi-monitor",
    widgetLines: ["line 1", "line 2"],
    widgetPlacement: "aboveEditor",
  });
  assert.deepEqual(extensionWidgetRequest("k", ["x"], { placement: "belowEditor" })?.widgetPlacement, "belowEditor");
});

test("undefined 是清除，必须透传（不能吞掉）", () => {
  const request = extensionWidgetRequest("pi-monitor", undefined);
  assert.ok(request, "undefined 不能被当成非法值丢掉，否则前端永远收不到 clear");
  assert.equal(request.widgetKey, "pi-monitor");
  assert.equal(request.widgetLines, undefined, "清除请求必须让 widgetLines 缺失/为空，前端据此删除");
});

test("空数组同样是清除", () => {
  assert.deepEqual(extensionWidgetRequest("k", [])?.widgetLines, []);
});

test("函数式组件在纯文本出口里忽略（不会误清同名 widget）", () => {
  assert.equal(extensionWidgetRequest("k", () => {}), undefined);
  assert.equal(extensionWidgetRequest("k", "not-an-array"), undefined);
});

test("接线：桥调用 helper，前端在 widgetLines 为空/缺失时删除", () => {
  const bridge = functionBody(server, "createExtensionUiBridge");
  assert.match(bridge, /extensionWidgetRequest\(widgetKey,\s*content,\s*options\)/, "桥必须走同一个清除语义");
  assert.doesNotMatch(
    bridge,
    /if \(!Array\.isArray\(content\)\) \{\s*return;/,
    "旧的「非数组就丢」守卫必须删掉，它把 undefined 清除一起丢了",
  );
  assert.match(hook, /if \(request\.widgetLines\?\.length\)[\s\S]{0,200}else\s*\{\s*delete next\[request\.widgetKey\]/, "前端删除路径必须保留");
});