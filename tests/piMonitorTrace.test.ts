/**
 * pi-monitor trace 纯逻辑（~/.pi/agent/packages/pi-monitor/extensions/monitor/trace.ts）的测试。
 *
 * 目标是「排障时能不能看懂」：思考过程、工具入参/结果/耗时、错误标记、相邻条目时间差、
 * 以及各种上限（条数 / 单块字数 / 总体积）不能把页面撑爆。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	buildTrace,
	capText,
	errorSummary,
	toolArgsText,
	TRACE_LIMITS,
	traceToMarkdown,
} from "../../../.pi/agent/packages/pi-monitor/extensions/monitor/trace.ts";

function messageEntry(id: string, timestamp: string, message: Record<string, unknown>, parentId: string | null = null) {
	return { type: "message", id, parentId, timestamp, message };
}

const USER = messageEntry("e1", "2026-09-26T10:00:00.000Z", {
	role: "user",
	content: "修一下 login 的问题",
	timestamp: 1,
});

const ASSISTANT = messageEntry(
	"e2",
	"2026-09-26T10:00:02.500Z",
	{
		role: "assistant",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: { input: 1200, output: 340, cacheRead: 800, cacheWrite: 0, reasoning: 120, cost: { total: 0.0123 } },
		content: [
			{ type: "thinking", thinking: "先看看相关文件" },
			{ type: "text", text: "我去查一下" },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "rg login" } },
		],
		timestamp: 2,
	},
	"e1",
);

const TOOL_RESULT = messageEntry(
	"e3",
	"2026-09-26T10:00:04.000Z",
	{
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		isError: false,
		content: [{ type: "text", text: "src/login.ts:42" }],
		timestamp: 3,
	},
	"e2",
);

test("用户与 assistant 条目：文本、思考、模型、stopReason、usage 都在", () => {
	const trace = buildTrace([USER, ASSISTANT]);
	assert.equal(trace.entries.length, 2);

	const user = trace.entries[0];
	assert.equal(user.kind, "user");
	assert.equal(user.deltaMs, null);
	assert.deepEqual(user.blocks, [{ type: "text", text: "修一下 login 的问题" }]);

	const assistant = trace.entries[1];
	assert.equal(assistant.kind, "assistant");
	assert.equal(assistant.model, "claude-sonnet-4-5");
	assert.equal(assistant.stopReason, "toolUse");
	assert.equal(assistant.deltaMs, 2500);
	assert.equal(assistant.usage?.costUsd, 0.0123);
	assert.equal(assistant.usage?.reasoning, 120);
	assert.deepEqual(
		assistant.blocks.map((block) => block.type),
		["thinking", "text", "toolCall"],
	);
});

test("工具调用与它的结果合成一张卡，并带上耗时与错误标记", () => {
	const trace = buildTrace([USER, ASSISTANT, TOOL_RESULT], { timings: { c1: { ms: 1500, startedAt: 0 } } });
	assert.equal(trace.entries.length, 2, "toolResult 应该并进 assistant 的 toolCall，而不是单独一条");
	assert.equal(trace.totals.toolCalls, 1);
	assert.equal(trace.totals.toolErrors, 0);

	const block = trace.entries[1].blocks.find((item) => item.type === "toolCall");
	assert.ok(block);
	if (block.type !== "toolCall") return;
	assert.equal(block.tool.name, "bash");
	assert.equal(block.tool.callId, "c1");
	assert.match(block.tool.argsText, /rg login/);
	assert.equal(block.tool.result, "src/login.ts:42");
	assert.equal(block.tool.ms, 1500);
	assert.equal(block.tool.isError, false);
});

test("报错的工具结果被标成 error 并计入 totals", () => {
	const failed = messageEntry("e3", "2026-09-26T10:00:04.000Z", {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		isError: true,
		content: [{ type: "text", text: "command not found" }],
		timestamp: 3,
	});
	const trace = buildTrace([ASSISTANT, failed]);
	const block = trace.entries[0].blocks.find((item) => item.type === "toolCall");
	assert.ok(block && block.type === "toolCall");
	assert.equal(block.tool.isError, true);
	assert.equal(trace.totals.toolErrors, 1);
	assert.equal(trace.entries[0].isError, undefined, "消息本身不是错误，错在工具");
});

test("没有对应调用的 toolResult 仍然单独成条（别把结果弄丢）", () => {
	const orphan = messageEntry("e9", "2026-09-26T10:00:09.000Z", {
		role: "toolResult",
		toolCallId: "缺",
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: "文件内容" }],
		timestamp: 9,
	});
	const trace = buildTrace([orphan]);
	assert.equal(trace.entries.length, 1);
	assert.equal(trace.entries[0].kind, "tool");
	const block = trace.entries[0].blocks[0];
	assert.ok(block.type === "toolCall");
	assert.equal(block.tool.name, "read");
	assert.equal(block.tool.result, "文件内容");
});

test("模型报错、压缩、模型切换、thinking 档位都能读出来", () => {
	const failedAssistant = messageEntry("e2", "2026-09-26T10:00:02.000Z", {
		role: "assistant",
		model: "qwen",
		stopReason: "error",
		errorMessage: "context length exceeded",
		usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		content: [{ type: "text", text: "..." }],
		timestamp: 2,
	});
	const compaction = {
		type: "compaction",
		id: "c1",
		parentId: "e2",
		timestamp: "2026-09-26T10:01:00.000Z",
		summary: "之前修了 login",
		firstKeptEntryId: "e2",
		tokensBefore: 180000,
		tokensAfter: 20000,
	};
	const modelChange = { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-26T10:02:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4-5" };
	const levelChange = { type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-09-26T10:03:00.000Z", thinkingLevel: "high" };

	const trace = buildTrace([failedAssistant, compaction, modelChange, levelChange]);
	assert.equal(trace.entries[0].isError, true);
	assert.equal(trace.entries[0].detail, "context length exceeded");
	assert.equal(trace.entries[1].kind, "compaction");
	assert.match(trace.entries[1].detail ?? "", /180000 → 20000/);
	assert.match(trace.entries[1].blocks[0].type === "text" ? trace.entries[1].blocks[0].text : "", /之前修了 login/);
	assert.equal(trace.entries[2].detail, "anthropic/claude-sonnet-4-5");
	assert.equal(trace.entries[3].detail, "high");
});

test("时间差：相邻条目间隔；乱序时间不产生负数", () => {
	const later = messageEntry("e2", "2026-09-26T10:00:12.000Z", { role: "user", content: "b", timestamp: 12 });
	const back = messageEntry("e3", "2026-09-26T10:00:05.000Z", { role: "user", content: "c", timestamp: 5 });
	const trace = buildTrace([USER, later, back]);
	assert.equal(trace.entries[0].deltaMs, null);
	assert.equal(trace.entries[1].deltaMs, 12_000);
	assert.equal(trace.entries[2].deltaMs, null, "时间倒退时不报负数，标成 null");
	assert.equal(trace.entries[2].seq, 2);
});

test("时间戳优先用条目的 ISO 时间（message.timestamp 只是兜底）", () => {
	const trace = buildTrace([USER]);
	assert.equal(trace.entries[0].ts, Date.parse("2026-09-26T10:00:00.000Z"));
});

test("默认上限不截断正常会话（不是只能看最近的几百条）", () => {
	const entries = Array.from({ length: 1200 }, (_, index) =>
		messageEntry(`e${index}`, new Date(Date.UTC(2026, 8, 26, 10, 0, index % 60, Math.floor(index / 60))).toISOString(), {
			role: "user",
			content: "x".repeat(500),
			timestamp: index,
		}),
	);
	const trace = buildTrace(entries);
	assert.equal(trace.totals.entries, 1200);
	assert.equal(trace.totals.shown, 1200, "默认上限下 1200 条应该一条不丢");
	assert.equal(trace.totals.dropped, 0);
	assert.equal(trace.entries[0].seq, 0, "第一条要从会话开头开始");
	assert.ok(TRACE_LIMITS.maxEntries >= 5000, "默认条目上限要足够装下长会话");
	assert.ok(TRACE_LIMITS.maxTotalChars >= 8_000_000, "默认字节预算要足够装下长会话");
});

test("工具报错的条目：行上带 toolErrorCount 与首行错误摘要（不用展开就能看到原因）", () => {
	const failed = messageEntry("e3", "2026-09-26T10:00:04.000Z", {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		isError: true,
		content: [{ type: "text", text: "(no output)\n\nCommand exited with code 1" }],
		timestamp: 3,
	});
	const trace = buildTrace([ASSISTANT, failed]);
	const entry = trace.entries[0];
	assert.equal(entry.toolErrorCount, 1);
	assert.equal(entry.toolErrorSample, "Command exited with code 1", "要丢掉 (no output) 这种废话行");
	assert.equal(entry.isError, undefined, "消息本身不是错误");

	// 导出里要有「错误速查表」，直接列到哪一条、哪个工具、原因
	const markdown = traceToMarkdown(trace, { session: "s" });
	assert.match(markdown, /## tool errors \(1\)/);
	assert.match(markdown, /- \*\*#0\*\* `bash` \([^)]+\) — Command exited with code 1/);
});

test("错误摘要要挑出有信息量的那行（真实数据里的几种形状）", () => {
	const cases: Array<[string, string]> = [
		["(no output)\n\nCommand exited with code 1", "Command exited with code 1"],
		["Command aborted", "Command aborted"],
		["Command timed out after 120 seconds", "Command timed out after 120 seconds"],
		["FAIL Cannot find module /tmp/x.ts\n\n\nCommand exited with code 1", "FAIL Cannot find module /tmp/x.ts"],
		["== A ==\nℹ pass 8\nℹ fail 1\n\n\nCommand timed out after 300 seconds", "== A == · ℹ pass 8 · Command timed out after 300 seconds"],
		["Error: ENOENT: no such file or directory, open /tmp/x", "Error: ENOENT: no such file or directory, open /tmp/x"],
		["", "(no output)"],
	];
	for (const [raw, expected] of cases) {
		assert.equal(errorSummary(raw), expected, `input: ${JSON.stringify(raw)}`);
	}
	assert.ok(errorSummary("x".repeat(500)).length <= 201, "超长要截断");
});

test("多个工具报错时计数×N，摘要取第一个", () => {
	const two = messageEntry("e3", "2026-09-26T10:00:04.000Z", {
		role: "assistant",
		model: "m",
		stopReason: "toolUse",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		content: [
			{ type: "toolCall", id: "c1", name: "read", arguments: {} },
			{ type: "toolCall", id: "c2", name: "bash", arguments: {} },
		],
		timestamp: 3,
	});
	const r1 = messageEntry("e4", "2026-09-26T10:00:05.000Z", { role: "toolResult", toolCallId: "c1", toolName: "read", isError: true, content: [{ type: "text", text: "ENOENT" }] });
	const r2 = messageEntry("e5", "2026-09-26T10:00:06.000Z", { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: true, content: [{ type: "text", text: "exit 1" }] });
	const trace = buildTrace([two, r1, r2]);
	assert.equal(trace.entries.length, 1);
	assert.equal(trace.entries[0].toolErrorCount, 2);
	assert.equal(trace.entries[0].toolErrorSample, "ENOENT");
});

test("没有报错的条目不带 toolErrorCount（不能被当成错误筛出来）", () => {
	const trace = buildTrace([USER, ASSISTANT, TOOL_RESULT]);
	for (const entry of trace.entries) {
		assert.equal(entry.toolErrorCount, undefined);
		assert.equal(entry.toolErrorSample, undefined);
	}
});

test("上限：条数超了就丢最老的，并记在 totals.dropped", () => {
	const entries = Array.from({ length: 10 }, (_, index) =>
		messageEntry(`e${index}`, new Date(Date.UTC(2026, 8, 26, 10, 0, index)).toISOString(), {
			role: "user",
			content: `第 ${index} 条`,
			timestamp: index,
		}),
	);
	const trace = buildTrace(entries, { maxEntries: 4 });
	assert.equal(trace.totals.entries, 10);
	assert.equal(trace.totals.shown, 4);
	assert.equal(trace.totals.dropped, 6);
	assert.equal(trace.entries[0].kind, "user");
	const first = trace.entries[0].blocks[0];
	assert.ok(first.type === "text");
	assert.equal(first.text, "第 6 条", "保留的是最近的");
});

test("上限：单块超长会截断并给出隐藏了多少字符", () => {
	const long = "x".repeat(TRACE_LIMITS.maxBlockChars + 500);
	const trace = buildTrace([messageEntry("e1", "2026-09-26T10:00:00.000Z", { role: "user", content: long, timestamp: 1 })]);
	const block = trace.entries[0].blocks[0];
	assert.ok(block.type === "text");
	assert.equal(block.text.length, TRACE_LIMITS.maxBlockChars);
	assert.equal(block.truncated, 500);
});

test("上限：总量超预算时丢最老的条目，而不是把每条都切碎", () => {
	const big = "y".repeat(1000);
	const entries = Array.from({ length: 10 }, (_, index) =>
		messageEntry(`e${index}`, new Date(Date.UTC(2026, 8, 26, 10, 0, index)).toISOString(), {
			role: "user",
			content: big,
			timestamp: index,
		}),
	);
	const trace = buildTrace(entries, { maxTotalChars: 4000 });
	assert.ok(trace.totals.dropped > 0);
	assert.equal(trace.totals.shown, trace.entries.length);
	const kept = trace.entries[0].blocks[0];
	assert.ok(kept.type === "text");
	assert.equal(kept.text.length, 1000, "留下的条目内容是完整的");
});

test("capText / toolArgsText 的边界", () => {
	assert.deepEqual(capText("abc", 10), { text: "abc", truncated: 0 });
	assert.deepEqual(capText("abcdef", 3), { text: "abc", truncated: 3 });
	assert.equal(toolArgsText(undefined).text, "");
	assert.match(toolArgsText({ a: 1 }).text, /"a": 1/);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.equal(typeof toolArgsText(circular).text, "string");
});

test("导出的 Markdown 里思考、入参、结果、用量都在（贴 issue 用）", () => {
	const trace = buildTrace([USER, ASSISTANT, TOOL_RESULT], { timings: { c1: { ms: 1500 } } });
	const markdown = traceToMarkdown(trace, { session: "sess-1", model: "claude-sonnet-4-5" });
	assert.match(markdown, /^# pi-monitor trace/);
	assert.match(markdown, /- session: sess-1/);
	assert.match(markdown, /<summary>thinking<\/summary>/);
	assert.match(markdown, /先看看相关文件/);
	assert.match(markdown, /### tool `bash` · 1\.5s/);
	assert.match(markdown, /rg login/);
	assert.match(markdown, /src\/login\.ts:42/);
	assert.match(markdown, /usage: in 1200 \/ out 340/);
	assert.match(markdown, /entries: 2\/2 · tool calls: 1 · tool errors: 0/);
});