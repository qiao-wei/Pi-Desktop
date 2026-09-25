/**
 * 托管 Git worktree：一个会话一个隔离检出，几个任务并行改代码互不干扰。
 *
 * 模型参考 Codex 桌面端（`developers.openai.com/codex/app/worktrees`）：
 * - worktree 建在应用自己的 worktree 根目录下（`<agentDir>/worktrees/<id>`），和用户手写的
 *   `git worktree` 分得开，Codex 只删自己建的（这里同样：`isManagedWorktreePath` 是唯一的门）；
 * - 基于所选起点（默认当前 HEAD）建 **detached HEAD**，这样同一个分支不会被两个检出同时占住；
 * - 仓库里被 gitignore 的本地文件（`.env` 之类）用仓库根的 `.worktreeinclude` 声明后复制进新
 *   worktree，因为 git 不会带它们过去；
 * - 项目根的 `.pi`（项目级 skills / extensions / 包配置）不在 git 里，用一条软链共享进每个
 *   worktree（见 `worktreePiLink.mjs`）；
 * - 删 worktree 前先数一遍未提交 / 未跟踪 / 被忽略的文件，不确认就不删（git 自己的
 *   "contains modified or untracked files" 太含糊，也不知道被忽略的文件会被一起清掉）。
 *
 * 本模块的 argv 全部在这里拼，且只有 worktree 生命周期（add / remove / prune）与只读查询
 * （list / status / rev-parse / ls-files）两类调用；用户输入（分支名）走 `gitInfo.mjs` 的
 * 既有校验通道（`createGitBranch`），不进这里拼 argv。纯解析函数单独导出，`node --test`
 * 可以直接对 porcelain 文本做用例，不需要机器上装 git。
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { GIT_TIMEOUT_MS, createGitRunner, isSafeBranchName } from "./gitInfo.mjs";
import { WORKTREE_PI_DIR_NAME, isProjectPiLinkEntry, isWorktreePiLink } from "./worktreePiLink.mjs";

/** 托管 worktree 默认保留数量（参考 Codex 的 `desktop.worktree-keep-count`）。 */
export const WORKTREE_KEEP_COUNT = 15;

/** `.worktreeinclude` 的复制上限：防止把整个 node_modules 拖进每个 worktree。 */
export const MAX_WORKTREE_INCLUDE_FILES = 500;
export const MAX_WORKTREE_INCLUDE_FILE_BYTES = 4 * 1024 * 1024;

/** 托管 worktree 的根目录：`~/.pi/agent/worktrees`（跟 agentDir 走，跟 Codex 一样放应用数据区）。 */
export function worktreeRootFor(agentDir) {
  return join(String(agentDir ?? ""), "worktrees");
}

/**
 * 一个 worktree 的目录名：项目名 + 会话种子，可读且基本唯一。
 * 只保留 `[a-z0-9-]`，其余字符折成 `-`；解析不出东西时退回固定前缀。
 */
export function managedWorktreeId(projectName, sessionSeed) {
  const slug = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
  const project = slug(projectName) || "project";
  const seed = slug(sessionSeed).slice(0, 12) || "session";
  return `${project}-${seed}`;
}

