/**
 * Regression test for the composer button colours (stop / send / plain icon buttons).
 *
 * Why this exists: `src/app/styles.css` keeps the legacy element rules and then, much
 * later, a "normalize the legacy surfaces to the token palette" block. That block used to
 * repaint `.icon-button` / `.send-button` with `background: var(--card)` while the legacy
 * `color: #ffffff` survived — so in the light theme the stop/send glyphs were white on
 * white and invisible (dark theme looked fine because `--card` is dark).
 *
 * Instead of asserting on source strings (which would lock in implementation details),
 * this resolves the real CSS cascade for the elements the app renders and checks the
 * winning glyph colour against the winning background colour with the WCAG 1.4.11
 * non-text contrast threshold (3:1). The colour maths is pinned to Chromium by
 * `tests/cssColor.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { contrast, flatten, resolveColor, type RGB, type Tokens } from "./lib/cssColor.ts";
import { themeTokens } from "./lib/cssTokens.ts";
import { defaultThemeCss } from "./lib/themeSources.ts";

const stylesCss = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const TOKENS: Tokens = themeTokens(defaultThemeCss);

/** WCAG 1.4.11 minimum for a graphical object that carries meaning. */
const MIN_CONTRAST = 3;

interface Element {
  /** tag name, e.g. "button" */
  type: string;
  classes: string[];
  disabled?: boolean;
  hovered?: boolean;
  /** class list of each ancestor, outermost first (e.g. ["dark"] for <html class="dark">) */
  ancestors?: string[][];
}

interface Declaration {
  property: string;
  value: string;
  order: number;
}

/* -------------------------------------------------------------- rule parsing */

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Collect top-level `selector { decls }` rules; at-rule blocks (@media, @theme, ...) are skipped. */
function topLevelRules(css: string): { selectors: string[]; decls: Declaration[] }[] {
  const rules: { selectors: string[]; decls: Declaration[] }[] = [];
  const n = css.length;
  let i = 0;
  let order = 0;
  while (i < n) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < n && depth > 0) {
      if (css[j] === "/" && css[j + 1] === "*") {
        j = css.indexOf("*/", j) + 2;
        continue;
      }
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const selectorText = stripComments(css.slice(i, open)).trim();
    const body = css.slice(open + 1, j - 1);
    if (!selectorText.startsWith("@")) {
      const decls = parseDeclarations(body, order++);
      if (decls.length) rules.push({ selectors: splitSelector(selectorText), decls });
    }
    i = j;
  }
  return rules;
}

function splitSelector(selectorText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of selectorText) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function parseDeclarations(text: string, order: number): Declaration[] {
  const out: Declaration[] = [];
  for (const raw of stripComments(text).split(";")) {
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    const property = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!property || !value || property.startsWith("--") || property.startsWith("@")) continue;
    out.push({ property, value, order });
  }
  return out;
}

/* ---------------------------------------------------------- selector matching */

function compounds(selector: string): string[] {
  return selector
    .replace(/\s*>\s*/g, " > ")
    .split(/\s+/)
    .filter((token) => token !== ">" && token !== "");
}

