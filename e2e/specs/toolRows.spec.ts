import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, sendMessage, test, waitForFirstPaint, type Harness } from "../lib/fixtures";

/**
 * 过程行的端到端验收（思考行 + 工具行）。
 *
 * 这里**不造假 transcript**：假模型端点回一个真的 `edit` / `bash` 工具调用，pi 真执行它，
 * 桥真把结果转发到渲染进程 —— 于是"行画成什么样"建立在真实的结果信封上（`edit` 的
 * `details.patch`、`bash` 的 `structuredContent.exit_code`）。手工拼一份假的 process 块
 * 会把投影层（`toolDisplay` 的派生）与渲染层一起绕过，那正是这两块最需要被看到的地方。
 *
 * 截图落在 `e2e/.screenshots/`，是**验收证据**而不是仓库里的测试产物：布局这种事只能看，
 * 但它不稳定（字体、滚动条、动画帧），所以不进 CI 断言。
 */
const SCREENSHOT_DIR = new URL("../.screenshots/", import.meta.url).pathname;

/** 等这一轮真的结束：截图要拍的是静止态，不是"末尾还在补字"的中间帧。 */
async function turnFinished(page: import("@playwright/test").Page) {
  await expect(page.locator(".composer .send-button")).toHaveAttribute("aria-label", "Send", {
    timeout: 30_000,
  });
  // 折叠动画 300ms（与 CONTENT_UNMOUNT_DELAY_MS 一致）：不等它，截图会拍到被裁一半的正文。
  await page.waitForTimeout(400);
}

