/**
 * unified diff 补丁的纯解析器（零依赖）。
 *
 * 为什么不引 `diff` 之类的包：补丁已经在服务端算好了（`server/workspaceDiff.mjs`），这里只需要
 * 「逐行贴标签 + 算两侧行号」。而右面板要贴着 ZCode 的观感 —— 行号、增删底色、
 * `\ No newline at end of file` 标记都得自己控。真换成富渲染库是 M2e（`@pierre/diffs`）的事，
 * 到时候换掉的是渲染层，这个解析函数仍可以留着做「纯文本首帧」。
 *
 * 只吃**单文件**补丁：调用方永远是 `readFileDiff`，它按 path 过滤，`git diff` 不会给出第二个
 * 文件段。真遇到第二个 `+++` 段（合成补丁出故障、或上游换了实现）就停止解析 —— 宁可只显示
 * 第一个文件的改动，也不要把两个文件的块混在同一个路径标题下面。
 */

export type DiffLineKind = "context" | "add" | "remove";

export interface DiffLine {
  kind: DiffLineKind;
  /** 行内容，不含行首那一个 `+` / `-` / 空格。 */
  text: string;
  /** 这一行在左侧（旧文件）的行号；新增行没有。 */
  oldLine: number | null;
  /** 这一行在右侧（新文件）的行号；删除行没有。 */
  newLine: number | null;
  /** 紧跟其后的 `\ No newline at end of file`：末行没有换行符，要显式标出来。 */
  noNewline: boolean;
}

export interface DiffHunk {
  /** 原样的块头（`@@ -1,4 +1,5 @@ 说明`）。 */
  header: string;
  /** 块头 `@@` 之后那段「这是什么函数 / 结构」的说明；没有时是空串。 */
  section: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedPatch {
  /** 补丁头里的两侧路径；`/dev/null` 归一成 null，中文路径的 C 风格转义会解码。 */
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * 补丁头里的路径 → 可显示路径。
 *
 * 两件事必须处理，否则中文文件名会显示成一串八进制：
 * - `core.quotePath`（git 默认开）会把非 ASCII 路径写成 `"b/\346\226\207.md"`，要按 C 风格
 *   转义解码回 UTF-8；
 * - `a/` `b/` 前缀要去掉，`/dev/null`（新增 / 删除文件的一侧）返回 null。
 */
export function patchHeaderPath(raw: unknown): string | null {
  let value = String(raw ?? "").trim();
  if (!value) {
    return null;
  }

  // `diff -u` 会在路径后面接一个制表符 + 时间戳，git 不会，但顺手切掉更稳。
  const tab = value.indexOf("\t");
  if (tab !== -1) {
    value = value.slice(0, tab).trim();
  }

  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
    value = decodeGitQuotedPath(value.slice(1, -1));
  }

  if (value === "/dev/null") {
    return null;
  }

  return value.replace(/^[ab]\//, "");
}

/** git 的 C 风格路径转义：`\"` `\\` `\t` `\n` `\r` 和 `\ooo`（八进制字节，按 UTF-8 解码）。 */
function decodeGitQuotedPath(value: string): string {
  const bytes: number[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }

    const next = value[index + 1] ?? "";
    const octal = /^[0-7]{3}$/.test(value.slice(index + 1, index + 4)) ? value.slice(index + 1, index + 4) : "";
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }

    const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", f: "\f", b: "\b", v: "\v", '"': '"', "\\": "\\" };
    bytes.push(...new TextEncoder().encode(escapes[next] ?? next));
    index += 1;
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * 解析一份单文件 unified diff。
 *
 * 不抛错：补丁是外部命令的输出，形状无法保证（合成的未跟踪补丁就没有 `diff --git` 头）。
 * 认不出来的行一律结束当前块 —— 猜错行号比少显示一行更糟。
 */
export function parseUnifiedPatch(patch: string): ParsedPatch {
  const parsed: ParsedPatch = { oldPath: null, newPath: null, hunks: [], added: 0, removed: 0 };
  const raw = String(patch ?? "");
  if (!raw) {
    return parsed;
  }

  // 补丁总是以换行结尾，切出来的最后那个空串不是内容行。
  const rows = raw.split("\n");
  if (rows[rows.length - 1] === "") {
    rows.pop();
  }

  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let sawHeader = false;

  for (const row of rows) {
    const header = HUNK_HEADER.exec(row);
    if (header) {
      hunk = {
        header: row,
        section: header[5].trim(),
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      parsed.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }

    if (row.startsWith("--- ")) {
      // 第二个文件段：停止解析（见文件头注释）。第一个文件段之前看到的都当头部。
      if (hunk && parsed.hunks.length > 0) {
        break;
      }
      parsed.oldPath = patchHeaderPath(row.slice(4));
      sawHeader = true;
      hunk = null;
      continue;
    }

    if (row.startsWith("+++ ")) {
      parsed.newPath = patchHeaderPath(row.slice(4));
      sawHeader = true;
      hunk = null;
      continue;
    }

    if (hunk && row.startsWith("\\")) {
      // 「上一行没有换行符」：它属于刚推入的那一行。
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) {
        last.noNewline = true;
      }
      continue;
    }

    if (hunk) {
      const marker = row[0];
      if (marker === "+") {
        hunk.lines.push({ kind: "add", text: row.slice(1), oldLine: null, newLine, noNewline: false });
        parsed.added += 1;
        newLine += 1;
        continue;
      }

      if (marker === "-") {
        hunk.lines.push({ kind: "remove", text: row.slice(1), oldLine, newLine: null, noNewline: false });
        parsed.removed += 1;
        oldLine += 1;
        continue;
      }

      if (marker === " " || row === "") {
        hunk.lines.push({ kind: "context", text: marker === " " ? row.slice(1) : "", oldLine, newLine, noNewline: false });
        oldLine += 1;
        newLine += 1;
        continue;
      }
    }

    // `diff --git` / `index ...` / `new file mode` 这类头部行，以及块里认不出来的行。
    hunk = null;
  }

  // 只有头部、没有块的补丁（比如「改了文件权限」）：把路径留 null，让调用方说清楚。
  if (!sawHeader) {
    parsed.oldPath = null;
    parsed.newPath = null;
  }

  return parsed;
}

/** 渲染标题用哪个路径：优先新路径（新增文件只有它），两者都没有时给 null。 */
export function patchDisplayPath(parsed: Pick<ParsedPatch, "oldPath" | "newPath">): string | null {
  return parsed.newPath ?? parsed.oldPath ?? null;
}

/** 补丁里有没有实质改动（只有头部 / 空补丁都是 false）。 */
export function hasPatchContent(parsed: Pick<ParsedPatch, "hunks">): boolean {
  return parsed.hunks.some((hunk) => hunk.lines.length > 0);
}