/**
 * 单文件 diff（右侧「改动 / Review」面板与预览 tab 的数据源）。
 *
 * 分两层，和 `gitInfo.test.ts` 一样：
 * - 拼 argv 与解析补丁的部分是纯函数，直接对输入输出断言（含空值 / 未知来源这些边界）；
 * - `readFileDiff` 用注入的假 `execFile` 跑，不依赖机器上有没有 git，也不依赖真仓库。
 *
 * 假 execFile 的路由顺序就是真实调用顺序：先 `status` 问这个路径是什么（未跟踪 / 冲突），
 * 再 `diff` 拿正文，最后按来源读 before/after 两侧的 blob 与工作区文件。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_DIFF_SOURCE,
  DIFF_TIMEOUT_MS,
  GIT_DIFF_SOURCES,
  buildDiffArgs,
  buildUntrackedPatch,
  countPatchLines,
  diffSourceMessageId,
  isBinaryDiff,
  isKnownDiffSource,
  listSourceFiles,
  normalizeDiffSource,
  parseNameStatusZ,
  readFileDiff,
  splitUntrackedText,
  toPatchPath,
} from "../server/workspaceDiff.mjs";
import { isReadOnlyGitArgs, runReadOnlyGit } from "../server/gitInfo.mjs";

/** 假 `execFile`：记录调用，按 argv 返回计划好的结果（callback 风格，和真的一样）。 */
function fakeExecFile(plan) {
  const calls = [];
  const exec = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const result = plan(args, options) ?? { ok: false, code: 1, stdout: "", stderr: "unexpected git call" };
    setImmediate(() => {
      const error = result.ok ? null : Object.assign(new Error("git failed"), { code: result.code ?? 1, killed: false });
      callback(error, result.stdout ?? "", result.stderr ?? "");
    });
  };

  return { exec, calls };
}

/** 跟踪中的普通改动条目。`XY` 第一位是 index 侧，第二位是工作区侧。 */
function porcelainOrdinary(path, xy = ".M") {
  return `1 ${xy} N... 100644 100644 100644 1111111 2222222 ${path}`;
}

function porcelainUntracked(path) {
  return `? ${path}`;
}

function porcelainConflicted(path) {
  return `u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 ${path}`;
}

/** `status --porcelain=v2 -z` 的输出：条目之间用 NUL 分隔，`-z` 下没有结尾换行。 */
function statusOutput(...chunks) {
  return chunks.length === 0 ? "" : `${chunks.join("\u0000")}\u0000`;
}

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "",
].join("\n");

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/* ------------------------------------------------------------------ 来源归一 */

test("来源只认三个 git 值；空值 / null / 未知值一律回落到 unstaged", () => {
  for (const source of GIT_DIFF_SOURCES) {
    assert.equal(isKnownDiffSource(source), true);
    assert.equal(normalizeDiffSource(source), source);
  }

  for (const value of [undefined, null, "", "unstaged ", "STAGED", "last-turn", "head", 42, {}]) {
    assert.equal(isKnownDiffSource(value), false, `不该认成来源: ${String(value)}`);
    assert.equal(normalizeDiffSource(value), DEFAULT_DIFF_SOURCE, `应回落到 ${DEFAULT_DIFF_SOURCE}`);
  }
});

test("last-turn 不是 git 来源：它的 diff 由对话侧派生，不走本模块", () => {
  assert.equal(GIT_DIFF_SOURCES.includes("last-turn"), false);
  assert.equal(normalizeDiffSource("last-turn"), DEFAULT_DIFF_SOURCE);
});

test("来源文案 key 跟着归一后的值走", () => {
  assert.equal(diffSourceMessageId("unstaged"), "git.source.unstaged");
  assert.equal(diffSourceMessageId("staged"), "git.source.staged");
  assert.equal(diffSourceMessageId("branch"), "git.source.branch");
  assert.equal(diffSourceMessageId("last-turn"), "git.source.unstaged");
  assert.equal(diffSourceMessageId(undefined), "git.source.unstaged");
});

/* ------------------------------------------------------------------ argv */

