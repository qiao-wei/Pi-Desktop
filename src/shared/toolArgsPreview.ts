/**
 * Reading the arguments of a tool call that is **still arriving**.
 *
 * pi streams a call's arguments as JSON text, token by token (`tool_call_stream_delta`
 * → `argsText`), and only parses them once the block closes. So for most of a big
 * `write` or `edit` the row had no arguments at all: it could not say how many lines
 * the file was gaining until the call had already run.
 *
 * ZCode shows the counts *growing* while the file is written, and the information for
 * that is in the text we already have — a prefix of the JSON. What is missing is a
 * parser that tolerates a prefix:
 *
 * - a string cut by the end of the stream returns the text decoded so far (that prefix
 *   is real content — it is exactly the part the user is watching arrive);
 * - an object/array cut mid-way returns the members parsed so far;
 * - a dangling `"key":` with no value yet, or a trailing comma, is simply dropped.
 *
 * It never guesses: a field that has not started arriving is absent, not empty. Callers
 * must therefore treat a missing `content`/`newText` as "not known yet".
 */

import { deriveToolDisplay, toolDisplayForBlock, type ToolDisplay } from "./toolDisplay.ts";
import type { MessageProcessBlock } from "../types";

export interface PreviewReplaceEdit {
  oldText?: string;
  newText?: string;
}

/** The subset of a file tool's arguments a row can render before the call runs. */
export interface PreviewFileToolArgs {
  path?: string;
  content?: string;
  edits?: PreviewReplaceEdit[];
}

const LITERAL_STARTS = new Set(["t", "f", "n"]);

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index]!)) {
    index += 1;
  }
  return index;
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Decode the string literal at `start` (which must be its opening quote).
 *
 * Returns the decoded text and the index just past the closing quote. A literal the
 * stream has not finished returns its decoded prefix with `end = text.length`.
 */
function scanString(text: string, start: number): { value: string; end: number } | undefined {
  if (text[start] !== '"') {
    return undefined;
  }
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      return { value, end: index + 1 };
    }
    if (char !== "\\") {
      value += char;
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      // A backslash at the very end: the escape (and whatever it escapes) is not here
      // yet. Nothing of it can be decoded.
      return { value, end: text.length };
    }
    if (next === "u") {
      const hex = text.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { value, end: text.length };
      }
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    const decoded = ESCAPES[next];
    if (decoded === undefined) {
      value += next;
      index += 2;
      continue;
    }
    value += decoded;
    index += 2;
  }
  return { value, end: text.length };
}

/** Scan one value; `undefined` means the stream ended before the value began. */
function scanValue(text: string, start: number): { value: unknown; end: number } | undefined {
  const index = skipWhitespace(text, start);
  const char = text[index];
  if (char === undefined) {
    return undefined;
  }
  if (char === '"') {
    return scanString(text, index);
  }
  if (char === "{") {
    return scanObject(text, index);
  }
  if (char === "[") {
    return scanArray(text, index);
  }
  if (LITERAL_STARTS.has(char)) {
    const match = /^(true|false|null)/.exec(text.slice(index));
    if (!match) {
      return { value: undefined, end: text.length };
    }
    const literal = match[0];
    return { value: JSON.parse(literal), end: index + literal.length };
  }
  const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
  if (!match) {
    return { value: undefined, end: text.length };
  }
  return { value: Number(match[0]), end: index + match[0].length };
}

/** Scan an object, tolerating a truncated last member and trailing commas. */
function scanObject(text: string, start: number): { value: Record<string, unknown>; end: number } {
  const value: Record<string, unknown> = {};
  let index = skipWhitespace(text, start + 1);
  while (index < text.length) {
    const char = text[index];
    if (char === "}") {
      return { value, end: index + 1 };
    }
    if (char === ",") {
      index = skipWhitespace(text, index + 1);
      continue;
    }
    const key = scanString(text, index);
    if (!key) {
      // Not a string where a key belongs: the stream stopped in the middle of the
      // structure. Everything parsed so far is still valid.
      return { value, end: text.length };
    }
    index = skipWhitespace(text, key.end);
    if (text[index] !== ":") {
      return { value, end: text.length };
    }
    const member = scanValue(text, index + 1);
    if (!member) {
      return { value, end: text.length };
    }
    value[key.value] = member.value;
    index = skipWhitespace(text, member.end);
  }
  return { value, end: text.length };
}

