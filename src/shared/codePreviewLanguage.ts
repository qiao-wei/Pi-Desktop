/**
 * 文件预览的语言解析与配色主题（纯函数）。
 *
 * 逐字对齐 ZCode：
 * - `lib/codeViewer.ts:inferCodeLanguage` —— 先看扩展名，再看 shebang（`#!/...python|bash`），
 *   再看「像不像 diff」，最后落到 `log`（纯文本，shiki 里就是不着色）；
 * - `lib/codePreviewPreferences.ts` —— 明暗主题必须来自显式选项表，**不能**用主题名正则猜
 *   （`github-dark-high-contrast` / `catppuccin-mocha` 这类名字猜不出来）。
 * 解析结果直接喂给 `@pierre/diffs` 的 `file.lang`，所以这里只产出 shiki 的语言名。
 */

/**
 * 扩展名 → shiki 语言名。表就是 ZCode 那张表（少一个都会让某个文件突然变成纯文本）。
 * 注意 `text`/`txt` 落到 `log`：shiki 的 `log` 是没有语法规则的语言，等于「高亮关掉」。
 */
export const EXTENSION_TO_CODE_LANGUAGE: Readonly<Record<string, string>> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  diff: "diff",
  go: "go",
  h: "c",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  mermaid: "mermaid",
  mmd: "mermaid",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  text: "log",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  txt: "log",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

/** 明暗两档的代码主题。ZCode 的默认值就是这两个（`DEFAULT_CODE_PREVIEW_SETTINGS`）。 */
export const CODE_PREVIEW_THEMES = { light: "github-light", dark: "github-dark" } as const;

/** 主题名 → 这一档是深色还是浅色。表里没有的一律当浅色（和 app 的默认主题一致）。 */
const DARK_CODE_PREVIEW_THEMES: readonly string[] = [
  "github-dark",
  "github-dark-high-contrast",
  "vitesse-dark",
  "min-dark",
  "catppuccin-mocha",
];

export function isDarkCodePreviewTheme(theme: string): boolean {
  return DARK_CODE_PREVIEW_THEMES.includes(theme);
}

/** 没有扩展名的纯文本落到哪个语言：`log` = shiki 里「不着色」。 */
export const PLAIN_TEXT_CODE_LANGUAGE = "log";

/** 路径的最后一段（两种分隔符都要吃：git 的路径在 Windows 上是反斜杠）。 */
export function codePreviewLeaf(path: unknown): string {
  const value = String(path ?? "").trim().replace(/\\/g, "/");
  const index = value.lastIndexOf("/");
  return index === -1 ? value : value.slice(index + 1);
}

/** 文件后缀（小写，不带点）。点号结尾 / 没有点号 / 点号开头且没有第二个点 → 空串。 */
export function codePreviewExtension(path: unknown): string {
  const leaf = codePreviewLeaf(path);
  const index = leaf.lastIndexOf(".");
  if (index <= 0 || index === leaf.length - 1) {
    return "";
  }
  return leaf.slice(index + 1).toLowerCase();
}

/** 内容看起来像 unified diff 吗（ZCode `looksLikeDiff` 的同一组标记）。 */
export function looksLikeUnifiedDiff(text: unknown): boolean {
  const value = String(text ?? "");
  return /^(diff --git|--- |\+\+\+ |@@ )/m.test(value);
}

/**
 * 解出这个文件该用哪种语言高亮。`contentHint` 是文件正文（只在扩展名没命中时用得上，
 * 比如没有后缀的可执行脚本）。
 */
export function inferCodeLanguage(path?: string | null, contentHint?: string | null): string {
  const extension = codePreviewExtension(path);
  if (extension && EXTENSION_TO_CODE_LANGUAGE[extension]) {
    return EXTENSION_TO_CODE_LANGUAGE[extension];
  }

  const content = typeof contentHint === "string" ? contentHint : "";
  if (content.startsWith("#!/")) {
    if (content.includes("python")) {
      return "python";
    }
    if (content.includes("bash") || content.includes("sh")) {
      return "bash";
    }
  }

  if (content && looksLikeUnifiedDiff(content)) {
    return "diff";
  }

  return PLAIN_TEXT_CODE_LANGUAGE;
}