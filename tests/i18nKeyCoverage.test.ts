/**
 * 源码里每个 `t("字面量 key")` 都必须在语言包里真实存在。
 *
 * 背景：`t()` 的契约是「未知 key 原样返回」（宁可露出 key 也不白屏），而 `tsc` 只能保证
 * zh / en 两包 key **成对**，管不了「代码里引用了不存在的 key」。2026-09-21 用户截图反馈
 * git 徽标上直接显示 `git.generatingMessage` —— 这个 key 两包都没有，只有代码里用了。
 *
 * 所以这里做一次全量对账：扫 `src/**`（跳过语言包自身，注释里也写了 `t("...")`），
 * 逐个 key 查 zh + en。这类漏 key 是纯机械缺陷，用测试兜住，别靠人眼。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import test from "node:test";

import { zh } from "../src/i18n/zh.ts";
import { en } from "../src/i18n/en.ts";

/** 语言包自身的文档注释里会出现 `t("...")` 字样，扫源码时要排掉。 */
const scannedFiles = globSync(["src/**/*.ts", "src/**/*.tsx"]).filter((file) => !file.startsWith("src/i18n/"));

const callSites = scannedFiles.flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/\bt\(\s*["']([a-zA-Z0-9_.]+)["']/g)].map((match) => ({ key: match[1], file }));
});

test("扫描确实覆盖到全部调用点（防止正则失效后测试假绿）", () => {
  assert.ok(scannedFiles.length > 80, `扫描到的源文件太少: ${scannedFiles.length}`);
  assert.ok(callSites.length > 400, `扫描到的 t() 字面量调用太少: ${callSites.length}`);
});

test('每个 t("字面量 key") 都能在中文包里查到', () => {
  const missing = callSites.filter(({ key }) => !(key in zh));

  assert.deepEqual(
    missing.map(({ key, file }) => `${key} (${file})`),
    [],
    "这些 key 代码里在用，但 zh.ts 没有 —— 运行时会原样显示 key",
  );
});

test("英文包同样不缺（两包成对由类型保证，这里防手滑绕过类型）", () => {
  for (const { key, file } of callSites) {
    assert.ok(key in en, `en.ts 缺 key ${key}（${file} 在用）`);
  }
});

// `t(\`settings.heading.${activeTab}\`)` 是 src 里唯一拼出来的 key（其余 `t(\`...\`)` 都是
// perfCount，不是文案），这里把它的候选值单独钉住。
test("拼出来的 settings.heading.* 四个 tab 都有文案", () => {
  const appSource = readFileSync("src/app/App.tsx", "utf8");
  assert.match(appSource, /t\(`settings\.heading\.\$\{activeTab\}`\)/, "动态 key 的写法变了就要同步这条测试");
  for (const tab of ["models", "personalization", "archived", "notifications"]) {
    assert.ok(`settings.heading.${tab}` in zh, `zh.ts 缺 settings.heading.${tab}`);
    assert.ok(`settings.heading.${tab}` in en, `en.ts 缺 settings.heading.${tab}`);
  }
});