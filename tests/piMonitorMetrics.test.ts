/**
 * pi-monitor 纯逻辑层（~/.pi/agent/packages/pi-monitor/extensions/monitor/metrics.ts）的行为测试。
 *
 * 被测源码在 agent 级的 package 目录（用户要求放 ~/.pi/agent），所以用相对路径 
 * → ../../../.pi/agent/packages/pi-monitor/，本机之外跑这些用例需要有那个目录。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	buildJsonReport,
	buildMarkdownReport,
	buildPanelLines,
	buildStatusText,
	buildWidgetLines,
	DEFAULT_CONFIG,
	DEFAULT_RULES,
	evaluateRules,
	firstBlockingMatch,
	formatCost,
	formatDuration,
	formatPercent,
	formatTokens,
	parseMonitorConfig,
	redactSecrets,
	resolveRuleRegex,
	sanitizeForLog,
	SessionMonitor,
	thresholdBreaches,
	toolCallText,
	truncateForLog,
} from "../../../.pi/agent/packages/pi-monitor/extensions/monitor/metrics.ts";

// ---------------------------------------------------------------------------
// 指标状态机
// ---------------------------------------------------------------------------

test("SessionMonitor 累计 turn、工具调用、错误与耗时", () => {
	const monitor = new SessionMonitor(1_000);
	monitor.startTurn(1_000);
	monitor.beginTool("t1", "bash", 1_000);
	monitor.endTool("t1", false, 1_350);
	monitor.beginTool("t2", "read", 1_400);
	monitor.endTool("t2", false, 1_500);
	monitor.beginTool("t3", "bash", 1_600);
	monitor.endTool("t3", true, 2_100);
	monitor.endTurn("completed", 2_200);

	const snap = monitor.snapshot(2_200);
	assert.equal(snap.turns, 1);
	assert.equal(snap.toolCalls, 3);
	assert.equal(snap.toolErrors, 1);
	assert.equal(snap.lastOutcome, "completed");
	assert.equal(snap.elapsedMs, 1_200);

	const bash = snap.tools.find((tool) => tool.name === "bash");
	assert.deepEqual(bash, { name: "bash", calls: 2, errors: 1, totalMs: 850, maxMs: 500 });
	assert.equal(snap.lastTool?.name, "bash");
	assert.equal(snap.lastTool?.error, true);
	assert.equal(snap.lastTool?.ms, 500);
});

test("工具按总耗时降序排列，同一工具的 call/error 独立累计", () => {
	const monitor = new SessionMonitor(0);
	monitor.beginTool("a", "grep", 0);
	monitor.endTool("a", false, 100);
	monitor.beginTool("b", "bash", 0);
	monitor.endTool("b", false, 5_000);
	monitor.beginTool("c", "grep", 0);
	monitor.endTool("c", true, 3_000);

	const snap = monitor.snapshot(6_000);
	assert.deepEqual(
		snap.tools.map((tool) => tool.name),
		["bash", "grep"],
	);
	const grep = snap.tools.find((tool) => tool.name === "grep");
	assert.equal(grep?.calls, 2);
	assert.equal(grep?.errors, 1);
	assert.equal(grep?.totalMs, 3_100);
	assert.equal(grep?.maxMs, 3_000);
});

test("未闭合的工具调用不会污染统计，endTool 回退为 unknown", () => {
	const monitor = new SessionMonitor(0);
	monitor.beginTool("open", "read", 0);
	const last = monitor.endTool("missing", false, 500);
	assert.equal(last.name, "unknown");
	assert.equal(last.ms, 0);
	assert.equal(monitor.toolCalls, 1);
});

test("addUsage 累加 token 与成本，忽略空值和 NaN", () => {
	const monitor = new SessionMonitor(0);
	monitor.addUsage({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.001 } });
	monitor.addUsage(undefined);
	monitor.addUsage({ input: Number.NaN, output: 1, cost: { total: 0.002 } });

	const snap = monitor.snapshot(0);
	assert.deepEqual(snap.tokens, { input: 100, output: 51, cacheRead: 10, cacheWrite: 5, costUsd: 0.003 });
});

test("provider 状态码区分 429 限流与其它错误", () => {
	const monitor = new SessionMonitor(0);
	monitor.recordProviderStatus(200, 0);
	monitor.recordProviderStatus(429, 0);
	monitor.recordProviderStatus(503, 0);
	const snap = monitor.snapshot(0);
	assert.equal(snap.rateLimits, 1);
	assert.equal(snap.providerErrors, 1);
	assert.equal(snap.alerts.length, 2);
	assert.ok(snap.alerts.some((alert) => alert.message.includes("429")));
	assert.ok(snap.alerts.some((alert) => alert.message.includes("503")));
});

test("alerts 只保留最近 50 条", () => {
	const monitor = new SessionMonitor(0);
	for (let i = 0; i < 60; i += 1) monitor.addAlert("info", `alert ${i}`, i);
	const snap = monitor.snapshot(60);
	assert.equal(snap.alerts.length, 50);
	assert.equal(snap.alerts[0].message, "alert 10");
});

test("recordBlocked 计入 blocked 并留下 warning 告警", () => {
	const monitor = new SessionMonitor(0);
	monitor.recordBlocked("rm-rf-root: blocked", 0);
	const snap = monitor.snapshot(0);
	assert.equal(snap.blocked, 1);
	assert.equal(snap.alerts.at(-1)?.level, "warning");
});

test("reset 清空全部计数但保留时间锚点语义", () => {
	const monitor = new SessionMonitor(0);
	monitor.startTurn(0);
	monitor.beginTool("t", "bash", 0);
	monitor.endTool("t", true, 10);
	monitor.addUsage({ input: 5, cost: { total: 1 } });
	monitor.recordBlocked("x", 0);

	monitor.reset(500);
	const snap = monitor.snapshot(500);
	assert.equal(snap.turns, 0);
	assert.equal(snap.toolCalls, 0);
	assert.equal(snap.toolErrors, 0);
	assert.equal(snap.blocked, 0);
	assert.equal(snap.tokens.costUsd, 0);
	assert.deepEqual(snap.tools, []);
	assert.equal(snap.elapsedMs, 0);
});

test("hydrate 从会话条目重建 turn、token 与工具计数（/resume 后不清零）", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: [] } },
		{ type: "message", message: { role: "assistant", usage: { input: 10, output: 20, cost: { total: 0.01 } } } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", isError: false } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", isError: true } },
		{ type: "message", message: { role: "assistant", usage: { input: 1, output: 2, cost: { total: 0.02 } } } },
		{ type: "custom", customType: "unrelated" },
	];
	const monitor = SessionMonitor.fromEntries(0, entries);
	const snap = monitor.snapshot(0);
	assert.equal(snap.turns, 2);
	assert.equal(snap.toolCalls, 2);
	assert.equal(snap.toolErrors, 1);
	assert.equal(snap.tokens.input, 11);
	assert.equal(snap.tokens.costUsd, 0.03);
	assert.equal(snap.tools[0].name, "bash");
	assert.equal(snap.tools[0].calls, 2);
	assert.equal(snap.tools[0].errors, 1);
});

// ---------------------------------------------------------------------------
// 重建（app 重启 / 新进程加载扩展后，不是只 resume）
// ---------------------------------------------------------------------------

test("hydrate 重建：turn/token/工具/压缩/模型报错/开始时间，且标记 restored", () => {
	const entries = [
		{ type: "session", timestamp: "2026-09-27T10:00:00.000Z" },
		{ type: "message", timestamp: "2026-09-27T10:00:01.000Z", message: { role: "user", content: "hi" } },
		{
			type: "message",
			timestamp: "2026-09-27T10:00:05.000Z",
			message: { role: "assistant", usage: { input: 10, output: 20, cost: { total: 0.01 } }, stopReason: "error", errorMessage: "context length exceeded" },
		},
		{ type: "compaction", timestamp: "2026-09-27T10:01:00.000Z", summary: "s", firstKeptEntryId: "x", tokensBefore: 1 },
	];
	const monitor = new SessionMonitor(Date.now());
	assert.equal(monitor.restored, false);
	monitor.hydrate(entries);
	const snap = monitor.snapshot(Date.parse("2026-09-27T10:10:00.000Z"));
	assert.equal(snap.restored, true, "页面要能看出这些数字是重建的");
	assert.equal(snap.turns, 1);
	assert.equal(snap.tokens.costUsd, 0.01);
	assert.equal(snap.compactions, 1);
	assert.equal(snap.startedAt, Date.parse("2026-09-27T10:00:00.000Z"), "开始时间取历史最早一条");
	assert.equal(snap.elapsedMs, 10 * 60 * 1000, "elapsed 按会话真实时长，不是进程启动时长");
	assert.ok(snap.alerts.some((alert) => /context length exceeded/.test(alert.message)), "历史里的模型报错要进 alerts");
});

test("hydrate 空历史不标 restored（新会话不该显示「重建」）", () => {
	const monitor = new SessionMonitor(1000);
	monitor.hydrate([]);
	const snap = monitor.snapshot(1000);
	assert.equal(snap.restored, false);
	assert.equal(snap.turns, 0);
	assert.equal(snap.startedAt, 1000);
});

test("审计日志 replay：补上条目里数不出来的计数，且不重复计工具调用", () => {
	const entries = [
		{ type: "message", timestamp: "2026-09-27T10:00:01.000Z", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0 } } } },
		{ type: "message", timestamp: "2026-09-27T10:00:02.000Z", message: { role: "toolResult", toolName: "bash", isError: false } },
	];
	const audit = [
		{ kind: "session_start", reason: "startup" },
		{ kind: "tool_end", tool: "bash", ms: 1200, error: false },
		{ kind: "tool_end", tool: "bash", ms: 300, error: false },
		{ kind: "blocked", tool: "bash", rule: "rm-rf-root" },
		{ kind: "blocked", tool: "bash", rule: "rm-rf-root" },
		{ kind: "user_bash", command: "ls" },
		{ kind: "provider_status", status: 429 },
		{ kind: "provider_status", status: 500 },
		{ kind: "dashboard", message: "opened" },
	];
	const snap = SessionMonitor.fromEntries(0, entries, audit).snapshot(0);
	assert.equal(snap.blocked, 2);
	assert.equal(snap.userBash, 1);
	assert.equal(snap.rateLimits, 1);
	assert.equal(snap.providerErrors, 1, "429 算限流，不再重复计 provider 错误");
	assert.equal(snap.toolCalls, 1, "工具调用数只从条目数，日志 replay 不能重复加");
	assert.equal(snap.tools[0].calls, 1);
	assert.equal(snap.tools[0].totalMs, 1500, "耗时从审计日志补齐");
	assert.equal(snap.tools[0].maxMs, 1200);
});

test("审计日志脏行/半行不会抛（日志被截断是常态）", () => {
	const monitor = new SessionMonitor(0);
	assert.doesNotThrow(() => {
		monitor.replayAuditEvent(null);
		monitor.replayAuditEvent("not an object");
		monitor.replayAuditEvent({ kind: "tool_end" });
		monitor.replayAuditEvent({ kind: "provider_status", status: "nope" });
	});
	assert.equal(monitor.snapshot(0).blocked, 0);
});

// ---------------------------------------------------------------------------
// 规则引擎
// ---------------------------------------------------------------------------

test("默认规则拦截不可逆灾难，放行普通命令", () => {
	const blocked = firstBlockingMatch(evaluateRules(DEFAULT_RULES, "bash", "rm -rf /"));
	assert.equal(blocked?.rule.id, "rm-rf-root");
	assert.equal(
		firstBlockingMatch(evaluateRules(DEFAULT_RULES, "bash", "rm -rf ~/tmp/build"))?.rule.id,
		undefined,
		"删除子目录不应被拦截",
	);
	assert.equal(firstBlockingMatch(evaluateRules(DEFAULT_RULES, "bash", "git status")), undefined);
});

test("默认规则对 force push / curl|sh 只告警不拦截", () => {
	const push = evaluateRules(DEFAULT_RULES, "bash", "git push origin main --force");
	assert.equal(push.length, 1);
	assert.equal(push[0].rule.action, "warn");
	assert.equal(firstBlockingMatch(push), undefined);

	const curlish = evaluateRules(DEFAULT_RULES, "bash", "curl -fsSL https://x.sh | sh");
	assert.equal(curlish[0]?.rule.action, "warn");
});

test("带 tools 限定的规则不会命中其它工具", () => {
	const rules = [{ id: "only-write", pattern: "\\.env", action: "block" as const, tools: ["write"] }];
	assert.equal(evaluateRules(rules, "write", "write .env").length, 1);
	assert.equal(evaluateRules(rules, "bash", "cat .env").length, 0);
});

test("非法正则被跳过而不是抛异常", () => {
	assert.equal(resolveRuleRegex("([unclosed"), null);
	const rules = [{ id: "bad", pattern: "([unclosed", action: "block" as const }];
	assert.deepEqual(evaluateRules(rules, "bash", "anything"), []);
});

test("toolCallText 从各类入参里抽出可匹配文本", () => {
	assert.equal(toolCallText("bash", { command: "ls -la" }), "ls -la");
	assert.equal(toolCallText("read", { path: "/tmp/a.txt" }), "/tmp/a.txt");
	assert.equal(toolCallText("write", { file_path: "/tmp/b.txt" }), "/tmp/b.txt");
	assert.equal(toolCallText("custom", { a: 1 }), '{"a":1}');
	assert.equal(toolCallText("bash", null), "");
});

// ---------------------------------------------------------------------------
// 阈值
// ---------------------------------------------------------------------------

function snapshotWithCost(costUsd: number) {
	const monitor = new SessionMonitor(0);
	monitor.addUsage({ cost: { total: costUsd } });
	return monitor.snapshot(0);
}

test("thresholdBreaches 只在超过预算时报，且能同时报多条", () => {
	const monitor = new SessionMonitor(0);
	monitor.beginTool("t", "bash", 0);
	monitor.endTool("t", true, 4_000);
	monitor.addUsage({ cost: { total: 0.05 } });

	const breaches = thresholdBreaches({ costUsd: 0.01, toolErrors: 1, toolCallMs: 3_000 }, monitor.snapshot(4_000));
	const keys = breaches.map((breach) => breach.key).sort();
	assert.deepEqual(keys, ["budget:cost", "budget:tool-errors", "slow:bash"]);
	assert.equal(breaches.find((breach) => breach.key === "budget:cost")?.level, "error");
});

test("thresholdBreaches 空预算不报，恰好等于阈值视为达到", () => {
	assert.deepEqual(thresholdBreaches({}, snapshotWithCost(100)), []);
	const breaches = thresholdBreaches({ costUsd: 0.01 }, snapshotWithCost(0.01));
	assert.equal(breaches.length, 1);
});

// ---------------------------------------------------------------------------
// 脱敏 / 截断
// ---------------------------------------------------------------------------

test("redactSecrets 抹掉常见密钥形态，保留普通文本", () => {
	assert.match(redactSecrets("export API_KEY=abcd1234efgh"), /\[REDACTED\]/);
	assert.doesNotMatch(redactSecrets("export API_KEY=abcd1234efgh"), /abcd1234efgh/);
	assert.doesNotMatch(redactSecrets("Authorization: Bearer abcdef123456"), /abcdef123456/);
	assert.doesNotMatch(redactSecrets("token=sk-abcdefghijklmnop"), /sk-abcdefghijklmnop/);
	assert.doesNotMatch(redactSecrets("ghp_abcdefghijklmnopqrstuvwx"), /ghp_abcdefghijklmnopqrstuvwx/);
	assert.doesNotMatch(redactSecrets("AKIAIOSFODNN7EXAMPLE"), /AKIAIOSFODNN7EXAMPLE/);
	assert.doesNotMatch(
		redactSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"),
		/eyJhbGciOiJIUzI1NiJ9/,
	);
	assert.equal(redactSecrets("npm run test"), "npm run test");
});

test("redactSecrets 抹掉 PEM 私钥块", () => {
	const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
	const redacted = redactSecrets(`key:\n${pem}\n`);
	assert.doesNotMatch(redacted, /MIIEowIBAAKCAQEA/);
	assert.match(redacted, /\[REDACTED\]/);
});

test("truncateForLog 截断并保留长度信息", () => {
	const long = "x".repeat(100);
	const truncated = truncateForLog(long, 10);
	assert.match(truncated, /^x{10}… \[truncated 90 chars\]$/);
	assert.equal(truncateForLog("short", 10), "short");
});

test("sanitizeForLog 先脱敏再截断", () => {
	const out = sanitizeForLog("API_KEY=supersecretvalue " + "y".repeat(50), 20);
	assert.doesNotMatch(out, /supersecretvalue/);
});

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

test("parseMonitorConfig 默认值：widget/log 开、dashboard 不自动开、内置规则、空预算", () => {
	const config = parseMonitorConfig(undefined);
	assert.equal(config.widget, DEFAULT_CONFIG.widget);
	assert.equal(config.log, DEFAULT_CONFIG.log);
	assert.equal(config.notifyOnBlock, true);
	assert.equal(config.dashboardAutoOpen, false);
	assert.equal(config.dashboardIdleMs, 180_000);
	assert.deepEqual(config.budget, {});
	assert.equal(config.rules.length, DEFAULT_RULES.length);
});

test("parseMonitorConfig 忽略类型不对的字段，不抛异常", () => {
	const config = parseMonitorConfig({
		widget: "yes",
		log: 1,
		notifyOnBlock: null,
		dashboardAutoOpen: "on",
		dashboardIdleMs: -3,
		budget: { costUsd: -5, toolErrors: "3", toolCallMs: 2000 },
	});
	assert.equal(config.widget, true);
	assert.equal(config.log, true);
	assert.equal(config.notifyOnBlock, true);
	assert.equal(config.dashboardAutoOpen, false);
	assert.equal(config.dashboardIdleMs, 180_000);
	assert.deepEqual(config.budget, { toolCallMs: 2000 });
});

test("parseMonitorConfig 支持 dashboardAutoOpen / dashboardIdleMs（含 0 = 不自动关）", () => {
	const config = parseMonitorConfig({ dashboardAutoOpen: true, dashboardIdleMs: 0 });
	assert.equal(config.dashboardAutoOpen, true);
	assert.equal(config.dashboardIdleMs, 0);
});

test("dashboardEmbedded 默认关：默认一律弹浏览器，内嵌窗口得显式开", () => {
	assert.equal(parseMonitorConfig({}).dashboardEmbedded, false);
	assert.equal(parseMonitorConfig({ dashboardEmbedded: true }).dashboardEmbedded, true);
	assert.equal(parseMonitorConfig({ dashboardEmbedded: "yes" }).dashboardEmbedded, false);
});

test("parseMonitorConfig 支持替换规则集，空数组等于关闭规则", () => {
	const custom = parseMonitorConfig({ rules: [{ id: "r", pattern: "danger", action: "block" }] });
	assert.equal(custom.rules.length, 1);
	assert.equal(custom.rules[0].id, "r");

	const disabled = parseMonitorConfig({ rules: [] });
	assert.deepEqual(disabled.rules, []);
});

test("parseMonitorConfig 丢弃结构不完整的规则", () => {
	const config = parseMonitorConfig({
		rules: [
			{ pattern: "ok", action: "warn" },
			{ pattern: "no-action" },
			{ action: "block" },
			{ pattern: "bad-action", action: "explode" },
			"not-an-object",
		],
	});
	assert.deepEqual(
		config.rules.map((rule) => rule.pattern),
		["ok"],
	);
	assert.equal(config.rules[0].id, "ok");
});

// ---------------------------------------------------------------------------
// 格式化 / 报告
// ---------------------------------------------------------------------------

test("formatDuration / formatTokens / formatCost 的边界", () => {
	assert.equal(formatDuration(0), "0ms");
	assert.equal(formatDuration(999), "999ms");
	assert.equal(formatDuration(1_500), "1.5s");
	assert.equal(formatDuration(60_000), "1m00s");
	assert.equal(formatDuration(3_723_000), "1h02m");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_500), "1.5k");
	assert.equal(formatTokens(2_500_000), "2.50M");
	assert.equal(formatCost(0), "$0");
	assert.equal(formatCost(0.00001), "<$0.0001");
	assert.equal(formatCost(0.01234), "$0.0123");
});

test("formatPercent 把宿主的原始浮点收拾成人能看的百分比", () => {
	assert.equal(formatPercent(55.816796874999994), "56%");
	assert.equal(formatPercent(7.25), "7.3%");
	assert.equal(formatPercent(0), "0%");
	assert.equal(formatPercent(100), "100%");
	assert.equal(formatPercent(140), "100%");
	assert.equal(formatPercent(-3), "0%");
	assert.equal(formatPercent(Number.NaN), "0%");
});

test("面板里的 ctx 不出现原始浮点", () => {
	const lines = buildPanelLines(new SessionMonitor(1).snapshot(), { model: "a/b", contextPercent: 55.816796874999994 });
	const modelLine = lines.find((line) => line.startsWith("model")) ?? "";
	assert.match(modelLine, /ctx 56%/);
	assert.doesNotMatch(modelLine, /55\.81679/);
});

test("状态栏与 widget 文本包含关键计数", () => {
	const monitor = new SessionMonitor(1_000);
	monitor.startTurn(1_000);
	monitor.beginTool("t", "bash", 1_000);
	monitor.endTool("t", true, 3_000);
	monitor.addUsage({ input: 2_000, output: 500, cost: { total: 0.02 } });
	const snap = monitor.snapshot(3_000);

	const status = buildStatusText(snap);
	assert.match(status, /2\.0s/);
	assert.match(status, /1 turns/);
	assert.match(status, /1 tools/);
	assert.match(status, /1 err/);
	assert.match(status, /\$0\.02/);

	const lines = buildWidgetLines(snap);
	assert.match(lines[0], /pi-monitor/);
	assert.match(lines[1], /cost \$0\.02/);
	assert.ok(lines.some((line) => line.startsWith("last: bash")));
});

test("面板与 Markdown 报告包含汇总表、工具明细和 dashboard 链接", () => {
	const monitor = new SessionMonitor(0);
	monitor.startTurn(0);
	monitor.beginTool("t", "bash", 0);
	monitor.endTool("t", true, 1_500);
	monitor.addUsage({ input: 100, output: 20, cost: { total: 0.004 } });
	const snap = monitor.snapshot(1_500);

	const panel = buildPanelLines(snap, {
		model: "anthropic/claude-sonnet-4-5",
		contextPercent: 7,
		dashboardUrl: "http://127.0.0.1:1234/?session=abc",
	}).join("\n");
	assert.match(panel, /anthropic\/claude-sonnet-4-5/);
	assert.match(panel, /slowest tools/);
	assert.match(panel, /bash/);
	assert.match(panel, /http:\/\/127\.0\.0\.1:1234/);

	const markdown = buildMarkdownReport(snap, {
		session: "s1",
		cwd: "/tmp/proj",
		dashboardUrl: "http://127.0.0.1:1234/?session=abc",
	});
	assert.match(markdown, /^# pi-monitor report/m);
	assert.match(markdown, /\| tool calls \| 1 \|/);
	assert.match(markdown, /\| bash \| 1 \| 1 \| 1\.5s \| 1\.5s \|/);
	assert.match(markdown, /- session: s1/);
	assert.match(markdown, /- dashboard: http:\/\/127\.0\.0\.1:1234/);

	const json = JSON.parse(buildJsonReport(snap));
	assert.equal(json.toolCalls, 1);
	assert.equal(json.toolErrors, 1);
});