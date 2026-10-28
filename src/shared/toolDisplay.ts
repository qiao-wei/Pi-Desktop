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
 * (`chatBubbles.assistantMessageConversationView`), so no component ever parses
 * tool text. It is deliberately presentation-free: no colors, no labels, no
 * React. `toolRowFamily` decides which row renders; `display` decides what its
 * body can show.
 */

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

/** A whole-file patch for a `write`, whose pi result carries no `details`. */
function patchForWrittenFile(path: string, content: string): ToolFileDiff | null {
  if (!path || content.length === 0) {
    return null;
  }
  const lines = content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");
  const patch = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
  return { path, added: lines.length, removed: 0, patch };
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
}): ToolDisplay {
  const family = toolRowFamily(input.toolName);
  const envelope = readToolEnvelope(
    input.result === undefined ? input.partialResult : input.result,
  );
  const args = isRecord(input.args) ? input.args : undefined;

  switch (family) {
    case "edit": {
      const patch = stringField(envelope.details, "patch");
      if (!patch) {
        return { kind: "none" };
      }
      return { kind: "fileDiff", files: parseUnifiedPatch(patch) };
    }
    case "write": {
      const file = patchForWrittenFile(
        stringField(args, "path") ?? "",
        stringField(args, "content") ?? "",
      );
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
