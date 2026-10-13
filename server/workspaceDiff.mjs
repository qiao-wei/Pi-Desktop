/**
 * 单个文件的 diff（右侧「改动 / Review」面板与预览 tab 的数据源）。
 *
 * 和 `gitInfo.mjs` 的分工：那个模块回答"仓库现在是什么状态"，这个模块回答"这一个文件改成什么样了"。
 * 两者共用 `runReadOnlyGit` 的只读白名单 —— 渲染层永远不执行 git，看 diff 也照样只读。
 *
 * 输出形状照 ZCode 的 `GitDiffResult` 对齐，因为渲染层的降级决策就建在这套形状上：
 * - `availability` 不是 `patch` 时一律不渲染 diff 正文，只显示一句原因（ZCode 的
 *   `getDiffFallbackMessageId` 就是逐个值挑文案的）；
 * - `patch` 与完整内容对（`beforeContent`/`afterContent`）**必须一起成功或一起降级**：
 *   任一侧读失败就都置 `null`。否则渲染层会把"读不到"当成"空文件"，把整篇文件画成
 *   整篇新增或整篇删除 —— 那是在骗人（ZCode 的 `toCompleteDiffContents` 就是为这个而存在）。
 *
 * `last-turn`（"模型刚改了什么"）**故意不在这个模块**：那个来源的 diff 由对话侧的工具调用
 * 参数派生，和 git 无关。ZCode 同样把 `last-turn` 排除在 git 的 `getDiff` 之外。
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { isInsidePath } from "./localMedia.mjs";
import { parsePorcelainV2, runReadOnlyGit } from "./gitInfo.mjs";
import { dropProjectPiLinkEntries } from "./worktreePiLink.mjs";

/**
 * 单文件补丁的输出上限（字节）。对齐 ZCode 的 `DEFAULT_GIT_DIFF_BYTES = 1MB`：
 * lockfile / 生成物这类大文件会撞上，撞上就是 `truncated` 而不是把 MB 级文本塞进渲染层。
 */
export const MAX_DIFF_PATCH_BYTES = 1024 * 1024;

/**
 * diff 的完整内容（before/after）单侧上限。超了只关掉富渲染（可展开未改动段那套），
 * **不丢 patch** —— patch 已经拿到就是对的，没理由因为全文太大把它一起扔掉。
 */
export const MAX_DIFF_SIDE_BYTES = 1024 * 1024;

/**
 * 单条 diff 命令的超时。比 `GIT_TIMEOUT_MS`（5s，给状态徽标用）宽：对单个大文件算 diff
 * 在冷缓存的大仓库里能到秒级，用 5s 会在正常预览中途被杀掉。
 */
export const DIFF_TIMEOUT_MS = 20000;

/** 可用的 diff 来源。`last-turn` 见文件头注释，不走 git。 */
export const GIT_DIFF_SOURCES = ["unstaged", "staged", "branch"];

/** 缺省来源：和 ZCode 的 Git 面板一样，打开先看"工作区相对暂存区"。 */
export const DEFAULT_DIFF_SOURCE = "unstaged";

/**
 * 所有来源共用的 diff 参数。
 *
 * `--no-ext-diff` + `--no-color` 是必须的：用户完全可能配了 `diff.external` 或
 * `color.ui=always`，那样拿到的是自定义工具的输出 / ANSI 转义，解析和渲染都会错。
 * `--binary` 让二进制文件产出 `GIT binary patch`，我们据此判定 `binary` 而不是去渲染乱码。
 */
const DIFF_BASE_FLAGS = ["--no-ext-diff", "--no-color", "--binary"];

export function isKnownDiffSource(value) {
  return GIT_DIFF_SOURCES.includes(String(value ?? ""));
}

export function normalizeDiffSource(value) {
  const source = String(value ?? "");
  return isKnownDiffSource(source) ? source : DEFAULT_DIFF_SOURCE;
}

/** 来源的文案 key（对齐 ZCode 的 `getSourceMessageId`，文案本身在 i18n 里）。 */
export function diffSourceMessageId(source) {
  const normalized = normalizeDiffSource(source);
  if (normalized === "staged") {
    return "git.source.staged";
  }
  if (normalized === "branch") {
    return "git.source.branch";
  }
  return "git.source.unstaged";
}

