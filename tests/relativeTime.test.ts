/**
 * 「3 分钟前」的分档（右面板标签页总览用）。
 *
 * 这里钉的是边界而不是文案：文案在 zh/en 两包里各写一份，这里只保证**返回的 key 存在**
 * 且分档正确（坏时间戳 / 未来时间不能让人看到负数）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";
import { relativeTimeLabel } from "../src/shared/relativeTime.ts";

const NOW = 1_700_000_000_000;

test("相对时间：刚刚 / 分钟 / 小时 / 天 四档，边界落在整档上", () => {
  assert.deepEqual(relativeTimeLabel(NOW, NOW), { key: "time.justNow", params: {} });
  assert.deepEqual(relativeTimeLabel(NOW - 59_000, NOW), { key: "time.justNow", params: {} }, "59 秒还是「刚刚」");
  assert.deepEqual(relativeTimeLabel(NOW - 60_000, NOW), { key: "time.minutesAgo", params: { count: 1 } });
  assert.deepEqual(relativeTimeLabel(NOW - 59 * 60_000, NOW), { key: "time.minutesAgo", params: { count: 59 } });
  assert.deepEqual(relativeTimeLabel(NOW - 60 * 60_000, NOW), { key: "time.hoursAgo", params: { count: 1 } });
  assert.deepEqual(relativeTimeLabel(NOW - 23 * 60 * 60_000, NOW), { key: "time.hoursAgo", params: { count: 23 } });
  assert.deepEqual(relativeTimeLabel(NOW - 24 * 60 * 60_000, NOW), { key: "time.daysAgo", params: { count: 1 } });
  assert.deepEqual(relativeTimeLabel(NOW - 3 * 24 * 60 * 60_000, NOW), { key: "time.daysAgo", params: { count: 3 } });
});

test("坏时间戳 / 未来时间（时钟回拨）都算「刚刚」，不显示负数", () => {
  for (const value of [undefined, null, "", "1700000000000", Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
    assert.deepEqual(relativeTimeLabel(value, NOW), { key: "time.justNow", params: {} }, `坏值 ${String(value)}`);
  }
  assert.deepEqual(relativeTimeLabel(NOW + 60_000, NOW), { key: "time.justNow", params: {} }, "未来时间");
});

test("四个 key 在 zh / en 两包都存在", () => {
  for (const key of ["time.justNow", "time.minutesAgo", "time.hoursAgo", "time.daysAgo"]) {
    assert.ok(key in zh, `zh.ts 缺 ${key}`);
    assert.ok(key in en, `en.ts 缺 ${key}`);
  }
});
