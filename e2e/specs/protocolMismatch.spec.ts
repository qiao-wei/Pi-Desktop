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
test("桥声明的投递档位认不出时，界面同样说人话（不是照着旧假设继续）", async ({ page, harness }) => {
  await page.route("**/api/protocol", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      // 版本对得上，只有档位是客户端没实现的那种：这正是"加字段不 bump 版本"之后会出现的形态。
      body: JSON.stringify({ protocolVersion: 1, deliveryProfile: "replayable" }),
    }),
  );

  await page.goto(harness.rendererUrl, { waitUntil: "domcontentloaded" });

  await expect(page.locator(".composer [role='textbox']")).toBeVisible({ timeout: 30_000 });
  const body = page.locator("body");
  await expect(body).toContainText(/Delivery profile mismatch/i, { timeout: 20_000 });
  await expect(body).toContainText(/replayable/);
  await expect(body).toContainText(/local-live/);
});

test("真桥声明的档位是客户端认识的那个：不该出现任何不匹配提示", async ({ page, harness }) => {
  await page.goto(harness.rendererUrl, { waitUntil: "domcontentloaded" });

  // 首屏画出来（说明握手过了），并且**没有**任何 mismatch 文案：
  // 这是"桥真的声明了 DELIVERY_PROFILE、客户端真的接受它"的唯一端到端证据。
  await expect(page.locator(".composer [role='textbox']")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText(/Delivery profile mismatch/i);
  await expect(page.locator("body")).not.toContainText(/Protocol mismatch/i);
});
