/**
 * 线上载荷的字节预算。
 *
 * 这些用例钉的是**诚实**：裁掉的量必须被记下来（界面要靠它说"内容过大"），
 * 计数必须来自裁剪之前的原文（`+N` 不能因为预览变短而缩水），并且同一个对象
 * 不能被就地改坏——转录在快照之间是共享的。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  budgetArgsDelta,
  budgetFramePayload,
  budgetToolArgs,
  budgetToolResultText,
  cutTextHeadTail,
  MAX_STREAM_FRAME_BYTES,
  omittedFieldOf,
  omittedFieldsOf,
  textByteLength,
  TOOL_ARG_STRING_MAX_BYTES,
  TOOL_ARGS_STREAM_MAX_BYTES,
} from "../src/shared/toolPayloadBudget.ts";

const big = (lines: number, line = "0123456789abcdef") =>
  Array.from({ length: lines }, () => line).join("\n");

test("小参数原样返回：同一份对象，不挂标记", () => {
  const args = { path: "a.ts", content: "x" };
  const budgeted = budgetToolArgs(args);
  assert.equal(budgeted, args, "没有要裁的东西时不该复制");
  assert.equal(omittedFieldsOf(budgeted).length, 0);
});

test("超长正文裁成 head + tail，并记下裁剪前的行数", () => {
  const content = big(8000);
  const result = budgetToolArgs({ path: "big.md", content }) as {
    content: string;
    __omitted: unknown;
  };

  // JSON 仍然可解析：路径这类短字段必须还在，否则行里就点不到文件了。
  const parsed = JSON.parse(JSON.stringify(result)) as typeof result;
  assert.equal((parsed as unknown as { path: string }).path, "big.md");

  assert.ok(parsed.content.startsWith("0123456789abcdef\n"), "开头保留");
  assert.ok(parsed.content.endsWith("0123456789abcdef"), "结尾保留");
  assert.ok(parsed.content.includes("\n…\n"), "中间是省略标记");
  assert.ok(
    textByteLength(parsed.content) < textByteLength(content),
    "整体确实变小了",
  );

  const cut = omittedFieldOf(parsed, "content");
  assert.ok(cut, "裁剪信息必须能被查回来");
  assert.equal(cut.bytes, textByteLength(content), "bytes 是原文的字节数");
  assert.equal(cut.lines, 8000, "lines 是原文的行数（不是预览的行数）");
});

test("不就地修改输入：原件仍然完整", () => {
  const content = big(4000);
  const args = { path: "a.md", content };
  budgetToolArgs(args);
  assert.equal(args.content.length, content.length, "共享的转录不能被裁坏");
});

test("幂等：裁过的对象再裁一次不会缩水，也不会叠标记", () => {
  const once = budgetToolArgs({ content: big(8000) }) as { content: string; __omitted: unknown[] };
  const twice = budgetToolArgs(once) as { content: string; __omitted: unknown[] };
  assert.equal(twice, once, "已预算过的对象原样返回");
  assert.equal(twice.__omitted.length, 1);
  assert.ok(!twice.content.includes("\n…\n…\n"), "标记不会叠加");
});

test("嵌套字段也裁（edits[0].newText），路径按数组下标记", () => {
  const args = {
    path: "a.ts",
    edits: [{ oldText: "a", newText: big(6000) }],
  };
  const budgeted = budgetToolArgs(args);
  const cut = omittedFieldOf(budgeted, "edits[0].newText");
  assert.ok(cut, `没找到裁剪信息：${JSON.stringify(omittedFieldsOf(budgeted))}`);
  assert.equal(cut.lines, 6000);
});

test("非字符串字段与浅对象保持原样", () => {
  const args = { path: "a.ts", offset: 12, flag: true, options: { a: 1 }, content: "ok" };
  assert.equal(budgetToolArgs(args), args);
});

test("cutTextHeadTail：刚好在预算内的文本不动", () => {
  const text = "x".repeat(TOOL_ARG_STRING_MAX_BYTES * 2);
  assert.deepEqual(cutTextHeadTail(text, TOOL_ARG_STRING_MAX_BYTES, TOOL_ARG_STRING_MAX_BYTES), {
    text,
    cut: null,
  });
});

test("cutTextHeadTail：多字节字符被切开时不留下替换符", () => {
  const text = "一".repeat(40_000); // 每个 3 字节，远超预算
  const { text: cut, cut: info } = cutTextHeadTail(text, 32 * 1024, 32 * 1024);
  assert.ok(info);
  assert.ok(!cut.startsWith("\uFFFD"), "开头不能是半个字符");
  assert.ok(!cut.includes("\n…\n\uFFFD"), "标记后面不能是半个字符");
  assert.equal(info.lines, 1);
});

test("结果正文：小于预算原样，超了裁中段并报原始量", () => {
  const small = "hello";
  assert.deepEqual(budgetToolResultText(small), { text: small, cut: null });

  const text = `${"a".repeat(40_000)}\n${"b".repeat(40_000)}`;
  const { text: cut, cut: info } = budgetToolResultText(text);
  assert.ok(info);
  assert.equal(info.bytes, textByteLength(text));
  assert.equal(info.lines, 2);
  assert.ok(cut.startsWith("a"));
  assert.ok(cut.endsWith("b"));
});

test("参数流 delta 预算：发够就停，不越界", () => {
  const first = budgetArgsDelta(0, "x".repeat(100), 50);
  assert.equal(first.text.length, 50);
  assert.equal(first.forwardedBytes, 50);

  const second = budgetArgsDelta(first.forwardedBytes, "y".repeat(100), 50);
  assert.equal(second.text, "", "预算用完之后不再转发");
  assert.equal(second.forwardedBytes, 50);

  // 边界：正好用完预算的那一段可以整段发。
  const exact = budgetArgsDelta(0, "z".repeat(TOOL_ARGS_STREAM_MAX_BYTES));
  assert.equal(exact.text.length, TOOL_ARGS_STREAM_MAX_BYTES);
  assert.equal(budgetArgsDelta(exact.forwardedBytes, "tail").text, "");
});

/* -------------------------------------------------------------------------- */
/* 整帧预算                                                                    */
/* -------------------------------------------------------------------------- */