test("diff argv 永远带上禁外部工具 / 禁彩色 / 二进制这三件套", () => {
  for (const source of GIT_DIFF_SOURCES) {
    const args = buildDiffArgs({ source, path: "src/a.ts", base: "origin/main" });
    assert.equal(args[0], "diff");
    assert.equal(args.includes("--no-ext-diff"), true, `${source}: 用户配了 diff.external 会拿到自定义输出`);
    assert.equal(args.includes("--no-color"), true, `${source}: color.ui=always 会塞进 ANSI 转义`);
    assert.equal(args.includes("--binary"), true, `${source}: 二进制要能被识别出来`);
    assert.deepEqual(args.slice(-2), ["--", "src/a.ts"], "路径必须走 `--` 之后，`-` 开头的文件名才安全");
  }
});

test("unstaged / staged 只差一个 --cached，其余一致", () => {
  const unstaged = buildDiffArgs({ source: "unstaged", path: "src/a.ts" });
  const staged = buildDiffArgs({ source: "staged", path: "src/a.ts" });

  assert.equal(unstaged.includes("--cached"), false);
  assert.equal(staged.includes("--cached"), true);
  assert.deepEqual(staged.filter((arg) => arg !== "--cached"), unstaged);
});

test("branch 用三个点（分叉点→HEAD），不是两个点", () => {
  const args = buildDiffArgs({ source: "branch", path: "src/a.ts", base: "origin/main" });

  assert.equal(args.includes("origin/main...HEAD"), true, "两个点会把上游新提交算成我们的反向改动");
  assert.equal(args.includes("--find-renames"), true, "分支对比才需要跟着重命名（与 ZCode 对齐）");
  assert.deepEqual(args.slice(-2), ["--", "src/a.ts"]);
});

test("缺 path / 分支缺 base 直接抛，不拼出半截命令", () => {
  assert.throws(() => buildDiffArgs({ source: "unstaged", path: "  " }), /without a path/);
  assert.throws(() => buildDiffArgs({ source: "branch", path: "src/a.ts", base: "  " }), /needs a base ref/);
});

test("新增的 merge-base 进了只读白名单，写命令仍然进不来", () => {
  assert.equal(isReadOnlyGitArgs(["merge-base", "origin/main", "HEAD"]), true);
  assert.equal(isReadOnlyGitArgs(["diff", "--no-ext-diff", "--no-color", "--binary", "--", "a.ts"]), true);
  assert.equal(isReadOnlyGitArgs(["show", ":src/a.ts"]), true);
  assert.equal(isReadOnlyGitArgs(["commit", "-m", "x"]), false);
  assert.equal(isReadOnlyGitArgs(["checkout", "main"]), false);
});

test("runReadOnlyGit 把 cwd 放在 spawn 选项里，diff 也不会拼进 argv", async () => {
  const { exec, calls } = fakeExecFile(() => ({ ok: true, stdout: "" }));
  await runReadOnlyGit("/tmp/my project", ["diff", "--", "src/a.ts"], { execImpl: exec });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["diff", "--", "src/a.ts"]);
  assert.equal(calls[0].options.cwd, "/tmp/my project");
  assert.equal(calls[0].options.timeout, 5000);
});

/* ------------------------------------------------------------------ 补丁解析 */

test("二进制补丁的两种措辞都能认出来", () => {
  assert.equal(isBinaryDiff("Binary files a/logo.png and b/logo.png differ\n"), true);
  assert.equal(isBinaryDiff("diff --git a/x.bin b/x.bin\nGIT binary patch\n"), true);
  assert.equal(isBinaryDiff(PATCH), false);
  assert.equal(isBinaryDiff(""), false);
  assert.equal(isBinaryDiff(undefined), false);
});

