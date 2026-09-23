/**
 * Sidebar actions that land the user in a conversation must also move the main area
 * to the chat view.
 *
 * The Global skills &amp; packages page owns the main area while it is open, so a
 * project row's "New session" used to create the conversation and then sit there —
 * the only feedback was a row appearing in the sidebar. Same for switching a
 * conversation. These tests pin the wiring (App.tsx is a .tsx file, so it can only be
 * asserted as source under `node --test`):
 * - the sidebar's `onOpenChat` really selects the chat view;
 * - the new-session button goes through a handler instead of calling the action raw;
 * - that handler flips the view synchronously, before waiting on the server.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  // 先跳过参数表再数花括号：解构参数里的 `{}` 会被误当成函数体开头，
  // 而第一个 `\n  }\n` 也不是可靠终点（组件里有更早出现的 2 空格缩进闭合）。
  const openParen = appSource.indexOf("(", start);
  let depth = 0;
  let cursor = openParen;
  for (; cursor < appSource.length; cursor += 1) {
    if (appSource[cursor] === "(") depth += 1;
    if (appSource[cursor] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const openBrace = appSource.indexOf("{", cursor);
  assert.notEqual(openBrace, -1, `${name} body could not be delimited`);
  depth = 0;
  for (let index = openBrace; index < appSource.length; index += 1) {
    if (appSource[index] === "{") depth += 1;
    if (appSource[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return appSource.slice(openBrace, index + 1);
      }
    }
  }
  assert.fail(`${name} body never closes`);
}

test("the sidebar chat switch selects the chat view", () => {
  assert.match(appSource, /onOpenChat=\{\(\) => setActiveMainView\("chat"\)\}/);
});

test("the sidebar section titles come from the language pack", () => {
  const body = functionBody("ProjectSidebar");
  assert.match(body, /\{t\("sidebar\.pinned"\)\}/, "Pinned 标题应走 t()");
  assert.match(body, /\{t\("sidebar\.projects"\)\}/, "Projects 标题应走 t()");
  assert.doesNotMatch(body, />Pinned</, "Pinned 不应再硬编码");
  assert.doesNotMatch(body, />Projects</, "Projects 不应再硬编码");
});

test("the project row's new-session button goes through the sidebar handler", () => {
  const rowStart = appSource.indexOf('"group relative"');
  assert.notEqual(rowStart, -1, "project row markup changed");
  // The row now also has an earlier `isExpanded ?` (the folder icon), so delimit at the
  // end of the project section instead of the first expansion check.
  const rowBlock = appSource.slice(rowStart, appSource.indexOf("</section>", rowStart));
  assert.match(rowBlock, /aria-label=\{t\("sidebar\.newSession"\)\}/, "new-session button markup changed");
  // 「＋」一次点击就建会话（会先把主区域切到 chat）；⌥/Alt 点击才是 worktree。
  assert.match(
    rowBlock,
    /onClick=\{\(event\) => createSessionFromSidebar\(project\.id, event\.altKey \? \{ worktree: true \} : undefined\)\}/,
    "the new-session button must route through the handler that switches the view",
  );
});

test("opening a conversation from the sidebar flips the view before awaiting the server", () => {
  const handlers: Array<[name: string, action: string]> = [
    ["createSessionFromSidebar", "onCreateSession("],
    ["selectSessionFromSidebar", "onSelectSession("],
  ];

  for (const [handler, action] of handlers) {
    const body = functionBody(handler);

    // 只数语句行，不数注释里的 `onOpenChat()` —— 下面的注释会提到它（自 363c473
    // composer-focus 起把注释也数进去了，测试一直是红的，实现是对的）。
    const calls = [...body.matchAll(/^\s*onOpenChat\(\);/gm)];
    assert.equal(
      calls.length,
      1,
      `${handler} should switch to chat exactly once`,
    );

    const openAt = calls[0].index ?? -1;
    const actionAt = body.indexOf(action);
    assert.ok(openAt >= 0, `${handler} never switches to the chat view`);
    assert.ok(actionAt >= 0, `${handler} lost its ${action} call`);
    assert.ok(openAt < actionAt, `${handler} must switch the view, then load the conversation`);
    assert.ok(
      !/\bawait\b/.test(body.slice(0, openAt)),
      `${handler} awaits before switching — the jump would lag behind the click`,
    );
  }
});

test("creating a session from a collapsed project expands it right away", () => {
  const body = functionBody("createSessionFromSidebar");

  assert.match(
    body,
    /setExpandedProjectIds\(\(current\) => expandProjectForNewSession\(current, projectId\)\)/,
    "新建会话后项目要自动展开，否则被选中的新会话藏在收起的项目里",
  );
  assert.ok(
    !/\bawait\b/.test(body.slice(0, body.indexOf("expandProjectForNewSession"))),
    "展开必须在等待服务端之前发生，不能等创建回包",
  );
});
