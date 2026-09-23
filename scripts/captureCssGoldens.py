#!/usr/bin/env python3
"""Refresh tests/fixtures/chromiumColors.json from a real browser.

The pure-JS colour engine used by the style tests (tests/lib/cssColor.ts) is pinned against
Chromium's own output. Re-run this after changing the palette tokens in src/app/tailwind.css,
or whenever a golden test reports drift:

    python3 scripts/captureCssGoldens.py        # needs playwright + a chromium build

Only values that Chromium can rasterise are captured; each one is painted opaque over black
so the JSON can be compared 1:1 with flatten(resolveColor(value), [0, 0, 0]).
"""

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
TAILWIND = ROOT / "src/app/tailwind.css"
OUT = ROOT / "tests/fixtures/chromiumColors.json"

VALUES = [
    "var(--card)",
    "var(--foreground)",
    "var(--muted-foreground)",
    "var(--muted)",
    "var(--border)",
    "var(--destructive)",
    "var(--destructive-foreground)",
    "var(--accent)",
    "var(--accent-foreground)",
    "var(--background)",
    "var(--primary)",
    "var(--primary-foreground)",
    "color-mix(in oklab, var(--destructive) 78%, #000)",
    "color-mix(in oklab, var(--destructive) 40%, var(--border))",
    "color-mix(in srgb, #ffffff 50%, #000000)",
    "#26312d",
    "#ffffff",
    "rgb(38, 49, 45)",
]


def block(css: str, selector: str) -> str:
    i = css.index(f"{selector} {{")
    depth = 0
    for k in range(css.index("{", i), len(css)):
        if css[k] == "{":
            depth += 1
        elif css[k] == "}":
            depth -= 1
            if depth == 0:
                return css[i : k + 1]
    raise RuntimeError(f"unbalanced braces after {selector}")


def parse(css: str, selector: str) -> dict:
    body = block(css, selector).split("{", 1)[1].rsplit("}", 1)[0]
    out = {}
    for decl in body.split(";"):
        if ":" in decl:
            name, *rest = decl.split(":")
            name = name.strip()
            if name.startswith("--"):
                out[name] = ":".join(rest).strip()
    return out


def expand(value: str, tokens: dict) -> str:
    previous, current = None, value
    while current != previous:
        previous = current
        current = re.sub(
            r"var\(\s*(--[\w-]+)\s*\)", lambda m: tokens.get(m.group(1), "transparent"), current
        )
    return current


PROBE = """<!doctype html><html><head><meta charset=utf-8></head><body>
<canvas id=c width=4 height=4></canvas></body></html>"""

RASTER = """val => {
  const ctx = document.getElementById('c').getContext('2d');
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 4, 4);
  ctx.fillStyle = val;
  ctx.fillRect(0, 0, 4, 4);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}"""


def main() -> int:
    css = TAILWIND.read_text()
    root = parse(css, ":root")
    dark = {**root, **parse(css, ".dark")}
    probe = Path("/tmp/css_golden_probe.html")
    probe.write_text(PROBE)

    goldens = {
        "_comment": "opaque raster over rgb(0,0,0), captured from headless Chromium "
        "by scripts/captureCssGoldens.py"
    }
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(probe.as_uri())
        for theme, tokens in (("light", root), ("dark", dark)):
            goldens[theme] = {value: page.evaluate(RASTER, expand(value, tokens)) for value in VALUES}
        browser.close()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(goldens, indent=1) + "\n")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
