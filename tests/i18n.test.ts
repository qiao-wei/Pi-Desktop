/**
 * i18n 运行时的行为契约。
 *
 * 语言包是「纯数据 + 类型约束」：en 的 key 集合由类型 `satisfies Record<keyof
 * typeof zh, string>` 在编译期钉死，这里再在运行时对一遍，防 `as const` 之外
 * 的手滑（比如 key 写重、值写成空串）。运行时行为只测四件事：插值、缺 key
 * 回退、切换语言后 t() 立即换语言、环境变量优先于系统探测。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { zh } from "../src/i18n/zh.ts";
import { en } from "../src/i18n/en.ts";
import { getLocale, setLocale, subscribeLocale, t } from "../src/i18n/index.ts";

test("英文包覆盖中文包的每一个 key（两包永不漂移）", () => {
  const zhKeys = Object.keys(zh);
  const enKeys = Object.keys(en);
  assert.ok(zhKeys.length > 100, "语言包不应退化成空壳");
  for (const key of zhKeys) {
    assert.ok(key in en, `英文包缺 key: ${key}`);
  }
  assert.deepEqual(enKeys.length, zhKeys.length, "两包 key 数量应一致（en 不应有多余 key）");
});

test("两包的值都是非空字符串，插值槽在两包中成对出现", () => {
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, "string", `${key} 应是字符串`);
    assert.ok((value as string).length > 0, `${key} 不应是空串`);
    const zhSlots = ((value as string).match(/\{(\w+)\}/g) ?? []).sort();
    const enSlots = ((en as Record<string, string>)[key].match(/\{(\w+)\}/g) ?? []).sort();
    assert.deepEqual(zhSlots, enSlots, `${key} 的插值槽在两包中应一致`);
  }
});

test("t() 用参数插值；缺参数保留 {slot} 原样", () => {
  setLocale("zh");
  assert.equal(t("usage.cacheDetail", { read: "1.7k", write: "200" }), "(输入 1.7k，输出 200)");
  assert.equal(t("composer.error.attachmentTooLarge", { name: "a.png", limit: 25 }), "a.png 超过 25 MB。");
  // 缺 limit 参数：槽原样保留，而不是产出 "undefined" 混进用户可见文案
  assert.equal(t("composer.error.attachmentTooLarge", { name: "a.png" }), "a.png 超过 {limit} MB。");
});

test("未知 key 原样返回（宁可露出 key 也不抛异常白屏）", () => {
  assert.equal(t("nope.missing.key"), "nope.missing.key");
});

test("切换语言后 t() 立即换语言，并通知订阅者", () => {
  setLocale("zh");
  let notified = 0;
  const unsubscribe = subscribeLocale(() => {
    notified += 1;
  });

  assert.equal(t("usage.title"), "上下文用量");
  setLocale("en");
  assert.equal(getLocale(), "en");
  assert.equal(notified, 1, "切换语言应通知订阅者（React 侧靠它重渲染）");
  assert.equal(t("usage.title"), "Context usage");

  setLocale("zh");
  assert.equal(t("usage.title"), "上下文用量");
  assert.equal(notified, 2);
  assert.equal(t("usage.title", undefined), "上下文用量");

  unsubscribe();
  // 同语言重复 set 不应重复通知
  const before = notified;
  setLocale("zh");
  assert.equal(notified, before);
});

test("PI_DESKTOP_LOCALE 环境变量优先于系统探测", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const mod = new URL("../src/i18n/index.ts", import.meta.url).pathname;

  const en = await run(process.execPath, [
    "--input-type=module",
    "-e",
    `import { getLocale } from ${JSON.stringify(mod)}; console.log(getLocale());`,
  ], { env: { ...process.env, PI_DESKTOP_LOCALE: "en" } });
  assert.equal(en.stdout.trim(), "en", "PI_DESKTOP_LOCALE=en 应生效（node 里 navigator.language 是 en-US，必须能被环境变量压住）");

  const zh = await run(process.execPath, [
    "--input-type=module",
    "-e",
    `import { getLocale } from ${JSON.stringify(mod)}; console.log(getLocale());`,
  ], { env: { ...process.env, PI_DESKTOP_LOCALE: "zh" } });
  assert.equal(zh.stdout.trim(), "zh");
});

test("useT 必须经 useSyncExternalStore 订阅 locale（钉住切换语言后组件重渲染的契约）", () => {
  const source = readFileSync(new URL("../src/i18n/react.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export function useT"));
  assert.match(body, /useSyncExternalStore\(subscribeLocale, getLocale\)/,
    "useT 丢了订阅：切换语言后界面不会重渲染，翻译全部停在旧语言");
});

test("slash menu 与侧栏新增文案两包齐备，count 插值生效", () => {
  setLocale("zh");
  assert.equal(t("capability.slashMenu.skills", { count: 3 }), "技能 (3)");
  assert.equal(t("capability.slashMenu.commands", { count: 0 }), "指令 (0)");
  assert.equal(t("capability.slashMenu.empty"), "没有匹配的技能或指令");
  assert.equal(t("capability.slashMenu.aria"), "技能与指令");
  assert.equal(t("sidebar.pinned"), "已置顶");
  assert.equal(t("sidebar.projects"), "项目");

  setLocale("en");
  assert.equal(t("capability.slashMenu.skills", { count: 3 }), "Skills (3)");
  assert.equal(t("capability.slashMenu.commands", { count: 0 }), "Commands (0)");
  assert.equal(t("capability.slashMenu.empty"), "No matching skills or commands");
  assert.equal(t("sidebar.pinned"), "Pinned");
  assert.equal(t("sidebar.projects"), "Projects");
  setLocale("zh");
});

test("en 包的类型约束真的在工作（抽查几个 key 的英文值）", () => {
  assert.equal(en["compaction.running"], "Compacting context, please wait…");
  assert.ok(en["models.apiType.azure-openai-responses"].includes("no listing"));
  assert.ok(zh["models.apiType.azure-openai-responses"].includes("无法拉取列表"));
});
