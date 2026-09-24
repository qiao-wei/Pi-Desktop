/**
 * 设置 → 个性化 里的「扩展面板呈现方式」端到端接线守卫。
 *
 * 背景:扩展的交互面板(`ctx.ui.custom()`)只有终端文本行这一个出口,面板本身也只认按键。
 * 所以「网页风格」不是新 API,而是:桥用会发颜色的 theme 渲染同一批行(request 上标
 * `renderMode: "webui"`),前端用 `src/shared/terminalText.ts` 解析成 DOM,并把点击翻译成
 * 按键(`inputs`)回灌给组件 —— 组件的状态机始终是唯一权威。
 *
 * 这里钉住的是两件容易静默坏掉的事:
 * 1. 默认必须是 `tui`:老用户升级后看到的还是原来那套纯文本面板;
 * 2. 两端共用的「强调色」约定:桥发 SGR 96,读取侧认 `ansi-bright-cyan` —— 错一个,
 *    「光标在展开行上」的点击距离就会算错(`▾` 与空闲展开行无法区分)。
 *
 * 行为层由 `tests/terminalText.test.ts` 覆盖;桥是脚本不能 import,只能按函数体做结构断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { EXTENSION_UI_ACCENT_COLOR, parseTerminalLines } from "../src/shared/terminalText.ts";
import { constObjectBody, functionBody } from "./lib/sourceText.ts";

const server = readFileSync(join(import.meta.dirname, "../server/index.mjs"), "utf8");
const read = (path: string): string => readFileSync(join(import.meta.dirname, "..", path), "utf8");

test("两端共用的强调色约定:SGR 96 ⇄ ansi-bright-cyan", () => {
  // 行为侧:96 必须解析成读取侧认的那个记号(不是「碰巧也是蓝色」)。
  const [line] = parseTerminalLines(["\u001b[96m▸\u001b[39m"]);
  assert.equal(line!.segments[0]!.style.color, EXTENSION_UI_ACCENT_COLOR);

  // 生产侧:桥必须用 96 做 accent,并把它嵌进 fg/borderAccent 两个角色。
  assert.match(server, /const extensionUiAnsiAccent = "96";/, "accent 的 ANSI 码变了就要同步读取侧");
  const codes = constObjectBody(server, "extensionUiAnsiFgCodes");
  assert.match(codes, /accent:\s*extensionUiAnsiAccent,/);
  assert.match(codes, /borderAccent:\s*extensionUiAnsiAccent,/);
});

test("默认是 tui：升级后不动老用户的面板", () => {
  assert.match(server, /const defaultExtensionUiMode = "tui";/);
  const normalize = functionBody(server, "normalizeExtensionUiMode");
  assert.match(
    normalize,
    /return extensionUiModes\.includes\(mode\) \? mode : defaultExtensionUiMode;/,
    "未知/缺省值必须回落到默认模式,而不是原样透传",
  );
  // 客户端同样兜底成 tui(旧桥不下发 renderMode 时)。
  const hook = read("src/features/chat/usePiDesktopApp.ts");
  assert.match(hook, /extensionUi: bootstrap\.personalization\?\.extensionUi \?\? "tui",/);
  assert.match(hook, /extensionUi: "tui",/, "空状态也要有默认值");
});

test("模式写入/读出 personalization.json 并随快照回到前端", () => {
  const load = functionBody(server, "loadPersonalization");
  assert.match(load, /extensionUi: normalizeExtensionUiMode\(stored\?\.extensionUi\)/);

  const save = functionBody(server, "setPersonalization");
  assert.match(save, /const extensionUi = normalizeExtensionUiMode\(body\?\.extensionUi\);/);
  assert.match(save, /personalization = \{ style, customInstructions, persona, extensionUi \};/);
  // 它是 UI 偏好,不是模型指令:不能混进系统提示词。
  const instruction = functionBody(server, "personalizationInstruction");
  assert.doesNotMatch(instruction, /extensionUi/, "呈现方式不能进系统提示词");
});

test("custom() 每次调用读一次模式：改完设置下一个面板就生效，不用重连", () => {
  const bridge = functionBody(server, "createExtensionUiBridge");
  assert.match(bridge, /const renderMode = extensionUiRenderMode\(\);/);
  assert.match(bridge, /renderMode,\n/, "request 上必须带 renderMode");
});

test("webui 才发颜色：activeUiTheme 只在 webui 下换成 ansiUiTheme", () => {
  const pick = functionBody(server, "activeUiTheme");
  assert.match(pick, /return extensionUiRenderMode\(\) === "webui" \? ansiUiTheme : headlessUiTheme;/);

  const themed = functionBody(server, "extensionUiRenderMode");
  assert.match(themed, /normalizeExtensionUiMode\(personalization\?\.extensionUi\)/);

  // ansiUiTheme 必须和 headlessUiTheme 一样覆盖整套 Theme API,否则扩展 factory 同步抛错。
  const ansi = constObjectBody(server, "ansiUiTheme");
  for (const method of ["fg", "bg", "bold", "italic", "underline", "inverse", "strikethrough", "getFgAnsi", "getBgAnsi"]) {
    assert.match(ansi, new RegExp(`\\b${method}:\\s*\\(`), `ansiUiTheme 缺 ${method}`);
  }
});

test("一次点击 = 一串按键：服务端按顺序回放 inputs，组件关闭就停", () => {
  const respond = functionBody(server, "respond");
  assert.match(respond, /const keys = readKeyResponse\(response\);/);
  assert.match(respond, /for \(const data of keys\)\s*\{[\s\S]{0,200}handleInput\?\.\(data\)/);
  assert.match(respond, /if \(pendingRequests\.get\(String\(response\.id\)\) !== pending\) break;/);

  const reader = functionBody(server, "readKeyResponse");
  assert.match(reader, /Array\.isArray\(response\?\.inputs\)/, "批量按键走 inputs");
  assert.match(reader, /typeof response\?\.input === "string" \? \[response\.input\]/, "单键仍走 input");
});

test("前端:点击回包不能把面板关掉，面板组件按 renderMode 分支", () => {
  const hook = read("src/features/chat/usePiDesktopApp.ts");
  assert.match(
    hook,
    /if \("input" in response \|\| "inputs" in response \|\| "action" in response\)/,
    "inputs 必须像 input 一样保持面板打开(服务端会推新的一帧回来)",
  );

  const api = read("src/lib/api.ts");
  assert.match(api, /renderMode\?: ExtensionUiMode;/);
  assert.match(api, /\| \{ id: string; inputs: string\[\] \}/);

  const panel = read("src/components/ExtensionCustomUiPanel.tsx");
  assert.match(panel, /request\.renderMode === "webui" \? "webui" : "tui"/, "缺省必须是 tui");
  assert.match(panel, /parseTerminalLines\(request\.lines \?\? \[\]\)/);
  assert.match(panel, /onRespond\(\{ id: request\.id, inputs: target\.keys \}\)/, "点击只能翻译成按键");
  // App 只负责挂载共享组件,不再自己实现一份终端面板。
  const app = read("src/app/App.tsx");
  assert.match(app, /<ExtensionCustomUiPanel/);
  assert.doesNotMatch(app, /function ExtensionCustomUi\(/, "旧的内联面板必须删掉,避免两份实现漂移");
});

test("纯文本出口（widget/状态栏/窗口标题）会把颜色码剥掉，不显示转义字符", () => {
  // webui 模式下 `ctx.ui.theme` 会发 SGR，而扩展也常拿它涂 widget/status 文案；
  // 这几个出口不是终端，必须当纯文本处理。
  const app = read("src/app/App.tsx");
  assert.match(functionBody(app, "ExtensionWidgetStack"), /stripTerminalSequences\(line\)/);
  assert.match(functionBody(app, "ExtensionStatusBar"), /stripTerminalSequences\(value\)/);
  assert.match(app, /document\.title = stripTerminalSequences\(state\.extensionTitle \?\? ""\)/);
});

test("滚轮只能变成上下键：不确认、不越权，Shift 留给原生滚动", () => {
  const panel = read("src/components/ExtensionCustomUiPanel.tsx");
  const rows = functionBody(panel, "ExtensionPanelRows");

  // React 的 onWheel 是 passive，preventDefault 会被忽略 → 必须自己挂非 passive 监听。
  assert.match(rows, /addEventListener\("wheel", listener, \{ passive: false \}\)/);
  assert.match(rows, /removeEventListener\("wheel", listener\)/, "卸载要成对，否则弹层会泄监听");

  // 滚轮只发方向键；回车只能来自点击/键盘。
  assert.match(rows, /wheelSteps\.current\.push\(event, performance\.now\(\)\)/);
  assert.match(panel, /steps < 0 \? TERMINAL_KEYS\.up : TERMINAL_KEYS\.down/);
  const wheelKeys = panel.slice(panel.indexOf("onStep={"), panel.indexOf("onStep={") + 400);
  assert.doesNotMatch(wheelKeys, /TERMINAL_KEYS\.enter/, "滚轮绝不能捎带回车");

  // 修饰键让位给原生滚动（面板比视口高时仍能看完）。
  assert.match(rows, /event\.shiftKey \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey/);
  // 认不出可导航行时不接管滚轮，否则面板就没法滚了。
  assert.match(rows, /if \(!navigable \|\| event\.shiftKey/);
  // 每次新帧把光标行带回可视区。
  assert.match(rows, /cursorRowRef\.current\?\.scrollIntoView\(\{ block: "nearest" \}\)/);
});

test("设置页给出这两个选项，并且保存走已有的 personalization 通道", () => {
  const app = read("src/app/App.tsx");
  assert.match(app, /const personalizationExtensionUiOptions = \[/);
  assert.match(app, /value: "tui", labelKey: "settings\.extensionUi\.tui\.label"/);
  assert.match(app, /value: "webui", labelKey: "settings\.extensionUi\.webui\.label"/);
  assert.match(
    app,
    /personalizationDraft\.extensionUi === option\.value/,
    "选中态必须读同一个 draft 字段(否则保存的不是用户点的那项)",
  );

  // 服务端白名单与前端选项必须一致。
  assert.match(server, /const extensionUiModes = \["tui", "webui"\];/);
});