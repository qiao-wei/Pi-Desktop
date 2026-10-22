/**
 * 「改动」面板的 review 形态（2026-10-21 用户按 ZCode 的截图反馈后改的）。
 *
 * 这里钉三件事：
 * - **行是开关，不是「另开一张标签页」**：单击就地展开这份文件的 diff，所以扫十个文件不会
 *   攒十张标签页；「在标签页里打开 / 看正文 / 用 IDE 打开」改走行上的右键菜单（能力不丢）。
 * - **行上要在折叠态就能看出规模**：`+N −M`（服务端 numstat 给的，分支来源那条路也要有），
 *   以及「谁改的」状态字母 —— 没有这两样，用户得逐个点开才知道该看哪个。
 * - **展开后的正文按服务端的 availability 分流**：有补丁走 DiffViewer（读得到全文就带
 *   「N 行未改动」上下文），二进制 / 被截断 / 读失败各有各的文案和重试，不许「有补丁就画」。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";
import {
  MAX_RICH_DIFF_FULL_CONTENT_CHARS,
  MAX_RICH_DIFF_FULL_CONTENT_LINES,
  canRenderRichWorkspaceDiff,
  countDiffContentLines,
  normalizeChangedFilesResponse,
} from "../src/shared/workspaceDiff.ts";

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const gitPaneSource = read("src/features/workspace/GitPane.tsx");
const changeCardSource = read("src/features/workspace/ChangeCard.tsx");
const appSource = read("src/app/App.tsx");

test("改动行单击就地展开：一次只开一张，收起由同一个按钮负责", () => {
  assert.match(gitPaneSource, /const \[expandedPath, setExpandedPath\] = useState\(""\)/);
  assert.match(gitPaneSource, /isExpanded=\{file\.path === expandedPath\}/);
  assert.match(changeCardSource, /aria-expanded=\{isExpanded\}/);
  assert.match(changeCardSource, /onClick=\{\(\) => onToggle\(path\)\}/);
  assert.match(changeCardSource, /rotate-180/, "展开态要有朝上的箭头");
  // 行本身的点击不能再跳到「打开标签页」那条路上去 —— 那样就又回到点十个文件攒十张标签页。
  assert.doesNotMatch(changeCardSource, /onClick=\{\(\) => onOpenDiffInTab\(path\)\}/);
  assert.match(changeCardSource, /onOpenDiff=\{onOpenDiffInTab\}/, "标签页那条路留在右键菜单里");
});

test("展开时才去读 diff，按「来源 + 路径」存，换来源整份作废", () => {
  assert.match(gitPaneSource, /if \(!isOpen\) \{\s*void loadDiff\(path\);/);
  assert.match(gitPaneSource, /function changeDiffKey\(source: WorkspaceDiffSource, path: string\): string/);
  assert.match(gitPaneSource, /diffState=\{diffByKey\[changeDiffKey\(source, file\.path\)\] \?\? null\}/);
  // 在途响应的序号：连点两下 / 边读边换来源时，迟到的那个不许写回来。
  assert.match(gitPaneSource, /const diffSequence = useRef\(0\)/);
  assert.match(gitPaneSource, /if \(diffSequence\.current !== sequence\) \{\s*return;/);
  assert.match(gitPaneSource, /useEffect\(\(\) => \{\s*diffSequence\.current \+= 1;\s*setDiffByKey\(\{\}\);\s*\}, \[source\]\)/);
});

test("分支来源展开时要把 base 原样交回去（否则服务端解不出基准）", () => {
  assert.match(gitPaneSource, /const \[branchBase, setBranchBase\] = useState\(""\)/);
  assert.match(gitPaneSource, /setBranchBase\(parsed\.base\)/);
  assert.match(gitPaneSource, /base: source === "branch" \? branchBase : undefined/);
  assert.match(gitPaneSource, /if \(source === "branch" && !branchBase\) \{\s*return;/);
  // 右键菜单里「在标签页打开」那一档也要带上同一个 base。
  assert.match(gitPaneSource, /onOpenDiff\(path, source, branchBaseForTab\)/);
  assert.match(appSource, /onOpenDiff=\{\(path, source, base\) => openWorkspacePreview\(path, source, base\)\}/);
  assert.match(appSource, /panelTabs\.openDiff\(\{ path, source, base \}\)/);
  // 就地展开也要语法高亮，明暗档跟着应用主题走。
  assert.match(appSource, /themeMode=\{theme\}\s+onRefresh=\{\(\) => void projectGit\.refresh\(\)\}/);
});

test("行上折叠态就显示状态字母与 +N −M，统计为 0 时不留一个空位", () => {
  assert.match(changeCardSource, /const showStats = added > 0 \|\| removed > 0;/);
  assert.match(changeCardSource, /gitStatusLetter\(status\)/);
  assert.match(changeCardSource, /\+{added\}/);
  assert.match(changeCardSource, /−\{removed\}/);
  assert.match(changeCardSource, /<ChevronDown/);
  // 目录是次要信息（面板只有 ~340px）：让文件名先占，目录先截断。
  assert.match(changeCardSource, /fileNameOf\(path\)/);
  assert.match(changeCardSource, /parentDirectory\(path\)/);
});

test("展开后的正文四种情况各有出口，绝不把非补丁画成补丁", () => {
  assert.match(changeCardSource, /const hasPatch = Boolean\(diff && diff\.availability === "patch" && diff\.patch && diff\.patch\.trim\(\)\)/);
  assert.match(changeCardSource, /diffState\?\.isLoading && !diff/);
  assert.match(changeCardSource, /diffState\?\.error/);
  assert.match(changeCardSource, /onRetry\(path\)/, "读失败要能重试");
  assert.match(changeCardSource, /!diffState\?\.isLoading && !hasPatch/);
  assert.match(changeCardSource, /diff\?\.summary \?\? t\("git\.diff\.unavailable"\)/);
  // 有补丁时把两侧全文一起给渲染器（读得到才有「N 行未改动」那套上下文）。
  assert.match(changeCardSource, /beforeContent=\{diff\.beforeContent\}/);
  assert.match(changeCardSource, /afterContent=\{diff\.afterContent\}/);
  // 长行 diff 不被 340px 裁掉：横向滚动开在卡片这一层。
  assert.match(changeCardSource, /mr-\[18px\] min-w-0 overflow-x-auto overflow-y-hidden/);
});

test("改动清单的行数归一化：非法值归 0，summary 非空时清空清单", () => {
  const parsed = normalizeChangedFilesResponse({
    source: "branch",
    base: "abc123",
    summary: "",
    files: [
      { path: "src/a.ts", status: "modified", added: 12, removed: 3 },
      { path: "src/b.ts", status: "added" },
      { path: "src/c.ts", status: "deleted", added: -5, removed: Number.NaN },
      { path: "", status: "modified", added: 1 },
    ],
  });

  assert.ok(parsed);
  assert.equal(parsed.base, "abc123");
  assert.deepEqual(
    parsed.files.map((file) => [file.path, file.added, file.removed]),
    [
      ["src/a.ts", 12, 3],
      // 数不出来就是 0（渲染层据此不显示统计，而不是显示「+0 −0」）。
      ["src/b.ts", 0, 0],
      ["src/c.ts", 0, 0],
    ],
    "负数和 NaN 都归 0；没有路径的行直接丢掉",
  );

  const unavailable = normalizeChangedFilesResponse({
    source: "branch",
    base: "abc123",
    summary: "Current branch has no upstream branch to compare with.",
    files: [{ path: "src/a.ts", status: "modified", added: 1, removed: 1 }],
  });
  assert.ok(unavailable);
  assert.deepEqual(unavailable.files, [], "列不出来时不许留着上一次的清单");
  assert.match(unavailable.summary, /no upstream branch/);
});

test("行数：末尾换行不多算一行，空内容算 0 行", () => {
  assert.equal(countDiffContentLines(null), 0);
  assert.equal(countDiffContentLines(""), 0);
  assert.equal(countDiffContentLines("a"), 1);
  assert.equal(countDiffContentLines("a\n"), 1);
  assert.equal(countDiffContentLines("a\nb"), 2);
  assert.equal(countDiffContentLines("a\nb\n"), 2);
});

test("富渲染的使用条件：两侧齐 + 篇幅在上限内，超限退回落差补丁", () => {
  // 上限与 ZCode 同值（180k 字符 / 1200 行）：点开大文件时不能让主线程同步比整篇。
  assert.equal(MAX_RICH_DIFF_FULL_CONTENT_CHARS, 180_000);
  assert.equal(MAX_RICH_DIFF_FULL_CONTENT_LINES, 1_200);

  assert.equal(canRenderRichWorkspaceDiff(null), false);
  assert.equal(canRenderRichWorkspaceDiff({}), false);
  assert.equal(canRenderRichWorkspaceDiff({ beforeContent: "a\n", afterContent: "b\n" }), true);
  // 只来一侧：服务端没读完整，不能让渲染层当空文件去画整篇增/删。
  assert.equal(canRenderRichWorkspaceDiff({ beforeContent: "a\n", afterContent: null }), false);
  assert.equal(canRenderRichWorkspaceDiff({ beforeContent: null, afterContent: "a\n" }), false);

  // 边界：正好在上限上仍可富渲染，超一个就退。
  const justUnder = "x".repeat(MAX_RICH_DIFF_FULL_CONTENT_CHARS - 1);
  assert.equal(canRenderRichWorkspaceDiff({ beforeContent: justUnder, afterContent: "" }), true);
  assert.equal(
    canRenderRichWorkspaceDiff({ beforeContent: `${justUnder}x`, afterContent: "" }),
    true,
    "总字符数正好等于上限还是富渲染",
  );
  assert.equal(
    canRenderRichWorkspaceDiff({ beforeContent: `${justUnder}xx`, afterContent: "" }),
    false,
    "超出一个字符就该退",
  );

  const linesAtLimit = `${"x\n".repeat(MAX_RICH_DIFF_FULL_CONTENT_LINES - 1)}x`;
  assert.equal(countDiffContentLines(linesAtLimit), MAX_RICH_DIFF_FULL_CONTENT_LINES);
  assert.equal(canRenderRichWorkspaceDiff({ beforeContent: linesAtLimit, afterContent: "x" }), true);
  assert.equal(
    canRenderRichWorkspaceDiff({ beforeContent: `${linesAtLimit}\nx`, afterContent: "x" }),
    false,
    "行数超限就该退",
  );
});

test("改动面板用到的文案两套都有", () => {
  for (const [pack, source] of [["zh", zh], ["en", en]] as const) {
    for (const key of ["git.diff.loading", "git.diff.retry", "git.diff.unavailable", "git.diff.loadFailed"]) {
      assert.ok(key in source, `${pack} 缺 ${key}`);
    }
  }
});