/**
 * 「智能生成提交信息」的纯逻辑：把 diff 上下文拼成 prompt，再把模型返回的文本收拾成一条
 * 能直接提交的信息。
 *
 * 单独放一个文件是为了可测：`node --test` 直接盖 prompt 的组装和输出的规范化，不碰模型。
 * 真正的模型调用在 `server/index.mjs` 的路由里（`modelRuntime.complete`，用当前会话的模型）。
 */

/** 提交信息长度上限（与 `server/gitInfo.mjs` 的校验一致，模型输出也按这个截）。 */
export const MAX_GENERATED_COMMIT_MESSAGE_CHARS = 2000;

const SYSTEM_PROMPTS = {
  zh: [
    "你是 Git 提交信息生成器。",
    "根据给定的改动，写出**一条**中文提交信息。",
    "要求：",
    "- 第一行是简短的祈使句标题（不超过 50 字），说明改了什么，不要句号结尾；",
    "- 如有必要，空一行后补 2-4 条要点（每条以「- 」开头），只写从 diff 能看出来的事实；",
    "- 不要编造需求背景、issue 号、测试结果；不要提到 AI、模型或「本次改动」；",
    "- 只输出提交信息本身，不要代码块、不要引号、不要任何解释。",
  ].join("\n"),
  en: [
    "You write Git commit messages.",
    "Given a change set, write ONE commit message.",
    "Rules:",
    "- The first line is a short imperative subject (max 50 chars), no trailing period;",
    "- If useful, add a blank line and 2-4 bullet points (each starting with \u0022- \u0022) stating only facts visible in the diff;",
    "- Never invent requirements, issue numbers, or test results; never mention AI, models, or \u0022this change\u0022;",
    "- Output the commit message only: no code fences, no quotes, no explanation.",
  ].join("\n"),
};

/** 把 diff 上下文拼成一次性的 user 消息。 */
export function buildCommitMessagePrompt({ locale = "en", context } = {}) {
  const language = locale === "zh" ? "zh" : "en";
  const lines = [];

  lines.push(language === "zh" ? "改动清单：" : "Changed files:");
  for (const file of context?.files ?? []) {
    const rename = file.origPath ? `${file.origPath} → ` : "";
    const stats = file.added || file.removed ? ` (+${file.added} −${file.removed})` : "";
    lines.push(`- [${file.status}] ${rename}${file.path}${stats}`);
  }
  if ((context?.files ?? []).length === 0) {
    lines.push("- (none)");
  }

  if (context?.branch) {
    lines.push("", language === "zh" ? `当前分支：${context.branch}` : `Branch: ${context.branch}`);
  }

  if (context?.patch) {
    lines.push("", language === "zh" ? "补丁（工作区相对 HEAD）：" : "Patch (working tree vs HEAD):", "```diff", context.patch, "```");
  }

  for (const file of context?.newFiles ?? []) {
    if (!file.text) {
      lines.push("", language === "zh" ? `新文件 ${file.path}（内容过长或二进制，未展示）` : `New file ${file.path} (binary or too large, not shown)`);
      continue;
    }
    const body = String(file.text).replace(/\n+$/, "");
    lines.push(
      "",
      language === "zh" ? `新文件 ${file.path}${file.truncated ? "（已截断）" : ""}：` : `New file ${file.path}${file.truncated ? " (truncated)" : ""}:`,
      "```",
      body,
      "```",
    );
  }

  for (const dir of context?.skippedUntrackedDirs ?? []) {
    lines.push("", language === "zh" ? `未跟踪目录 ${dir}（内容未展示）` : `Untracked directory ${dir} (content not shown)`);
  }

  return { systemPrompt: SYSTEM_PROMPTS[language], userText: lines.join("\n") };
}

/**
 * 把模型输出收拾成可以直接提交的信息：
 * 去掉代码块围栏、首尾引号、「提交信息：」这类前缀，压掉多余空行，并限长。
 * 返回空串表示"模型没给出可用内容"，调用方据此报错而不是提交一条空信息。
 */
export function normalizeGeneratedCommitMessage(text) {
  let value = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!value) {
    return "";
  }

  // 整段被 ``` 包起来的情况：先剥围栏。
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(value);
  if (fenced) {
    value = fenced[1];
  }
  value = value.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");

  value = value
    .split("\n")
    .map((line) => line.replace(/^\s*(?:git\s+)?(?:commit\s+message|提交信息|提交说明|commit)\s*[:：]\s*/i, ""))
    .join("\n")
    .trim();

  // 整条被引号/书名号包起来（模型偶尔会这样）。
  const quoted = /^(["'“‘「『《])([\s\S]*)\1$/.exec(value);
  if (quoted) {
    value = quoted[2].trim();
  } else {
    const paired = /^([「『《])([\s\S]*)([」』》])$/.exec(value);
    if (paired) {
      value = paired[2].trim();
    }
  }

  value = value
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (value.length > MAX_GENERATED_COMMIT_MESSAGE_CHARS) {
    value = value.slice(0, MAX_GENERATED_COMMIT_MESSAGE_CHARS).trimEnd();
  }

  return value;
}