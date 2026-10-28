import { expect, test } from "@playwright/test";

import { startE2E } from "../lib/bridge.mjs";
import { startViteDevServer } from "../lib/vite.mjs";
import { sendMessage, waitForFirstPaint } from "../lib/fixtures";

/**
 * 长会话的窗口化历史：**翻出来的旧消息不能被下一次快照删掉**。
 *
 * 这条用例自带一套桥 + 渲染进程（而不是用 worker 夹具），因为它必须把
 * `PI_DESKTOP_CONVERSATION_TAIL_TURNS` 压到 2：默认 60 轮的窗口要跑 61 轮对话才能看到效果，
 * 那是同一个 bug 的更慢版本。用例里 5 轮就够暴露三件事：
 *
 * 1. 快照只带窗口 → 首屏没有第 1 轮；
 * 2. 点「加载更早的消息」→ 第 1 轮补进来；
 * 3. **再跑一轮**（快照窗口滑到 3..5）→ 第 1 轮必须还在。
 *
 * 第 3 步是重点：没有 `mergeChatBubbles` 的 `window` 参数，每次落定都会把用户刚翻出来的
 * 历史当成"服务端删掉了"而清空——旧实现里这正是"往上翻了一下又弹回来"的来源。
 */
test("窗口化历史：加载更早之后，新一轮快照不会把它删掉", async ({ page }) => {
  const e2e = await startE2E({
    env: { PI_DESKTOP_CONVERSATION_TAIL_TURNS: "2" },
    model: { chunkDelayMs: 5, firstTokenDelayMs: 5 },
  });
  const vite = await startViteDevServer(e2e.apiBase);
  try {
    await page.goto(vite.url.replace(/\/$/, "") + "/", { waitUntil: "domcontentloaded" });
    await waitForFirstPaint(page);
    const projectId = await e2e.api.openProject(e2e.workspaceDir);
    await e2e.api.selectE2EModel({ projectId });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForFirstPaint(page);

    for (const input of ["第一轮", "第二轮", "第三轮", "第四轮"]) {
      const frames = await e2e.api.prompt(input);
      expect(frames.at(-1)?.type).toBe("done");
    }

    // 重新载入：走 bootstrap（不是流），于是首屏看到的就是"窗口里有什么"。
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForFirstPaint(page);

    const bubbles = page.locator("[data-message-id]");
    await expect(bubbles).toHaveCount(4, { timeout: 15_000 }); // 第 3、4 轮 × (问 + 答)
    await expect(page.getByText("第一轮", { exact: true })).toHaveCount(0);

    const loadOlder = page.getByRole("button", { name: "加载更早的消息" });
    await expect(loadOlder).toBeVisible();
    await loadOlder.click();

    await expect(bubbles).toHaveCount(8, { timeout: 15_000 }); // 四轮全在
    await expect(page.getByText("第一轮", { exact: true })).toHaveCount(1);
    // 到顶了：按钮消失，而不是留一个点了没反应的入口。
    await expect(loadOlder).toHaveCount(0);

    // 第 5 轮**从 UI 发**：这一轮的 `done` 前服务端会再发一次全量快照（窗口变成 3..5），
    // 第 1、2 轮此时只能靠客户端的窗口合并保住——这是整条用例的重点。
    await sendMessage(page, "第五轮");
    await expect(page.getByText("第五轮", { exact: true })).toHaveCount(1, { timeout: 30_000 });
    // 落定时过程区会折叠（300ms 动画），让它先稳定再数。
    await expect(page.locator(".composer .send-button")).toHaveAttribute("aria-label", "Send", { timeout: 30_000 });
    await page.waitForTimeout(500);
    await expect(bubbles).toHaveCount(10, { timeout: 15_000 });
    await expect(page.getByText("第一轮", { exact: true })).toHaveCount(1);
    await expect(page.getByText("第五轮", { exact: true })).toHaveCount(1);
  } catch (error) {
    const logs = e2e.logs();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n--- bridge stdout ---\n${logs.stdout}\n--- bridge stderr ---\n${logs.stderr}`,
    );
  } finally {
    await vite.stop();
    await e2e.stop();
  }
});