test("数增删行：文件头 / 块头 / No newline 标记都不算", () => {
  assert.deepEqual(countPatchLines(PATCH), { added: 2, removed: 1 });

  assert.deepEqual(
    countPatchLines(
      ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old", "+new", "\\ No newline at end of file", ""].join("\n"),
    ),
    { added: 1, removed: 1 },
  );

  // 只有上下文行的补丁（纯重命名 / 纯模式变更）增删都是 0。
  assert.deepEqual(countPatchLines("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n same\n same\n"), { added: 0, removed: 0 });
  assert.deepEqual(countPatchLines(""), { added: 0, removed: 0 });
});

test("未跟踪文本切分：空串、单行无换行、多行、末尾空行", () => {
  assert.deepEqual(splitUntrackedText(""), { lines: [], hasTrailingNewline: true });
  assert.deepEqual(splitUntrackedText("only"), { lines: ["only"], hasTrailingNewline: false });
  assert.deepEqual(splitUntrackedText("a\nb\n"), { lines: ["a", "b"], hasTrailingNewline: true });
  assert.deepEqual(splitUntrackedText("a\nb"), { lines: ["a", "b"], hasTrailingNewline: false });
  // 末尾空行是真实的一行，不能被 for 掉。
  assert.deepEqual(splitUntrackedText("a\n\n"), { lines: ["a", ""], hasTrailingNewline: true });
});

test("未跟踪补丁：只保留 ---/+++ / @@ 三段，不带平台相关的 diff --git 头", () => {
  const built = buildUntrackedPatch({ path: "src/new.ts", content: "export const a = 1;\n" });

  assert.equal(built.availability, "patch");
  assert.equal(built.patch.includes("diff --git"), false, "diff --git 头的格式差异会让渲染器抛异常");
  assert.deepEqual(built.patch.trimEnd().split("\n"), [
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,1 @@",
    "+export const a = 1;",
  ]);
  assert.equal(built.beforeContent, "", "新增文件的左侧是真的空，不是读失败");
  assert.equal(built.afterContent, "export const a = 1;\n");
  assert.deepEqual([built.added, built.removed], [1, 0]);
});

test("未跟踪补丁：空文件只有头部，没有 @@（空文件不该伪造一个块）", () => {
  const built = buildUntrackedPatch({ path: "src/empty.ts", content: "" });

  assert.deepEqual(built.patch.trimEnd().split("\n"), ["--- /dev/null", "+++ b/src/empty.ts"]);
  assert.deepEqual([built.added, built.removed], [0, 0]);
});

test("未跟踪补丁：末行没有换行要显式标出来", () => {
  const built = buildUntrackedPatch({ path: "a.txt", content: "no newline" });

  assert.equal(built.patch.endsWith("\\ No newline at end of file\n"), true);
  assert.equal(built.patch.includes("+no newline"), true);
});

test("补丁头部路径要相对化并归一：绝对路径、反斜杠、仓库外路径", () => {
  assert.equal(toPatchPath("src/a.ts", "/repo"), "src/a.ts");
  assert.equal(toPatchPath("/repo/src/a.ts", "/repo"), "src/a.ts");
  assert.equal(toPatchPath("src\\win\\a.ts", "/repo"), "src/win/a.ts");
  assert.equal(toPatchPath("/outside/a.ts", "/repo"), "/outside/a.ts", "仓库外保留原样，不要伪造一个 ../ 路径");
  assert.equal(toPatchPath("", "/repo"), "");
});

/* ------------------------------------------------------------------ readFileDiff */

test("readFileDiff 缺项目目录 / 缺路径都直接抛", async () => {
  const { exec } = fakeExecFile(() => ({ ok: true, stdout: "" }));

  await assert.rejects(() => readFileDiff({ cwd: "  ", path: "src/a.ts", execImpl: exec }), /project folder/);
  await assert.rejects(() => readFileDiff({ cwd: "/repo", path: "  ", execImpl: exec }), /without a path/);
});

