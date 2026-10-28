/**
 * The structured presentation model behind a tool row.
 *
 * pi hands the runtime a tool result of `{ content, details, structuredContent }`
 * (`dist/core/tools/*.js`) and the bridge forwards it verbatim — `promptStream.mjs`
 * writes `event.result` straight onto the wire. What the renderer used to do with
 * it was flatten it to text (`stringifyValue`), so the result box showed
 * `{"content":[{"type":"text","text":"…"}]}` and `details.patch` (the diff the
 * `edit` tool computed) and `structuredContent.exit_code` (the one `bash`
 * computed) were dropped on the floor.
 *
 * This module derives the row model **once**, for both the live stream
 * (`chatStreamProjection.toToolProcessBlock`) and the persisted transcript
 * (`assistantMessageView.assistantMessageConversationView`), so no component ever parses
 * tool text. It is deliberately presentation-free: no colors, no labels, no
 * React. `toolRowFamily` decides which row renders; `display` decides what its
 * body can show.
 */

import { budgetToolResultText, omittedFieldOf, type PayloadCut } from "./toolPayloadBudget.ts";

/**
 * Which row a tool gets. Family is derived from the tool *name* only: the row
 * must be knowable while the call is still streaming, before any result exists.
 * The set mirrors pi's builtin tool names (`read, write, edit, bash, powershell,
 * grep, ls, find`, plus `tool_search`) and MCP's `mcp__<server>__<tool>`.
 */
export type ToolRowFamily =
  | "read"
  | "write"
  | "edit"
  | "execute"
  | "search"
  | "mcp"
  | "other";

export interface ToolFileDiff {
  path: string;
  added: number;
  removed: number;
  /** Unified diff (`--- path` / `+++ path` / `@@ …`), exactly as pi emits it. */
  patch: string;
  /**
   * The body never made it onto the wire (`toolPayloadBudget` cut it) — the counts
   * above are real, the patch is empty on purpose. The body renders a note instead
   * of an empty diff; the file itself is on disk, so opening it is the real answer.
   */
  omitted?: { bytes: number };
}

/**
 * What a tool's *body* can render. `none` is honest rather than empty: the row
 * still renders (family + args + result text), it just has no structured body.
 */
export type ToolDisplay =
  | { kind: "fileDiff"; files: ToolFileDiff[] }
  | {
      kind: "terminal";
      output: string;
      exitCode?: number;
      truncated?: boolean;
      fullOutputPath?: string;
    }
  | { kind: "read"; path?: string }
  | { kind: "none" };

/**
 * Are two body models the same? The process-block merge keeps an existing block
 * object when nothing changed, so identity stability depends on comparing this
 * field too — otherwise every streamed event would look like a change and the
 * whole thread would re-render per token.
 */
export function sameToolDisplay(
  a: ToolDisplay | undefined,
  b: ToolDisplay | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined || a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "none":
      return true;
    case "read":
      return a.path === (b as Extract<ToolDisplay, { kind: "read" }>).path;
    case "terminal": {
      const other = b as Extract<ToolDisplay, { kind: "terminal" }>;
      return (
        a.output === other.output &&
        a.exitCode === other.exitCode &&
        a.truncated === other.truncated &&
        a.fullOutputPath === other.fullOutputPath
      );
    }
    case "fileDiff": {
      const other = b as Extract<ToolDisplay, { kind: "fileDiff" }>;
      return (
        a.files.length === other.files.length &&
        a.files.every((file, index) => {
          const candidate = other.files[index]!;
          return (
            file.path === candidate.path &&
            file.added === candidate.added &&
            file.removed === candidate.removed &&
            file.patch === candidate.patch
          );
        })
      );
    }
  }
}

/** pi's MCP tool name: `mcp__<server>__<tool>`, sanitized to `[A-Za-z0-9_]`. */
export function parseMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  if (!toolName.startsWith("mcp__")) {
    return null;
  }
  const rest = toolName.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator + 2 >= rest.length) {
    // pi always mints both separators (`createMcpToolName`); a name with only one
    // is not a pi MCP name, and guessing would mislabel a foreign tool.
    return null;
  }
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

