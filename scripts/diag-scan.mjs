#!/usr/bin/env node
/**
 * diag-scan: 常驻探针日志的异常窗口扫描器（只读，不改任何行为）。
 *
 * 用法：
 *   node scripts/diag-scan.mjs                 # 全量
 *   node scripts/diag-scan.mjs --since=30m     # 最近 30 分钟（支持 s/m/h）
 *   node scripts/diag-scan.mjs --log=<path>    # 换日志文件
 *   node scripts/diag-scan.mjs --raw=<requestId前缀>
 *
 * 为什么需要它：卡顿不是百分百复现，靠"当场抓到"不现实。探针每 2 秒把
 * `client.perf.summary` 经服务端落盘，于是这份日志成为一个可持续采样的总体，
 * 由脚本来找窗口，而不是靠人记住几点几分。
 *
 * 三条判据（互相排斥不了，所以都报）：
 *   A 数据到了但没重画：窗口内 event.stream > 0，而 render.* / markdown.render == 0
 *   B 主线程被堵：fps 明显掉下来 / stalls.blockingMs、worstMs 大 / 有 worstScripts
 *   C 流式中拉 bootstrap：merge.streamingBootstrap 或 poll.bootstrap.start 出现
 *   D 客户端丢事件：stream.eventDropped > 0
 *   E 渲染形状异常：render.shape.ALARM.openThinkingAboveTool > 0（还在输出的推理块
 *     排在已经出现的工具卡前面）
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const logPath = argValue("log", join(homedir(), ".pi", "agent", "pi-desktop-runtime.ndjson"));
if (!existsSync(logPath)) {
  console.error(`找不到日志：${logPath}`);
  process.exit(1);
}

const parseSince = (text) => {
  const m = /^(\d+)([smh]?)$/.exec(text ?? "");
  if (!m) return null;
  const mult = { s: 1e3, m: 6e4, h: 36e5, "": 1e3 }[m[2]];
  return Number(m[1]) * mult;
};
const sinceMs = parseSince(argValue("since", null));
const cutoff = sinceMs ? Date.now() - sinceMs : null;

if (args.some((a) => a.startsWith("--raw"))) {
  const prefix = argValue("raw", "");
  const rows = readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.event === "wire" && String(r.requestId ?? "").startsWith(prefix));
  rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const r of rows) console.log(JSON.stringify(r));
  process.exit(0);
}

const rows = readFileSync(logPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && typeof r.timestamp === "string")
  .map((r) => ({ ...r, _t: Date.parse(r.timestamp) }))
  .filter((r) => Number.isFinite(r._t) && (cutoff === null || r._t >= cutoff));

const perf = rows.filter((r) => r.event === "client.perf.summary").sort((a, b) => a._t - b._t);
const prompts = rows.filter((r) => r.event === "prompt.start").sort((a, b) => a._t - b._t);

const num = (v) => (typeof v === "number" ? v : 0);
const counter = (details, matcher) =>
  (details?.counters ?? []).filter((c) => matcher(c.name)).reduce((sum, c) => sum + num(c.count), 0);
const counterList = (details, matcher) =>
  (details?.counters ?? [])
    .filter((c) => matcher(c.name))
    .map((c) => `${c.name}=${c.count}`)
    .join(" ");

console.log(`日志 ${logPath}`);
console.log(`记录 ${rows.length} 条（perf 窗口 ${perf.length} 个${cutoff ? `，${argValue("since", "")} 内` : "，全量"}）`);
if (!perf.length) {
  console.log("\n没有任何 client.perf.summary：探针没开（检查启动时是否带了 VITE_PI_DESKTOP_PERF=1 与 VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED=1，且窗口已刷新）。");
  process.exit(0);
}

/* ---- 逐窗口打分，找出"卡住形状"的窗口 ---- */
const renderRe = /^(render\.|markdown\.render|thread\.convertMessage)/;
const flagged = [];
for (const w of perf) {
  const d = w.details ?? {};
  const events = counter(d, (n) => n === "event.stream");
  const dropped = counter(d, (n) => n === "stream.eventDropped");
  const bootstrap = counter(d, (n) => n.startsWith("merge.streamingBootstrap") || n.startsWith("poll.bootstrap"));
  const renders = counter(d, renderRe);
  const alarm = counter(d, (n) => n.includes("ALARM"));
  const fps = num(d?.frames?.fps);
  const blocking = num(d?.stalls?.blockingMs);
  const worst = num(d?.stalls?.worstMs);
  const reasons = [];
  if (events > 0 && renders === 0) reasons.push("A 数据到了但没重画");
  if (fps > 0 && fps < 20) reasons.push("B 主线程几乎没帧");
  if (blocking >= 300 || worst >= 500) reasons.push("B 长任务/LoAF");
  if (bootstrap > 0) reasons.push("C 流式中拉 bootstrap");
  if (dropped > 0) reasons.push("D 客户端丢事件");
  if (alarm > 0) reasons.push("E 还在输出的推理块排在工具卡前面");
  if (reasons.length) {
    flagged.push({ w, reasons, events, dropped, bootstrap, renders, fps, blocking, worst, alarm, d });
  }
}

