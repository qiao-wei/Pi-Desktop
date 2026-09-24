/**
 * Reading terminal text outside a terminal.
 *
 * Extensions draw interactive panels (`ctx.ui.custom()`) as arrays of terminal lines, and the
 * panel contract is keyboard-only: the component owns a cursor and reacts to key sequences.
 * Pi Desktop renders those panels inside the window instead of a terminal, so the bridge ships
 * the raw lines and this module turns them into something a DOM surface can use:
 *
 * - `stripTerminalSequences` - drop escape sequences, keep the text (the plain "TUI view").
 * - `parseTerminalLines`      - keep the *styling*: SGR (colour/weight) and OSC 8 links become a
 *                               small serialisable style record instead of raw escape bytes, so
 *                               the renderer never has to interpret terminal output itself and
 *                               never needs `dangerouslySetInnerHTML`.
 * - `readRowTargets`          - the click affordance: which rendered rows the extension's cursor
 *                               can land on, and the key sequence that moves it there. A click is
 *                               translated into exactly the keystrokes a user would have typed.
 *
 * Everything here is pure, so it is unit-tested directly and reusable by any surface that wants
 * to render extension output (the desktop panel today; a preview/inspector later).
 */

/** A colour the renderer understands: an `ansi-*` token, or a ready-to-use CSS colour. */
export type TerminalColor = string;

/**
 * The accent colour the bridge uses for an extension panel's selected row (`theme.selected(...)`).
 *
 * `readRowTargets` needs it to tell a cursor row from an ordinary expanded row: both draw `▾`,
 * only the cursor row is accented. Keep in sync with `extensionUiAnsiAccent` in
 * `server/index.mjs` - `tests/extensionUiMode.test.ts` pins the two together.
 */
export const EXTENSION_UI_ACCENT_COLOR = "ansi-bright-cyan";

export interface TerminalStyle {
  color?: TerminalColor;
  background?: TerminalColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
  /** OSC 8 target; `undefined` means "not a link". */
  link?: string;
}

export interface TerminalSegment {
  text: string;
  style: TerminalStyle;
}

export interface TerminalLine {
  segments: TerminalSegment[];
  /** The line's text with all styling and escapes removed - handy for titles and tests. */
  text: string;
}

/** Key sequences the panels listen for; shared so buttons and clicks send the same bytes. */
export const TERMINAL_KEYS = {
  up: "\u001b[A",
  down: "\u001b[B",
  enter: "\r",
  space: " ",
} as const;

const ESC = "\u001b";
const BEL = "\u0007";

/** Basic/bright ANSI colours (SGR 30-37, 90-97); the dim half maps onto the muted tokens. */
const ANSI_BASIC_COLOR_NAMES = [
  "ansi-black",
  "ansi-red",
  "ansi-green",
  "ansi-yellow",
  "ansi-blue",
  "ansi-magenta",
  "ansi-cyan",
  "ansi-white",
  "ansi-bright-black",
  "ansi-bright-red",
  "ansi-bright-green",
  "ansi-bright-yellow",
  "ansi-bright-blue",
  "ansi-bright-magenta",
  "ansi-bright-cyan",
  "ansi-bright-white",
] as const;

/** Drop every escape sequence, keep the printable text (and the existing behaviour of callers). */
export function stripTerminalSequences(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "");
}

export function parseTerminalLines(lines: readonly string[]): TerminalLine[] {
  return lines.map(parseTerminalLine);
}

function parseTerminalLine(line: string): TerminalLine {
  const segments: TerminalSegment[] = [];
  let style: TerminalStyle = {};
  let pending = "";
  let index = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && sameStyle(last.style, style)) {
      last.text += pending;
    } else {
      segments.push({ text: pending, style: { ...style } });
    }
    pending = "";
  };

  while (index < line.length) {
    const char = line[index]!;

    if (char === ESC) {
      const escape = readEscapeSequence(line, index);
      if (!escape) {
        index += 1;
        continue;
      }
      index = escape.end;
      if (escape.kind === "sgr") {
        // Close the run with the style that produced it *before* switching styles.
        flush();
        style = applySgr(style, escape.params);
      } else if (escape.kind === "link") {
        flush();
        style = withLink(style, escape.uri);
      }
      continue;
    }

    const code = char.charCodeAt(0);
    // Control characters are zero-width artefacts in a terminal; a DOM row has no use for them.
    if (code < 0x20 || code === 0x7f) {
      index += 1;
      continue;
    }

    pending += char;
    index += 1;
  }

  flush();
  return { segments, text: segments.map((segment) => segment.text).join("") };
}

