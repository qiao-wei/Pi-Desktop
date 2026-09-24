/**
 * Reads the shadcn/Tailwind custom-property blocks out of a theme's CSS
 * (`src/themes/<id>/theme.css`, see `src/themes/README.md`).
 * Shared by the style tests so they resolve `var(--token)` exactly like the browser does.
 */
import assert from "node:assert/strict";

import type { Tokens } from "./cssColor.ts";

/** shadcn 控件层 token：任何主题都必须定义它们，否则控件会半旧半新。 */
export const SHADCN_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--app-sidebar-surface",
  "--app-content-surface",
  "--app-header-border",
];

function blockBody(css: string, selector: string, from: number): { body: string; end: number } {
  const at = css.indexOf(`${selector} {`, from);
  assert.notEqual(at, -1, `expected a "${selector} {" block`);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      return { body: css.slice(at + selector.length + 2, i), end: i };
    }
  }
  throw new Error(`unbalanced braces after "${selector}"`);
}

function parseBody(body: string): Tokens {
  const map: Tokens = {};
  // 注释会落在两个分号之间（例如内联的 `/* collapsed: … */`），先把它们去掉；
  // 否则下一整条声明会被当成"名字里带注释"而被跳过。
  for (const decl of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const name = decl.slice(0, idx).trim();
    if (name.startsWith("--")) map[name] = decl.slice(idx + 1).trim();
  }
  return map;
}

/** Raw declarations of the block whose selector is exactly `selector`, starting at `from`. */
export function blockTokens(
  css: string,
  selector: string,
  from = 0,
): { tokens: Tokens; end: number } {
  const block = blockBody(css, selector, from);
  return { tokens: parseBody(block.body), end: block.end };
}

/**
 * `{ light, dark }` token maps; `.dark` is layered on top of `:root` like in the browser.
 */
export function themeTokens(css: string): { light: Tokens; dark: Tokens } {
  const root = blockBody(css, ":root", 0);
  const dark = blockBody(css, ".dark", root.end);
  const lightTokens = parseBody(root.body);
  return { light: lightTokens, dark: { ...lightTokens, ...parseBody(dark.body) } };
}

/**
 * Raw declarations of one appearance's blocks (NOT merged over the base palette),
 * so a caller can tell "this theme defined the token" from "it fell back".
 */
export function appearanceDeclarations(
  css: string,
  appearance: string,
): { light: Tokens; dark: Tokens } {
  const light = blockBody(css, `:root[data-appearance="${appearance}"]`, 0);
  const dark = blockBody(css, `:root[data-appearance="${appearance}"].dark`, light.end);
  return { light: parseBody(light.body), dark: parseBody(dark.body) };
}

/**
 * `{ light, dark }` token maps for one colour theme ("appearance").
 *
 * Each appearance overrides the base palette on `<html data-appearance="…">`:
 * a light block plus a darker `…].dark` block, both inside that theme's own file.
 * The caller passes the theme sources concatenated **with the default theme first**
 * (see `tests/lib/themeSources.ts`): `blockBody` finds blocks by first-occurrence text
 * search, so `.dark` has to match the real base block and not a
 * `:root[data-appearance="codex"].dark` one.
 */
export function appearanceTokens(
  css: string,
  appearance: string,
): { light: Tokens; dark: Tokens } {
  const base = themeTokens(css);
  const own = appearanceDeclarations(css, appearance);
  return {
    light: { ...base.light, ...own.light },
    dark: { ...base.dark, ...own.light, ...own.dark },
  };
}
