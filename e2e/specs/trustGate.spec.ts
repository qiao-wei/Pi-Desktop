import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, waitForFirstPaint } from "../lib/fixtures";

/**
 * 信任闸：项目级资源（`.pi/skills`、`.pi/mcp.json`…）在没有被信任时**不加载**，
 * 界面要说清楚这件事，并且给一键信任的入口。
 *
 * 闸门要有牙齿，所以用例不只断言"横幅出现了"：它先记下未信任时项目里的技能**看不见**，
 * 点完"信任并加载"之后必须**看得见** —— 否则横幅就是个装饰。
 */
test("未信任项目的项目级资源不加载，界面给出提示且能一键信任", async ({ page, harness }) => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-desktop-e2e-untrusted-"));
  const skillDir = join(workspace, ".pi", "skills", "e2e-project-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    ["---", "name: e2e-project-skill", "description: 只在项目被信任后才出现的技能（e2e）", "---", "", "# E2E project skill", ""].join("\n"),
    "utf8",
  );

  const projectId = await harness.api.openProject(workspace, "Untrusted E2E");
  await harness.api.selectE2EModel({ projectId });

  const before = await harness.api.get("/api/bootstrap");
  expect(JSON.stringify(before.snapshot?.projectTrusted ?? before.projectTrusted)).not.toBe("true");

  await page.goto(harness.rendererUrl, { waitUntil: "domcontentloaded" });
  await waitForFirstPaint(page);

  // 1) 未信任：提示可见，并且明说项目级 Pi package 没加载。
  await expect(page.locator("body")).toContainText("项目级 Pi package 尚未加载", { timeout: 20_000 });
  const trustButton = page.getByRole("button", { name: /信任并加载/ });
  await expect(trustButton).toBeVisible();

  // 2) 闸门有牙齿：此刻项目里的技能还没进来。
  const untrustedReload = await harness.api.post("/api/skills/reload", { scope: "all" });
  expect(JSON.stringify(untrustedReload)).not.toContain("e2e-project-skill");

  // 3) 一键信任 → 提示消失，项目级技能出现。
  await trustButton.click();
  await expect(page.locator("body")).not.toContainText("项目级 Pi package 尚未加载", { timeout: 20_000 });

  const trustedReload = await harness.api.post("/api/skills/reload", { scope: "all" });
  expect(JSON.stringify(trustedReload)).toContain("e2e-project-skill");
});