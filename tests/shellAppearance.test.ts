/**
 * 界面主题 → 宿主窗口外观的同步。
 *
 * 背景（真踩过的坑）：macOS 的原生侧栏材质（Electron 的 `vibrancy: "sidebar"`、Tauri 的
 * `Effect::Sidebar`）明暗**只跟随窗口/系统的 NSAppearance**，而我们的浅色/深色是渲染层
 * 自己的（`<html class="dark">`）。系统浅色 + 界面深色时，一层浅色玻璃垫在深色侧栏下 ——
 * 白字落在发灰的板上，看上去就是「主题完全没实现」，而且改任何 token 都救不回来。
 *
 * 这条链路跨四个文件：`index.html` 首帧脚本 → `src/lib/shell-appearance.ts`（运行期权威）
 * → `src-electron/preload.js` 的命令白名单 → 宿主 handler（`host-commands.js` /
 * `src-tauri/src/lib.rs`）。任何一处漏掉都**不报错**，只是材质明暗悄悄不跟随主题，
 * 所以这里除了钉住接线，还真跑一次 renderer 侧的行为。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { syncShellAppearance } from "../src/lib/shell-appearance.ts";

const COMMAND = "set_window_appearance";

const preloadSource = readFileSync(new URL("../src-electron/preload.js", import.meta.url), "utf8");
const hostCommandsSource = readFileSync(new URL("../src-electron/host-commands.js", import.meta.url), "utf8");
const tauriSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const appTsx = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const shellAppearanceSource = readFileSync(new URL("../src/lib/shell-appearance.ts", import.meta.url), "utf8");

type AnyRecord = Record<string, unknown>;

/** 装一个假的 `window`（宿主在场 / 不在场都由它表达），返回还原函数。 */
function stubWindow(value: unknown): () => void {
  const scope = globalThis as AnyRecord;
  const had = "window" in scope;
  const previous = scope.window;
  scope.window = value;

  return () => {
    if (had) {
      scope.window = previous;
    } else {
      delete scope.window;
    }
  };
}

function recordInvoke(): { calls: Array<{ command: string; args: unknown }>; value: unknown } {
  const calls: Array<{ command: string; args: unknown }> = [];

  return {
    calls,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: unknown) => {
          calls.push({ command, args });
        },
      },
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("宿主在场时把主题发给宿主（深色/浅色都要发，不能只发深色）", async () => {
  for (const theme of ["dark", "light"] as const) {
    const { calls, value } = recordInvoke();
    const restore = stubWindow(value);

    try {
      syncShellAppearance(theme);
      await settle();
      assert.deepEqual(calls, [{ command: COMMAND, args: { appearance: theme } }]);
    } finally {
      restore();
    }
  }
});

test("纯浏览器（没有 __TAURI_INTERNALS__）里既不发请求也不抛错", async () => {
  // 先钉住「发之前先问一句宿主在不在场」：这条守卫被删掉后（改成直接 invoke），
  // 错误就只在浏览器里现场出现，测试跑不到那儿。
  assert.match(shellAppearanceSource, /if \(!hasShellBridge\(\)\) \{\s*\n\s*return;\s*\n\s*\}/);

  for (const scope of [undefined, {}]) {
    const restore = stubWindow(scope);

    try {
      // `invoke` 在浏览器里会同步抛错；主题 effect 在挂载时就会调它，
      // 抛出去等于把整个界面带崩。
      assert.doesNotThrow(() => syncShellAppearance("dark"));
      await settle();
    } finally {
      restore();
    }
  }
});

test("宿主拒绝（旧 preload 不认识这个命令）不该变成未处理的 rejection", async () => {
  const restore = stubWindow({
    __TAURI_INTERNALS__: {
      invoke: async () => {
        throw new Error("Unsupported host command: set_window_appearance");
      },
    },
  });

  try {
    assert.doesNotThrow(() => syncShellAppearance("dark"));
    // 未捕获的 rejection 会让 node 的测试进程直接失败，所以这里必须 settle 一次。
    await settle();
  } finally {
    restore();
  }
});

