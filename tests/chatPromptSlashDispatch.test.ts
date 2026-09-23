/**
 * 聊天里以 "/" 开头的文本不能被当成扩展命令。
 *
 * 背景：pi 的 `prompt()` 看到消息以 "/" 开头，会先把首个 token 交给已注册的扩展命令
 * （`_tryExecuteExtensionCommand`），于是用户在输入框里打 "/run 命令行里的补全…" 时，
 * pi-subagents 的 /run 被真的执行，报出 "Unknown agent: 命令行里的补全…"。
 * 「这句是问题还是命令」文本本身分不出来，所以规则是：聊天框不派发命令，永远当文本。
 *
 * 命令有自己的入口，这里一并钉住：斜杠菜单点选走 /api/capabilities/package/command，
 * 那条路必须继续 expandPromptTemplates（否则命令就跑不起来了）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");

/** Extract a named `function`/`async function` body by brace counting. */
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