export function toolRowFamily(toolName: string): ToolRowFamily {
  if (parseMcpToolName(toolName)) {
    return "mcp";
  }
  switch (toolName) {
    case "read":
      return "read";
    case "write":
      return "write";
    case "edit":
      return "edit";
    case "bash":
    case "powershell":
      return "execute";
    case "grep":
    case "ls":
    case "find":
    case "tool_search":
      return "search";
    default:
      return "other";
  }
}

interface ToolEnvelope {
  text: string;
  details: Record<string, unknown> | undefined;
  structuredContent: Record<string, unknown> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text of a pi content array: text blocks joined, everything else labelled. */
function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!isRecord(block)) {
        return "";
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "image") {
        return "[image]";
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * Normalize pi's result into text + the two structured side-channels.
 *
 * The wire carries `result` as whatever pi produced, but a hand-recorded fixture
 * (`tests/fixtures/steerRun.json`) captured it JSON-stringified, so an
 * already-stringified envelope is unwrapped too — otherwise a replayed run would
 * take a different path than a live one.
 */
export function readToolEnvelope(
  result: unknown,
  fallbackText?: string,
): ToolEnvelope {
  if (result === undefined || result === null) {
    return { text: fallbackText ?? "", details: undefined, structuredContent: undefined };
  }
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed) && ("content" in parsed || "details" in parsed)) {
          return readToolEnvelope(parsed, fallbackText);
        }
      } catch {
        // Not an envelope after all: the string is the output.
      }
    }
    return { text: result, details: undefined, structuredContent: undefined };
  }
  if (!isRecord(result)) {
    return { text: fallbackText ?? "", details: undefined, structuredContent: undefined };
  }
  return {
    text: contentText(result.content),
    details: isRecord(result.details) ? result.details : undefined,
    structuredContent: isRecord(result.structuredContent)
      ? result.structuredContent
      : undefined,
  };
}

/** The plain text of a tool result — envelope unwrapped, never raw JSON. */
export function toolResultText(
  result: unknown,
  fallbackText?: string,
): string {
  return readToolEnvelope(result, fallbackText).text;
}

/**
 * Same, with the wire budget applied: an extension tool (or an MCP server) can
 * return more than a chat row should ever carry. `cut` is non-null only when the
 * text was actually shortened, so the row can say so instead of silently showing
 * a fraction of the output.
 */
export function toolResultTextWithCut(
  result: unknown,
  fallbackText?: string,
): { text: string; cut: PayloadCut | null } {
  return budgetToolResultText(toolResultText(result, fallbackText));
}

function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

/**
 * Split a unified patch into per-file diffs. pi's `edit` produces a single-file
 * patch (`generateUnifiedPatch` → `createTwoFilesPatch`), but the parser does not
 * assume that: a `--- ` header starts a new file.
 */
export function parseUnifiedPatch(patch: string): ToolFileDiff[] {
  const files: ToolFileDiff[] = [];
  let path: string | undefined;
  let body: string[] = [];

  const flush = () => {
    if (path === undefined && body.length === 0) {
      return;
    }
    const text = body.join("\n");
    const { added, removed } = countPatchLines(text);
    files.push({ path: path ?? "", added, removed, patch: text });
  };

  const lines = patch.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    // A file header is only a header when a `+++` line follows: a *removed* line
    // whose content starts with `-- ` also renders as `--- …`, and splitting on
    // that alone would cut one file into two phantom ones.
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      flush();
      path = line.slice(4).trim();
      body = [line];
      continue;
    }
    if (body.length === 1 && line.startsWith("+++ ")) {
      // The new-side header names the file the diff is *for*; prefer it over the
      // old-side name so a rename shows the destination.
      const next = line.slice(4).trim();
      if (next.length > 0) {
        path = next;
      }
      body.push(line);
      continue;
    }
    body.push(line);
  }
  flush();
  return files;
}

