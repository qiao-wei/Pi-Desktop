/**
 * 「自动解决冲突」的纯逻辑：把 `readConflictContext` 拿到的冲突清单与带标记的内容拼成一条
 * 可以直接发给 agent 的提示词。
 *
 * 单独放一个文件是为了可测：`node --test` 直接盖提示词的组装，不碰会话、不碰模型。
 * 前端点击「自动解决冲突」时，服务端返回这条文案，App 新建一个会话并把它填进 composer，
 * 用户看完再点提交（不是替用户自动发消息）。
 */

/** 单个文件在提示词里最多展示多少字符（和 `readConflictContext` 的读取上限一致）。 */
export const MAX_PROMPT_FILE_CHARS = 6000;

/**
 * 冲突上下文 → 提示词。`context` 就是 `readConflictContext` 的返回值（可再补一个
 * `projectCwd`：冲突所在的工作区与会话的工作目录不是一个地方时要显式告诉 agent 用绝对路径）。
 */
export function buildConflictPrompt({ locale = "en", context = {} } = {}) {
  const language = locale === "zh" ? "zh" : "en";
  const files = Array.isArray(context.files) ? context.files : [];
  const lines = [];

  if (language === "zh") {
    lines.push("当前工作区有未解决的合并冲突，请解决这些冲突。", "");
    lines.push(`当前分支：${context.branch || "(unknown)"}`);
    lines.push("冲突文件：");
    for (const file of files) {
      lines.push(`- ${file.path}${file.truncated ? "（内容过长，仅展示片段）" : ""}`);
    }
    if (!files.length) {
      lines.push("- (none)");
    }
    if (typeof context.skipped === "number" && context.skipped > 0) {
      lines.push(`- 另有 ${context.skipped} 个冲突文件未列出`);
    }

    if (context.cwd && context.projectCwd && context.cwd !== context.projectCwd) {
      lines.push("", `注意：冲突在这个检出里：${context.cwd}（不是本会话的工作目录，请用绝对路径操作它）。`);
    }

    lines.push("", "冲突内容（<<<<<<< 到 ======= 是当前分支，======= 到 >>>>>>> 是对方分支）：");
    for (const file of files) {
      lines.push("", `### ${file.path}`);
      if (file.text) {
        lines.push("```", file.text, "```");
      } else {
        lines.push("（二进制或过大，未展示内容，请自行读取该文件）");
      }
    }

    lines.push(
      "",
      "要求：",
      "- 只解决冲突，保留双方真正想要的改动，不要顺手重构无关代码；",
      "- 删掉所有冲突标记（<<<<<<<、=======、>>>>>>>），让文件回到可运行的状态；",
      "- 不要执行 git commit / git add，把结果留在工作区，等用户确认；",
      "- 最后逐文件简要说明你是怎么合并的。",
    );
    return lines.join("\n");
  }

  lines.push("The working tree has unresolved merge conflicts. Please resolve them.", "");
  lines.push(`Current branch: ${context.branch || "(unknown)"}`);
  lines.push("Conflicted files:");
  for (const file of files) {
    lines.push(`- ${file.path}${file.truncated ? " (content too long; excerpt shown)" : ""}`);
  }
  if (!files.length) {
    lines.push("- (none)");
  }
  if (typeof context.skipped === "number" && context.skipped > 0) {
    lines.push(`- ${context.skipped} more conflicted files are not listed`);
  }

  if (context.cwd && context.projectCwd && context.cwd !== context.projectCwd) {
    lines.push("", `Note: the conflicts live in ${context.cwd}, which is not this session's working directory - operate on it with absolute paths.`);
  }

  lines.push("", "Conflict content (<<<<<<< to ======= is the current branch, ======= to >>>>>>> is the other side):");
  for (const file of files) {
    lines.push("", `### ${file.path}`);
    if (file.text) {
      lines.push("```", file.text, "```");
    } else {
      lines.push("(binary or too large; read the file yourself)");
    }
  }

  lines.push(
    "",
    "Requirements:",
    "- Resolve only the conflicts, keep what both sides actually wanted, and do not refactor unrelated code;",
    "- Remove every conflict marker (<<<<<<<, =======, >>>>>>>) so the files are runnable again;",
    "- Do not run git commit / git add; leave the result in the working tree for the user to confirm;",
    "- Finish with a short per-file summary of how you merged each one.",
  );
  return lines.join("\n");
}