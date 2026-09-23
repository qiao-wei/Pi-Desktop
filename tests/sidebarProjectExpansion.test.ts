/**
 * 在项目行点「新建会话」必须顺手把它展开：服务端已经选中了新会话，项目还收着的话
 * 侧栏里没有任何「点中了」的痕迹。这里测纯函数本身；App.tsx 的接线由
 * sidebarChatNavigation.test.ts 以源码断言兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { expandProjectForNewSession } from "../src/shared/sidebarProjectExpansion.ts";

test("adds the project to an empty set", () => {
  const expanded = expandProjectForNewSession(new Set<string>(), "project-a");
  assert.deepEqual([...expanded], ["project-a"]);
});

test("keeps the projects that were already expanded", () => {
  const expanded = expandProjectForNewSession(new Set(["project-a", "project-b"]), "project-c");
  assert.deepEqual([...expanded].sort(), ["project-a", "project-b", "project-c"]);
});

test("already expanded: returns the very same reference", () => {
  const current = new Set(["project-a", "project-b"]);
  const expanded = expandProjectForNewSession(current, "project-a");
  assert.equal(expanded, current, "已展开时不应新建 Set 触发整列重渲染");
});

test("does not mutate the input set", () => {
  const current = new Set(["project-a"]);
  expandProjectForNewSession(current, "project-b");
  assert.deepEqual([...current], ["project-a"], "调用方传进来的是 React state，不能原地改");
});