/** Scan an array, tolerating a truncated last element and trailing commas. */
function scanArray(text: string, start: number): { value: unknown[]; end: number } {
  const value: unknown[] = [];
  let index = skipWhitespace(text, start + 1);
  while (index < text.length) {
    const char = text[index];
    if (char === "]") {
      return { value, end: index + 1 };
    }
    if (char === ",") {
      index = skipWhitespace(text, index + 1);
      continue;
    }
    const item = scanValue(text, index);
    if (!item) {
      return { value, end: text.length };
    }
    value.push(item.value);
    index = skipWhitespace(text, item.end);
  }
  return { value, end: text.length };
}

/** Parse as much of a JSON object prefix as there is. */
export function parseJsonPrefix(text: string): Record<string, unknown> | undefined {
  const start = skipWhitespace(text, 0);
  if (text[start] !== "{") {
    return undefined;
  }
  return scanObject(text, start).value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replaceEdits(value: unknown): PreviewReplaceEdit[] | undefined {
  // Some models send `edits` as a JSON *string*; pi unpacks it before running, so the
  // row must read it the same way or it would show counts for nothing.
  const list = typeof value === "string" ? parseJsonPrefix(value) ?? parseEditsArray(value) : value;
  if (!Array.isArray(list)) {
    return isRecord(list) && ("oldText" in list || "newText" in list) ? [pickEdit(list)] : undefined;
  }
  return list.filter(isRecord).map(pickEdit);
}

function parseEditsArray(text: string): unknown[] | undefined {
  const start = skipWhitespace(text, 0);
  if (text[start] !== "[") {
    return undefined;
  }
  return scanArray(text, start).value;
}

function pickEdit(record: Record<string, unknown>): PreviewReplaceEdit {
  const edit: PreviewReplaceEdit = {};
  if (typeof record.oldText === "string") {
    edit.oldText = record.oldText;
  }
  if (typeof record.newText === "string") {
    edit.newText = record.newText;
  }
  return edit;
}

/**
 * The file-tool arguments a streaming call has revealed so far.
 *
 * Returns `undefined` when the text is not an object at all (a different tool shape,
 * or args that have not started), so callers can keep whatever they had.
 */
export function readPartialFileToolArgs(callText: string): PreviewFileToolArgs | undefined {
  const parsed = parseJsonPrefix(callText);
  if (!parsed) {
    return undefined;
  }
  const args: PreviewFileToolArgs = {};
  if (typeof parsed.path === "string") {
    args.path = parsed.path;
  }
  if (typeof parsed.content === "string") {
    args.content = parsed.content;
  }
  const edits = replaceEdits(parsed.edits);
  if (edits) {
    args.edits = edits;
  }
  return args;
}
/**
 * How much new argument text arrives between two previews.
 *
 * Reading a partial argument JSON is linear in the text's length, so doing it per token
 * would cost O(n²) over one big `write` (a 100 KB file is ~25k tokens). ZCode has the
 * same shape of problem and re-renders on a timer; here the "timer" is the text itself,
 * which is deterministic and needs no clock: one preview per 128 characters — a few
 * lines of a file, so the number moves like a counter rather than jumping once.
 */
const PREVIEW_REFRESH_CHARS = 128;

/**
 * The row's body model for a call whose arguments are still arriving.
 *
 * While arguments stream there is no result, so the only source is the text itself:
 * {@link readPartialFileToolArgs} decodes the prefix and the `edit`/`write` branches of
 * `deriveToolDisplay` turn it into the same `fileDiff` shape the final patch produces —
 * which is why the row's `+N −M` can grow instead of appearing all at once.
 *
 * Returns the *current* display when nothing needs recomputing, so the block keeps its
 * identity between refreshes.
 */
export function streamedArgsDisplay(
  current: Extract<MessageProcessBlock, { kind: "tool" }>,
  callText: string,
  readBaseline?: (path: string) => string | undefined,
): ToolDisplay | undefined {
  // A settled block already has the authoritative patch; a preview must never win.
  if (current.status !== "streaming") {
    return current.display;
  }
  const bucket = Math.floor(callText.length / PREVIEW_REFRESH_CHARS);
  if (bucket === Math.floor(current.callText.length / PREVIEW_REFRESH_CHARS)) {
    return current.display;
  }
  const args = readPartialFileToolArgs(callText);
  if (!args) {
    return current.display;
  }
  return toolDisplayForBlock(
    deriveToolDisplay({
      toolName: current.toolName,
      args,
      result: undefined,
      baseline: args.path ? readBaseline?.(args.path) : undefined,
    }),
  );
}
