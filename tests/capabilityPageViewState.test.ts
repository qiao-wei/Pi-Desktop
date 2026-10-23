/**
 * 「全局技能与扩展」页是覆盖在会话上的，不是替换会话。原先的写法是
 * `activeMainView === "capabilities" ? <CapabilitiesPage /> : <section conversation …>`：
 * 切过去会把会话整块卸载，composer 的正文只存在 contentEditable DOM 里（composerText 是
 * 派生值），于是草稿连同会话滚动位置一起没了。这里钉住两件事：
 * - 会话区始终挂载，页面用绝对定位盖上去，被遮住的聊天用 inert 移出 Tab 顺序；
 * - 页面标签页（技能 / Packages）跟着页面实例被卸载，所以选择落在 ui-preferences 里。
 *
 * App.tsx 是 .tsx，node --test 只能按源码断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appSource as readAppSource } from "./lib/appSource.ts";

const appSourceText = readAppSource();
const prefsSource = readFileSync(new URL("../src/lib/ui-preferences.ts", import.meta.url), "utf8");

/** Source of a top-level `function name(...) { ... }`, delimited at the next flush-left brace. */
function topLevelFunctionSource(name: string): string {
  const start = appSourceText.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = appSourceText.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return appSourceText.slice(start, end);
}

test("the conversation surface stays mounted while the Global page is open", () => {
  // 不能再退回「二选一渲染」：那正是丢草稿的原因。
  assert.doesNotMatch(
    appSourceText,
    /activeMainView === "capabilities" \? \(\s*<CapabilitiesPage/,
    "the capabilities page must not replace the conversation section",
  );
  // 按 token 断言而不是整串 className：codex 主题会给这层加一个 `conversation-column`
  // class（用来把会话列抬到窗口顶部），整串匹配会把它误判成回归。
  // 会话区 <section> 现在住在 `ComposerRegion.tsx`：宿主里那个栅格格子直接渲染它。
  const host = /<div\s+className="([^"]*)"\s*>\s*<ComposerRegion\b/.exec(appSourceText)?.[1];
  assert.ok(host, "找不到包住会话区的那个栅格格子");
  for (const token of ["relative", "h-full", "min-h-0", "min-w-0", "overflow-hidden"]) {
    assert.ok(
      host.split(/\s+/).includes(token),
      `覆盖层宿主必须保留 ${token}（定位 / 裁剪 / 栅格列都靠它）：${host}`,
    );
  }
  assert.match(
    appSourceText,
    /inert=\{activeMainView === "capabilities"\}/,
    "the covered chat must leave the tab order and stop receiving clicks",
  );
  assert.match(
    appSourceText,
    /<div className="absolute inset-0 z-20">\s*<CapabilitiesPage/,
    "the page is drawn over the conversation, not instead of it",
  );
});

test("inert lands on the covered conversation, never on the page itself", () => {
  // 会话区（带 inert 的 <section>）与覆盖层现在分居两个文件，所以不能再靠「在整篇源码里谁的
  // 下标更小」来断言覆盖层不在 section 里 —— 直接看 <section> 的开始标签与它的内容。
  const sectionTag = /<section\b[^>]*className="conversation-surface[^>]*>/.exec(appSourceText)?.[0];
  assert.ok(sectionTag, "找不到会话区的 <section> 开始标签");
  assert.match(
    sectionTag,
    /inert=\{activeMainView === "capabilities"\}/,
    "inert 必须落在会话 <section> 自己的开始标签上（落在祖先上会把盖在它上面的页面一起禁掉）",
  );

  const overlayAt = appSourceText.indexOf('<div className="absolute inset-0 z-20">');
  assert.notEqual(overlayAt, -1, "覆盖层宿主不见了");
  const sectionAt = appSourceText.indexOf(sectionTag);
  assert.ok(overlayAt < sectionAt || sectionAt < 0, "覆盖层不能被放进会话区里面");
});

test("the Global page remembers the last tab across visits and restarts", () => {
  const page = topLevelFunctionSource("CapabilitiesPage");

  assert.match(
    page,
    /useState<CapabilityScopeTab>\(\(\) => loadUiPreferences\(\)\.capabilityScopeTab \?\? "skill"\)/,
    "the tab initializes from the persisted preference",
  );
  assert.match(
    page,
    /function selectTab\(next: CapabilityScopeTab\) \{\s*setTab\(next\);\s*saveUiPreferences\(\{ capabilityScopeTab: next \}\);\s*\}/,
    "picking a tab must persist it, or the unmounted page resets to skills",
  );
  assert.match(page, /onClick=\{\(\) => selectTab\(value\)\}/, "the tab buttons must go through selectTab");

  assert.match(prefsSource, /capabilityScopeTab\?: "skill" \| "package"/, "the preference is persisted");
  assert.match(prefsSource, /缺省 = 技能/);
});