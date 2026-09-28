/**
 * pi-monitor dashboard 服务端（~/.pi/agent/packages/pi-monitor/extensions/monitor/dashboard.ts）的集成测试。
 *
 * 真起一个 listen(0) 的本地 server，用真 HTTP 请求验证：鉴权、SSE 推送、reset/close、
 * 空闲自动关闭、大 body 拒绝。不 mock http。
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { renderDashboardHtml, startDashboardServer } from "../../../.pi/agent/packages/pi-monitor/extensions/monitor/dashboard.ts";

/**
 * 把页面里内联的 <script> 抽出来（renderDashboardHtml 已经把 token / title 插进去了）。
 * 页面脚本是写在 TS 模板字面量里的，`\"` 这类转义会被模板字面量吃掉，
 * 所以必须真解析一遍才能发现「页面白屏」这类事故（冒烟时就是这么抓到一次）。
 */
function pageScript(html: string): string {
	const start = html.indexOf("<script>");
	const end = html.lastIndexOf("</script>");
	assert.ok(start >= 0 && end > start, "页面里应该有内联 script");
	const body = html.slice(start + "<script>".length, end);
	assert.doesNotMatch(body, /\$\{/, "不该残留模板占位符");
	return body;
}

async function start(t: TestContext, overrides: Record<string, unknown> = {}) {
	let payload: Record<string, unknown> = { snapshot: { turns: 1, toolCalls: 2, tokens: { costUsd: 0.01 } }, meta: {} };
	const handle = await startDashboardServer({
		title: "pi-monitor dashboard",
		token: "test-token",
		idleTimeoutMs: 60_000,
		watchdogMs: 50,
		getPayload: () => payload,
		...overrides,
	});
	t.after(() => handle.close());
	return {
		handle,
		setPayload: (next: Record<string, unknown>) => {
			payload = next;
		},
	};
}

async function poll(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

/** 从 SSE 流里读到包含给定子串的内容（可能跨多个 chunk）。 */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, timeoutMs = 2000) {
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !text.includes(needle)) {
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	return text;
}

test("GET / 需要 token：无 token 403，带 token 返回 HTML 页面", async (t) => {
	const { handle } = await start(t);

	const denied = await fetch(handle.url.replace("/?session=test-token", "/") + "?session=wrong");
	assert.equal(denied.status, 403);

	const ok = await fetch(handle.url);
	assert.equal(ok.status, 200);
	assert.match(ok.headers.get("content-type") ?? "", /text\/html/);
	const html = await ok.text();
	assert.match(html, /pi-monitor dashboard/);
	assert.match(html, /EventSource/);
	assert.match(html, /"test-token"/);
});

test("renderDashboardHtml 转义标题，避免注入", () => {
	const html = renderDashboardHtml("<img src=x onerror=alert(1)>", "tok");
	assert.doesNotMatch(html, /<img src=x/);
	assert.match(html, /&lt;img src=x/);
});

test("页面内联脚本能被解析（模板字面量吃掉转义 = 白屏，这道守卫必须拦住）", () => {
	const html = renderDashboardHtml("pi-monitor dashboard", "tok-'quote");
	const body = pageScript(html);
	assert.doesNotThrow(() => new Function(body), "页面脚本必须能编译");
	assert.match(body, /test-token|tok-'quote/);
	assert.match(body, /new EventSource/);
	assert.match(body, /\/api\/export\?session=/);
});

/** 从页面脚本里抠出一个顶层 function 的源码（用来在 node 里单独跑它测行为）。 */
function pageFunction(html: string, name: string): string {
	const body = pageScript(html);
	const start = body.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `页面里应该有 function ${name}`);
	const end = body.indexOf("\n}\n", start);
	assert.ok(end > start, `找不到 function ${name} 的结尾`);
	return body.slice(start, end + 2);
}

/**
 * 页面是「按条目签名复用 DOM、只重建变化的尾巴」的，签名漏掉任一可变字段
 * （尤其是流式补齐的工具结果）都会让页面上永远看不到那次变化 —— 这里真把函数跑起来测。
 */
test("entrySig：流式补齐的工具结果/文本/用量一变，签名就必须变（否则页面不重建）", () => {
	const src = pageFunction(renderDashboardHtml("d", "tok"), "entrySig");
	const entrySig = new Function(`${src}; return entrySig;`)() as (entry: unknown) => string;
	const base = {
		seq: 3,
		kind: "assistant",
		ts: 1,
		deltaMs: 10,
		detail: "",
		stopReason: "toolUse",
		usage: { input: 1, output: 2, costUsd: 0.01, cacheRead: 0, cacheWrite: 0 },
		blocks: [{ type: "toolCall", tool: { name: "bash", callId: "c1", argsText: "{}", ms: null, result: undefined } }],
	};
	const clone = (patch: Record<string, unknown>) => JSON.parse(JSON.stringify({ ...base, ...patch }));
	const sig = (entry: unknown) => entrySig(entry);

	assert.equal(sig(base), sig(clone({})), "同一条目必须同签名（否则每 400ms 白重建）");
	assert.notEqual(sig(base), sig(clone({ seq: 4 })));
	assert.notEqual(sig(base), sig(clone({ detail: "boom", isError: true })));

	const withResult = clone({});
	withResult.blocks[0].tool.result = "x".repeat(10);
	assert.notEqual(sig(base), sig(withResult), "工具结果回来了必须重建");
	const longerResult = clone({});
	longerResult.blocks[0].tool.result = "x".repeat(99);
	assert.notEqual(sig(withResult), sig(longerResult), "结果变长也要重建");

	const withMs = clone({});
	withMs.blocks[0].tool.ms = 1500;
	assert.notEqual(sig(base), sig(withMs), "工具耗时填上了要重建");

	const withText = clone({ blocks: [{ type: "text", text: "hi" }] });
	const withText2 = clone({ blocks: [{ type: "text", text: "hii" }] });
	assert.notEqual(sig(withText), sig(withText2));

	const usage2 = clone({});
	usage2.usage.output = 999;
	assert.notEqual(sig(base), sig(usage2));
});

/**
 * 把页面里的分组/过滤逻辑抠出来在 node 里真跑：
 * 「只勾 tools」必须能看到带 read/write/bash 的 assistant 条目（工具卡就在那条里），
 * 而不是像以前那样一条不剩 —— 以前 tool 分组只匹配「无主的 toolResult」。
 */
test("页面脚本里的反斜杠不能被模板字面量吃掉（曾经把 /\\s+/g 变成 /s+/g，静默把文本里的 s 吃了）", () => {
	const html = renderDashboardHtml("d", "tok");
	const make = new Function(pageFunction(html, "preview") + "\nreturn preview;");
	const preview = make();
	// 行为层：文本里的连续 s 不能被换掉
	assert.equal(preview({ blocks: [{ type: "text", text: "pass 8 · success  \"s\"" }] }), "pass 8 · success \"s\"");
	assert.equal(preview({ blocks: [{ type: "text", text: "ssss" }] }), "ssss");
	// 结构层：转义后的正则确实原样到达页面
	const body = pageScript(html);
	assert.ok(body.includes("replace(/\\s+/g"), "preview 里的 /\\s+/g 必须原样到达页面");
	assert.ok(!body.includes("replace(/s+/g"), "不能被吃成 /s+/g");
});

test("「Errors only」切换：一次进只看错，再一次恢复全部（含 errors 自身）", () => {
	const html = renderDashboardHtml("d", "tok");
	const all = { errors: true, user: true, assistant: true, tool: true, compaction: true, other: true };
	const make = new Function(
		"var GROUPS = [[\"errors\",\"errors\"],[\"user\",\"user\"],[\"assistant\",\"assistant\"],[\"tool\",\"tools\"],[\"compaction\",\"compaction\"],[\"other\",\"other\"]];\n" +
			pageFunction(html, "isErrOnly") + "\n" + pageFunction(html, "errOnlyTarget") +
			"\nreturn { isErrOnly: isErrOnly, errOnlyTarget: errOnlyTarget };",
	);
	const api = make();
	assert.equal(api.isErrOnly(all), false, "全都开着不算只看错");
	assert.deepEqual(api.errOnlyTarget(all), { errors: true, user: false, assistant: false, tool: false, compaction: false, other: false });
	const only = api.errOnlyTarget(all);
	assert.equal(api.isErrOnly(only), true);
	assert.deepEqual(api.errOnlyTarget(only), all, "再点一下必须恢复全部（errors 也要开，否则会变成全空）");
	// 用户手动把其它组全关掉时，按钮也要亮着
	assert.equal(api.isErrOnly({ errors: true, user: false, assistant: false, tool: false, compaction: false, other: false }), true);
});

test("页面里的错误摘要（errSummary）与 trace 侧同规则：丢掉 (no output)、保留超时", () => {
	const html = renderDashboardHtml("d", "tok");
	const errSummary = new Function(pageFunction(html, "errSummary") + "\nreturn errSummary;")();
	assert.equal(errSummary("(no output)\n\nCommand exited with code 1"), "Command exited with code 1");
	assert.equal(errSummary("== A ==\nℹ pass 8\n\nCommand timed out after 300 seconds"), "== A == · ℹ pass 8 · Command timed out after 300 seconds");
	assert.equal(errSummary(""), "(no output)");
});

test("只勾 errors：能筛出工具报错/模型报错的条目，且行上有红色标记", () => {
	const html = renderDashboardHtml("d", "tok");
	const src = [pageFunction(html, "group"), pageFunction(html, "groupsOf"), pageFunction(html, "matches")].join("\n");
	const make = new Function(
		"var GROUPS = [[\"errors\",\"errors\"],[\"user\",\"user\"],[\"assistant\",\"assistant\"],[\"tool\",\"tools\"]]; var active = {}; var query = \"\";\n" +
			src +
			"\nreturn { matches: matches, groupsOf: groupsOf, setActive: function (a) { active = a; }, setQuery: function (q) { query = q; } };",
	);
	const api = make();
	const failedTool = { kind: "assistant", title: "a", toolErrorCount: 1, toolErrorSample: "ENOENT", blocks: [{ type: "toolCall", tool: { name: "read", argsText: "{}", result: "ENOENT", isError: true } }] };
	const okTool = { kind: "assistant", title: "a", blocks: [{ type: "toolCall", tool: { name: "read", argsText: "{}", result: "ok" } }] };
	const modelError = { kind: "assistant", title: "a", isError: true, detail: "context length exceeded", blocks: [{ type: "text", text: "..." }] };
	assert.deepEqual(api.groupsOf(failedTool), ["assistant", "tool", "errors"]);

	api.setActive({ errors: true, user: false, assistant: false, tool: false });
	assert.equal(api.matches(failedTool), true, "工具报错的条目要能筛出来");
	assert.equal(api.matches(modelError), true, "模型报错也要能筛出来");
	assert.equal(api.matches(okTool), false, "正常的工具调用不算错误");

	// 行上的标记：toolerr 类 + 红色 pill + 错误首行
	const body = pageScript(html);
	assert.match(body, /entry\.toolErrorCount \? " toolerr" : ""/);
	assert.match(body, /class="pill err-pill"/);
	assert.match(body, /if \(entry\.toolErrorSample\) return "✗ " \+ entry\.toolErrorSample/);
	assert.match(body, /class="err-msg"/);
	assert.match(html, /\.entry\.toolerr \{ border-left-color: var\(--err\)/);
});

test("只勾 tools：能筛出带工具调用的 assistant 条目", () => {
	const html = renderDashboardHtml("d", "tok");
	const src = [pageFunction(html, "group"), pageFunction(html, "groupsOf"), pageFunction(html, "matches")].join("\n");
	const make = new Function(
		"var GROUPS = [[\"user\",\"user\"],[\"assistant\",\"assistant\"],[\"tool\",\"tools\"]]; var active = {}; var query = \"\";\n" +
			src +
			"\nreturn { matches: matches, groupsOf: groupsOf, setActive: function (a) { active = a; }, setQuery: function (q) { query = q; } };",
	);
	const api = make();
	const toolCall = { type: "toolCall", tool: { name: "bash", argsText: "{}", result: "" } };
	const withTool = { kind: "assistant", title: "a", blocks: [{ type: "thinking", text: "x" }, toolCall] };
	const withoutTool = { kind: "assistant", title: "a", blocks: [{ type: "text", text: "hi" }] };
	const user = { kind: "user", title: "u", blocks: [{ type: "text", text: "hi" }] };
	const orphanTool = { kind: "tool", title: "t", blocks: [{ type: "toolCall", tool: { name: "read", argsText: "{}" } }] };

	assert.deepEqual(api.groupsOf(withTool), ["assistant", "tool"]);
	assert.deepEqual(api.groupsOf(withoutTool), ["assistant"]);
	assert.deepEqual(api.groupsOf(orphanTool), ["tool"]);

	api.setActive({ user: false, assistant: false, tool: true });
	assert.equal(api.matches(withTool), true, "带工具的 assistant 必须选得出来");
	assert.equal(api.matches(orphanTool), true);
	assert.equal(api.matches(withoutTool), false);
	assert.equal(api.matches(user), false);

	api.setActive({ user: false, assistant: true, tool: false });
	assert.equal(api.matches(withTool), true, "只看 assistant 时带工具的那条也在");
	assert.equal(api.matches(withoutTool), true);
	assert.equal(api.matches(orphanTool), false);

	api.setActive({ user: true, assistant: true, tool: true });
	api.setQuery("bash");
	assert.equal(api.matches(withTool), true, "搜索仍然能命中工具名");
	assert.equal(api.matches(withoutTool), false);

	// 空结果时要告诉用户当前勾了哪些组，别让人以为「什么都没有」是 bug
	assert.match(pageScript(html), /no entries match — filters on:/);
});

test("重建计数时页面要标明 restored（不然用户以为这些数就是本次运行的）", () => {
	const html = renderDashboardHtml("d", "tok");
	assert.match(html, /title="counters were rebuilt from this session history/);
	assert.match(pageScript(html), /if \(metrics\.restored\)/);
});

test("长会话不会每次都全量重绘：条目按签名复用 DOM，只重建变化的部分", () => {
	const html = renderDashboardHtml("d", "tok");
	const body = pageScript(html);
	assert.match(body, /function entrySig\(entry\)/);
	assert.match(body, /var sigList = \[\], nodeList = \[\]/);
	assert.match(body, /sigList\[keep\] === entrySig\(shown\[keep\]\)/);
	assert.match(body, /sigList\.length = Math\.min\(sigList\.length, keep\)/);
	// 过滤条件/全展开变了就不复用（签名里没包含折叠状态）
	assert.match(body, /key === filterKey/);
	assert.match(body, /GROUPS\.map\(function \(g\) \{ return active\[g\[0\]\] \? "1" : "0"; \}\)/);
	// 服务端先渲染了 loading 占位符，脚本必须接管它，否则增量渲染会把它永远留在列表顶上
	assert.match(html, /<main id="list"><div class="empty">loading…<\/div><\/main>/);
	assert.match(body, /document\.querySelector\("#list > \.empty"\)/);
});

test("默认全部折叠：条目/思考/入参/结果都要初始收起，且状态存在 JS 里（流式重绘不丢）", () => {
	const body = pageScript(renderDashboardHtml("d", "tok"));
	assert.match(body, /openBlocks = \{\}/);
	assert.match(body, /openEntries = \{\}/);
	assert.match(body, /data-key="' \+ key \+ '"/);
	assert.match(body, /openBlocks\[key\] = wasCollapsed/);
	assert.match(body, /openEntries\[seq\] = !article\.classList\.contains\("collapsed"\)/);
	// 默认值不能来自 DOM class，必须由 JS 状态与 expandAll 决定
	assert.match(body, /var open = expandAll \|\| openEntries\[entry\.seq\] === true/);
	assert.match(body, /var open = expandAll \|\| openBlocks\[key\] === true/);
	assert.match(body, /var openArgs = expandAll \|\| openBlocks\[key \+ ":args"\] === true/);
	assert.match(body, /var openResult = expandAll \|\| openBlocks\[key\] === true/);
	assert.match(body, /\(body && !open \? " collapsed" : ""\)/);
	// 折叠行要有一行摘要，否则全折叠后什么都看不到
	assert.match(body, /function preview\(entry\)/);
	assert.match(body, /class="prev"/);
});

test("折叠的 thinking / 长结果 / raw 真的会被 CSS 隐掉", () => {
	const html = renderDashboardHtml("d", "tok");
	assert.match(html, /\.blk\.thinking\.collapsed pre \{ display: none; \}/);
	assert.match(html, /\.sect\.collapsed pre \{ display: none; \}/);
	// .body 自己声明了 display:grid，会压过 UA 的 [hidden]，没有这条就会把 raw JSON 永远露出来
	assert.match(html, /\.body\[hidden\] \{ display: none; \}/);
	// 条目收起时不能连带把 raw 也隐掉（raw 有自己的 hidden 开关）
	assert.match(html, /\.entry\.collapsed > \.body:not\(\.raw\) \{ display: none; \}/);
});

test("dashboard 页面不会把宿主给的原始浮点百分比直接渲染出来", () => {
	const html = renderDashboardHtml("pi-monitor", "tok");
	assert.match(html, /function fmtPercent\(/);
	assert.match(html, /fmtPercent\(metrics\.contextPercent\)/);
	assert.doesNotMatch(html, /contextPercent \+ "%"/);
});

test("GET /api/snapshot 返回当前 payload；token 错则 403", async (t) => {
	const { handle, setPayload } = await start(t);
	setPayload({ snapshot: { turns: 7 }, meta: { session: "s1" } });

	const res = await fetch(`${handle.url.replace("/?session=test-token", "")}/api/snapshot?session=test-token`);
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.snapshot.turns, 7);
	assert.equal(body.meta.session, "s1");

	const bad = await fetch(`${handle.url.replace("/?session=test-token", "")}/api/snapshot?session=nope`);
	assert.equal(bad.status, 403);
});

test("GET /events 是 SSE：先发当前快照，broadcast 后再推新快照", async (t) => {
	const { handle, setPayload } = await start(t);
	const base = handle.url.replace("/?session=test-token", "");

	const res = await fetch(`${base}/events?session=test-token`);
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
	assert.ok(res.body);
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();

	const initial = await readUntil(reader, "event: snapshot");
	assert.match(initial, /event: snapshot/);
	assert.match(initial, /"turns":1/);
	assert.equal(handle.clientCount(), 1);
	assert.equal(handle.connected, true);

	setPayload({ snapshot: { turns: 42 }, meta: {} });
	handle.broadcast();
	const updated = await readUntil(reader, '"turns":42');
	assert.match(updated, /"turns":42/);

	// 传进来的 JSON 直接广播，不再去调 getPayload（扩展侧已经算过一次指纹 + 序列化）
	handle.broadcast('{"precomputed":true}');
	const pre = await readUntil(reader, 'precomputed');
	assert.match(pre, /"precomputed":true/);

	await reader.cancel();
	await poll(() => handle.clientCount() === 0);
	assert.equal(handle.connected, false);
});

test("POST /api/reset 调 onReset 并广播；token 错 403；未知端点 404", async (t) => {
	let resets = 0;
	const { handle, setPayload } = await start(t, { onReset: () => { resets += 1; } });
	const base = handle.url.replace("/?session=test-token", "");

	setPayload({ snapshot: { turns: 99 }, meta: {} });
	const res = await fetch(`${base}/api/reset`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-monitor-token": "test-token" },
		body: "{}",
	});
	assert.equal(res.status, 200);
	assert.equal(resets, 1);

	const bad = await fetch(`${base}/api/reset`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-monitor-token": "wrong" },
		body: "{}",
	});
	assert.equal(bad.status, 403);

	const missing = await fetch(`${base}/api/nope`, {
		method: "POST",
		headers: { "x-monitor-token": "test-token" },
		body: "{}",
	});
	assert.equal(missing.status, 404);

	const notFound = await fetch(`${base}/whatever`);
	assert.equal(notFound.status, 404);
});

test("POST /api/close 关闭服务", async (t) => {
	const { handle } = await start(t);
	const base = handle.url.replace("/?session=test-token", "");

	const res = await fetch(`${base}/api/close`, {
		method: "POST",
		headers: { "x-monitor-token": "test-token" },
		body: "{}",
	});
	assert.equal(res.status, 200);
	assert.ok(await poll(() => handle.server.listening === false));
});

test("超过 64KB 的 body 被拒（413）", async (t) => {
	const { handle } = await start(t);
	const base = handle.url.replace("/?session=test-token", "");
	const huge = JSON.stringify({ pad: "x".repeat(70 * 1024) });

	const res = await fetch(`${base}/api/heartbeat`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-monitor-token": "test-token" },
		body: huge,
	});
	assert.equal(res.status, 413);
});

test("长时间没有浏览器连接时自动关闭（idle 超时）", async (t) => {
	const handle = await startDashboardServer({
		title: "pi-monitor dashboard",
		token: "test-token",
		idleTimeoutMs: 20,
		watchdogMs: 10,
		getPayload: () => ({ snapshot: {}, meta: {} }),
	});
	t.after(() => handle.close());
	assert.ok(await poll(() => handle.server.listening === false, 1500), "idle 超时后 server 应已 close");
});

test("有 SSE 客户端时不会被 idle 超时误关", async (t) => {
	const { handle } = await start(t, { idleTimeoutMs: 20, watchdogMs: 10 });
	const base = handle.url.replace("/?session=test-token", "");
	const res = await fetch(`${base}/events?session=test-token`);
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	await readUntil(reader, "event: snapshot");

	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(handle.server.listening, true, "有客户端连接时不应自动关");
	await reader.cancel();
});