/**
 * 生成文档的区域**不许**写出 `undefined`。
 *
 * 背景（真实事故）：`check.mjs` 把传给渲染器的字段从 `bridgeRoutes` 改名成 `routeCount`，
 * 而 `render.mjs` 还在读旧名字，于是 `docs/architecture/architecture.md` 的生成区写下了
 * “bridge 实际应答：**undefined** 条”。
 *
 * 为什么半个月没人发现：`docs-regions` 这条规则比的是「生成结果 vs 已落盘的文档」——两边
 * 都是 `undefined`，逐字相等，**校验是绿的**。一个生成器的 bug 被自己的产物冻结成了“真源”。
 *
 * 所以这里补两道闸：
 * 1. 渲染器缺字段就**抛**（`architecture:check` 当场红，不会再写一份带 `undefined` 的文档）；
 * 2. 落盘的文档里不许出现 `undefined` / `NaN`（兜住“别人改了模板但没改这里”的情况）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { renderDocRegions } from "../scripts/architecture/lib/render.mjs";

const policy = JSON.parse(readFileSync("architecture/policy.json", "utf8"));

/** 与 `check.mjs` 交给渲染器的形状一致；数字取当前真值。 */
const stats = {
  protocolVersion: { declared: 1 },
  routeCount: 102,
  clientPathCount: 97,
  frozenRouteCount: 102,
};

test("生成的区域里没有 undefined / NaN，且三个计数都来自 stats", () => {
  const regions = renderDocRegions(policy, stats);
  const rendered = Object.values(regions)
    .flatMap((byName) => Object.values(byName))
    .join("\n");

  assert.doesNotMatch(
    rendered,
    /\bundefined\b/,
    "生成区里出现了 undefined —— 说明某个 stats 字段读错了名字",
  );
  assert.doesNotMatch(rendered, /\bNaN\b/);

  const surface = regions["docs/architecture/architecture.md"].surface;
  assert.match(surface, new RegExp(`bridge 实际应答：\\*\\*${stats.routeCount}\\*\\* 条`));
  assert.match(surface, new RegExp(`渲染进程命名：\\*\\*${stats.clientPathCount}\\*\\* 条`));
  assert.match(surface, new RegExp(`冻结的协议表面：\\*\\*${stats.frozenRouteCount}\\*\\* 条`));
});

test("缺任何一个计数就抛错，而不是往文档里写 undefined", () => {
  for (const key of ["routeCount", "clientPathCount", "frozenRouteCount"]) {
    const broken = { ...stats, [key]: undefined };
    assert.throws(
      () => renderDocRegions(policy, broken),
      new RegExp(`stats\\.${key} is missing`),
      `${key} 缺失时必须指名报错`,
    );
  }

  assert.throws(
    () => renderDocRegions(policy, { ...stats, protocolVersion: undefined }),
    /stats\.protocolVersion\.declared is missing/,
  );
});

test("已落盘的架构文档里没有 undefined / NaN（生成区已冻结成真，写进去就再也报不出来）", () => {
  for (const file of ["docs/architecture/architecture.md", "docs/architecture/protocols.md"]) {
    const text = readFileSync(file, "utf8");
    for (const region of text.matchAll(
      /<!-- architecture:begin ([\w-]+) -->([\s\S]*?)<!-- architecture:end \1 -->/g,
    )) {
      assert.doesNotMatch(
        region[2],
        /\bundefined\b/,
        `${file} 的 "${region[1]}" 区域里有 undefined`,
      );
      assert.doesNotMatch(region[2], /\bNaN\b/, `${file} 的 "${region[1]}" 区域里有 NaN`);
    }
  }
});
