import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deriveSessionTitle,
  sessionTitleMaxChars,
  sessionTitleMaxChaseChars,
  sessionTitleMaxWords,
  sessionTitleUnits,
} from "../src/shared/sessionTitle.ts";

// The submit-time budget is unit-based: one unit per CJK character, one per
// Latin/number word. <= budget keeps the whole title; a cut chases forward to
// the nearest punctuation and never grows past the chase cap.
const submitBudget = sessionTitleMaxChars;
const submitChaseCap = sessionTitleMaxChaseChars;
import { ATTACHMENT_CONTEXT_END, ATTACHMENT_CONTEXT_START } from "../src/shared/chatBubbles.ts";

const exactCases: Array<[string, string]> = [
  // File names / versions / URLs must not be mistaken for sentence ends.
  ["帮我看看 server/index.mjs 这个文件的报错", "server/index.mjs 这个文件的报错"],
  ["升级到 3.5 版本后登录失败", "升级到 3.5 版本后登录失败"],
  ["参考 https://example.com/docs 里的说明改一下", "example.com 里的说明改一下"],
  ["看看这个 https://github.com/foo/bar 的 PR", "github.com 的 PR"],
  // Openers that carry no topic.
  ["请帮我优化下提交问题后，根据问题提取临时标题的方法", "根据问题提取临时标题的方"],
  ["你好，帮我改下登录", "登录"],
  ["你是资深前端工程师，请review一下这段代码", "review这段代码"],
  // English keeps whole words within the unit budget (one word = one unit).
  ["How do I fix the bug in foo.py?", "fix the bug in foo.py"],
  ["Fix login bug", "Fix login bug"],
  ["Implement rate limiting for the API", "Implement rate limiting for the API"],
  // A short sentence stays whole.
  ["this is a book.", "this is a book"],
  ["I love you", "I love you"],
  // Markdown / code noise.
  ["```ts\nconst a = 1;\n```\n这样写有问题吗", "这样写有问题吗"],
  // Half-cut trailing latin fragments are dropped.
  ["分析一下这个报错：TypeError: x is undefined", "报错：TypeError: x is undefined"],
  // Badge text (a flattened attachment badge carries a size token).
  ["报告.pdf 12 KB", "报告.pdf"],
  // A title that already fits is kept whole, no punctuation needed.
  ["worktree多任务", "worktree多任务"],
  // Trailing particles are part of the sentence; dropping them made it half.
  ["Jev 不是开源的吗", "Jev 不是开源的吗"],
  ["登录失败", "登录失败"],
  ["为什么报错啊", "为什么报错啊"],
  ["你好", "你好"],
  // Exactly on the budget stays whole; one unit over gets cut at the budget
  // (no punctuation nearby to chase).
  ["多任务调度系统的完整方案", "多任务调度系统的完整方案"],
  ["这是一条超过十二个字的长句子测试用", "这是一条超过十二个字的长"],
];

test("deriveSessionTitle extracts a clean submit-time title", () => {
  for (const [input, expected] of exactCases) {
    assert.equal(deriveSessionTitle(input), expected, `input: ${input}`);
  }
});

test("deriveSessionTitle drops attachment metadata and inline badge characters", () => {
  const raw = [
    ATTACHMENT_CONTEXT_START,
    JSON.stringify({
      displayInput: "帮我修复登录失败",
      attachments: [{ name: "报告.pdf", size: 12345, mimeType: "application/pdf" }],
      messageParts: [
        { kind: "text", text: "帮我修复登录失败" },
        { kind: "capability", capability: { id: "pdf", kind: "skill", name: "pdf" } },
      ],
    }),
    ATTACHMENT_CONTEXT_END,
  ].join("");

  const title = deriveSessionTitle({ text: raw });
  assert.equal(title, "登录失败");
  for (const leak of ["{", "}", '"', "<", ">", "capability", "messageParts", "kind", "12345"]) {
    assert.ok(!title.includes(leak), `leaked ${leak} in ${title}`);
  }
});

test("deriveSessionTitle falls back to the attachment name, then to empty", () => {
  assert.equal(deriveSessionTitle({ text: "", attachments: [{ name: "screenshot.png" }] }), "screenshot.png");
  assert.equal(
    deriveSessionTitle({
      text: `${ATTACHMENT_CONTEXT_START}{"displayInput":"","attachments":[{"name":"报告.pdf"}]}${ATTACHMENT_CONTEXT_END}`,
    }),
    "报告.pdf",
  );
  assert.equal(deriveSessionTitle("   "), "");
  assert.equal(deriveSessionTitle(null), "");
  assert.equal(deriveSessionTitle({ text: "???" }), "");
});

