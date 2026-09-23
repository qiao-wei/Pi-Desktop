import type { CapabilityCommand } from "../types/domain";

/**
 * 包命令面板的搜索：命中「命令名 + 描述」，把搜索词按空白切成多个 token 做 AND，
 * 所以 `/subagents steer` 和 `steer subagents` 都能找到 `/subagents-steer`。
 *
 * 单一实现在这里而不是组件里，是为了能被单测直接跑：过滤规则（大小写、开头的 `/`、
 * 空查询原样返回同一份数组）都是行为契约，不是渲染细节。
 */
export function filterPackageCommands(commands: CapabilityCommand[], query: string): CapabilityCommand[] {
  const tokens = query
    .trim()
    .toLowerCase()
    // 用户经常照抄命令的样子，直接打 `/refine`：前导斜杠不算搜索词。
    .replace(/^\/+/, "")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) {
    return commands;
  }
  return commands.filter((command) => {
    const haystack = `${command.name} ${command.description ?? ""}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}