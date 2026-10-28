/**
 * 真桥：快照只带尾部窗口，更早的历史按页取。
 *
 * 这条链路是"长会话不再每次落定都搬全量"的核心，而且三个环节各自在不同的文件里
 * （`conversationWindow.mjs` 切窗口 / `sessionSnapshots.mjs` 建快照 / `routesApp.mjs` 出接口），
 * 只测其中任何一个都证明不了另一端接上了。这里用真桥 + 假模型，直接读 HTTP。
 *
 * 轮数被 `PI_DESKTOP_CONVERSATION_TAIL_TURNS` 压到 2，否则要跑 61 轮才能看到窗口生效
 * ——测的还是同一段代码。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startE2E } from "../e2e/lib/bridge.mjs";

test("快照只带尾部窗口，GET /api/sessions/messages 按 beforeTurn 往前翻页", async () => {
  const e2e = await startE2E({
    env: { PI_DESKTOP_CONVERSATION_TAIL_TURNS: "2" },
    model: { chunkDelayMs: 0, firstTokenDelayMs: 0 },
  });
  try {
    await e2e.api.openProject(e2e.workspaceDir);
    await e2e.api.selectE2EModel();

    for (const input of ["one", "two", "three", "four"]) {
      const frames = await e2e.api.prompt(input);
      assert.equal(frames.at(-1)?.type, "done", `${input} 这一轮没有正常结束`);
    }

    const bootstrap = await e2e.api.get("/api/bootstrap");
    const conversation = bootstrap.snapshot.conversation;

    // 默认行为没变：`messages` 还是气泡数组，只是现在只有窗口内的。
    assert.equal(conversation.totalTurns, 4);
    assert.equal(conversation.oldestTurn, 3, "4 轮、窗口 2：窗口从第 3 轮开始");
    assert.equal(conversation.hasMoreBefore, true);
    assert.deepEqual(
      conversation.messages.map((bubble) => bubble.id),
      ["t3#user", "t3#assistant", "t4#user", "t4#assistant"],
      "窗口只截内容，气泡编号仍是绝对的",
    );
    // 字段齐全：走这条路的代码（assistant-ui、滚动锚定、合并）都假定它们存在。
    assert.equal(typeof conversation.messages[0]?.content, "string");

    // 统计是整份会话的数，不跟着窗口缩水（用量浮层要用）。
    assert.equal(bootstrap.snapshot.stats.turnCount, 4);
    assert.equal(bootstrap.snapshot.stats.userMessageCount, 4);

    const page = await e2e.api.get("/api/sessions/messages?beforeTurn=3&limit=2");
    assert.deepEqual(
      page.messages.map((bubble) => bubble.id),
      ["t1#user", "t1#assistant", "t2#user", "t2#assistant"],
    );
    assert.equal(page.oldestTurn, 1);
    assert.equal(page.hasMoreBefore, false);
    assert.equal(page.totalTurns, 4);

    // 到顶：空页而不是报错，也不是"把整份再发一遍"。
    const none = await e2e.api.get("/api/sessions/messages?beforeTurn=1&limit=2");
    assert.deepEqual(none.messages, []);
    assert.equal(none.hasMoreBefore, false);

    // 单页上限：要 10000 也只给 200 轮（这里总共 4 轮，但值必须被夹住而不是照抄）。
    const clamped = await e2e.api.get("/api/sessions/messages?beforeTurn=4&limit=10000");
    assert.equal(clamped.oldestTurn, 1);
    assert.equal(clamped.messages.length, 6);
  } catch (error) {
    const logs = e2e.logs();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.stdout}\n${logs.stderr}`);
  } finally {
    await e2e.stop();
  }
});