/* ---- 汇总 ---- */
const total = (key) => perf.reduce((s, w) => s + counter(w.details ?? {}, (n) => n === key), 0);
console.log("\n=== 总量（判读：event.stream / action.session.set-bubbles = 多少事件合成一次提交；改前≈1:1，帧预算后应明显下降）===");
for (const key of ["event.stream", "stream.eventDropped", "merge.streamingBootstrap", "poll.bootstrap.start", "action.session.set-bubbles", "render.chatThread", "render.messages", "render.assistantMessage", "markdown.render"]) {
  console.log(`  ${key.padEnd(28)} ${total(key)}`);
}
const shapes = new Map();
for (const w of perf) {
  for (const c of w.details?.counters ?? []) {
    if (!c.name.startsWith("render.shape.")) continue;
    shapes.set(c.name, (shapes.get(c.name) ?? 0) + c.count);
  }
}
if (shapes.size) {
  console.log("\n=== 渲染形状（块顺序签名）===");
  for (const [name, count] of [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(count).padStart(5)}  ${name.replace("render.shape.", "")}`);
  }
}

console.log(`\n=== 可疑窗口：${flagged.length} / ${perf.length} ===`);
if (!flagged.length) {
  console.log("没有命中任何判据（说明这段时间探针没看到异常，或者复现发生在窗口之外）。");
} else {
  // 合并相邻窗口成"事件"，输出持续时长
  let group = null;
  const groups = [];
  for (const f of flagged) {
    if (group && f.w._t - group.end <= 6000 && String(group.reasons) === String(f.reasons)) {
      group.end = f.w._t;
      group.items.push(f);
    } else {
      group = { start: f.w._t, end: f.w._t, reasons: f.reasons, items: [f] };
      groups.push(group);
    }
  }
  for (const g of groups.slice(-14)) {
    const dur = ((g.end - g.start) / 1000).toFixed(1);
    const near = prompts.map((p) => ({ p, dt: Math.abs(p._t - g.start) })).sort((a, b) => a.dt - b.dt)[0];
    console.log(`\n  ${new Date(g.start).toLocaleTimeString("zh-CN")} 起 ~${dur}s  [${g.reasons.join(" + ")}]`);
    console.log(`    最接近的 prompt：${near && near.dt < 5 * 6e4 ? `${String(near.p.requestId ?? "").slice(0, 8)}（${((near.p._t - g.start) / 1000).toFixed(1)}s 偏移，输入 ${near.p.inputLength ?? "?"} 字符）` : "（5 分钟内没有 prompt）"}`);
    const first = g.items[0].w.details ?? {};
    console.log(`    窗口样本：event.stream=${g.items.reduce((s, f) => s + counter(f.d, (n) => n === "event.stream"), 0)} render=${g.items.reduce((s, f) => s + counter(f.d, renderRe), 0)} fps=${g.items.map((f) => f.fps).join("/")} blockingMs=${g.items.map((f) => f.blocking).join("/")} worstMs=${g.items.map((f) => f.worst).join("/")}`);
    const scripts = (first.stalls?.worstScripts ?? []).slice(0, 3);
    if (scripts.length) console.log(`    worstScripts: ${JSON.stringify(scripts)}`);
    const bs = g.items.map((f) => counterList(f.d, (n) => n.startsWith("merge.") || n.startsWith("poll."))).filter(Boolean);
    if (bs.length) console.log(`    bootstrap 计数: ${bs.join(" ; ")}`);
  }
  console.log(`\n（共 ${groups.length} 个可疑事件，只显示最近 14 个）`);
}