test("运行期由 App 的主题 effect 触发（不是只在设置页点一下才同步）", () => {
  const effect = appTsx.slice(
    appTsx.indexOf('document.documentElement.classList.toggle("dark"'),
    appTsx.indexOf('document.documentElement.classList.toggle("dark"') + 900,
  );

  assert.match(effect, /dataset\.appearance = appearance/, "先确认切到了主题 effect");
  // 要求它是**活代码**（行首就是调用），注释掉的、被包在 if (false) 里的都不算
  assert.match(
    effect,
    /^[ \t]*syncShellAppearance\(theme\);/m,
    "主题 effect 里必须同步窗口外观，否则系统浅色 + 界面深色会得到一块发白的玻璃",
  );
});

test("首帧脚本也同步一次（否则 React 挂载前会闪一帧浅色玻璃）", () => {
  assert.match(
    indexHtml,
    /if \(shell && typeof shell\.invoke === "function"\) \{/,
    "首帧脚本要先判断宿主在不在场（也要真的在那个分支里）",
  );
  assert.match(indexHtml, /set_window_appearance[\s\S]{0,80}appearance: dark \? "dark" : "light"/);
  // 必须在 React 之前：这段在主包的 <script type="module"> 之前执行
  assert.ok(
    indexHtml.indexOf(COMMAND) < indexHtml.indexOf('src="/src/main.tsx"'),
    "首帧脚本要排在主包前面",
  );
});

test("三个宿主侧入口必须同时认识这个命令", () => {
  // 1. preload 白名单：漏了 renderer 会拿到 `Unsupported host command`
  assert.match(preloadSource, new RegExp(`"${COMMAND}",`), "preload 的 HOST_COMMANDS 少了这个命令");

  // 2. Electron：改 nativeTheme.themeSource，Electron 会一并改 NSApp.appearance
  assert.match(hostCommandsSource, new RegExp(`ipcMain\\.handle\\("${COMMAND}"`));
  assert.match(hostCommandsSource, /nativeTheme\.themeSource = source/);
  // 材质的明暗看的是 effective appearance，不是 themeSource；把它回给渲染层，
  // 「材质没跟着翻」就是可观测的，而不是只能靠肉眼。
  assert.match(hostCommandsSource, /getEffectiveAppearance/);
  assert.match(hostCommandsSource, /effectiveAppearance/);

  // 3. Tauri：Window::set_theme(Some(Theme::Dark | Theme::Light))
  assert.match(tauriSource, new RegExp(`fn ${COMMAND}\\(window: Window, appearance: String\\)`));
  assert.match(tauriSource, /window\s*\.\s*set_theme\(Some\(theme\)\)/);
  assert.match(tauriSource, /"dark" => Theme::Dark/);
  assert.match(tauriSource, /"light" => Theme::Light/);
});

test("宿主命令清单三处一致（preload 白名单 / Tauri 声明 / 注册表）", () => {
  const allowlist = [...preloadSource.matchAll(/^\s+"([a-z_]+)",$/gm)].map((m) => m[1]);
  const declared = [...tauriSource.matchAll(/#\[tauri::command\]\s*\nfn ([a-z_]+)/g)].map((m) => m[1]);
  const registered = tauriSource
    .match(/generate_handler!\[([\s\S]*?)\]/)![1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const sorted = (values: string[]) => [...values].sort();
  assert.deepEqual(sorted(allowlist), sorted(registered), "preload 白名单与 Tauri 注册表不一致");
  assert.deepEqual(sorted(declared), sorted(registered), "Tauri 声明了但没注册（或反之）");
  assert.ok(allowlist.includes(COMMAND));
});

test("两侧对未知取值口径一致：都拒绝，而不是默默当成浅色", async () => {
  const { themeSourceFor } = await import("../src-electron/host-commands.js");

  assert.equal(themeSourceFor("dark"), "dark");
  assert.equal(themeSourceFor("light"), "light");
  for (const junk of [undefined, null, "", "Dark", "system"]) {
    assert.equal(themeSourceFor(junk), null, `${String(junk)} 不该被接受`);
  }
});