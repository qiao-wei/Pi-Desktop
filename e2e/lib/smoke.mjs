/**
 * 冒烟：不用浏览器，直接把"起假模型 + 起桥 + 建项目 + 选模型 + 发一轮"跑一遍。
 * 用来在写 Playwright 用例之前确认假模型端点真的能让 pi 走完一整轮。
 *
 * 用法：node e2e/lib/smoke.mjs
 */
import { startE2E } from "./bridge.mjs";

const e2e = await startE2E({ model: { chunkDelayMs: 40 }, env: { PI_DESKTOP_DIAGNOSTICS_ENABLED: "1" } });
if (!e2e.model) {
  throw new Error("冒烟需要假模型端点（startE2E 传 fakeModel: true）");
}
console.log(`apiBase = ${e2e.apiBase}`);

try {
  const models = await e2e.api.get("/api/models");
  const flat = JSON.stringify(models);
  console.log(`/api/models 里能看到假模型: ${flat.includes("e2e-model")}`);
  console.log(`/api/models hasConfiguredAuth: ${flat.includes("hasConfiguredAuth") ? "字段在" : "字段不在"}`);

  await e2e.api.openProject(e2e.workspaceDir);
  const selected = await e2e.api.selectE2EModel();
  console.log(`选模型 -> ${JSON.stringify(selected).slice(0, 200)}`);

  const events = await e2e.api.prompt("你好，介绍一下你自己");
  console.log(`事件数 ${events.length}`);
  console.log(`事件类型: ${[...new Set(events.map((event) => event.type))].join(", ")}`);
  const text = events
    .filter((event) => event.type === "assistant_delta" || event.type === "delta" || event.type === "text")
    .map((event) => event.text ?? event.delta ?? "")
    .join("");
  console.log(`流式文本: ${JSON.stringify(text).slice(0, 200)}`);
  if (text.includes("E2E-")) {
    console.log("✅ 假模型的分块文本真的流过了桥");
  } else {
    console.log("❌ 没看到假模型的文本，事件原样如下：");
    console.log(JSON.stringify(events.slice(0, 12), null, 1).slice(0, 3000));
  }
  console.log(`模型收到的请求数: ${e2e.model.requests.length}`);
  console.log(`其中一条的 model 字段: ${e2e.model.requests[0]?.body?.model}`);
} catch (error) {
  console.error(`❌ ${error.message}`);
  const logs = e2e.logs();
  const { readFileSync } = await import("node:fs");
  const path = `${e2e.agentDir}/pi-desktop-runtime.ndjson`;
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n");
    console.error("诊断日志尾部：");
    console.error(lines.slice(-6).join("\n").slice(-3000));
  } catch (readError) {
    console.error(`读诊断日志失败: ${readError.message}`);
  }
  console.error(logs.stdout.slice(-2000));
  console.error(logs.stderr.slice(-4000));
} finally {
  await e2e.stop();
}