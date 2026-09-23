/**
 * 包命令面板：搜索过滤规则 + 「滚动条要画出来」。
 *
 * 背景（2026-09-22 用户实测，截图）：pi-subagents 有 19 条 `/` 命令，面板按可用高度
 * （窗口不高时 ~370px）截断在那一列里，而且正好断在两行之间；macOS 的原生 overlay 滚动条
 * 不滚动就不画，于是看起来就是「action 较多的时候显示不全」。修法三条腿：
 *   ① 命令多时顶上钉一个搜索框（过滤规则 = 纯函数，单测直接跑）；
 *   ② 列表自己滚，滚动条交给 AutoHideScroll 的常驻模式画（不依赖平台画不画原生条）；
 *   ③ 面板顶部避开应用的标题条，否则搜索框整条被盖住。
 * 纯布局/DOM 行为在 node 里跑不了，所以这一部分按仓库惯例做「区域限定」的结构断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { filterPackageCommands } from "../src/shared/capabilityCommands.ts";
import type { CapabilityCommand } from "../src/types/domain.ts";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

const commands: CapabilityCommand[] = [
  { name: "run", description: "Run one subagent through workflowScript" },
  { name: "subagents-steer", description: "Steer a live async subagent run" },
  { name: "subagents-refresh-provider-models", description: "Refresh provider model catalogs" },
  { name: "subagents-doctor" },
];

/* ------------------------------ 过滤规则 ---------------------------------- */

test("空查询原样返回同一份数组（渲染时不要每帧都造新列表）", () => {
  assert.equal(filterPackageCommands(commands, ""), commands);
  assert.equal(filterPackageCommands(commands, "   "), commands);
});

test("按命令名匹配，忽略大小写", () => {
  assert.deepEqual(
    filterPackageCommands(commands, "DOCTOR").map((command) => command.name),
    ["subagents-doctor"],
  );
});

test("照着命令的样子打（前导 `/`）也能搜到", () => {
  assert.deepEqual(
    filterPackageCommands(commands, "/subagents-doctor").map((command) => command.name),
    ["subagents-doctor"],
  );
  // 斜杠只是被打字习惯带进来的，不当成搜索词的一部分：`/run` 仍然会命中描述里有 run 的命令。
  assert.deepEqual(
    filterPackageCommands(commands, "/run").map((command) => command.name),
    ["run", "subagents-steer"],
  );
});

test("描述里的词也算命中", () => {
  assert.deepEqual(
    filterPackageCommands(commands, "catalogs").map((command) => command.name),
    ["subagents-refresh-provider-models"],
  );
});

test("多个词按 AND 命中名字+描述，跟打的顺序无关", () => {
  assert.deepEqual(
    filterPackageCommands(commands, "steer async").map((command) => command.name),
    ["subagents-steer"],
  );
  assert.deepEqual(
    filterPackageCommands(commands, "async steer").map((command) => command.name),
    ["subagents-steer"],
  );
});

test("没有命中就是空列表，而不是退化成全部", () => {
  assert.deepEqual(filterPackageCommands(commands, "zzz-nothing"), []);
});

test("没有 description 的命令只按名字匹配，不会因此被漏掉", () => {
  assert.deepEqual(
    filterPackageCommands(commands, "doctor").map((command) => command.name),
    ["subagents-doctor"],
  );
});

/* ------------------------- 面板：可滚动 + 看得见 --------------------------- */

test("命令面板按可用高度滚动，滚动条常驻画出来", () => {
  const start = appSource.indexOf("function CapabilityCommandMenu(");
  assert.notEqual(start, -1, "CapabilityCommandMenu is gone from App.tsx");
  const menu = appSource.slice(start, appSource.indexOf("\n}\n", start));

  assert.match(
    menu,
    /<AutoHideScroll className="min-h-0 flex-1" thumbAlwaysVisible>/,
    "列表要放在 AutoHideScroll 的常驻模式里：一打开就要看得见滚动条（macOS 的原生 overlay 条不滚动不画）",
  );
  assert.match(menu, /<\/AutoHideScroll>/, "命令行必须在滚动容器里面");
  assert.doesNotMatch(
    menu,
    /::-webkit-scrollbar/,
    "不要自己写 ::-webkit-scrollbar：平台走 overlay 时它不生效（手测 offsetWidth-clientWidth 还是 0），\n" +
      "真机又可能占一条 classic gutter —— 和 .autohide-box 的隐藏规则也打架",
  );
  assert.match(menu, /max-h-\[var\(--radix-popover-content-available-height/, "按 Radix 量的可用高度封顶");
});

test("AutoHideScroll 的常驻模式：溢出就画条，且不跟滚动淡出", () => {
  const source = readFileSync(new URL("../src/components/AutoHideScroll.tsx", import.meta.url), "utf8");

  assert.match(source, /thumbAlwaysVisible\?: boolean/, "常驻模式必须是一个显式开关，默认行为不变");
  assert.match(
    source,
    /if \(thumbAlwaysVisible\) \{\s*return;\s*\}/,
    "常驻模式下不能再挂 700ms 的淡出定时器，否则条还是会消失",
  );
  assert.match(
    source,
    /thumb\.classList\.toggle\("is-visible", overflowing\)/,
    "常驻模式要按「是否溢出」维持可见状态（不溢出时别留一条死滑块）",
  );
});

test("面板顶部要避开应用标题条，否则搜索框会被 z-[100] 的标题条盖住", () => {
  const menu = appSource.slice(
    appSource.indexOf("function CapabilityCommandMenu("),
    appSource.indexOf("\n}\n", appSource.indexOf("function CapabilityCommandMenu(")),
  );
  const inset = Number(
    appSource.match(/const CAPABILITY_COMMAND_MENU_TOP_INSET = (\d+);/)?.[1] ?? "0",
  );

  // 标题条高度住在 styles.css，实际值拿来比，改了高度忘了改内缩就会红。
  const styles = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
  const titlebar = Number(styles.match(/--titlebar-height:\s*(\d+)px/)?.[1] ?? "0");
  assert.ok(titlebar > 0, "--titlebar-height 不见了");
  assert.ok(
    inset > titlebar,
    `标题条是 ${titlebar}px，内缩只有 ${inset}px：Radix 会把面板顶到标题条下面去`,
  );
  assert.match(
    menu,
    /collisionPadding=\{\{ top: CAPABILITY_COMMAND_MENU_TOP_INSET/,
    "顶部内缩要真的交给 Radix（collisionPadding），否则只是个常量",
  );
});

test("搜索框只在命令多的时候出现，并且用共享的纯函数过滤", () => {
  const start = appSource.indexOf("function CapabilityCommandMenu(");
  const menu = appSource.slice(start, appSource.indexOf("\n}\n", start));

  assert.match(menu, /const searchable = commands\.length > CAPABILITY_COMMAND_SEARCH_THRESHOLD/);
  assert.match(menu, /const matches = filterPackageCommands\(commands, query\)/);
  assert.match(menu, /placeholder=\{t\("capability\.card\.commandsSearch", \{ count: commands\.length \}\)\}/);
  assert.match(menu, /aria-label=\{t\("capability\.card\.commandsSearchAria"\)\}/);
  assert.match(menu, /t\("capability\.card\.commandsEmpty"\)/, "搜不到要有空态，不能留一片空白");
});