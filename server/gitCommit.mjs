/**
 * Git 写操作：把选中的改动提交出去。
 *
 * 从 `server/gitInfo.mjs` 拆出来的（那个文件到了 1250 行的棘轮上限，`max-lines` 规则要求
 * 「拆而不是抬上限」）。拆的时候只搬这一个函数：它是一次完整的事务（校验路径 → 需要时
 * `add` → `commit -- <paths>`），和读路径共用 `gitInfo.mjs` 里的同一份事实
 * （`parsePorcelainV2` / `commitablePaths` / `gitFailureReason`），所以依赖方向是
 * `gitCommit → gitInfo`，没有回指。
 *
 * 语义：把列出的路径按**工作区**的样子提交（和 UI 显示的行数一致），未选中的文件不受影响。
 */

import { execFile } from "node:child_process";

import { dropProjectPiLinkEntries } from "./worktreePiLink.mjs";
import {
  GIT_TIMEOUT_MS,
  MAX_COMMIT_PATHS,
  commitablePaths,
  createGitRunner,
  gitFailureReason,
  normalizeCommitMessage,
  parsePorcelainV2,
  runReadOnlyGit,
} from "./gitInfo.mjs";

/**
 * 提交选中的改动。
 *
 * 语义是"把这几个文件按磁盘上的样子提交"（和弹层里显示的行数一致）：
 * 1. `git commit -m <msg> -- <paths>` 本身就是部分提交：被列出的路径取**工作区**内容，
 *    因此修改/删除/重命名不需要先 `add`（实测：对已暂存的重命名/删除再 `git add` 反而会以
 *    "pathspec did not match" fatal）；
 * 2. 只有**未跟踪**的文件必须先 `git add` —— 否则 `commit -- <未跟踪路径>` 报
 *    "pathspec did not match any file(s) known to git"；
 * 3. 没被选中的文件一律不受影响：别人在终端里暂存的其它文件不会被卷进来。
 *
 * 路径必须来自刚刚的 `status` 输出，且冲突文件直接拒绝（见 `commitablePaths`）。
 *
 * @param {string} cwd
 * @param {{ message?: string, paths?: string[] }} [request]
 * @param {{
 *   execImpl?: typeof import("node:child_process").execFile,
 *   timeoutMs?: number,
 * }} [options]
 */
export async function commitGitChanges(cwd, { message, paths } = {}, { execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const project = String(cwd ?? "").trim();
  if (!project) {
    throw new Error("Cannot commit without a project folder");
  }

  const text = normalizeCommitMessage(message);
  const requested = Array.isArray(paths) ? paths.map((path) => String(path)) : [];
  if (requested.length === 0) {
    throw new Error("Select at least one file to commit");
  }
  if (requested.length > MAX_COMMIT_PATHS) {
    throw new Error(`Too many paths to commit (max ${MAX_COMMIT_PATHS})`);
  }

  const options = { execImpl, timeoutMs };
  const git = createGitRunner(options);

  const status = await runReadOnlyGit(
    project,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
    options,
  );
  if (!status.ok) {
    throw new Error(gitFailureReason(status));
  }

  const entries = dropProjectPiLinkEntries(project, parsePorcelainV2(status.stdout.split("\u0000")));
  const { paths: allowed, conflicted } = commitablePaths(entries);
  const requestedPaths = [...new Set(requested)];
  for (const path of requestedPaths) {
    if (conflicted.has(path)) {
      throw new Error(`Resolve conflicts before committing: ${path}`);
    }
    if (!allowed.has(path)) {
      throw new Error(`Not a changed file: ${path}`);
    }
  }

  // 重命名由服务端自己补齐旧路径（只提交新路径会留下半个重命名），最后排一次序：
  // argv 稳定，和用户勾选顺序无关。
  const renames = new Map(entries.filter((entry) => entry.origPath).map((entry) => [entry.path, entry.origPath]));
  const chosen = [...new Set(requestedPaths.flatMap((path) => [path, renames.get(path)].filter(Boolean)))].sort();

  const untracked = [...new Set(requestedPaths)].filter((path) => entries.some((entry) => entry.path === path && entry.untracked)).sort();
  if (untracked.length > 0) {
    const added = await git(["add", "--", ...untracked], { cwd: project });
    if (!added.ok) {
      throw new Error(gitFailureReason(added));
    }
  }

  const committed = await git(["commit", "-m", text, "--", ...chosen], { cwd: project });
  if (!committed.ok) {
    throw new Error(gitFailureReason(committed));
  }

  return committed.stdout.trim() || committed.stderr.trim();
}
