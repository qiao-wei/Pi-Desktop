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

  // 第二轮（拿到工具结果之后的文本）真的到达了：这一轮没有卡在工具那一跃。
  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 30_000,
  });
  await turnFinished(page);
  // 落定后过程区自动折叠、行跟着退场。先点开它 —— 这里要验的是**行的语法**，
  // 不是「流式途中它恰好在某个时刻可点」（后者是另一条用例的事，也很容易踩到
  // 「轮次已经收尾、区域已折叠」这个瞬间）。
  await expandProcessRegion(page);

  // 摘要行：图标 + 动作词 + 文件名 + diff 计数。动作词来自**工具名**（`edit` 就是 Edit）：
  // 「只插入几行」的补丁和「write 覆盖成超集」形状一样，形状不能当证据。
  const row = page.locator('[data-slot="tool-row"]').filter({ hasText: "demo.ts" }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
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

  // 第二遍：语法高亮是**异步补**的（ZCode 同款，先纯文本首帧，token 到了才换上）。
  // 所以这里轮询 —— 断言的是"最终会有颜色"，不是"点开那一帧就有"。
  await expect
    .poll(
      async () =>
        page
          .locator('[data-slot="diff-body"] [data-diff-highlight] span[style*="color"]')
          .count(),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  await page.waitForTimeout(400);
  await shoot(page, "tool-row-edit-light");
  // 走应用自己的主题开关（而不是往 <html> 上贴 class）：截图拍的必须是用户能到达的状态。
  await page.getByRole("button", { name: "切换到深色主题" }).click();
  await page.waitForTimeout(200);
  await shoot(page, "tool-row-edit-dark");
  await page.getByRole("button", { name: "切换到浅色主题" }).click();
});

/**
 * 写大文件时，行里的 `+N` 是**边流边涨**的（ZCode 的形态），不是等工具跑完一次性出现。
 *
 * 这条必须在真浏览器里量：数字来自「参数文本已到达多少」→ 投影层的节流重算 → 行的
 * `DiffCount`。单元测试钉得住解析与节流，但「用户看得见它涨」只能端到端验。
 */
