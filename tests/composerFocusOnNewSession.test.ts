/**
 * 新建任务后光标要自动落到 composer。
 *
 * 背景（用户反馈）：点侧栏项目行的「＋」新建会话后，焦点还留在侧栏按钮上，
 * 想打字必须再点一次输入框。期望 bootstrap 落地（新会话被选中）后 composer
 * 的 contentEditable 自动获得焦点。
 *
 * 纯 node 环境跑不了真实焦点行为，按仓库惯例（chatTypography.test.ts 等）做
 * 「区域限定」的结构断言：先切出 createSessionFromSidebar / props 区间再检查，
 * 避免被同文件别处的写法假绿。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appTsx = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** 取 `start 标记` 到 `end 标记` 之间的源码区间，两边锚点都必须唯一。 */
function region(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  assert.ok(start >= 0, `找不到起始锚点: ${startMark}`);
  const end = source.indexOf(endMark, start);
  assert.ok(end > start, `找不到结束锚点: ${endMark}`);
  return source.slice(start, end);
}

test("侧栏新建会话后把焦点交回 composer（.then(onFocusComposer)）", () => {
  const fn = region(appTsx, "function createSessionFromSidebar", "async function selectSessionFromSidebar");
  // 必须挂在 onCreateSession 完成之后：createSession 里 replaceBootstrap 落地才算就绪，
  // 提前 focus 会被「capabilities → chat」的切换/inert 状态吃掉。
  assert.match(
    fn,
    /void onCreateSession\(projectId\)\.then\(\(\) => onFocusComposer\(\)\)/,
    "createSessionFromSidebar 应在 onCreateSession 完成后调用 onFocusComposer",
  );
  // onOpenChat 必须先于创建调用：capabilities 页开着时会话区是 inert，focus 无效。
  assert.ok(
    fn.indexOf("onOpenChat()") < fn.indexOf("onCreateSession(projectId)"),
    "onOpenChat() 应在 onCreateSession 之前调用",
  );
});

test("ProjectSidebar 声明并接收 onFocusComposer，App 用 composerEditorRef 实现它", () => {
  const propsType = region(appTsx, "onSelectSession: (projectId: string", 'activeMainView: "chat" | "capabilities";');
  assert.match(propsType, /onFocusComposer: \(\) => void;/, "props 类型要声明 onFocusComposer");

  const destructure = region(appTsx, "  onSelectSession,\n", "  activeMainView,\n  onOpenCapabilities,");
  assert.match(destructure, /onFocusComposer,/, "props 解构要包含 onFocusComposer");

  const usage = region(appTsx, 'onSelectSession={selectSession}', 'activeMainView={activeMainView}');
  assert.match(
    usage,
    /onFocusComposer=\{\(\) => composerEditorRef\.current\?\.focus\(\{ preventScroll: true \}\)\}/,
    "App 侧应把 onFocusComposer 实现为聚焦 composer 编辑器",
  );
});
