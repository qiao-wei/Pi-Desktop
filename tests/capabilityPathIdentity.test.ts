/**
 * 能力资源的路径身份（`server/capabilityPathIdentity.mjs`）。
 *
 * 背景：pi 报技能路径时**不做 realpath**，所以两边都有「软链那一侧」的情况：
 * - worktree 会话里 `<worktree>/.pi` 是指向 `<project>/.pi` 的软链，项目技能报的是 worktree 那侧，
 *   而能力清单算的是项目那侧；
 * - 用户的技能本身就是软链（`~/.pi/agent/skills/x -> ~/.agents/skills/x`），报的就是软链那侧。
 *
 * 这一组用例要证明：这两个方向都得认（只认 realpath 会丢掉一整类用户技能，只认字面路径会丢掉
 * worktree 里的项目技能），且「算不算同一个 extension」在两种写法下答案一致。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  canonicalPath,
  extensionCapabilityId,
  isPathInside,
  isPathInsideCanonical,
  isReadOnlySkillSource,
  isSkillPathUnderRoots,
  skillSourceForPath,
} from "../server/capabilityPathIdentity.mjs";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("canonicalPath：存在的路径解析软链，不存在的路径把已存在祖先解析后再接回去，空串不折成 cwd", () => {
  const root = tempDir("pi-pathid-");
  try {
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "f.txt"), "x\n");
    const link = join(root, "link");
    symlinkSync(real, link, "dir");

    assert.equal(canonicalPath(join(link, "f.txt")), canonicalPath(join(real, "f.txt")));
    assert.equal(
      canonicalPath(join(root, "nope", "f.txt")),
      join(canonicalPath(root), "nope", "f.txt"),
      "待建目录与已存在的根写成同一个前缀（macOS /var ↔ /private/var）",
    );
    assert.equal(canonicalPath(""), "", "空串不解析成 cwd");
    assert.equal(canonicalPath("   "), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isPathInside 保持 resolve 语义（不解析软链），isPathInsideCanonical 才解析", () => {
  const root = tempDir("pi-pathid-");
  try {
    const real = join(root, "project", ".pi", "extensions");
    mkdirSync(real, { recursive: true });
    const worktree = join(root, "worktree");
    mkdirSync(worktree, { recursive: true });
    symlinkSync(join(root, "project", ".pi"), join(worktree, ".pi"), "dir");
    const viaLink = join(worktree, ".pi", "extensions", "x.ts");
    writeFileSync(viaLink, "export default () => {}\n");

    assert.equal(isPathInside(real, viaLink), false, "resolve 版看不见软链归属（这正是原来的 bug）");
    assert.equal(isPathInsideCanonical(real, viaLink), true, "realpath 版看见同一份文件");
    assert.equal(isPathInsideCanonical(real, join(real, "nested", "x.ts")), true);
    assert.equal(isPathInsideCanonical(real, join(root, "project", ".pi", "skills", "x.ts")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extensionCapabilityId：同一条软链路径与真实路径得到同一个 id", () => {
  const root = tempDir("pi-pathid-");
  try {
    const real = join(root, "project", ".pi", "extensions", "demo.ts");
    mkdirSync(join(root, "project", ".pi", "extensions"), { recursive: true });
    writeFileSync(real, "export default () => {}\n");
    const worktree = join(root, "worktree");
    mkdirSync(worktree, { recursive: true });
    symlinkSync(join(root, "project", ".pi"), join(worktree, ".pi"), "dir");

    const viaLink = join(worktree, ".pi", "extensions", "demo.ts");
    assert.equal(extensionCapabilityId(viaLink), extensionCapabilityId(real));
    assert.equal(extensionCapabilityId("/definitely/not/here.ts"), resolve("/definitely/not/here.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isSkillPathUnderRoots：技能目录自己就是软链（用户技能常见写法）也算受管", () => {
  const root = tempDir("pi-pathid-");
  try {
    // root 扮演 ~/.pi/agent/skills，real 扮演 ~/.agents/skills：root/x 是指向 real/x 的软链。
    // 只比对 realpath 会把整类用户技能判成「非托管」—— 面板里消失、开关失效。
    const agentSkills = join(root, "agent", "skills");
    const realSkills = join(root, "agents", "skills");
    mkdirSync(join(realSkills, "lark-im"), { recursive: true });
    mkdirSync(agentSkills, { recursive: true });
    writeFileSync(join(realSkills, "lark-im", "SKILL.md"), "---\nname: lark-im\n---\n");
    symlinkSync(join(realSkills, "lark-im"), join(agentSkills, "lark-im"), "dir");

    assert.equal(isSkillPathUnderRoots(join(agentSkills, "lark-im", "SKILL.md"), [agentSkills]), true, "软链那侧算受管");
    assert.equal(
      isSkillPathUnderRoots(join(realSkills, "lark-im", "SKILL.md"), [agentSkills]),
      false,
      "realpath 落在受管根之外的东西仍然不算（不能把所有软链都当受管）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isSkillPathUnderRoots：worktree 软链里的项目技能算受管，用户目录外的路径不算", () => {
  const root = tempDir("pi-pathid-");
  try {
    const projectSkills = join(root, "project", ".pi", "skills");
    mkdirSync(join(projectSkills, "demo"), { recursive: true });
    const skillFile = join(projectSkills, "demo", "SKILL.md");
    writeFileSync(skillFile, "---\nname: demo\n---\n");
    const agentSkills = join(root, "agent", "skills");
    mkdirSync(agentSkills, { recursive: true });
    const worktree = join(root, "worktree");
    mkdirSync(worktree, { recursive: true });
    symlinkSync(join(root, "project", ".pi"), join(worktree, ".pi"), "dir");
    const viaLink = join(worktree, ".pi", "skills", "demo", "SKILL.md");

    const roots = [agentSkills, projectSkills];
    assert.equal(isSkillPathUnderRoots(viaLink, roots), true);
    assert.equal(isSkillPathUnderRoots(skillFile, roots), true);
    assert.equal(isSkillPathUnderRoots(join(agentSkills, "other", "SKILL.md"), roots), true);
    assert.equal(isSkillPathUnderRoots(join(root, "elsewhere", "SKILL.md"), roots), false);
    assert.equal(isSkillPathUnderRoots("", roots), false);
    assert.equal(isSkillPathUnderRoots(skillFile, []), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skillSourceForPath：字面路径优先（软链归入口那侧），realpath 只在字面都不命中时兜底", () => {
  const root = tempDir("pi-skillsource-");
  try {
    const builtin = join(root, "app", "skills");
    const piAgent = join(root, "pi", "skills");
    const agents = join(root, "agents", "skills");
    for (const dir of [join(builtin, "docx"), join(agents, "dws")]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\n");
    }
    // ~/.pi/agent/skills/lark-im 是指向 ~/.agents/skills/lark-im 的软链。
    mkdirSync(join(agents, "lark-im"), { recursive: true });
    writeFileSync(join(agents, "lark-im", "SKILL.md"), "---\nname: lark-im\n---\n");
    mkdirSync(piAgent, { recursive: true });
    symlinkSync(join(agents, "lark-im"), join(piAgent, "lark-im"), "dir");

    const roots = { builtin, piAgent, agents };
    assert.equal(skillSourceForPath(join(builtin, "docx", "SKILL.md"), roots), "builtin");
    assert.equal(skillSourceForPath(join(agents, "dws", "SKILL.md"), roots), "agents");
    assert.equal(
      skillSourceForPath(join(piAgent, "lark-im", "SKILL.md"), roots),
      "piAgent",
      "报的是软链那侧就归 piAgent；删它删掉的也只是那条软链",
    );
    // 项目根不在入参里：能力清单只含受管技能，落不到上面的路径一律回到旧的 project 行为。
    assert.equal(skillSourceForPath(join(root, "proj", ".pi", "skills", "jev", "SKILL.md"), roots), "project");
    assert.equal(skillSourceForPath("", roots), "project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isReadOnlySkillSource：内置与跨客户端只读，piAgent / project 可删", () => {
  assert.equal(isReadOnlySkillSource("builtin"), true);
  assert.equal(isReadOnlySkillSource("agents"), true);
  assert.equal(isReadOnlySkillSource("piAgent"), false);
  assert.equal(isReadOnlySkillSource("project"), false);
});