test("write 大文件：参数还在流的时候 +N 就在涨（覆盖既有文件时还给出 −M）", async ({ page, harness }) => {
  // 先放一份**已有内容**的文件：`−M` 只能来自写入前的正文，所以这条同时验「基线真的读到了」。
  writeFileSync(join(harness.workspaceDir, "notes.md"), Array.from({ length: 5 }, (_, index) => `旧第 ${index + 1} 行`).join("\n") + "\n");
  await openProject(page, harness);

  await sendMessage(page, "E2E-TOOL-WRITE 写一个说明文件");

  const row = page.locator('[data-slot="tool-row"]').filter({ hasText: "notes.md" }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });

  // 运行态：动作词是「正在写入」并带扫光。这是用户报的 bug（跑起来永远显示「写入」、
  // 一点光都没有）：`status` 没接进来 ⇒ running 恒为 false。断言分两半 —— 文案、以及
  // 那个 span 真的在跑 `tw-shimmer` 动画（只有类名不算，CSS 可能被覆盖）。
  const kind = row.locator('[data-slot="tool-row-kind"]');
  await expect(kind).toContainText(/正在写入/);
  // 用字符串形式的 evaluate：e2e 参与 `tsc -p tsconfig.node-runtime.json`，那份配置
  // 没有 DOM lib，写成函数就会在 node 侧类型检查里报 `getComputedStyle` 未定义。
  const live = await kind.evaluate((element) => {
    // `getComputedStyle` 这个全局在 e2e 的 node 侧类型检查里不存在（那份 tsconfig 没有
    // DOM lib），所以走元素自己的 window。写成函数（而不是字符串）才有真实返回值。
    const style = element.ownerDocument.defaultView!.getComputedStyle(element);
    return {
      animation: style.animationName,
      fill: style.webkitTextFillColor,
      running: element.getAttribute("data-running"),
    };
  });
  assert.ok(live.running !== null, "运行中的动作词要带 data-running");
  assert.match(live.animation, /shimmer/i, `动作词应当在跑扫光动画，实际 ${live.animation}`);
  // 扫光靠 `background-clip: text` + 透明填充色生效；填充色不透明说明渐变没接上。
  assert.match(live.fill, /rgba\(0, 0, 0, 0\)|transparent/, `扫光没生效：fill=${live.fill}`);

  // 采样：只认「已经出现数字」的帧。至少要有一次 0 < N < 24，才能说明它**中途**更新过。
  const seen = new Set<number>();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const label = await row.locator('[aria-label^="+"]').first().getAttribute("aria-label").catch(() => null);
    if (label) {
      const value = Number(label.slice(1));
      if (Number.isFinite(value)) {
        seen.add(value);
        if (value > 0 && value < 24) {
          // 留一张「还在涨」的证据（工具还没跑，数字已经在了）。
          await shoot(page, "write-row-growing");
          break;
        }
      }
    }
    await page.waitForTimeout(30);
  }
  assert.ok(
    [...seen].some((value) => value > 0 && value < 24),
    `应当观察到增长中的中间值，实际只看到 ${JSON.stringify([...seen])}`,
  );

  // 收尾：参数收齐后行里就是最终行数，正文是整文件的 diff。`−5` 来自写入前的正文
  //（宿主按相对路径读到旧文件；读不到时这一档只会显示 `+N`，见 ADR-006 §15）。
  await expect(row.locator('[aria-label^="+"]').first()).toHaveAttribute("aria-label", "+24", { timeout: 30_000 });
  await expect(row.locator('[aria-label^="-"]').first()).toHaveAttribute("aria-label", "-5", { timeout: 30_000 });
  // 落定后动作词回到名词形态，扫光与 data-running 一起消失（行不再声称还在进行）。
  await expect(kind).toContainText(/^写入$/);
  assert.equal(await kind.getAttribute("data-running"), null, "落定后不许再标运行中");
  assert.equal(
    await kind.evaluate(
      (element) => element.ownerDocument.defaultView!.getComputedStyle(element).animationName,
    ),
    "none",
    "落定后动画要停",
  );
  await row.locator('[role="button"]').click({ position: { x: 6, y: 8 } });
  await expect(page.locator('[data-diff-line="added"]').first()).toContainText("第 1 条");
});

/**
 * 超出预算的 write：正文不随流传输，但**行里的数字仍然是真的**。
 *
 * 一份 8000 行的文件（约 800 KB）远超线上单字段上限（32 KiB）。服务端在发帧前裁成
 * head + tail 并把原始行数记进 `__omitted`；行必须据此显示 `+8000`，正文位置说明
 * 「未随流传输」，而不是渲染一个空的 diff（空 diff 看起来像"没有改动"）。
 */
