/**
 * Minimal CSS colour engine shared by the style tests.
 *
 * It exists so the tests can resolve the *winning* declaration of a real stylesheet
 * (`var(--token)`, `oklch()`, `oklab()`, `color-mix()`, hex, rgb) into sRGB and reason
 * about contrast, without a browser. `tests/cssColor.test.ts` pins this engine against
 * Chromium's own output, so the engine cannot silently drift.
 */

export type RGB = [number, number, number];
export type Tokens = Record<string, string>;

export interface Color {
  rgb: RGB;
  alpha: number;
}

export function hexToRgb(hex: string): RGB {
  const digits = hex.replace("#", "");
  const full = digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as RGB;
}

function srgbToLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}

function oklabToLinearSrgb(L: number, a: number, b: number): RGB {
  const l = (L + 0.396337777 * a + 0.215803757 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearSrgbToOklab(rgb: RGB): RGB {
  const [r, g, b] = rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675718 * s,
  ];
}

/** Split a string on top-level separators (commas by default), keeping `var(...)` intact. */
export function splitTopLevel(text: string, separator = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === separator && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out.filter((part) => part !== "");
}

function num(token: string, raw: string): number {
  const value = parseFloat(token);
  if (!Number.isFinite(value)) throw new Error(`cannot parse colour: "${raw}"`);
  return token.endsWith("%") ? value / 100 : value;
}

/**
 * Resolve a CSS colour value to sRGB.
 * `tokens` supplies custom property values; `backdrop` is the surface alpha is
 * composited onto (defaults to opaque black, matching how the goldens were captured).
 */
export function resolveColor(value: string, tokens: Tokens, seen = 0): Color {
  const text = value.trim().replace(/!important$/, "");
  if (seen > 20) throw new Error(`token cycle while resolving "${value}"`);

  // 颜色关键字里只有这两个在用（其余都该抛错，不让测试默默当成透明）。
  // `transparent` 按规范就是 rgba(0,0,0,0)，压到背景上就是背景本身。
  if (text === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
  if (text === "white") return { rgb: [255, 255, 255], alpha: 1 };

  const varRef = text.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+)\s*)?\)$/);
  if (varRef) {
    const token = tokens[varRef[1]] ?? varRef[2];
    if (!token) throw new Error(`token ${varRef[1]} is not defined`);
    return resolveColor(token, tokens, seen + 1);
  }

  if (/^#([\da-f]{3}|[\da-f]{6})$/i.test(text)) {
    return { rgb: hexToRgb(text), alpha: 1 };
  }

  const func = text.match(/^([a-z-]+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)$/i);
  if (!func) throw new Error(`unsupported colour value: "${value}"`);
  const [, name, innerRaw] = func;

  // Modern syntax allows `oklch(L C H / A)`; keep the colour unpremultiplied.
  const [colorPart, alphaPart] = splitTopLevel(innerRaw, "/");
  const alpha = alphaPart === undefined ? 1 : num(alphaPart, value);

  if (name === "color-mix") return mix(colorPart ?? "", tokens, value, seen, alpha);

  const args = splitTopLevel(colorPart ?? "").flatMap((part) => splitTopLevel(part, " "));
  let rgb: RGB;
  if (name === "rgb" || name === "rgba") {
    rgb = [num(args[0], value), num(args[1], value), num(args[2], value)].map(Math.round) as RGB;
  } else if (name === "oklch") {
    const L = num(args[0], value);
    const C = num(args[1] ?? "0", value);
    const H = (num(args[2] ?? "0", value) * Math.PI) / 180;
    rgb = oklabToLinearSrgb(L, C * Math.cos(H), C * Math.sin(H)).map(linearToSrgb) as RGB;
  } else if (name === "oklab") {
    rgb = oklabToLinearSrgb(num(args[0], value), num(args[1], value), num(args[2], value)).map(
      linearToSrgb,
    ) as RGB;
  } else {
    throw new Error(`unsupported colour function "${name}" in "${value}"`);
  }

  return { rgb, alpha };
}

/**
 * `in oklab, var(--x) 40%, var(--y)` -> colour + alpha, mixed the way the CSS spec says:
 * premultiplied inside the interpolation space (this is what Chromium does, and it matters
 * as soon as one of the two colours carries alpha).
 */
function mix(
  inner: string,
  tokens: Tokens,
  raw: string,
  seen: number,
  alphaOverride: number,
): Color {
  const parts = splitTopLevel(inner);
  const hasMethod = (parts[0] ?? "").startsWith("in ");
  const method = hasMethod ? parts[0].slice(3).trim() : "oklab";
  const colors = hasMethod ? parts.slice(1) : parts;
  const parse = (part: string) => {
    const pct = part.match(/^(.*?)\s(-?[\d.]+)%$/);
    return { color: pct ? pct[1] : part, percent: pct ? parseFloat(pct[2]) / 100 : undefined };
  };
  const [a, b] = colors.map(parse);
  if (!a?.color || !b?.color) throw new Error(`cannot parse color-mix "${raw}"`);
  const ca = resolveColor(a.color, tokens, seen + 1);
  const cb = resolveColor(b.color, tokens, seen + 1);
  const pa = a.percent ?? 0.5;
  const pb = b.percent ?? 1 - pa;
  const total = pa + pb || 1;
  const t = pb / total;
  const resultAlpha = Math.min(1, (ca.alpha * pa + cb.alpha * pb) / total) || 1;

  const toLinear = (rgb: RGB) => rgb.map(srgbToLinear) as RGB;
  const isOklab = method === "oklab" || method === "oklch";
  const isSrgbGamma = method === "srgb" || method === "rgb";
  const space = (color: Color): RGB =>
    isOklab ? linearSrgbToOklab(toLinear(color.rgb)) : isSrgbGamma ? color.rgb.map((c) => c / 255) as RGB : toLinear(color.rgb);
  const fromSpace = (value: RGB): RGB => {
    if (isSrgbGamma) return value.map((v) => Math.round(v * 255)) as RGB;
    const linear = isOklab ? oklabToLinearSrgb(...value) : value;
    return linear.map(linearToSrgb) as RGB;
  };

  const sa = space(ca);
  const sb = space(cb);
  // premultiply -> interpolate -> unpremultiply
  const mixed: RGB = [0, 1, 2].map((i) => {
    const va = sa[i] * ca.alpha;
    const vb = sb[i] * cb.alpha;
    return va + (vb - va) * t;
  }) as RGB;
  const rgb = fromSpace(mixed.map((v) => v / resultAlpha) as RGB);
  return { rgb, alpha: alphaOverride * resultAlpha };
}

/** Composite a (possibly translucent) colour onto an opaque surface. */
export function flatten(color: Color, backdrop: RGB): RGB {
  return composite(color.rgb, color.alpha, backdrop);
}

/** Resolve a value and immediately flatten it onto `backdrop`. */
export function resolveOn(value: string, tokens: Tokens, backdrop: RGB): RGB {
  return flatten(resolveColor(value, tokens), backdrop);
}

function composite(rgb: RGB, alpha: number, backdrop: RGB): RGB {
  if (alpha >= 1) return rgb;
  return rgb.map((c, i) => Math.round(c * alpha + backdrop[i] * (1 - alpha))) as RGB;
}

export function relativeLuminance(rgb: RGB): number {
  const [r, g, b] = rgb.map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque sRGB colours. */
export function contrast(a: RGB, b: RGB): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}
