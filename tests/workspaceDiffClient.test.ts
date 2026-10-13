/**
 * 右面板改动预览的共享层（`src/shared/workspaceDiff.ts`）。
 *
 * 这里守的是「渲染层会不会说谎」：
 * - 非 patch 的正文必须被丢掉（truncated 是半个补丁，画出来就是假的完整改动）；
 * - 缺 path 的响应当「拿不到」处理（标题空白比报错更难解释）；
 * - 来源文案的 key 必须与服务端的 `diffSourceMessageId` 一致，且两包都真有文案 ——
 *   否则用户看到的来源是「另一个来源」的措辞。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { diffSourceMessageId } from "../server/workspaceDiff.mjs";
import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";
import {
  DEFAULT_WORKSPACE_DIFF_SOURCE,
  WORKSPACE_DIFF_SOURCES,
  buildWorkspaceDiffQuery,
  canRenderWorkspaceDiffPatch,
  normalizeWorkspaceDiffResponse,
  normalizeWorkspaceDiffSource,
  sameWorkspaceDiffSubject,
  workspaceDiffSourceLabelKey,
} from "../src/shared/workspaceDiff.ts";

const PATCH = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");

function patchResponse(overrides: Record<string, unknown> = {}) {
  return {
    path: "src/x.ts",
    source: "unstaged",
    availability: "patch",
    patch: PATCH,
    beforeContent: "old\n",
    afterContent: "new\n",
    added: 1,
    removed: 1,
    summary: null,
    ...overrides,
  };
}

test("来源枚举与服务端一致：缺省是 unstaged，未知值也落回它", () => {
  assert.deepEqual([...WORKSPACE_DIFF_SOURCES], ["unstaged", "staged", "branch"]);
  assert.equal(DEFAULT_WORKSPACE_DIFF_SOURCE, "unstaged");

  for (const value of [undefined, null, "", "last-turn", "Unstaged", 7, {}, []]) {
    assert.equal(normalizeWorkspaceDiffSource(value), "unstaged", `不该认成来源: ${String(value)}`);
  }
  for (const source of WORKSPACE_DIFF_SOURCES) {
    assert.equal(normalizeWorkspaceDiffSource(source), source);
  }
});

test("来源文案 key 与服务端同一张表，且两包都有文案", () => {
  for (const source of WORKSPACE_DIFF_SOURCES) {
    const key = workspaceDiffSourceLabelKey(source);
    assert.equal(key, diffSourceMessageId(source), `来源 ${source} 的文案 key 与服务端不一致`);
    assert.ok(key in zh, `zh.ts 缺 ${key}`);
    assert.ok(key in en, `en.ts 缺 ${key}`);
  }
});

test("查询串：中文路径 / 空格 / # 都要转义，空值不进串", () => {
  const query = buildWorkspaceDiffQuery({ projectId: "p1", path: "文档/说明 #1.md", source: "staged" });
  assert.ok(query.startsWith("/api/projects/git/diff?"));
  const params = new URLSearchParams(query.slice(query.indexOf("?") + 1));
  assert.equal(params.get("projectId"), "p1");
  assert.equal(params.get("path"), "文档/说明 #1.md", "转义错了服务端会拿到半个路径");
  assert.equal(params.get("source"), "staged");
  assert.equal(params.has("sessionPath"), false, "空会话路径不该出现在串里");
  assert.equal(params.has("base"), false);

  const withSession = buildWorkspaceDiffQuery({ projectId: "p1", sessionPath: "/tmp/wt", path: "a.ts", base: "main" });
  const withParams = new URLSearchParams(withSession.slice(withSession.indexOf("?") + 1));
  assert.equal(withParams.get("sessionPath"), "/tmp/wt");
  assert.equal(withParams.get("base"), "main");
});

test("响应归一化：patch 来源保留正文与统计", () => {
  const diff = normalizeWorkspaceDiffResponse(patchResponse());
  assert.ok(diff);
  assert.equal(diff.availability, "patch");
  assert.equal(diff.patch, PATCH);
  assert.equal(diff.beforeContent, "old\n");
  assert.equal(diff.afterContent, "new\n");
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.summary, null);
});

test("响应归一化：不是对象 / 缺 path 一律当拿不到（返回 null）", () => {
  for (const raw of [null, undefined, "nope", 42, [], {}, { path: "" }, { path: 7 }]) {
    assert.equal(normalizeWorkspaceDiffResponse(raw), null, `不该通过: ${JSON.stringify(raw)}`);
  }
});

test("响应归一化：没见过的 availability 降级成 unavailable 并丢掉正文", () => {
  const diff = normalizeWorkspaceDiffResponse(patchResponse({ availability: "who-knows" }));
  assert.ok(diff);
  assert.equal(diff.availability, "unavailable");
  assert.equal(diff.patch, null, "没见过的状态不许把正文画出来");
});

test("响应归一化：truncated / binary 即使带着正文也不画（那是半个补丁）", () => {
  for (const availability of ["truncated", "binary"]) {
    const diff = normalizeWorkspaceDiffResponse(patchResponse({ availability, summary: "too big" }));
    assert.ok(diff);
    assert.equal(diff.availability, availability);
    assert.equal(diff.patch, null);
    assert.equal(diff.summary, "too big", "原因要留着，右面板靠它说话");
  }
});

test("响应归一化：统计不是有限数就归零，summary 空串归 null", () => {
  const diff = normalizeWorkspaceDiffResponse(patchResponse({ added: Number.NaN, removed: "3", summary: "" }));
  assert.ok(diff);
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
  assert.equal(diff.summary, null);
});

test("只有 patch 来源且正文非空才可渲染", () => {
  assert.equal(canRenderWorkspaceDiffPatch(normalizeWorkspaceDiffResponse(patchResponse())), true);
  assert.equal(canRenderWorkspaceDiffPatch(null), false);
  assert.equal(canRenderWorkspaceDiffPatch(normalizeWorkspaceDiffResponse(patchResponse({ patch: null }))), false);
  assert.equal(canRenderWorkspaceDiffPatch(normalizeWorkspaceDiffResponse(patchResponse({ patch: "  \n" }))), false);
  assert.equal(
    canRenderWorkspaceDiffPatch(normalizeWorkspaceDiffResponse(patchResponse({ availability: "unavailable" }))),
    false,
  );
});

test("同一个「文件 + 来源 + base」的判定：决定重拉时要不要先清空", () => {
  const request = { path: "a.ts", source: "unstaged", base: "" };
  assert.equal(sameWorkspaceDiffSubject(request, { path: "a.ts" }), true, "缺省来源等价于 unstaged");
  assert.equal(sameWorkspaceDiffSubject(request, { path: "a.ts", source: "unstaged" }), true);
  assert.equal(sameWorkspaceDiffSubject(request, { path: "a.ts", source: "staged" }), false);
  assert.equal(sameWorkspaceDiffSubject(request, { path: "b.ts" }), false);
  assert.equal(sameWorkspaceDiffSubject(null, { path: "a.ts" }), false, "没有上一次请求时不算同一个");

  const onBranch = { path: "a.ts", source: "branch", base: "main" };
  assert.equal(sameWorkspaceDiffSubject(onBranch, { path: "a.ts", source: "branch", base: "main" }), true);
  assert.equal(
    sameWorkspaceDiffSubject(onBranch, { path: "a.ts", source: "branch", base: "dev" }),
    false,
    "换 base 必须清空，否则会把 main 的改动挂在 dev 标题下",
  );
});

test("客户端拼的接口与服务端路由逐字对得上（拼错就是静默 404）", () => {
  const indexSource = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const route = indexSource.indexOf('url.pathname === "/api/projects/git/diff"');
  assert.notEqual(route, -1, "服务端没有这条路由了");
  assert.equal(buildWorkspaceDiffQuery({ projectId: "p", path: "a" }).split("?")[0], "/api/projects/git/diff");

  // worktree 会话要读自己那份工作区，否则右面板显示的是主检出的改动。
  const handler = indexSource.slice(route, route + 700);
  assert.match(handler, /requestWorkspaceCwd\(project, \{ sessionPath \}\)/);
  assert.match(handler, /readFileDiff\(\{/);
});