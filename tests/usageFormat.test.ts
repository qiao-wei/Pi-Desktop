import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cachePercent, formatCacheDetail, formatTokens, percentOf } from "../src/app/usageFormat.ts";

describe("formatCacheDetail（UsagePopover 累计缓存明细）", () => {
  it("cacheWrite=0 时只展示数字，不带「输入/输出」字样", () => {
    assert.equal(formatCacheDetail(1_650_100, 0), "1650.1k");
  });

  it("cacheRead=0 时只展示写入数字", () => {
    assert.equal(formatCacheDetail(0, 500), "500");
    assert.equal(formatCacheDetail(0, 31_900), "31.9k");
  });

  it("读写都有时保留 (输入 x，输出 y) 拆分", () => {
    assert.equal(formatCacheDetail(1_700, 200), "(输入 1.7k，输出 200)");
    assert.equal(formatCacheDetail(1_650_100, 31_900), "(输入 1650.1k，输出 31.9k)");
  });

  it("两边都为 0 时兜底为 0（正常不会渲染该行）", () => {
    assert.equal(formatCacheDetail(0, 0), "0");
  });
});

describe("cachePercent（累计缓存占比，分母只用读侧）", () => {
  it("cacheWrite=0 时 = cacheRead / (input + cacheRead)，不带输出", () => {
    assert.equal(cachePercent(1_500, 0, 2_000), 75);
  });

  it("cacheWrite>0 时分子含写入，分母仍只用读侧", () => {
    assert.equal(cachePercent(1_700, 300, 2_000), 100);
    assert.equal(cachePercent(1_700, 300, 4_000), 50);
  });

  it("读侧分母为 0/负数时返回 null", () => {
    assert.equal(cachePercent(1_500, 0, 0), null);
    assert.equal(cachePercent(1_500, 0, -1), null);
  });

  it("超过 100% 时夹到 100", () => {
    assert.equal(cachePercent(5_000, 0, 2_000), 100);
  });
});

describe("percentOf", () => {
  it("total 无效时返回 null，正常时算百分比", () => {
    assert.equal(percentOf(50, 0), null);
    assert.equal(percentOf(50, undefined), null);
    assert.equal(percentOf(50, 200), 25);
  });
});

describe("formatTokens", () => {
  it("null/undefined 显示 --", () => {
    assert.equal(formatTokens(null), "--");
    assert.equal(formatTokens(undefined), "--");
  });

  it("千位以下原样，千位以上缩写为 k", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1000), "1k");
    assert.equal(formatTokens(71_300), "71.3k");
  });
});
