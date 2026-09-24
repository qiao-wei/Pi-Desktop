/**
 * 能力资源的路径身份（`server/capabilityPathIdentity.mjs`）。
 *
 * 背景：worktree 会话里 `<worktree>/.pi` 是指向 `<project>/.pi` 的软链，pi 报的是软链那侧
 * 的路径，而能力清单算的是项目那侧。这一组用例就是要证明：两边按 realpath 对齐之后，
 * 「算不算同一个 extension」「skill 在不在受管根里」在两种写法下答案一致。
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
  isSkillPathUnderRoots,
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