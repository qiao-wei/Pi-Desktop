/**
 * worktree 复用项目 skills / packages 的接线守卫。
 *
 * 机制本身在 `server/worktreePiLink.mjs`（软链识别）与 `server/capabilityPathIdentity.mjs`
 * （realpath 身份）里，各自有真行为用例。这里只按仓库惯例读 `server/index.mjs` 源码，钉住
 * 三处「一改就悄悄退化回去」的接线：
 * 1. 建会话 / 重载能力时幂等补 `<worktree>/.pi` 软链；
 * 2. 两个 override 用 realpath 判身份（否则 worktree 里软链侧的路径对不上能力清单）；
 * 3. 能力清单里的路径（disabledPackageRoots / skillPaths / extensionPaths）也按 realpath 算。
 *
 * 这些是 `.mjs` 进程内函数，`node --test` 直接 import 会拉起整个 server，所以只能做源码级断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");

/** 取 `start 标记` 到 `end 标记` 之间的源码区间（两个锚点都必须唯一且有序）。 */
function region(source, startMark, endMark) {
  const start = source.indexOf(startMark);
  assert.ok(start >= 0, `找不到起始锚点: ${startMark}`);
  const end = source.indexOf(endMark, start);
  assert.ok(end > start, `找不到结束锚点: ${endMark}`);
  return source.slice(start, end);
}

test("index.mjs 从 capabilityPathIdentity 取路径身份，不再自己 resolve", () => {
  assert.match(
    serverSource,
    /import \{ canonicalPath, extensionCapabilityId, isPathInside, isSkillPathUnderRoots \} from "\.\/capabilityPathIdentity\.mjs";/,
  );
  assert.doesNotMatch(serverSource, /function extensionCapabilityId\(/, "本地的 resolve 版 id 已删除");
  assert.match(
    serverSource,
    /function isManagedSkillPath\(filePath, project = activeProject\(\)\) \{\s*return isSkillPathUnderRoots\(/,
  );
});

test("override 用 canonicalPath 判身份：软链侧的 extension / skill 才对得上能力清单", () => {
  const overrides = region(serverSource, "extensionsOverride: (base) => ({", "appendSystemPromptOverride:");
  assert.match(overrides, /const normalized = canonicalPath\(extension\.path\);/);
  assert.doesNotMatch(overrides, /const normalized = resolve\(/, "不能再退回 resolve");
  // 技能走 capabilitySkillSelection 的活策略（主分支的修复），但禁用包的守卫要按 realpath 比，
  // 否则 worktree 会话里从软链侧报上来的包体资源过滤不掉。
  assert.match(overrides, /applySkillSelection\(base\.skills, capabilityPaths\.skillSelection/);
  assert.match(overrides, /isManaged: \(path\) => isManagedSkillPath\(path, project\)/);
  assert.match(overrides, /isDisabledPath: \(path\) => capabilityPaths\.disabledPackageRoots\.some\(\(root\) => isPathInside\(root, canonicalPath\(path\)\)\)/);
});

test("能力清单里的路径按 realpath 算（含 disabledPackageRoots 的前缀匹配）", () => {
  assert.match(serverSource, /skillPaths: \[appSkillsDir, \.\.\.new Set\(skillPaths\.map\(\(path\) => canonicalPath\(path\)\)\)\]/);
  assert.match(serverSource, /disabledPackageRoots: packages[\s\S]{0,220}\.map\(\(path\) => canonicalPath\(path\)\)/);
  assert.match(serverSource, /\.map\(\(resource\) => canonicalPath\(resource\.path\)\)/);
});

test("开会话与重载能力时都会幂等补项目 .pi 的软链", () => {
  const ensure = region(serverSource, "function ensureWorktreePiLink", "function sessionWorkspaceCwdForPath");
  assert.match(ensure, /linkProjectPiIntoWorktree\(project\.cwd, workspaceCwd\)/);
  assert.match(ensure, /workspaceCwd === project\.cwd/, "普通会话不碰");
  assert.match(ensure, /isManagedWorktreePath\(worktreesRoot, workspaceCwd\)/, "只认托管 worktree，不在普通子目录造链");

  const create = region(serverSource, "async function createRuntime", "function ensureBuiltinPackages");
  assert.match(create, /const workspaceCwd = sessionWorkspaceCwd\(project, sessionManager\);/);
  assert.match(create, /ensureWorktreePiLink\(project, workspaceCwd/, "会话打开时补链");

  const reload = region(serverSource, "async function reloadRuntimeTargets", "function skillSummaries");
  assert.match(reload, /ensureWorktreePiLink\(project, candidate\.workspaceCwd\)/, "刚装的项目技能能到已开的 worktree 会话");
});

test("建 worktree 时链上项目 .pi，删除时先摘链", () => {
  const gitWorktreeSource = readFileSync(new URL("../server/gitWorktree.mjs", import.meta.url), "utf8");
  const create = region(gitWorktreeSource, "export async function createManagedWorktree", "async function rollbackWorktree");
  assert.match(create, /const piLink = linkProjectPiIntoWorktree\(project, target\);/);
  assert.match(create, /return \{ path: realOrResolved\(target\), id, base, included, piLink \};/);

  const remove = region(gitWorktreeSource, "export async function removeManagedWorktree", "export function worktreeDisplayName");
  assert.match(remove, /const piLinkRemoved = removeWorktreePiLink\(target\);/);
  assert.match(remove, /git\(\["worktree", "remove"/, "摘链之后才删，git 不会因为未跟踪的 .pi 拒绝");
  const unlinkAt = remove.indexOf("removeWorktreePiLink(target)");
  const gitRemoveAt = remove.indexOf('"worktree", "remove"');
  assert.ok(unlinkAt >= 0 && unlinkAt < gitRemoveAt, "摘链必须发生在 git worktree remove 之前");
});