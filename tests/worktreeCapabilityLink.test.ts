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
import { bridgeFiles, bridgeSource } from "./lib/bridgeSource.ts";

// 正向断言（这段代码在桥里）看整棵树 —— 桥已按领域拆文件，钉具体文件会让每次拆分假红；
// 否定断言（入口里不许再自己实现一份）才看 `server/index.mjs`。
const bridgeTree = bridgeSource();

/** 取 `start 标记` 到 `end 标记` 之间的源码区间（两个锚点都必须唯一且有序）。 */
function region(source, startMark, endMark) {
  const start = source.indexOf(startMark);
  assert.ok(start >= 0, `找不到起始锚点: ${startMark}`);
  const end = source.indexOf(endMark, start);
  assert.ok(end > start, `找不到结束锚点: ${endMark}`);
  return source.slice(start, end);
}

test("index.mjs 从 capabilityPathIdentity 取路径身份，不再自己 resolve", () => {
  // 只钉「这些身份函数必须来自那个模块」，不钉 import 列表的完整字面量 —— 列表增删一个符号
  // 不该红；真正要防的是本地又抄一份 resolve 版实现（下面两条负面断言）。
  // 这条看的是**入口**：它是 import 这些身份函数的调用方，也正是「不许自己再写一份」的那个文件。
  // 桥拆成领域模块后，调用这些身份函数的不是入口而是各领域文件 —— 所以按整棵树取 import。
  const identitySymbols = [
    ...bridgeTree.matchAll(/import \{([^}]+)\} from "\.\/capabilityPathIdentity\.mjs";/g),
  ]
    .flatMap((match) => match[1].split(","))
    .map((symbol) => symbol.trim());
  for (const symbol of [
    "canonicalPath",
    "extensionCapabilityId",
    "isPathInside",
    "isReadOnlySkillSource",
    "isSkillPathUnderRoots",
    "skillPathTarget",
    "skillSourceForPath",
  ]) {
    assert.ok(
      identitySymbols.includes(symbol),
      `capabilityPathIdentity 的 ${symbol} 必须从那个模块取，不许在桥里另写一份`,
    );
  }
  // 「不许自己再写一份」的准确写法：整棵树里这个函数**只能**定义在身份模块里
  // （拆文件后树里包含定义本身，直接对整棵树做否定断言会把唯一合法的那份也算进去）。
  const definers = bridgeFiles()
    .filter(([, text]) => /function extensionCapabilityId\(/.test(text))
    .map(([name]) => name);
  assert.deepEqual(
    definers,
    ["server/capabilityPathIdentity.mjs"],
    "resolve 版 id 只许有一份，且在身份模块里",
  );
  assert.match(
    bridgeTree,
    /function isManagedSkillPath\(filePath, project = activeProject\(\)\) \{\s*return isSkillPathUnderRoots\(/,
  );
});

test("override 用 canonicalPath 判身份：软链侧的 extension / skill 才对得上能力清单", () => {
  const overrides = region(
    bridgeTree,
    "extensionsOverride: (base) => ({",
    "appendSystemPromptOverride:",
  );
  assert.match(overrides, /const normalized = canonicalPath\(extension\.path\);/);
  assert.doesNotMatch(overrides, /const normalized = resolve\(/, "不能再退回 resolve");
  // 技能走 capabilitySkillSelection 的活策略（主分支的修复），但禁用包的守卫要按 realpath 比，
  // 否则 worktree 会话里从软链侧报上来的包体资源过滤不掉。
  assert.match(overrides, /applySkillSelection\(base\.skills, capabilityPaths\.skillSelection/);
  assert.match(overrides, /isManaged: \(path\) => isManagedSkillPath\(path, project\)/);
  assert.match(
    overrides,
    /isDisabledPath: \(path\) => capabilityPaths\.disabledPackageRoots\.some\(\(root\) => isPathInside\(root, canonicalPath\(path\)\)\)/,
  );
});

test("能力清单里的路径按 realpath 算（含 disabledPackageRoots 的前缀匹配）", () => {
  assert.match(
    bridgeTree,
    /skillPaths: \[appSkillsDir, \.\.\.new Set\(skillPaths\.map\(\(path\) => canonicalPath\(path\)\)\)\]/,
  );
  assert.match(
    bridgeTree,
    /disabledPackageRoots: packages[\s\S]{0,220}\.map\(\(path\) => canonicalPath\(path\)\)/,
  );
  assert.match(bridgeTree, /\.map\(\(resource\) => canonicalPath\(resource\.path\)\)/);
});

test("开会话与重载能力时都会幂等补项目 .pi 的软链", () => {
  const ensure = region(
    bridgeTree,
    "function ensureWorktreePiLink",
    "function sessionWorkspaceCwdForPath",
  );
  assert.match(ensure, /linkProjectPiIntoWorktree\(project\.cwd, workspaceCwd\)/);
  assert.match(ensure, /workspaceCwd === project\.cwd/, "普通会话不碰");
  assert.match(
    ensure,
    /isManagedWorktreePath\(worktreesRoot, workspaceCwd\)/,
    "只认托管 worktree，不在普通子目录造链",
  );

  const create = region(
    bridgeTree,
    "async function createRuntime",
    "function ensureBuiltinPackages",
  );
  assert.match(create, /const workspaceCwd = sessionWorkspaceCwd\(project, sessionManager\);/);
  assert.match(create, /ensureWorktreePiLink\(project, workspaceCwd/, "会话打开时补链");

  // reloadRuntimeTargets 已按域搬到 server/skillPackages.mjs —— 这一处要读整座桥。
  const reload = region(bridgeSource(), "async function reloadRuntimeTargets", "\nfunction ");
  assert.match(
    reload,
    /ensureWorktreePiLink\(project, candidate\.workspaceCwd\)/,
    "刚装的项目技能能到已开的 worktree 会话",
  );
});

test("建 worktree 时链上项目 .pi，删除时先摘链", () => {
  const gitWorktreeSource = readFileSync(
    new URL("../server/gitWorktree.mjs", import.meta.url),
    "utf8",
  );
  const create = region(
    gitWorktreeSource,
    "export async function createManagedWorktree",
    "async function rollbackWorktree",
  );
  assert.match(create, /const piLink = linkProjectPiIntoWorktree\(project, target\);/);
  assert.match(create, /return \{ path: realOrResolved\(target\), id, base, included, piLink \};/);

  const remove = region(
    gitWorktreeSource,
    "export async function removeManagedWorktree",
    "export function worktreeDisplayName",
  );
  assert.match(remove, /const piLinkRemoved = removeWorktreePiLink\(target\);/);
  assert.match(
    remove,
    /git\(\["worktree", "remove"/,
    "摘链之后才删，git 不会因为未跟踪的 .pi 拒绝",
  );
  const unlinkAt = remove.indexOf("removeWorktreePiLink(target)");
  const gitRemoveAt = remove.indexOf('"worktree", "remove"');
  assert.ok(unlinkAt >= 0 && unlinkAt < gitRemoveAt, "摘链必须发生在 git worktree remove 之前");
});
