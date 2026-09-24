/**
 * 配色主题的源码读取（主题按目录放在 `src/themes/<id>/`，见 `src/themes/README.md`）。
 *
 * `themeSourcesCss()` 把各主题拼成一份给 `lib/cssTokens.ts` 的解析器用，**默认主题必须
 * 排在最前**：`blockBody()` 靠「首次出现」定位块，`.dark {` 得先命中默认主题里那个真正的
 * `.dark`，而不是 `:root[data-appearance="codex"].dark {`。
 * （运行时没有这个问题：CSS 靠选择器权重决定胜负，不靠首次匹配。）
 */
import { readFileSync, readdirSync } from "node:fs";

const THEMES_DIR = new URL("../../src/themes/", import.meta.url);

/** 主题目录名（`README.md` / `index.ts` 这类文件不是目录，会被自然排除）。 */
export function listThemeIds(): string[] {
  return readdirSync(THEMES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function readThemeFile(id: string, file: string): string {
  return readFileSync(new URL(`./${id}/${file}`, THEMES_DIR), "utf8");
}

export function readThemeCss(id: string): string {
  return readThemeFile(id, "theme.css");
}

/** 默认顺序：默认主题永远在最前，其余按 id 字母序。 */
function byDefaultFirst(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "default") return -1;
  if (b === "default") return 1;
  return a.localeCompare(b);
}

export function orderedThemeIds(): string[] {
  return listThemeIds().sort(byDefaultFirst);
}

export function themeSourcesCss(): string {
  return orderedThemeIds().map(readThemeCss).join("\n");
}

export const defaultThemeCss = readThemeCss("default");
export const codexThemeCss = readThemeCss("codex");