test("未暂存改动：patch 正文 + 增删计数 + 左侧取 index（不是 HEAD）", async () => {
  const repo = tempDir("piwsd-unstaged-");
  writeFileSync(join(repo, "a.ts"), "const a = 1;\nconst b = 3;\n");

  const { exec, calls } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: statusOutput(porcelainOrdinary("a.ts")) };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: PATCH };
    }
    if (args[0] === "show") {
      return { ok: true, stdout: "const a = 1;\nconst b = 2;\nconst d = 5;\n" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: repo, path: "a.ts", source: "unstaged", execImpl: exec });

  assert.equal(diff.availability, "patch");
  assert.equal(diff.source, "unstaged");
  assert.equal(diff.path, "a.ts", "path 原样回给调用方，UI 靠它对齐行");
  assert.equal(diff.patch, PATCH);
  assert.deepEqual([diff.added, diff.removed], [2, 1]);
  assert.equal(diff.beforeContent, "const a = 1;\nconst b = 2;\nconst d = 5;\n");
  assert.equal(diff.afterContent, "const a = 1;\nconst b = 3;\n");
  assert.equal(diff.summary, null);

  const showCall = calls.find((call) => call.args[0] === "show");
  assert.deepEqual(showCall.args, ["show", ":a.ts"], "未暂存的左侧是 index；用 HEAD 会重复算上已 add 的改动");
  assert.equal(showCall.options.timeout, DIFF_TIMEOUT_MS, "diff 有自己的超时，比状态徽标的 5s 宽");

  rmSync(repo, { recursive: true, force: true });
});

test("已暂存改动：argv 带 --cached，两侧分别是 HEAD 与 index", async () => {
  const repo = tempDir("piwsd-staged-");

  const { exec, calls } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: statusOutput(porcelainOrdinary("a.ts", "M.")) };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: PATCH };
    }
    if (args[0] === "show") {
      return args[1] === "HEAD:a.ts"
        ? { ok: true, stdout: "old\n" }
        : { ok: true, stdout: "new\n" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: repo, path: "a.ts", source: "staged", execImpl: exec });

  assert.equal(diff.availability, "patch");
  assert.equal(diff.beforeContent, "old\n");
  assert.equal(diff.afterContent, "new\n", "已暂存 = HEAD → index，不是工作区");

  const diffCall = calls.find((call) => call.args[0] === "diff");
  assert.equal(diffCall.args.includes("--cached"), true);

  rmSync(repo, { recursive: true, force: true });
});

test("未跟踪文件：git diff 没有输出，改成合成整篇新增的补丁", async () => {
  const repo = tempDir("piwsd-untracked-");
  writeFileSync(join(repo, "new.ts"), "export const a = 1;\nexport const b = 2;\n");

  const { exec, calls } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: statusOutput(porcelainUntracked("new.ts")) };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: "" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: repo, path: "new.ts", execImpl: exec });

  assert.equal(diff.availability, "patch");
  assert.equal(diff.patch.includes("--- /dev/null"), true);
  assert.equal(diff.patch.includes("+++ b/new.ts"), true);
  assert.equal(diff.patch.includes("@@ -0,0 +1,2 @@"), true);
  assert.equal(diff.beforeContent, "");
  assert.equal(diff.afterContent, "export const a = 1;\nexport const b = 2;\n");
  assert.deepEqual([diff.added, diff.removed], [2, 0]);
  assert.equal(diff.summary, null);

  // 未跟踪文件的判定的确用上了显式的 --untracked-files：用户配成 no 时会静默走不到这条路。
  const statusCall = calls.find((call) => call.args[0] === "status");
  assert.equal(statusCall.args.includes("--untracked-files=normal"), true);
  assert.deepEqual(statusCall.args.slice(-2), ["--", "new.ts"]);

  rmSync(repo, { recursive: true, force: true });
});

test("未跟踪的二进制文件：不合成补丁，直接说不可预览", async () => {
  const repo = tempDir("piwsd-untracked-bin-");
  writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

  const { exec } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: statusOutput(porcelainUntracked("logo.png")) };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: "" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: repo, path: "logo.png", execImpl: exec });

  assert.equal(diff.availability, "binary");
  assert.equal(diff.patch, null);
  assert.equal(diff.beforeContent, null);
  assert.equal(diff.afterContent, null);
  assert.match(diff.summary, /Binary/i);

  rmSync(repo, { recursive: true, force: true });
});