test("deriveSessionTitle keeps english titles to whole words within the unit budget", () => {
  const latinInputs = [
    "How do I fix the bug in foo.py?",
    "Fix login bug",
    "Implement rate limiting for the API",
    "Please update the deployment pipeline configuration",
  ];
  for (const input of latinInputs) {
    const title = deriveSessionTitle(input);
    assert.ok(title.split(/\s+/u).length <= submitBudget, `too many words: ${title}`);
    for (const token of title.match(/[A-Za-z][A-Za-z0-9'’\-_.]*/gu) ?? []) {
      assert.ok(input.includes(token), `token ${token} is not in the source`);
    }
  }
});

test("deriveSessionTitle pushes a cut forward to the next punctuation (capped)", () => {
  // 15 units: the 12-unit cut lands inside "解决方案"; the comma at unit 15 wins.
  const chased = deriveSessionTitle("多任务调度系统的完整化解决方案，并且支持并行开发");
  assert.equal(chased, "多任务调度系统的完整化解决方案");
  assert.ok(sessionTitleUnits(chased) > submitBudget, `should pass the budget: ${chased}`);
  assert.ok(sessionTitleUnits(chased) <= submitChaseCap, `past the chase cap: ${chased}`);
  assert.ok(!chased.includes("并且"), `pulled in the next clause: ${chased}`);

  // The only punctuation sits past the cap, so the title falls back to the
  // budget cut instead of growing to chase it.
  const capped = deriveSessionTitle("实现多任务调度系统的完整方案并且支持并行开发处理流程化评估，还要断点续传");
  assert.equal(capped, "多任务调度系统的完整方案");
  assert.ok(sessionTitleUnits(capped) <= submitBudget, `should not chase past the cap: ${capped}`);
});

test("deriveSessionTitle keeps CJK titles within budget and never emits a partial latin word", () => {
  const inputs = [
    "帮我看看 server/index.mjs 这个文件的报错",
    "请帮我优化下提交问题后，根据问题提取临时标题的方法",
    "分析一下这个报错：TypeError: x is undefined",
    "把 src/features/chat/usePiDesktopApp.ts 里的标题逻辑整理一下",
  ];
  for (const input of inputs) {
    const title = deriveSessionTitle(input);
    assert.ok(sessionTitleUnits(title) <= submitChaseCap, `too long: ${title}`);
    for (const token of title.match(/[A-Za-z][A-Za-z0-9'’\-_.]*/gu) ?? []) {
      assert.ok(input.includes(token), `token ${token} is not in the source`);
    }
  }
});

test("deriveSessionTitle is idempotent", () => {
  for (const [input] of exactCases) {
    const once = deriveSessionTitle(input);
    assert.equal(deriveSessionTitle(once), once, `not idempotent: ${input}`);
  }
});

test("client and server share one submit-time implementation", () => {
  const client = readFileSync("src/features/chat/usePiDesktopApp.ts", "utf8");
  const server = readFileSync("server/index.mjs", "utf8");

  assert.ok(client.includes('from "../../shared/sessionTitle"'));
  assert.ok(server.includes('from "../src/shared/sessionTitle.ts"'));
  assert.ok(!client.includes("function fallbackSessionTitle"));
  assert.ok(/function inferConversationTitle[\s\S]*?deriveSessionTitle\(/.test(server));
  // The post-hoc summary title is derived from the question like the provisional
  // one, so the model-unavailable fallback shares the same rule.
  assert.ok(/function fallbackSessionTitle[\s\S]*?deriveSessionTitle\(/.test(server));
  assert.ok(server.includes("const fallbackTitle = fallbackSessionTitle(messageToText(userMessage))"));
});

test("the summary title is kept as written, never cut to fit", () => {
  const server = readFileSync("server/index.mjs", "utf8");

  // The budget lives in the prompt; the code must not hard-cut the model output.
  assert.ok(/const generatedTitleMaxChars = 16;/.test(server));
  assert.ok(server.includes("中文标题不超过 ${generatedTitleMaxChars} 字"));
  assert.ok(server.includes("英文标题不超过 ${sessionTitleMaxWords} 个词"));

  const normalize = /function normalizeGeneratedTitle\([\s\S]*?\n\}/.exec(server)?.[0] ?? "";
  assert.ok(normalize.includes("function normalizeGeneratedTitle"), "normalizeGeneratedTitle not found");
  assert.ok(!normalize.includes("truncateTitle"), "summary title is still truncated");
  assert.ok(!normalize.includes("firstSentence"), "summary title still loses its first sentence");
  assert.ok(!/\.slice\(/.test(normalize), "summary title is still sliced by length");

  // A truncated model title is exactly the bug from the screenshot.
  assert.ok(!server.includes('truncateTitle(assistantContentText(response)'));
});