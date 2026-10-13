/**
 * 文件预览的语言解析与配色主题（纯函数）。表逐字对齐 ZCode 的 `lib/codeViewer.ts` 与
 * `lib/codePreviewPreferences.ts` —— 这张表错了的表现是「某个文件突然失去高亮」，很难从
 * 界面上看出来是解析错了还是本来就没有规则，所以在这里钉住。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CODE_PREVIEW_THEMES,
  EXTENSION_TO_CODE_LANGUAGE,
  PLAIN_TEXT_CODE_LANGUAGE,
  codePreviewExtension,
  codePreviewLeaf,
  inferCodeLanguage,
  isDarkCodePreviewTheme,
  looksLikeUnifiedDiff,
} from "../src/shared/codePreviewLanguage.ts";

test("扩展名直接决定语言（ZCode 那张表逐条对账）", () => {
  const cases: Array<[string, string]> = [
    ["src/a.ts", "typescript"],
    ["src/a.tsx", "tsx"],
    ["src/a.js", "javascript"],
    ["src/a.mjs", "javascript"],
    ["src/a.jsx", "jsx"],
    ["src/a.py", "python"],
    ["src/a.rb", "ruby"],
    ["src/a.rs", "rust"],
    ["src/a.go", "go"],
    ["src/a.c", "c"],
    ["src/a.h", "c"],
    ["src/a.cc", "cpp"],
    ["src/a.cpp", "cpp"],
    ["src/a.java", "java"],
    ["src/a.css", "css"],
    ["src/a.html", "html"],
    ["src/a.htm", "html"],
    ["src/a.svg", "xml"],
    ["src/a.xml", "xml"],
    ["src/a.json", "json"],
    ["src/a.yaml", "yaml"],
    ["src/a.yml", "yaml"],
    ["src/a.toml", "toml"],
    ["src/a.sql", "sql"],
    ["src/a.sh", "bash"],
    ["src/a.bash", "bash"],
    ["src/a.md", "markdown"],
    ["src/a.mmd", "mermaid"],
    ["src/a.mermaid", "mermaid"],
    ["src/a.diff", "diff"],
    ["README.txt", "log"],
    ["notes.text", "log"],
  ];
  for (const [path, language] of cases) {
    assert.equal(inferCodeLanguage(path), language, `${path} 应解析成 ${language}`);
  }
  assert.equal(EXTENSION_TO_CODE_LANGUAGE.ts, "typescript");
});

test("扩展名大小写、反斜杠路径、点文件都要正确", () => {
  assert.equal(inferCodeLanguage("SRC/APP.TSX"), "tsx", "大写扩展名也要认");
  assert.equal(inferCodeLanguage("src\\windows\\a.py"), "python", "Windows 反斜杠要当成路径分隔符");
  // 点文件没有扩展名（`.gitignore` 不该被当成 `gitignore` 语言）。
  assert.equal(inferCodeLanguage(".gitignore"), PLAIN_TEXT_CODE_LANGUAGE);
  assert.equal(codePreviewExtension(".gitignore"), "");
  assert.equal(codePreviewExtension("a."), "", "点号结尾没有扩展名");
  assert.equal(codePreviewExtension("a.b.c"), "c");
  assert.equal(codePreviewLeaf("/a/b/c.ts"), "c.ts");
  assert.equal(codePreviewLeaf("a\\b\\c.ts"), "c.ts");
  assert.equal(codePreviewLeaf(""), "");
});

test("没有扩展名时看 shebang，再看像不像 diff，最后是纯文本", () => {
  assert.equal(inferCodeLanguage("scripts/run", "#!/usr/bin/env python3\nprint(1)"), "python");
  assert.equal(inferCodeLanguage("scripts/run", "#!/bin/bash\nset -e"), "bash");
  assert.equal(inferCodeLanguage("scripts/run", "#!/bin/sh\nset -e"), "bash");
  assert.equal(inferCodeLanguage("scripts/run", "just some text"), PLAIN_TEXT_CODE_LANGUAGE);
  assert.equal(inferCodeLanguage("patch.out", "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@"), "diff");
  assert.equal(inferCodeLanguage("patch.out", "@@ -1 +1 @@\n-a\n+b"), "diff");
  assert.equal(inferCodeLanguage(undefined, undefined), PLAIN_TEXT_CODE_LANGUAGE);
  assert.equal(inferCodeLanguage(null, null), PLAIN_TEXT_CODE_LANGUAGE);
  assert.equal(inferCodeLanguage("", ""), PLAIN_TEXT_CODE_LANGUAGE);
  // 扩展名优先于内容：`.ts` 文件里恰好有 diff 标记也还是 ts。
  assert.equal(inferCodeLanguage("a.ts", "diff --git a/x b/x"), "typescript");
});

test("looksLikeUnifiedDiff 只在行首标记时成立", () => {
  assert.equal(looksLikeUnifiedDiff("--- a/x"), true);
  assert.equal(looksLikeUnifiedDiff("+++ b/x"), true);
  assert.equal(looksLikeUnifiedDiff("@@ -1,2 +1,2 @@"), true);
  assert.equal(looksLikeUnifiedDiff("a markdown --- separator"), false, "行中间的 --- 不算 diff");
  assert.equal(looksLikeUnifiedDiff(""), false);
  assert.equal(looksLikeUnifiedDiff(null), false);
});

test("明暗主题来自显式表，不靠名字猜", () => {
  assert.equal(CODE_PREVIEW_THEMES.light, "github-light");
  assert.equal(CODE_PREVIEW_THEMES.dark, "github-dark");
  assert.equal(isDarkCodePreviewTheme("github-dark"), true);
  assert.equal(isDarkCodePreviewTheme("catppuccin-mocha"), true);
  assert.equal(isDarkCodePreviewTheme("vitesse-dark"), true);
  assert.equal(isDarkCodePreviewTheme("min-dark"), true);
  assert.equal(isDarkCodePreviewTheme("github-dark-high-contrast"), true);
  assert.equal(isDarkCodePreviewTheme("github-light"), false);
  assert.equal(isDarkCodePreviewTheme("github-light-high-contrast"), false);
  assert.equal(isDarkCodePreviewTheme("catppuccin-latte"), false);
  assert.equal(isDarkCodePreviewTheme(""), false);
});