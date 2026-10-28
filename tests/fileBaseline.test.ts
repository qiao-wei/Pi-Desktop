import assert from "node:assert/strict";
import test from "node:test";

import { createFileBaselineReader } from "../src/features/chat/fileBaseline.ts";
import { deriveToolDisplay } from "../src/shared/toolDisplay.ts";

/**
 * `write` 的「删了几行」只能来自**写入前的文件**：参数只说往里写什么。读文件是 I/O，而派生
 * （`src/shared`）是纯层，所以由宿主注入一个**同步读 + 后台补**的读取器 —— 这里钉的就是它：
 * 第一次问「还不知道」，答案到了之后才给正文；读不到就永远说「不知道」，绝不编一个 0。
 */
const CONTENT = {
  path: "notes.md",
  availability: "text",
  text: "一\n二\n三\n",
  size: 12,
  truncated: false,
  summary: null,
};

function deferred() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("第一次问就发起读取，本次仍返回 undefined（派生不能等 I/O）", async () => {
  const pending = deferred();
  const calls: string[] = [];
  const read = createFileBaselineReader(
    { projectId: "p1", fetchFile: () => pending.promise },
    {
      read: (path) => {
        calls.push(path);
        return pending.promise;
      },
    },
  );

  assert.equal(read("notes.md"), undefined);
  assert.deepEqual(calls, ["notes.md"], "第一次问就发起请求，而不是等第二次");
  assert.equal(read("notes.md"), undefined, "同一个文件在途时不再重复请求");
  assert.equal(calls.length, 1);

  pending.resolve(CONTENT);
  await pending.promise;
  await Promise.resolve();
  assert.equal(read("notes.md"), "一\n二\n三\n", "答案到了之后才给正文");
  assert.equal(calls.length, 1, "命中缓存，不再请求");
});

test("读不到（二进制 / 过大 / 不存在）就是不知道，而且不再重试", async () => {
  let calls = 0;
  const read = createFileBaselineReader(
    { projectId: "p1", fetchFile: async () => undefined },
    {
      read: async () => {
        calls += 1;
        return { path: "img.png", availability: "binary", text: null, size: 9, truncated: false, summary: "binary" };
      },
    },
  );
  assert.equal(read("img.png"), undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(read("img.png"), undefined, "读不到不许编一个空文件");
  assert.equal(calls, 1, "结论记住了，不重复问");
});

test("请求失败也只算「不知道」，不抛出去", async () => {
  const read = createFileBaselineReader(
    { projectId: "p1", fetchFile: () => Promise.reject(new Error("boom")) },
    {
      read: () => Promise.reject(new Error("boom")),
    },
  );
  assert.equal(read("notes.md"), undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(read("notes.md"), undefined);
});

test("路径归一化：`./notes.md` 与 `notes.md` 是同一个文件；空路径不请求", async () => {
  const calls: string[] = [];
  const read = createFileBaselineReader(
    { projectId: "p1", fetchFile: async () => undefined },
    {
      read: async (path) => {
        calls.push(path);
        return CONTENT;
      },
    },
  );
  assert.equal(read("./notes.md"), undefined);
  assert.equal(read("  "), undefined);
  assert.deepEqual(calls, ["notes.md"]);
});

test("换项目就清空：上一个项目的文件正文不能当这个项目的基线", async () => {
  let source = { projectId: "p1" };
  const read = createFileBaselineReader(
    () => ({ ...source, fetchFile: async () => CONTENT }),
    {
      read: async () => CONTENT,
    },
  );
  assert.equal(read("notes.md"), undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(read("notes.md"), "一\n二\n三\n");

  source = { projectId: "p2" };
  assert.equal(read("notes.md"), undefined, "新项目里同一个相对路径是**另一个**文件");
});

test("有了基线，write 的预览就能说「删了几行」；没有就只加不减", () => {
  const args = { path: "notes.md", content: "新一\n新二\n" };
  const withoutBaseline = deriveToolDisplay({ toolName: "write", args });
  assert.equal(withoutBaseline.kind, "fileDiff");
  if (withoutBaseline.kind === "fileDiff") {
    assert.deepEqual([withoutBaseline.files[0]!.added, withoutBaseline.files[0]!.removed], [2, 0]);
  }

  const withBaseline = deriveToolDisplay({ toolName: "write", args, baseline: "一\n二\n三\n" });
  assert.equal(withBaseline.kind, "fileDiff");
  if (withBaseline.kind === "fileDiff") {
    assert.deepEqual([withBaseline.files[0]!.added, withBaseline.files[0]!.removed], [2, 3]);
    assert.equal(withBaseline.files[0]!.patch.includes("-三"), true, "旧文件的行进正文");
  }
});