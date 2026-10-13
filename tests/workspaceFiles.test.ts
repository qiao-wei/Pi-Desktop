/**
 * 右面板 Files 视图的服务端读取（`server/workspaceFiles.mjs`）。
 *
 * 用真临时目录测（这个模块本身就是在跟 fs 打交道，mock 掉 fs 等于没测）：
 * 重点是「越界必须拒绝」「忽略名单真的生效」「上限真的生效」这三类会被安全/性能问题踩到的地方。
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  IGNORED_DIRECTORY_NAMES,
  MAX_DIRECTORY_ENTRIES,
  MAX_FILE_TEXT_BYTES,
  isIgnoredEntryName,
  listWorkspaceDirectory,
  normalizeRelativeDir,
  readWorkspaceFile,
  sortDirectoryEntries,
} from "../server/workspaceFiles.mjs";

/** 造一棵临时工作区：`{ "src/a.ts": "内容", "src/sub": {} }`。 */
function makeWorkspace(files) {
  const root = mkdtempSync(join(tmpdir(), "pi-workspace-files-"));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    if (content === null) {
      mkdirSync(absolute, { recursive: true });
      continue;
    }
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

test("相对目录归一化：空 / 点 / 反斜杠 / 多余斜杠都对，越界与绝对路径是 null", () => {
  assert.equal(normalizeRelativeDir(""), "");
  assert.equal(normalizeRelativeDir("   "), "");
  assert.equal(normalizeRelativeDir("."), "");
  assert.equal(normalizeRelativeDir("/"), "");
  assert.equal(normalizeRelativeDir("src"), "src");
  assert.equal(normalizeRelativeDir("src/features"), "src/features");
  assert.equal(normalizeRelativeDir("src/features/"), "src/features");
  assert.equal(normalizeRelativeDir("src//features"), "src/features");
  assert.equal(normalizeRelativeDir("./src/./features"), "src/features");
  assert.equal(normalizeRelativeDir("src\\features"), "src/features", "Windows 传进来的分隔符也要认");

  for (const value of ["..", "../x", "src/../..", "src/../../etc", "/etc", "C:/Windows", "C:\\Windows"]) {
    assert.equal(normalizeRelativeDir(value), null, `不该通过: ${value}`);
  }
});

test("忽略名单：.git / node_modules 不出现在列表里", () => {
  for (const name of IGNORED_DIRECTORY_NAMES) {
    assert.equal(isIgnoredEntryName(name, true), true);
  }
  assert.equal(isIgnoredEntryName(".DS_Store", false), true);
  assert.equal(isIgnoredEntryName("node_modules", false), false, "同名文件不忽略（只有目录才忽略）");
  assert.equal(isIgnoredEntryName("src", true), false);
});

test("排序：目录在前，然后名字不区分大小写，最后用原始名字兜底（顺序稳定）", () => {
  const sorted = sortDirectoryEntries([
    { name: "b.txt" },
    { name: "Zebra", isDir: true },
    { name: "apple", isDir: true },
    { name: "A.txt" },
    { name: "a.txt" },
  ]).map((entry) => entry.name);

  assert.deepEqual(sorted, ["apple", "Zebra", "A.txt", "a.txt", "b.txt"]);
});

test("列根目录：文件名、相对路径、目录标记、大小都对；忽略名单生效", () => {
  const root = makeWorkspace({
    "src/a.ts": "hello",
    "README.md": "# hi",
    "node_modules/pkg/index.js": "x",
    ".git/HEAD": "ref",
    ".DS_Store": "junk",
  });

  try {
    const listing = listWorkspaceDirectory({ cwd: root });
    assert.equal(listing.ok, true);
    assert.equal(listing.dir, "");
    assert.equal(listing.truncated, false);
    assert.deepEqual(
      listing.entries.map((entry) => [entry.path, entry.isDir, entry.size]),
      [
        ["src", true, 0],
        ["README.md", false, 4],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("列子目录：路径带上前缀，展开哪层才读哪层", () => {
  const root = makeWorkspace({ "src/features/a.ts": "a", "src/b.ts": "b", "src/sub/c.ts": "c" });

  try {
    const listing = listWorkspaceDirectory({ cwd: root, dir: "src" });
    assert.deepEqual(
      listing.entries.map((entry) => entry.path),
      ["src/features", "src/sub", "src/b.ts"],
    );
    assert.equal(listing.entries.find((entry) => entry.isDir).name, "features");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("上限：条数超过 limit 就截断并标记 truncated", () => {
  const files = {};
  for (let index = 0; index < 12; index += 1) {
    files[`f${String(index).padStart(2, "0")}.txt`] = "x";
  }
  const root = makeWorkspace(files);

  try {
    const listing = listWorkspaceDirectory({ cwd: root, limit: 5 });
    assert.equal(listing.entries.length, 5);
    assert.equal(listing.truncated, true);
    assert.equal(listing.entries[0].name, "f00.txt", "截断前先排序，留下的应该是最前面的几个");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("越界与不存在的目录：拒绝且不抛", () => {
  const root = makeWorkspace({ "a.txt": "a" });

  try {
    for (const dir of ["..", "../..", "src/../../.."]) {
      const listing = listWorkspaceDirectory({ cwd: root, dir });
      assert.equal(listing.ok, false);
      assert.match(listing.status, /outside the project folder/);
    }

    const missing = listWorkspaceDirectory({ cwd: root, dir: "nope" });
    assert.equal(missing.ok, false);
    assert.match(missing.status, /not readable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("软链指着项目外时：列得出来但读不了（不能因为链接名在项目里就放行）", () => {
  const outside = mkdtempSync(join(tmpdir(), "pi-workspace-outside-"));
  const root = makeWorkspace({ "inside.txt": "in" });
  writeFileSync(join(outside, "secret.txt"), "top secret");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));

  try {
    const listing = listWorkspaceDirectory({ cwd: root });
    const link = listing.entries.find((entry) => entry.name === "link.txt");
    assert.equal(link.isLink, true);
    assert.equal(link.isDir, false);

    const read = readWorkspaceFile({ cwd: root, path: "link.txt" });
    assert.equal(read.availability, "unavailable");
    assert.match(read.summary, /outside the project folder/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("读文本：内容、大小、行尾都原样给出", () => {
  const root = makeWorkspace({ "src/a.ts": "第一行\n第二行\n" });

  try {
    const read = readWorkspaceFile({ cwd: root, path: "src/a.ts" });
    assert.equal(read.availability, "text");
    assert.equal(read.path, "src/a.ts");
    assert.equal(read.text, "第一行\n第二行\n");
    assert.equal(read.truncated, false);
    assert.equal(read.summary, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("读文件：二进制、超大、目录、不存在、越界各有各的说法", () => {
  const root = makeWorkspace({ "bin.dat": "x", "src": null, "big.txt": "0123456789" });
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]));

  try {
    const binary = readWorkspaceFile({ cwd: root, path: "bin.dat" });
    assert.equal(binary.availability, "binary");
    assert.equal(binary.text, null);

    const tooLarge = readWorkspaceFile({ cwd: root, path: "big.txt", maxBytes: 4 });
    assert.equal(tooLarge.availability, "too-large");
    assert.equal(tooLarge.size, 10, "要说清真实大小，用户才知道差多少");
    assert.equal(tooLarge.truncated, true);

    const folder = readWorkspaceFile({ cwd: root, path: "src" });
    assert.equal(folder.availability, "unavailable");
    assert.match(folder.summary, /is a folder/);

    const missing = readWorkspaceFile({ cwd: root, path: "nope.txt" });
    assert.match(missing.summary, /missing on disk/);

    for (const path of ["../outside.txt", "/etc/passwd", ""]) {
      const escaped = readWorkspaceFile({ cwd: root, path });
      assert.equal(escaped.availability, "unavailable", `不该读: ${path}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("读不了的权限：报 not readable 而不是抛出去", () => {
  const root = makeWorkspace({ "locked.txt": "secret" });
  chmodSync(join(root, "locked.txt"), 0o000);

  try {
    const read = readWorkspaceFile({ cwd: root, path: "locked.txt" });
    // root 用户（CI 上偶尔是）永远读得到，那就只断言"没抛且有明确的 availability"。
    assert.ok(["unavailable", "text"].includes(read.availability));
    if (read.availability === "unavailable") {
      assert.match(read.summary, /not readable|missing on disk/);
    }
  } finally {
    chmodSync(join(root, "locked.txt"), 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

test("常量与 ZCode 对齐（上限改了要同步改这条测试）", () => {
  assert.equal(MAX_FILE_TEXT_BYTES, 256 * 1024);
  assert.equal(MAX_DIRECTORY_ENTRIES, 500);
});