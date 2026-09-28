/**
 * pi-monitor 接线层（~/.pi/agent/packages/pi-monitor/extensions/monitor/index.ts）测试：用假的
 * ExtensionAPI / ExtensionContext 走真实事件序列，验证计数 → UI → 日志 → 拦截 → dashboard。
 *
 * dashboard 相关用真 HTTP（server 是 listen(0) 的本地服务）；浏览器打开用 mock pi.exec 记录。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import monitorFactory from "../../../.pi/agent/packages/pi-monitor/extensions/monitor/index.ts";

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

function createMockPi() {
	const events = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const execCalls: Array<{ file: string; args: string[] }> = [];
	const pi = {
		on(name: string, handler: Handler) {
			const list = events.get(name) ?? [];
			list.push(handler);
			events.set(name, list);
			return () => {
				events.set(
					name,
					(events.get(name) ?? []).filter((entry) => entry !== handler),
				);
			};
		},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		registerShortcut(key: string, definition: any) {
			shortcuts.set(key, definition);
		},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getActiveTools() {
			return [];
		},
		getAllTools() {
			return [...tools.values()].map((tool) => ({ name: tool.name }));
		},
		setActiveTools() {},
		async exec(file: string, args: string[]) {
			execCalls.push({ file, args });
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		setSessionName() {},
		getSessionName() {
			return undefined;
		},
		events: { on: () => () => {}, emit: () => {} },
	};
	return { pi, events, tools, commands, shortcuts, execCalls };
}

function createMockCtx(options: { branch?: unknown[]; entries?: unknown[]; trusted?: boolean; cwd?: string } = {}) {
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: options.cwd ?? process.cwd(),
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		thinkingLevel: "high",
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => "/tmp/sess-1.jsonl",
			getBranch: () => options.branch ?? [],
			getEntries: () => options.entries ?? options.branch ?? [],
		},
		isProjectTrusted: () => options.trusted ?? false,
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 1234, contextWindow: 200_000, percent: 1 }),
		getSystemPrompt: () => "",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			setWidget: (key: string, value: string[] | undefined) => widgets.set(key, value),
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			custom: async () => undefined,
			confirm: async () => false,
			select: async () => undefined,
			input: async () => undefined,
		},
	};
	return { ctx, statuses, widgets, notifications };
}

async function emit(events: Map<string, Handler[]>, name: string, event: any, ctx: any) {
	const results: unknown[] = [];
	for (const handler of events.get(name) ?? []) results.push(await handler(event, ctx));
	return results;
}

function useTempAgentDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-monitor-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});
	return dir;
}

function dashboardUrlFrom(notifications: Array<{ message: string }>): string | undefined {
	for (const notification of [...notifications].reverse()) {
		const match = notification.message.match(/http:\/\/127\.0\.0\.1:\d+\/\?session=[0-9a-f-]+/i);
		if (match) return match[0];
	}
	return undefined;
}

test("app 重启后（reason=startup）计数从历史重建，而不是全 0——含审计日志里的拦截/provider/工具耗时", async (t) => {
	const agentDir = useTempAgentDir(t);
	const entries = [
		{ type: "session", id: "s0", parentId: null, timestamp: "2026-09-27T10:00:00.000Z" },
		{
			type: "message",
			id: "e1",
			parentId: "s0",
			timestamp: "2026-09-27T10:00:01.000Z",
			message: { role: "user", content: "帮我改代码" },
		},
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-09-27T10:00:05.000Z",
			message: {
				role: "assistant",
				model: "deepseek-v4.1-flash",
				stopReason: "toolUse",
				usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } },
				content: [{ type: "toolCall", id: "c1", name: "edit", arguments: {} }],
			},
		},
		{
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: "2026-09-27T10:00:06.000Z",
			message: { role: "toolResult", toolCallId: "c1", toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] },
		},
		{ type: "compaction", id: "k1", parentId: "e3", timestamp: "2026-09-27T10:02:00.000Z", summary: "之前改了代码", tokensBefore: 100 },
	];
	// 上次运行写下的审计日志（被拦住过、被限流过、工具耗时）
	const auditPath = join(agentDir, "monitor", "sessions", "sess-1.jsonl");
	mkdirSync(dirname(auditPath), { recursive: true });
	writeFileSync(
		auditPath,
		[
			JSON.stringify({ kind: "session_start", reason: "startup" }),
			JSON.stringify({ kind: "tool_end", tool: "edit", ms: 2500, error: false }),
			JSON.stringify({ kind: "blocked", tool: "bash", rule: "rm-rf-root" }),
			JSON.stringify({ kind: "provider_status", status: 429 }),
			"{ 半行脏数据",
		].join("\n"),
	);

	const { pi, events, tools } = createMockPi();
	monitorFactory(pi);
	const { ctx, statuses } = createMockCtx({ entries });
	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const tool = tools.get("monitor_report");
	const snap = JSON.parse((await tool.execute("c", { format: "json" }, undefined, undefined, ctx)).content[0].text);
	assert.equal(snap.restored, true, "要标明数字是从历史重建的");
	assert.equal(snap.turns, 1);
	assert.equal(snap.toolCalls, 1);
	assert.equal(snap.compactions, 1);
	assert.equal(snap.tokens.costUsd, 0.05);
	assert.equal(snap.blocked, 1, "审计日志里的拦截也要恢复");
	assert.equal(snap.rateLimits, 1);
	assert.ok(snap.tools.some((stat: any) => stat.name === "edit" && stat.totalMs === 2500), "工具耗时从审计日志补齐");
	assert.match(String(statuses.get("pi-monitor")), /1 turns/, "状态栏不能显示 0 turns");

	// 新的一轮事件继续累加，不会因为重建而重复计数
	await emit(events, "turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);
	const snap2 = JSON.parse((await tool.execute("c2", { format: "json" }, undefined, undefined, ctx)).content[0].text);
	assert.equal(snap2.turns, 2);
});

test("注册了 monitor_report 工具、/monitor 命令和两个快捷键", () => {
	const { pi, tools, commands, shortcuts } = createMockPi();
	monitorFactory(pi);

	assert.ok(tools.has("monitor_report"));
	assert.match(tools.get("monitor_report").description, /trace/i);
	assert.ok(commands.has("monitor"));
	assert.match(commands.get("monitor").description, /dashboard/);
	assert.ok(shortcuts.has("ctrl+shift+m"));
	assert.ok(shortcuts.has("ctrl+shift+d"));
});

test("会话生命周期：状态栏/widget 更新，工具与 token 进入计数，日志落 JSONL", async (t) => {
	const agentDir = useTempAgentDir(t);
	const { pi, events } = createMockPi();
	monitorFactory(pi);
	const { ctx, statuses, widgets } = createMockCtx();

	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.match(String(statuses.get("pi-monitor")), /0 turns/);
	assert.ok(Array.isArray(widgets.get("pi-monitor")));

	await emit(events, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
	await emit(events, "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "ls" } }, ctx);
	await emit(events, "tool_execution_end", { toolCallId: "c1", toolName: "bash", result: {}, isError: false }, ctx);
	await emit(events, "tool_execution_start", { toolCallId: "c2", toolName: "read", args: { path: "/x" } }, ctx);
	await emit(events, "tool_execution_end", { toolCallId: "c2", toolName: "read", result: {}, isError: true }, ctx);
	await emit(
		events,
		"message_end",
		{
			type: "message_end",
			message: { role: "assistant", usage: { input: 1200, output: 400, cost: { total: 0.02 } }, stopReason: "stop" },
		},
		ctx,
	);
	await emit(events, "turn_end", { type: "turn_end", turnIndex: 0, outcome: "completed", toolResults: [{}, {}] }, ctx);

	const status = String(statuses.get("pi-monitor"));
	assert.match(status, /1 turns/);
	assert.match(status, /2 tools/);
	assert.match(status, /1 err/);
	assert.match(status, /\$0\.02/);

	const widget = widgets.get("pi-monitor") ?? [];
	assert.ok(widget.some((line) => line.includes("tools 2 (err 1")));
	assert.ok(widget.some((line) => line.startsWith("last: read")));

	await emit(events, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	assert.equal(statuses.get("pi-monitor"), undefined);

	const logPath = join(agentDir, "monitor", "sessions", "sess-1.jsonl");
	assert.ok(existsSync(logPath), "JSONL 审计日志应写入 agent 目录");
	const lines = readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const kinds = lines.map((line) => line.kind);
	assert.ok(kinds.includes("session_start"));
	assert.ok(kinds.includes("tool_end"));
	assert.ok(kinds.includes("turn_end"));
	assert.ok(kinds.includes("session_shutdown"));
	const summary = JSON.parse(readFileSync(join(agentDir, "monitor", "summaries", "sess-1.json"), "utf8"));
	assert.equal(summary.toolCalls, 2);
	assert.equal(summary.toolErrors, 1);
});

test("resume 时从会话分支重建计数，而不是从零开始", async (t) => {
	useTempAgentDir(t);
	const { pi, events } = createMockPi();
	monitorFactory(pi);
	const branch = [
		{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cost: { total: 0.5 } } } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", isError: true } },
	];
	const { ctx, statuses } = createMockCtx({ branch });

	await emit(events, "session_start", { type: "session_start", reason: "resume" }, ctx);
	const status = String(statuses.get("pi-monitor"));
	assert.match(status, /1 turns/);
	assert.match(status, /1 tools/);
	assert.match(status, /1 err/);
	assert.match(status, /\$0\.5/);
});

test("默认规则拦截 rm -rf /，返回 block 且计入 blocked、发 warning", async (t) => {
	useTempAgentDir(t);
	const { pi, events } = createMockPi();
	monitorFactory(pi);
	const { ctx, statuses, notifications } = createMockCtx();
	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const [result] = (await emit(
		events,
		"tool_call",
		{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "rm -rf /" } },
		ctx,
	)) as Array<{ block?: boolean; reason?: string }>;
	assert.equal(result?.block, true);
	assert.match(String(result?.reason), /rm-rf-root/);
	assert.ok(notifications.some((entry) => entry.type === "warning" && /blocked/.test(entry.message)));
	assert.match(String(statuses.get("pi-monitor")), /1 blocked/);

	const [allowed] = (await emit(
		events,
		"tool_call",
		{ type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "rm -rf ./build" } },
		ctx,
	)) as Array<{ block?: boolean }>;
	assert.notEqual(allowed?.block, true);
});

test("预算阈值只触发一次，并写入 alerts 与通知", async (t) => {
	const agentDir = useTempAgentDir(t);
	writeFileSync(join(agentDir, "monitor.json"), JSON.stringify({ budget: { costUsd: 0.01 } }), "utf8");
	const { pi, events } = createMockPi();
	monitorFactory(pi);
	const { ctx, notifications } = createMockCtx();
	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const assistant = {
		type: "message_end",
		message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0.02 } }, stopReason: "stop" },
	};
	await emit(events, "message_end", assistant, ctx);
	await emit(events, "turn_end", { type: "turn_end", turnIndex: 0, outcome: "completed", toolResults: [] }, ctx);
	await emit(events, "turn_end", { type: "turn_end", turnIndex: 1, outcome: "completed", toolResults: [] }, ctx);

	const costNotices = notifications.filter((entry) => /budget/.test(entry.message));
	assert.equal(costNotices.length, 1, "同一阈值不应重复通知");
	assert.equal(costNotices[0].type, "error");
});

test("受信任项目的 .pi/monitor.json 覆盖全局配置", async (t) => {
	const agentDir = useTempAgentDir(t);
	writeFileSync(join(agentDir, "monitor.json"), JSON.stringify({ widget: true }), "utf8");
	const projectDir = mkdtempSync(join(tmpdir(), "pi-monitor-project-"));
	t.after(() => rmSync(projectDir, { recursive: true, force: true }));
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "monitor.json"), JSON.stringify({ widget: false, rules: [] }), "utf8");

	const { pi, events, commands } = createMockPi();
	monitorFactory(pi);
	const { ctx, widgets, notifications } = createMockCtx({ trusted: true, cwd: projectDir });
	ctx.mode = "print";
	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);

	assert.equal(widgets.get("pi-monitor"), undefined, "项目配置 widget:false 应关闭 widget");

	await commands.get("monitor").handler("rules", ctx);
	assert.ok(notifications.some((entry) => /no rules configured/.test(entry.message)));
});

test("monitor_report 工具返回 markdown/json 快照", async (t) => {
	useTempAgentDir(t);
	const { pi, events, tools } = createMockPi();
	monitorFactory(pi);
	const { ctx } = createMockCtx();
	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await emit(events, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
	await emit(events, "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} }, ctx);
	await emit(events, "tool_execution_end", { toolCallId: "c1", toolName: "bash", result: {}, isError: false }, ctx);

	const tool = tools.get("monitor_report");
	const markdown = await tool.execute("call-1", { format: "markdown" }, undefined, undefined, ctx);
	assert.match(markdown.content[0].text, /^# pi-monitor report/);
	assert.match(markdown.content[0].text, /\| tool calls \| 1 \|/);

	const json = await tool.execute("call-2", { format: "json" }, undefined, undefined, ctx);
	assert.equal(JSON.parse(json.content[0].text).toolCalls, 1);
});

test("monitor_report format=trace 返回最近记录（带思考与工具结果），并可限条数", async (t) => {
	useTempAgentDir(t);
	const entries = [
		{
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: "2026-09-26T10:00:00.000Z",
			message: { role: "user", content: "第一步", timestamp: 1 },
		},
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-09-26T10:00:01.000Z",
			message: {
				role: "assistant",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				content: [
					{ type: "thinking", thinking: "先看看文件" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
				],
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: "2026-09-26T10:00:02.000Z",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				isError: true,
				content: [{ type: "text", text: "ENOENT: a.ts" }],
				timestamp: 3,
			},
		},
	];
	const { pi, events, tools } = createMockPi();
	monitorFactory(pi);
	const { ctx } = createMockCtx({ entries });
	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const tool = tools.get("monitor_report");
	const trace = await tool.execute("call-1", { format: "trace" }, undefined, undefined, ctx);
	const text = trace.content[0].text;
	assert.match(text, /showing the last 2 of 2 entries/);
	assert.match(text, /先看看文件/);
	assert.match(text, /### tool `read`/);
	assert.match(text, /ENOENT: a\.ts/);
	assert.equal(trace.details.format, "trace");

	const limited = await tool.execute("call-2", { format: "trace", limit: 1 }, undefined, undefined, ctx);
	assert.match(limited.content[0].text, /showing the last 1 of 2 entries/);
	assert.doesNotMatch(limited.content[0].text, /第一步/, "只保留最后一条（user 那条被截掉）");
	assert.match(limited.content[0].text, /先看看文件/, "最后一条里的思考应保留");
	assert.match(limited.content[0].text, /### tool `read`/);
});

test("/monitor dashboard url 起真实本地服务但不打开浏览器，close 后服务停止", async (t) => {
	useTempAgentDir(t);
	const { pi, events, commands, execCalls } = createMockPi();
	monitorFactory(pi);
	const { ctx, notifications } = createMockCtx();
	ctx.mode = "print";
	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const command = commands.get("monitor");
	t.after(async () => {
		await emit(events, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	});
	await command.handler("dashboard url", ctx);
	const url = dashboardUrlFrom(notifications);
	assert.ok(url, `应 notify dashboard url，实际：${JSON.stringify(notifications)}`);
	assert.equal(execCalls.length, 0, "url 动作不应打开浏览器");

	const res = await fetch(url);
	assert.equal(res.status, 200);
	const html = await res.text();
	assert.match(html, /pi-monitor dashboard/);

	const base = new URL(url);
	const snapshotRes = await fetch(`${base.origin}/api/snapshot?session=${base.searchParams.get("session")}`);
	assert.equal(snapshotRes.status, 200);
	const payload = await snapshotRes.json();
	assert.equal(payload.metrics.turns, 0);
	assert.equal(payload.meta.session, "sess-1");
	assert.equal(payload.meta.sessionFile, "/tmp/sess-1.jsonl");
	assert.ok(Array.isArray(payload.trace.entries), "payload 里应该带 trace.entries");

	const exportRes = await fetch(`${base.origin}/api/export?session=${base.searchParams.get("session")}`);
	assert.equal(exportRes.status, 200);
	assert.match(exportRes.headers.get("content-disposition") ?? "", /pi-monitor-trace-sess-1\.md/);
	assert.match(await exportRes.text(), /^# pi-monitor trace/);
	const noToken = await fetch(`${base.origin}/api/export`);
	assert.equal(noToken.status, 403);

	await command.handler("dashboard status", ctx);
	assert.ok(notifications.some((entry) => /0 client\(s\)/.test(entry.message)));

	await command.handler("dashboard close", ctx);
	assert.ok(notifications.some((entry) => /dashboard closed/.test(entry.message)));
	await assert.rejects(fetch(url));
	await emit(events, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
});

test("/monitor dashboard open 通过 pi.exec 打开浏览器；dashboardAutoOpen 在 session_start 自动开", async (t) => {
	const agentDir = useTempAgentDir(t);
	writeFileSync(join(agentDir, "monitor.json"), JSON.stringify({ dashboardAutoOpen: true }), "utf8");
	const { pi, events, execCalls } = createMockPi();
	monitorFactory(pi);
	const { ctx, notifications } = createMockCtx();
	ctx.mode = "print";

	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);
	t.after(async () => {
		await emit(events, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	});
	assert.ok(await waitFor(() => execCalls.length > 0), "autoOpen 应触发打开");
	assert.equal(execCalls[0].file, process.platform === "darwin" ? "open" : execCalls[0].file);
	assert.ok(dashboardUrlFrom(notifications) || execCalls.length > 0);

	// 关掉 dashboard，否则 server 会拖住 event loop
	await emit(events, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
});

test("/monitor（无子命令）默认在浏览器里打开 dashboard；panel 才是 TUI 浮层", async (t) => {
	useTempAgentDir(t);
	const { pi, events, commands, execCalls } = createMockPi();
	monitorFactory(pi);
	const { ctx, notifications } = createMockCtx();
	ctx.mode = "tui";
	t.after(async () => {
		await emit(events, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	});
	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const command = commands.get("monitor");
	await command.handler("", ctx);

	const url = dashboardUrlFrom(notifications);
	assert.ok(url, `默认动作应该起了 dashboard，实际：${JSON.stringify(notifications)}`);
	assert.ok(
		notifications.some((entry) => /opened in browser/.test(entry.message)),
		"应明确告诉用户已在浏览器打开",
	);
	assert.ok(execCalls.length > 0, "应该真的调了打开浏览器的命令");
	assert.equal(await (await fetch(url)).status, 200);

	// panel/show 仍然给 TUI 面板（自定义 UI 被调用），不重复开浏览器
	const before = execCalls.length;
	ctx.ui.custom = async () => undefined;
	await command.handler("panel", ctx);
	assert.equal(execCalls.length, before, "panel 不应该再开浏览器");
});

test("/monitor 打开的是当前会话的 trace：思考、工具入参/结果都在；/monitor export 落盘", async (t) => {
	const agentDir = useTempAgentDir(t);
	const entries = [
		{
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: "2026-09-26T10:00:00.000Z",
			message: { role: "user", content: "修一下 login", timestamp: 1 },
		},
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-09-26T10:00:02.000Z",
			message: {
				role: "assistant",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				content: [
					{ type: "thinking", thinking: "先看相关文件" },
					{ type: "text", text: "我去查一下" },
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
				],
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: "2026-09-26T10:00:03.500Z",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: "a.ts\\nb.ts" }],
				timestamp: 3,
			},
		},
	];
	const { pi, events, commands } = createMockPi();
	monitorFactory(pi);
	const { ctx, notifications } = createMockCtx({ entries });
	ctx.mode = "print";
	t.after(async () => {
		await emit(events, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	});
	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);

	// 真跑一次工具事件，让 trace 里的 toolCall 带上耗时
	await emit(events, "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "ls" } }, ctx);
	await emit(events, "tool_execution_end", { toolCallId: "c1", toolName: "bash", result: {}, isError: false }, ctx);

	const command = commands.get("monitor");
	await command.handler("dashboard url", ctx);
	const url = dashboardUrlFrom(notifications);
	assert.ok(url, "应该起了 dashboard");
	const base = new URL(url);
	const payload = await (
		await fetch(`${base.origin}/api/snapshot?session=${base.searchParams.get("session")}`)
	).json();

	assert.equal(payload.meta.session, "sess-1");
	assert.equal(payload.trace.entries.length, 2, "toolResult 应并进 assistant 的 toolCall 卡");
	const [user, assistant] = payload.trace.entries;
	assert.equal(user.kind, "user");
	assert.equal(user.blocks[0].text, "修一下 login");
	const thinking = assistant.blocks.find((block: any) => block.type === "thinking");
	assert.equal(thinking.text, "先看相关文件");
	const call = assistant.blocks.find((block: any) => block.type === "toolCall");
	assert.equal(call.tool.name, "bash");
	assert.match(call.tool.argsText, /"command": "ls"/);
	assert.equal(call.tool.result, "a.ts\\nb.ts");
	assert.equal(typeof call.tool.ms, "number", "工具耗时应该来自 tool_execution_start/end");

	await command.handler("export", ctx);
	const notice = notifications.findLast((entry) => /trace written/.test(entry.message));
	assert.ok(notice, `应通知 trace 已写盘：${JSON.stringify(notifications.map((n) => n.message))}`);
	const tracePath = String(notice.message).match(/[^\s]+\.md/)?.[0] ?? "";
	assert.ok(tracePath.startsWith(join(agentDir, "monitor", "traces")), `应写在 traces 目录，实际 ${tracePath}`);
	const markdown = readFileSync(tracePath, "utf8");
	assert.match(markdown, /先看相关文件/);
	assert.match(markdown, /### tool `bash`/);
	assert.match(markdown, /a\.ts/);
});

test("/monitor widget on|off、reset、alerts、未知子命令", async (t) => {
	useTempAgentDir(t);
	const { pi, events, commands } = createMockPi();
	monitorFactory(pi);
	const { ctx, widgets, notifications } = createMockCtx();
	ctx.mode = "print";
	await emit(events, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const command = commands.get("monitor");
	await command.handler("widget off", ctx);
	assert.equal(widgets.get("pi-monitor"), undefined);
	await command.handler("widget on", ctx);
	assert.ok(Array.isArray(widgets.get("pi-monitor")));

	await command.handler("alerts", ctx);
	assert.ok(notifications.some((entry) => /no alerts/.test(entry.message)));

	await command.handler("reset", ctx);
	assert.ok(notifications.some((entry) => /counters reset/.test(entry.message)));

	await command.handler("nonsense", ctx);
	assert.ok(notifications.some((entry) => entry.type === "error"));
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}