/**
 * 「这条会话现在跑在哪个目录」的唯一判定规则。
 *
 * 托管 worktree 的会话，其 cwd（pi 在 `SessionManager.create(cwd, dir)` 时写进会话文件头）
 * 就是 worktree 路径；普通会话一直是项目目录。这条规则错一次的后果很重 —— agent 会在用户
 * 没预期的检出里改文件、git 徽标显示错的分支 —— 所以它单独成模块、可测：
 *
 * - cwd 落在托管 worktree 根目录之外（项目被移动、会话文件被手改、用户自己建的 worktree）
 *   → 项目目录；
 * - worktree 目录已经不存在（被外部删掉、被清理）→ 项目目录，绝不让 runtime 建在一个
 *   已消失的 cwd 上；
 * - 只有「在托管根目录里」+「目录还在」才真正采信。
 *
 * 注意：判定只看路径归属和存在性，不碰磁盘以外的东西；`pathExists` 可注入，测试不需要
 * 真的建目录。
 */
import { existsSync } from "node:fs";

import { isManagedWorktreePath } from "./gitWorktree.mjs";

/**
 * @returns {{ cwd: string, reason: "project" | "worktree" | "missing" }}
 *   `reason` 只用于诊断：`missing` 表示会话本来在 worktree 里、但目录已经没了。
 */
export function resolveSessionWorkspaceCwd({ projectCwd, worktreeRoot, sessionCwd, pathExists = existsSync } = {}) {
  const project = String(projectCwd ?? "").trim();
  const candidate = String(sessionCwd ?? "").trim();
  if (!candidate || candidate === project) {
    return { cwd: project, reason: "project" };
  }
  if (!isManagedWorktreePath(worktreeRoot, candidate)) {
    return { cwd: project, reason: "project" };
  }
  if (!pathExists(candidate)) {
    return { cwd: project, reason: "missing" };
  }
  return { cwd: candidate, reason: "worktree" };
}