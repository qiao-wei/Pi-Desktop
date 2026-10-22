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
  // 和同一行上的其它按钮一样，锁定时跟着禁用（同一段里 class 与锁定 class 成对出现）。
  assert.match(
    sidebar,
    /className=\{cn\("size-6", sidebarLock\.lockClass\)\}[\s\S]{0,400}?data-project-files-nav=\{project\.id\}/,
  );
  assert.match(
    sidebar,
    /className=\{cn\("size-6", sidebarLock\.lockClass\)\}[\s\S]{0,400}?data-project-capabilities-nav=\{project\.id\}/,
  );
});

test("动作簇的图标是一族 16px 画法，且顺序对齐 ZCode", () => {
  const sidebar = topLevelFunctionSource("ProjectSidebar");
  const rowStart = sidebar.indexOf('"group relative"');
  assert.notEqual(rowStart, -1, "project row markup changed");
  // 到这一行的 `</section>` 为止（别用第一个 `</section>`：侧栏里前面还有别的 section）。
  const cluster = sidebar.slice(sidebar.indexOf("sidebarHoverActionClass", rowStart), sidebar.indexOf("</section>", rowStart));

  // 图标全部来自 `sidebarIcons`（24 格 / 1.7 描边），尺寸统一 16px：
  // 之前这里混了 lucide 的 FolderTree（17px）和 Blocks（17px）——同排里只有它们又粗又大。
  for (const icon of ["SidebarMoreIcon", "SidebarFileTreeIcon", "SidebarSkillsIcon", "SidebarNewSessionIcon"]) {
    // 用字符串比对：`{16}` 放进 RegExp 会被当成量词（`e{16}` = 十六个 e）。
    assert.ok(cluster.includes(`<${icon} size={16} />`), `${icon} 要用 16px 的族谱画法`);
  }
  assert.doesNotMatch(cluster, /<FolderTree|<Blocks|MoreHorizontal/, "不许再混 lucide 的看家图标");

  // 顺序照 ZCode 的项目行（`ProjectNodeContent.tsx` 的 virtual-project-actions）：
  // 「…」在最左，动作按次要→主要排，新建会话在最右。
  const order = ["SidebarMoreIcon", "data-project-files-nav", "data-project-capabilities-nav", "SidebarNewSessionIcon"];
  const positions = order.map((token) => cluster.indexOf(token));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    `动作簇顺序应为 ${order.join(" → ")}`,
  );
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

test("新加的两个图标画在侧栏同一套族谱上（不是另一个图标族）", () => {
  const icons = readFileSync(new URL("../src/components/sidebarIcons.tsx", import.meta.url), "utf8");
  // ZCode 的「文件树」是 lucide `ListTree`、「技能」是 `WandSparkles`：路径照抄，
  // 但外壳用 `Svg()`（24 格 + strokeWidth 1.7），否则又变成两种笔画混排。
  assert.match(icons, /export function SidebarFileTreeIcon/);
  assert.match(icons, /d="M3 6v4c0 1\.1\.9 2 2 2h3"/);
  assert.match(icons, /export function SidebarSkillsIcon/);
  assert.match(icons, /m21\.64 3\.64-1\.28-1\.28a1\.21 1\.21 0 0 0-1\.72 0L2\.36 18\.64/);
  assert.match(icons, /export function SidebarMoreIcon/);
  assert.match(icons, /strokeWidth=\{1\.7\}/);
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