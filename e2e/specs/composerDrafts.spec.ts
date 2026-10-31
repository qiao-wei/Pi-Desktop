import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, waitForFirstPaint } from "../lib/fixtures";

/**
 * composer 的草稿必须是**会话级**的，而且是完整的（正文 + 附件徽标）。
 *
 * 回归的 bug：composer 正文活在 contentEditable 的 DOM 里，切会话不会卸载这块 DOM，
 * 于是 A 里打了一半的字会原样出现在 B 的输入框里（用户：「composer 里的内容保持，
 * 是 session 级的，现在是全局的」）。
 *
 * 用真实切换（点侧栏会话行）验证，因为「气泡/焦点/selected session 渲染」都不是
 * node 单测能覆盖的：
 *   1. 在 B 里打草稿 + 加一张图；
 *   2. 切到 A：输入框要是空的（不能带 B 的字）；
 *   3. 在 A 里打草稿；
 *   4. 切回 B：B 的正文和附件徽标都回来，且不能出现 A 的字；
 *   5. 再切回 A：A 的正文回来，且没有 B 的附件。
 */
const PROJECT_NAME = "E2E Project";

test("composer 草稿按会话隔离、切回时正文与附件徽标都恢复", async ({ page, harness }) => {
  const projectDir = join(harness.workspaceDir, "composer-drafts");
  mkdirSync(projectDir, { recursive: true });
  const projectId = await harness.api.openProject(projectDir, PROJECT_NAME);
  await harness.api.selectE2EModel({ projectId });

  // 两条带固定标题的会话（active = 后建的那条 = Draft B）。
  // 侧栏行的标题在空会话阶段统一显示 "New session"（会话名只进头部），所以按服务器
  // 返回的真实 sessionPath 选行，而不是按标题。
  const draftA = await harness.api.post("/api/sessions", { projectId, name: "Draft A" });
  const draftB = await harness.api.post("/api/sessions", { projectId, name: "Draft B" });

  await page.goto(harness.rendererUrl, { waitUntil: "domcontentloaded" });
  await waitForFirstPaint(page);

  const editor = page.locator(".composer [role='textbox']");
  const header = page.locator(".conversation-header h1");
  const sessionRow = (sessionPath: string) => page.locator(`[data-session-path="${sessionPath}"]`);
  const badges = editor.locator("[data-attachment-id]");

  // ── 1. B 里打草稿 + 加一张图 ────────────────────────────────────────────
  await expect(header).toHaveText("Draft B");
  await editor.click();
  await page.keyboard.type("DRAFT-B");
  await page.locator(".composer-file-input").setInputFiles({
    name: "draft-b.png",
    mimeType: "image/png",
    buffer: Buffer.from("not-a-real-png-but-bytes-are-enough"),
  });
  await expect(badges).toHaveCount(1);

  // ── 2. 切到 A：A 是空会话，不能带着 B 的草稿 ─────────────────────────────
  await sessionRow(draftA.activeSessionPath).click();
  await expect(header).toHaveText("Draft A");
  await expect(editor).toHaveText("");
  await expect(badges).toHaveCount(0);

  // ── 3. A 里打自己的草稿 ─────────────────────────────────────────────────
  await editor.click();
  await page.keyboard.type("DRAFT-A");

  // ── 4. 切回 B：正文 + 附件徽标都回来，且没有 A 的字 ───────────────────────
  await sessionRow(draftB.activeSessionPath).click();
  await expect(header).toHaveText("Draft B");
  await expect(editor).toContainText("DRAFT-B");
  await expect(editor).not.toContainText("DRAFT-A");
  await expect(badges).toHaveCount(1);
  // 停放的附件预览 URL 不能被回收：徽标回来了但图片是坏的等于草稿不完整。
  const previewUrl = await badges.first().locator("img").getAttribute("src");
  const previewStillReadable = await page.evaluate(async (url) => {
    try {
      return (await fetch(url ?? "")).ok;
    } catch {
      return false;
    }
  }, previewUrl);
  expect(previewStillReadable).toBe(true);

  // ── 5. 再切回 A：A 的草稿还在，B 的附件不能跟过来 ─────────────────────────
  await sessionRow(draftA.activeSessionPath).click();
  await expect(header).toHaveText("Draft A");
  await expect(editor).toContainText("DRAFT-A");
  await expect(editor).not.toContainText("DRAFT-B");
  await expect(badges).toHaveCount(0);
});