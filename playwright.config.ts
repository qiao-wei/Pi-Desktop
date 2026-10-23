import { defineConfig, devices } from "@playwright/test";

/**
 * e2e（Playwright）：真桥 + 真渲染进程 + **假模型端点**（见 e2e/README.md）。
 *
 * 与 `npm test`（2,100+ 条 node 级测试）的分工：那边测的是纯逻辑与模块契约，
 * 这里测的是"整条路真的能跑起来"——冷启动、一轮流式对话、协议不匹配、信任闸。
 * 白屏、装配点写错、打包壳起不来这类问题只有这一层能发现。
 *
 * 串行（workers: 1）：一套夹具就包含一个 vite dev + 一个桥进程，且桥的状态在用例间共享。
 */
export default defineConfig({
  testDir: "./e2e/specs",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]] : [["list"]],
  use: {
    // 中文优先（仓库默认语言）：断言 UI 文案时不用跟着英文版走。
    locale: "zh-CN",
    trace: "retain-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // 本机若已有系统 Chrome 也能用：`PLAYWRIGHT_CHANNEL=chrome npm run e2e`。
        // CI 上是 `npx playwright install --with-deps chromium`（无需系统浏览器）。
        channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
      },
    },
  ],
});