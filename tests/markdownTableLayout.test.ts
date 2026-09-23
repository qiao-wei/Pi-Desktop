/**
 * 聊天 markdown 表格：窄窗口下不许把整页撑出横向滚动条，单元格之间要有可见分隔线。
 *
 * 背景（用户实测）：会话里一张宽表（长 inline-code 配置字符串）会顶破 44rem 的
 * 正文列，让 thread viewport 出现左右滚动条；同时单元格边框用
 * `border-muted-foreground/20`（浅色主题下 ~20% 灰度）几乎看不见，读起来像没有分隔线。
 *
 * 修复口径：
 * - 表格外包一层 `overflow-x-auto` 的 wrapper。`overflow` 直接写在 `<table>` 上永远
 *   不会生成滚动容器（display: table 不是 scroll container），所以原来那张表的宽度
 *   直接变成了父级的最小内容宽度；
 * - 单元格加 `[overflow-wrap:anywhere]`。正文继承的 `wrap-break-word`（break-word）
 *   不影响 min-content 宽度，一个长 token 就足以把列顶宽；`anywhere` 才会收缩列宽；
 * - 边框换成主题 `border`（可见），并补上表头上边框与最后一列的右边框，让网格闭合。
 *
 * 纯样式值在 node 里跑不了布局，按仓库惯例（chatTypography.test.ts / composerResponsive.test.ts）
 * 做「区域限定」的结构断言：先切出组件区间，再在区间内检查，避免被同文件别处的写法假绿。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const markdownTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/markdown-text.tsx", import.meta.url),
  "utf8",
);

/** 取 `key: ({ className, ...props }) => (` 到下一个同级组件键之间的源码区间。 */
function componentRegion(source: string, key: string, nextKey: string): string {
  const start = source.indexOf(`${key}: ({ className, ...props }) =>`);
  assert.ok(start >= 0, `找不到组件: ${key}`);
  const end = source.indexOf(`${nextKey}: ({`, start);
  assert.ok(end > start, `找不到 ${key} 的结束锚点: ${nextKey}`);
  return source.slice(start, end);
}

/**
 * 区间内所有双引号字符串字面量。
 *
 * 组件里的类名写在 `className={cn("...", className)}` 里，所以只找 `className=`
 * 前缀会全都漏掉；这里直接收字面量，再由调用方按锚点类过滤。
 */
function classNamesIn(region: string): string[] {
  const found: string[] = [];
  const re = /"([^"\n]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(region)) !== null) found.push(match[1]);
  return found;
}

const hasClass = (className: string, token: string) =>
  className.split(/\s+/).includes(token);

const tableRegion = componentRegion(markdownTsx, "table", "th");
const thRegion = componentRegion(markdownTsx, "th", "td");
const tdRegion = componentRegion(markdownTsx, "td", "tr");

test("表格被 overflow-x-auto 的 wrapper 包住，滚动发生在表格内部而不是整页", () => {
  const wrapper = classNamesIn(tableRegion).find((c) =>
    c.includes("aui-md-table-wrapper"),
  );
  assert.ok(wrapper, "table 组件应返回 aui-md-table-wrapper 包装层");
  assert.ok(
    hasClass(wrapper, "overflow-x-auto"),
    `wrapper 要能横向滚动，否则宽表会顶破正文列（当前：${wrapper}）`,
  );
  assert.ok(
    hasClass(wrapper, "max-w-full"),
    `wrapper 不应超过正文列宽（当前：${wrapper}）`,
  );
  assert.ok(
    tableRegion.includes('data-slot="aui_md-table-wrapper"'),
    "wrapper 需要 data-slot 便于定位/测试",
  );

  const table = classNamesIn(tableRegion).find((c) => hasClass(c, "aui-md-table"));
  assert.ok(table, "wrapper 里应有 aui-md-table");
  assert.ok(
    !hasClass(table, "overflow-x-auto") && !hasClass(table, "overflow-y-auto"),
    `overflow 写在 <table> 上不生效，滚动容器只能是 wrapper（当前：${table}）`,
  );
});

test("单元格用可见的 border，且网格四边闭合", () => {
  const th = classNamesIn(thRegion).find((c) => hasClass(c, "aui-md-th"));
  const td = classNamesIn(tdRegion).find((c) => hasClass(c, "aui-md-td"));
  assert.ok(th && td, "th / td 都要有 aui-md 锚点类");

  for (const [name, className] of [
    ["th", th],
    ["td", td],
  ] as const) {
    assert.ok(
      hasClass(className, "border-border"),
      `${name} 应使用主题 border 色（可见），而不是 muted-foreground/20（当前：${className}）`,
    );
    assert.ok(
      !className.includes("border-muted-foreground/20"),
      `${name} 不应再使用几乎看不见的 20% 边框色（当前：${className}）`,
    );
    assert.ok(
      hasClass(className, "border-s") && hasClass(className, "border-b"),
      `${name} 需要左边框（列分隔线）与下边框（行分隔线）（当前：${className}）`,
    );
    assert.ok(
      hasClass(className, "last:border-e"),
      `${name} 最后一列需要右边框，否则表格右侧开口（当前：${className}）`,
    );
    assert.ok(
      hasClass(className, "[overflow-wrap:anywhere]"),
      `${name} 需要 anywhere 换行，长 token 才不会把列顶宽（当前：${className}）`,
    );
  }

  assert.ok(
    hasClass(th, "border-t"),
    `表头需要上边框，否则表格顶部开口（当前：${th}）`,
  );
});