/**
 * 能力资源的「路径身份」：一个 extension / skill 属于哪个 scope、算不算同一个资源，统一按
 * **真实路径**（realpath）判断，而不是 `resolve()`。
 *
 * 为什么不能只用 `resolve()`：托管 worktree 里 `<worktree>/.pi` 是一条指向 `<project>/.pi`
 * 的软链（见 `gitWorktree.mjs` 的 `linkProjectPiIntoWorktree`），pi 从会话 cwd 走过时看到、
 * 报出来的是软链那侧的路径（`resolve` 不解析软链），而 Pi Desktop 记的能力清单是按项目根算
 * 的项目那侧路径。两边不对齐，就会出三件错事：能力面板里查无此技能、开关对它不起作用、
 * 被禁用的包体资源过滤不掉（`disabledPackageRoots` 前缀匹配失败）。
 *
 * 只对「存在的东西」解析软链；不存在（还没建的目录、被删掉的 worktree）退回 `resolve()`，
 * 保证纯函数、不抛错。这样调用方不用先 existsSync。
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * 真实路径；路径不存在时解析「最深的已存在祖先」再把剩余段接回去（不是简单退回 resolve）。
 * 例：macOS 的 `/var/folders/...` 实际是 `/private/var/folders/...`，待建的目录必须和已存在的
 * 根写成同一个前缀，否则「在不在这个根里」会假阴。
 */
export function canonicalPath(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  return canonicalizeExistingPrefix(resolve(text));
}

function canonicalizeExistingPrefix(absolutePath) {
  const suffix = [];
  let current = absolutePath;
  for (;;) {
    try {
      const real = realpathSync(current);
      return suffix.length ? join(real, ...suffix) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return absolutePath;
      }
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

/** 目标是否落在根目录里（根目录本身算在内）。比较用 `resolve`，不解析软链 —— 语义与之前一致。 */
export function isPathInside(root, candidate) {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 软链感知版的 `isPathInside`：两边先 realpath 再比。 */
export function isPathInsideCanonical(root, candidate) {
  const normalizedRoot = canonicalPath(root);
  const normalizedCandidate = canonicalPath(candidate);
  if (!normalizedRoot || !normalizedCandidate) {
    return false;
  }
  return isPathInside(normalizedRoot, normalizedCandidate);
}

/**
 * extension 的能力 id。软链共享的项目扩展（worktree 会话里从 `<worktree>/.pi/extensions`
 * 加载的那份）因此和项目会话里是同一个 id，配置（capabilities.json 的 pin / 默认开关）与
 * 会话选择都能对上。
 */
export function extensionCapabilityId(filePath) {
  return canonicalPath(filePath);
}

/** 某个 skill 文件是否落在「受管的技能根」里（内置、用户、项目三处）。 */
export function isSkillPathUnderRoots(filePath, roots) {
  const normalized = canonicalPath(filePath);
  if (!normalized) {
    return false;
  }
  return (roots ?? []).some((root) => isPathInsideCanonical(root, normalized));
}