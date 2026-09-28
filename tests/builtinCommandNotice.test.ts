/**
 * 内置命令状态带的文案选择（见 src/shared/builtinCommandNotice.ts）。
 *
 * 规则：命令自己的 `<name>.<phase>` 文案优先，没有就退到通用 `/{name}` 措辞 ——
 * 这样「新增一条内置命令」不用再改这条链路，也允许 `/reload` 这种值得解释的命令单写。
 *
 * 纯函数 + 真实语言包，直接在 node 里跑；App 侧接线在 builtinCommands.test.ts 里对账。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_COMMAND_DONE_DISMISS_MS,
  builtinCommandNoticeText,
} from "../src/shared/builtinCommandNotice.ts";
import { getLocale, hasTranslation, setLocale, t } from "../src/i18n/index.ts";
import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";

/** 每条断言后都恢复语言，免得影响后面的用例（node:test 同进程顺序跑）。 */
function withLocale<T>(locale: "zh" | "en", run: () => T): T {
  const previous = getLocale();
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale(previous);
  }
}

test("hasTranslation: 认字面量 key，不认没登记的 key", () => {
  assert.equal(hasTranslation("composer.builtinCommand.running"), true);
  assert.equal(hasTranslation("composer.builtinCommand.reload.done"), true);
  assert.equal(hasTranslation("composer.builtinCommand.definitelyNotACommand.done"), false);
  assert.equal(hasTranslation(""), false);
});

test("有专用文案的命令用自己的措辞（/reload 说的是重载了什么）", () => {
  const running = withLocale("zh", () => builtinCommandNoticeText("reload", "running"));
  const done = withLocale("zh", () => builtinCommandNoticeText("reload", "done"));

  assert.equal(running, zh["composer.builtinCommand.reload.running"]);
  assert.equal(done, zh["composer.builtinCommand.reload.done"]);
  // 专用文案必须比通用文案具体，否则就没必要单写。
  assert.match(running, /扩展/);
  assert.notEqual(running, t("composer.builtinCommand.running", { name: "reload" }));
});

test("没写专用文案的命令退到通用措辞，且带上命令名", () => {
  // 未来的内置命令（比如 /compact）不改这条链路也该有反馈。
  const running = withLocale("zh", () => builtinCommandNoticeText("compact", "running"));
  const done = withLocale("zh", () => builtinCommandNoticeText("compact", "done"));

  assert.equal(running, `正在执行 /compact …`);
  assert.equal(done, `/compact 已完成`);
  assert.doesNotMatch(running, /\{name\}/, "占位符必须被替换掉，不能漏出模板");
});

test("两个阶段说的是两件事，不会都落到同一句", () => {
  for (const locale of ["zh", "en"] as const) {
    withLocale(locale, () => {
      assert.notEqual(
        builtinCommandNoticeText("reload", "running"),
        builtinCommandNoticeText("reload", "done"),
      );
      assert.notEqual(
        builtinCommandNoticeText("unknown", "running"),
        builtinCommandNoticeText("unknown", "done"),
      );
    });
  }
});

test("英文包同样按「专用优先、否则通用」出文案", () => {
  const specific = withLocale("en", () => builtinCommandNoticeText("reload", "done"));
  const generic = withLocale("en", () => builtinCommandNoticeText("compact", "done"));

  assert.equal(specific, en["composer.builtinCommand.reload.done"]);
  assert.equal(generic, "/compact done");
  assert.notEqual(specific, generic);
});

test("「已完成」停留时间是正数（0 会让成功回执根本看不见）", () => {
  assert.ok(BUILTIN_COMMAND_DONE_DISMISS_MS > 0);
});

test("语言包两边的内置命令文案成对", () => {
  const keys = ["running", "done", "reload.running", "reload.done"].map(
    (suffix) => `composer.builtinCommand.${suffix}`,
  );
  for (const key of keys) {
    assert.ok(key in zh, `zh.ts 缺 ${key}`);
    assert.ok(key in en, `en.ts 缺 ${key}`);
  }
});