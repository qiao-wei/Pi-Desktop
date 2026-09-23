/**
 * The click-to-zoom lightbox has to out-rank the window chrome it is opened over.
 *
 * Pi Desktop draws its own titlebar (`decorations: false`) and that bar sits at
 * `z-[100]`, so a `z-50` overlay left the top 40px of the screen showing the titlebar
 * — which is exactly where the close button is anchored, so the ✕ looked missing and
 * could not be clicked. The class strings are the only place this is decided (there
 * is no DOM in this test runner), so they are read off the two files that own them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const image = readFileSync(
  new URL("../src/components/assistant-ui/elements/image.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

function classesOf(marker: string, source: string): string {
  const match = new RegExp(`className="([^"]*${marker}[^"]*)"`).exec(source);
  assert.ok(match, `no className carrying "${marker}"`);
  return match[1];
}

function zIndexOf(classes: string): number {
  const match = /(?:^|\s)z-\[(\d+)\]/.exec(classes);
  assert.ok(match, `no explicit z-[n] in: ${classes}`);
  return Number(match[1]);
}

const overlay = classesOf("aui-image-zoom-overlay", image);
const content = classesOf("aui-image-zoom-content", image);
const close = classesOf("aui-image-zoom-close", image);
const titlebar = classesOf("app-titlebar", app);

test("the mask covers the whole window, titlebar included", () => {
  assert.match(overlay, /(^|\s)fixed(?=\s)/, "overlay must be fixed");
  assert.match(overlay, /(^|\s)inset-0(?=\s)/, "overlay must pin all four edges");
  assert.ok(
    zIndexOf(overlay) > zIndexOf(titlebar),
    `overlay z-${zIndexOf(overlay)} must sit above the titlebar z-${zIndexOf(titlebar)}`,
  );
});

test("the close button is a focusable button pinned to the top-right corner", () => {
  assert.match(
    image,
    /<button[\s\S]{0,400}aui-image-zoom-close/,
    "the ✕ must be a <button>, not a bare icon",
  );
  // 文案走 i18n（`image.zoomClose`），不再硬编码英文：这里钉的是「可访问名仍然存在」
  assert.match(image, /aria-label=\{t\("image\.zoomClose"\)\}/);
  assert.match(close, /(^|\s)top-\d+(?=\s)/, "anchored to the top");
  assert.match(close, /(^|\s)(end|right)-\d+(?=\s)/, "anchored to the right edge");
  // Corner padding has to clear the 40px titlebar it now floats over.
  assert.doesNotMatch(close, /(^|\s)top-[1-4](?=\s)/, "the corner button must clear the 40px titlebar strip");
});

test("the zoomed picture leaves room instead of filling the screen", () => {
  // The class names are built by concatenation on purpose: a literal arbitrary-value
  // utility written in this file is a candidate class name as far as Tailwind's
  // scanner is concerned, and it would ship in the production CSS.
  const capOf = (property: string, unit: string) =>
    Number(
      new RegExp(`(?:^|\\s)${property}-${"\\["}(?:min\\()?(\\d+)d?${unit}`).exec(content)?.[1],
    );
  const height = capOf("max-h", "vh");
  const width = capOf("max-w", "vw");
  assert.ok(Number.isFinite(height) && height > 0, "the zoomed image has no viewport height cap");
  assert.ok(Number.isFinite(width) && width > 0, "the zoomed image has no viewport width cap");
  assert.ok(height <= 80, `height cap is ${height} percent of the viewport, expected at most 80`);
  assert.ok(width <= 80, `width cap is ${width} percent of the viewport, expected at most 80`);
  // ...and the mask keeps its own padding so nothing touches the window edge.
  assert.match(overlay, /(^|\s)p-\d+(?=\s)/, "overlay needs inner padding");
});

test("every media surface shares this one lightbox", () => {
  const markdown = readFileSync(
    new URL("../src/components/assistant-ui/elements/markdown-text.tsx", import.meta.url),
    "utf8",
  );
  assert.match(markdown, /import \{ ImageZoom \} from/, "markdown images must reuse ImageZoom");
  assert.match(image, /export \{[\s\S]*ImageZoom/, "ImageZoom stays exported for those surfaces");
});