test("冲突文件：别去渲染组合 diff，直接让人去解冲突", async () => {
  const { exec, calls } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: statusOutput(porcelainConflicted("a.ts")) };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: "/repo", path: "a.ts", execImpl: exec });

  assert.equal(diff.availability, "unavailable");
  assert.equal(diff.patch, null);
  assert.match(diff.summary, /[Cc]onflict/);
  assert.equal(
    calls.some((call) => call.args[0] === "diff"),
    false,
    "冲突态连 diff 都不该跑：组合 diff 两个父版本，渲染出来是错的",
  );
});

test("跟踪中的二进制改动：availability=binary，patch 置空", async () => {
  const { exec } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: statusOutput(porcelainOrdinary("logo.png")) };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: "Binary files a/logo.png and b/logo.png differ\n" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: "/repo", path: "logo.png", execImpl: exec });

  assert.equal(diff.availability, "binary");
  assert.equal(diff.patch, null);
  assert.deepEqual([diff.added, diff.removed], [0, 0]);
});

test("补丁超过上限：判成 truncated 而不是把 MB 级正文塞给渲染层", async () => {
  const huge = `--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1,1 @@\n+${"x".repeat(2048)}\n`;
  const { exec } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: statusOutput(porcelainOrdinary("big.txt")) };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: huge };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: "/repo", path: "big.txt", execImpl: exec, maxPatchBytes: 1024 });

  assert.equal(diff.availability, "truncated");
  assert.equal(diff.patch, null, "截断态不给正文，UI 只显示一句原因（与 ZCode 一致）");
  assert.match(diff.summary, /preview limit/);
});

test("maxBuffer 溢出也是 truncated：stdout 是有效前缀，不是失败", async () => {
  const { exec } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: "" };
    }
    if (args[0] === "diff") {
      return { ok: false, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "--- a/x\n", stderr: "" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: "/repo", path: "x.txt", execImpl: exec });

  assert.equal(diff.availability, "truncated");
  assert.equal(diff.patch, null);
});

test("空输出 + 文件不存在：说 missing，不要谎报 no changes", async () => {
  const repo = tempDir("piwsd-missing-");
  const { exec } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: "" };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: "" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: repo, path: "gone.ts", execImpl: exec });

  assert.equal(diff.availability, "unavailable");
  assert.match(diff.summary, /missing/i);

  rmSync(repo, { recursive: true, force: true });
});

test("空输出 + 文件存在：就是没有改动", async () => {
  const repo = tempDir("piwsd-clean-");
  writeFileSync(join(repo, "a.ts"), "const a = 1;\n");

  const { exec } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: "" };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: "" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: repo, path: "a.ts", execImpl: exec });

  assert.equal(diff.availability, "unavailable");
  assert.match(diff.summary, /No changes/);

  rmSync(repo, { recursive: true, force: true });
});

test("完整内容对一起降级：工作区读不到时 before/after 都置 null，但 patch 照样保留", async () => {
  const repo = tempDir("piwsd-nocontent-");
  // 故意不写工作区文件：模拟"编辑器原子保存的中间窗口 / 文件刚被删掉"。
  const { exec } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: statusOutput(porcelainOrdinary("a.ts")) };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: PATCH };
    }
    if (args[0] === "show") {
      return { ok: true, stdout: "old\n" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: repo, path: "a.ts", execImpl: exec });

  assert.equal(diff.availability, "patch");
  assert.equal(diff.patch, PATCH);
  assert.equal(diff.beforeContent, null, "补空串会把'读不到'渲染成'空文件'，整篇画成新增");
  assert.equal(diff.afterContent, null);

  rmSync(repo, { recursive: true, force: true });
});

