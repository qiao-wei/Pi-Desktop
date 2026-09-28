/**
 * 聊天服务端绝不把 "/" 开头的文本当扩展命令。
 *
 * 背景：pi 的 `prompt()` 看到消息以 "/" 开头，会先把首个 token 交给已注册的扩展命令
 * （`_tryExecuteExtensionCommand`），于是用户在输入框里打 "/run 命令行里的补全…" 时，
 * pi-subagents 的 /run 被真的执行，报出 "Unknown agent: 命令行里的补全…"。
 *
 * 2026-09-28 起命令有了新的显式入口（composer 的 TUI 式 `/command args`）：Chat 路由这条
 * 底层规则不变（`expandPromptTemplates: false`，服务端永不自己派发），派发只发生在客户端
 * **精确命中已加载包命令** 时，而且走的是独立的 /api/capabilities/package/command。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** Extract a named `function` body by brace counting. */
function functionBody(source: string, name: string): string {
  const declaration = source.indexOf(`function ${name}`);
  assert.notEqual(declaration, -1, `function ${name} not found`);
  const openParen = source.indexOf("(", declaration);
  let parenDepth = 0;
  let cursor = openParen;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") parenDepth += 1;
    if (source[cursor] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const openBrace = source.indexOf("{", cursor);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace, index + 1);
      }
    }
  }
  assert.fail(`function ${name} body never closes`);
}

test("chat submissions never dispatch extension commands", () => {
  const prompt = functionBody(server, "streamPrompt");
  const call = /await activeSession\.prompt\(input, \{([\s\S]*?)\}\);/.exec(prompt);
  assert.notEqual(call, null, "the chat prompt call must be found");
  assert.match(
    call?.[1] ?? "",
    /expandPromptTemplates: false/,
    "typed chat text must reach the model even when it starts with \"/\"",
  );
  assert.doesNotMatch(
    call?.[1] ?? "",
    /expandPromptTemplates: (?!false)/,
    "no chat path may leave command dispatch on (pi defaults it to true)",
  );
});

test("the slash-menu / Packages-page command route still dispatches", () => {
  const command = functionBody(server, "streamCapabilityPackageCommand");
  assert.match(
    command,
    /expandPromptTemplates: true/,
    "running a command the user picked still needs pi's command dispatch",
  );
});

// 新入口的正确性靠「只认已加载包命令」这条线：composer 提交时用纯函数解析 `/name args`，
// 再在能力快照里精确查找；查不到就交回聊天（服务端那条 expandPromptTemplates:false 兜底）。
test("composer only dispatches an exact, currently loaded package command", () => {
  const resolve = functionBody(server, "resolveCapabilityPackageCommand");
  assert.match(resolve, /findCapabilityPackageCommand\(targetRuntime, packageId, commandName\)/);
  // 参数补全走同一个精确查找，不另开一套匹配规则。
  const args = functionBody(server, "readCapabilityCommandArguments");
  assert.match(args, /findCapabilityPackageCommand\(targetRuntime, packageId, commandName\)/);

  const submit = functionBody(appSource, "handleSubmit");
  assert.match(submit, /matchSlashCommandArgs\(orderedText\)/);
  assert.match(submit, /findSlashCommand\(capabilities, submittedCommand\.name\)/);
  // 派发必须早于聊天提交，命中命令时 `return`，不会落到 submitTurn。
  const dispatch = submit.indexOf("findSlashCommand(capabilities, submittedCommand.name)");
  const chatSubmit = submit.indexOf("submitTurn(orderedText");
  assert.ok(dispatch !== -1 && chatSubmit !== -1 && dispatch < chatSubmit);
});