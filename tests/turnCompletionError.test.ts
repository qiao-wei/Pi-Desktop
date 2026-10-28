/**
 * 「这一轮失败了没有」只按转录的**终局**判：最后一条 assistant 消息。
 *
 * 背景（真实事故）：一轮长任务在桥上看得好好的，界面上却收到 `error` 帧 —— 气泡标失败、
 * 系统提醒弹「任务失败」，而用户明明已经看到完整答案。原因是 `latestAssistantError`
 * 会往回复扫，扫到**任意**一条 `stopReason: "error"` 的 assistant 消息就返回：pi 在同一轮
 * prompt 里重试、溢出后压缩再继续、压缩后重试留下的失败尝试全在转录里（它们只是被
 * `context_edit` 从模型投影里摘掉），于是一次早已救回来的超时被当成这一轮的结局。
 *
 * 这几条断言是产品行为，不是实现细节：终局正常 = 这一轮没失败，哪怕前面失败过。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createSessionSnapshots } from "../server/sessionSnapshots.mjs";

const { latestAssistantError } = createSessionSnapshots({}, {});

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (stopReason: string, text = "answer", errorMessage?: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason,
  errorMessage,
  timestamp: 2,
});
const toolResult = () => ({ role: "toolResult", toolCallId: "call-1", content: [], timestamp: 3 });

test("重试后成功：前面那次失败的尝试不算这一轮失败", () => {
  assert.equal(
    latestAssistantError([
      user("do it"),
      assistant("error", "", "Request timed out."),
      assistant("stop", "改完了。"),
    ]),
    "",
  );
});

test("终局失败：最后一条 assistant 是 error 时才报", () => {
  assert.equal(
    latestAssistantError([user("do it"), assistant("error", "", "Request timed out.")]),
    "模型调用停止：Request timed out.",
  );

  // 同一个回合里先成功、最后一个请求失败：终局是失败。
  assert.equal(
    latestAssistantError([
      user("do it"),
      assistant("stop", "先做了一半。"),
      assistant("error", "", "503 ServiceUnavailable"),
    ]),
    "模型调用停止：503 ServiceUnavailable",
  );
});

test("末尾的 toolResult / user 不算终局消息，往前找最后一条 assistant", () => {
  assert.equal(
    latestAssistantError([user("do it"), assistant("error", "", "boom"), toolResult(), user("again")]),
    "模型调用停止：boom",
    "没有新的 assistant 消息时，上一次失败的结局仍然成立",
  );
  assert.equal(
    latestAssistantError([user("do it"), assistant("stop", "好了"), toolResult()]),
    "",
  );
});

test("用户自己中止：只有它是终局时才算（中止后的正常回答不算）", () => {
  assert.equal(
    latestAssistantError([user("do it"), assistant("aborted", "", "Request aborted")]),
    "模型调用停止：Request aborted",
  );
  assert.equal(
    latestAssistantError([user("do it"), assistant("aborted", ""), assistant("stop", "继续做完了")]),
    "",
  );
});

test("没有消息 / 非数组：不编造错误", () => {
  assert.equal(latestAssistantError(undefined), "");
  assert.equal(latestAssistantError([]), "");
  assert.equal(latestAssistantError([user("hi"), toolResult()]), "");
});