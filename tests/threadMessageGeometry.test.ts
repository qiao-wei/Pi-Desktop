/**
 * Regression test for "加载历史对话，鼠标往上滚动时，乱跳".
 *
 * Why this exists: message roots used to carry `content-visibility: auto` +
 * `contain-intrinsic-size: auto 200px` so long threads only paid layout for what
 * was on screen. Chrome substitutes the *last remembered* height for a skipped
 * row, and these rows mount empty - measured on a real 58-bubble session the
 * offscreen roots reported 0px and 30px where their true heights are 41px and
 * 270px, so a thread that is 12149px tall presented a scroll range of 1738px.
 * Wheeling up laid out everything above the fold at once, and one 300px gesture
 * moved the content by 1487px, then 2616px, then 1676px. The browser cannot
 * compensate: `ChatThread.tsx` pins the scroller to `overflow-anchor: none` for
 * as long as it owns the position.
 *
 * The bug is a stylesheet declaration, so no function in the repo can catch it.
 * This resolves the cascade for the elements the thread actually renders and
 * asserts they keep real geometry. The element chains below were read off the
 * running app (`.scratch/chain.py`), not invented.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesCss = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");

interface Node {
  tag: string;
  classes: string[];
  attrs: Record<string, string>;
}

/** The message root of a user bubble, outermost ancestor first. */
const USER_ROOT: Node[] = [
  { tag: "div", classes: ["aui-thread"], attrs: {} },
  { tag: "div", classes: ["aui-thread-viewport"], attrs: {} },
  {
    tag: "div",
    classes: ["grid", "auto-rows-auto", "content-start", "gap-y-2", "px-2"],
    attrs: { "data-slot": "aui_user-message-root", "data-role": "user", "data-message-id": "t1#user" },
  },
];

/** The message root of an assistant bubble. */
const ASSISTANT_ROOT: Node[] = [
  { tag: "div", classes: ["aui-thread"], attrs: {} },
  { tag: "div", classes: ["aui-thread-viewport"], attrs: {} },
  {
    tag: "div",
    classes: ["relative", "flex", "flex-col", "gap-2", "px-2"],
    attrs: {
      "data-slot": "aui_assistant-message-root",
      "data-role": "assistant",
      "data-message-id": "t1#assistant",
    },
  },
];

interface Decl {
  property: string;
  value: string;
  important: boolean;
}

interface Rule {
  selector: string;
  decls: Decl[];
}

/** Declaration blocks with comments stripped; at-rules are skipped (no plain-element rules there). */
function parse(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped))) {
    const selectorText = match[1].trim();
    if (!selectorText || selectorText.startsWith("@")) {
      continue;
    }
    const decls: Decl[] = [];
    for (const raw of match[2].split(";")) {
      const decl = raw.trim();
      const colon = decl.indexOf(":");
      if (colon < 0) {
        continue;
      }
      const value = decl.slice(colon + 1).trim();
      decls.push({
        property: decl.slice(0, colon).trim(),
        value: value.replace(/\s*!important$/, ""),
        important: /!important$/.test(value),
      });
    }
    for (const selector of selectorText.split(",").map((s) => s.trim()).filter(Boolean)) {
      rules.push({ selector, decls });
    }
  }
  return rules;
}

const RULES = parse(stylesCss);

/**
 * Does a `[data-message-id]`-shaped compound (`.cls`, `tag`, `[attr]`, `[attr=v]`)
 * describe this node? Anything this mini resolver cannot express - pseudo-classes,
 * other operators - never matches rather than guessing.
 */
