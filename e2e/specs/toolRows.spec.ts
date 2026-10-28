import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
 * 表头文案：运行中是「工作中 N 秒」，落定是「已工作 N 秒」（ZCode 的
 * `chat.history.workingFor` / `workedFor`）。
 *
 * 时长来自**转录自己的时间戳**（`chatTurnTiming.ts`：首条条目 → 末条条目），不是客户端
 * 现算的 —— 所以历史消息打开后照样有（见下面那条 reload 用例）。假模型一轮不到 1 秒，
 * 于是按 `Math.max(1, …)` 显示「1 秒」；拿不到时间戳时才会退回无时长的「思考过程」。
 */
const RUNNING_HEADER = /^(工作中|工作中 \d+ 秒)$/;
const PROCESS_HEADER = /^(已工作 \d+ 秒|思考过程)$/;
const SETTLED_HEADER = /^已工作 \d+ 秒$/;

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

  // 摘要行：图标 + 动作词 + 文件名 + diff 计数。动作词来自**工具名**（`edit` 就是 Edit）：
  // 「只插入几行」的补丁和「write 覆盖成超集」形状一样，形状不能当证据。
  const row = page.locator('[data-slot="tool-row"]').filter({ hasText: "demo.ts" }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("demo.ts");
  await expect(row).toContainText("+1");
  await expect(row).toContainText("−1");
  // 文件就在项目根：路径要显示项目文件夹名，而不是空着（用户报过「还是没有路径」）。
  await expect(row.locator('[data-slot="tool-row-path"]')).toHaveText(/^[^/]+\/$/);

  // 收起态：正文不在 DOM 里（不是 visibility:hidden），也是 ZCode 的行为。
  await expect(page.locator("[data-diff-line]")).toHaveCount(0);

  // 展开：diff 行按 added/removed 分类着色，且没有 `+`/`-` 前缀字符
  //（ZCode 用色块 + 行号表达，前缀字符是旧实现的写法）。
  // 点行的图标一端（不是文件名：名字是打开右面板的链接）。'[role="button"]' 的中心点
  // 现在落在名字上，所以显式给位置。
  await row.locator('[role="button"]').click({ position: { x: 6, y: 8 } });
  const added = page.locator('[data-diff-line="added"]');
  await expect(added).toContainText("beta");
  await expect(page.locator('[data-diff-line="removed"]')).toContainText("alpha");
  await expect(added).not.toContainText("+beta");

  // 第二轮（拿到工具结果之后的文本）真的到达了：这一轮没有卡在工具那一跃。
  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 30_000,
  });
  await turnFinished(page);

  // 落定后过程区先自动折叠、行也退场了；截图要看的是**用户点开之后**的样子
  // （「编辑 demo.ts · 项目名/ +1 −1」和真正的内联 diff），所以再展开一次。
  await expandProcessRegion(page);
  await page.locator('[data-slot="tool-row"]').filter({ hasText: "demo.ts" }).first()
    .locator('[role="button"]').click({ position: { x: 6, y: 8 } });
  await expect(page.locator("[data-diff-line]", { hasText: "beta" }).first()).toBeVisible();
  await page.waitForTimeout(400);
  await shoot(page, "tool-row-edit-light");
  // 走应用自己的主题开关（而不是往 <html> 上贴 class）：截图拍的必须是用户能到达的状态。
  await page.getByRole("button", { name: "切换到深色主题" }).click();
  await page.waitForTimeout(200);
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
  // 真实的「持续了 N 秒」，不是无时长兜底（用户 2026-10-27 实测到的一直是后者）。
  await expect(finalTrigger).toContainText(/持续了\s*\d+\s*秒/);
  await expect(finalTrigger).not.toContainText("几秒");
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


/**
 * 用户 2026-10-27 的反馈：「打开历史消息时，上面的时间都没了」。
 *
 * 时长的来源必须是**转录**而不是「这个客户端刚才看了多久的流」——reload 之后没有任何
 * 流式事件，只有条目时间戳，所以这条用例是「时长来源对不对」的唯一硬证据。
 */