test("超大 write：行里是真实行数，正文说明「未随流传输」而不是空 diff", async ({ page, harness }) => {
  await openProject(page, harness);

  await sendMessage(page, "E2E-TOOL-WRITE-BIG 写一个很大的文件");

  // 先等这一轮真的结束。**不要**在流式途中断言最终行数：打字机在 64 KiB 处就停发了，
  // 而整轮落定时过程区会自动折叠、行随之卸载——中途看到的永远是预览值（+412/+617/…）。
  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 90_000,
  });
  await turnFinished(page);

  // 折叠后重新展开：这时行是由**落定后**的数据重建的（快照/转录路径），
  // 行里的数字必须来自裁剪前的原文，而不是 head/tail 预览。
  const region = page.locator('[data-slot="aui_process-group"]').last();
  await region.locator("> div > button").click();
  const row = region.locator('[data-slot="tool-row"]').filter({ hasText: "big.md" }).first();
  await expect(row).toBeVisible();
  await expect(row.locator('[aria-label^="+"]').first()).toHaveAttribute("aria-label", "+8000");

  await row.locator('[role="button"]').first().click();
  const body = page.locator('[data-slot="diff-body"]');
  await expect(body).toBeVisible();
  await expect(body).toContainText("未随流传输");
  // 关键反例：不许拿 head/tail 预览去造 diff 行。
  await expect(body.locator("[data-diff-line]")).toHaveCount(0);

  // 展开是高度动画（内容先渲染、再长高）：不等它，截图会拍到高度 0 的那一帧。
  await page.waitForTimeout(400);
  await shoot(page, "tool-row-write-omitted-light");
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

  // 而且这行字**在动**：类名不够，量的是计算样式。曾经它同时挂着 40% 的淡色，
  // 扫光只剩 8% 不透明度（等于没有效果），所以这里同时钉动画和"填充色被渐变接管"。
  const sweep = await trigger
    .locator(".shimmer")
    .first()
    .evaluate((element) => {
      const style = element.ownerDocument.defaultView!.getComputedStyle(element);
      return { animation: style.animationName, fill: style.webkitTextFillColor };
    });
  assert.match(sweep.animation, /shimmer/i, `「正在思考」应当有扫光动画，实际 ${sweep.animation}`);
  assert.match(sweep.fill, /rgba\(0, 0, 0, 0\)|transparent/, `扫光没有接管填充色：${sweep.fill}`);
  // 证据：运行中的一行（「正在思考」+ 单行尾巴）。扫光是一条动画，静态图只能看形态。
  await shoot(page, "thinking-row-running-light");

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

/**
 * 一轮结束后的「N 个文件已更改」卡片（ZCode 的 `ConversationFileSummaryPanel`）。
 *
 * 用户 2026-10-28 的反馈：「变更文件的显示应该像截图那样，现在在正文后面，样式也不对」——
 * 两件事分开验：
 * - **样式**：不是一行淡灰小字，而是 `rounded-xl` 卡片；表头有聚合 `+X −Y`，展开后每行有
 *   文件名 + 目录 + 自己的增删 + 审查/打开。
 * - **位置**：卡片在正文列里、消息操作栏**之前**。挂到操作栏下面会被读成消息装饰。
 */
