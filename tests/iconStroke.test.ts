/**
 * 全站图标线宽只有一个来源：`--app-icon-stroke`。
 *
 * 背景：lucide 在 `<svg>` 上写死 `stroke-width="2"`（**呈现属性**），16px 下明显偏粗；
 * 侧栏那批手写图标又各自写 1.7。两套粗细同屏出现，看起来就是「图标都太粗」。
 * 现在 `styles.css` 里一条规则同时盖上 `svg.lucide` 与 `svg.app-icon`，值来自主题 token。
 *
 * 钉住三件事，都是「改错了不会报错、只会悄悄退回粗线」的类型：
 * 1. 规则存在且读 token —— CSS 规则优先级高于呈现属性，lucide 的 2 才会真的被盖掉；
 * 2. token 在默认主题与 codex 的浅/深两个块里都有值 —— 漏了会级联回 lucide 的 2；
 * 3. 没有代码再把 `strokeWidth` 写回图标 —— 写了也会被 CSS 盖掉，属于静默失效。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { appearanceDeclarations, themeTokens } from "./lib/cssTokens.ts";
import { codexThemeCss, defaultThemeCss } from "./lib/themeSources.ts";

const stylesCss = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");

/** 去掉注释再断言：文件里恰好有一段解释「lucide 写死 stroke-width=2」的注释。 */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

test("一条规则同时管住 lucide 与手写图标，且线宽来自主题 token", () => {
  assert.match(
    withoutComments(stylesCss),
    /svg\.lucide,\s*svg\.app-icon\s*\{\s*stroke-width:\s*var\(--app-icon-stroke[^)]*\);/,
    "统一线宽规则不见了：lucide 会退回自己写死的 stroke-width=2",
  );
});

test("--app-icon-stroke 在默认主题与 codex 的明暗两个块里都有值", () => {
  const base = themeTokens(defaultThemeCss);
  const value = base.light["--app-icon-stroke"];
  assert.ok(value, "默认主题缺 --app-icon-stroke（主题是所有人的基础层）");
  assert.ok(Number(value) > 0 && Number(value) < 2, `--app-icon-stroke=${value} 没有比 lucide 的 2 细`);

  const own = appearanceDeclarations(codexThemeCss, "codex");
  for (const mode of ["light", "dark"] as const) {
    assert.ok(
      own[mode]["--app-icon-stroke"],
      `codex ${mode} 缺 --app-icon-stroke：级联会掉回默认主题（虽然同值，但完整覆盖的约定就破了）`,
    );
  }
});

test("源码里不再给图标写 strokeWidth（CSS 会盖掉，写了也是静默失效）", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/strokeWidth=/.test(code)) offenders.push(path);
    }
  };
  walk(join(import.meta.dirname, "..", "src"));
  assert.deepEqual(
    offenders,
    [],
    "线宽归 `--app-icon-stroke` 管；确实要单独加重请用内联 style={{ strokeWidth }}（优先级更高）",
  );
});