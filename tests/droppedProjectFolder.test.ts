/**
 * 侧栏拖入文件夹 → 打开「新建项目」对话框。
 *
 * 这里锁住两件容易悄悄坏掉的事：
 * 1. 纯决策：一个 drop 里到底该拿哪个条目建项目（多选优先目录、全是文件就不该动手）。
 * 2. Electron 侧的唯一通道：渲染进程是 sandbox 的，只有 preload 能拿到 `webUtils`，
 *    少了它拖进来的文件夹就没有绝对路径可用。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { collectDroppedItems, droppedFilePath, pickDroppedProjectFolder, supportsDroppedFolderPaths } from "../src/shared/droppedProjectFolder.ts";

test("多选里优先选目录，而不是排在前面的文件", () => {
  assert.deepEqual(
    pickDroppedProjectFolder([
      { name: "notes.md", path: "/tmp/notes.md", isDirectory: false },
      { name: "my-app", path: "/tmp/my-app", isDirectory: true },
    ]),
    { name: "my-app", path: "/tmp/my-app" },
  );
});

test("只拖一个文件夹时原样返回名字与绝对路径", () => {
  assert.deepEqual(
    pickDroppedProjectFolder([{ name: "tender", path: "/Users/me/tender", isDirectory: true }]),
    { name: "tender", path: "/Users/me/tender" },
  );
});

test("全都是文件时不开新建项目对话框", () => {
  assert.equal(
    pickDroppedProjectFolder([
      { name: "a.png", path: "/tmp/a.png", isDirectory: false },
      { name: "b.png", path: "/tmp/b.png", isDirectory: false },
    ]),
    undefined,
  );
});

test("平台没说条目类型时（拿不到 webkitGetAsEntry）仍接受单个拖拽项", () => {
  assert.deepEqual(
    pickDroppedProjectFolder([{ name: "unknown-kind" }]),
    { name: "unknown-kind", path: undefined },
  );
});

test("没有名字也没有路径的条目被忽略；全空则 undefined", () => {
  assert.deepEqual(
    pickDroppedProjectFolder([
      { name: "  ", isDirectory: true },
      { name: "real", path: "/tmp/real", isDirectory: true },
    ]),
    { name: "real", path: "/tmp/real" },
  );
  assert.equal(pickDroppedProjectFolder([{ name: "   " }]), undefined);
  assert.equal(pickDroppedProjectFolder([]), undefined);
});

test("名字/路径两侧空白被清理，空路径不冒充路径", () => {
  assert.deepEqual(
    pickDroppedProjectFolder([{ name: "  proj  ", path: "   ", isDirectory: true }]),
    { name: "proj", path: undefined },
  );
});

test("droppedFilePath 通过 preload bridge 取绝对路径", () => {
  const file = new File(["x"], "readme.md");
  assert.equal(
    droppedFilePath(file, { pathForFile: (candidate) => (candidate === file ? "/tmp/readme.md" : "") }),
    "/tmp/readme.md",
  );
});

test("droppedFilePath 在没有 bridge / bridge 抛错 / 空结果时一律 undefined", () => {
  const file = new File(["x"], "readme.md");
  assert.equal(droppedFilePath(file, undefined), undefined);
  assert.equal(droppedFilePath(file, { pathForFile: () => "" }), undefined);
  assert.equal(droppedFilePath(file, { pathForFile: () => "   " }), undefined);
  assert.equal(
    droppedFilePath(file, {
      pathForFile: () => {
        throw new Error("not a File backed by disk");
      },
    }),
    undefined,
  );
});

test("collectDroppedItems：目录条目用 entries API 判类型，路径从零长 File 解析", () => {
  const folderFile = new File([], "proj");
  const facts = collectDroppedItems(
    {
      items: [{ kind: "file", getAsFile: () => folderFile, webkitGetAsEntry: () => ({ isDirectory: true, name: "proj" }) }],
      files: [folderFile],
    },
    { pathForFile: () => "/Users/me/proj" },
  );

  assert.deepEqual(facts, [{ name: "proj", path: "/Users/me/proj", isDirectory: true }]);
});

test("collectDroppedItems：getAsFile 返回 null 的目录用 files 里的 File 拿路径", () => {
  const folderFile = new File([], "proj");
  const facts = collectDroppedItems(
    {
      items: [{ kind: "file", getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true, name: "proj" }) }],
      files: [folderFile],
    },
    { pathForFile: () => "/Users/me/proj" },
  );

  assert.deepEqual(facts, [{ name: "proj", path: "/Users/me/proj", isDirectory: true }]);
});

test("collectDroppedItems：items 的 File 解析不出路径时回退到 files 的同位 File", () => {
  const itemFile = new File([], "proj");
  const fallbackFile = new File([], "proj");
  const facts = collectDroppedItems(
    {
      items: [{ kind: "file", getAsFile: () => itemFile, webkitGetAsEntry: () => ({ isDirectory: true, name: "proj" }) }],
      files: [fallbackFile],
    },
    { pathForFile: (file) => (file === fallbackFile ? "/Users/me/proj" : "") },
  );

  assert.deepEqual(facts, [{ name: "proj", path: "/Users/me/proj", isDirectory: true }]);
});

test("collectDroppedItems：entries API 抛错时类型未知，但名字仍取到", () => {
  const file = new File([], "proj");
  const facts = collectDroppedItems(
    {
      items: [
        {
          kind: "file",
          getAsFile: () => file,
          webkitGetAsEntry: () => {
            throw new Error("data store no longer readable");
          },
        },
      ],
    },
    undefined,
  );

  assert.deepEqual(facts, [{ name: "proj", path: undefined, isDirectory: undefined }]);
});

test("collectDroppedItems：非 file 条目被忽略；没有 items 时退回 files", () => {
  const file = new File(["x"], "notes.md");
  assert.deepEqual(
    collectDroppedItems(
      {
        items: [
          { kind: "string", getAsFile: () => null },
          { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false, name: "notes.md" }) },
        ],
      },
      undefined,
    ),
    [{ name: "notes.md", path: undefined, isDirectory: false }],
  );

  assert.deepEqual(collectDroppedItems({ files: [file] }, undefined), [
    { name: "notes.md", path: undefined },
  ]);
});

test("supportsDroppedFolderPaths：只有带了 pathForFile 的主机（Electron）才算支持", () => {
  assert.equal(supportsDroppedFolderPaths(undefined), false);
  assert.equal(supportsDroppedFolderPaths({}), false);
  assert.equal(supportsDroppedFolderPaths({ pathForFile: () => "/tmp/proj" }), true);
});

test("Electron preload 暴露 __PI_DESKTOP_FILES__ 且走 webUtils.getPathForFile", () => {
  const preload = readFileSync(new URL("../src-electron/preload.js", import.meta.url), "utf8");
  assert.match(preload, /webUtils/);
  assert.match(preload, /getPathForFile\(file\)/);
  assert.match(preload, /exposeInMainWorld\("__PI_DESKTOP_FILES__"/);
});