/** 统一构造"没得看"的结果，避免四处手写这个形状。 */
export function unavailableDiff(path, source, summary) {
  return {
    path,
    source: normalizeDiffSource(source),
    availability: "unavailable",
    patch: null,
    beforeContent: null,
    afterContent: null,
    added: 0,
    removed: 0,
    summary,
  };
}

/**
 * 拼 `git diff` 的 argv（纯函数，测试直接对 argv 断言，不 spawn）。
 *
 * 分支来源用 `<base>...HEAD`（三个点）：这是"从共同祖先到 HEAD"，也就是这个分支自己带来的
 * 改动。两个点会把它人在 base 上的新提交算成我们的反向改动，历史一乱就不可读。
 */
export function buildDiffArgs({ source, path, base = "" } = {}) {
  const target = String(path ?? "").trim();
  if (!target) {
    throw new Error("Cannot diff without a path");
  }

  const normalized = normalizeDiffSource(source);
  if (normalized === "staged") {
    return ["diff", "--cached", ...DIFF_BASE_FLAGS, "--", target];
  }

  if (normalized === "branch") {
    const ref = String(base ?? "").trim();
    if (!ref) {
      throw new Error("Branch diff needs a base ref");
    }
    return ["diff", ...DIFF_BASE_FLAGS, "--find-renames", `${ref}...HEAD`, "--", target];
  }

  return ["diff", ...DIFF_BASE_FLAGS, "--", target];
}

/** `git diff` 说不动二进制的两种措辞（老的 "Binary files ... differ" 和新的 `--binary` 补丁）。 */
export function isBinaryDiff(patch) {
  const text = String(patch ?? "");
  return text.includes("GIT binary patch") || text.includes("Binary files ");
}

/**
 * 从补丁里数增删行。
 *
 * 不额外跑 `--numstat`：补丁正文里就有答案，多跑一条命令只为数一遍不值得。
 * `---`/`+++` 是文件头、`@@` 是块头、`\` 是 "No newline" 标记，都不算增删。
 */
