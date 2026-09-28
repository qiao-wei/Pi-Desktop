/**
 * pi 内置斜杠命令里 Pi Desktop 真能执行的那部分。
 *
 * pi 的完整内置表在 `@earendil-works/pi-coding-agent` 的 `dist/core/slash-commands.js`
 * （`BUILTIN_SLASH_COMMANDS`），但它没有从包根导出；而且内置命令的**执行**逻辑只存在于
 * pi 的 interactive/TUI mode，Pi Desktop 走的是 SDK/RPC，拿不到那套派发。所以这里只登记
 * BFF 真的实现了的命令 —— 菜单里放一条点了没反应的命令，比不放更糟。
 *
 * 新增一条命令 = 在这里登记 + 在 `server/index.mjs` 的 `runBuiltinCommand` 里实现
 * + 补测试。描述与 pi 保持一致。
 */
export const PI_DESKTOP_BUILTIN_COMMANDS = [
  {
    name: "reload",
    description: "Reload extensions, skills, prompts, themes, and context files",
  },
];

export function findBuiltinCommand(name) {
  return PI_DESKTOP_BUILTIN_COMMANDS.find((command) => command.name === name) ?? null;
}

/**
 * `/name args` 的派发决策。纯函数，规则可测：
 * - 未登记 → `unknown`（调用方当普通文本处理，不当作命令）；
 * - 带了参数 → `invalid`（目前登记的命令都不吃参数）；
 * - 其余 → `run`。
 */
export function planBuiltinCommand(name, args = "") {
  const command = findBuiltinCommand(name);
  if (!command) {
    return { kind: "unknown" };
  }
  if (String(args ?? "").trim()) {
    return { kind: "invalid", command, reason: `/${command.name} does not take arguments.` };
  }
  return { kind: "run", command };
}