/**
 * 一轮回答里「agent 改了哪些文件」—— 从工具调用参数里读，纯函数。
 *
 * 为什么从工具调用读、而不是问 git：用户问的是「**这一轮**改了什么」。git 只知道
 * 「相对 HEAD 有什么改动」，它答不出轮次 —— 第二轮改同一个文件时，git 那份会把两轮
 * 混在一起。工具调用是唯一带轮次信息的来源。
 *
 * 只认**会写文件**的工具（pi 的 `write` / `edit`，参数里都有 `path`）。`bash` 也可能改文件
 * （`sed -i`、`git checkout`、生成器脚本），但它没有可靠的路径参数，宁可不显示也不能瞎猜
 * —— 列错一个文件比少列一个更坏：用户会去右面板找那个根本不存在的改动。
 */

import type { ToolDisplay } from "./toolDisplay.ts";

/** 参数里带 `path` 的写文件工具。 */
export const FILE_MUTATING_TOOLS = ["write", "edit"] as const;

export function isFileMutatingTool(toolName: unknown): boolean {
  const name = String(toolName ?? "").trim().toLowerCase();
  return FILE_MUTATING_TOOLS.includes(name as (typeof FILE_MUTATING_TOOLS)[number]);
}

/** 工具调用的最小形状（assistant-ui 的 tool-call part，也是我们自己的工具卡）。 */
export interface ToolCallLike {
  type?: string;
  toolName?: string;
  args?: unknown;
  /** 原始参数字符串（assistant-ui 会给；`args` 解析失败时兜底用）。 */
  argsText?: string;
  /** 投影层派生出来的展示模型；`fileDiff` 里带着每个文件真实的增删行数。 */
  display?: ToolDisplay;
}

/** 一行「这一轮改了什么」：路径 + 增删行数。 */
export interface TurnChangedFile {
  path: string;
  /** 新增行数；拿不到真实 patch 时是 0（不是"没改"，是"数不出来"）。 */
  added: number;
  /** 删除行数；同上。 */
  removed: number;
  /** 这条数字是不是真的来自 diff（false 时界面上只显示文件名）。 */
  counted: boolean;
  /** 这一轮这个文件的 unified patch（右面板「审查」直接渲染它，而不是现读 git）。 */
  patch?: string;
}

function pathFromArgs(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return "";
  }
  const value = (args as Record<string, unknown>).path;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 一次工具调用改的文件路径；不是写文件工具、或者拿不到 path 就返回空串。
 *
 * `args` 已经是对象时直接用；只有原始字符串时才尝试 parse —— parse 失败就当拿不到
 * （流式途中参数还没拼完是常态，报错会把一个正常的中间态变成噪音）。
 */
export function toolCallChangedPath(part: ToolCallLike | null | undefined): string {
  if (!part || part.type !== "tool-call" || !isFileMutatingTool(part.toolName)) {
    return "";
  }

  const fromArgs = pathFromArgs(part.args);
  if (fromArgs) {
    return fromArgs;
  }

  const text = String(part.argsText ?? "").trim();
  if (!text) {
    return "";
  }

  try {
    return pathFromArgs(JSON.parse(text));
  } catch {
    return "";
  }
}

/**
 * 一轮里改过的文件，**按第一次出现的顺序去重**。
 *
 * 顺序有意义：agent 通常先改主文件再改配套文件，保持工具调用顺序比按字母排序更贴近
 * 「这轮干了什么」。同一个文件被改多次只列一行（点进去看到的本来就是最新那份 diff）。
 */
export function collectTurnChangedFiles(parts: readonly ToolCallLike[] | null | undefined): string[] {
  if (!Array.isArray(parts)) {
    return [];
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  for (const part of parts) {
    const path = toolCallChangedPath(part);
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    paths.push(path);
  }
  return paths;
}
/**
 * 折成相对项目根的路径。
 *
 * agent 常常直接写绝对路径（`/Users/x/proj/src/a.ts`），列表里那一长串会把真正区分文件的部分
 * 挤没了；预览头部也会跟着显示整条绝对路径。项目外的路径原样保留（宁可显示得丑，也不能
 * 把 `/etc/passwd` 折成 `etc/passwd` 假装它在项目里）。
 */
export function toWorkspaceRelativePath(path: unknown, root: unknown): string {
  const value = String(path ?? "").trim();
  const base = String(root ?? "").trim().replace(/\/+$/, "");
  if (!value || !base) {
    return value;
  }
  if (value === base) {
    return "";
  }
  if (!value.startsWith(`${base}/`)) {
    return value;
  }
  return value.slice(base.length + 1);
}

/**
 * 一轮改动的**行数**：从投影层派生出的 `display.files` 读，不从 patch 文本里数。
 *
 * 两个刻意的规则：
 * - **同一个文件取最后一次**调用。`edit` 的 display 只描述那一次补丁，把两次 edit 的
 *   行数相加会把同一段代码算两遍（改一次 +3、再改回来 −3，相加得到"改了 6 行"）；
 *   而"这一轮这个文件最后变成什么样"正是读者要的。顺序仍按**第一次出现**排。
 * - **数不出来就说数不出来**（`counted: false`）。大文件的正文被预算裁掉时 patch 为空，
 *   此时 `added`/`removed` 都可能是 0，界面不能把它显示成"没有增删"。
 */
export function collectTurnChangedFilesWithCounts(
  parts: readonly ToolCallLike[] | null | undefined,
): TurnChangedFile[] {
  if (!Array.isArray(parts)) {
    return [];
  }

  const byPath = new Map<string, TurnChangedFile>();
  for (const part of parts) {
    const path = toolCallChangedPath(part);
    if (!path) {
      continue;
    }
    const file = part.display?.kind === "fileDiff" ? matchingChangedFile(part.display, path) : undefined;
    byPath.set(path, {
      path,
      added: file?.added ?? 0,
      removed: file?.removed ?? 0,
      counted: file !== undefined,
      // 正文被预算裁掉时 patch 是空串：右面板会退回「按 git 现读」，至少不是一张假 diff。
      ...(file?.patch ? { patch: file.patch } : {}),
    });
  }
  return [...byPath.values()];
}

/** display 里的那一项：优先精确匹配路径，只有一个文件时才退而求其次。 */
function matchingChangedFile(display: ToolDisplay, path: string) {
  if (display.kind !== "fileDiff") {
    return undefined;
  }
  const exact = display.files.find((file) => file.path === path);
  if (exact) {
    return exact;
  }
  return display.files.length === 1 ? display.files[0] : undefined;
}
