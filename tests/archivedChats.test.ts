/**
 * 设置 → 归档聊天 的纯逻辑（筛选 / 排序 / 按项目分组）。
 *
 * 组件本身是 .tsx，测试进程 import 不了；能真正跑断言的部分抽到了
 * `shared/archivedChats.ts`，这里覆盖「搜什么字段、排序方向、分组顺序」。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  archivedProjectOptions,
  filterArchivedSessions,
  groupArchivedSessions,
  NO_PROJECT_GROUP_KEY,
} from "../src/shared/archivedChats.ts";
import type { ArchivedSessionSummary } from "../src/types/domain.ts";

function session(overrides: Partial<ArchivedSessionSummary> & { path: string }): ArchivedSessionSummary {
  return {
    id: overrides.path,
    title: "Untitled",
    cwd: "/tmp/project",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    firstMessage: "",
    projectId: "p1",
    projectName: "Code",
    ...overrides,
  };
}

const sessions: ArchivedSessionSummary[] = [
  session({ path: "/a", title: "查一下 npm 打包", firstMessage: "查一下现在的 npm run electron", updatedAt: 100, projectId: "p2", projectName: "Docs" }),
  session({ path: "/b", title: "用 assistant-ui 重构", firstMessage: "重构聊天消息区", updatedAt: 300, projectId: "p1", projectName: "Code" }),
  session({ path: "/c", title: "hi", firstMessage: "hi", updatedAt: 200, projectId: "p1", projectName: "Code" }),
  session({ path: "/d", title: "orphan", firstMessage: "", updatedAt: 150, projectId: "", projectName: undefined }),
];

test("默认按最近更新倒序，并且不就地修改入参", () => {
  const snapshot = sessions.map((entry) => entry.path);
  const sorted = filterArchivedSessions(sessions);
  assert.deepEqual(sorted.map((entry) => entry.path), ["/b", "/c", "/d", "/a"]);
  assert.deepEqual(sessions.map((entry) => entry.path), snapshot, "排序必须复制数组，不能改动 bootstrap 快照");
});

test("oldest 排序方向相反", () => {
  assert.deepEqual(
    filterArchivedSessions(sessions, { sort: "oldest" }).map((entry) => entry.path),
    ["/a", "/d", "/c", "/b"],
  );
});

test("搜索命中标题与首条用户消息，大小写不敏感", () => {
  assert.deepEqual(
    filterArchivedSessions(sessions, { query: "NPM" }).map((entry) => entry.path),
    ["/a"],
  );
  assert.deepEqual(
    filterArchivedSessions(sessions, { query: "重构" }).map((entry) => entry.path),
    ["/b"],
  );
  // 前后空白要忽略，否则粘贴搜索词时永远搜不到。
  assert.deepEqual(
    filterArchivedSessions(sessions, { query: "  hi  " }).map((entry) => entry.path),
    ["/c"],
  );
});

test("按项目筛选，空 projectId 表示全部", () => {
  assert.deepEqual(
    filterArchivedSessions(sessions, { projectId: "p1" }).map((entry) => entry.path),
    ["/b", "/c"],
  );
  assert.deepEqual(
    filterArchivedSessions(sessions, { projectId: "" }).length,
    sessions.length,
  );
});

test("分组保持组内顺序，组顺序由每组第一条决定", () => {
  const groups = groupArchivedSessions(filterArchivedSessions(sessions));
  assert.deepEqual(
    groups.map((group) => group.projectName),
    ["Code", "", "Docs"],
    "无项目的组保留空 projectName，由组件回退到「无项目」文案",
  );
  assert.deepEqual(groups.map((group) => group.sessions.length), [2, 1, 1]);
  // 组键在项目 id 缺失时回退到固定 key，不能变成空串（否则多组会互相覆盖）。
  assert.equal(groups[1].key, NO_PROJECT_GROUP_KEY);
  assert.equal(groups[1].projectId, undefined);
});

test("项目下拉去重并按名称排序", () => {
  assert.deepEqual(archivedProjectOptions(sessions), [
    { id: "p1", name: "Code" },
    { id: "p2", name: "Docs" },
  ]);
});

test("空清单与全空查询都不炸", () => {
  assert.deepEqual(filterArchivedSessions([]), []);
  assert.deepEqual(groupArchivedSessions([]), []);
  assert.deepEqual(archivedProjectOptions([]), []);
});