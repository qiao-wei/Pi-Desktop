/**
 * 运行时的项目信任判定.
 *
 * 把 pi 的 trust 判定包成一处，让建会话与能力盘点用同一条事实。
 *
 * 从 `server/index.mjs` 搬出来的纯函数（只依赖 import 进来的东西，不碰模块状态）——
 * 那个文件曾经 8.7k 行、棘轮不许它再长，所以按「一簇一文件」往外搬。
 */
import { resolveProjectTrusted } from "./piKernel.mjs";

/**
 * @param {{
 *   cwd: string,
 *   settingsManager: any,
 *   trustStore: any,
 *   projectTrustContext: any,
 *   extensionsResult?: any,
 * }} options
 * @returns {Promise<boolean>}
 */
async function resolveProjectTrustForRuntime({
  cwd,
  settingsManager,
  trustStore,
  projectTrustContext,
  extensionsResult = undefined,
}) {
  return resolveProjectTrusted({
    cwd,
    trustStore,
    defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
    extensionsResult,
    // Runtime creation can happen before the bootstrap response is available.
    // Keep trust resolution non-interactive here; the HTTP endpoint below handles
    // an explicit trust decision and reloads the open runtimes afterwards.
    projectTrustContext: {
      ...projectTrustContext,
      hasUI: false,
      ui: {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        notify: () => {},
      },
    },
    onExtensionError: (message) => {
      console.error(message);
    },
  });
}

export { resolveProjectTrustForRuntime };