/** Lines of a text the way a diff counts them: a trailing newline ends the last line. */
function textLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** The replacements of an `edit` call, whichever shape the model sent. */
function editReplacements(record: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const raw = record?.edits;
  const list = Array.isArray(raw) ? raw : [record];
  return list.filter((entry): entry is Record<string, unknown> => isRecord(entry));
}

/**
 * Preview of an `edit` from its arguments alone, for the stretch of the stream where
 * the call's `details.patch` does not exist yet.
 *
 * It needs no file on disk: each replacement is exact, so its `oldText` lines are the
 * removed lines and its `newText` lines are the added ones, one for one. That is why
 * the counts can grow while the arguments arrive — and why they are a *preview*: the
 * authoritative numbers come with the patch (which also carries context lines).
 */
function previewEditDisplay(
  args: Record<string, unknown> | undefined,
  path: string,
): ToolDisplay {
  const removed: string[] = [];
  const added: string[] = [];
  for (const edit of editReplacements(args)) {
    const oldText = edit.oldText;
    const newText = edit.newText;
    if (typeof oldText === "string") {
      removed.push(...textLines(oldText));
    }
    if (typeof newText === "string") {
      added.push(...textLines(newText));
    }
  }
  if (removed.length === 0 && added.length === 0) {
    return { kind: "none" };
  }
  const patch = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
  return {
    kind: "fileDiff",
    files: [{ path, added: added.length, removed: removed.length, patch }],
  };
}

/**
 * A whole-file patch for a `write`, whose pi result carries no `details`.
 *
 * `baseline` is the file's previous content, when the host could read it before the call
 * ran. Without it the honest answer is "0 removed": a `write` on a new file really does
 * only add lines, and a `write` over an old file cannot be told from a new one by the
 * arguments alone.
 */