test("分支来源：先解析上游，before 取分叉点的 blob", async () => {
  const { exec, calls } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: statusOutput(porcelainOrdinary("a.ts")) };
    }
    if (args[0] === "rev-parse") {
      return { ok: true, stdout: "origin/main\n" };
    }
    if (args[0] === "merge-base") {
      return { ok: true, stdout: "abc1234\n" };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: PATCH };
    }
    if (args[0] === "show") {
      return args[1].startsWith("abc1234:") ? { ok: true, stdout: "base\n" } : { ok: true, stdout: "head\n" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: "/repo", path: "a.ts", source: "branch", execImpl: exec });

  assert.equal(diff.availability, "patch");
  assert.equal(diff.beforeContent, "base\n");
  assert.equal(diff.afterContent, "head\n");

  const diffCall = calls.find((call) => call.args[0] === "diff");
  assert.equal(diffCall.args.includes("origin/main...HEAD"), true);
  assert.equal(calls.some((call) => call.args[0] === "merge-base"), true);
});

test("分支来源没有上游：不跑 diff，直接说清楚为什么没得比", async () => {
  const { exec, calls } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: "" };
    }
    if (args[0] === "rev-parse") {
      return { ok: false, code: 128, stdout: "", stderr: "fatal: no upstream configured\n" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: "/repo", path: "a.ts", source: "branch", execImpl: exec });

  assert.equal(diff.availability, "unavailable");
  assert.match(diff.summary, /upstream/i);
  assert.equal(calls.some((call) => call.args[0] === "diff"), false);
});

test("分支来源显式给 base 时不再去问上游", async () => {
  const { exec, calls } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: "" };
    }
    if (args[0] === "merge-base") {
      return { ok: true, stdout: "" };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: PATCH };
    }
    if (args[0] === "show") {
      return { ok: true, stdout: "x\n" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: "/repo", path: "a.ts", source: "branch", base: "main", execImpl: exec });

  assert.equal(diff.availability, "patch");
  assert.equal(calls.some((call) => call.args[0] === "rev-parse"), false);
  assert.equal(calls.find((call) => call.args[0] === "diff").args.includes("main...HEAD"), true);
});

test("越界路径 fail fast：不读工作区外的文件，连 git 都不跑", async () => {
  const { exec, calls } = fakeExecFile(() => ({ ok: true, stdout: PATCH }));

  for (const path of ["../outside.ts", "src/../../outside.ts", "/etc/passwd"]) {
    const diff = await readFileDiff({ cwd: "/repo", path, execImpl: exec });

    assert.equal(diff.availability, "unavailable", `${path} 不该拿到 diff`);
    assert.equal(diff.beforeContent, null);
    assert.equal(diff.afterContent, null);
    assert.match(diff.summary, /outside the project/i);
  }

  assert.equal(calls.length, 0, "越界路径一条 git 命令都不该发出去");
});

test("项目内的绝对路径照样能用（调用方可能只有绝对路径）", async () => {
  const { exec } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: statusOutput(porcelainOrdinary("a.ts")) };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: PATCH };
    }
    if (args[0] === "show") {
      return { ok: true, stdout: "x\n" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: "/repo", path: "/repo/a.ts", execImpl: exec });

  assert.equal(diff.availability, "patch");
  assert.equal(diff.path, "/repo/a.ts", "path 原样回给调用方");
});

test("diff 命令失败：原文进 summary，不吞成 no changes", async () => {
  const { exec } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: true, stdout: "" };
    }
    if (args[0] === "diff") {
      return { ok: false, code: 128, stdout: "", stderr: "fatal: bad revision 'HEAD'\n" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: "/repo", path: "a.ts", execImpl: exec });

  assert.equal(diff.availability, "unavailable");
  assert.match(diff.summary, /bad revision/);
});

