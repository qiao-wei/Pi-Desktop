import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "../lib/fixtures";

/**
 * 打包壳冒烟：**真的把 Electron 拉起来**，看窗口把首屏画出来。
 *
 * 与另外三条用例的分工：那三条跑在浏览器里，证明"桥 + 渲染进程"这条路通；
 * 这一条证明**外壳**这一层也通 —— preload 注入了基地址、协议注册/加载、桥随壳一起起。
 * 白屏最常见的一种死法（壳起来了但渲染进程拿不到地址）只有这里能发现。
 *
 * 说明（dev 模式与打包模式的差别是**真实存在**的，所以这里测的是 dev）：
 * - 壳连 `PI_DESKTOP_DEV_URL`（见 src-electron/main.js），也就是夹具里那个 vite dev；
 *   渲染进程的桥地址来自 vite 烘进去的 `VITE_PI_DESKTOP_API_BASE`，**不是** preload 注入的
 *   `--pi-desktop-api-base`（那条只在打包模式下由壳自己起桥时才有）。所以这里断言的是
 *   "壳的窗口真的从那个桥拿到了数据"，而不是"注入了地址"。
 * - 用 `PI_DESKTOP_E2E_SHELL=0` 可以显式跳过（CI 上没有显示服务器时用 xvfb-run，见 README）。
 */
const enabled = process.env.PI_DESKTOP_E2E_SHELL !== "0";

test.skip(!enabled, "PI_DESKTOP_E2E_SHELL=0：跳过外壳冒烟");

test("Electron 外壳能起窗并把首屏画出来（不是白屏）", async ({ harness }, testInfo) => {
  const { _electron: electron } = await import("@playwright/test");
  await harness.api.openProject(harness.workspaceDir, "Shell E2E");

  const shellAgentDir = join(harness.workspaceDir, "..", "shell-agent");
  mkdirSync(shellAgentDir, { recursive: true });
  writeFileSync(
    join(shellAgentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          e2e: {
            name: "E2E",
            baseUrl: harness.modelBaseUrl,
            api: "openai-completions",
            authHeader: true,
            apiKey: "e2e-key",
            models: [
              {
                id: "e2e-model",
                name: "E2E Model",
                contextWindow: 128000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const app = await electron.launch({
    args: [join(process.cwd(), "src-electron", "main.js")],
    env: {
      ...process.env,
      PI_DESKTOP_DEV_URL: harness.rendererUrl,
      PI_CODING_AGENT_DIR: shellAgentDir,
      PI_DESKTOP_PORT: "0",
      PI_DESKTOP_DIAGNOSTICS_ENABLED: "0",
    },
  });

  try {
    // devtools 是另一个窗口，所以按 URL 找那个真正加载了渲染进程的窗口。
    const window = await (async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        for (const candidate of app.windows()) {
          if (candidate.url().startsWith(harness.rendererUrl)) {
            return candidate;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`60s 内没有出现加载 ${harness.rendererUrl} 的窗口：${app.windows().map((w) => w.url()).join(", ")}`);
    })();

    await expect(window.locator(".composer [role='textbox']")).toBeVisible({ timeout: 45_000 });
    // 壳里的渲染进程真的连上了那个桥：侧栏里能看到刚建的项目（数据是从桥来的）。
    await expect(window.locator("body")).toContainText("Shell E2E", { timeout: 30_000 });

    await testInfo.attach("shell-first-paint.png", { body: await window.screenshot(), contentType: "image/png" });
  } finally {
    await app.close();
  }
});
