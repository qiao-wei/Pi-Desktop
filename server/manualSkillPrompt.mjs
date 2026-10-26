/**
 * manual-only 技能（`disable-model-invocation: true`）的正文注入。
 *
 * 背景：pi 会把这类技能从系统提示的 `<available_skills>` 里整条过滤掉
 * （`dist/core/skills.js` 的 `formatSkillsForPrompt`），所以桌面版那条
 * 「徽标 → 使能 → 模型自己 read SKILL.md」的路对它们天然无效：无论怎么使能，模型都看不到。
 * 在 pi 里唯一能用它们的方式是 `/skill:<name>`，由 `_expandSkillCommand` 把正文展开进
 * 这一条消息。
 *
 * 桌面版的 composer 只有徽标这一种附件方式，聊天路由又刻意 `expandPromptTemplates: false`
 * （见 index.mjs 里 `streamPrompt` 上的注释），所以这里由服务端补上展开：用户显式附上了哪个
 * manual-only 技能，就把它的正文按 pi 的格式拼进这一条 prompt。其余技能保持原样——它们走
 * 徽标使能，由模型按需读，不白烧上下文（`~/.agents/skills` 里的 SKILL.md 平均 5.6KB）。
 *
 * 格式是 pi 的**公共契约**而不是内部细节：pi 导出了 `parseSkillBlock` 专门解析它
 * （`dist/core/agent-session.js`，类型也进了 `dist/index.d.ts`），TUI 用它渲染技能调用气泡。
 * 测试用 `parseSkillBlock` 对本模块的输出做 round-trip，上游改了格式这里会立刻红。
 */

// 内核只从适配层进（architecture 规则 kernel-boundary）：这里是 `@earendil-works/*` 的唯一入口。
import { stripFrontmatter } from "./piKernel.mjs";

/**
 * 一个技能 → pi 的 skill block。
 *
 * 与 `AgentSession._expandSkillCommand` 逐字符同形（含 `References are relative to …` 末尾那个
 * 句点），因为它俩的输出要能被同一个 `parseSkillBlock` 认出来。
 *
 * @param {{ name?: string, filePath?: string, baseDir?: string, content?: string }} entry
 *   `content` 是 SKILL.md 的原文，frontmatter 在这里去掉。
 * @returns {string} 空格名/路径/正文（正文只剩 frontmatter）时返回空串，由调用方跳过。
 */
export function formatManualSkillBlock(entry) {
  const name = String(entry?.name ?? "").trim();
  const filePath = String(entry?.filePath ?? "").trim();
  const baseDir = String(entry?.baseDir ?? "").trim();
  const body = stripFrontmatter(String(entry?.content ?? "")).trim();
  if (!name || !filePath || !body) {
    return "";
  }

  return `<skill name="${name}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

/**
 * 若干个技能 → 直接拼在用户消息前面的前缀（含把用户原文隔开的那两个换行）。
 *
 * 多个技能各成一个 block，用空行分开：`parseSkillBlock` 的正则只认第一个 block（它把
 * 剩下的都当成用户消息），但桌面版不用它渲染消息，模型侧看两个 block 也没问题。
 *
 * @param {Array<{ name?: string, filePath?: string, baseDir?: string, content?: string }>} entries
 * @returns {string} 没有任何可用 block 时返回空串，调用方据此保持 prompt 原样。
 */
export function manualSkillPromptPrefix(entries) {
  const blocks = (entries ?? []).map(formatManualSkillBlock).filter(Boolean);
  return blocks.length ? `${blocks.join("\n\n")}\n\n` : "";
}