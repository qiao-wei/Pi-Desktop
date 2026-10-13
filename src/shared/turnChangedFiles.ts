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
