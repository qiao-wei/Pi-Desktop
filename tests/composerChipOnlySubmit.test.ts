/**
 * 「只挂技能徽标、一个字不写」也能提交 —— TUI 的 `/skill:<name>` 无参数形态。
 *
 * 以前这条路是不通的：`handleSubmit` 的守卫（以及渲染进程 `submitTurn` / `submitEdit` 的同款
 * 守卫、发送按钮的 disabled）都把「没有文字且没有附件」当成空消息直接 return。于是
 * `disable-model-invocation: true` 的技能即便挂上徽标也发不出去 —— 服务端那句
 * `input is required` 从 UI 根本到不了。
 *
 * 两边都要放开，缺一边就还是发不出去（渲染进程先拦一次，服务端再拦一次）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bridgeSource } from "./lib/bridgeSource.ts";
import { appSource } from "./lib/appSource.ts";

// `App.tsx` 已拆成 胶水 + `useAppModel.ts`（回调）+ `AppShell.tsx`（视图），
// 所以读整个 `src/app/`，不然「这段代码在 App 里」的断言会随合法拆分假红。
const appSourceText = appSource();
const hookSource = readFileSync(
  new URL("../src/features/chat/usePiDesktopApp.ts", import.meta.url),
  "utf8",
);
const editBoxSource = readFileSync(
  new URL("../src/features/chat/MessageEditBox.tsx", import.meta.url),
  "utf8",
);
const serverSource = bridgeSource();

/** 参数表不算进去：默认值写在参数里，body 里看不到。 */
function functionBody(source: string, name: string): string {
  const declaration = source.indexOf(`function ${name}(`);
  assert.notEqual(declaration, -1, `function ${name} not found`);
  const openBrace = source.indexOf("{", source.indexOf(")", declaration));
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

/** `const x = useCallback(async (...) => { ... }, [...])` */
function callbackBody(source: string, name: string): string {
  const declaration = source.indexOf(`const ${name} = useCallback(`);
  assert.notEqual(declaration, -1, `callback ${name} not found`);
  const arrow = source.indexOf("=> {", declaration);
  assert.notEqual(arrow, -1, `callback ${name} has no block body`);
  const openBrace = arrow + 3;
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
  assert.fail(`callback ${name} body never closes`);
}

test("composer 记录徽标数量（发送按钮要跟着亮）", () => {
  const sync = functionBody(appSourceText, "syncComposerState");
  assert.match(
    sync,
    /setComposerCapabilityCount\(parts\.filter\(\(part\) => part\.kind === "capability"\)\.length\)/,
  );
  assert.match(
    appSourceText,
    /const \[composerCapabilityCount, setComposerCapabilityCount\] = useState\(0\)/,
  );
});

test("发送按钮：只有徽标时不再 disabled", () => {
  assert.match(
    appSourceText,
    /disabled=\{\(!composerText\.trim\(\) && attachments\.length === 0 && composerCapabilityCount === 0\)/,
  );
});

test("App handleSubmit：只有徽标时不再被当作空消息", () => {
  const body = functionBody(appSourceText, "handleSubmit");
  assert.match(
    body,
    /const hasCapabilityPart = promptParts\.some\(\(part\) => part\.kind === "capability"\)/,
  );
  assert.match(
    body,
    /if \(\(!promptText\.trim\(\) && orderedAttachments\.length === 0 && !hasCapabilityPart\) \|\| isPreparingAttachments\)/,
  );
});

test("渲染进程 submitTurn / submitEdit：守卫与 input 兜底都认识徽标", () => {
  for (const name of ["submitTurn", "submitEdit"]) {
    const body = callbackBody(hookSource, name);
    assert.match(
      body,
      /const capabilityPart = hasCapabilityPart\(contentParts\)/,
      `${name} 要判徽标`,
    );
    assert.match(
      body,
      /const input = promptFallback\(displayInput, attachments, contentParts\)/,
      `${name} 要给不空的 input`,
    );
    assert.match(
      body,
      /\(!displayInput\.trim\(\) && !attachments\.length && !capabilityPart\)/,
      `${name} 的守卫要放开徽标`,
    );
  }
});

test("编辑框：徽标计数参与 disabled 与守卫，并同样翻译 /skill:<name>", () => {
  assert.match(
    editBoxSource,
    /setCapabilityCount\(next\.filter\(\(part\) => part\.kind === "capability"\)\.length\)/,
  );
  assert.match(editBoxSource, /!text\.trim\(\) && attachmentCount === 0 && capabilityCount === 0/);
  const submit = functionBody(editBoxSource, "handleSubmit");
  assert.match(submit, /applyManualSkillCommand\(nextText, capabilities\.skills, editorParts\)/);
  assert.match(
    submit,
    /!promptText\.trim\(\) && !attachmentList\.length && !promptParts\.some\(\(part\) => part\.kind === "capability"\)/,
  );
});

test("服务端：input is required 只对「真的什么都没有」生效，且 baseInput 不是空串", () => {
  const body = functionBody(serverSource, "streamPrompt");
  assert.match(
    body,
    /const requestedCapabilities = messageParts\.filter\(\(part\) => part\?\.kind === "capability"\)/,
  );
  assert.match(
    body,
    /if \(!rawInput\.trim\(\) && !attachments\.length && !requestedCapabilities\.length\)/,
  );
  assert.match(
    body,
    /const baseInput = rawInput\n\s*\|\| \(attachments\.length \? attachmentOnlyPrompt\(attachments\) : capabilityOnlyPrompt\(requestedCapabilities\)\)/,
  );
});
