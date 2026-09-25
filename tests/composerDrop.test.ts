/**
 * 拖进 composer 的一堆条目怎么落地（Electron 走目录引用，其它宿主当场拒绝）。
 *
 * 这里锁的是这次 bug 的根：目录在 Chromium/WebKit 里是一个零长的 `File`，只要它混进
 * 「附件 = 字节」那条通道，提交时 `FileReader` 就会抛出平台原文
 * （"A requested file or directory could not be found at the time an operation was processed."）。
 * 所以决策必须发生在接字节之前，而且「拿不到路径的目录」只能被拒绝、不能被静默吞掉。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { attachmentKindFromMimeType, DIRECTORY_MIME_TYPE, isDirectoryAttachment } from "../src/shared/attachmentKind.ts";
import { pickNewFolderDrops, planComposerDrop } from "../src/shared/composerDrop.ts";

const folderFile = () => new File([], "proj");
const realFile = (name = "notes.md", body = "x") => new File([body], name);

test("宿主能给出绝对路径（Electron）：目录成引用，文件走字节", () => {
  const notes = realFile();
  const plan = planComposerDrop([
    { name: "proj", path: "/Users/me/proj", isDirectory: true, file: folderFile() },
    { name: "notes.md", path: "/Users/me/notes.md", isDirectory: false, file: notes },
  ]);

  assert.deepEqual(plan.folders, [{ name: "proj", path: "/Users/me/proj" }]);
  assert.deepEqual(plan.refusedFolders, []);
  assert.deepEqual(plan.files, [notes]);
});

test("宿主给不出路径（Tauri / 浏览器）：目录被拒绝，零长 File 绝不落进字节通道", () => {
  const zeroLengthDirectoryFile = folderFile();
  const plan = planComposerDrop([
    { name: "proj", isDirectory: true, file: zeroLengthDirectoryFile },
  ]);

  assert.deepEqual(plan.folders, []);
  assert.deepEqual(plan.refusedFolders, ["proj"]);
  assert.deepEqual(
    plan.files,
    [],
    "把目录的 File 交给 addFiles 正是那次报错的来源（FileReader 打不开目录）",
  );
});

test("混拖：目录与文件各归各位，顺序保持", () => {
  const first = realFile("a.md");
  const second = realFile("b.md");
  const plan = planComposerDrop([
    { name: "a.md", path: "/tmp/a.md", isDirectory: false, file: first },
    { name: "proj", path: "/tmp/proj", isDirectory: true, file: folderFile() },
    { name: "b.md", path: "/tmp/b.md", isDirectory: false, file: second },
  ]);

  assert.deepEqual(plan.folders.map((folder) => folder.name), ["proj"]);
  assert.deepEqual(plan.files, [first, second]);
  assert.deepEqual(plan.refusedFolders, []);
});

test("拿不到 webkitGetAsEntry（类型未知）时仍按文件走，与本改动前一致", () => {
  const file = realFile();
  const plan = planComposerDrop([{ name: "mystery", path: "/tmp/mystery", isDirectory: undefined, file }]);

  assert.deepEqual(plan.files, [file]);
  assert.deepEqual(plan.folders, []);
  // 万一它其实是目录：提交侧会把「读不出来」指名报出来，而不是抛平台原文。
  assert.deepEqual(plan.refusedFolders, []);
});

test("没有 File 句柄的条目没有字节可送，直接忽略", () => {
  const plan = planComposerDrop([
    { name: "只有名字", isDirectory: false },
    { name: "", path: "/tmp/nameless", isDirectory: false },
  ]);

  assert.deepEqual(plan.files, []);
  assert.deepEqual(plan.folders, []);
  assert.deepEqual(plan.refusedFolders, []);
});

test("目录没有名字时用路径末段兜底（拒绝时也要报得出名字）", () => {
  const named = planComposerDrop([{ name: "  ", path: "/Users/me/my-app", isDirectory: true }]);
  assert.deepEqual(named.folders, [{ name: "my-app", path: "/Users/me/my-app" }]);

  const refused = planComposerDrop([{ name: "", path: "", isDirectory: true }]);
  assert.deepEqual(refused.refusedFolders, ["folder"]);
});

test("空白条目的名字与路径都按 trim 后的结果判定", () => {
  const plan = planComposerDrop([{ name: " proj ", path: "   ", isDirectory: true }]);
  assert.deepEqual(plan.folders, []);
  assert.deepEqual(plan.refusedFolders, ["proj"]);
});

test("空 drop 什么都没有", () => {
  assert.deepEqual(planComposerDrop([]), { folders: [], refusedFolders: [], files: [] });
});

test("pickNewFolderDrops：同一个目录拖两次只留一个徽标", () => {
  const { folders, overflow } = pickNewFolderDrops(
    [
      { name: "proj", path: "/tmp/proj" },
      { name: "proj", path: "/tmp/proj" },
      { name: "other", path: "/tmp/other" },
    ],
    [],
    10,
  );

  assert.deepEqual(folders.map((folder) => folder.path), ["/tmp/proj", "/tmp/other"]);
  assert.equal(overflow, false);
});

test("pickNewFolderDrops：已在 composer 里的目录不重复添加", () => {
  const { folders } = pickNewFolderDrops([{ name: "proj", path: "/tmp/proj" }], ["/tmp/proj"], 10);
  assert.deepEqual(folders, []);
});

test("pickNewFolderDrops：槽位不够时保住已装下的，并报 overflow", () => {
  const { folders, overflow } = pickNewFolderDrops(
    [
      { name: "a", path: "/tmp/a" },
      { name: "b", path: "/tmp/b" },
    ],
    [],
    1,
  );

  assert.deepEqual(folders.map((folder) => folder.path), ["/tmp/a"]);
  assert.equal(overflow, true);
});

test("attachmentKindFromMimeType：目录 / 图片 / 其余", () => {
  assert.equal(attachmentKindFromMimeType(DIRECTORY_MIME_TYPE), "directory");
  assert.equal(attachmentKindFromMimeType("  Inode/Directory  "), "directory");
  assert.equal(attachmentKindFromMimeType("image/png"), "image");
  assert.equal(attachmentKindFromMimeType("IMAGE/JPEG"), "image");
  assert.equal(attachmentKindFromMimeType("application/pdf"), "file");
  assert.equal(attachmentKindFromMimeType(""), "file");
  assert.equal(attachmentKindFromMimeType(undefined), "file");
  assert.equal(isDirectoryAttachment({ mimeType: DIRECTORY_MIME_TYPE }), true);
  assert.equal(isDirectoryAttachment({ mimeType: "text/plain" }), false);
});