export function countPatchLines(patch) {
  let added = 0;
  let removed = 0;

  for (const line of String(patch ?? "").split("\n")) {
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
 * 未跟踪文件在自己合成 patch 时用的文本切分。
 *
 * 末行有没有换行必须单独记住：`+abc` 和 `+abc` + `\ No newline at end of file` 是两种
 * 不同的文件，丢掉这行会让"最后一行没有换行"的改动看起来和正常文件一样。
 */
export function splitUntrackedText(text) {
  const value = String(text ?? "");
  if (!value) {
    return { lines: [], hasTrailingNewline: true };
  }

  const hasTrailingNewline = value.endsWith("\n");
  const body = hasTrailingNewline ? value.slice(0, -1) : value;
  return { lines: body.split("\n"), hasTrailingNewline };
}

/**
 * 未跟踪文件的补丁：git 看不见未跟踪文件（`git diff` 对它没有输出），所以整篇都是新增。
 *
 * 故意**不**用 `git diff --no-index /dev/null <file>`：那份输出在 Windows 上会带平台相关的
 * 文件头，而且某些 `diff --git` 头部格式会让 diff 渲染器直接抛异常。这里的 unified 形态只保留
 * 单文件预览真正需要的 `---/+++ / @@`，是两端都能稳定吃下的最小集合（ZCode 的
 * `buildUntrackedTextDiffResult` 出于同样的理由也这么做）。
 */
export function buildUntrackedPatch({ path, content } = {}) {
  const { lines, hasTrailingNewline } = splitUntrackedText(content);
  const patchLines = ["--- /dev/null", `+++ b/${path}`];

  if (lines.length > 0) {
    patchLines.push(`@@ -0,0 +1,${lines.length} @@`);
    patchLines.push(...lines.map((line) => `+${line}`));
    if (!hasTrailingNewline) {
      patchLines.push("\\ No newline at end of file");
    }
  }

  return {
    availability: "patch",
    patch: `${patchLines.join("\n")}\n`,
    beforeContent: "",
    afterContent: String(content ?? ""),
    added: lines.length,
    removed: 0,
  };
}

/** 补丁头部里的路径：绝对路径要相对化，反斜杠要归一，否则 `+++ b/...` 会是个本机绝对路径。 */
export function toPatchPath(target, project) {
  const value = String(target ?? "");
  if (!value) {
    return "";
  }

  const absolute = isAbsolute(value) ? value : join(project, value);
  const inside = relative(project, absolute);
  const chosen = inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : value;
  return chosen.split("\\").join("/");
}

/** 文本能不能安全当文本预览：含 NUL 就是二进制。 */
function isPreviewableText(text) {
  return !String(text ?? "").includes("\0");
}

/** 工作区里的文件内容；不可读 / 太大 / 二进制 / 不是普通文件都返回 null（一视同仁）。 */
function readWorktreeText(project, target, maxSideBytes) {
  const absolute = isAbsolute(target) ? target : join(project, target);
  try {
    const stats = statSync(absolute);
    if (!stats.isFile() || stats.size > maxSideBytes) {
      return null;
    }

    const content = readFileSync(absolute, "utf8");
    return isPreviewableText(content) ? content : null;
  } catch {
    // 文件被删除、以及编辑器"原子保存"的中间窗口都会让 stat/read 失败。
    // 这里不能猜成合法空文件——那会把删除渲染成"空文件"。
    return null;
  }
}

/**
 * 某个 ref 下的文件内容。`ref` 传空串表示 index（`git show :path`），
 * 传 `HEAD` 表示最后一次提交，传 merge-base 的 oid 表示分叉点。
 *
 * 读不到就返回 null：路径在该 ref 里不存在（新增文件没有 HEAD 版本）、被杀掉、超限、
 * 或内容是二进制。调用方靠 `null` 触发"完整内容对一起降级"。
 */
async function readBlobText(project, ref, target, { maxSideBytes, ...options }) {
  const result = await runReadOnlyGit(project, ["show", `${ref}:${target}`], options);
  if (!result.ok || result.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return null;
  }
  if (Buffer.byteLength(result.stdout, "utf8") > maxSideBytes || !isPreviewableText(result.stdout)) {
    return null;
  }

  return result.stdout;
}

/**
 * 这个路径在 git 眼里是什么（未跟踪 / 冲突 / 已暂存）。
 *
 * 传 `-- <path>` 让 git 自己过滤，省掉"把 porcelain 里的 repo 相对路径和我们手上的路径对齐"
 * 这件麻烦事；`--untracked-files=normal` 是显式写死的：用户可能配了
 * `status.showUntrackedFiles=no`，那样未跟踪文件会静默消失，整条"未跟踪"分支就走不到了。
 */
async function readPathEntries(project, target, options) {
  const result = await runReadOnlyGit(
    project,
    ["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--", target],
    options,
  );
  if (!result.ok) {
    // status 失败不该让整个 diff 失败：最差只是不知道它是不是未跟踪。
    return [];
  }

  return dropProjectPiLinkEntries(project, parsePorcelainV2(result.stdout.split("\u0000")));
}

/** 当前分支的上游（`origin/main` 这种）；没有上游就返回空串。 */
async function resolveUpstream(project, options) {
  const result = await runReadOnlyGit(
    project,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    options,
  );
  return result.ok ? result.stdout.trim() : "";
}

/**
 * 分叉点。拿不到就退回 base 本身：`<base>...HEAD` 在 base 不是本地 ref 时也能算，
 * 但读 blob 需要一个真实 oid，所以尽力而为。
 */
async function resolveMergeBase(project, base, options) {
  const result = await runReadOnlyGit(project, ["merge-base", base, "HEAD"], options);
  return result.ok ? result.stdout.trim() : "";
}

/** 按来源读 before/after 两侧的全文。任一侧失败就返回 null（见文件头注释的"一起降级"）。 */
async function readDiffContents({ project, target, source, base, maxSideBytes, ...options }) {
  const side = { maxSideBytes, ...options };

  if (source === "staged") {
    const [beforeContent, afterContent] = [
      await readBlobText(project, "HEAD", target, side),
      await readBlobText(project, "", target, side),
    ];
    return beforeContent === null || afterContent === null ? null : { beforeContent, afterContent };
  }

  if (source === "branch") {
    const mergeBase = await resolveMergeBase(project, base, options);
    const [beforeContent, afterContent] = [
      await readBlobText(project, mergeBase || base, target, side),
      await readBlobText(project, "HEAD", target, side),
    ];
    return beforeContent === null || afterContent === null ? null : { beforeContent, afterContent };
  }

  // unstaged 的左侧是 **index** 而不是 HEAD：未暂存 = 工作区相对暂存区，
  // 用 HEAD 当左侧会把"已 add 的改动"重复算进来一次。
  const [beforeContent, afterContent] = [
    await readBlobText(project, "", target, side),
    readWorktreeText(project, target, maxSideBytes),
  ];
  return beforeContent === null || afterContent === null ? null : { beforeContent, afterContent };
}

function gitFailureText(result) {
  return (result.stderr || result.stdout).trim() || (result.killed ? "git timed out" : `git failed (${result.code})`);
}

/** `--name-status` 的状态字母 → 共享的 `GitFileStatus`（未知字母当 modified，别把它变没）。 */
function nameStatusToFileStatus(letter) {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
}

/**
 * `git diff --name-status -z` 的输出 → 文件行。
 *
 * 为什么要 `-z`：不带它时 git 会把含空格/换行/引号的路径加引号并转义（`"a\tb.ts"`），
 * 解析方要再实现一遍 git 的 C 转义规则 —— 那是最容易出隐形 bug 的一公里。`-z` 用 NUL 分隔
 * 且从不转义。重命名/复制占两个路径（旧、新），所以不能简单地按位置取。
 */
export function parseNameStatusZ(output) {
  const tokens = String(output ?? "").split("\u0000");
  const files = [];

  for (let index = 0; index < tokens.length; ) {
    const code = tokens[index];
    if (!code) {
      index += 1;
      continue;
    }

    index += 1;
    const letter = code.charAt(0);
    const renamed = letter === "R" || letter === "C";
    const origPath = renamed ? tokens[index] ?? "" : "";
    if (renamed) {
      index += 1;
    }
    const path = tokens[index] ?? "";
    index += 1;

    if (!path) {
      continue;
    }

    files.push({
      path,
      origPath,
      status: nameStatusToFileStatus(letter),
      staged: false,
      untracked: false,
      conflicted: nameStatusToFileStatus(letter) === "conflicted",
      added: 0,
      removed: 0,
    });
  }

  return files;
}

/**
 * 某个来源下的改动文件清单。
 *
 * **只实现 `branch`**：未暂存 / 已暂存的文件清单本来就在 `git status --porcelain=v2` 里
 * （`/api/projects/git` 已经回给渲染层了），再跑一次 `git diff --name-only` 只会多出一个
 * 可能不一致的事实来源。而分支对比（相对上游的分叉点、含已提交但未推送的改动）porcelain
 * 是看不到的，这个才是真缺的那块。
 *
 * 返回 `{ source, base, files, summary }`；`summary` 非空表示这个来源现在列不出来。
 */
export async function listSourceFiles({
  cwd,
  source = "branch",
  base = "",
  execImpl = execFile,
  timeoutMs = DIFF_TIMEOUT_MS,
} = {}) {
  const project = String(cwd ?? "").trim();
  const normalized = normalizeDiffSource(source);

  if (normalized !== "branch") {
    return { source: normalized, base: "", files: [], summary: "This source has no file list of its own." };
  }

  const options = { execImpl, timeoutMs };
  const resolvedBase = String(base ?? "").trim() || (await resolveUpstream(project, options));
  if (!resolvedBase) {
    return { source: normalized, base: "", files: [], summary: "Current branch has no upstream branch to compare with." };
  }

  // 分叉点拿不到就退回上游本身：`git diff <upstream>` 也成立（只是会把上游自己的新提交算成“删除”）。
  const from = (await resolveMergeBase(project, resolvedBase, options)) || resolvedBase;
  const result = await runReadOnlyGit(project, ["diff", "--name-status", "-z", from], options);
  if (!result.ok || result.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { source: normalized, base: from, files: [], summary: gitFailureText(result) };
  }

  return { source: normalized, base: from, files: parseNameStatusZ(result.stdout), summary: "" };
}

/**
 * 读一个文件的 diff。
 *
 * 返回 `{ path, source, availability, patch, beforeContent, afterContent, added, removed, summary }`。
 * `availability` 四态：`patch`（有正文）/ `binary` / `truncated` / `unavailable`。
 * 后三态 `patch` 一律为 `null`，渲染层只显示 `summary`。
 */
export async function readFileDiff({
  cwd,
  path,
  source = DEFAULT_DIFF_SOURCE,
  base = "",
  execImpl = execFile,
  timeoutMs = DIFF_TIMEOUT_MS,
  maxPatchBytes = MAX_DIFF_PATCH_BYTES,
  maxSideBytes = MAX_DIFF_SIDE_BYTES,
} = {}) {
  const project = String(cwd ?? "").trim();
  const target = String(path ?? "").trim();
  if (!project) {
    throw new Error("Cannot diff without a project folder");
  }
  if (!target) {
    throw new Error("Cannot diff without a path");
  }

  const normalized = normalizeDiffSource(source);

  // 边界先卡住：`path` 来自渲染层，`join(project, "../../etc/passwd")` 会真的读到工作区外面。
  // 这里复用 `localMedia` 的路径谓词（同一个“必须落在根下面”的规则，别写第二份）。
  // 故意 fail fast：越界路径连 git 都不跑，免得把仓库外的路径交给 git 去解释。
  const absoluteTarget = resolve(isAbsolute(target) ? target : join(project, target));
  if (!isInsidePath(resolve(project), absoluteTarget)) {
    return unavailableDiff(target, normalized, "Path is outside the project folder.");
  }

  const options = { execImpl, timeoutMs };
  const entries = await readPathEntries(project, target, options);
  const entry = entries[0] ?? null;

  // 冲突文件是合并态，`git diff` 给的是组合 diff（两个父版本），大多渲染器都读不对。
  // 这里直接说"去编辑器里解"，前端保留「用 IDE 打开」和「自动解决冲突」两个既有入口。
  if (entry?.conflicted) {
    return unavailableDiff(target, normalized, "Conflicted file: resolve the conflict before reviewing the diff.");
  }

  let resolvedBase = String(base ?? "").trim();
  if (normalized === "branch") {
    if (!resolvedBase) {
      resolvedBase = await resolveUpstream(project, options);
    }
    if (!resolvedBase) {
      return unavailableDiff(target, normalized, "Current branch has no upstream branch to compare with.");
    }
  }

  const result = await runReadOnlyGit(project, buildDiffArgs({ source: normalized, path: target, base: resolvedBase }), options);

  // maxBuffer 溢出时 `ok` 也是 false，但 stdout 是有效的前缀——它就是"太大"而不是"失败"。
  const truncatedByBuffer = result.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  if (truncatedByBuffer || Buffer.byteLength(result.stdout, "utf8") > maxPatchBytes) {
    return {
      ...unavailableDiff(target, normalized, "Git diff output exceeded the preview limit."),
      availability: "truncated",
    };
  }
  if (!result.ok) {
    return unavailableDiff(target, normalized, gitFailureText(result));
  }

  const patch = result.stdout;

  if (!patch.trim()) {
    // 空输出有两种完全不同的原因，别混成一句话。
    if (entry?.untracked) {
      return readUntrackedDiff(project, target, normalized, { maxSideBytes });
    }

    const absolute = absoluteTarget;
    if (!statSync(absolute, { throwIfNoEntry: false })) {
      return unavailableDiff(target, normalized, "File is missing on disk.");
    }

    return unavailableDiff(target, normalized, "No changes for this file in the selected source.");
  }

  if (isBinaryDiff(patch)) {
    return {
      ...unavailableDiff(target, normalized, "Binary diff is not previewable."),
      availability: "binary",
    };
  }

  const contents = await readDiffContents({
    project,
    target,
    source: normalized,
    base: resolvedBase,
    maxSideBytes,
    ...options,
  });
  const { added, removed } = countPatchLines(patch);

  return {
    path: target,
    source: normalized,
    availability: "patch",
    patch,
    // 全文读不到就一起置 null（而不是补空串）：富渲染因此关闭，但 patch 照样能看。
    beforeContent: contents?.beforeContent ?? null,
    afterContent: contents?.afterContent ?? null,
    added,
    removed,
    summary: null,
  };
}

/** 未跟踪文件：合成"整篇新增"的补丁，顺带给出 before/after（before 是真的空，不是读失败）。 */
function readUntrackedDiff(project, target, source, { maxSideBytes }) {
  const absolute = isAbsolute(target) ? target : join(project, target);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return unavailableDiff(target, source, "File is missing on disk.");
  }

  if (!stats.isFile()) {
    return unavailableDiff(target, source, "Not a regular file.");
  }

  const truncated = {
    ...unavailableDiff(target, source, "Untracked file is too large to preview."),
    availability: "truncated",
  };
  if (stats.size > maxSideBytes) {
    return truncated;
  }

  const content = readFileSync(absolute);
  if (content.includes(0)) {
    return {
      ...unavailableDiff(target, source, "Binary diff is not previewable."),
      availability: "binary",
    };
  }

  return {
    path: target,
    source,
    ...buildUntrackedPatch({ path: toPatchPath(target, project), content: content.toString("utf8") }),
    summary: null,
  };
}