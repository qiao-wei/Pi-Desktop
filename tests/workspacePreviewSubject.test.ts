/**
 * 右面板预览的「在看什么」（`src/shared/workspacePreview.ts`）。
 *
 * 这个判断决定了「换目标时要不要清掉屏上的内容」。它错了的表现是**看 A 的时候屏上留着 B 的正文**，
 * 所以每种切换组合都要有一条：换文件、换来源、换 base、改动↔正文。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  contentSubject,
  diffSubject,
  previewSubjectPath,
  sameWorkspacePreviewSubject,
} from "../src/shared/workspacePreview.ts";
import { buildWorkspaceDiffQuery, buildWorkspaceChangedFilesQuery } from "../src/shared/workspaceDiff.ts";

test("同一个文件 + 同一个来源 = 同一件事（重拉时旧内容可以留在屏上）", () => {
  const first = diffSubject({ path: "src/a.ts", source: "unstaged" });
  assert.equal(sameWorkspacePreviewSubject(first, diffSubject({ path: "src/a.ts", source: "unstaged" })), true);
  assert.equal(sameWorkspacePreviewSubject(contentSubject("a.ts"), contentSubject("a.ts")), true);
});

test("换文件 / 换来源 = 不是同一件事（旧正文必须清掉）", () => {
  const first = diffSubject({ path: "src/a.ts", source: "unstaged" });
  assert.equal(sameWorkspacePreviewSubject(first, diffSubject({ path: "src/b.ts", source: "unstaged" })), false);
  assert.equal(sameWorkspacePreviewSubject(first, diffSubject({ path: "src/a.ts", source: "staged" })), false);
  assert.equal(sameWorkspacePreviewSubject(contentSubject("a.ts"), contentSubject("b.ts")), false);
});

test("同一个文件从「看改动」切到「看正文」：不是同一件事", () => {
  assert.equal(
    sameWorkspacePreviewSubject(diffSubject({ path: "src/a.ts", source: "unstaged" }), contentSubject("src/a.ts")),
    false,
  );
  assert.equal(
    sameWorkspacePreviewSubject(contentSubject("src/a.ts"), diffSubject({ path: "src/a.ts", source: "unstaged" })),
    false,
  );
});

test("换 base 不算同一件事（屏上的 diff 里没有 base 字段，拿它比会骗过去）", () => {
  const main = diffSubject({ path: "src/a.ts", source: "branch", base: "main" });
  const dev = diffSubject({ path: "src/a.ts", source: "branch", base: "dev" });
  assert.equal(sameWorkspacePreviewSubject(main, dev), false);
  // 空 base 与「没给 base」是一回事（服务端会自己解上游）。
  assert.equal(
    sameWorkspacePreviewSubject(diffSubject({ path: "a.ts", source: "branch" }), diffSubject({ path: "a.ts", source: "branch", base: "  " })),
    true,
  );
  // 来源大小写/别名走 normalize（和 `normalizeWorkspaceDiffSource` 同一套）。
  assert.equal(
    sameWorkspacePreviewSubject(diffSubject({ path: "a.ts", source: "unstaged" }), diffSubject({ path: "a.ts", source: "nonsense" })),
    true,
    "未知来源会归一成默认来源，所以这两个是同一件事",
  );
});

test("null 的两侧：都是 null 算同一件事，一边是一边不是就不算", () => {
  assert.equal(sameWorkspacePreviewSubject(null, null), true);
  assert.equal(sameWorkspacePreviewSubject(null, contentSubject("a.ts")), false);
  assert.equal(sameWorkspacePreviewSubject(diffSubject({ path: "a.ts", source: "unstaged" }), null), false);
});

test("subject 的路径提取（预览头部 / IDE 打开用它）", () => {
  assert.equal(previewSubjectPath(diffSubject({ path: "src/a.ts", source: "staged" })), "src/a.ts");
  assert.equal(previewSubjectPath(contentSubject("src/b.ts")), "src/b.ts");
  assert.equal(previewSubjectPath(null), "");
});

test("两条查询串与服务端路由逐字对账（改一处忘另一处就会 404）", () => {
  assert.equal(
    buildWorkspaceDiffQuery({ projectId: "p", path: "a.ts", source: "staged" }),
    "/api/projects/git/diff?projectId=p&path=a.ts&source=staged",
  );
  assert.equal(
    buildWorkspaceChangedFilesQuery({ projectId: "p", sessionPath: "/tmp/wt", source: "branch" }),
    "/api/projects/git/files?projectId=p&source=branch&sessionPath=%2Ftmp%2Fwt",
  );
});
test("「本轮补丁」与「git 的未暂存改动」不是同一件事（同一个文件也要重读）", () => {
  const gitDiff = diffSubject({ path: "src/a.ts", source: "unstaged" });
  const turnPatch = diffSubject({ path: "src/a.ts", source: "unstaged", origin: "turn" });
  assert.equal(sameWorkspacePreviewSubject(gitDiff, turnPatch), false);
  assert.equal(sameWorkspacePreviewSubject(turnPatch, diffSubject({ path: "src/a.ts", source: "unstaged", origin: "turn" })), true);
});
