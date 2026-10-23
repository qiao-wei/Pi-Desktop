/**
 * `.agents/skills` 的发现规则 —— 与 pi 内核**对照**（parity）。
 *
 * pi 从 cwd 一路向上收集 `<dir>/.agents/skills` 直到 git 仓库根（没仓库就一直走到文件系统根），
 * 只在项目已信任时启用；用户那份 `~/.agents/skills` 单独作为用户级来源收。桌面侧要把这类技能
 * 算进受管根（能显示 / 能按会话开关 / 删除守卫拦得住），所以 `projectAgentsSkillRoots` 是那段
 * 遍历的手抄版。
 *
 * 手抄的东西必须自己会红：这组用例直接用 pi 的真 `DefaultResourceLoader` 加载一个临时仓库，
 * 然后拿**内核自己给出的路径与 `skill.sourceInfo`**去对桌面的分类结果。内核改了向上收集的
 * 规则（或改了 sourceInfo 的标注），这里立刻失败，而不是让能力页静默漏掉一整类技能。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

import {
  isPathInside,
  isReadOnlySkillSource,
  isSkillPathUnderRoots,
  projectAgentsSkillRoots,
  skillSourceForPath,
} from "../server/capabilityPathIdentity.mjs";
import { normalizeSkillDiagnostics } from "../server/capabilitySkillDiagnostics.mjs";

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pi-agents-skills-"));
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main", "."], { stdio: "pipe" });
  return dir;
}

function seedSkill(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: from ${name}\n---\n\nbody of ${name}\n`,
  );
}

/** 用 pi 自己的 loader 加载（resolveProjectTrust 决定项目的 `.agents` 见不见得到）。 */
async function loadSkills({ cwd, projectDir, agentDir, trusted }) {
  const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload({ resolveProjectTrust: async () => trusted });
  return loader.getSkills().skills;
}

function withTmp(t, fn) {
  const repo = createRepo();
  const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-agent-"));
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });
  return fn({ repo, agentDir });
}

test("pi 加载祖先目录里的 .agents/skills；桌面的根列表正好覆盖内核报出来的路径", async (t) => {
  await withTmp(t, async ({ repo, agentDir }) => {
    // 仓库根一层、中间一层；cwd 在更深的应用子目录里（真实 monorepo 的样子）。
    seedSkill(join(repo, ".agents", "skills", "root-skill"), "root-skill");
    seedSkill(join(repo, "packages", ".agents", "skills", "mid-skill"), "mid-skill");
    const cwd = join(repo, "packages", "app");
    mkdirSync(cwd, { recursive: true });

    const skills = await loadSkills({ cwd, projectDir: repo, agentDir, trusted: true });
    const loaded = skills.filter(
      (skill) => skill.name === "root-skill" || skill.name === "mid-skill",
    );
    assert.deepEqual(
      loaded.map((skill) => skill.name).sort(),
      ["mid-skill", "root-skill"],
      "pi 必须仍然向上收集 .agents/skills（内核规则变了就要同步改 projectAgentsSkillRoots）",
    );

    const userAgentsSkills = join(homedir(), ".agents", "skills");
    const roots = projectAgentsSkillRoots(cwd, homedir());
    assert.ok(roots.includes(join(cwd, ".agents", "skills")), "cwd 自己那一层要在");
    assert.ok(roots.includes(join(repo, "packages", ".agents", "skills")), "祖先那一层要在");
    assert.ok(roots.includes(join(repo, ".agents", "skills")), "仓库根那一层要在");
    assert.ok(
      roots.every((root) => isPathInside(repo, root)),
      "遍历必须在 git 仓库根停下（内核就是这么停的）",
    );

    // **对照**：内核自己报的 `scope` 就是分类依据，桌面那份手抄的遍历必须和它一致。
    // 内核填的是 `{source: "auto", scope, baseDir} `—— `source` 对自动发现（含 `.pi/skills`）
    // 一律是 "auto"，真正区分来源的是 `scope` + `baseDir` 的目录约定。
    let checked = 0;
    for (const skill of skills) {
      const info = skill.sourceInfo ?? {};
      if (info.origin !== "top-level" || basename(info.baseDir ?? "") !== ".agents") {
        continue;
      }
      const source = skillSourceForPath(skill.filePath, {
        agents: userAgentsSkills,
        projectAgents: roots,
      });
      assert.equal(
        source,
        info.scope === "user" ? "agents" : "projectAgents",
        `${skill.name}（scope=${info.scope}）的分类必须和内核的 scope 对上`,
      );
      assert.equal(
        isSkillPathUnderRoots(skill.filePath, [userAgentsSkills, ...roots]),
        true,
        `${skill.name} 必须算受管`,
      );
      checked += 1;
    }
    assert.ok(checked >= 2, "至少要覆盖项目里的两层 .agents/skills");
    assert.equal(
      isReadOnlySkillSource("projectAgents"),
      true,
      "项目 .agents/skills 也是跨客户端共享目录：只读",
    );
  });
});