/** worktree 根下的相对路径（`\` → `/`，去掉开头的 `./`）。 */
export function normalizeWorktreeRelativePath(path) {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/** 存在就按 realpath 解析（macOS 的 `/tmp` 与 `/private/tmp` 是同一处），否则退回 resolve。 */
function realOrResolved(path) {
  const value = String(path ?? "");
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

/**
 * `target` 是否落在托管 worktree 根目录里（根目录本身不算）。
 * 这是「Codex 只删自己建的 worktree」那条边界的唯一实现。
 *
 * macOS 上 `tmpdir()` 给的 `/var/...` 与真实路径 `/private/var/...` 是同一处，而待建的
 * worktree 目录此时还不存在（realpath 解析不了），所以两边各试「原样 resolve」和「realpath」
 * 两个写法，任一命中就算在根里。
 */
export function isManagedWorktreePath(root, target) {
  const rootValue = String(root ?? "").trim();
  const targetValue = String(target ?? "").trim();
  if (!rootValue || !targetValue) {
    return false;
  }

  const roots = new Set([resolve(rootValue), realOrResolved(rootValue)]);
  const targets = new Set([resolve(targetValue), realOrResolved(targetValue)]);
  for (const rootPath of roots) {
    const prefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
    for (const targetPath of targets) {
      if (targetPath === rootPath) {
        return false;
      }
      if (targetPath.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * `git worktree list --porcelain` 的文本 → 条目数组。
 *
 * 每条以空行分隔；`key` 单独成行（detached/bare/locked/prunable），`locked` / `prunable`
 * 后面的文字是原因。`branch` 是完整 ref（`refs/heads/main`），这里同时给出短名 `branchName`。
 */
export function parseWorktreeListPorcelain(text) {
  const entries = [];
  let current = null;
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }

    const separator = line.indexOf(" ");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);

    if (key === "worktree") {
      if (current) {
        entries.push(current);
      }
      current = { path: value, head: "", branch: "", branchName: "", detached: false, bare: false, locked: false, lockReason: "", prunable: false, prunableReason: "" };
      continue;
    }

    if (!current) {
      continue;
    }

    if (key === "HEAD") {
      current.head = value;
    } else if (key === "branch") {
      current.branch = value;
      current.branchName = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
    } else if (key === "detached") {
      current.detached = true;
    } else if (key === "bare") {
      current.bare = true;
    } else if (key === "locked") {
      current.locked = true;
      current.lockReason = value;
    } else if (key === "prunable") {
      current.prunable = true;
      current.prunableReason = value;
    }
  }

  if (current) {
    entries.push(current);
  }
  return entries;
}

/** 仓库里的 `.worktreeinclude`：注释、空行、`\` 折成 `/`，保留 `!` 取反与结尾 `/`。 */
export function parseWorktreeInclude(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => normalizeWorktreeRelativePath(line))
    .filter(Boolean);
}

/** 读仓库根的 `.worktreeinclude`（没有就是空数组，读失败也不该让建 worktree 挂掉）。 */
export function readWorktreeInclude(cwd) {
  try {
    return parseWorktreeInclude(readFileSync(join(String(cwd), ".worktreeinclude"), "utf8"));
  } catch {
    return [];
  }
}

/**
 * 一条 `.worktreeinclude` 规则 → 正则。
 *
 * 支持 gitignore 的常用子集：`*`（不跨 `/`）、`?`、`**`、锚定（规则里含 `/` 就从仓库根算）、
 * 结尾 `/` 表示目录（命中其下所有文件）、开头 `!` 取反（由 `matchesWorktreeInclude` 处理）。
 * 不做字符类 `[abc]`、不处理 `?` 的反斜杠转义 —— `.worktreeinclude` 是给“把 .env 带过去”
 * 用的，够用即可，规则写复杂了应当直接写进仓库。
 */
export function worktreeIncludeRuleToRegExp(body) {
  const directoryOnly = body.endsWith("/");
  let pattern = directoryOnly ? body.replace(/\/+$/, "") : body;
  // 锚定看的是去掉结尾斜杠之后的规则：`node_modules/` 是「任意一层的 node_modules 目录」，
  // 不是「仓库根的 node_modules」（gitignore 同样如此）。
  const anchored = pattern.includes("/");
  pattern = pattern.replace(/^\//, "");

  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**/` 匹配零层或多层目录（gitignore 语义）：`**/fixtures/a` 也要命中 `fixtures/a`。
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  const suffix = directoryOnly ? "(?:/.*)?" : "";
  return { anchored, directoryOnly, regexp: new RegExp(`^${source}${suffix}$`) };
}

/**
 * 一个仓库相对路径是否命中 `.worktreeinclude`（按顺序、后面的规则覆盖前面的）。
 */
export function matchesWorktreeInclude(patterns, relativePath) {
  const path = normalizeWorktreeRelativePath(relativePath).replace(/\/+$/, "");
  if (!path) {
    return false;
  }

  const segments = path.split("/");
  let ignored = false;
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    const negate = raw.startsWith("!");
    const body = negate ? raw.slice(1) : raw;
    if (!body) {
      continue;
    }

    const { anchored, regexp } = worktreeIncludeRuleToRegExp(body);
    const matched = anchored
      ? regexp.test(path)
      // 不锚定的规则对每一段都算一次：`*.env` 命中 `a/b/.env`，`secrets/` 命中 `a/secrets/x`。
      : segments.some((segment) => regexp.test(segment));

    if (matched) {
      ignored = !negate;
    }
  }
  return ignored;
}

/** 从候选（`git ls-files --others --ignored` 报出来的文件）里挑出命中的，保持原顺序。 */
export function selectWorktreeIncludeFiles(patterns, candidates) {
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => matchesWorktreeInclude(patterns, candidate));
}

/**
 * `git status --porcelain -z` → 修改 / 未跟踪 / 被忽略三类。
 * 重命名条目在 `-z` 下多出一个原始路径块，这里跳过它，避免把旧路径算成一条改动。
 */
export function parseStatusPorcelainZ(text) {
  const chunks = String(text ?? "").split("\0");
  const changed = [];
  const untracked = [];
  const ignored = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const entry = chunks[index];
    if (!entry || entry.length < 3) {
      continue;
    }

    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === "!!") {
      ignored.push(path);
      continue;
    }
    if (code === "??") {
      untracked.push(path);
      continue;
    }

    changed.push(path);
    if (code[0] === "R" || code[0] === "C") {
      index += 1;
    }
  }
  return { changed, untracked, ignored };
}

/** `git status` 的路径在 `-z` 模式下不做转义，直接可用；为空串的条目丢掉。 */
function cleanPaths(paths) {
  return paths.filter((path) => typeof path === "string" && path.length > 0);
}

function gitFailureReason(result) {
  return (result.stderr || result.stdout).trim() || (result.killed ? "git timed out" : `git failed (${result.code})`);
}

function worktreeOptions({ execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return { execImpl, timeoutMs };
}

/** 当前 HEAD 的 commit；空仓库（还没有第一个 commit）返回空串。 */
export async function readWorktreeBase(cwd, options = {}) {
  const result = await createGitRunner(worktreeOptions(options))(
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    { cwd: String(cwd ?? "").trim() },
  );
  return result.ok ? result.stdout.trim() : "";
}

/**
 * 建一个托管 worktree：`git worktree add --detach <path> <baseRef>`。
 *
 * 起点默认 `HEAD`（当前分支的当前提交），detached 检出 —— 同一个分支因此可以被多个
 * worktree 各自引用而不会互相抢。目录已存在且非空时直接拒绝，不覆盖任何东西。
 * 建完之后按 `.worktreeinclude` 把被忽略的本地文件复制进去。
 */
export async function createManagedWorktree(cwd, { root, id, baseRef = "HEAD" } = {}, options = {}) {
  const project = String(cwd ?? "").trim();
  if (!project) {
    throw new Error("没有项目目录，无法创建 worktree。");
  }
  if (!isManagedWorktreePath(root, join(String(root ?? ""), id))) {
    throw new Error("worktree 路径不在托管目录里。");
  }

  const base = await readWorktreeBase(project, options);
  if (!base) {
    throw new Error("仓库还没有任何提交，先在主检出提交一次再建 worktree。");
  }
  // 起点可以是任意 ref，但绝不能以 `-` 开头被 git 当成选项（它是唯一进 argv 的用户输入）。
  if (String(baseRef) !== "HEAD" && !isSafeBranchName(baseRef)) {
    throw new Error(`Invalid base ref: ${baseRef || "(empty)"}`);
  }

  const target = join(String(root), id);
  if (existsSync(target)) {
    throw new Error(`worktree 目录已存在：${target}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  const git = createGitRunner(worktreeOptions(options));
  const created = await git(["worktree", "add", "--detach", target, String(baseRef || "HEAD")], { cwd: project });
  if (!created.ok) {
    // 半个 worktree 不如没有：失败时把注册信息和工作目录都清掉，避免留下一个
    // `git worktree list` 里看得见、但 checkout 不出来的幽灵。
    await rollbackWorktree(project, target, options);
    throw new Error(gitFailureReason(created));
  }

  const included = await copyWorktreeIncludeFiles(project, target, options);
  // 复制完 include 文件之后再链 `.pi`：万一 `.worktreeinclude` 里声明了 `.pi/...`，那份是
  // 用户要带过去的真实文件，先让 copy 建出目录，链就自然跳过（见 linkProjectPiIntoWorktree）。
  const piLink = linkProjectPiIntoWorktree(project, target);
  // git 自己记的是解析过符号链接的真实路径（`worktree list` 报的也是它），返回值跟着保持一致，
  // 否则会话存下来的 cwd 与 git 的清单会是同一目录的两个写法。
  return { path: realOrResolved(target), id, base, included, piLink };
}

/** 建 worktree 失败时的回滚：先摘链，再摘注册，最后删目录。 */
async function rollbackWorktree(project, target, options) {
  removeWorktreePiLink(target);
  const git = createGitRunner(worktreeOptions(options));
  await git(["worktree", "remove", "--force", target], { cwd: project }).catch(() => undefined);
  await git(["worktree", "prune"], { cwd: project }).catch(() => undefined);
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // 回滚尽力而为：目录删不掉也不能把原始错误盖掉。
  }
}

/**
 * 按 `.worktreeinclude` 把仓库里被 gitignore 的本地文件复制进 worktree。
 * 已存在的文件不覆盖、符号链接跳过（和 Codex 一致），单文件与总数都有上限。
 */
export async function copyWorktreeIncludeFiles(sourceCwd, targetPath, options = {}) {
  const patterns = readWorktreeInclude(sourceCwd);
  if (!patterns.length) {
    return { copied: [], skipped: 0 };
  }

  const git = createGitRunner(worktreeOptions(options));
  const listed = await git(
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
    { cwd: String(sourceCwd) },
  );
  if (!listed.ok) {
    return { copied: [], skipped: 0 };
  }

  const candidates = selectWorktreeIncludeFiles(patterns, cleanPaths(listed.stdout.split("\0")));
  const copied = [];
  let skipped = 0;
  for (const relativePath of candidates) {
    if (copied.length >= MAX_WORKTREE_INCLUDE_FILES) {
      skipped += 1;
      continue;
    }

    const source = join(String(sourceCwd), relativePath);
    const destination = join(String(targetPath), relativePath);
    try {
      const info = lstatSync(source);
      // 符号链接跳过（跟 Codex 一致）：跨目录的链接复制过去既可能指错，也可能把大目录拖进来。
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_WORKTREE_INCLUDE_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      if (existsSync(destination)) {
        continue;
      }
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      copied.push(relativePath);
    } catch {
      skipped += 1;
    }
  }

  return { copied, skipped };
}

/** 托管 worktree 清单（只报落在托管根目录里的那些）。 */
export async function listManagedWorktrees(cwd, { root } = {}, options = {}) {
  const project = String(cwd ?? "").trim();
  if (!project) {
    return [];
  }

  const git = createGitRunner(worktreeOptions(options));
  const listed = await git(["worktree", "list", "--porcelain"], { cwd: project });
  if (!listed.ok) {
    return [];
  }

  return parseWorktreeListPorcelain(listed.stdout).filter((entry) => isManagedWorktreePath(root, entry.path));
}

/**
 * 目录软链的类型：Windows 上建目录链接需要开发者模式/管理员权限，junction 不需要；
 * Node 在非 Windows 平台忽略这个 type，等价普通软链，所以两边可以传同一个值。
 */
export function piLinkSymlinkType(platform = process.platform) {
  return platform === "win32" ? "junction" : "dir";
}

/**
 * 把项目根的 `.pi` 链进 worktree（幂等）。
 *
 * 四种结果都返回而不是抛错 —— 调用方（建 worktree / 开会话 / 重载能力）都不该因为共享失败
 * 而彻底失败，失败时差的是「项目级 skills/packages 看不到」，会在诊断里留下 reason。
 * - `no-project-pi`：项目还没有 `.pi`，无从共享（之后出现时开会话/重载会补上）；
 * - `existing-pi`：worktree 里已经有一份真实的 `.pi`（分支提交的，或 `.worktreeinclude`
 *   复制过去的），那份比共享链更具体，绝不覆盖；
 * - `already` / `linked` / `relinked`：成功；
 * - `error`：建链失败（权限、Windows 无 junction），带 `error`。
 */
export function linkProjectPiIntoWorktree(projectCwd, worktreePath, { platform = process.platform } = {}) {
  const project = String(projectCwd ?? "").trim();
  const worktree = String(worktreePath ?? "").trim();
  if (!project || !worktree) {
    return { linked: false, reason: "missing-input" };
  }

  const source = realOrResolved(join(project, WORKTREE_PI_DIR_NAME));
  if (!existsSync(source)) {
    return { linked: false, reason: "no-project-pi" };
  }

  const destination = join(worktree, WORKTREE_PI_DIR_NAME);
  let existing = null;
  try {
    existing = lstatSync(destination);
  } catch {
    existing = null;
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      return { linked: false, reason: "existing-pi" };
    }
    let current = "";
    try {
      current = realpathSync(destination);
    } catch {
      current = "";
    }
    if (current === source) {
      return { linked: true, reason: "already" };
    }
    // 托管检出归应用管：指向别处的软链换成项目那份，避免上一个项目 / 移动后的残留。
    try {
      unlinkSync(destination);
    } catch (error) {
      return { linked: false, reason: "error", error };
    }
  }

  try {
    symlinkSync(source, destination, piLinkSymlinkType(platform));
    return { linked: true, reason: existing ? "relinked" : "linked" };
  } catch (error) {
    return { linked: false, reason: "error", error };
  }
}

/**
 * 摘掉 worktree 里的共享 `.pi` 链（不递归、不碰真实目录）。
 *
 * 删 worktree 前必须先把链摘掉，原因有两个：git 看到未跟踪的 `.pi` 会拒绝删除；更重要的
 * 是删除动作绝不能顺着链把项目的 `.pi` 带走。
 */
export function removeWorktreePiLink(worktreePath) {
  const target = String(worktreePath ?? "").trim();
  if (!target) {
    return false;
  }
  const link = join(target, WORKTREE_PI_DIR_NAME);
  try {
    if (!lstatSync(link).isSymbolicLink()) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    unlinkSync(link);
    return true;
  } catch {
    return false;
  }
}

/**
 * worktree 里的未提交 / 未跟踪 / 被忽略文件。
 * UI 用它显示「这个 worktree 脏不脏」，删除前也用它做安全闸。
 *
 * 共享 `.pi` 链是应用自己放的，不算用户改动（`git status --ignored` 一定会列出来，所以这条
 * 过滤跟 `.gitignore` / `info/exclude` 无关）。只在该链存在时过滤，分支自带的真实 `.pi`
 * 里真的有改动时不会被藏起来。
 */
export async function readWorktreeChanges(worktreePath, options = {}) {
  const target = String(worktreePath ?? "").trim();
  if (!target) {
    return { changed: [], untracked: [], ignored: [] };
  }

  const git = createGitRunner(worktreeOptions(options));
  const status = await git(
    ["status", "--porcelain", "-z", "--ignored", "--untracked-files=normal"],
    { cwd: target },
  );
  if (!status.ok) {
    return { changed: [], untracked: [], ignored: [] };
  }

  const parsed = parseStatusPorcelainZ(status.stdout);
  const dropPiLink = isWorktreePiLink(target)
    ? (paths) => paths.filter((path) => !isProjectPiLinkEntry(path))
    : (paths) => paths;
  return {
    changed: dropPiLink(cleanPaths(parsed.changed)),
    untracked: dropPiLink(cleanPaths(parsed.untracked)),
    ignored: dropPiLink(cleanPaths(parsed.ignored)),
  };
}

/** 删除前的安全闸：有东西没交出去就要先问过用户（`force` 由二次确认后传进来）。 */
export function worktreeRemovalBlocked(changes) {
  const changed = changes?.changed?.length ?? 0;
  const untracked = changes?.untracked?.length ?? 0;
  const ignored = changes?.ignored?.length ?? 0;
  if (!changed && !untracked && !ignored) {
    return "";
  }
  return `worktree 里还有未提交内容（修改 ${changed} / 未跟踪 ${untracked} / 被忽略 ${ignored}）。`;
}

/**
 * 删一个托管 worktree。
 *
 * 三道门：非托管路径不删（`isManagedWorktreePath`）、有未提交内容且没给 `force` 不删、
 * 删完 `prune` 一次把 git 的 worktree 元数据收干净。
 */
export async function removeManagedWorktree(cwd, targetPath, { root, force = false } = {}, options = {}) {
  const project = String(cwd ?? "").trim();
  const target = String(targetPath ?? "").trim();
  if (!project || !target) {
    throw new Error("删除 worktree 需要项目目录和 worktree 路径。");
  }
  if (!isManagedWorktreePath(root, target)) {
    throw new Error("只删除应用自己创建的 worktree。");
  }

  if (!force) {
    const blocked = worktreeRemovalBlocked(await readWorktreeChanges(target, options));
    if (blocked) {
      throw new Error(blocked);
    }
  }

  const git = createGitRunner(worktreeOptions(options));
  // 目录已经不在了（用户在访达里删掉了它，或者磁盘清理工具干的）：没有文件可删，但 git
  // 的注册信息还在 `worktree list` 里 —— 走 prune 把它清掉，而不是报“目录不存在”把用户
  // 卡在一个点不掉的红徽标上。
  if (!existsSync(target)) {
    await git(["worktree", "prune"], { cwd: project }).catch(() => undefined);
    return { path: target, pruned: true };
  }

  // 先摘共享 `.pi` 链：git 看到未跟踪的 `.pi` 会拒绝 remove；而且先把链解开，删除动作就
  // 绝无可能顺着它删到项目的 `.pi`。分支自带的真实 `.pi` 不是软链，这里不动它。
  const piLinkRemoved = removeWorktreePiLink(target);

  const removed = await git(["worktree", "remove", ...(force ? ["--force"] : []), target], { cwd: project });
  if (!removed.ok) {
    throw new Error(gitFailureReason(removed));
  }
  await git(["worktree", "prune"], { cwd: project }).catch(() => undefined);
  return { path: target, piLinkRemoved };
}

/** worktree 的显示名：`<项目名>-<id>` 的最后两段，给徽标用。 */
export function worktreeDisplayName(targetPath) {
  const value = String(targetPath ?? "").replace(/\/+$/, "");
  return basename(value) || value;
}

/** 给日志/诊断用的简短描述。 */
export function worktreeSummary(entry) {
  if (!entry) {
    return "";
  }
  return `${worktreeDisplayName(entry.path)}${entry.branchName ? ` (${entry.branchName})` : entry.detached ? " (detached)" : ""}`;
}

/** 相对路径工具：worktree 内的绝对路径 → 仓库内相对路径（给 UI 显示）。 */
export function relativeToWorktree(worktreePath, targetPath) {
  return relative(resolve(String(worktreePath)), resolve(String(targetPath)));
}