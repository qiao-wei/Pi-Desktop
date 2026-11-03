/**
 * 右侧面板的标签页模型（Codex 风格：一个文件一个 tab + 工具 tab + 新标签页）。
 *
 * 这里钉四件事：
 * - **开/关/激活的代数**：同一个文件同一个模式复用一个 tab、新 tab 追加到末尾并激活、
 *   关当前 tab 落到右邻居（没有就左邻居）、全关掉之后没有激活项 —— 这些规则写进组件里就只能
 *   靠点出来，所以放在纯模块里直接测（和 ZCode `lib/workspaceSidePane.ts` 对齐）；
 * - **从「新标签页」选工具是替换**（Codex 里 New tab 选 Files → 变成那张文件面板）；
 * - **文案 key 在 zh / en 两包都真实存在** —— `i18nKeyCoverage.test.ts` 只能扫
 *   `t("字面量")`，而这张表里的 key 是数据，扫不到，所以这里单独对账；
 * - **布局契约**：strip 不许把面板撑出滚动区（量到过的真 bug），内容框只有一种（见 `RIGHT_PANEL_TAB_FRAME`）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";
import {
  DEFAULT_RIGHT_PANEL_TAB,
  RECENT_CLOSED_PANEL_TAB_LIMIT,
  RIGHT_PANEL_TOOL_TABS,
  closeOtherPanelTabs,
  closePanelTab,
  fileTabId,
  forgetRecentClosedPanelTab,
  isToolTabId,
  movePanelTab,
  rememberClosedPanelTabs,
  normalizeActivePanelTab,
  normalizeRightPanelTab,
  openPanelTab,
  RIGHT_PANEL_TAB_FRAME,
  tabFilePath,
  toolTab,
  type RightPanelFileTab,
  type RightPanelTab,
} from "../src/features/workspace/rightPanelTabs.ts";

const rightPanelSource = readFileSync(
  new URL("../src/features/workspace/RightPanel.tsx", import.meta.url),
  "utf8",
);

function fileTab(path: string, mode: "content" | "diff" = "content", source = "unstaged"): RightPanelFileTab {
  const tab: RightPanelFileTab =
    mode === "diff" ? { kind: "file", id: "", path, mode, source } : { kind: "file", id: "", path, mode };
  return { ...tab, id: fileTabId(path) };
}

function ids(tabs: readonly RightPanelTab[]): string[] {
  return tabs.map((tab) => tab.id);
}

test("工具表：默认是「改动」，id 不重复，且每个都在 isToolTabId 的范围内", () => {
  // 2026-10-12：能力面板搬到项目条目上的弹窗、文件树搬到左侧栏。
  // 2026-10-31：「浏览器」进表 —— 它是宿主能力驱动的视图（Electron 能画，Tauri/Web 由面板
  // 自己说明不可用），所以它属于“工具 tab 的声明”，不属于“按端分支”。
  assert.equal(DEFAULT_RIGHT_PANEL_TAB, "git");
  assert.equal(RIGHT_PANEL_TOOL_TABS[0].id, DEFAULT_RIGHT_PANEL_TAB);
  assert.deepEqual(
    RIGHT_PANEL_TOOL_TABS.map((tool) => tool.id),
    ["git", "browser"],
    "右面板自带的视图：改动 + 内置浏览器（文件树在左侧栏、技能/包是弹窗）",
  );

  const toolIds = RIGHT_PANEL_TOOL_TABS.map((tool) => tool.id);
  assert.equal(new Set(toolIds).size, toolIds.length, "同一个 id 出现两次会让 tab 的 value 撞车");
  for (const id of toolIds) {
    assert.equal(isToolTabId(id), true);
  }
});

test("偏好里读到未知值 / null / 别的类型，一律回落成默认工具 tab", () => {
  for (const value of [undefined, null, "", "git-review", "treemapping", "content:src/a.ts", 7, {}, [], true]) {
    assert.equal(isToolTabId(value), false, `不该认成工具 id: ${String(value)}`);
    assert.equal(normalizeRightPanelTab(value), DEFAULT_RIGHT_PANEL_TAB);
  }

  for (const tool of RIGHT_PANEL_TOOL_TABS) {
    assert.equal(normalizeRightPanelTab(tool.id), tool.id, "已知 id 必须原样透传");
  }
});

test("文件 tab 的身份只看路径：同一个文件永远同一张 tab", () => {
  assert.equal(fileTabId("src/a.ts"), "file:src/a.ts");
  assert.equal(fileTabId("  src/a.ts  "), "file:src/a.ts", "前后空白不该拆出第二张 tab");
  // 模式（正文/改动）和来源（未暂存/已暂存/分支）都不是身份：它们决定这张 tab 此刻的内容，
  // 同一个文件在 strip 上出现两三个同名标签，用户分不清哪张是哪张。
  const a = fileTab("src/a.ts", "content");
  const b = fileTab("src/a.ts", "diff", "staged");
  assert.equal(a.id, b.id);
});

test("打开新 tab：追加到末尾并激活；同一个文件再点只复用（原地替换）", () => {
  const first = openPanelTab([toolTab("files")], "files", fileTab("src/a.ts"));
  assert.deepEqual(ids(first.tabs), ["files", "file:src/a.ts"]);
  assert.equal(first.activeTabId, "file:src/a.ts");

  const second = openPanelTab(first.tabs, first.activeTabId, fileTab("src/b.ts"));
  assert.deepEqual(ids(second.tabs), ["files", "file:src/a.ts", "file:src/b.ts"]);
  assert.equal(second.activeTabId, "file:src/b.ts");

  // 再点 a：不新增，激活已有的那张，并且**位置不变**（用户可能已经习惯了它在 strip 上的位置）。
  const again = openPanelTab(second.tabs, second.activeTabId, fileTab("src/a.ts"));
  assert.deepEqual(ids(again.tabs), ["files", "file:src/a.ts", "file:src/b.ts"]);
  assert.equal(again.activeTabId, "file:src/a.ts");
  assert.equal(again.tabs.length, 3);
});

test("同一个文件换模式 / 来源 / base：还是那一张 tab，只是内容换了", () => {
  const opened = openPanelTab([], "", fileTab("src/a.ts", "diff", "unstaged"));
  const switched = openPanelTab(opened.tabs, opened.activeTabId, {
    ...fileTab("src/a.ts", "diff", "branch"),
    base: "origin/main",
  });

  assert.equal(switched.tabs.length, 1, "一个文件只该有一张 tab");
  const tab = switched.tabs[0];
  assert.equal(tab.kind, "file");
  assert.equal(tab.kind === "file" ? tab.source : "", "branch", "来源要换到那张 tab 上");
  assert.equal(tab.kind === "file" ? tab.base : "", "origin/main", "新请求的 base 也要换进去");

  // 从「树里看正文」切到「看改动」：同一张 tab，模式变了。
  const asContent = openPanelTab(switched.tabs, switched.activeTabId, fileTab("src/a.ts", "content"));
  assert.equal(asContent.tabs.length, 1);
  assert.equal(asContent.tabs[0].kind === "file" ? asContent.tabs[0].mode : "", "content");
});

test("关 tab：关当前那张落到右邻居、没有右邻居落到左邻居；关别人不动激活项", () => {
  const tabs: RightPanelTab[] = [toolTab("capabilities"), fileTab("src/a.ts"), fileTab("src/b.ts")];

  const middle = closePanelTab(tabs, "file:src/a.ts", "file:src/a.ts");
  assert.deepEqual(ids(middle.tabs), ["capabilities", "file:src/b.ts"]);
  assert.equal(middle.activeTabId, "file:src/b.ts", "关中间那张要顺手把下一个抬上来");

  const last = closePanelTab(tabs, "file:src/b.ts", "file:src/b.ts");
  assert.equal(last.activeTabId, "file:src/a.ts", "关最后一张落到左邻居");

  const other = closePanelTab(tabs, "capabilities", "file:src/b.ts");
  assert.equal(other.activeTabId, "capabilities", "关的不是当前那张时激活项不许动");
  assert.deepEqual(ids(other.tabs), ["capabilities", "file:src/a.ts"]);

  // 关一个不存在的 id：原样返回，不能把面板清空。
  const missing = closePanelTab(tabs, "capabilities", "file:src/zzz.ts");
  assert.deepEqual(ids(missing.tabs), ids(tabs));
  assert.equal(missing.activeTabId, "capabilities");
});

test("全关掉之后没有激活项（面板这时显示「新标签页」）", () => {
  const only = closePanelTab([fileTab("src/a.ts")], "file:src/a.ts", "file:src/a.ts");
  assert.deepEqual(only.tabs, []);
  assert.equal(only.activeTabId, "");
  assert.equal(normalizeActivePanelTab([], ""), "");
});

test("关闭其他 / 选中项不存在时落到最后一个 tab", () => {
  const tabs: RightPanelTab[] = [toolTab("files"), fileTab("src/a.ts"), fileTab("src/b.ts")];
  const kept = closeOtherPanelTabs(tabs, "file:src/a.ts");
  assert.deepEqual(ids(kept.tabs), ["file:src/a.ts"]);
  assert.equal(kept.activeTabId, "file:src/a.ts");

  // 激活项被关掉（或偏好里存了个不存在的 id）→ 落到最后一个，和 ZCode 的 normalize 一致。
  assert.equal(normalizeActivePanelTab(tabs, "file:src/zzz.ts"), "file:src/b.ts");
  assert.deepEqual(ids(closeOtherPanelTabs(tabs, "nope").tabs), []);
});

test("tabFilePath：只有文件 tab 有路径（树 / 改动列表拿它做选中态）", () => {
  assert.equal(tabFilePath(fileTab("src/a.ts")), "src/a.ts");
  assert.equal(tabFilePath(fileTab("src/a.ts", "diff")), "src/a.ts");
  assert.equal(tabFilePath(toolTab("files")), "");
  assert.equal(tabFilePath(null), "");
});

test("每个工具 tab 的标签 / 提示 / 说明文案在 zh / en 两包都存在", () => {
  for (const tool of RIGHT_PANEL_TOOL_TABS) {
    for (const key of [tool.labelKey, tool.hintKey, tool.descriptionKey]) {
      assert.ok(key in zh, `zh.ts 缺 ${key}（工具 ${tool.id}）`);
      assert.ok(key in en, `en.ts 缺 ${key}（工具 ${tool.id}）`);
    }
  }

  for (const key of [
    "rightPanel.tab.addTab",
    "rightPanel.tab.close",
    "rightPanel.tab.closeOthers",
    "rightPanel.tab.closeAll",
    "rightPanel.launcher.title",
    "rightPanel.launcher.hint",
  ]) {
    assert.ok(key in zh, `zh.ts 缺 ${key}`);
    assert.ok(key in en, `en.ts 缺 ${key}`);
  }
});

test("内容框只有一种：每张 tab 自己钉住头部、正文自己滚", () => {
  assert.ok(RIGHT_PANEL_TAB_FRAME.includes("flex-col"), "tab 要自己钉住头部");
  assert.ok(RIGHT_PANEL_TAB_FRAME.includes("min-h-0"), "正文滚动区必须先能收缩");
  assert.ok(!RIGHT_PANEL_TAB_FRAME.includes("px-["), "正文要贴满面板宽度（水平内边距归各视图自己）");
  // 竖直内边距挂在 aside 上（codex 主题要覆盖 padding-top）：内容框里不许出现 pt-。
  assert.ok(!RIGHT_PANEL_TAB_FRAME.includes("pt-["), "竖直内边距不进内容框");
  // 组件得真的用上这个常量（两张 tabpanel：有激活项 / 一张没有时的空状态）。
  assert.equal(
    [...rightPanelSource.matchAll(/className=\{RIGHT_PANEL_TAB_FRAME\}/g)].length,
    2,
    "两个 tabpanel 都要用这个框",
  );
});

test("strip 不许把面板撑出滚动区，且 tab 可关 / 中键关 / 右键能关", () => {
  // 这条守的是一个量到过的真 bug：strip 比面板宽 → 父级 aside（overflow-hidden）也被撑出
  // scrollWidth > clientWidth，点一下 tab 浏览器为了露出焦点元素会把整块内容横推十几像素。
  assert.match(rightPanelSource, /min-w-0 flex-1[^"]*overflow-x-auto/, "标签视口自己负责横向溢出");
  assert.match(rightPanelSource, /max-w-\[9\.75rem\] min-w-0 shrink-0/, "tab 按内容宽度（上限 156px）且能收缩");
  assert.match(rightPanelSource, /data-right-panel-tab=\{tab\.id\}/, "给 e2e / 后续测试留一个稳定的选择器");
  assert.match(rightPanelSource, /onAuxClick=\{\(event\) => \{[\s\S]*?event\.button !== 1[\s\S]*?onCloseTab\(tab\.id\)/, "中键关闭");
  assert.match(rightPanelSource, /aria-label=\{t\("rightPanel\.tab\.close"\)\}/, "tab 上的关闭按钮要有无障碍名");
  assert.match(rightPanelSource, /rightPanel\.tab\.closeOthers/, "右键菜单要有「关闭其他」");
  assert.match(rightPanelSource, /rightPanel\.tab\.closeAll/, "右键菜单要有「全部关闭」");
});

test("不用 Radix 的 TabsTrigger（tab 里要放原生关闭按钮，button 套 button 会让事件错位）", () => {
  assert.ok(!rightPanelSource.includes("<TabsTrigger"), "手写 strip 是有意为之：见组件顶部注释");
  assert.ok(!rightPanelSource.includes('from "@/components/ui/tabs"'), "别再把 Radix 的 Tabs 引回来");
  assert.match(rightPanelSource, /role="tablist"/);
  assert.match(rightPanelSource, /role="tab"/);
  assert.match(rightPanelSource, /role="tabpanel"/);
});

test("tab 视觉：标题按内容宽度（不许 flex-1）、关闭按钮的 24px 要留出来", () => {
  // 这两条都对应量到过的真 bug：`flex-1` 的 flex-basis 是 0，tab 宽度会塌成「图标 + 内边距」，
  // 于是每个标题都被截成一个字母；ZCode 的 mask 渐隐在没有重叠风险时会反而把标题吃掉。
  assert.doesNotMatch(rightPanelSource, /min-w-0 flex-1 truncate/, "标题不能用 flex-1（宽度会塌）");
  assert.doesNotMatch(rightPanelSource, /mask-image/, "关闭按钮的空间已经用 pr-6 让出来了，不需要 mask 渐隐");
  assert.match(rightPanelSource, /px-2 pr-6/, "给关闭按钮留出位置，标题才不会被 X 压住");
});

test("strip 左边是标签页总览（打开的 tab + 最近关闭 + 搜索），并且能重开", () => {
  assert.match(rightPanelSource, /<PanelTabOverview/, "总览要在 strip 里");
  assert.match(rightPanelSource, /onReopenClosedTab=\{onReopenClosedTab\}/);

  const overviewSource = readFileSync(
    new URL("../src/features/workspace/PanelTabOverview.tsx", import.meta.url),
    "utf8",
  );
  assert.match(overviewSource, /role="button"/, "总览的行是可点的");
  assert.match(overviewSource, /data-right-panel-overview-tab=\{tab\.id\}/, "打开的 tab 一行一个");
  assert.match(overviewSource, /data-right-panel-overview-closed=\{entry\.tab\.id\}/, "最近关闭的 tab 也能重开");
  assert.match(overviewSource, /onReopenClosedTab\(entry\.tab\.id\)/, "点最近关闭 = 重开");
  assert.match(overviewSource, /relativeTimeLabel/, "打开/关闭时间显示成「3 分钟前」");
  assert.match(overviewSource, /ArrowDown/, "搜索框支持上下键选");
});

test("tab 可拖拽换位（原生 HTML5 DnD，拖的东西放 dataTransfer 而不是只靠 state）", () => {
  assert.match(rightPanelSource, /draggable/);
  assert.match(rightPanelSource, /dataTransfer\?\.setData\("text\/plain", tab\.id\)/);
  assert.match(rightPanelSource, /onMoveTab\(from, tab\.id\)/);
});

test("`+` 是加标签页下拉（ZCode 的 sidePane.addTab），不是一张新页面", () => {
  assert.match(rightPanelSource, /DropdownMenuTrigger asChild/, "`+` 要点开一个下拉");
  assert.match(rightPanelSource, /data-right-panel-add-tool=\{tool\.id\}/, "下拉项带上稳定的选择器");
  assert.match(rightPanelSource, /onSelect=\{\(\) => onOpenToolTab\(tool\.id\)\}/, "选一项就直接开那张 tab");
});
test("拖拽换位：往左拖插到目标前面，往右拖插到目标后面（ZCode reorderSidePaneTab 同）", () => {
  const tabs: RightPanelTab[] = [toolTab("capabilities"), fileTab("src/a.ts"), fileTab("src/b.ts")];

  // 把第 1 张拖到第 3 张的位置 → 插到它后面。
  assert.deepEqual(ids(movePanelTab(tabs, "capabilities", "file:src/b.ts")), [
    "file:src/a.ts",
    "file:src/b.ts",
    "capabilities",
  ]);

  // 把第 3 张拖到第 1 张的位置 → 插到它前面。
  assert.deepEqual(ids(movePanelTab(tabs, "file:src/b.ts", "capabilities")), [
    "file:src/b.ts",
    "capabilities",
    "file:src/a.ts",
  ]);

  // 原地、未知 id 都原样返回（不能把 tab 弄丢）。
  assert.deepEqual(ids(movePanelTab(tabs, "file:src/a.ts", "file:src/a.ts")), ids(tabs));
  assert.deepEqual(ids(movePanelTab(tabs, "nope", "file:src/a.ts")), ids(tabs));
  assert.deepEqual(ids(movePanelTab(tabs, "file:src/a.ts", "nope")), ids(tabs));
});

test("最近关闭：新的在最前、按 id 去重、最多 8 条", () => {
  const first = rememberClosedPanelTabs([], [fileTab("src/a.ts")], 1000);
  assert.deepEqual(
    first.map((entry) => entry.tab.id),
    ["file:src/a.ts"],
  );
  assert.equal(first[0]!.closedAt, 1000);

  const second = rememberClosedPanelTabs(first, [fileTab("src/b.ts"), toolTab("git")], 2000);
  assert.deepEqual(
    second.map((entry) => entry.tab.id),
    ["file:src/b.ts", "git", "file:src/a.ts"],
    "后关的排在前面，ZCode 也是 prepend",
  );

  // 同一个 id 又关一次：只留最新那条，不出现两份。
  const again = rememberClosedPanelTabs(second, [fileTab("src/a.ts")], 3000);
  assert.deepEqual(
    again.map((entry) => entry.tab.id),
    ["file:src/a.ts", "file:src/b.ts", "git"],
  );

  // 上限 8 条（再多就只有最近关的那些）。
  let list = rememberClosedPanelTabs([], [], 0);
  for (let index = 0; index < RECENT_CLOSED_PANEL_TAB_LIMIT + 4; index += 1) {
    list = rememberClosedPanelTabs(list, [fileTab(`src/f${index}.ts`)], index);
  }
  assert.equal(list.length, RECENT_CLOSED_PANEL_TAB_LIMIT);
  assert.equal(list[0]!.tab.kind === "file" ? list[0]!.tab.path : "", `src/f${RECENT_CLOSED_PANEL_TAB_LIMIT + 3}.ts`);

  // 空输入：原样返回（不要白造一个新数组把引用弄脏）。
  assert.deepEqual(rememberClosedPanelTabs(list, [], 999).length, list.length);
  assert.deepEqual(
    forgetRecentClosedPanelTab(again, "file:src/b.ts").map((entry) => entry.tab.id),
    ["file:src/a.ts", "git"],
  );
});

test("复用同一个文件时保留 openedAt（总览里的「3 分钟前」不该被重置成「刚刚」）", () => {
  const opened = openPanelTab([], "", { ...fileTab("src/a.ts"), openedAt: 111 });
  const again = openPanelTab(opened.tabs, opened.activeTabId, {
    ...fileTab("src/a.ts", "diff", "staged"),
    openedAt: 999,
  });

  assert.equal(again.tabs.length, 1);
  assert.equal(again.tabs[0]!.openedAt, 111, "复用的是身份：打开时间留在原来那张上");
});

test("带补丁的审查 tab 与同一个文件的正文 tab 是同一张（按路径复用，补丁随内容替换）", () => {
  const opened = openPanelTab([toolTab("git")], "git", {
    kind: "file",
    id: fileTabId("src/a.ts"),
    path: "src/a.ts",
    mode: "diff",
    source: "unstaged",
    patch: "@@ -1 +1 @@\n-a\n+b\n",
    openedAt: 1,
  });
  const reused = openPanelTab(opened.tabs, opened.activeTabId, {
    kind: "file",
    id: fileTabId("src/a.ts"),
    path: "src/a.ts",
    mode: "content",
    openedAt: 2,
  });
  // 一个文件一个 tab：换模式不再多一张。
  assert.equal(reused.tabs.length, 2);
  const fileTab = reused.tabs.find((tab) => tab.kind === "file");
  assert.equal(fileTab?.kind === "file" ? fileTab.mode : "", "content");
  // 复用时不重置打开时间（总览里的「3 分钟前」）。
  assert.equal(fileTab?.openedAt, 1);
});