test("重名技能的诊断：内核报 collision，我们搬的那个形状对得上（且输的那份真没被加载）", async (t) => {
  await withTmp(t, async ({ repo, agentDir }) => {
    // 同名两个技能：pi 保留先发现的（`a`），把后来的当 collision 诊断扔掉。
    seedSkill(join(repo, ".pi", "skills", "a", "dup"), "dup");
    seedSkill(join(repo, ".pi", "skills", "b", "dup"), "dup");
    seedSkill(join(repo, ".pi", "skills", "uniq-skill"), "uniq-skill");

    const settingsManager = SettingsManager.create(repo, agentDir, { projectTrusted: false });
    const loader = new DefaultResourceLoader({ cwd: repo, agentDir, settingsManager });
    await loader.reload({ resolveProjectTrust: async () => true });
    const raw = loader.getSkills();

    const loaded = raw.skills.filter((skill) => skill.name === "dup");
    assert.equal(loaded.length, 1, "同名只留一份");
    assert.ok(
      raw.diagnostics.some((diagnostic) => diagnostic.type === "collision"),
      "pi 仍然用 collision 诊断说明这件事（丢了它用户只看到技能不见了）",
    );

    const normalized = normalizeSkillDiagnostics(raw.diagnostics);
    const collision = normalized.find((diagnostic) => diagnostic.type === "collision");
    assert.ok(collision, "搬运后的诊断里必须有 collision");
    assert.match(collision.message, /collision/);
    assert.equal(collision.collision?.name, "dup");
    assert.equal(collision.collision?.winnerPath, loaded[0].filePath, "winner 就是真被加载的那份");
    assert.equal(collision.path, collision.collision?.loserPath, "诊断的 path 是输掉的那份");
    assert.notEqual(collision.collision?.loserPath, collision.collision?.winnerPath);
    // 赢家那份是真加载了吗？
    assert.ok(loaded[0].filePath.includes("/skills/a/dup/"), "先发现的 a 才是赢家");
  });
});

test("normalizeSkillDiagnostics：空/缺字段不产生空告警，路径可选", () => {
  assert.deepEqual(normalizeSkillDiagnostics(undefined), []);
  assert.deepEqual(normalizeSkillDiagnostics([{ type: "warning", message: "   " }]), []);
  assert.deepEqual(
    normalizeSkillDiagnostics([{ message: "frontmatter 缺 name", path: "/x/SKILL.md" }]),
    [{ type: "warning", message: "frontmatter 缺 name", path: "/x/SKILL.md", collision: null }],
  );
});

test("未信任的项目：pi 不加载 .agents/skills（根列表只认身份，不是加载清单）", async (t) => {
  await withTmp(t, async ({ repo, agentDir }) => {
    seedSkill(join(repo, ".agents", "skills", "root-skill"), "root-skill");
    const cwd = join(repo, "packages", "app");
    mkdirSync(cwd, { recursive: true });

    const skills = await loadSkills({ cwd, projectDir: repo, agentDir, trusted: false });
    assert.equal(
      skills.some((skill) => skill.name === "root-skill"),
      false,
      "未信任时内核不读项目的 .agents/skills",
    );
    // 桌面侧仍然认得这个路径（它是受管的、只读的），只是内核不会把它加载出来。
    assert.equal(
      isSkillPathUnderRoots(
        join(repo, ".agents", "skills", "root-skill", "SKILL.md"),
        projectAgentsSkillRoots(cwd, homedir()),
      ),
      true,
    );
  });
});

test("用户那份 ~/.agents/skills 永远不会被算成项目根", () => {
  const home = "/home/someone";
  const repo = "/work/repo";
  const roots = projectAgentsSkillRoots(join(repo, "packages", "app"), home);
  assert.equal(roots.includes(join(home, ".agents", "skills")), false);
  assert.equal(
    projectAgentsSkillRoots(home, home).includes(join(home, ".agents", "skills")),
    false,
  );
  // 连 cwd 就在 home 下时也不能把它加回来（否则用户那份会被当项目级、拿错来源标签）。
  assert.equal(resolve(roots[0] ?? "") === resolve(join(home, ".agents", "skills")), false);
});

test("分类顺序：用户 agents 目录优先于项目根，软链侧仍按字面路径归 piAgent", () => {
  const userAgents = join("/home/someone", ".agents", "skills");
  const projectRoots = [join("/work/repo", ".agents", "skills")];

  // 同一个路径两边都命中时不能抖：agents 在前，projectAgents 在后。
  assert.equal(
    skillSourceForPath(join(userAgents, "grill-me", "SKILL.md"), {
      agents: userAgents,
      projectAgents: projectRoots,
    }),
    "agents",
  );
  // `~/.pi/agent/skills/x` 指向跨客户端目录时，pi 报的是软链那侧 → 归 piAgent（删掉的只是软链）。
  assert.equal(
    skillSourceForPath(join("/home/someone", ".pi", "agent", "skills", "x", "SKILL.md"), {
      piAgent: join("/home/someone", ".pi", "agent", "skills"),
      agents: userAgents,
      projectAgents: projectRoots,
    }),
    "piAgent",
  );
});
