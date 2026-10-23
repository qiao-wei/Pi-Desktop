/**
 * Playwright 夹具：一套 e2e 环境 = 假模型端点 + 真桥 + 真渲染进程（vite dev）。
 *
 * 作用域是 **worker**：vite dev 与桥只起一次，全部用例共用（`workers: 1`，见 playwright.config.ts）。
 * 桥的状态在用例之间是共享的 —— 需要干净状态的地方（比如"未信任项目"）由用例自己建目录与项目，
 * 这也是真实用户的用法。
 */
import { expect, test as base } from "@playwright/test";

import { startE2E } from "./bridge.mjs";
import { startViteDevServer } from "./vite.mjs";

export interface Harness {
  /** 桥的地址。 */
  apiBase: string;
  /** 渲染进程地址（vite dev）。 */
  rendererUrl: string;
  /** 桥的 HTTP 面。 */
  api: ReturnType<typeof startE2E> extends Promise<infer T> ? (T extends { api: infer A } ? A : never) : never;
  /** 隔离出来的 agent 目录（`~/.pi/agent` 的替身）。 */
  agentDir: string;
  /** 每个用例可以随便造的临时工作区。 */
  workspaceDir: string;
  /** 假模型端点的基地址（外壳用例要另起一份配置指向它）。 */
  modelBaseUrl: string;
  /** 假模型端点收到的请求（断言"桥到底发了什么给模型"）。 */
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  logs: () => { stdout: string; stderr: string };
}

export const test = base.extend<object, { harness: Harness }>({
  harness: [
    // Playwright 的签名：第一个形参必须是解构模式（空模式也是模式），第二个是夹具的 use。
    async ({}, use) => {
      const e2e = await startE2E({ model: { chunkDelayMs: 60, firstTokenDelayMs: 40 } });
      if (!e2e.model) {
        throw new Error("e2e 夹具必须有假模型端点：没有它，一轮对话就没有确定性的文本");
      }
      const vite = await startViteDevServer(e2e.apiBase);
      const harness: Harness = {
        apiBase: e2e.apiBase,
        rendererUrl: vite.url,
        api: e2e.api,
        agentDir: e2e.agentDir,
        workspaceDir: e2e.workspaceDir,
        modelBaseUrl: e2e.model.baseUrl,
        requests: e2e.model.requests,
        logs: () => ({ ...e2e.logs(), ...vite.logs() }),
      };
      try {
        await use(harness);
      } finally {
        await vite.stop();
        await e2e.stop();
      }
    },
    { scope: "worker" },
  ],
});

/** 首屏：等到应用外壳真的画出来（不是白屏，也不是永久 loading）。 */
export async function waitForFirstPaint(page: import("@playwright/test").Page) {
  await expect(page.locator(".composer [role='textbox']")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-message-id]").first()).toBeAttached({ timeout: 15_000 }).catch(() => {});
}

/** 在输入框里打字并发送（走真实键盘事件，连同 Enter 提交）。 */
export async function sendMessage(page: import("@playwright/test").Page, text: string) {
  const editor = page.locator(".composer [role='textbox']");
  await editor.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

export { expect };