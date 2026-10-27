/**
 * 过程行上的每个字（思考标题、工具行的动作词、状态词、正文分段名）都必须走 i18n。
 *
 * 这些字符串原来硬编码英文（`Reasoning` / `Used bash` / `4 tool calls` / `Request` /
 * `Result`），切到中文界面也还是英文 —— 2026-09-19 用户直接指出「红框里这些目前没有
 * 多语言」。测试分两层：
 * - 行为层：两包的值与 `{slot}` 插值（这是用户真正看到的东西）；
 * - 结构层：组件里不再残留那些英文硬编码，且真的调了 `t(...)`。
 * 结构断言只钉「旧的硬编码写法必须消失」，不钉具体实现语句，避免锁死重构。
 *
 * 2026-10-27：行改成 ZCode 的语法后，动作词从「Used {name}」变成按工具分族的状态词
 * （Reading/Read、Running/Terminal…），工具组计数与分步标题随包装层一起消失。这里跟着
 * 换成新词表：动作词这一层如果回退成硬编码，中文界面就会重新出现英文动词。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { setLocale, t } from "../src/i18n/index.ts";

const threadTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url),
  "utf8",
);
const thinkingRowTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/thinking-row.tsx", import.meta.url),
  "utf8",
);
const toolRowTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/tool-row.tsx", import.meta.url),
  "utf8",
);
const toolBodiesTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/tool-bodies.tsx", import.meta.url),
  "utf8",
);

test("思考行跟随语言：运行中是「正在思考」，结束后是「思考 · N 秒」", () => {
  setLocale("zh");
  assert.equal(t("process.reasoning.thinking"), "正在思考");
  assert.equal(t("process.reasoning.thought"), "思考");
  assert.equal(t("process.reasoning.durationSeconds", { seconds: 7 }), "持续了 7 秒");
  assert.equal(t("process.reasoning.durationFewSeconds"), "持续了几秒");

  setLocale("en");
  assert.equal(t("process.reasoning.thinking"), "Thinking");
  assert.equal(t("process.reasoning.thought"), "Thought");
  assert.equal(t("process.reasoning.durationSeconds", { seconds: 7 }), "7 seconds");
  assert.equal(t("process.reasoning.durationFewSeconds"), "a few seconds");
  setLocale("zh");
});

test("工具行动作词跟随语言：分族 + 运行中/结束后两态", () => {
  setLocale("zh");
  assert.equal(t("process.tool.read.running"), "正在读取");
  assert.equal(t("process.tool.read.done"), "已读取");
  assert.equal(t("process.tool.execute.running"), "执行中");
  assert.equal(t("process.tool.execute.done"), "终端");
  assert.equal(t("process.status.failed"), "执行失败");

  setLocale("en");
  assert.equal(t("process.tool.read.running"), "Reading");
  assert.equal(t("process.tool.read.done"), "Read");
  assert.equal(t("process.tool.execute.running"), "Running");
  assert.equal(t("process.tool.execute.done"), "Terminal");
  assert.equal(t("process.status.failed"), "Failed");
  setLocale("zh");
});

test("多文件改动按单复数取 key；搜索结果拼成一句完整摘要", () => {
  setLocale("zh");
  assert.equal(t("process.tool.fileCount.one", { count: 1 }), "1 个文件");
  assert.equal(t("process.tool.fileCount.other", { count: 4 }), "4 个文件");
  assert.equal(t("process.tool.search.findWithQuery", { query: "useT" }), "查找 useT");
  assert.equal(t("process.tool.search.listIn", { cwd: "src" }), "列出 src");

  setLocale("en");
  assert.equal(t("process.tool.fileCount.one", { count: 1 }), "1 file");
  assert.equal(t("process.tool.fileCount.other", { count: 4 }), "4 files");
  assert.equal(t("process.tool.search.findWithQuery", { query: "useT" }), "Find useT");
  assert.equal(t("process.tool.search.listIn", { cwd: "src" }), "List in src");
  setLocale("zh");
});

test("工具正文分段名跟随语言", () => {
  setLocale("zh");
  assert.equal(t("process.tool.parameters"), "参数");
  assert.equal(t("process.tool.error"), "错误");
  assert.equal(t("process.result"), "结果");
  assert.equal(t("message.copyCode"), "复制代码");
  assert.equal(t("message.workingAria"), "助手正在工作");

  setLocale("en");
  assert.equal(t("process.tool.parameters"), "Parameters");
  assert.equal(t("process.tool.error"), "Error");
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
    ["thread.aui.tsx", /`Used \$\{toolName\}`/, "工具行的动作词必须走 i18n"],
    ["thread.aui.tsx", /`Running \$\{toolName\}`/, "运行中的动作词必须走 i18n"],
    ["thread.aui.tsx", /`Failed \$\{toolName\}`/, "失败词必须走 i18n"],
    ["thread.aui.tsx", /`Thinking step \$\{index \+ 1\}`/, "分步标题必须走 process.stepTitle"],
    ["thread.aui.tsx", /aria-label="Assistant is working"/, "运行指示器 aria 必须走 message.workingAria"],
    ["thinking-row.tsx", />Thinking</, "思考行的运行态文案必须走 i18n"],
    ["thinking-row.tsx", />Thought</, "思考行的完成态文案必须走 i18n"],
    ["tool-row.tsx", />Terminal</, "终端动作词必须走 i18n"],
    ["tool-row.tsx", />MCP</, "MCP 动作词必须走 i18n"],
    ["tool-bodies.tsx", />Parameters</, "工具正文分段名必须走 i18n"],
    ["tool-bodies.tsx", />Error</, "失败分段名必须走 i18n"],
  ];
  const sources: Record<string, string> = {
    "thread.aui.tsx": threadTsx,
    "thinking-row.tsx": thinkingRowTsx,
    "tool-row.tsx": toolRowTsx,
    "tool-bodies.tsx": toolBodiesTsx,
  };

  for (const [file, pattern, message] of stale) {
    assert.doesNotMatch(sources[file], pattern, `${file}: ${message}`);
  }

  // 确认这些文件确实拿到了 t（而不是只是删掉了英文、留下空白）
  assert.match(thinkingRowTsx, /process\.reasoning\.thought/, "思考行必须调用思考词表");
  assert.match(
    toolRowTsx,
    /process\.tool\.execute\.done/,
    "终端动作词要走词表，而不是写死 Terminal",
  );
  assert.match(
    toolRowTsx,
    /process\.status\.failed/,
    "失败状态词要走词表",
  );
  assert.match(
    toolBodiesTsx,
    /process\.tool\.parameters/,
    "工具正文分段名要走词表",
  );
  assert.match(toolBodiesTsx, /process\.result/, "结果分段名要走词表");
});
