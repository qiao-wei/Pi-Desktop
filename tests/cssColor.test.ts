/**
 * Pin the pure-JS colour engine in `tests/lib/cssColor.ts` against Chromium's own output.
 *
 * `tests/fixtures/chromiumColors.json` was captured from headless Chromium (canvas raster of
 * each value composited over opaque black). The engine is only ever as trustworthy as this
 * test, and the contrast assertions in `composerButtonContrast.test.ts` depend on it.
 *
 * Re-capture after changing the palette tokens (needs a browser, not part of `npm test`):
 *   python3 scripts/captureCssGoldens.py
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { contrast, flatten, resolveColor, type Tokens } from "./lib/cssColor.ts";
import { themeTokens } from "./lib/cssTokens.ts";
import { defaultThemeCss } from "./lib/themeSources.ts";

const goldens = JSON.parse(
  readFileSync(new URL("./fixtures/chromiumColors.json", import.meta.url), "utf8"),
) as { light: Record<string, number[]>; dark: Record<string, number[]> };

const TOKENS = themeTokens(defaultThemeCss);

/** Chromium rasterised over opaque black, so the engine has to be flattened the same way. */
const BACKDROP: [number, number, number] = [0, 0, 0];
/** ±2: 8-bit rounding of the alpha compositing / oklab->sRGB matrices. */
const MAX_CHANNEL_DELTA = 2;

for (const theme of ["light", "dark"] as const) {
  const table = TOKENS[theme];
  for (const [value, chromium] of Object.entries(goldens[theme])) {
    if (value === "_comment") continue;
    test(`resolves "${value}" like Chromium does (${theme})`, () => {
      const mine = flatten(resolveColor(value, table), BACKDROP);
      assert.ok(
        mine.every((channel, i) => Math.abs(channel - chromium[i]) <= MAX_CHANNEL_DELTA),
        `${value}: engine ${JSON.stringify(mine)} vs Chromium ${JSON.stringify(chromium)} ` +
          `(drift beyond ${MAX_CHANNEL_DELTA} per channel)`,
      );
    });
  }
}

test("transparent 不是“未知颜色”，而是背景本身", () => {
  const backdrop: [number, number, number] = [24, 200, 90];
  assert.deepEqual(flatten(resolveColor("transparent", TOKENS.light), backdrop), backdrop);
});

test("contrast() matches the WCAG ratio for known pairs", () => {
  assert.equal(contrast([255, 255, 255], [0, 0, 0]), 21);
  assert.equal(contrast([255, 255, 255], [255, 255, 255]), 1);
  // #767676 on white is the canonical 4.54:1 AA boundary.
  const ratio = contrast([118, 118, 118], [255, 255, 255]);
  assert.ok(ratio > 4.5 && ratio < 4.6, `got ${ratio}`);
});