test("整帧：限内的帧原样、零裁剪", () => {
  const payload = { type: "delta", text: "hi" };
  const budgeted = budgetFramePayload(payload);
  assert.equal(budgeted.payload, payload);
  assert.equal(budgeted.cuts.length, 0);
  assert.equal(budgeted.salvaged, false);
});

test("整帧：只有一个大字段时裁掉它，形状与类型不变", () => {
  const payload = {
    type: "tool_execution_end",
    bubbleId: "t3#assistant",
    toolCallId: "call-1",
    result: { content: [{ type: "text", text: big(20_000) }] },
  };
  const budgeted = budgetFramePayload(payload, 128 * 1024);
  const out = budgeted.payload as typeof payload & { __cuts: unknown[] };
  assert.equal(out.type, "tool_execution_end");
  assert.equal(out.bubbleId, "t3#assistant");
  assert.equal(out.toolCallId, "call-1", "结构字段必须留下，事件才能落到正确的行");
  assert.ok(budgeted.cuts.length > 0);
  assert.ok(budgeted.bytes <= 128 * 1024, `裁剪后仍然超限：${budgeted.bytes}`);
  assert.ok(
    (out.result.content[0].text as string).includes("\n…\n"),
    "正文是 head+tail，不是整段消失",
  );
});

test("整帧：裁完还超限就只剩便宜字段，但 type 与 id 仍在", () => {
  // 一千个中等字符串：每个都在单字段预算内，合起来却远超一帧。
  const cells = Array.from({ length: 1000 }, () => "q".repeat(4_000));
  const budgeted = budgetFramePayload({ type: "tool_execution_update", toolCallId: "c2", cells }, 256 * 1024);
  const out = budgeted.payload as {
    type: string;
    toolCallId: string;
    cells?: unknown;
    __dropped: { bytes: number };
  };
  assert.equal(budgeted.salvaged, true);
  assert.equal(out.type, "tool_execution_update");
  assert.equal(out.toolCallId, "c2");
  assert.equal(out.cells, undefined, "大数组整体丢掉");
  assert.ok(out.__dropped.bytes > 0);
  assert.ok(budgeted.bytes <= MAX_STREAM_FRAME_BYTES);
});
test("整帧：超限的快照整份省略，而不是裁成半份历史", () => {
  // 一份"状态文档"被裁短 = 用更小的历史覆盖客户端已有的历史。所以这里的规则是：
  // 宁可明确说"这次没带"，也不发一份残缺的。客户端据此跳过这次 reconcile。
  const snapshot = {
    type: "snapshot",
    runId: "run-1",
    snapshot: {
      snapshot: {
        conversation: {
          messages: Array.from({ length: 240 }, (_, index) => ({
            id: `t${index}#user`,
            role: "user",
            content: big(200, `line ${index}`),
          })),
        },
      },
    },
  };

  const budgeted = budgetFramePayload(snapshot, 256 * 1024);
  const out = budgeted.payload as {
    type: string;
    runId?: string;
    snapshot?: unknown;
    snapshotOmitted?: { bytes: number; messages: number; reason: string };
    __cuts?: unknown;
    __dropped?: unknown;
  };

  assert.equal(budgeted.salvaged, true);
  assert.equal(out.type, "snapshot", "客户端要能认出这是哪一类帧");
  assert.equal(out.runId, "run-1");
  assert.equal(out.snapshot, undefined, "不许留下被裁过的 snapshot");
  assert.equal(out.__cuts, undefined, "也不该走通用裁剪（那会切出半份历史）");
  assert.equal(out.snapshotOmitted?.reason, "oversize");
  assert.equal(out.snapshotOmitted?.messages, 240);
  assert.ok((out.snapshotOmitted?.bytes ?? 0) > 256 * 1024, "记的是裁剪前的原始大小");
  assert.ok(textByteLength(JSON.stringify(out)) < 1024, "省略帧本身必须很小");
});

test("整帧：没有超限的快照原样通过（不因为它是状态文档就特殊处理）", () => {
  const snapshot = {
    type: "snapshot",
    runId: "run-2",
    snapshot: { snapshot: { conversation: { messages: [{ id: "t1#user", role: "user", content: "hi" }] } } },
  };
  const budgeted = budgetFramePayload(snapshot, 256 * 1024);
  assert.equal(budgeted.payload, snapshot);
  assert.equal(budgeted.salvaged, false);
  assert.equal((budgeted.payload as { snapshotOmitted?: unknown }).snapshotOmitted, undefined);
});
