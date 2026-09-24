/**
 * worktree 会话真的能复用项目 skills / packages —— 端到端用 pi 自己的 loader 验。
 *
 * 前面几组用例分别钉住了「软链建好没」「路径身份按 realpath 算没」，但真正的承诺是这一条：
 * 在 worktree 目录里用 pi 的 `DefaultResourceLoader` 加载，项目根的 `.pi/skills` 和
 * **相对源**的项目包里的 skill 都出得来，且和项目会话看到的是同一份。
 *
 * 相对源项目包是关键用例：它只能靠「worktree 的 `.pi` 就是项目那份」解决 —— 单纯把项目
 * 资源路径注入给 pi（不建链）救不了它，因为 pi 是按 `join(cwd, '.pi')` 解析相对源的。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

import { createManagedWorktree, linkProjectPiIntoWorktree } from "../server/gitWorktree.mjs";
import { isWorktreePiLink } from "../server/worktreePiLink.mjs";

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-res-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], {
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, git };
}

/** 项目根的 `.pi`：一个项目技能 + 一个相对源本地包（包内一个技能）。 */
function seedProjectPi(repoDir) {
  mkdirSync(join(repoDir, ".pi", "skills", "proj-skill"), { recursive: true });
  writeFileSync(join(repoDir, ".pi", "skills", "proj-skill", "SKILL.md"), "---\nname: proj-skill\ndescription: from project\n---\n");
  const pkg = join(repoDir, ".pi", "local-pkg");
  mkdirSync(join(pkg, "skills", "pkg-skill"), { recursive: true });
  writeFileSync(join(pkg, "skills", "pkg-skill", "SKILL.md"), "---\nname: pkg-skill\ndescription: from package\n---\n");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "local-pkg", version: "1.0.0", pi: { skills: ["skills"] } }));
  writeFileSync(join(repoDir, ".pi", "settings.json"), JSON.stringify({ packages: [{ source: "./local-pkg", autoload: true }] }));
}

async function loadSkillNames({ cwd, projectDir, agentDir }) {
  const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload({ resolveProjectTrust: async () => true });
  return loader.getSkills().skills.map((skill) => skill.name);
}

test("worktree 会话经软链看到与项目会话相同的项目技能与相对源包技能", async () => {
  const repo = createRepo();
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-root-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-worktree-agent-"));
  try {
    seedProjectPi(repo.dir);
    const created = await createManagedWorktree(repo.dir, { root, id: "app-res" });
    assert.equal(created.piLink.reason, "linked");
    assert.equal(isWorktreePiLink(created.path), true);
    assert.equal(existsSync(join(created.path, ".pi", "local-pkg", "package.json")), true, "包也能从 worktree 侧读到");

    const fromProject = await loadSkillNames({ cwd: repo.dir, projectDir: repo.dir, agentDir });
    const fromWorktree = await loadSkillNames({ cwd: created.path, projectDir: repo.dir, agentDir });

    for (const name of ["proj-skill", "pkg-skill"]) {
      assert.ok(fromProject.includes(name), `项目会话应看到 ${name}`);
      assert.ok(fromWorktree.includes(name), `worktree 会话应看到 ${name}`);
      assert.equal(
        fromWorktree.filter((item) => item === name).length,
        1,
        `${name} 在 worktree 里不能重复（软链侧 + 显式注入会撞名）`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("项目还没有 .pi 时 worktree 不建链；项目随后出现 .pi，重链后能力补齐", async () => {
  const repo = createRepo();
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-root-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-worktree-agent-"));
  try {
    const created = await createManagedWorktree(repo.dir, { root, id: "app-late" });
    assert.equal(created.piLink.reason, "no-project-pi");
    assert.equal(isWorktreePiLink(created.path), false);

    // 建完 worktree 之后才装的项目技能：开会话/重载时补链（这里直接调同一个入口）。
    seedProjectPi(repo.dir);
    assert.deepEqual(linkProjectPiIntoWorktree(repo.dir, created.path), { linked: true, reason: "linked" });

    const names = await loadSkillNames({ cwd: created.path, projectDir: repo.dir, agentDir });
    assert.ok(names.includes("proj-skill"));
    assert.ok(names.includes("pkg-skill"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
});