test("status 失败不连累 diff：只是不知道它是不是未跟踪", async () => {
  const { exec } = fakeExecFile((args) => {
    if (args[0] === "status") {
      return { ok: false, code: 128, stdout: "", stderr: "fatal: not a git repository\n" };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: PATCH };
    }
    if (args[0] === "show") {
      return { ok: true, stdout: "old\n" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const diff = await readFileDiff({ cwd: "/repo", path: "a.ts", execImpl: exec });

  assert.equal(diff.availability, "patch");
  assert.equal(diff.patch, PATCH);
});
test("--name-status -z 解析：A/M/D/R 各自的状态，重命名占两个路径", () => {
  const output = [
    "M",
    "src/a.ts",
    "A",
    "src/new.ts",
    "D",
    "src/gone.ts",
    "R100",
    "src/old.ts",
    "src/renamed.ts",
    "T",
    "src/typechange.bin",
    "",
  ].join("\u0000");

  assert.deepEqual(parseNameStatusZ(output), [
    { path: "src/a.ts", origPath: "", status: "modified", staged: false, untracked: false, conflicted: false, added: 0, removed: 0 },
    { path: "src/new.ts", origPath: "", status: "added", staged: false, untracked: false, conflicted: false, added: 0, removed: 0 },
    { path: "src/gone.ts", origPath: "", status: "deleted", staged: false, untracked: false, conflicted: false, added: 0, removed: 0 },
    { path: "src/renamed.ts", origPath: "src/old.ts", status: "renamed", staged: false, untracked: false, conflicted: false, added: 0, removed: 0 },
    { path: "src/typechange.bin", origPath: "", status: "modified", staged: false, untracked: false, conflicted: false, added: 0, removed: 0 },
  ]);
});

test("--name-status -z 解析：路径里的空格/换行不会被转义（这就是要 -z 的原因）", () => {
  const output = ["M", "src/has space.ts", "M", "src/has\nnewline.ts", ""].join("\u0000");
  const files = parseNameStatusZ(output);

  assert.deepEqual(
    files.map((file) => file.path),
    ["src/has space.ts", "src/has\nnewline.ts"],
  );
});

test("--name-status -z 解析：空输出 / 半边条目都不炸", () => {
  assert.deepEqual(parseNameStatusZ(""), []);
  assert.deepEqual(parseNameStatusZ("\u0000\u0000"), []);
  // 重命名少了一个路径（理论上不该出现）：不许抛，也不许造出一个空路径的行。
  assert.deepEqual(parseNameStatusZ(["R100", "src/old.ts", ""].join("\u0000")), []);
});

test("分支文件清单：跑 merge-base + diff --name-status -z，底座是分叉点", async () => {
  const { exec, calls } = fakeExecFile((args) => {
    if (args[0] === "rev-parse") {
      return { ok: true, stdout: "origin/main\n" };
    }
    if (args[0] === "merge-base") {
      return { ok: true, stdout: "abc123\n" };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: `M\u0000src/a.ts\u0000A\u0000src/b.ts\u0000` };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const listing = await listSourceFiles({ cwd: "/repo", source: "branch", execImpl: exec });

  assert.equal(listing.summary, "");
  assert.equal(listing.base, "abc123");
  assert.deepEqual(
    listing.files.map((file) => [file.path, file.status]),
    [
      ["src/a.ts", "modified"],
      ["src/b.ts", "added"],
    ],
  );

  // diff 必须带 -z（否则路径会被转义）且以分叉点为底座，并且不能出现 `--` 之外的写命令。
  const diffCall = calls.find((call) => call.args[0] === "diff");
  assert.deepEqual(diffCall.args, ["diff", "--name-status", "-z", "abc123"]);
  for (const call of calls) {
    assert.equal(call.command, "git");
    assert.ok(isReadOnlyGitArgs(call.args), `只读白名单外的参数: ${call.args.join(" ")}`);
  }
});

test("分支文件清单：显式给的 base 优先于上游；没有上游就说清原因", async () => {
  const explicit = fakeExecFile((args) => {
    if (args[0] === "merge-base") {
      return { ok: true, stdout: "deadbeef\n" };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: "M\u0000a.ts\u0000" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const listing = await listSourceFiles({ cwd: "/repo", source: "branch", base: "dev", execImpl: explicit.exec });
  assert.equal(listing.base, "deadbeef");
  assert.equal(explicit.calls.some((call) => call.args[0] === "rev-parse"), false, "有 base 就不该再问上游");

  const noUpstream = fakeExecFile(() => ({ ok: false, code: 128, stdout: "", stderr: "no upstream\n" }));
  const failed = await listSourceFiles({ cwd: "/repo", source: "branch", execImpl: noUpstream.exec });
  assert.match(failed.summary, /no upstream branch/);
  assert.deepEqual(failed.files, []);
  assert.equal(noUpstream.calls.some((call) => call.args[0] === "diff"), false, "没有上游就别跑 diff");
});

test("分支文件清单：diff 失败时原文进 summary，不假装没有改动", async () => {
  const { exec } = fakeExecFile((args) => {
    if (args[0] === "rev-parse") {
      return { ok: true, stdout: "origin/main\n" };
    }
    if (args[0] === "merge-base") {
      return { ok: true, stdout: "abc123\n" };
    }
    return { ok: false, code: 128, stdout: "", stderr: "fatal: bad revision\n" };
  });

  const listing = await listSourceFiles({ cwd: "/repo", source: "branch", execImpl: exec });
  assert.match(listing.summary, /bad revision/);
  assert.deepEqual(listing.files, []);
});

test("分支文件清单：未暂存/已暂存不走这条路（porcelain 已经有那两份清单）", async () => {
  const { exec, calls } = fakeExecFile(() => ({ ok: true, stdout: "" }));
  const listing = await listSourceFiles({ cwd: "/repo", source: "unstaged", execImpl: exec });

  assert.match(listing.summary, /no file list of its own/);
  assert.equal(calls.length, 0, "一次 git 都不该跑");
});

test("分支文件清单：numstat 的行数归到对应文件（行上要显示 +N −M）", async () => {
  const { exec, calls } = fakeExecFile((args) => {
    if (args[0] === "rev-parse") {
      return { ok: true, stdout: "origin/main\n" };
    }
    if (args[0] === "merge-base") {
      return { ok: true, stdout: "abc123\n" };
    }
    if (args[0] === "diff" && args.includes("--numstat")) {
      // 二进制文件那两个字段是 `-`（→ 0/0）；重命名记录把计数归到新路径。
      return {
        ok: true,
        stdout: `12\t3\tsrc/a.ts\0-\t-\tassets/logo.png\0`,
      };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: `M\0src/a.ts\0M\0src/untouched.ts\0M\0assets/logo.png\0` };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const listing = await listSourceFiles({ cwd: "/repo", source: "branch", execImpl: exec });

  assert.deepEqual(
    listing.files.map((file) => [file.path, file.added, file.removed]),
    [
      ["src/a.ts", 12, 3],
      ["src/untouched.ts", 0, 0],
      ["assets/logo.png", 0, 0],
    ],
  );
  // 两条 diff 都以分叉点做底座，而且都在只读白名单里。
  const diffCalls = calls.filter((call) => call.args[0] === "diff");
  assert.equal(diffCalls.length, 2);
  for (const call of diffCalls) {
    assert.ok(call.args.includes("abc123"), `diff 少了分叉点: ${call.args.join(" ")}`);
    assert.ok(isReadOnlyGitArgs(call.args), `只读白名单外的参数: ${call.args.join(" ")}`);
  }
  assert.ok(
    diffCalls.some((call) => call.args.includes("--name-status")),
    "清单本身仍走 name-status（状态字母靠它）",
  );
});

test("分支文件清单：numstat 失败不算列不出来，只是没有统计", async () => {
  const { exec } = fakeExecFile((args) => {
    if (args[0] === "rev-parse") {
      return { ok: true, stdout: "origin/main\n" };
    }
    if (args[0] === "merge-base") {
      return { ok: true, stdout: "abc123\n" };
    }
    if (args[0] === "diff" && args.includes("--numstat")) {
      return { ok: false, code: 128, stdout: "", stderr: "fatal: bad revision\n" };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: `M\0src/a.ts\0` };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected" };
  });

  const listing = await listSourceFiles({ cwd: "/repo", source: "branch", execImpl: exec });

  assert.equal(listing.summary, "", "文件清单是准的，不能被统计的失败拉成不可用");
  assert.deepEqual(
    listing.files.map((file) => [file.path, file.added, file.removed]),
    [["src/a.ts", 0, 0]],
  );
});
