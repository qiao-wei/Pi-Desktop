/**
 * Reads the shadcn/Tailwind custom-property blocks out of `src/app/tailwind.css`.
 * Shared by the style tests so they resolve `var(--token)` exactly like the browser does.
 */
import assert from "node:assert/strict";

import type { Tokens } from "./cssColor.ts";

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
  for (const decl of body.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const name = decl.slice(0, idx).trim();
    if (name.startsWith("--")) map[name] = decl.slice(idx + 1).trim();
  }
  return map;
}

/** `{ light, dark }` token maps; `.dark` is layered on top of `:root` like in the browser. */
export function themeTokens(css: string): { light: Tokens; dark: Tokens } {
  const root = blockBody(css, ":root", 0);
  const dark = blockBody(css, ".dark", root.end);
  const lightTokens = parseBody(root.body);
  return { light: lightTokens, dark: { ...lightTokens, ...parseBody(dark.body) } };
}
