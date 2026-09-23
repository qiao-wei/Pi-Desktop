/**
 * 会话运行期间的标签（思考折叠标题、工具行、工具组计数、工具卡分段名）必须走 i18n。
 *
 * 这些字符串原来硬编码英文（`Reasoning` / `Used bash` / `4 tool calls` / `Request` /
 * `Result`），切到中文界面也还是英文 —— 2026-09-19 用户直接指出「红框里这些目前没有
 * 多语言」。测试分两层：
 * - 行为层：两包的值与 `{slot}` 插值（这是用户真正看到的东西）；
 * - 结构层：组件里不再残留那些英文硬编码，且真的调了 `t(...)`。
 * 结构断言只钉「旧的硬编码写法必须消失」，不钉具体实现语句，避免锁死重构。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { setLocale, t } from "../src/i18n/index.ts";

const threadTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url),
  "utf8",
);
const reasoningTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/reasoning.tsx", import.meta.url),
  "utf8",
);
const toolCallTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/tool-call.tsx", import.meta.url),
  "utf8",
);
const toolGroupTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/tool-group.aui.tsx", import.meta.url),
  "utf8",
);

test("思考折叠标题跟随语言，带时长时插值生效", () => {
  setLocale("zh");
  assert.equal(t("process.reasoning"), "思考");
  assert.equal(t("process.reasoningWithDuration", { seconds: 7 }), "思考 (7s)");

  setLocale("en");
  assert.equal(t("process.reasoning"), "Reasoning");
  assert.equal(t("process.reasoningWithDuration", { seconds: 7 }), "Reasoning (7s)");
  setLocale("zh");
});

test("工具行标签跟随语言：已调用 / 正在调用 / 调用失败", () => {
  setLocale("zh");
  assert.equal(t("process.toolUsed", { name: "bash" }), "已调用 bash");
  assert.equal(t("process.toolRunning", { name: "bash" }), "正在调用 bash");
  assert.equal(t("process.toolFailed", { name: "bash" }), "bash 调用失败");

  setLocale("en");
  assert.equal(t("process.toolUsed", { name: "bash" }), "Used bash");
  assert.equal(t("process.toolRunning", { name: "bash" }), "Running bash");
  assert.equal(t("process.toolFailed", { name: "bash" }), "Failed bash");
  setLocale("zh");
});

test("工具组计数按单复数取 key，插值后是完整短语", () => {
  setLocale("zh");
  assert.equal(t("process.toolGroupCount.one", { count: 1 }), "1 个工具调用");
  assert.equal(t("process.toolGroupCount.other", { count: 4 }), "4 个工具调用");

  setLocale("en");
  assert.equal(t("process.toolGroupCount.one", { count: 1 }), "1 tool call");
  assert.equal(t("process.toolGroupCount.other", { count: 4 }), "4 tool calls");
  setLocale("zh");
});

test("思考分步标题与工具卡分段名跟随语言", () => {
  setLocale("zh");
  assert.equal(t("process.stepTitle", { index: 2 }), "第 2 步思考");
  assert.equal(t("process.request"), "请求");
  assert.equal(t("process.result"), "结果");
  assert.equal(t("message.copyCode"), "复制代码");
  assert.equal(t("message.workingAria"), "助手正在工作");

  setLocale("en");
  assert.equal(t("process.stepTitle", { index: 2 }), "Thinking step 2");
  assert.equal(t("process.request"), "Request");
  assert.equal(t("process.result"), "Result");
  assert.equal(t("message.copyCode"), "Copy code");
  assert.equal(t("message.workingAria"), "Assistant is working");
  setLocale("zh");
});

test("图片浮层与图片状态文案跟随语言", () => {
  setLocale("zh");
  assert.equal(t("image.zoomClose"), "关闭放大的图片");
  assert.equal(t("image.filtered"), "图片无法生成");

  setLocale("en");
  assert.equal(t("image.zoomOpen"), "Click to zoom image");
  assert.equal(t("image.zoomDialog"), "Zoomed image");
  assert.equal(t("image.zoomClose"), "Close zoomed image");
  assert.equal(t("image.contentLabel"), "Image content");
  assert.equal(t("image.generating"), "Generating image…");
  assert.equal(t("image.filtered"), "Image could not be generated");
  assert.equal(t("image.filteredReason"), "The provider blocked this image.");
  setLocale("zh");
});

test("组件里不再硬编码这些英文标签，而是调用 t(...)", () => {
  const stale: Array<[string, RegExp, string]> = [
    ["thread.aui.tsx", /`Used \$\{toolName\}`/, "工具行 label 必须走 process.toolUsed"],
    ["thread.aui.tsx", /`Running \$\{toolName\}`/, "运行中 label 必须走 process.toolRunning"],
    ["thread.aui.tsx", /`Failed \$\{toolName\}`/, "失败 label 必须走 process.toolFailed"],
    ["thread.aui.tsx", /`Thinking step \$\{index \+ 1\}`/, "分步标题必须走 process.stepTitle"],
    ["thread.aui.tsx", /aria-label="Assistant is working"/, "运行指示器 aria 必须走 message.workingAria"],
    ["reasoning.tsx", /Reasoning\{durationText\}/, "思考标题必须走 process.reasoning"],
    ["reasoning.tsx", /` \(\$\{duration\}s\)`/, "时长后缀不能手拼英文括号"],
    ["tool-call.tsx", />Request</, "工具卡分段名必须走 process.request"],
    ["tool-call.tsx", />Result</, "工具卡分段名必须走 process.result"],
    ["tool-group.aui.tsx", /`\$\{count\} tool \$\{count === 1 \? "call" : "calls"\}`/, "工具组计数必须走 i18n"],
  ];
  const sources: Record<string, string> = {
    "thread.aui.tsx": threadTsx,
    "reasoning.tsx": reasoningTsx,
    "tool-call.tsx": toolCallTsx,
    "tool-group.aui.tsx": toolGroupTsx,
  };

  for (const [file, pattern, message] of stale) {
    assert.doesNotMatch(sources[file], pattern, `${file}: ${message}`);
  }

  // 确认这些文件确实拿到了 t（而不是只是删掉了英文、留下空白）
  assert.match(reasoningTsx, /t\("process\.reasoning"\)/, "reasoning.tsx 必须调用 process.reasoning");
  assert.match(toolGroupTsx, /t\("process\.toolGroupCount\.one", \{ count \}\)/, "工具组单数 key");
  assert.match(toolGroupTsx, /t\("process\.toolGroupCount\.other", \{ count \}\)/, "工具组复数 key");
  assert.match(toolCallTsx, /t\("process\.request"\)/);
  assert.match(toolCallTsx, /t\("process\.result"\)/);
});