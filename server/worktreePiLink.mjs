/**
 * 「共享 `.pi` 链」：为什么存在、怎么识别。
 *
 * 托管 worktree 里 `<worktree>/.pi` 是一条指向 `<project>/.pi` 的软链。原因：pi 的
 * `DefaultResourceLoader` 把「会话 cwd」同时当成「项目配置根」—— `.pi/skills`、`.pi/extensions`、
 * 项目包的相对源、`.pi/npm|git` 安装根全按 `join(cwd, '.pi')` 算。会话 cwd 在 worktree 里，
 * 不建链就看不到项目级能力；把资源路径一个个注入给 pi 只能救技能和绝对源包，救不了相对源包，
 * 还会和 pi 自己的发现撞名。让 worktree 的 `.pi` 就是项目那份，隐式解析自动算对，也只有一份包。
 *
 * 代价：对 git 来说它是未跟踪/被忽略的条目，但它是应用自己放的，不是用户的活 —— 脏检查、
 * 徽标、提交列表都要把它排除掉（真实目录不排除）。建/摘链在 `gitWorktree.mjs`。
 *
 * 单独成模块是因为 worktree 生命周期（`gitWorktree.mjs`）和 git 状态读取（`gitInfo.mjs`）
 * 两边都要用，而后两者本来就是单向依赖（worktree → gitInfo），互相 import 会成环。
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";

export const WORKTREE_PI_DIR_NAME = ".pi";

/** `<worktree>/.pi` 是不是应用建的软链（而不是分支自己提交进来的真实目录）。 */
export function isWorktreePiLink(worktreePath) {
  const target = String(worktreePath ?? "").trim();
  if (!target) {
    return false;
  }
  try {
    return lstatSync(join(target, WORKTREE_PI_DIR_NAME)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 相对路径是不是那条共享 `.pi`（本条目 `.pi` 或它下面的 `.pi/...`）。 */
export function isProjectPiLinkEntry(relativePath) {
  const path = String(relativePath ?? "");
  return path === WORKTREE_PI_DIR_NAME || path.startsWith(`${WORKTREE_PI_DIR_NAME}/`);
}

/**
 * 从 git 报出来的条目里剔掉共享 `.pi`。条目形态是 `{ path }`（既有解析结果）；
 * 只有该 worktree 的 `.pi` 真的是软链时才过滤，分支自带的真实 `.pi` 改动照常保留。
 */
export function dropProjectPiLinkEntries(worktreePath, entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!isWorktreePiLink(worktreePath)) {
    return list;
  }
  return list.filter((entry) => !isProjectPiLinkEntry(entry?.path));
}