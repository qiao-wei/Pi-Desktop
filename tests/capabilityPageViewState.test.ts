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

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const prefsSource = readFileSync(new URL("../src/lib/ui-preferences.ts", import.meta.url), "utf8");

/** Source of a top-level `function name(...) { ... }`, delimited at the next flush-left brace. */
function topLevelFunctionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = appSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return appSource.slice(start, end);
}

test("the conversation surface stays mounted while the Global page is open", () => {
  // 不能再退回「二选一渲染」：那正是丢草稿的原因。
  assert.doesNotMatch(
    appSource,
    /activeMainView === "capabilities" \? \(\s*<CapabilitiesPage/,
    "the capabilities page must not replace the conversation section",
  );
  // 按 token 断言而不是整串 className：codex 主题会给这层加一个 `conversation-column`
  // class（用来把会话列抬到窗口顶部），整串匹配会把它误判成回归。
  const host = /<div\s+className="([^"]*)"\s*>\s*<section\s+className="conversation-surface/.exec(
    appSource,
  )?.[1];
  assert.ok(host, "找不到包住会话区的那个栅格格子");
  for (const token of ["relative", "h-full", "min-h-0", "min-w-0", "overflow-hidden"]) {
    assert.ok(
      host.split(/\s+/).includes(token),
      `覆盖层宿主必须保留 ${token}（定位 / 裁剪 / 栅格列都靠它）：${host}`,
    );
  }
  assert.match(
    appSource,
    /inert=\{activeMainView === "capabilities"\}/,
    "the covered chat must leave the tab order and stop receiving clicks",
  );
  assert.match(
    appSource,
    /<div className="absolute inset-0 z-20">\s*<CapabilitiesPage/,
    "the page is drawn over the conversation, not instead of it",
  );
});

test("inert lands on the covered conversation, never on the page itself", () => {
  const inertAt = appSource.indexOf('inert={activeMainView === "capabilities"}');
  assert.notEqual(inertAt, -1, "the inert gate is gone");
  const pageAt = appSource.indexOf("<div className=\"absolute inset-0 z-20\">");
  assert.notEqual(pageAt, -1, "the overlay host is gone");
  assert.ok(inertAt < pageAt, "inerting the overlay's ancestor would disable the page");
  // It is the conversation <section> that goes inert, so the attribute must sit on its start tag.
  const sectionOpen = appSource.lastIndexOf("<section", inertAt);
  assert.ok(sectionOpen >= 0 && sectionOpen < inertAt, "inert must be on the conversation section");
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