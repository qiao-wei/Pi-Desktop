/**
 * e2e 里的渲染进程：**vite dev**（不是 `vite preview`）。
 *
 * 为什么不是构建产物：桥的地址在渲染进程里是**模块加载时定一次**的常量
 * （`src/lib/api.ts` 的 `pickApiBase`，注释写了"晚到的注入用不上"），而 `vite build`
 * 会把这个值烘进产物 —— 而 e2e 的桥为了让并行用例不抢端口用的是 `PI_DESKTOP_PORT=0`，
 * 地址是运行时才知道的。dev server 在进程启动时读 `VITE_PI_DESKTOP_API_BASE`，
 * 于是地址可以在起 dev server 之前定下来，而且不用等一次完整的生产构建。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import { ROOT_DIR } from "./bridge.mjs";

/** 从 vite 的启动输出里认出地址（`➜  Local:   http://127.0.0.1:5176/`）。 */
function waitForUrl(child, seen) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`vite dev 30s 内没有就绪。\n${seen.stdout}\n${seen.stderr}`)), 30_000);
    const inspect = (chunk) => {
      // oxlint-disable-next-line no-control-regex -- 剥掉 ANSI 颜色码，控制字符正是要匹配的东西
      const text = String(chunk).replace(/\u001b\[[0-9;]*m/g, "");
      seen.stdout += text;
      const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", (chunk) => {
      seen.stderr += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`vite dev 提前退出（code ${code}）。\n${seen.stdout}\n${seen.stderr}`));
    });
  });
}

/**
 * 起一个 vite dev server，并把桥地址交给它。
 *
 * @param {string} apiBase 桥的地址（会烘进 `import.meta.env.VITE_PI_DESKTOP_API_BASE`）。
 */
export async function startViteDevServer(apiBase, options = {}) {
  /** @type {{stdout: string, stderr: string}} */
  const seen = { stdout: "", stderr: "" };
  const child = spawn(
    process.execPath,
    [
      join(ROOT_DIR, "node_modules", "vite", "bin", "vite.js"),
      "--host",
      "127.0.0.1",
      // 0 = 让 vite 自己挑一个空闲端口，并行跑用例时不会撞端口。
      "--port",
      "0",
      "--clearScreen",
      "false",
    ],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        VITE_PI_DESKTOP_API_BASE: apiBase,
        ...(options.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const url = await waitForUrl(child, seen);
  return {
    url,
    logs: () => seen,
    async stop() {
      child.kill("SIGTERM");
      await /** @type {Promise<void>} */ (new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      }));
    },
  };
}