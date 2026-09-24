/**
 * Package 命令(/review 等)在桥侧的 UI 接线守卫。
 *
 * 背景:点击包卡片上的 /review「没反应」。根因:桥的 uiBridge `custom()` 调扩展
 * factory 时把 theme 写死为 `{}`,而 pi-review 的选择器 factory 同步调用
 * `theme.bold(...)` → TypeError → 桥把弹层当 `closed` 秒发,prompt 又正常返回
 * (pi 会吞掉扩展命令错误,只发给 runner 的 error listeners),前端既没弹窗也没
 * 报错。修法:①给 factory 和 ctx.ui.theme 一个方法齐全的透传 theme;
 * ②streamCapabilityPackageCommand 把 runner 的命令错误转成 {type:"error"} 事件。
 *
 * 这些是接线守卫(结构性断言),全部限定在目标函数/常量体内提取,
 * 避免被文件里其他同名写法满足(假绿)。行为层由真机验证:点 /review 应弹出选择器。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { constObjectBody, functionBody } from "./lib/sourceText.ts";

const server = readFileSync(join(import.meta.dirname, "../server/index.mjs"), "utf8");
test("headlessUiTheme 覆盖 Theme 的颜色/字重 API(/review 的 factory 直接踩 bold)", () => {
  const theme = constObjectBody(server, "headlessUiTheme");
  // pi 的 Theme API:fg/bg(color, text) + bold/italic/underline/inverse/strikethrough(text)。
  for (const method of ["fg", "bg", "bold", "italic", "underline", "inverse", "strikethrough"]) {
    assert.match(theme, new RegExp(`\\b${method}:\\s*\\(`), `headlessUiTheme 缺 ${method}`);
  }
});

test("custom() 递给扩展 factory 的 theme 是完整透传对象(不是 {})", () => {
  const bridge = functionBody(server, "createExtensionUiBridge");
  // 2026-09-24:主题从写死的 headlessUiTheme 改为按呈现方式取的 activeUiTheme(),
  // 但「必须是有全套方法的透传 theme」这条不变 —— factory 会直接调 theme.bold(...)。
  assert.match(
    bridge,
    /factory\(fakeTui,\s*activeUiTheme\(\),\s*fakeKeybindings,/,
    "custom() 的 factory 调用必须注入 activeUiTheme()",
  );
  assert.doesNotMatch(
    bridge,
    /factory\(fakeTui,\s*\{\s*,/,
    "factory 的 theme 参数不允许再传空对象",
  );
});

test("ctx.ui.theme 返回同一个透传对象(补齐旧版只有 fg 的残缺主题)", () => {
  const context = functionBody(server, "createUiContext");
  assert.match(context, /get theme\(\)\s*\{\s*return activeUiTheme\(\);/);
});

test("桥启动即 initTheme（/end-review 的 BorderedLoader→keyHint 依赖模块级 theme）", () => {
  // pi 的 theme 是 globalThis 代理，未初始化时任何属性访问都抛
  // "Theme not initialized. Call initTheme() first."。BorderedLoader（/end-review
  // 总结加载器）构造函数无条件调 keyHint → theme.fg，所以桥必须在启动时补上 TUI
  // 才会做的 initTheme。断言限定在 agentDir 定义到 agentBinDir 之间的启动块。
  assert.match(
    server,
    /\n  initTheme,\n\} from "@earendil-works\/pi-coding-agent";/,
    "initTheme 必须从 pi-coding-agent 导入",
  );
  const start = server.indexOf("const agentDir = ");
  const end = server.indexOf("const agentBinDir");
  assert.ok(start >= 0 && end > start, "找不到启动常量区");
  const startupBlock = server.slice(start, end);
  assert.match(
    startupBlock,
    /initTheme\(SettingsManager\.create\(appCwd, agentDir, \{ projectTrusted: false \}\)\.getTheme\(\), false\)/,
    "启动块必须用全局设置的主题调 initTheme",
  );
  assert.match(startupBlock, /\} catch \{\s*initTheme\(undefined, false\);/, "主题读取失败必须回退默认主题");
});

test("包命令执行期间的扩展错误转发成 {type:\"error\"} 事件(消静默失败)", () => {
  const handler = functionBody(server, "streamCapabilityPackageCommand");
  assert.match(
    handler,
    /extensionRunner\?\.onError\?\.\(\(error\) =>\s*\{\s*const detail[\s\S]{0,200}type: "error",\s*message:/,
    "必须订阅 extensionRunner.onError 并 writeEvent error",
  );
  // finally 里必须退订,否则监听器跨请求泄漏。
  const finallyIndex = handler.indexOf("} finally {");
  assert.ok(finallyIndex >= 0, "streamCapabilityPackageCommand 缺 finally");
  const finallyBlock = handler.slice(finallyIndex);
  assert.match(finallyBlock, /unsubscribeExtensionErrors\?\.\(\);/, "finally 必须退订 onError");
});

/**
 * 桥把扩展上下文的 mode 标成 "tui" 而不是 "rpc"。pi-core 的约定是
 * `ctx.ui.custom()` 只在 "tui" 下可用("rpc" 里是立即返回的 headless stub),而桥其实
 * 实现了真的 custom()(把 TUI 组件渲染成文本 + 转发按键)。
 * pi-mcp-adapter >= 2.27.0 用 `canRenderPanel = hasUI && mode === "tui"` 守卫交互面板,
 * 标 "rpc" 会让它的 /mcp、/mcp setup、/mcp-auth 面板全部退化成一条通知。
 */
test('扩展上下文 mode 标为 "tui",让依赖 custom() 的交互面板不再退化', () => {
  const bind = functionBody(server, "bindPiDesktopSessionExtensions");
  assert.match(bind, /mode:\s*"tui"/, "bindExtensions 必须用 mode: \"tui\"");
  assert.doesNotMatch(bind, /mode:\s*"rpc"/, "bindExtensions 不允许再标 \"rpc\"");
});