test("一轮结束后出现变更文件卡片：聚合增删、单行增删、审查入口", async ({ page, harness }) => {
  writeFileSync(join(harness.workspaceDir, "demo.ts"), "const greek = 'alpha';\n");
  await openProject(page, harness);

  await sendMessage(page, "E2E-TOOL-EDIT 改一下 demo.ts");
  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 30_000,
  });
  await turnFinished(page);

  const message = page.locator("[data-message-id$='#assistant']").last();
  const card = message.locator('[data-slot="aui_turn-changed-files"]');
  await expect(card).toBeVisible({ timeout: 15_000 });

  // 位置：在正文列内，且在操作栏之前（同一个祖先里比较文档顺序）。
  // 这份 tsconfig 没有 DOM lib（`Node` / `Element` 都是 TS2304），所以用结构化类型
  // 和 `DOCUMENT_POSITION_FOLLOWING` 的字面量 4 —— 走 ownerDocument 也不行，
  // 常量挂在 window 上而 window 同样没有类型。
  const order = await card.evaluate((node: {
    closest(selector: string): {
      querySelector(selector: string): { tagName: string } | null;
    } | null;
    compareDocumentPosition(other: unknown): number;
  }) => {
    const content = node.closest('[data-slot="aui_assistant-message-content"]');
    const footer = node
      .closest("[data-message-id]")
      ?.querySelector('[data-slot="aui_assistant-message-footer"]');
    if (!content || !footer) return { inContent: false, beforeFooter: false };
    return {
      inContent: true,
      // 4 = DOCUMENT_POSITION_FOLLOWING：footer 在卡片之后。
      beforeFooter: (node.compareDocumentPosition(footer) & 4) !== 0,
    };
  });
  assert.deepEqual(order, { inContent: true, beforeFooter: true }, "卡片必须在正文列里、操作栏之前");

  // 表头：标题 + 聚合增删（demo.ts 换一行 → +1 -1）。破折号是 ASCII `-`：参考实现的表头
  // 聚合就用连字符，不是排版用的 `−`（工具行的 `DiffCount` 才是 `−`）。
  const trigger = card.locator('[data-slot="aui_turn-changed-files-trigger"]');
  await expect(trigger).toContainText("1 个文件已更改");
  await expect(trigger).toContainText("+1");
  await expect(trigger).toContainText("-1");
  // 收起态：行不在 DOM 里（ZCode 默认收起）。
  await expect(card.locator('[data-slot="aui_turn-changed-file"]')).toHaveCount(0);

  await trigger.click();
  const row = card.locator('[data-slot="aui_turn-changed-file"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("demo.ts");
  await expect(row).toContainText("+1");
  await expect(row).toContainText("-1");
  await expect(row.locator('[data-slot="aui_turn-changed-file-review"]')).toHaveText("审查");
  await expect(row.locator('[data-slot="aui_turn-changed-file-open"]')).toHaveText("打开");

  await page.waitForTimeout(200);
  await shoot(page, "changed-files-card-light");
  // 走应用自己的主题开关，截图拍的是用户能到达的状态（两张图拍的都是收起后展开的静态卡片，
  // 不先点「审查」—— 右面板会跟着变，卡片就淹没在一屏 diff 里了）。
  await page.getByRole("button", { name: "切换到深色主题" }).click();
  await page.waitForTimeout(200);
  await shoot(page, "changed-files-card-dark");
  await page.getByRole("button", { name: "切换到浅色主题" }).click();

  // 「审查」把它在右面板打开（和工具行点文件名同一个落点）。
  await row.locator('[data-slot="aui_turn-changed-file-review"]').click();
  await expect(page.getByRole("tab", { name: /demo\.ts/ })).toHaveAttribute("aria-selected", "true");
});

/**
 * 展开一轮末尾的变更文件卡片时，视口要**跟着它上移**，展开后底部仍贴底。
 *
 * 用户 2026-10-29：「将 unfold 的时候，要自动上移，展开后底部还是 keep 在底部」。
 * 根因不在卡片本身，在视口 owner 的「读者接管」判据：它拿 `userInputAt`（随手一次
 * `pointerdown` 就会刷新）当“读者在滚”的证据，于是点开卡片的那一下就被当成「读者离开
 * 了底部」，`sync()` 主动撤掉 follow —— 卡片下面的行直接长到折叠线以外，不滚就看不见。
 * 判据改成只认**滚动**意图：wheel / touchmove / keydown，以及在会话表面（含滚动条）上的按下；
 * 落在控件（展开按钮、行里的链接）上的点击不再算数。
 *
 * 必须用**长到真能滚**的会话：只有一两条消息时视口没有滚动空间，断言会变成空话。
 */
