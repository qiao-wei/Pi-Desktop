/**
 * 项目条目上的两个入口（2026-10-12 按 ZCode 的布局定的）：
 *
 * - **文件**：在**左侧栏**展开这个项目的文件树（ZCode 的 file tree 就在左侧栏，点文件在
 *   右侧开一张文件 tab）；右面板不再有「文件」tab。
 * - **技能/包**：弹窗（ZCode 把 workspace 的 skills/packages 收在这一层）；右面板不再有
 *   「能力面板」tab。
 *
 * 这里钉的是**接线**，不是像素：入口挂在项目行上、树本体只有一份（App 组好整块传进来，
 * 不许在侧栏里再写一遍 FilesPane）、弹窗里的面板定义只有一份（capabilityPanelParity 也守）。
 *
 * 已知的宿主差异：PiDesktop 有多个项目、却只有一个「当前项目」（服务端跟着选中的会话走），
 * 所以点别的项目上的图标时得先切过去 —— 否则左边的树和右边的预览会指向两个不同的项目。
 * 这条也一起钉住，免得以后有人以为那是多余的。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** Source of a top-level `function name(...) { ... }`, delimited at the next flush-left brace. */
function topLevelFunctionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = appSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return appSource.slice(start, end);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("项目行上有「文件」和「技能/包」两个入口，各接各的 handler", () => {
  const sidebar = topLevelFunctionSource("ProjectSidebar");

  assert.equal(countOccurrences(sidebar, "data-project-files-nav={project.id}"), 1, "文件入口只许有一个");
  assert.equal(countOccurrences(sidebar, "data-project-capabilities-nav={project.id}"), 1, "技能/包入口只许有一个");
  assert.match(sidebar, /onClick=\{\(\) => onOpenProjectFileTree\(project\.id\)\}/);
  assert.match(sidebar, /onClick=\{\(\) => onOpenProjectCapabilities\(project\.id\)\}/);
  // 无障碍名 + 悬停提示（图标按钮没有文字，靠这两个）。
  assert.match(sidebar, /aria-label=\{t\("sidebar\.filesNav"\)\}/);
  assert.match(sidebar, /aria-label=\{t\("sidebar\.projectCapabilitiesNav"\)\}/);
  // 和同一行上的其它按钮一样，锁定时跟着禁用。
  assert.match(sidebar, /data-project-files-nav=\{project\.id\}[\s\S]{0,400}?sidebarLock\.lockClass/);
});

test("文件树在左侧栏里，本体只有一份（App 组好整块传进来）", () => {
  assert.equal(countOccurrences(appSource, "<FilesPane"), 1, "FilesPane 只许有一处实例：侧栏的文件树");

  const sidebar = topLevelFunctionSource("ProjectSidebar");
  assert.equal(countOccurrences(sidebar, "<FilesPane"), 0, "侧栏不许再抄一遍文件树");
  assert.match(sidebar, /\{fileTreeProjectId \? \(/);
  assert.match(sidebar, /\{fileTreeView\}/);
  // 返回项目列表 + 标题是当前项目的名字。
  assert.match(sidebar, /onClick=\{onCloseFileTree\}/);
  assert.match(sidebar, /projects\.find\(\(project\) => project\.id === fileTreeProjectId\)\?\.name/);
  assert.match(sidebar, /data-sidebar-file-tree/);

  // 侧栏不再有「文件」这个右面板 tab 的接线（那个视图搬走了：见 rightPanelTabs.test.ts）。
  assert.doesNotMatch(appSource, /rightPanelTab:[\s\S]{0,200}"files"/);
});

test("点别的项目上的入口会先切到那个项目（树与预览必须指向同一个项目）", () => {
  const focus = topLevelFunctionSource("focusProjectForPanel");
  assert.match(focus, /projectId === bootstrap\.activeProjectId/);
  assert.match(focus, /selectSession\(projectId, session\.path\)/);
  assert.match(focus, /sessions\.find\(\(candidate\) => !candidate\.pinned\)/);

  for (const handler of ["openProjectFileTree", "openProjectCapabilities"]) {
    const body = topLevelFunctionSource(handler);
    assert.match(body, /if \(focusProjectForPanel\(projectId\)\)/, `${handler} 必须先切项目再打开`);
  }
});

test("技能/包弹窗里放的是那个共享面板，且一次只有一个", () => {
  assert.equal(countOccurrences(appSource, "<ProjectCapabilitiesPanel"), 1, "面板的 call site 只许有一处");
  assert.match(appSource, /open=\{Boolean\(capabilitiesDialogProjectId\)\}/);
  assert.match(appSource, /onOpenChange=\{\(next\) => \{[\s\S]{0,120}?setCapabilitiesDialogProjectId\(""\)/);
});

test("两个入口的文案 key 在 zh / en 两包都有", () => {
  for (const key of [
    "sidebar.filesNav",
    "sidebar.filesBack",
    "sidebar.projectCapabilitiesNav",
    "sidebar.capabilitiesDialog.title",
    "sidebar.capabilitiesDialog.hint",
  ]) {
    assert.ok(key in zh, `zh.ts 缺 ${key}`);
    assert.ok(key in en, `en.ts 缺 ${key}`);
  }
});