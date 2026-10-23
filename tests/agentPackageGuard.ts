// pi-monitor 那组用例的被测源码不在仓库里：它住在用户 home 的 agent 包里
// （`~/.pi/agent/packages/pi-monitor`，见各文件顶部的说明）。`.pi/` 是 gitignore 的，所以干净的
// clone —— CI 的 checkout 就是 —— 根本没有这些文件，而**静态** import 会在加载阶段就抛错，把整个
// 测试进程带下来（症状是文件级 "test failed"，看不出是缺文件）。
//
// 所以源码不在本机时，这组用例注册成 skip，而不是让文件崩掉。这台机器上有没有源码，只由这一个
// 地方判断；`test` 的调用形状照抄 node:test（`test(name, fn)` 与 `test(name, options, fn)` 都过）。

import { existsSync } from "node:fs";
import testBase from "node:test";

/**
 * `~/.pi/agent/packages/` —— 这些用例的被测源码住的目录。tests/ 往上三级就是 home
 * （repo/tests → repo → Desktop → ~），这个深度与哪个文件调用无关，所以它只写在这一个地方。
 */
export const AGENT_PACKAGES_DIR = new URL("../../../.pi/agent/packages/", import.meta.url);

/** 本机有没有那套 agent 包的源码。 */
export const agentPackageAvailable = existsSync(new URL("pi-monitor/", AGENT_PACKAGES_DIR));

const SKIP_REASON =
  "本机没有 ~/.pi/agent/packages/pi-monitor 的源码（它在用户 agent 包里，不在仓库里）";

export const test = (
  agentPackageAvailable
    ? testBase
    : (name: string, optionsOrFn: unknown, _maybeFn?: unknown) => {
        const options =
          typeof optionsOrFn === "function" ? {} : { ...(optionsOrFn as Record<string, unknown>) };
        return testBase(name, { ...options, skip: SKIP_REASON }, () => {});
      }
) as typeof testBase;

/**
 * 动态 import 一个 agent 包模块，源码不在本机时返回 null（配合上面的 `test`，用例根本不会跑，
 * 函数体里解构出来的符号也就用不到）。
 *
 * 收 URL 而不是路径字符串：`import()` 里的相对路径是相对**调用点所在模块**解析的，交给 helper
 * 解析会找错目录。调用方用 `new URL("pi-monitor/extensions/monitor/x.ts", AGENT_PACKAGES_DIR)` 拼。
 */
export async function loadAgentModule<T>(url: URL): Promise<T | null> {
  if (!agentPackageAvailable) {
    return null;
  }
  return (await import(url.href)) as T;
}