test("展开变更文件卡片：视口自动上移，展开后仍贴底", async ({ page, harness }) => {
  writeFileSync(join(harness.workspaceDir, "demo.ts"), "const greek = 'alpha';\n");
  await openProject(page, harness);

  // 攒出足够长的会话（每条一轮真跑工具），末尾的卡片才落在折叠线附近。
  for (let index = 0; index < 3; index += 1) {
    await sendMessage(page, `E2E-TOOL-EDIT 改一下 demo.ts（第 ${index + 1} 轮）`);
    await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
      timeout: 30_000,
    });
    await turnFinished(page);
  }

  const viewport = page.locator(".aui-thread-viewport");
  const card = page.locator('[data-slot="aui_turn-changed-files"]').last();
  await expect(card).toBeVisible({ timeout: 15_000 });

  // 先把视口放到真正的底部（等价于用户滚到最新一条），再量展开前的位置。
  await viewport.evaluate((node: { scrollTop: number; scrollHeight: number }) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect
    .poll(async () =>
      viewport.evaluate((node: { scrollTop: number; scrollHeight: number; clientHeight: number }) =>
        Math.round(node.scrollHeight - node.clientHeight - node.scrollTop),
      ),
    )
    .toBeLessThanOrEqual(1);

  // 用 Playwright 的 `boundingBox` 量位置：e2e 的 tsconfig 没有 DOM lib，
  // `document` / `HTMLElement` 在里面都是 TS2304（见上面那条用例的注释）。
  const viewportBox = await viewport.boundingBox();
  const before = await card.boundingBox();
  assert.ok(viewportBox && before, "视口与变更文件卡片都必须可见");

  await card.locator('[data-slot="aui_turn-changed-files-trigger"]').click();
  await expect(card.locator('[data-slot="aui_turn-changed-file"]')).toHaveCount(1);

  // 展开后底部仍贴底：只多出卡片本身的高度，而不是把行长到折叠线以外。
  await expect
    .poll(async () =>
      viewport.evaluate((node: { scrollTop: number; scrollHeight: number; clientHeight: number }) =>
        Math.round(node.scrollHeight - node.clientHeight - node.scrollTop),
      ),
    )
    .toBeLessThanOrEqual(1);
  const after = await card.boundingBox();
  assert.ok(after, "展开后卡片必须还在 DOM 里");
  assert.ok(after.y < before.y, `卡片没有随展开上移（top ${before.y} → ${after.y}）`);
  assert.ok(
    after.y + after.height <= viewportBox.y + viewportBox.height,
    `展开后的卡片底部在折叠线以外（card ${after.y + after.height} > viewport ${viewportBox.y + viewportBox.height}）`,
  );
});

/**
 * 「审查 / 打开」真的落到右面板 —— 而且工具参数给的是**绝对路径**（真实 agent 常这么写）。
 *
 * 两个都踩过：
 * - 卡片把工具参数里的原始路径直接交给右面板，而 `readWorkspaceFile` /
 *   `normalizeRelativeDir` 对绝对路径一律回 `outside the project folder`，于是
 *   「打开」看起来毫无反应、「审查」也拿不到 diff。卡片必须自己折一次相对路径。
 * - `审查` 必须渲染**这一轮的补丁**，而不是现读 git：这个工作区不是仓库（`git diff` 只会回
 *   一段 usage 文本），而 agent 新建的文件在 git 里本来就还是 untracked —— 那时 unstaged
 *   diff 是空的，用户点的却是「审查这一轮」。参考实现（ZCode）同样是直接渲染补丁。
 * - `打开` 走 `openContent`（正文）。两条都要验，否则「点哪个都没反应」这种回归没人拦。
 */
test("变更文件卡片：绝对路径也能审查（右面板 diff）与打开（右面板正文）", async ({ page, harness }) => {
  writeFileSync(join(harness.workspaceDir, "demo.ts"), "const greek = 'alpha';\n");
  await openProject(page, harness);

  await sendMessage(page, "E2E-TOOL-EDIT-ABS 改一下 demo.ts");
  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 30_000,
  });
  await turnFinished(page);

  const card = page.locator('[data-slot="aui_turn-changed-files"]').last();
  await card.locator('[data-slot="aui_turn-changed-files-trigger"]').click();
  const row = card.locator('[data-slot="aui_turn-changed-file"]').first();
  // 显示的是相对路径（绝对路径在行里会被折掉项目前缀）。
  await expect(row).toContainText("demo.ts");
  await expect(row).not.toContainText(harness.workspaceDir);

  // 审查：右面板出这张文件的 diff（不是「不在项目里」的错误文案）。
  await row.locator('[data-slot="aui_turn-changed-file-review"]').click();
  const panel = page.locator('[data-slot="right-panel"]');
  await expect(page.getByRole("tab", { name: /demo\.ts/ })).toHaveAttribute("aria-selected", "true");
  await expect(panel).toContainText("beta", { timeout: 15_000 });
  await expect(panel).toContainText("alpha");
  // 来源标签说清这是「本轮改动」，而不是假装成 git 的未暂存改动。
  await expect(panel).toContainText("本轮改动");
  await expect(panel).not.toContainText("outside the project folder");
  await expect(panel).not.toContainText("Not a git repository");

  // 打开：右面板换成这份文件的正文。
  await row.locator('[data-slot="aui_turn-changed-file-open"]').click();
  await expect(panel).toContainText("const greek = 'beta';", { timeout: 15_000 });

  // 「打开」右侧的箭头是「用什么打开」的下拉（ZCode 的 OpenSplitButton）。
  await row.locator('[data-slot="aui_turn-changed-file-open-with"]').click();
  await expect(page.getByRole("menuitem", { name: "在编辑器中打开" })).toBeVisible();
  await page.keyboard.press("Escape");
});

