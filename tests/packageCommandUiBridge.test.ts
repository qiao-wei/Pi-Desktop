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
import { bridgeEntrySource, bridgeSource } from "./lib/bridgeSource.ts";

const server = bridgeSource();
// 内核引用只走适配层（kernel-adapter 边界）：断言要同时看 re-export 与导入来源。
const piKernel = readFileSync(join(import.meta.dirname, "../server/piKernel.mjs"), "utf8");
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
  // 只断言「这两个符号确实来自那条 import」，不钉 import 列表的完整字面量 ——
  // 列表里加一个符号（本轮加了 stripFrontmatter）不该把这条测试弄红。
  // 同一模块可能有多条 import（桥就分成两条：一条拿 runtime 工具，一条拿 initTheme 等）——
  // 把所有 `from "<spec>"` 的具名导入合起来看。
  // 用「字面量切分」拿 import 列表，不走正则转义：文件里有 JSDoc 用
  // `import { x } ... from "@earendil-works/pi-coding-agent"` 举例（讲 `export { x } from` 的坑），
  // 用正则很容易命中那段注释。这里按 `} from "<spec>";` 切，再往前找最近的 `import {`。
  const symbolsOf = (source, spec) => {
    const marker = `} from "${spec}";`;
    const chunks = source.split(marker);
    return chunks
      .slice(0, -1)
      .map((chunk) => {
        const start = chunk.lastIndexOf("import {");
        return start >= 0 ? chunk.slice(start + "import {".length) : "";
      })
      .flatMap((block) => block.split(/[,\s]+/).filter(Boolean));
  };
  assert.ok(
    symbolsOf(piKernel, "@earendil-works/pi-coding-agent").includes("initTheme"),
    "initTheme 必须从 pi-coding-agent 导入（适配层）",
  );
  assert.ok(
    symbolsOf(server, "./piKernel.mjs").includes("initTheme"),
    "桥必须通过 piKernel.mjs 拿到 initTheme",
  );
  // 启动时真的调了 initTheme：调用点现在在**启动工厂** server/boot.mjs（路径/环境常量与装配一起搬过去了），
  // 所以断言看整棵桥树，再钉住「入口在启动时确实调了这个工厂」。
  const all = bridgeSource();
  assert.match(
    all,
    /initTheme\(SettingsManager\.create\(appCwd, agentDir, \{ projectTrusted: false \}\)\.getTheme\(\), false\)/,
    "启动时必须用全局设置的主题调 initTheme",
  );
  assert.match(all, /\} catch \{\s*initTheme\(undefined, false\);/, "主题读取失败必须回退默认主题");
  assert.match(
    bridgeEntrySource(),
    /const boot = await createBridgeBoot\(\);/,
    "入口必须在启动时（组合区之前）就跑启动工厂，否则上面的 initTheme 不会发生",
  );
});

test('包命令执行期间的扩展错误转发成 {type:"error"} 事件(消静默失败)', () => {
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
  assert.match(bind, /mode:\s*"tui"/, 'bindExtensions 必须用 mode: "tui"');
  assert.doesNotMatch(bind, /mode:\s*"rpc"/, 'bindExtensions 不允许再标 "rpc"');
});
