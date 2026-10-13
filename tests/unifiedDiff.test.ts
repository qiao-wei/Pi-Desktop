/**
 * unified diff 解析器。
 *
 * 重点不是「能解析正常补丁」，而是那些会让渲染层说谎的地方：
 * - 两侧行号（渲染层直接显示，错一行整段都对不上）；
 * - `\ No newline at end of file` 必须挂到它上一行，不能自己变成一行内容；
 * - 中文路径在 git 默认 `core.quotePath` 下是 `"b/\346\226\207.md"`，解码错了标题就废了；
 * - 认不出来的行（比如块中间插进来一个 `index ...`）必须结束当前块，不能让后面的 `+` 行
 *   继续在错的旧行号上往下数。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildUntrackedPatch, countPatchLines } from "../server/workspaceDiff.mjs";
import { hasPatchContent, parseUnifiedPatch, patchDisplayPath, patchHeaderPath } from "../src/shared/unifiedDiff.ts";

const BASIC_PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@ function hello() {",
  " const one = 1;",
  "-const two = 2;",
  "+const two = 22;",
  "+const three = 3;",
  " return one;",
  " return three;",
  "",
].join("\n");

test("基本补丁：两侧行号、增删计数、块说明都对得上", () => {
  const parsed = parseUnifiedPatch(BASIC_PATCH);

  assert.equal(parsed.oldPath, "src/a.ts");
  assert.equal(parsed.newPath, "src/a.ts");
  assert.equal(parsed.added, 2);
  assert.equal(parsed.removed, 1);
  assert.equal(parsed.hunks.length, 1);

  const [hunk] = parsed.hunks;
  assert.equal(hunk.oldStart, 1);
  assert.equal(hunk.oldCount, 4);
  assert.equal(hunk.newStart, 1);
  assert.equal(hunk.newCount, 5);
  assert.equal(hunk.section, "function hello() {");
  assert.deepEqual(
    hunk.lines.map((line) => [line.kind, line.text, line.oldLine, line.newLine]),
    [
      ["context", "const one = 1;", 1, 1],
      ["remove", "const two = 2;", 2, null],
      ["add", "const two = 22;", null, 2],
      ["add", "const three = 3;", null, 3],
      ["context", "return one;", 3, 4],
      ["context", "return three;", 4, 5],
    ],
  );
});

test("多个块：行号每个块各自从块头重新开始", () => {
  const parsed = parseUnifiedPatch(
    [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -10,2 +10,2 @@",
      " keep",
      "-old",
      "+new",
      "@@ -100,1 +101,1 @@ last",
      "-gone",
      "+fresh",
      "",
    ].join("\n"),
  );

  assert.equal(parsed.hunks.length, 2);
  assert.equal(parsed.hunks[0].lines[0].oldLine, 10);
  assert.equal(parsed.hunks[1].lines[0].oldLine, 100);
  assert.equal(parsed.hunks[1].lines[0].newLine, null, "删除行只有旧侧行号");
  assert.equal(parsed.hunks[1].lines[1].newLine, 101, "紧跟着的新增行从块头说的 101 开始");
  assert.equal(parsed.hunks[1].section, "last");
});

test("省略行数（@@ -1 +1 @@）按 1 行算", () => {
  const parsed = parseUnifiedPatch(["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"));

  assert.equal(parsed.hunks[0].oldCount, 1);
  assert.equal(parsed.hunks[0].newCount, 1);
});

test("`\\ No newline at end of file` 挂到上一行，自己不占一行", () => {
  const parsed = parseUnifiedPatch(
    ["--- a/x.txt", "+++ b/x.txt", "@@ -1 +1 @@", "-abc", "\\ No newline at end of file", "+abd", "\\ No newline at end of file", ""].join("\n"),
  );

  assert.equal(parsed.hunks[0].lines.length, 2, "标记行不该变成一个内容行");
  assert.equal(parsed.hunks[0].lines[0].noNewline, true, "标记属于它上面那行（删除侧）");
  assert.equal(parsed.hunks[0].lines[1].noNewline, true, "新增侧同理");
  assert.equal(parsed.hunks[0].lines[0].text, "abc");
});

test("未跟踪文件的合成补丁：没有 diff --git 头也能解析，旧路径是 null", () => {
  const synthetic = buildUntrackedPatch({ path: "notes/new.md", content: "一\n二\n" });
  const parsed = parseUnifiedPatch(synthetic.patch);

  assert.equal(parsed.oldPath, null, "/dev/null 要归一成 null，否则标题会显示成 /dev/null");
  assert.equal(parsed.newPath, "notes/new.md");
  assert.equal(patchDisplayPath(parsed), "notes/new.md");
  assert.equal(parsed.added, 2);
  assert.equal(parsed.removed, 0);
  assert.equal(hasPatchContent(parsed), true);
});

test("删除文件：新路径是 null，标题回落旧路径", () => {
  const parsed = parseUnifiedPatch(["--- a/gone.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-bye", ""].join("\n"));

  assert.equal(parsed.newPath, null);
  assert.equal(patchDisplayPath(parsed), "gone.ts");
  assert.equal(parsed.removed, 1);
});

test("中文路径：解 git 的 C 风格八进制转义，并去掉 a/ b/ 前缀", () => {
  const escaped = patchHeaderPath('"a/\\346\\226\\207\\344\\273\\266.md"');
  assert.equal(escaped, "文件.md");

  const parsed = parseUnifiedPatch(['--- "a/\\346\\226\\207\\344\\273\\266.md"', '+++ "b/\\346\\226\\207\\344\\273\\266.md"', "@@ -1 +1 @@", "-旧", "+新", ""].join("\n"));
  assert.equal(parsed.oldPath, "文件.md");
  assert.equal(parsed.newPath, "文件.md");
});

test("路径头部的零碎写法：时间戳、普通转义、空串、/dev/null", () => {
  assert.equal(patchHeaderPath("b/x.ts\t2026-10-10 10:00:00 +0800"), "x.ts", "diff -u 会带时间戳");
  assert.equal(patchHeaderPath('"b/tab\\tname.ts"'), "tab\tname.ts");
  assert.equal(patchHeaderPath(""), null);
  assert.equal(patchHeaderPath("/dev/null"), null);
});

test("空补丁 / 只有头部的补丁：没有块，也不谎报改动", () => {
  for (const patch of ["", "\n", "diff --git a/x b/x\nindex 111..222 100644\n"]) {
    const parsed = parseUnifiedPatch(patch);
    assert.deepEqual(parsed.hunks, []);
    assert.equal(parsed.added, 0);
    assert.equal(parsed.removed, 0);
    assert.equal(hasPatchContent(parsed), false);
  }

  // 只改了权限：git 只给头部 + old mode/new mode，没有块。
  const modeOnly = parseUnifiedPatch(["diff --git a/s.sh b/s.sh", "old mode 100644", "new mode 100755", ""].join("\n"));
  assert.equal(hasPatchContent(modeOnly), false);
});

test("块中间出现认不出的行：结束当前块，后面的行不再串行号", () => {
  const parsed = parseUnifiedPatch(
    ["--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,3 @@", " keep", "index 1111111..2222222 100644", "+would-be-wrong", " keep2", ""].join("\n"),
  );

  const [hunk] = parsed.hunks;
  assert.equal(hunk.lines.length, 1, "认不出的行之后的内容不该继续算进这个块");
  assert.equal(hunk.lines[0].text, "keep");
  assert.equal(parsed.added, 0, "被丢掉的行不该计入增删");
});

test("第二个文件段停止解析：两个文件的块不会混在一个标题下", () => {
  const parsed = parseUnifiedPatch(
    ["--- a/one.ts", "+++ b/one.ts", "@@ -1 +1 @@", "-a", "+b", "--- a/two.ts", "+++ b/two.ts", "@@ -5 +5 @@", "-c", "+d", ""].join("\n"),
  );

  assert.equal(parsed.newPath, "one.ts");
  assert.equal(parsed.hunks.length, 1);
  assert.deepEqual(parsed.hunks[0].lines.map((line) => line.text), ["a", "b"]);
});

test("真空行按上下文行处理并推进两侧行号（git 会写成空格，别把空串当段落结束）", () => {
  const parsed = parseUnifiedPatch(["--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,3 @@", " a", "", " b", ""].join("\n"));

  assert.deepEqual(
    parsed.hunks[0].lines.map((line) => [line.text, line.oldLine, line.newLine]),
    [
      ["a", 1, 1],
      ["", 2, 2],
      ["b", 3, 3],
    ],
  );
});

test("补丁结尾的换行不产生幽灵行", () => {
  const parsed = parseUnifiedPatch(["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"));

  assert.equal(parsed.hunks[0].lines.length, 2);
});

test("增删计数与服务端 countPatchLines 对账（渲染层显示的 +/- 必须和徽标一致）", () => {
  const cases = [
    BASIC_PATCH,
    buildUntrackedPatch({ path: "a.md", content: "一\n二\n三\n" }).patch,
    buildUntrackedPatch({ path: "a.md", content: "没有换行" }).patch,
    ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,2 @@", " keep", "-a", "+b", "@@ -9,1 +9,1 @@", "-c", "+d", ""].join("\n"),
  ];

  for (const patch of cases) {
    const parsed = parseUnifiedPatch(patch);
    const counted = countPatchLines(patch);
    assert.deepEqual({ added: parsed.added, removed: parsed.removed }, counted, `对不上：\n${patch}`);
  }
});

test("块里删除侧的旧行号会随着删除行累加，新增侧不动", () => {
  const parsed = parseUnifiedPatch(["--- a/x", "+++ b/x", "@@ -3,4 +3,2 @@", "-a", "-b", " c", "-d", ""].join("\n"));

  assert.deepEqual(
    parsed.hunks[0].lines.map((line) => [line.kind, line.oldLine, line.newLine]),
    [
      ["remove", 3, null],
      ["remove", 4, null],
      ["context", 5, 3],
      ["remove", 6, null],
    ],
  );
});