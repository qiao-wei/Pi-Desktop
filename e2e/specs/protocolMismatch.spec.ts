import { expect, test } from "../lib/fixtures";

/**
 * 协议版本不匹配：界面必须**说人话**，不能白屏、不能只往控制台里扔一行。
 *
 * 用拦截 `/api/protocol` 来造这个场面（而不是给桥加一个"测试用版本号"环境变量）：
 * 生产代码里不需要为测试留后门，而"对面公告了一个对不上的版本"本来就是网络这一层的事实。
 */
test("桥公告了不认识的协议版本时，界面给出可操作的提示而不是白屏", async ({ page, harness }) => {
  await page.route("**/api/protocol", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      // 比本 UI 新：文案走 protocolMismatchMessage 的 "newer" 分支。
      body: JSON.stringify({ protocolVersion: 9999 }),
    }),
  );

  const consoleText: string[] = [];
  page.on("console", (message) => consoleText.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => consoleText.push(`[pageerror] ${error.message}`));

  await page.goto(harness.rendererUrl, { waitUntil: "domcontentloaded" });

  // 没有白屏：应用外壳（侧栏 + 输入框）仍然画出来了。
  await expect(page.locator(".composer [role='textbox']")).toBeVisible({ timeout: 30_000 });

  // 而且这件事被说出来了：可操作的那句话（含双方各自的版本号）。
  const body = page.locator("body");
  await expect(body).toContainText(/Protocol mismatch/i, { timeout: 20_000 });
  await expect(body).toContainText(/9999/);
  await expect(body).toContainText(/rebuild|reload|Restart|restart/i);

  expect(harness.apiBase).not.toBe("");
  expect(consoleText.join("\n")).not.toContain("Cannot read properties of undefined");
});