function matchesCompound(compound: string, node: Node): boolean {
  if (!compound) {
    return false;
  }
  const attrs = [...compound.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
  const withoutAttrs = compound.replace(/\[[^\]]*\]/g, "");
  if (/[:+~^$*|()]/.test(withoutAttrs)) {
    return false;
  }
  const classes = withoutAttrs.match(/\.[A-Za-z0-9_-]+/g)?.map((s) => s.slice(1)) ?? [];
  const tag = /^[A-Za-z][A-Za-z0-9-]*/.exec(withoutAttrs.replace(/\.[A-Za-z0-9_-]+/g, ""))?.[0];
  if (tag && node.tag !== tag.toLowerCase()) {
    return false;
  }
  if (!classes.every((c) => node.classes.includes(c))) {
    return false;
  }
  for (const attr of attrs) {
    const [name, ...rest] = attr.split("=");
    if (!name || name.includes("~") || name.includes("^") || name.includes("$") || name.includes("*")) {
      return false;
    }
    if (rest.length === 0) {
      if (!(name in node.attrs)) {
        return false;
      }
      continue;
    }
    const want = rest.join("=").replace(/^["']|["']$/g, "");
    if (node.attrs[name] !== want) {
      return false;
    }
  }
  return true;
}

/** Descendant and child combinators only; anything else does not match. */
function matches(selector: string, chain: Node[]): boolean {
  const tokens = selector
    .replace(/\s*>\s*/g, " > ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0 || /[+~]/.test(selector)) {
    return false;
  }
  // (compound | ">")…, with no leading or trailing combinator.
  if (tokens[0] === ">" || tokens[tokens.length - 1] === ">") {
    return false;
  }
  const steps: Array<{ compound: string; parentOnly: boolean }> = [];
  let parentOnly = false;
  for (const token of tokens) {
    if (token === ">") {
      parentOnly = true;
    } else {
      steps.push({ compound: token, parentOnly });
      parentOnly = false;
    }
  }
  if (steps.length > chain.length || !matchesCompound(steps[steps.length - 1].compound, chain[chain.length - 1])) {
    return false;
  }
  let cursor = chain.length - 2;
  for (let i = steps.length - 2; i >= 0; i -= 1) {
    const { compound, parentOnly: strict } = steps[i];
    if (!strict) {
      while (cursor >= 0 && !matchesCompound(compound, chain[cursor])) {
        cursor -= 1;
      }
    }
    if (cursor < 0 || !matchesCompound(compound, chain[cursor])) {
      return false;
    }
    cursor -= 1;
  }
  return true;
}

/**
 * The declaration that wins for `property` on `chain`, or `null` when none is set.
 *
 * Document order decides between rules of equal specificity, which is the only
 * tie-break this sheet needs; `!important` outranks everything regardless.
 */
function winning(chain: Node[], property: string): string | null {
  let value: string | null = null;
  let important = false;
  for (const rule of RULES) {
    if (!matches(rule.selector, chain)) {
      continue;
    }
    for (const decl of rule.decls) {
      if (decl.property !== property) {
        continue;
      }
      if (!important || decl.important) {
        value = decl.value;
        important = decl.important;
      }
    }
  }
  return value;
}

for (const [label, chain] of [
  ["user", USER_ROOT],
  ["assistant", ASSISTANT_ROOT],
] as const) {
  test(`${label} message root keeps real geometry (no content-visibility estimates)`, () => {
    assert.equal(
      winning(chain, "content-visibility"),
      null,
      "a skipped row falls back to its last remembered height (0px for these), so the scroll " +
        "range grows several-fold the moment the reader wheels up",
    );
    assert.equal(
      winning(chain, "contain-intrinsic-size"),
      null,
      "only meaningful together with content-visibility; leaving it behind invites the same bug",
    );
  });
}

test("the cascade resolver describes the rendered thread (sanity checks)", () => {
  // If any of these stops matching, the element chains above no longer line up
  // with what the app renders and the assertions above would be vacuous.
  assert.equal(winning(USER_ROOT.slice(0, 2), "overflow-y"), "auto");
  assert.equal(winning(USER_ROOT, "width"), "100%");
  assert.equal(winning(USER_ROOT, "min-width"), "0");
  assert.equal(winning(ASSISTANT_ROOT, "width"), "100%");
});

test("the content-visibility A/B experiment switch went with the experiment", () => {
  assert.doesNotMatch(stylesCss, /data-pi-desktop-cv/);
  assert.doesNotMatch(
    readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8"),
    /pi-desktop\.cv/,
    "the localStorage key only existed to steer the containment experiment",
  );
});