type EscapeSequence =
  | { kind: "sgr"; params: number[]; end: number }
  | { kind: "link"; uri: string | undefined; end: number }
  | { kind: "ignored"; end: number };

/**
 * A single ESC-introduced sequence. Returns `undefined` for a lone ESC, which callers drop.
 *
 * Non-SGR CSI sequences (erase, cursor moves) are consumed and ignored: the bridge renders one
 * component into standalone lines, so they can never affect a neighbouring row.
 */
function readEscapeSequence(line: string, start: number): EscapeSequence | undefined {
  const next = line[start + 1];
  if (next === undefined) return undefined;

  if (next === "]") {
    let index = start + 2;
    while (index < line.length && line[index] !== BEL && !(line[index] === ESC && line[index + 1] === "\\")) {
      index += 1;
    }
    const payload = line.slice(start + 2, index);
    const end = index >= line.length ? line.length : line[index] === BEL ? index + 1 : index + 2;
    return { kind: "link", uri: readOsc8Uri(payload), end };
  }

  if (next === "[") {
    let index = start + 2;
    while (index < line.length) {
      const char = line[index]!;
      if (char >= "@" && char <= "~") {
        const end = index + 1;
        if (char !== "m") return { kind: "ignored", end };
        return { kind: "sgr", params: readSgrParams(line.slice(start + 2, index)), end };
      }
      index += 1;
    }
    return { kind: "ignored", end: line.length };
  }

  // Charset designators (`ESC ( B`) are three bytes; two-byte escapes are the common case.
  const designator = "(#%*+-./".includes(next);
  return { kind: "ignored", end: Math.min(line.length, start + (designator ? 3 : 2)) };
}

/** `OSC 8 ; params ; uri` (empty uri closes the link); anything else is not a hyperlink. */
function readOsc8Uri(payload: string): string | undefined {
  if (!payload.startsWith("8;")) return undefined;
  const separator = payload.indexOf(";", 2);
  if (separator === -1) return undefined;
  const uri = payload.slice(separator + 1);
  return uri.length > 0 ? uri : undefined;
}

function readSgrParams(raw: string): number[] {
  if (raw.length === 0) return [0];
  return raw.split(";").map((part) => {
    const value = Number.parseInt(part.split(":")[0] ?? "", 10);
    return Number.isFinite(value) ? value : 0;
  });
}

function applySgr(style: TerminalStyle, params: readonly number[]): TerminalStyle {
  // Every sequence is a patch on the current state (`39` clears only the colour), so start from
  // the running style; `0` is the one code that resets everything except the OSC-managed link.
  let next: TerminalStyle = { ...style };

  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]!;

    if (code === 0) {
      next = style.link ? { link: style.link } : {};
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 7) {
      next.inverse = true;
    } else if (code === 9) {
      next.strike = true;
    } else if (code === 21 || code === 22) {
      delete next.bold;
      if (code === 22) delete next.dim;
    } else if (code === 23) {
      delete next.italic;
    } else if (code === 24) {
      delete next.underline;
    } else if (code === 27) {
      delete next.inverse;
    } else if (code === 29) {
      delete next.strike;
    } else if (code === 39) {
      delete next.color;
    } else if (code === 49) {
      delete next.background;
    } else if (code >= 30 && code <= 37) {
      next.color = ANSI_BASIC_COLOR_NAMES[code - 30]!;
    } else if (code >= 40 && code <= 47) {
      next.background = ANSI_BASIC_COLOR_NAMES[code - 40]!;
    } else if (code >= 90 && code <= 97) {
      next.color = ANSI_BASIC_COLOR_NAMES[code - 90 + 8]!;
    } else if (code >= 100 && code <= 107) {
      next.background = ANSI_BASIC_COLOR_NAMES[code - 100 + 8]!;
    } else if (code === 38 || code === 48) {
      const extended = readExtendedColor(params, index);
      if (extended) {
        if (code === 38) next.color = extended.color;
        else next.background = extended.color;
        index = extended.next;
      }
    }
  }

  return next;
}