test("历史消息（重新载入后）过程区表头仍然有真实时长", async ({ page, harness }) => {
  await openProject(page, harness);
  await sendMessage(page, "E2E-TOOL-BASH 跑一条命令");

  const region = page.locator('[data-slot="aui_process-group"]').last();
  await expect(region.locator("> div > button")).toHaveText(SETTLED_HEADER, { timeout: 30_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForFirstPaint(page);

  // 重新载入 = 纯历史：没有 timing、没有 delta，语义与「打开旧会话」完全相同。
  const restored = page.locator('[data-slot="aui_process-group"]').last();
  await expect(restored.locator("> div > button")).toHaveText(SETTLED_HEADER, { timeout: 30_000 });
  await expect(restored).not.toHaveAttribute("data-live", "true");
  await shoot(page, "process-region-history");
});

/**
 * 文件名与路径分工（ZCode 的 `renderFileChip` vs `renderFilePath`）：
 * 点名字 → 右面板打开这个文件；点路径 → 展开内联正文。
 */
test("点文件名在右面板打开文件，点路径展开内联 diff", async ({ page, harness }) => {
  await openProject(page, harness);
  mkdirSync(join(harness.workspaceDir, "src/notes"), { recursive: true });
  writeFileSync(join(harness.workspaceDir, "src/notes/demo.ts"), "const greek = 'alpha';\n");

  await sendMessage(page, "E2E-TOOL-EDIT-NESTED 改一下嵌套目录里的文件");
  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 30_000,
  });
  await turnFinished(page);
  await expandProcessRegion(page);

  const row = page.locator('[data-slot="tool-row"]').last();
  const name = row.locator('[data-slot="tool-row-file-link"]');
  const path = row.locator('[data-slot="tool-row-path"]');
  // 名字与路径分开显示：项目内路径折成相对路径。
  await expect(name).toHaveText("demo.ts");
  await expect(path).toHaveText("src/notes/");

  // 点名字：右面板出现这个文件的 tab，且**没有**因此展开内联正文。
  await name.click();
  await expect(page.getByRole("tab", { name: /demo\.ts/ })).toHaveAttribute("aria-selected", "true");
  await expect(row.locator('[data-slot="diff-body"]')).toHaveCount(0);

  // 点路径：内联展开，右面板那张 tab 保持不变。
  await path.click();
  await expect(row.locator('[data-slot="diff-body"]')).toBeVisible();
  await expect(row.locator('[role="button"]')).toHaveAttribute("aria-expanded", "true");
  await page.waitForTimeout(500);
  await expect(row.locator('[data-slot="diff-body"]')).toBeVisible();
  await expect(page.getByRole("tab", { name: /demo\.ts/ })).toHaveAttribute("aria-selected", "true");
  await shoot(page, "tool-row-file-vs-path");
});

/**
 * 用户 2026-10-27 的反馈：「thinking 在展开的时候没有自动跟随（流式输出思考的时候）」。
 *
 * 展开的正文是限高滚动区：新 token 必须把视野推到末尾，否则读者盯着一段不动的旧文本。
 * 假模型流 40 行（> max-h-60），用例在流式途中点开，等正文超过限高后量 `scrollTop`。
 */
test("展开的思考正文跟着流式输出吸底", async ({ page, harness }) => {
  await openProject(page, harness);
  await sendMessage(page, "E2E-THINK-LONG 想一想");

  const trigger = page.locator('[data-slot="thinking-trigger"]').last();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  const body = page.locator('[data-slot="thinking-text"]').last();
  await expect(body).toBeVisible();

  // 等到正文真的超过限高（这时"跟随"才有意义），且仍在流式里。
  await expect
    .poll(async () => body.evaluate((node) => node.scrollHeight - node.clientHeight), { timeout: 20_000 })
    .toBeGreaterThan(0);

  const distance = await body.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
  assert.ok(distance <= 4, `展开的思考正文没有吸底：距底 ${distance}px`);

  // 还在流式（否则下面两条断言会变成空话）。
  await expect(trigger).toContainText("正在思考");

  // 读者自己往上滚 → 停止跟随：后续 chunk 不许把他拉回去。
  await body.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(body).toHaveAttribute("data-scroll-mask", "bottom");
  await page.waitForTimeout(800);
  const stayed = await body.evaluate((node) => node.scrollTop);
  assert.ok(stayed < 24, `读者上滚后仍被拉回底部（scrollTop=${stayed}）`);

  // 滚回底部 → 恢复跟随。
  await body.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(800);
  const resumed = await body.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
  assert.ok(resumed <= 4, `滚回底部后没有恢复跟随（距底 ${resumed}px）`);
});
