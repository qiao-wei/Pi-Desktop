/**
 * 「滚到某条消息」信号的路由规则。
 *
 * 症状背景：全局搜索点结果 → 切会话 → 目标消息应该被滚到屏幕中间。切会话是异步的，
 * 新线程还没挂载；等它挂载后 entry 恢复又会把视口拉回旧位置。所以信号必须能先发后
 * 订阅（parked），并且只由当前会话的视口 owner 消费。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createChatJumpBus, type ChatJumpRequest } from "../src/shared/chatJumpBus.ts";

const chatThreadSource = readFileSync(
  new URL("../src/features/chat/ChatThread.tsx", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

test("已挂载的 owner 立即收到请求", () => {
  const bus = createChatJumpBus();
  const seen: ChatJumpRequest[] = [];
  bus.subscribe("/p/s1.jsonl", (request) => seen.push(request));
  assert.equal(bus.request("/p/s1.jsonl", "t3#assistant", "global-search"), true);
  assert.deepEqual(seen, [
    { sessionPath: "/p/s1.jsonl", messageId: "t3#assistant", reason: "global-search" },
  ]);
});

test("先请求后订阅也会送达（切会话还没挂载的窗口）", () => {
  const bus = createChatJumpBus();
  assert.equal(bus.request("/p/s2.jsonl", "t1#user", "global-search"), false);
  const seen: ChatJumpRequest[] = [];
  bus.subscribe("/p/s2.jsonl", (request) => seen.push(request));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].messageId, "t1#user");
});

test("暂存只保留最新一条，且是每个会话各自的", () => {
  const bus = createChatJumpBus();
  bus.request("/p/s1.jsonl", "t1#user", "global-search");
  bus.request("/p/s1.jsonl", "t2#assistant", "global-search");
  const seen: string[] = [];
  bus.subscribe("/p/s1.jsonl", (request) => seen.push(request.messageId));
  bus.subscribe("/p/s2.jsonl", (request) => seen.push(request.messageId));
  assert.deepEqual(seen, ["t2#assistant"]);
});

test("别的会话的 owner 不会收到请求，取消订阅后不再送达", () => {
  const bus = createChatJumpBus();
  const seen: string[] = [];
  const unsubscribe = bus.subscribe("/p/s1.jsonl", (request) => seen.push(request.messageId));
  assert.equal(bus.request("/p/s2.jsonl", "t1#user", "global-search"), false);
  assert.deepEqual(seen, []);
  unsubscribe();
  assert.equal(bus.hasSubscriber("/p/s1.jsonl"), false);
  assert.equal(bus.request("/p/s1.jsonl", "t9#user", "global-search"), false);
});

test("ChatThread 订阅了 jump bus，并把它交给视口 owner", () => {
  assert.match(chatThreadSource, /from "\.\.\/\.\.\/shared\/chatJumpBus"/);
  assert.match(chatThreadSource, /chatJumpBus\.subscribe\(/);
});

test("App 的结果点击切会话后发起跳转请求", () => {
  assert.match(appSource, /chatJumpBus\.request\(/);
  assert.match(appSource, /"global-search"/);
});