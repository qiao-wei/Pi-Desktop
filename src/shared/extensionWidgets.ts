/**
 * Extension widget (`ctx.ui.setWidget`) display helpers.
 *
 * Extensions push status text into the composer area. Pi Desktop collects all of them into a
 * single status rail above the composer (`ExtensionStatusRail` in `src/app/App.tsx`), so the
 * per-widget presentation logic lives here as pure functions and is unit-tested directly.
 */

/** A widget as it reaches the renderer: the plain text lines plus where the extension wanted it. */
export interface ExtensionWidget {
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

/**
 * Words that mean "something went wrong" in an extension line. Used only to light a warning dot
 * on the collapsed chip; the full text still lives in the expanded rail.
 *
 * `\b` after `err` keeps this from matching inside unrelated words, while the `err` branch still
 * catches pi-monitor's "3 err" and "(err 3, 1%)" summaries.
 */
const WARNING_PATTERN = /\b(?:err|error|errors|failed|failure|warn|warning)\b/i;

/** Chip label for a widget key; falls back to a generic name when the key is blank. */
export function extensionWidgetLabel(key: string): string {
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : "extension";
}

/** Whether any line reads like a failure/warning, so the chip can flag it. */
export function extensionWidgetHasWarning(lines: readonly string[]): boolean {
  return lines.some((line) => WARNING_PATTERN.test(line));
}