/**
 * 切语言时，已经在屏幕上的过程行必须跟着换 —— 不是新起一条会话才换。
 *
 * 用户 2026-10-29 的截图就是这条：思考行已经是中文（「思考 · 持续了几秒」），
 * 下面 bash 行的动作词却还写着 `Terminal`。根因不在词表（两包都有 `终端`/`Terminal`），
 * 而在 `ToolRow` 把 `resolvePresentation` 塞进了 `useMemo`：`t` 是模块级函数，
 * 切语言时身份不变，`useT()` 虽然触发了重渲染，memo 的依赖却没变，动作词就冻结在
 * 切换前那一门语言上。所以这条用例必须**在同一个 DOM 上切两次语言**，重新挂载会掩盖它。
 */
test("切语言时行上的文字当场跟着换（思考行 + 工具行动作词）", async ({ page, harness }) => {
  await openProject(page, harness);

  // 语言切换住在左下角工具条里、明暗切换的左边（2026-10-29 从标题栏右格搬来）。
  // 这里按**屏幕上的横向位置**验，而不是按类名/DOM 顺序 —— 用户要的就是视觉顺序。
  const titlebar = page.locator(".app-titlebar");
  await expect(titlebar.getByRole("button", { name: "切换到 English" })).toHaveCount(0);
  const sidebarFooter = page.locator(".project-sidebar-surface footer");
  const languageToggle = sidebarFooter.getByRole("button", { name: "切换到 English" });
  const themeToggle = sidebarFooter.getByRole("button", { name: /切换到(深色|浅色)主题/ });
  const [languageBox, themeBox] = await Promise.all([
    languageToggle.boundingBox(),
    themeToggle.boundingBox(),
  ]);
  assert.ok(languageBox && themeBox, "语言切换与明暗切换都要在侧栏底部可见");
  assert.ok(
    languageBox.x < themeBox.x,
    `语言切换必须在明暗切换左边（x=${languageBox.x} vs ${themeBox.x}）`,
  );

  await sendMessage(page, "E2E-THINK E2E-TOOL-BASH 先想一下再跑命令");
  await expect(page.locator("[data-message-id$='#assistant']").last()).toContainText("E2E-3 done", {
    timeout: 30_000,
  });
  await turnFinished(page);
  await expandProcessRegion(page);

  const thinking = page.locator('[data-slot="thinking-trigger"]').last();
  const kind = page.locator('[data-slot="tool-row-kind"]').last();
  await expect(thinking).toContainText("思考");
  await expect(kind).toHaveText("终端");

  await page.getByRole("button", { name: "切换到 English" }).click();
  await expect(thinking).toContainText("Thought");
  await expect(kind).toHaveText("Terminal");

  await page.getByRole("button", { name: "Switch to 中文" }).click();
  await expect(thinking).toContainText("思考");
  await expect(kind).toHaveText("终端");
});
