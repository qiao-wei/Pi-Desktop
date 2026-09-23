/**
 * 「智能生成提交信息」的纯逻辑 + diff 上下文读取。
 *
 * 模型调用本身不在这里测（它要网络 + API key）；这里钉住三件事：
 * - prompt 真的把改动清单 / 补丁 / 新文件内容带上了，且语言跟随 UI 语言；
 * - 模型输出被收拾成一条可直接提交的信息（剥围栏、剥引号、剥「提交信息：」、压空行、限长）；
 * - `readCommitDiff` 只读选中路径的 diff，未跟踪文件单独摘录且二进制/超大文件跳过。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCommitMessagePrompt, normalizeGeneratedCommitMessage, MAX_GENERATED_COMMIT_MESSAGE_CHARS } from "../server/commitMessage.mjs";
import { readCommitDiff } from "../server/gitInfo.mjs";

/** 假 `execFile`：只认 status / diff HEAD / diff（空仓库退路）。 */
function fakeGit(plan) {
  const calls = [];
  const exec = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const key = args.join(" ");
    const result = plan[key] ?? (key.startsWith("status --porcelain=v2")
      ? { ok: true, stdout: STATUS }
      : { ok: true, stdout: "" });
    setImmediate(() => callback(result.ok ? null : Object.assign(new Error("git failed"), { code: result.code ?? 1 }), result.stdout ?? "", result.stderr ?? ""));
  };
  return { exec, calls };
}

const STATUS = `${[
  "# branch.head main",
  "1 .M N... 100644 100644 100644 aaa bbb src/app.ts",
  "2 R. N... 100644 100644 100644 eee fff R100 src/new.ts",
  "src/old.ts",
  "? fresh.txt",
  "u UU N... 100644 100644 100644 100644 ggg hhh iii src/conflict.ts",
].join("\u0000")}\u0000`;

/* ------------------------------------------------------------------ prompt */

test("prompt：带上改动清单、分支、补丁和新文件内容；语言跟随 UI", () => {
  const context = {
    branch: "main",
    files: [
      { path: "src/app.ts", origPath: "", status: "modified", staged: false, added: 3, removed: 1 },
      { path: "src/new.ts", origPath: "src/old.ts", status: "renamed", staged: true, added: 0, removed: 0 },
    ],
    patch: "diff --git a/src/app.ts b/src/app.ts\n+hello",
    patchTruncated: false,
    newFiles: [{ path: "fresh.txt", text: "hello\n", truncated: false }],
    skippedUntrackedDirs: [],
  };

  const zh = buildCommitMessagePrompt({ locale: "zh", context });
  assert.match(zh.systemPrompt, /中文提交信息/);
  assert.match(zh.userText, /改动清单：/);
  assert.match(zh.userText, /- \[modified\] src\/app\.ts \(\+3 −1\)/);
  assert.match(zh.userText, /- \[renamed\] src\/old\.ts → src\/new\.ts/);
  assert.match(zh.userText, /当前分支：main/);
  assert.match(zh.userText, /```diff\n[\s\S]*\+hello/);
  assert.match(zh.userText, /新文件 fresh\.txt：\n```\nhello\n```/);

  const en = buildCommitMessagePrompt({ locale: "en", context });
  assert.match(en.systemPrompt, /Git commit messages/);
  assert.match(en.userText, /Changed files:/);
  assert.match(en.userText, /Branch: main/);
  assert.ok(!/改动清单/.test(en.userText));

  // 未知语言当成英文，不能漏掉 systemPrompt。
  assert.equal(buildCommitMessagePrompt({ locale: "fr", context }).systemPrompt, en.systemPrompt);
});

test("prompt：二进制/超长新文件、未跟踪目录都只留一条说明", () => {
  const { userText } = buildCommitMessagePrompt({
    locale: "zh",
    context: {
      files: [{ path: "pkg/", origPath: "", status: "untracked", staged: false, added: 0, removed: 0 }],
      patch: "",
      newFiles: [{ path: "logo.png", text: "", truncated: true }],
      skippedUntrackedDirs: ["pkg/"],
    },
  });

  assert.match(userText, /新文件 logo\.png（内容过长或二进制，未展示）/);
  assert.match(userText, /未跟踪目录 pkg\/（内容未展示）/);
  assert.ok(!/```diff/.test(userText), "没有补丁时不要输出空的 diff 块");
});

/* ------------------------------------------------------------------ 输出规范化 */

