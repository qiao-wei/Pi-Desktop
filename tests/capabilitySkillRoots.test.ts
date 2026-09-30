/**
 * `~/.agents/skills`（跨客户端技能约定目录）的接线守卫。
 *
 * pi 无条件发现它，但能力页/会话开关以前只认 `~/.pi/agent/skills`，于是 `.agents` 那侧
 * 是「看不见、也不能关」。这组用例钉住四件事：
 * 1. 跨客户端目录从真实 home 推导，并进入 `isManagedSkillPath` 的受管根；
 * 2. 能力清单用「字面路径优先」的 `skillSourceForPath` 分类，4 个 chip 才有数据；
 * 3. 内置与 `.agents` 来源只读，删除守卫按**字面路径**拦（`~/.pi` 指向它的软链仍可删）；
 * 4. 读内容兜底与版本快照也认识这个目录。
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

test("受管根包含 .agents，能力页才能显示 / 按会话开关它", () => {
  assert.match(
    serverSource,
    /function isManagedSkillPath\(filePath, project = activeProject\(\)\) \{\s*return isSkillPathUnderRoots\(filePath, \[appSkillsDir, agentSkillsDir, agentsSkillsDir, join\(project\.cwd, "\.pi", "skills"\)\]\);/,
  );
});

test("能力清单按 skillSourceForPath 分类，并据此给出 readonly", () => {
  const payload = region(serverSource, "const source = skillSourceForPath(", ".sort(compareCapabilityCards)");
  assert.match(payload, /builtin: appSkillsDir,/);
  assert.match(payload, /piAgent: agentSkillsDir,/);
  assert.match(payload, /agents: agentsSkillsDir,/);
  assert.match(payload, /source,\n/, "payload 用算好的 source，而不是就地二选一");
  assert.match(payload, /readonly: isReadOnlySkillSource\(source\),/);
  // 旧的二选一分类必须消失，否则 .agents 永远落不到自己的 chip。
  assert.doesNotMatch(serverSource, /isBuiltinSkillPath\(skill\.filePath\)[\s\S]{0,40}\? "builtin"/);
});

test("删除守卫按字面路径拦 .agents，~/.pi 那侧的软链仍然可删", () => {
  const guard = region(serverSource, "function assertWritableSkillTarget", "function assertWritableSkillFile");
  assert.match(guard, /isPathInside\(resolve\(agentsSkillsDir\), resolve\(skillRoot\)\)/);
  assert.doesNotMatch(
    guard,
    /isSkillPathUnderRoots\(skillRoot, \[agentsSkillsDir\]\)/,
    "realpath 命中会让 ~/.pi/agent/skills 指向 .agents 的软链也删不掉",
  );
});

test("读内容兜底与版本快照都认识 .agents", () => {
  assert.match(
    serverSource,
    /const roots = \[appSkillsDir, agentSkillsDir, agentsSkillsDir, join\(project\.cwd, "\.pi", "skills"\)\];/,
  );
  assert.match(
    serverSource,
    /function inferInstalledSkillScope\(project, skillRoot\) \{\s*if \(isSkillPathUnderRoots\(skillRoot, \[agentSkillsDir, agentsSkillsDir\]\)\) \{\s*return "user";/,
  );
});