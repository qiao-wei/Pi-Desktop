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
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/**
 * 某个 skill 文件是否落在「受管的技能根」里（内置、用户、项目三处）。
 *
 * 两个方向都要认，缺一个就会丢掉一整类技能（都有真实用例）：
 * - **字面路径**：用户的技能通常是从 `~/.pi/agent/skills/x` 指向 `~/.agents/skills/x`（或
 *   `~/.bailian/skills/x`）的软链，pi 报出来的是软链那一侧。只对比 realpath 会把整类用户
 *   技能判成「非托管」—— 能力面板里直接消失、会话级开关也落不到它们身上。
 * - **真实路径**：托管 worktree 会话里，项目技能是通过 `<worktree>/.pi` 软链看到的，pi 报的是
 *   worktree 那一侧，而能力清单锚在项目根。只对比字面路径就认不出它，开关同样落不到。
 */
export function isSkillPathUnderRoots(filePath, roots) {
  const list = roots ?? [];
  const literal = resolve(String(filePath ?? "").trim() || ".");
  if (list.some((root) => isPathInside(resolve(root), literal))) {
    return true;
  }
  const canonical = canonicalPath(filePath);
  if (!canonical) {
    return false;
  }
  return list.some((root) => isPathInsideCanonical(root, canonical));
}

/**
 * 技能来源分类（能力页的 4 个筛选 chip 与卡片徽标共用）：
 * `builtin` 随应用内置、`piAgent` 是 `~/.pi/agent/skills`、`agents` 是跨客户端的
 * `~/.agents/skills`、`project` 是项目 `.pi/skills`。
 *
 * 判定顺序 = pi 的加载顺序，所以「同一份技能两边都能到达」时归属稳定：字面路径先命中
 * （`~/.pi/agent/skills/x` 是指向 `~/.agents/skills/x` 的软链时，pi 报的就是软链那侧，
 * 归 `piAgent`，删它删掉的也只是那条软链）；realpath 只在字面路径都没命中时兜底
 * （worktree 会话里 `<worktree>/.pi` 软链 → 归 `project`）。
 */
export function skillSourceForPath(filePath, roots = {}) {
  // 一个来源可能对应**多个**根（项目的 `.agents/skills` 从 cwd 一路向上都有），所以值可以是数组。
  const entries = [
    ["builtin", roots.builtin],
    ["piAgent", roots.piAgent],
    ["agents", roots.agents],
    ["projectAgents", roots.projectAgents],
  ].flatMap(([source, value]) => {
    const list = Array.isArray(value) ? value : [value];
    return list.filter(Boolean).map((root) => [source, root]);
  });
  // 第一遍只看字面路径：pi 报哪一侧就归哪一侧，分类和删除守卫（也按字面路径）永远一致。
  const literal = resolve(String(filePath ?? "").trim() || ".");
  for (const [source, root] of entries) {
    if (isPathInside(resolve(root), literal)) {
      return source;
    }
  }
  // 字面路径都不认识时才按 realpath 兜底（worktree 会话里 `<worktree>/.pi` 是软链）。
  const canonical = canonicalPath(filePath);
  if (canonical) {
    for (const [source, root] of entries) {
      if (isPathInsideCanonical(root, canonical)) {
        return source;
      }
    }
  }
  // 受管集合里只剩项目 `.pi/skills` 一处；陈旧/未知路径保持旧行为（以前也是落到 project）。
  return "project";
}

/**
 * 内置与跨客户端（`~/.agents/skills`）来源的技能不允许从能力页删除：内置是应用资产；
 * `.agents` 那侧可能被别的客户端一起挂载（例如百炼把同一份技能挂进 `.codex`/`.gemini`），
 * 从这一个客户端删会把别人的入口一起删掉。只有 `piAgent` 与 `project` 可删。
 */
export function isReadOnlySkillSource(source) {
  return source === "builtin" || source === "agents" || source === "projectAgents";
}

/**
 * 一个路径是否住在任何 `.agents/skills` 里（用户的 `~/.agents/skills`，或项目里任意一层
 * 的 `<dir>/.agents/skills`）。
 *
 * 只看字面路径、不解析软链：`~/.pi/agent/skills/x -> ~/.agents/skills/x` 那种软链的两个侧面
 * 身份不同（删软链侧只删软链），正是能力页依赖的语义。
 *
 * 用途是「跨客户端技能一律只读」的守卫：`.agents/skills` 是 Agent Skills 的共享目录，Codex /
 * Gemini / 百炼都从同一份目录读技能，从这一个客户端删会把别人的入口一起删掉。
 */
export function isCrossClientSkillPath(filePath) {
  const parts = resolve(String(filePath ?? "").trim() || ".").split(sep);
  return parts.some((part, index) => part === ".agents" && parts[index + 1] === "skills");
}

/**
 * 项目里的 `.agents/skills` 根列表：从 `cwd` 一路向上到 git 仓库根（有仓库时）或文件系统根。
 *
 * 与 pi 的 `collectAncestorAgentsSkillDirs`（`dist/core/package-manager.js`）同规则，只是把
 * **用户那份** `~/.agents/skills` 排除掉（pi 也排除：那份已经作为用户级 "agents" 来源单独收）。
 * pi 只在项目已信任时才用这些根加载技能，所以这里的列表只用来认身份 / 认来源，不是加载清单。
 */
export function projectAgentsSkillRoots(cwd, homeDir = "") {
  const userAgentsSkillsDir = homeDir ? resolve(homeDir, ".agents", "skills") : "";
  const start = resolve(String(cwd ?? "").trim() || ".");
  const gitRepoRoot = findGitRepoRoot(start);
  const roots = [];
  let dir = start;
  for (;;) {
    const candidate = join(dir, ".agents", "skills");
    if (candidate !== userAgentsSkillsDir) {
      roots.push(candidate);
    }
    if (gitRepoRoot && dir === gitRepoRoot) {
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return roots;
}

function findGitRepoRoot(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return "";
    }
    dir = parent;
  }
}

/**
 * 一个技能落盘后，删除/覆盖它真正要动的那条路径。
 *
 * 技能有两种形态，能力页把它们一视同仁地列出来：
 * - **目录技能**：`<root>/<name>/SKILL.md` → 目标是那个技能目录；
 * - **独立 markdown 技能**：pi 的 `loadSkillsFromDir` 从技能根目录直接收 `*.md`
 *   （`includeRootFiles`），此时目标是那个文件本身。
 *
 * 所以不能统一取 `dirname(filePath)`：独立 md 技能算出来的目标是**整个 skills 根目录**，
 * 删一个技能会把用户所有技能一起 `rm -rf`（`~/.pi/agent/skills` 下还全是指向别处的软链）。
 */
export function skillPathTarget(filePath) {
  const resolved = resolve(String(filePath ?? "").trim() || ".");
  return basename(resolved) === "SKILL.md" ? dirname(resolved) : resolved;
}