test("规范化：剥代码围栏、引号、前缀，压掉多余空行", () => {
  assert.equal(normalizeGeneratedCommitMessage("  fix: 头部徽标  "), "fix: 头部徽标");
  assert.equal(normalizeGeneratedCommitMessage("```\nfix: a\n```"), "fix: a");
  assert.equal(normalizeGeneratedCommitMessage("```text\nfix: a\n\n- b\n```"), "fix: a\n\n- b");
  assert.equal(normalizeGeneratedCommitMessage('"fix: a"'), "fix: a");
  assert.equal(normalizeGeneratedCommitMessage("「fix: a」"), "fix: a");
  assert.equal(normalizeGeneratedCommitMessage("提交信息：fix: a"), "fix: a");
  assert.equal(normalizeGeneratedCommitMessage("Commit message: fix: a"), "fix: a");
  assert.equal(normalizeGeneratedCommitMessage("fix: a\n\n\n\n- b  \n"), "fix: a\n\n- b");
  assert.equal(normalizeGeneratedCommitMessage(""), "");
  assert.equal(normalizeGeneratedCommitMessage("   \n  "), "");
});

test("规范化：超长输出被截到上限", () => {
  const long = normalizeGeneratedCommitMessage("x".repeat(MAX_GENERATED_COMMIT_MESSAGE_CHARS + 500));
  assert.equal(long.length, MAX_GENERATED_COMMIT_MESSAGE_CHARS);
});

test("规范化：保留正文里的普通冒号，不误伤", () => {
  assert.equal(normalizeGeneratedCommitMessage("fix: 修复 a\n\n- 原因：b"), "fix: 修复 a\n\n- 原因：b");
});

/* ------------------------------------------------------------------ readCommitDiff */

test("readCommitDiff：只读选中路径的 diff，未跟踪文件单独摘录", async () => {
  const { exec, calls } = fakeGit({ "diff HEAD -- src/app.ts": { ok: true, stdout: "diff --git a/src/app.ts\n+hi" } });
  const context = await readCommitDiff("/tmp/repo", ["src/app.ts"], { execImpl: exec });

  assert.deepEqual(context.files.map((file) => file.path), ["src/app.ts"]);
  assert.match(context.patch, /\+hi/);
  assert.equal(context.patchTruncated, false);
  assert.deepEqual(context.newFiles, [], "没勾未跟踪文件就不读内容");
  // 未跟踪的 fresh.txt 不该出现在 diff 命令里（git diff HEAD 看不到它）。
  const patchCalls = calls.filter((call) => call.args.join(" ").startsWith("diff HEAD -- ")).map((call) => call.args);
  assert.deepEqual(patchCalls, [["diff", "HEAD", "--", "src/app.ts"]]);
});

test("readCommitDiff：没传 paths 时用全部非冲突改动", async () => {
  const { exec } = fakeGit({ "diff HEAD -- src/app.ts src/old.ts src/new.ts": { ok: true, stdout: "patch" } });
  const context = await readCommitDiff("/tmp/repo", [], { execImpl: exec });

  assert.deepEqual(context.files.map((file) => file.path), ["fresh.txt", "src/app.ts", "src/new.ts"]);
  assert.ok(!context.files.some((file) => file.path === "src/conflict.ts"), "冲突文件不进上下文");
  assert.deepEqual(context.skippedUntrackedDirs, []);
});

test("readCommitDiff：冲突路径 / 非改动路径 / 没改动 → 直接报错", async () => {
  const conflicted = fakeGit({});
  await assert.rejects(() => readCommitDiff("/tmp/repo", ["src/conflict.ts"], { execImpl: conflicted.exec }), /Resolve conflicts/);

  const unknown = fakeGit({});
  await assert.rejects(() => readCommitDiff("/tmp/repo", ["src/nope.ts"], { execImpl: unknown.exec }), /Not a changed file: src\/nope.ts/);

  const clean = fakeGit({ "status --porcelain=v2 --branch -z --untracked-files=normal": { ok: true, stdout: "# branch.head main\u0000" } });
  await assert.rejects(() => readCommitDiff("/tmp/repo", [], { execImpl: clean.exec }), /Nothing to describe/);
});

test("readCommitDiff：补丁超长被截断并标记", async () => {
  const { exec } = fakeGit({ "diff HEAD -- src/app.ts": { ok: true, stdout: "y".repeat(30000) } });
  const context = await readCommitDiff("/tmp/repo", ["src/app.ts"], { execImpl: exec });

  assert.equal(context.patchTruncated, true);
  assert.match(context.patch, /补丁已截断）/);
  assert.ok(context.patch.length < 30000);
});

test("readCommitDiff：真仓库里能拿到补丁和新文件内容（含二进制跳过）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-commit-msg-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(dir, "a.txt"), "a2\n");
  writeFileSync(join(dir, "fresh.txt"), "brand new\n");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3]));

  const context = await readCommitDiff(dir, ["a.txt", "fresh.txt", "bin.dat"]);

  assert.match(context.patch, /-a\n\+a2/, "补丁里有真实改动");
  assert.deepEqual(
    context.newFiles.map((file) => [file.path, file.text.trim(), file.truncated]),
    [
      ["bin.dat", "", true],
      ["fresh.txt", "brand new", false],
    ],
    "二进制新文件不把内容塞进 prompt",
  );
  assert.equal(context.branch, "main");
});