function patchForWrittenFile(
  path: string,
  content: string,
  baseline?: string,
): ToolFileDiff | null {
  if (!path || content.length === 0) {
    return null;
  }
  const added = textLines(content);
  const removed = baseline === undefined ? [] : textLines(baseline);
  const patch = [
    `--- ${path}`,
    `+++ ${path}`,
    // No old side means "created from nothing", which is what `-0,0` says.
    `@@ -${removed.length === 0 ? 0 : 1},${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
  return { path, added: added.length, removed: removed.length, patch };
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Build the body model for one tool block. `args` is the parsed call arguments
 * (pi's `arguments`, already an object); `result` is the raw value off the wire.
 */
export function deriveToolDisplay(input: {
  toolName: string;
  args: unknown;
  result: unknown;
  /** In-flight output, used while a call is still running. */
  partialResult?: unknown;
  /**
   * The call failed. A preview is built from the *arguments*, so it describes what the
   * call meant to do — and a failed `edit`/`write` changed nothing. Printing `+3 −1`
   * next to an error would claim an outcome that did not happen.
   */
  isError?: boolean;
  /**
   * Content of the file *before* this call, when the host could read it. Only `write`
   * needs it (a `write` argument says what goes in, never what comes out), and only for
   * the removed count — see `src/features/chat/fileBaseline.ts` for who fills it in.
   */
  baseline?: string;
}): ToolDisplay {
  const family = toolRowFamily(input.toolName);
  const envelope = readToolEnvelope(
    input.result === undefined ? input.partialResult : input.result,
  );
  const args = isRecord(input.args) ? input.args : undefined;

  switch (family) {
    case "edit": {
      const patch = stringField(envelope.details, "patch");
      if (patch) {
        return { kind: "fileDiff", files: parseUnifiedPatch(patch) };
      }
      // No patch yet: the call is still streaming its arguments (pi computes the patch
      // after the file is written). The arguments describe the change exactly, so this
      // is a real preview rather than a guess — but only while it can still come true:
      // a failed `edit` changed nothing, and numbers would be a claim about an outcome.
      if (input.isError === true) {
        return { kind: "none" };
      }
      return previewEditDisplay(args, stringField(args, "path") ?? "");
    }
    case "write": {
      // A result that carries a real patch wins: it has context lines and is the
      // authoritative count. (pi's `write` currently sends none, which is why the
      // whole-file preview below exists at all.)
      const settledPatch = stringField(envelope.details, "patch");
      if (settledPatch) {
        return { kind: "fileDiff", files: parseUnifiedPatch(settledPatch) };
      }
      if (input.isError === true) {
        return { kind: "none" };
      }
      const path = stringField(args, "path") ?? "";
      // 正文被预算裁掉了：颜色逐行比对已经没有意义，但「写了多少行」是服务端在
      // 裁之前数好的，仍然是真的。给出计数、空 patch 和省略标记——绝不把 head/tail
      // 预览当成完整文件去造一份假 diff。
      const omittedContent = omittedFieldOf(args, "content");
      if (omittedContent) {
        const added = omittedContent.lines;
        const removed = input.baseline === undefined ? 0 : textLines(input.baseline).length;
        return {
          kind: "fileDiff",
          files: [{ path, added, removed, patch: "", omitted: { bytes: omittedContent.bytes } }],
        };
      }
      const file = patchForWrittenFile(path, stringField(args, "content") ?? "", input.baseline);
      return file ? { kind: "fileDiff", files: [file] } : { kind: "none" };
    }
    case "execute": {
      const structured = envelope.structuredContent;
      const output =
        stringField(structured, "output") ??
        (envelope.text.length > 0 ? envelope.text : "");
      if (output.length === 0) {
        return { kind: "none" };
      }
      const exitCode = numberField(structured, "exit_code");
      const truncated =
        structured?.truncated === true || isRecord(envelope.details?.truncation);
      const fullOutputPath =
        stringField(structured, "full_output_path") ??
        stringField(envelope.details, "fullOutputPath");
      // Undefined fields are omitted, not carried as `undefined`: the model is
      // compared with `deepStrictEqual` in tests and copied into render state.
      return {
        kind: "terminal",
        output,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(truncated ? { truncated: true } : {}),
        ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
      };
    }
    case "read":
      return { kind: "read", path: stringField(args, "path") };
    default:
      return { kind: "none" };
  }
}

/**
 * `{kind:"none"}` and "no display" render identically, so the block keeps the
 * absent form: process blocks travel inside bootstrap snapshots, and a
 * placeholder object per grep/ls/find row is pure weight.
 */
export function toolDisplayForBlock(
  display: ToolDisplay,
): ToolDisplay | undefined {
  if (display.kind === "none") {
    return undefined;
  }
  // A `read` without a path cannot name a file, so it carries no more than `none`.
  if (display.kind === "read" && !display.path) {
    return undefined;
  }
  return display;
}

/**
 * Body model for a tool call before any result exists. Only `read` has one (its
 * path), which is why the row can name a file while the call is still running.
 */
export function callToolDisplay(toolName: string, args: unknown): ToolDisplay | undefined {
  return toolDisplayForBlock(deriveToolDisplay({ toolName, args, result: undefined }));
}

/* -------------------------------------------------------------------------- */
/* Row text helpers (pure, so the row component holds no parsing logic)        */
/* -------------------------------------------------------------------------- */

/** Last path segment. `a/b/c.ts` → `c.ts`, `c.ts` → `c.ts`, `a/b/` → `b`. */
export function pathLeaf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

/** Everything before the last segment, or `""` when the path is a bare name. */
export function pathDirectory(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index <= 0 ? "" : trimmed.slice(0, index);
}

/**
 * The folder text after a file name in a tool row.
 *
 * A file can sit directly in the workspace, in which case its directory part is
 * empty — and a row with no path at all reads as if the file had no location (that is
 * what users saw for `Edit hello.py`). The workspace's own folder name is the honest
 * answer there: it says "at the root of *this* project", in the same relative form as
 * everything else in the row.
 *
 * ZCode keeps the trailing slash (`packages/ui/src/settings/`), and it is what makes
 * the path read as a location rather than as part of the file name.
 */
export function toolRowFolder(relative: string, workspaceRoot: string): string {
  const directory = pathDirectory(relative);
  if (directory) {
    return `${directory}/`;
  }
  const rootName = pathLeaf(workspaceRoot);
  return rootName ? `${rootName}/` : "";
}

/** Which verb a file-writing tool row uses. */
export type EditOperation = "write" | "edit";

/**
 * The verb comes from **the tool that ran**, never from the shape of its diff.
 *
 * Deriving it from the diff ("no removed lines ⇒ this must have been a write") reads
 * an insertion-only `edit` as `Write` — which is exactly what users see when a turn
 * appends a few lines to an existing file. The diff cannot tell the two apart: a
 * `write` that happens to replace a file with a superset, and an `edit` that only
 * inserts, produce the same patch shape. ZCode reads the operation from the tool
 * identity for the same reason (`fileSummaryHeuristics.ts`).
 *
 * `delete` is not a case here because pi has no delete tool: a diff that only removes
 * lines is still an edit of that file.
 */
export function editOperationOfTool(toolName: string): EditOperation {
  return toolName.trim().toLowerCase() === "write" ? "write" : "edit";
}

/* -------------------------------------------------------------------------- */
/* Unified-diff rendering                                                     */
/* -------------------------------------------------------------------------- */

export type ToolDiffLineKind = "added" | "removed" | "context";

export interface ToolDiffLine {
  kind: ToolDiffLineKind;
  /** Line content without the diff protocol marker. */
  text: string;
}

/**
 * Lines a body renders at once. ZCode caps its lightweight preview at 800
 * (`MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES`) for the same reason: a lockfile edit is
 * a megabyte long and this body is inline in a chat message, not in a viewer.
 */
export const TOOL_DIFF_MAX_LINES = 800;

/** Rendered lines, cut in the middle when the patch is longer than the cap. */
export interface ToolDiffLines {
  head: ToolDiffLine[];
  /** Lines after the cut. Empty unless `omitted > 0`. */
  tail: ToolDiffLine[];
  /** How many lines were dropped between `head` and `tail`. */
  omitted: number;
}

/**
 * Turn one file's unified patch into the lines a body renders.
 *
 * Everything that is *protocol* is dropped, not just the file headers: `---`/`+++`,
 * git's own `diff --git` / `index` prelude, and `@@` hunk headers. The row already
 * names the file, and the eleven-line window is an artefact of the format rather
 * than something the reader asked to see — ZCode's own preview says the same
 * ("不需要继续暴露 ---/+++ / @@ 这些协议头").
 *
 * Over-long patches keep **head and tail**, with the dropped count in between: the
 * end of a diff is where the interesting part usually is (a trailing brace that had
 * to move), so cutting only the tail would hide it.
 */
export function toolDiffLines(
  patch: string,
  maxLines = TOOL_DIFF_MAX_LINES,
): ToolDiffLines {
  const lines: ToolDiffLine[] = [];

  for (const raw of patch.split("\n")) {
    if (
      raw.startsWith("diff --git ") ||
      raw.startsWith("index ") ||
      raw.startsWith("new file mode ") ||
      raw.startsWith("deleted file mode ") ||
      raw.startsWith("old mode ") ||
      raw.startsWith("new mode ") ||
      raw.startsWith("similarity index ") ||
      raw.startsWith("rename from ") ||
      raw.startsWith("rename to ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("@@")
    ) {
      continue;
    }
    if (raw.length === 0) {
      continue;
    }
    const kind: ToolDiffLineKind = raw.startsWith("+")
      ? "added"
      : raw.startsWith("-")
        ? "removed"
        : "context";
    lines.push({ kind, text: kind === "context" ? raw.replace(/^ /, "") : raw.slice(1) });
  }

  if (lines.length <= maxLines) {
    return { head: lines, tail: [], omitted: 0 };
  }
  // Same split as ZCode: one line of the budget goes to the notice itself.
  const keepCount = maxLines - 1;
  const headCount = Math.ceil(keepCount / 2);
  return {
    head: lines.slice(0, headCount),
    tail: lines.slice(lines.length - (keepCount - headCount)),
    omitted: lines.length - keepCount,
  };
}