function matchCompound(compound: string, el: Element): boolean {
  const re = /([#.]?[\w-]+|\*|::?[\w-]+(\([^()]*\))?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(compound))) {
    const token = match[1];
    if (token === "*") continue;
    if (token.startsWith(".")) {
      if (!el.classes.includes(token.slice(1))) return false;
    } else if (token.startsWith("#")) {
      return false; // ids are not used in the legacy sheet
    } else if (token.startsWith(":")) {
      const name = token.replace(/^:+/, "").split("(")[0];
      const arg = token.includes("(") ? token.slice(token.indexOf("(") + 1, -1).trim() : "";
      switch (name) {
        case "disabled":
          if (!el.disabled) return false;
          break;
        case "hover":
          if (!el.hovered) return false;
          break;
        case "not":
          if (matchCompound(arg, el)) return false;
          break;
        case "root":
          if (el.type !== "html") return false;
          break;
        default:
          return false; // unknown pseudo-class: be conservative and skip the rule
      }
    } else if (token !== el.type) {
      return false;
    }
  }
  return true;
}

/** Descendant-combinator matching: last compound on the element, earlier ones on ancestors. */
function matchesSelector(selector: string, el: Element): boolean {
  const list = compounds(selector);
  if (!list.length) return false;
  if (!matchCompound(list[list.length - 1], el)) return false;
  const ancestors = el.ancestors ?? [];
  let cursor = ancestors.length - 1;
  for (let i = list.length - 2; i >= 0; i--) {
    let found = false;
    while (cursor >= 0) {
      const candidate: Element = { type: "div", classes: ancestors[cursor] };
      cursor--;
      if (matchCompound(list[i], candidate)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function specificity(selector: string): [number, number, number] {
  const text = compounds(selector).join(" ");
  const ids = (text.match(/#[\w-]+/g) ?? []).length;
  const types = (text.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  const classes = (text.match(/\.[\w-]+|:(?!not)[\w-]+(\([^()]*\))?|\[[^\]]*\]/g) ?? []).length;
  const notInner = (text.match(/:not\(([^)]*)\)/g) ?? []).length;
  return [ids, classes + notInner, types];
}

/* -------------------------------------------------------------- cascade lookup */

const RULES = topLevelRules(stylesCss);

/** The winning declaration of `property` for `el`, or null when nothing declares it. */
function declared(el: Element, property: string): { value: string; selector: string } | null {
  let best: { value: string; selector: string; spec: [number, number, number]; order: number } | null =
    null;
  for (const rule of RULES) {
    for (const selector of rule.selectors) {
      if (!matchesSelector(selector, el)) continue;
      const decl = rule.decls.find((d) => d.property === property);
      if (!decl) continue;
      const spec = specificity(selector);
      const wins =
        !best ||
        spec[0] !== best.spec[0]
          ? spec[0] > (best?.spec[0] ?? -1)
          : spec[1] !== best.spec[1]
            ? spec[1] > best.spec[1]
            : spec[2] !== best.spec[2]
              ? spec[2] > best.spec[2]
              : decl.order >= best.order;
      if (wins) best = { value: decl.value, selector, spec, order: decl.order };
    }
  }
  return best ? { value: best.value, selector: best.selector } : null;
}

/* --------------------------------------------------------------------- cases */

interface Case {
  name: string;
  element: Element;
}

const cases: Case[] = [
  { name: "stop button", element: { type: "button", classes: ["icon-button", "stop-button"] } },
  {
    name: "stop button hover",
    element: { type: "button", classes: ["icon-button", "stop-button"], hovered: true },
  },
  { name: "send button", element: { type: "button", classes: ["send-button"] } },
  {
    name: "send button hover",
    element: { type: "button", classes: ["send-button"], hovered: true },
  },
  {
    name: "send button disabled",
    element: { type: "button", classes: ["send-button"], disabled: true },
  },
  { name: "plain icon button", element: { type: "button", classes: ["icon-button"] } },
  {
    name: "composer model trigger",
    element: { type: "button", classes: ["composer-model-trigger"] },
  },
  {
    name: "composer model trigger hover",
    element: { type: "button", classes: ["composer-model-trigger"], hovered: true },
  },
  {
    name: "composer model trigger disabled",
    element: { type: "button", classes: ["composer-model-trigger"], disabled: true },
  },
  {
    name: "active icon button",
    element: { type: "button", classes: ["icon-button", "is-active"] },
  },
];

for (const theme of ["light", "dark"] as const) {
  const ancestors = theme === "dark" ? [["dark"]] : [];
  const tokens = TOKENS[theme];
  const surface = flatten(resolveColor("var(--card)", tokens), [0, 0, 0] as RGB);

  for (const testCase of cases) {
    test(`composer ${testCase.name} keeps a readable glyph in the ${theme} theme`, () => {
      const el: Element = { ...testCase.element, ancestors };
      const glyph = declared(el, "color");
      assert.ok(
        glyph,
        `nothing sets a glyph colour for "${el.classes.join(".")}" (${theme} theme)`,
      );
      const background = declared(el, "background") ?? declared(el, "background-color");
      const fg = flatten(resolveColor(glyph.value, tokens), surface);
      const bg = background ? flatten(resolveColor(background.value, tokens), surface) : surface;
      const ratio = contrast(fg, bg);
      assert.ok(
        ratio >= MIN_CONTRAST,
        `${testCase.name} [${theme}]: ${glyph.value} on ${background?.value ?? "var(--card)"} ` +
          `= ${ratio.toFixed(2)}:1 (needs >= ${MIN_CONTRAST}:1; ` +
          `color won by ${glyph.selector}, background won by ${background?.selector ?? "(surface)"})`,
      );
    });
  }
}

/* 模型列表里自己上色的小字（供应商分组副标题、行内元信息）：
   它们坐在 --app-content-surface 上，用 --muted-foreground 很容易在浅色主题下糊成一片。 */
const quietTextCases: Case[] = [
  { name: "settings group meta", element: { type: "span", classes: ["settings-group-meta"] } },
  { name: "settings row meta", element: { type: "span", classes: ["settings-row-meta"] } },
  { name: "settings row model id", element: { type: "span", classes: ["settings-row-id"] } },
  { name: "provider picker row", element: { type: "button", classes: ["provider-picker-row"] } },
  // 名字那截自己不写颜色，靠 trigger 继承，所以测 trigger。
  { name: "provider picker trigger", element: { type: "button", classes: ["provider-picker-trigger"] } },
  { name: "provider picker trigger meta", element: { type: "span", classes: ["provider-picker-trigger-meta"] } },
  { name: "provider picker empty state", element: { type: "p", classes: ["provider-picker-empty"] } },
  { name: "provider picker meta", element: { type: "span", classes: ["provider-picker-meta"] } },
  { name: "provider picker url", element: { type: "span", classes: ["provider-picker-url"] } },
  { name: "add model id", element: { type: "span", classes: ["add-model-id"] } },
];

for (const theme of ["light", "dark"] as const) {
  const ancestors = theme === "dark" ? [["dark"]] : [];
  const tokens = TOKENS[theme];
  const surface = flatten(resolveColor("var(--app-content-surface)", tokens), [0, 0, 0] as RGB);

  for (const testCase of quietTextCases) {
    test(`models list ${testCase.name} stays readable in the ${theme} theme`, () => {
      const el: Element = { ...testCase.element, ancestors };
      const glyph = declared(el, "color");
      assert.ok(glyph, `nothing sets a colour for "${el.classes.join(".")}" (${theme} theme)`);
      const background = declared(el, "background") ?? declared(el, "background-color");
      const fg = flatten(resolveColor(glyph.value, tokens), surface);
      const bg = background ? flatten(resolveColor(background.value, tokens), surface) : surface;
      const ratio = contrast(fg, bg);
      assert.ok(
        ratio >= MIN_CONTRAST,
        `${testCase.name} [${theme}]: ${glyph.value} on ${background?.value ?? "surface"} = ${ratio.toFixed(2)}:1`,
      );
    });
  }
}
