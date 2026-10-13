/**
 * 文件预览的代码查看器：**完全照 ZCode 的做法**（`@pierre/diffs/react` 的 `<File>` + shiki），
 * 而不是我们自己数行号画 `<span>`。
 *
 * 这里钉三件事：
 * - **引擎与主题的接法**：`shiki-wasm`（shiki-js 的 RegExp 会把 V8 code range 吃满 → OOM）、
 *   `theme: { light, dark }` + `themeType`（token 是 `light-dark()`，不显式给档就会跟着系统
 *   偏好走）、`cacheKey` 里必须有主题与内容指纹（否则切深浅/改内容还命中旧 token）；
 * - **只有一个滚动容器**：横向纵向都归库那层，外层再套一个滚动框会让滚动条跑到看不见的地方；
 * - **大小限制与 ZCode 同语义**：超过 256KB 服务端就不读、也不回半截文本（UTF-8 从中间截断
 *   会乱码），界面只说「太大」而不是渲染半截。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";

const codeViewerSource = readFileSync(
  new URL("../src/features/workspace/CodeViewer.tsx", import.meta.url),
  "utf8",
);
const previewPaneSource = readFileSync(
  new URL("../src/features/workspace/PreviewPane.tsx", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server/workspaceFiles.mjs", import.meta.url), "utf8");

test("代码查看器用 @pierre/diffs 的 File，引擎固定 shiki-wasm", () => {
  assert.match(codeViewerSource, /from "@pierre\/diffs\/react"/);
  assert.match(codeViewerSource, /<DiffsFile file=\{file\} options=\{options\}/);
  assert.match(codeViewerSource, /"shiki-wasm"/, "主线程渲染也必须用 wasm 引擎，否则 V8 code range 会被正则吃满");
  // 先不开 worker 池：那要打包器多吐一个 chunk，两个宿主都得跟着陪跑。开之前先改这里。
  assert.doesNotMatch(codeViewerSource, /new Worker\(/, "worker 池还没开（见组件注释）");
  assert.doesNotMatch(codeViewerSource, /WorkerPoolContextProvider/);
});

test("主题两档一起给 + colorScheme，缓存键带主题与内容指纹", () => {
  assert.match(codeViewerSource, /theme: themes,/);
  assert.match(codeViewerSource, /themeType: themeMode,/);
  assert.match(codeViewerSource, /colorScheme: themeMode/);
  assert.match(codeViewerSource, /"--diffs-bg": "var\(--background\)"/);
  assert.match(codeViewerSource, /"--diffs-font-size": `\$\{CODE_PREVIEW_FONT_SIZE_PX\}px`/);
  // 库按 file.cacheKey 复用 token：不带主题/内容指纹就会拿到过期的高亮。
  assert.match(
    codeViewerSource,
    /cacheKey: `\$\{isDarkCodePreviewTheme\(themes\[themeMode\]\) \? "dark" : "light"\}:\$\{name\}:\$\{code\.length\}:\$\{hashCodeViewerContent\(code\)\}`/,
  );
  assert.match(codeViewerSource, /function hashCodeViewerContent\(/);
});

test("行号 / 折行 / 头部都走库的选项，和 ZCode 一套", () => {
  assert.match(codeViewerSource, /disableFileHeader: true/, "头部我们自己画（文件名/目录/大小）");
  assert.match(codeViewerSource, /disableLineNumbers: !showLineNumbers/);
  assert.match(codeViewerSource, /overflow: wrapLongLines \? "wrap" : "scroll"/);
  assert.match(codeViewerSource, /tokenizeMaxLineLength: 1_000/);
  assert.match(codeViewerSource, /useTokenTransformer: false/);
  assert.match(codeViewerSource, /data-code-viewer=""/, "给 e2e 留稳定选择器");
  assert.match(codeViewerSource, /data-language=\{language\}/);
});

test("预览面板用 CodeViewer 渲染正文，不再自己画行号", () => {
  assert.match(previewPaneSource, /import \{ CodeViewer \} from "\.\/CodeViewer"/);
  assert.match(previewPaneSource, /<CodeViewer code=\{content\.text \?\? ""\} path=\{subject\.path\} themeMode=\{themeMode\} \/>/);
  assert.doesNotMatch(previewPaneSource, /function TextViewer/, "自研的纯文本查看器已被替换");
  assert.doesNotMatch(previewPaneSource, /splitTextLines/, "行号不再由我们切行");
  // 库那层自己滚，外面不许再套一个 overflow-auto。
  assert.match(previewPaneSource, /className="min-h-0 flex-1 overflow-hidden pt-1 pb-3"/);
  // 明暗档从应用主题来（App 里传的 `theme`）。
  assert.match(appSource, /themeMode=\{theme\}/);
  assert.match(previewPaneSource, /themeMode: "light" \| "dark"/);
});

test("文件过大：只说太大，不渲染半截（阈值与 ZCode 同）", () => {
  // 服务端：超过 256KB 直接 too-large，text 为 null。
  assert.match(serverSource, /export const MAX_FILE_TEXT_BYTES = 256 \* 1024;/);
  assert.match(serverSource, /return textOrUnavailable\(relativePath, "too-large", "File is larger than the preview limit\."/);
  // 界面：too-large 时给本地化的体积提示，而不是把服务端那句英文原因原样端出来。
  assert.match(previewPaneSource, /const tooLarge = !isDiff && content\?\.availability === "too-large";/);
  assert.match(previewPaneSource, /t\("rightPanel\.contentTooLarge", \{ size: formatFileSize\(content\?\.size \?\? 0\) \}\)/);
  for (const [pack, source] of [["zh", zh], ["en", en]] as const) {
    assert.ok("rightPanel.contentTooLarge" in source, `${pack} 缺 rightPanel.contentTooLarge`);
  }
  // 半截文本不可能被渲染：能渲染正文的前提是 availability === "text"。
  assert.match(previewPaneSource, /const showText = !isDiff && canRenderFileText\(content\);/);
});