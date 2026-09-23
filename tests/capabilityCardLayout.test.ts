/**
 * 能力市场卡片的资源 tag 行必须横跨整张卡，不能留在中间列里。
 *
 * 背景（用户实测 + 真机量过）：卡片是 `grid-cols-[40px_minmax(0,1fr)_auto]`，中间列在
 * 3 列布局（1440px）下只有 119px、2 列布局（1240px）下 205px，而四个 tag 一行需要 ~287px。
 * 于是 tag 只能换行——换出来的第二行旁边，正好是操作列（设置/删除/置顶/开关，128px）*下方*
 * 的空网格单元：操作只有一行高，那片空间 tag 行流不过去，看起来就是「空白没利用上」。
 *
 * 修复口径：tag 行从中间列挪出来，做成跨三列（`col-span-3`）的独立一行。全卡内容宽度
 * 315–401px > 287px，四个 tag 一行放下，操作列下方的空间也被用上。
 *
 * 纯布局在 node 里跑不了，按仓库惯例（markdownTableLayout.test.ts）做「区域限定」的结构断言：
 * 先切出卡片组件区间，再在区间内检查。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** 取顶层 `function name(...) { ... }` 的源码（到下一个顶格 `}` 结束）。 */
function topLevelFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return source.slice(start, end);
}

const card = topLevelFunctionSource(appSource, "CapabilityMarketCard");

test("市场卡片：资源 tag 行跨满整卡，而不是挤在中间列里", () => {
  assert.match(
    card,
    /<div className="col-span-3 min-w-0">\s*<CapabilityResourceChips item=\{item\} onOpen=\{onOpenResources\} \/>/,
    "tag 行必须是跨三列的独立一行，否则中间列放不下四个 tag，会和操作列下方的空白一起表现为「tag 换行 + 一大片空白」",
  );
});

test("市场卡片：中间列只剩标题，不再承载 tag 行", () => {
  const middleStart = card.indexOf('"grid min-w-0 content-start justify-items-start gap-1"');
  assert.notEqual(middleStart, -1, "中间列（标题列）不见了");
  // 中间列的区间到操作列起点为止；tag 行必须在这个区间之外。
  const actionsStart = card.indexOf('className="flex items-center gap-1"', middleStart);
  assert.ok(actionsStart > middleStart, "操作列锚点不见了");
  const middle = card.slice(middleStart, actionsStart);
  assert.ok(
    !middle.includes("CapabilityResourceChips"),
    "tag 行又回到中间列了：那一列只有 119–205px，四个 tag 一定会换行",
  );
});

test("市场卡片仍然是「圆点 | 标题 | 操作」三列网格", () => {
  assert.ok(
    card.includes("grid-cols-[40px_minmax(0,1fr)_auto]"),
    "三列网格是 tag 行跨列的坐标系，改了要同步这组断言",
  );
});