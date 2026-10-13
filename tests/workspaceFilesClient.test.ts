/**
 * 右面板 Files 视图的客户端纯函数（`src/shared/workspaceFiles.ts`）。
 *
 * 重点在「服务端说什么，渲染层就说什么」：归一化把非 text 的正文丢掉、坏条目丢掉、
 * 查询串和服务端路由逐字对上 —— 这些错了都会表现成「面板画了个假东西」。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkspaceDirQuery,
  buildWorkspaceFileQuery,
  canRenderFileText,
  fileNameOf,
  filterWorkspaceTree,
  formatFileSize,
  normalizeDirectoryListing,
  normalizeFileContent,
  parentDirectory,
} from "../src/shared/workspaceFiles.ts";

test("目录查询串：空目录不带 dir 参数，会话路径可省", () => {
  assert.equal(buildWorkspaceDirQuery({ projectId: "p1" }), "/api/projects/files?projectId=p1");
  assert.equal(buildWorkspaceDirQuery({ projectId: "p1", dir: "  " }), "/api/projects/files?projectId=p1");
  assert.equal(
    buildWorkspaceDirQuery({ projectId: "p1", dir: "src/features", sessionPath: "/tmp/wt" }),
    "/api/projects/files?projectId=p1&dir=src%2Ffeatures&sessionPath=%2Ftmp%2Fwt",
  );
});

test("文件查询串：路径一定要在（不然服务端不知道读什么）", () => {
  assert.equal(buildWorkspaceFileQuery({ projectId: "p1", path: "a.ts" }), "/api/projects/file?projectId=p1&path=a.ts");
  assert.equal(
    buildWorkspaceFileQuery({ projectId: "p1", path: "src/中 文.ts", sessionPath: "/tmp/wt" }),
    "/api/projects/file?projectId=p1&path=src%2F%E4%B8%AD+%E6%96%87.ts&sessionPath=%2Ftmp%2Fwt",
  );
});

test("目录归一化：坏条目丢掉、缺字段补默认值、整体形状不对返回 null", () => {
  const listing = normalizeDirectoryListing({
    dir: "src",
    truncated: true,
    entries: [
      { name: "a.ts", path: "src/a.ts", isDir: false, isLink: false, size: 12 },
      // 没有 path 的条目整条丢掉：树上会变成一个点不开的行。
      { name: "broken" },
      // name 缺失就用 path 的最后一段兜底（服务端理论上不会这样，客户端得能兜住）。
      { path: "src/sub", isDir: true },
      "nonsense",
    ],
  });

  assert.deepEqual(listing, {
    dir: "src",
    truncated: true,
    entries: [
      { name: "a.ts", path: "src/a.ts", isDir: false, isLink: false, size: 12 },
      { name: "sub", path: "src/sub", isDir: true, isLink: false, size: 0 },
    ],
  });

  for (const raw of [null, undefined, [], "x", {}, { entries: "no" }]) {
    assert.equal(normalizeDirectoryListing(raw), null, `不该接受: ${JSON.stringify(raw)}`);
  }
});

test("正文归一化：非 text 一定拿不到正文（二进制/超限里没有可渲染的文字）", () => {
  const text = normalizeFileContent({ path: "a.ts", availability: "text", text: "hello", size: 5 });
  assert.equal(text?.text, "hello");
  assert.equal(text?.summary, null);
  assert.equal(canRenderFileText(text), true);

  const binary = normalizeFileContent({ path: "a.bin", availability: "binary", text: "mojibake", size: 9 });
  assert.equal(binary?.text, null, "binary 即使带了 text 也不看");
  assert.equal(canRenderFileText(binary), false);

  const unknown = normalizeFileContent({ path: "a.ts", availability: "whatever", text: "x" });
  assert.equal(unknown?.availability, "unavailable", "没见过的状态降级成看不了，而不是猜成 text");
  assert.equal(canRenderFileText(unknown), false);

  const tooLarge = normalizeFileContent({ path: "big", availability: "too-large", size: 999999, truncated: true });
  assert.equal(tooLarge?.truncated, true);
  assert.equal(tooLarge?.size, 999999);

  assert.equal(normalizeFileContent({ availability: "text", text: "x" }), null, "没有 path 就不知道在说什么");
  assert.equal(normalizeFileContent(null), null);
  assert.equal(canRenderFileText(null), false);
});

test("切行：CRLF 吃掉 \\r、结尾换行不多出一行、空文本是零行", () => {
});

test("路径拆分：父目录与文件名（树的展开和标题都用它）", () => {
  assert.deepEqual([parentDirectory("src/a.ts"), fileNameOf("src/a.ts")], ["src", "a.ts"]);
  assert.deepEqual([parentDirectory("a.ts"), fileNameOf("a.ts")], ["", "a.ts"]);
  assert.deepEqual([parentDirectory(""), fileNameOf("")], ["", ""]);
});

test("文件大小：B / KB / MB 三档都要像人话", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(1023), "1023 B");
  assert.equal(formatFileSize(1024), "1.0 KB");
  assert.equal(formatFileSize(20 * 1024), "20 KB");
  assert.equal(formatFileSize(2 * 1024 * 1024), "2.0 MB");
  assert.equal(formatFileSize(undefined), "0 B");
});
/** 文件树筛选：只筛「已经读回来的」那几层（树是懒加载的，没有全仓索引）。 */
test("筛选：空查询不过滤，命中项和它的祖先目录都显示", () => {
  const entriesByDir = new Map([
    [
      "",
      [
        { name: "src", path: "src", isDir: true },
        { name: "docs", path: "docs", isDir: true },
        { name: "README.md", path: "README.md", isDir: false },
      ],
    ],
    [
      "src",
      [
        { name: "a.ts", path: "src/a.ts", isDir: false },
        { name: "b.ts", path: "src/b.ts", isDir: false },
        { name: "shared", path: "src/shared", isDir: true },
      ],
    ],
    ["src/shared", [{ name: "c.ts", path: "src/shared/c.ts", isDir: false }]],
  ]);

  assert.equal(filterWorkspaceTree(entriesByDir, "   "), null, "空查询 = 不过滤");
  assert.equal(filterWorkspaceTree(entriesByDir, ""), null);

  const nested = filterWorkspaceTree(entriesByDir, "c.t");
  assert.deepEqual([...nested!.visible].sort(), ["src", "src/shared", "src/shared/c.ts"]);
  assert.deepEqual([...nested!.expand].sort(), ["src", "src/shared"], "祖先目录要自动展开，否则命中行藏在收起里");
  assert.equal(nested!.matchCount, 1);

  // 大小写不敏感：`SHARED` 既命中目录本身也命中它的子文件（子文件也要展开到）。
  const byName = filterWorkspaceTree(entriesByDir, "SHARED");
  assert.equal(byName!.matchCount, 2);
  assert.equal(byName!.visible.has("src/shared/c.ts"), true);

  // 命中的是目录本身、底下没有命中：只显示它，不替用户展开。
  const dirOnly = filterWorkspaceTree(entriesByDir, "docs");
  assert.equal(dirOnly!.matchCount, 1);
  assert.deepEqual([...dirOnly!.visible], ["docs"]);
  assert.equal(dirOnly!.expand.size, 0);

  // 没搜到：matchCount = 0（界面据此显示「没有匹配的文件」而不是一棵空树）。
  const none = filterWorkspaceTree(entriesByDir, "zzz");
  assert.equal(none!.matchCount, 0);
  assert.equal(none!.visible.size, 0);
});
