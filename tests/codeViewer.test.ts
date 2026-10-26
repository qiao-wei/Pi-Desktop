/**
 * 文件预览的代码查看器：**完全照 ZCode 的做法**（`@pierre/diffs/react` 的 `<File>` + shiki），
 * 而不是我们自己数行号画 `<span>`。
 *
 * 这里钉三件事：
 * - **引擎与主题的接法**：`shiki-wasm`（shiki-js 的 RegExp 会把 V8 code range 吃满 → OOM）、
 *   `theme: { light, dark }` + `themeType`（token 是 `light-dark()`，不显式给档就会跟着系统
 *   偏好走）、`cacheKey` 里必须有主题与内容指纹（否则切深浅/改内容还命中旧 token）；
 * - **只有一个滚动容器，且在面板这一层**：库那层（shadow DOM 的 pre）不滚，横向滚动条才会贴
 *   可见区底边；正文右边缘留一条 18px 的沟（和头部对齐，2026-10-12 用户反馈贴边太挤）；
 * - **大小限制与 ZCode 同语义**：超过 256KB 服务端就不读、也不回半截文本（UTF-8 从中间截断
 *   会乱码），界面只说「太大」而不是渲染半截。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appSource as readAppSource } from "./lib/appSource.ts";

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
const appSourceText = readAppSource();
const diffViewerSource = readFileSync(
  new URL("../src/features/workspace/DiffViewer.tsx", import.meta.url),
  "utf8",
);
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
  // 滚动容器摆在面板这一层（它高度确定 → 横向滚动条贴可见区底边），库里那层不滚：
  // 实测 shadow DOM 里 pre 的 scrollWidth == clientWidth，不会出现双滚动条。
  assert.match(previewPaneSource, /className="mr-\[18px\] min-h-0 flex-1 overflow-auto pt-1 pb-3"/);
  assert.match(codeViewerSource, /className="min-h-full w-max min-w-full"/);
  // DiffViewer 那份套了 cn(...)，只钉宽度这条。
  assert.match(diffViewerSource, /w-max min-w-full/);
  // 明暗档从应用主题来（App 里传的 `theme`）。
  assert.match(appSourceText, /themeMode=\{theme\}/);
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
test("正文右边缘留 18px 的沟：靠缩窄滚动视口（mr-*），不是给它加 padding", () => {
  // 2026-10-12 用户反馈正文贴到窗口边缘。这里钉住做法：`pr-*` 加在滚动容器上**不产生可见的沟**
  // —— overflow 裁到的是 padding box，溢出的长行照样画进 padding 区（真机实测：离边 9px 处
  // elementFromPoint 命中的仍是代码容器）；只有把滚动视口本身缩窄（margin）裁边才会跟着往里挪。
  const bodies = previewPaneSource.match(/mr-\[18px\] min-h-0 flex-1 overflow-auto pt-1 pb-3/g) ?? [];
  assert.equal(bodies.length, 2, "正文与 diff 两条路都要留沟");
  assert.doesNotMatch(previewPaneSource, /overflow-auto pt-1 pb-3 pr-\[18px\]/, "宽度用 mr-*，别用 pr-*");
  // 沟要够得着：库那层是 w-max（内容比面板宽时把外层撑开 → 滚动条贴可见区底边），
  // Shadow DOM 里的 pre 因此不会有自己的横向溢出。
  assert.match(codeViewerSource, /w-max min-w-full/);
  assert.match(diffViewerSource, /w-max min-w-full/);
});

test("diff 也是 @pierre/diffs 画的（带语法高亮），不是只上绿红底色", () => {
  // 2026-10-12 用户反馈「代码现在还是没有高亮」：正文已经是 pierre，但**改动**那条路还是自研的
  // 逐行渲染器（只有 +/- 底色）。diff 里的代码同样要过 shiki。
  assert.match(diffViewerSource, /import \{ MultiFileDiff, PatchDiff \} from "@pierre\/diffs\/react"/);
  assert.match(diffViewerSource, /<PatchDiff patch=\{patch\} options=\{options\}/);
  assert.doesNotMatch(diffViewerSource, /parseUnifiedPatch\(patch\)\.hunks\.map/, "不再自己逐行画");
  // 和 CodeViewer 同一套引擎 / 主题 / 变量。
  assert.match(diffViewerSource, /"shiki-wasm"/);
  assert.match(diffViewerSource, /theme: themes,/);
  assert.match(diffViewerSource, /themeType: themeMode,/);
  assert.match(diffViewerSource, /colorScheme: themeMode/);
  assert.match(diffViewerSource, /"--diffs-bg": "var\(--background\)"/);
  // ZCode 的 diff 选项：unified + bars。
  assert.match(diffViewerSource, /diffStyle: "unified"/);
  assert.match(diffViewerSource, /diffIndicators: "bars"/);
  assert.match(diffViewerSource, /overflow: "scroll"/);
  assert.match(diffViewerSource, /data-diff-viewer=""/, "给 e2e 留稳定选择器");
  // 宿主两处都传明暗档（预览标签页 + 改动面板的就地展开）。
  assert.match(previewPaneSource, /<DiffViewer/);
  assert.match(previewPaneSource, /themeMode=\{themeMode\}/);
});

test("diff 有全文就用 MultiFileDiff（能展开未改动行），只有 patch 才退回 PatchDiff", () => {
  // 2026-10-21 用户按 ZCode 的截图反馈「显示方式不对」：只有 +/- 底色和几个 hunk，看不到
  // ZCode 那种「N unmodified lines」的上下文分隔条。那条要两侧全文才好画，所以：
  // 服务端读得到 before/after → MultiFileDiff + line-info；只有 patch（超大文件）→
  // PatchDiff + simple（patch 缺上下文，画出来的展开提示点不开，等于骗人）。
  assert.match(diffViewerSource, /hunkSeparators: richFiles \? "line-info" : "simple"/);
  assert.match(diffViewerSource, /<MultiFileDiff/);
  assert.match(diffViewerSource, /oldFile=\{richFiles\.oldFile\}/);
  assert.match(diffViewerSource, /newFile=\{richFiles\.newFile\}/);
  // 富渲染那层**不能**给 `w-max`：库内部那个网格自己就是横向滚动容器（`overflow-x: scroll`），
  // 滚动容器对 max-content 的贡献是 0 —— 宿主宽度会塌成 0，整块 diff 画不出来（真机实测：
  // 宿主 rect 宽 0px、行都在 DOM 里但一个像素也不显示）。`w-full` + 库自己那层滚长行（ZCode 同）。
  assert.match(diffViewerSource, /className="block min-h-full w-full"/);
  assert.match(diffViewerSource, /<PatchDiff patch=\{patch\} options=\{options\} className="min-h-full w-max" \/>/);
  // cacheKey 必须带内容指纹：库按 key 复用高亮，内容变了不换 key 就会拿到上一份 token。
  assert.match(diffViewerSource, /function sideCacheKey\(side: "old" \| "new", name: string, contents: string\): string/);
  assert.match(diffViewerSource, /cacheKey: sideCacheKey\("old", name, sides\.beforeContent\)/);
  assert.match(diffViewerSource, /cacheKey: sideCacheKey\("new", name, sides\.afterContent\)/);
  // 两侧全文必须**一起**有、且篇幅在上限内才走富渲染：只有一侧说明没读完整（拿它当空文件
  // 会把整篇画成增/删），超过上限则同步比整篇会把点开那一帧卡住。规则本身在 shared/ 里单测。
  assert.match(diffViewerSource, /if \(!canRenderRichWorkspaceDiff\(sides\)\) \{\s*return null;/);
  assert.match(diffViewerSource, /const sides = \{ beforeContent, afterContent \};/);
  // 预览标签页把服务端给的全文一起交进去。
  assert.match(previewPaneSource, /beforeContent=\{diff\.beforeContent\}/);
  assert.match(previewPaneSource, /afterContent=\{diff\.afterContent\}/);
  assert.match(previewPaneSource, /path=\{subject\.path\}/);
});