/** `38;5;<index>` and `38;2;<r>;<g>;<b>`; returns the last consumed parameter index. */
function readExtendedColor(
  params: readonly number[],
  index: number,
): { color: TerminalColor; next: number } | undefined {
  const mode = params[index + 1];
  if (mode === 5) {
    const value = params[index + 2];
    if (value === undefined || value < 0 || value > 255) return undefined;
    return { color: ansi256ToColor(value), next: index + 2 };
  }
  if (mode === 2) {
    const red = params[index + 2];
    const green = params[index + 3];
    const blue = params[index + 4];
    if (![red, green, blue].every((value) => value !== undefined && value >= 0 && value <= 255)) {
      return undefined;
    }
    return { color: rgbToHex(red!, green!, blue!), next: index + 4 };
  }
  return undefined;
}

function ansi256ToColor(index: number): TerminalColor {
  if (index < 16) return ANSI_BASIC_COLOR_NAMES[index]!;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return rgbToHex(level, level, level);
  }
  const value = index - 16;
  const channel = (part: number): number => Math.round((part * 255) / 5);
  return rgbToHex(channel(Math.floor(value / 36)), channel(Math.floor((value % 36) / 6)), channel(value % 6));
}

function rgbToHex(red: number, green: number, blue: number): string {
  const hex = (value: number): string => value.toString(16).padStart(2, "0");
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

function withLink(style: TerminalStyle, uri: string | undefined): TerminalStyle {
  if (uri === undefined) {
    const { link: _link, ...rest } = style;
    return rest;
  }
  return { ...style, link: uri };
}

function sameStyle(a: TerminalStyle, b: TerminalStyle): boolean {
  return (
    a.color === b.color &&
    a.background === b.background &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.strike === b.strike &&
    a.link === b.link
  );
}

export interface TerminalRowTarget {
  /** The extension's cursor already sits on this row (nothing to move before activating). */
  cursor: boolean;
  /** Keystrokes that move the cursor onto this row and activate it, in order. */
  keys: string[];
}

/**
 * The glyphs the panels use for a navigable row's prefix column: the cursor marker (`▸`, or `▾`
 * when the cursor sits on an expanded row) and the idle collapsed marker (`·`).
 */
const PREFIX_GLYPHS = new Set(["▸", "▾", "·"]);
/** The check/toggle glyphs used for tools and resource rows. */
const TOGGLE_GLYPHS = new Set(["●", "◐", "○"]);
/** Frame characters the panels draw around their content (`│`, separators, corners). */
const FRAME_GLYPHS = new Set(["│", "─", "├", "┤", "╭", "╮", "╰", "╯", "┌", "┐", "└", "┘", "┃"]);

interface RowReading {
  selectable: boolean;
  cursor: boolean;
}

/**
 * Which rendered rows respond to up/down + enter, and what a click on one should send.
 *
 * This is the "A-plan" heuristic: the component contract carries no semantics, so a click can
 * only be expressed as the keystrokes a keyboard user would type. Rather than guessing row
 * positions, it reads the panels' own row grammar:
 *
 *   `▸ · ▾` in the prefix column marks a server row; two or more leading spaces followed by a
 *   toggle glyph (`● ◐ ○`) marks a tool/resource row. Anything else (banner, search box, hint
 *   line, stats, progress dots, discard prompt) is not navigable and stays inert.
 *
 * A row is the cursor row when its prefix glyph is `▸`, or `▾` in the accent colour - panels
 * draw the cursor with `theme.selected(...)` and idle rows with the muted border colour, and
 * `·` is only ever used for idle collapsed rows. When no cursor row can be found the map comes
 * back empty, so the UI shows no click affordance instead of sending keys that land somewhere
 * unexpected.
 */
export function readRowTargets(lines: readonly TerminalLine[]): Map<number, TerminalRowTarget> {
  const readings = lines.map(readRow);
  const cursorIndex = findCursorIndex(readings);
  if (cursorIndex === -1) return new Map();

  const rows: number[] = [];
  readings.forEach((reading, index) => {
    if (reading.selectable) rows.push(index);
  });

  const cursorSlot = rows.indexOf(cursorIndex);
  const targets = new Map<number, TerminalRowTarget>();
  for (const [slot, index] of rows.entries()) {
    const delta = slot - cursorSlot;
    const keys: string[] = Array.from({ length: Math.abs(delta) }, () =>
      delta < 0 ? TERMINAL_KEYS.up : TERMINAL_KEYS.down,
    );
    keys.push(TERMINAL_KEYS.enter);
    targets.set(index, { cursor: index === cursorIndex, keys });
  }
  return targets;
}

function readRow(line: TerminalLine): RowReading {
  const cells: Array<{ char: string; style: TerminalStyle }> = [];
  for (const segment of line.segments) {
    for (const char of segment.text) cells.push({ char, style: segment.style });
  }

  // Skip the frame the panel draws around its content, then count the indent after it.
  let index = 0;
  while (index < cells.length && FRAME_GLYPHS.has(cells[index]!.char)) index += 1;
  let spaces = 0;
  while (index + spaces < cells.length && cells[index + spaces]!.char === " ") spaces += 1;

  const glyph = cells[index + spaces]?.char;
  const style = cells[index + spaces]?.style ?? {};
  const isPrefix = glyph !== undefined && PREFIX_GLYPHS.has(glyph);
  const isToggle = glyph !== undefined && TOGGLE_GLYPHS.has(glyph);

  return {
    selectable: isPrefix || (isToggle && spaces >= 2),
    cursor: isPrefix && (glyph === "▸" || (glyph === "▾" && style.color === EXTENSION_UI_ACCENT_COLOR)),
  };
}

function findCursorIndex(readings: readonly RowReading[]): number {
  // `▸` is drawn only for the cursor on a collapsed row, so it is unique by construction; `▾`
  // and `·`-style idle rows would collide, which is exactly what the accent check filters out.
  return readings.findIndex((reading) => reading.cursor);
}

/**
 * Pointer gestures → the arrow keys the panel expects (the second half of the "A-plan" input
 * translation: a click is "move the cursor there, then enter", a wheel is "move one row").
 *
 * Wheel handling has to live here rather than at each call site because browser deltas are the
 * wrong unit: a wheel notch and a trackpad flick differ by an order of magnitude, and both
 * arrive as floods of small events. This accumulates travel and emits discrete steps, so the
 * panel sees exactly the key presses a keyboard user would have produced.
 */
export interface WheelStepOptions {
  /** Travel that counts as one row. */
  stepPx?: number;
  /** A pause longer than this starts a new gesture: leftover travel is dropped, not banked. */
  resetMs?: number;
  /** Upper bound per call, so one violent flick cannot spam the panel. */
  maxSteps?: number;
  lineHeightPx?: number;
  pageHeightPx?: number;
}

const WHEEL_STEP_DEFAULTS = {
  stepPx: 40,
  resetMs: 160,
  maxSteps: 3,
  lineHeightPx: 16,
  pageHeightPx: 600,
} as const;

/** `deltaMode` is in lines or pages for some devices (Firefox, and some mice); normalise to pixels. */
export function wheelDeltaPx(
  event: { deltaY: number; deltaMode?: number },
  options: WheelStepOptions = {},
): number {
  const { lineHeightPx, pageHeightPx } = { ...WHEEL_STEP_DEFAULTS, ...options };
  if (!Number.isFinite(event.deltaY)) return 0;
  if (event.deltaMode === 1) return event.deltaY * lineHeightPx;
  if (event.deltaMode === 2) return event.deltaY * pageHeightPx;
  return event.deltaY;
}

export interface WheelStepReader {
  /**
   * One wheel event in, row steps out: negative = up, positive = down, `0` = keep accumulating.
   */
  push(event: { deltaY: number; deltaMode?: number }, now: number): number;
}
export function createWheelStepReader(options: WheelStepOptions = {}): WheelStepReader {
  const { stepPx, resetMs, maxSteps } = { ...WHEEL_STEP_DEFAULTS, ...options };
  let residue = 0;
  let lastAt = Number.NEGATIVE_INFINITY;

  return {
    push(event, now) {
      const delta = wheelDeltaPx(event, options);
      if (now - lastAt > resetMs) residue = 0;
      lastAt = now;
      // Reversing direction should answer the very next event, not pay off the old residue first.
      if (residue !== 0 && Math.sign(delta) !== Math.sign(residue)) residue = 0;
      residue += delta;

      const steps = Math.trunc(residue / stepPx);
      if (steps === 0) return 0;
      residue -= steps * stepPx;
      if (Math.abs(steps) <= maxSteps) return steps;

      residue = 0;
      return Math.sign(steps) * maxSteps;
    },
  };
}