/** 浅色 / 深色各截一张：两套 token 是分开定义的（见 toolRow.test.ts 的 token 用例）。 */
async function shoot(page: import("@playwright/test").Page, name: string) {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`), fullPage: false });
}

async function openProject(page: import("@playwright/test").Page, harness: Harness) {
  await page.goto(harness.rendererUrl.replace(/\/$/, "") + "/", { waitUntil: "domcontentloaded" });
  await waitForFirstPaint(page);
  const projectId = await harness.api.openProject(harness.workspaceDir);
  await harness.api.selectE2EModel({ projectId });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForFirstPaint(page);
}



/**
 * 表头文案：有 `message.metadata.timing` 时是「已工作 N 秒」/「工作中 N 秒」（对齐 ZCode 的
 * `chat.history.workedFor`/`workingFor`），拿不到时长时退回 ZCode 自己的无时长标签
 *（「思考过程」/`labels.history`）。**Pi Desktop 目前从不写 `metadata.timing`**（本仓没有任何
 * 写入点），所以这里两条都接得住 —— 假模型跑完不到 1 秒，本来也量不出有意义的时长。
 * 真要把「已工作 58 秒」做实，需要一个真实时长来源（见 ADR-006「后果」）。
 */
const RUNNING_HEADER = /^(工作中 \d+ 秒|工作中)$/;
const PROCESS_HEADER = /^(已工作 \d+ 秒|思考过程)$/;

/**
 * 整轮结束后，过程区会**自动折叠**成一行「已工作 N 秒」（ZCode 的 turn history header
 * `chat.history.workedFor`，见 docs/adr/ADR-006）。所以落定之后再碰行，得先把区域点开 ——
 * 这本身就是要验的行为：折叠是真的、点开也是真的。
 */
async function expandProcessRegion(page: import("@playwright/test").Page) {
  const header = page.locator('[data-slot="aui_process-group"] > div > button').last();
  await header.click();
  return header;
}

test("edit 行：摘要行说出动作与文件，展开是内联 diff", async ({ page, harness }) => {
  writeFileSync(join(harness.workspaceDir, "demo.ts"), "const greek = 'alpha';\n");
  await openProject(page, harness);

  await sendMessage(page, "E2E-TOOL-EDIT 改一下 demo.ts");

  // 摘要行：图标 + 动作词 + 文件名 + diff 计数。动作词是**从 diff 形状推出来的**
  // （全新增=write，全替换=edit），不是从工具名照抄。
  const row = page.locator('[data-slot="tool-row"]').filter({ hasText: "demo.ts" }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("demo.ts");
  await expect(row).toContainText("+1");
  await expect(row).toContainText("−1");

  // 收起态：正文不在 DOM 里（不是 visibility:hidden），也是 ZCode 的行为。
  await expect(page.locator("[data-diff-line]")).toHaveCount(0);

  // 展开：diff 行按 added/removed 分类着色，且没有 `+`/`-` 前缀字符
  //（ZCode 用色块 + 行号表达，前缀字符是旧实现的写法）。
  await row.locator('[role="button"]').click();
  const added = page.locator('[data-diff-line="added"]');
  await expect(added).toContainText("beta");
  await expect(page.locator('[data-diff-line="removed"]')).toContainText("alpha");
  await expect(added).not.toContainText("+beta");

  // 第二轮（拿到工具结果之后的文本）真的到达了：这一轮没有卡在工具那一跃。
  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 30_000,
  });
  await turnFinished(page);

  await shoot(page, "tool-row-edit-light");
  // 走应用自己的主题开关（而不是往 <html> 上贴 class）：截图拍的必须是用户能到达的状态。
  await page.getByRole("button", { name: "切换到深色主题" }).click();
  await shoot(page, "tool-row-edit-dark");
  await page.getByRole("button", { name: "切换到浅色主题" }).click();
});

test("bash 行：展开是终端正文，含 $ 提示符与输出", async ({ page, harness }) => {
  await openProject(page, harness);

  await sendMessage(page, "E2E-TOOL-BASH 跑一条命令");

  const row = page.locator('[data-slot="tool-row"]').filter({ hasText: "printf" }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });

  await row.locator('[role="button"]').click();
  // 输出那一段是 `pre.text-foreground-subtle`（命令本身也是一个 `pre`，所以按类名限定）。
  const body = page.locator("pre.text-foreground-subtle").filter({ hasText: "e2e-stdout-line" });
  await expect(body).toHaveCount(1);
  await expect(body).toBeVisible();
  await expect(page.locator("span").filter({ hasText: /^\$$/ }).first()).toBeVisible();

  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 30_000,
  });
  await turnFinished(page);

  await shoot(page, "tool-row-bash-light");
});
test("思考行：默认收起、单行尾巴、落定后给时长", async ({ page, harness }) => {
  await openProject(page, harness);

  await sendMessage(page, "E2E-THINK 说说你怎么想的");

  const trigger = page.locator('[data-slot="thinking-trigger"]').last();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  // 运行中：标签是「正在思考」，尾巴是**最后一行**（不是开头那句）。
  await expect(trigger).toContainText("正在思考");
  await expect(trigger.locator("[data-reasoning-streaming-line]")).toBeAttached();

  // 收起态：思考行自己的正文不在 DOM 里 —— 行默认收起，只有读者点它才开。
  await expect(page.locator('[data-slot="thinking-text"]')).toHaveCount(0);

  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 30_000,
  });
  await turnFinished(page);

  // 落定后整轮的过程区先自动折叠：行退场，只剩「已工作 N 秒」的表头。
  const header = await expandProcessRegion(page);
  await expect(header).toHaveText(PROCESS_HEADER);
  const finalTrigger = page.locator('[data-slot="thinking-trigger"]').last();
  await expect(finalTrigger).toBeVisible();

  // 展开区域后：不再是 shimmer，而是「思考 · N 秒」；尾巴消失（只剩展开按钮）。
  await expect(finalTrigger).toContainText("思考");
  await expect(finalTrigger).toContainText("秒");
  await expect(finalTrigger.locator("[data-reasoning-streaming-line]")).toHaveCount(0);

  // 展开：正文是纯文本左导轨。
  await finalTrigger.click();
  const body = page.locator('[data-slot="thinking-text"]');
  await expect(body).toBeVisible();
  await expect(body).toContainText("然后这是思考的尾巴");
  // 展开状态必须**挺过**落定之后的重投影：轮次结束时快照会替换流式块，若行是按
  // 「新 key 重建」的，读者刚展开的行会在收尾那一刻自己合上。
  await page.waitForTimeout(600);
  await expect(finalTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();

  await shoot(page, "thinking-row-light");
  await page.getByRole("button", { name: "切换到深色主题" }).click();
  await shoot(page, "thinking-row-dark");
  await page.getByRole("button", { name: "切换到浅色主题" }).click();
});

/**
 * 行与行、行与正文的间距**是同一个值** —— 用户 2026-10-27 给的 ZCode 截图就是这条：
 * 「思考 · 查阅 · 思考 · 终端」和正文混在一条时间线上，块与块的间隔一致。
 *
 * 这条断言必须量真实布局：以前行组自带 `gap-1.5`(6px)、正文靠段落外边距，
 * 两者在源码里各自看着都合理，只有在浏览器里量出来才知道不一致。
 */
test("相邻过程行之间、行与正文之间的间距一致（16px）", async ({ page, harness }) => {
  await openProject(page, harness);

  await sendMessage(page, "E2E-THINK E2E-TOOL-BASH 先想一下再跑命令");

  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 30_000,
  });
  await turnFinished(page);
  // 量间距要在展开态：区域落定后是折起来的。
  await expandProcessRegion(page);

  const thinking = page.locator('[data-slot="thinking-trigger"]').last();
  const tool = page.locator('[data-slot="tool-row"] [role="button"]').last();
  await expect(thinking).toBeVisible({ timeout: 30_000 });
  await expect(tool).toBeVisible({ timeout: 30_000 });

  const answer = page.locator('[data-slot="aui_assistant-message-content"] p').last();
  const [thinkingBox, toolBox, answerBox] = await Promise.all([
    thinking.boundingBox(),
    tool.boundingBox(),
    answer.boundingBox(),
  ]);
  assert.ok(thinkingBox && toolBox && answerBox, "三个元素都应有布局盒");

  const GAP = 16;
  const rowGap = toolBox.y - (thinkingBox.y + thinkingBox.height);
  const textGap = answerBox.y - (toolBox.y + toolBox.height);
  // 允许 1px 取整误差：量的是 getBoundingClientRect 的浮点值。
  assert.ok(
    Math.abs(rowGap - GAP) <= 1,
    `思考行与工具行之间应为 ${GAP}px，实测 ${rowGap.toFixed(1)}px`,
  );
  assert.ok(
    Math.abs(textGap - GAP) <= 1,
    `工具行与正文之间应为 ${GAP}px，实测 ${textGap.toFixed(1)}px`,
  );

  await shoot(page, "row-rhythm-light");
});


/**
 * 用户 2026-10-27 的验收点：**思考和工具的区域在整轮结束时自己折叠**。
 *
 * 这正是 ZCode 的 turn history：运行中默认展开（否则读者根本看不到工具在跑），
 * 答案写完就折成一行「已工作 N 秒」，点一下能再打开。旧实现（`PiDesktopProcessGroup`）
 * 就是这套逻辑，行改成 ZCode 语法后被一起丢掉了 —— 这条用例把它钉回来。
 */
test("整轮结束时过程区自动折叠成一行「已工作 N 秒」", async ({ page, harness }) => {
  await openProject(page, harness);

  await sendMessage(page, "E2E-TOOL-BASH 跑一条命令");

  const region = page.locator('[data-slot="aui_process-group"]').last();
  const header = region.locator("> div > button");
  // 运行中：区域是展开的（data-live），行真的在 DOM 里。
  await expect(region.locator('[data-slot="tool-row"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(region).toHaveAttribute("data-live", "true");
  await expect(header).toHaveText(RUNNING_HEADER);

  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 30_000,
  });
  await turnFinished(page);

  // 落定后：自动折叠。表头换成「已工作 N 秒」，行退场。
  await expect(region).not.toHaveAttribute("data-live", "true");
  await expect(header).toHaveText(PROCESS_HEADER);
  await expect(region.locator('[data-slot="tool-row"]')).toHaveCount(0);
  // 折叠时必须没有把答案顶走：正文还在，且仍是贴底状态。
  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done");

  // 点开：行回来，且表头/分隔线仍在（ZCode 的表头是常驻行）。
  await header.click();
  await expect(region.locator('[data-slot="tool-row"]')).toHaveCount(1);
  await expect(header).toHaveText(PROCESS_HEADER);

  await shoot(page, "process-region-expanded");
  await page.getByRole("button", { name: "切换到深色主题" }).click();
  await shoot(page, "process-region-expanded-dark");

  // 再点一次：又折回去。
  await header.click();
  await expect(region.locator('[data-slot="tool-row"]')).toHaveCount(0);
  await page.waitForTimeout(400);
  await shoot(page, "process-region-folded-dark");
  await page.getByRole("button", { name: "切换到浅色主题" }).click();
  await turnFinished(page);
  await shoot(page, "process-region-folded");
});
