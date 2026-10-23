/**
 * `.agents/skills`（跨客户端技能约定目录）的接线守卫。
 *
 * pi 无条件发现它（用户那份 + 从 cwd 向上的每一层，见 projectAgentsSkillRoots），但能力页/会话
 * 开关以前只认 `~/.pi/agent/skills`，于是 `.agents` 那侧是「看不见、也不能关」。这组用例钉住：
 * 1. 跨客户端目录从真实 home 推导，并进入 `managedSkillRoots`；
 * 2. 能力清单用「字面路径优先」的 `skillSourceForPath` 分类（含项目级的 `projectAgents`）；
 * 3. 内置与 `.agents` 来源只读，删除守卫按**字面路径**拦（`~/.pi` 指向它的软链仍可删）；
 * 4. 读内容兜底与版本快照也认识这些目录。
 *
 * `server/index.mjs` 是进程内 `.mjs`，`node --test` 直接 import 会拉起整个 server，
 * 所以按仓库惯例做源码级断言（参见 tests/worktreeCapabilityLink.test.ts）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");

/** 取 `startMark` 到 `endMark` 之间的源码区间（两个锚点都必须从 start 之后有序出现）。 */
function region(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  assert.ok(start >= 0, `找不到起始锚点: ${startMark}`);
  const end = source.indexOf(endMark, start);
  assert.ok(end > start, `找不到结束锚点: ${endMark}`);
  return source.slice(start, end);
}

test("跨客户端技能目录从真实 home 推导，不是写死的路径", () => {
  assert.match(serverSource, /const agentsSkillsDir = join\(homedir\(\), "\.agents", "skills"\);/);
});

test("受管根包含 .agents（用户的与项目的），能力页才能显示 / 按会话开关它", () => {
  // 受管根是一个函数：项目里的 `.agents/skills` 从 cwd 一路向上可能有好几个，
  // 写死成数组就又把它们漏成「查无此技能」。
  assert.match(
    serverSource,
    /function isManagedSkillPath\(filePath, project = activeProject\(\)\) \{\s*return isSkillPathUnderRoots\(filePath, managedSkillRoots\(project\)\);/,
  );
  const roots = region(serverSource, "function managedSkillRoots(", "function projectAgentsSkillsDirs(");
  for (const root of ["appSkillsDir", "agentSkillsDir", "agentsSkillsDir", "...projectAgentsSkillsDirs(project)", 'join(project.cwd, ".pi", "skills")']) {
    assert.ok(roots.includes(root), `受管根缺少 ${root}`);
  }
  // 项目那份必须和 pi 同源（同一个遍历规则），否则分类会和 pi 报的路径对不上。
  assert.match(serverSource, /function projectAgentsSkillsDirs\(project = activeProject\(\)\) \{\s*return projectAgentsSkillRoots\(project\.cwd, homedir\(\)\);/);
});

test("能力清单按 skillSourceForPath 分类，并据此给出 readonly", () => {
  const payload = region(serverSource, "const source = skillSourceForPath(", ".sort(compareCapabilityCards)");
  assert.match(payload, /builtin: appSkillsDir,/);
  assert.match(payload, /piAgent: agentSkillsDir,/);
  assert.match(payload, /agents: agentsSkillsDir,/);
  assert.match(payload, /projectAgents: projectAgentsSkillsDirs\(project\),/);
  assert.match(payload, /source,\n/, "payload 用算好的 source，而不是就地二选一");
  assert.match(payload, /readonly: isReadOnlySkillSource\(source\),/);
  // 旧的二选一分类必须消失，否则 .agents 永远落不到自己的 chip。
  assert.doesNotMatch(serverSource, /isBuiltinSkillPath\(skill\.filePath\)[\s\S]{0,40}\? "builtin"/);
});

test("删除守卫按字面路径拦 .agents，~/.pi 那侧的软链仍然可删", () => {
  const guard = region(serverSource, "function assertWritableSkillTarget", "function assertWritableSkillFile");
  // 用户的与项目的 `.agents/skills` 一律只读：路径里出现 `.agents/skills` 段就拦。
  assert.match(guard, /isCrossClientSkillPath\(skillRoot\)/);
  assert.match(guard, /Skills in \.agents\/skills are shared across agents and read-only here\./);
  assert.doesNotMatch(
    guard,
    /isSkillPathUnderRoots\(skillRoot, \[agentsSkillsDir\]\)/,
    "realpath 命中会让 ~/.pi/agent/skills 指向 .agents 的软链也删不掉",
  );
  // 只拦 literal 的 `.agents` 段，不解析软链：`~/.pi/agent/skills/x -> …/.agents/skills/x`
  // 的字面路径里没有这段，所以删的仍然只是那条软链。
  assert.doesNotMatch(guard, /isPathInsideCanonical|realpathSync/);
});

test("读内容兜底与版本快照都认识 .agents", () => {
  assert.match(
    serverSource,
    /function discoverSkillFromKnownRoots\(project, filePath\) \{\s*const roots = managedSkillRoots\(project\);/,
  );
  assert.match(
    serverSource,
    /function inferInstalledSkillScope\(project, skillRoot\) \{\s*if \(isSkillPathUnderRoots\(skillRoot, \[agentSkillsDir, agentsSkillsDir\]\)\) \{\s*return "user";/,
  );
});