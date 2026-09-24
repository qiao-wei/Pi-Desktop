/**
 * 配色主题（appearance）回归。
 *
 * 背景：`styles.css` 从旧设计长出来，带着近百处写死的颜色。要让「换主题」真的成立，
 * 这些颜色必须先按**角色**收敛成 `--app-*` token（见 `src/app/tailwind.css` 的注释），
 * 一个主题就是对同一批 token 的完整覆盖。
 *
 * 这里钉住四类事实，都是「改错了不会报错、只会悄悄退化」的类型：
 * 1. 覆盖的完整性 —— token 是级联的，漏掉一个不会报错，只会掉回原配色；而且
 *    `:root[data-appearance]` (0,2,0) 会盖过 `.dark` (0,1,0)，所以深色那条必须
 *    多带一个 `.dark`，否则深色下永远用浅色 token。
 * 2. 默认主题不变 —— 原配色必须还是原来那几个字面量（浅色 **和** 深色），
 *    因为 `.dark` 只重写了一小批遗留规则，其余规则在深色下也照旧用浅色字面量。
 * 3. 主题真的生效 —— codex 的关键角色必须与原配色不同，否则「切换」是假的。
 * 4. 每个明暗组合下的可读性 —— 用真实使用组合算对比度，而不是只看源码字符串。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { contrast, flatten, resolveColor, type RGB, type Tokens } from "./lib/cssColor.ts";
import { appearanceDeclarations, appearanceTokens, blockTokens, themeTokens } from "./lib/cssTokens.ts";
import { normalizeAppearance } from "../src/lib/ui-preferences.ts";

const tailwindCss = readFileSync(new URL("../src/app/tailwind.css", import.meta.url), "utf8");
const stylesCss = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const prefsSource = readFileSync(new URL("../src/lib/ui-preferences.ts", import.meta.url), "utf8");
const appTsx = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/** shadcn 控件层 token：任何主题都必须定义它们，否则控件会半旧半新。 */
const SHADCN_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--app-sidebar-surface",
  "--app-content-surface",
  "--app-header-border",
];

/* ------------------------------------------------------------------ 结构守卫 */

test("codex 覆盖块排在基础 `.dark` 之后，且深色块多带一个选择器权重", () => {
  const baseDark = tailwindCss.indexOf("\n.dark {");
  const codexLight = tailwindCss.indexOf(':root[data-appearance="codex"] {');
  const codexDark = tailwindCss.indexOf(':root[data-appearance="codex"].dark {');
  assert.notEqual(baseDark, -1, "基础 `.dark` 块不见了");
  assert.notEqual(codexLight, -1, "codex 浅色块不见了");
  assert.notEqual(codexDark, -1, "codex 深色块不见了");
  // 顺序：`blockBody` 靠首次出现的文本定位，排在前面会把真正的 `.dark` 块顶掉。
  assert.ok(codexLight > baseDark, "codex 浅色块必须排在 `.dark` 之后");
  assert.ok(codexDark > codexLight, "codex 深色块必须排在它的浅色块之后");
  // 权重：`:root[data-appearance]` (0,2,0) 会盖过 `.dark` (0,1,0)；
  // 深色块靠 `.dark` 再加一级，才能反过来盖住浅色块。
  assert.ok(
    codexDark > codexLight && tailwindCss.slice(codexDark, codexDark + 60).includes(".dark"),
    "codex 深色块必须带 `.dark`，否则深色下会被浅色 token 盖住",
  );
});

test("styles.css 里不再有写死的颜色（否则主题覆盖不到它）", () => {
  const withoutComments = stylesCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const literals = [...new Set(withoutComments.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])].sort();
  // `#000` 只出现在 `color-mix(in oklab, var(--destructive) 78%, #000)` 里，
  // 那是「把危险色压暗」的固定目标，不属于配色主题。
  assert.deepEqual(
    literals,
    ["#000"],
    `styles.css 又出现了写死的颜色：${literals.join(", ")}。` +
      "请按角色加进 tailwind.css 的 `--app-*` 并在这里的 codex 块里给值。",
  );
});

/* -------------------------------------------------------------- 默认主题不变 */

test("默认主题仍然是原来那几个颜色（浅色与深色都一样）", () => {
  const classic = themeTokens(tailwindCss);
  const expected: Record<string, string> = {
    "--app-accent": "#1f7a5b",
    "--app-ink": "#17231e",
    "--app-border": "#d8d0c3",
    "--app-surface-tile": "#efede6",
    "--app-chip-bg": "#3d3d3d",
    "--app-chip-ink": "#ffffff",
  };
  for (const [token, value] of Object.entries(expected)) {
    assert.equal(classic.light[token], value, `浅色 ${token} 变了`);
    // 深色下这些字面量本来就照旧生效：`.dark` 只重写了一小批遗留规则。
    assert.equal(classic.dark[token], value, `深色 ${token} 变了`);
  }
});

/* ------------------------------------------------------------ 覆盖完整性/生效 */

test("codex 在两种明暗下都定义了全部控件 token 与全部 `--app-*` 角色", () => {
  const base = themeTokens(tailwindCss);
  const own = appearanceDeclarations(tailwindCss, "codex");
  const roleTokens = Object.keys(base.light).filter((name) => name.startsWith("--app-"));
  assert.ok(roleTokens.length >= 20, `角色 token 太少（${roleTokens.length}），收敛是不是没做全？`);

  for (const mode of ["light", "dark"] as const) {
    const declared = own[mode];
    const missing = [...SHADCN_TOKENS, ...roleTokens].filter((name) => !(name in declared));
    assert.deepEqual(
      missing,
      [],
      `codex ${mode} 缺少 ${missing.join(", ")}：级联会掉回原配色，而且不会报错`,
    );
  }
});

test("codex 的关键角色确实与原配色不同（切换有实际效果）", () => {
  const classic = themeTokens(tailwindCss);
  const codex = appearanceTokens(tailwindCss, "codex");
  for (const token of ["--app-accent", "--app-ink", "--app-border", "--app-surface-tile"]) {
    assert.notEqual(codex.light[token], classic.light[token], `codex 浅色 ${token} 与原配色相同`);
    assert.notEqual(codex.dark[token], classic.dark[token], `codex 深色 ${token} 与原配色相同`);
  }
});

/* ------------------------------------------------------------------ 可读性 */

/** 真实会同时出现的 前景/背景 组合（各自来自规则里的一对声明）。 */
const CONTRAST_PAIRS: { name: string; fg: string; bg: string; min: number; modes?: ("light" | "dark")[] }[] = [
  // 正文/标签
  { name: "正文前景落在背景上", fg: "--foreground", bg: "--background", min: 4.5 },
  { name: "正文前景落在卡片上", fg: "--foreground", bg: "--card", min: 4.5 },
  {
    // 深色下 `.dark .markdown` / `.dark .composer-editor` 会把颜色重写成 `--foreground`，
    // 所以这条 `--app-ink` 只剩浅色生效（深色由上面两条 `--foreground` 条覆盖）。
    name: "markdown / 编辑器正文",
    fg: "--app-ink",
    bg: "--app-content-surface",
    min: 4.5,
    modes: ["light"],
  },
  { name: "设置页当前分区", fg: "--app-ink", bg: "--app-surface-tile-hover", min: 4.5 },
  { name: "次级行内说明", fg: "--app-ink-muted", bg: "--card", min: 3 },
  { name: "占位符 / 分组标签", fg: "--app-ink-faint", bg: "--card", min: 3 },
  { name: "附件卡片副标题", fg: "--app-ink-soft", bg: "--app-surface-tile", min: 3 },
  // 强调态
  { name: "选中的图标按钮", fg: "--app-accent", bg: "--app-accent-tint", min: 3 },
  { name: "技能徽标圆点", fg: "--app-chip-ink", bg: "--app-accent", min: 3 },
  { name: "选中页签", fg: "--app-chip-ink", bg: "--app-chip-bg", min: 3 },
  // 状态
  { name: "错误提示", fg: "--app-danger-ink", bg: "--app-danger-wash", min: 3 },
  { name: "警告提示", fg: "--app-warning-ink", bg: "--app-warning-wash", min: 3 },
  { name: "技能圆点", fg: "--app-success", bg: "--app-success-wash", min: 3 },
  { name: "命令/MCP 圆点", fg: "--app-info", bg: "--app-info-wash", min: 3 },
];

const BACKDROP: RGB = [255, 255, 255];

/**
 * 把 token 展开成真正的像素色。
 *
 * 底色要先算成**该主题自己的页面色**，不能一律用白：codex 深色的 tile / ink 很多是
 * 半透明的（参考项目就是白/黑 alpha 阶），铺在白底上会算出「白字压白底 = 1.00:1」
 * 这种假绿。真实渲染里它们是叠在 `--background`（深色 #181818）上的。
 */
function resolve(token: string, tokens: Tokens, page: RGB): RGB {
  return flatten(resolveColor(`var(${token})`, tokens), page);
}

for (const appearance of ["default", "codex"] as const) {
  const palettes =
    appearance === "default" ? themeTokens(tailwindCss) : appearanceTokens(tailwindCss, appearance);
  for (const mode of ["light", "dark"] as const) {
    for (const pair of CONTRAST_PAIRS) {
      if (pair.modes && !pair.modes.includes(mode)) continue;
      test(`${appearance}/${mode}：${pair.name} ≥ ${pair.min}:1`, () => {
        const tokens = palettes[mode];
        const page = flatten(resolveColor("var(--background)", tokens), BACKDROP);
        const ratio = contrast(resolve(pair.fg, tokens, page), resolve(pair.bg, tokens, page));
        assert.ok(
          ratio >= pair.min,
          `${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}:1（需要 ≥ ${pair.min}）`,
        );
      });
    }
  }
}

/* ------------------------------------------------------------ 偏好与接线 */

test("深色下 usage ring 里的百分比有覆盖（存量问题：深绿落在深卡上只剩 ≈2.3:1）", () => {
  assert.match(
    stylesCss,
    /\.dark \.usage-ring span \{\s*color: var\(--foreground\);/,
    "`.usage-ring span` 用的是 `--app-accent-ink`（浅色下的深绿），深色下需要重写成前景色",
  );
});

test("未知的主题 id 落回默认值，不会让 <html> 挂上无样式的值", () => {
  assert.equal(normalizeAppearance("codex"), "codex");
  assert.equal(normalizeAppearance("default"), "default");
  assert.equal(normalizeAppearance("nord"), "default");
  assert.equal(normalizeAppearance(undefined), "default");
  assert.equal(normalizeAppearance(42), "default");
});

test("首帧之前就贴好主题，且与运行时用同一个 localStorage 键", () => {
  const key = /const UI_PREFS_KEY = "([^"]+)"/.exec(prefsSource)?.[1];
  assert.ok(key, "ui-preferences 里找不到 UI_PREFS_KEY");
  assert.ok(indexHtml.includes(`"${key}"`), `引导脚本必须读写同一个键（${key}）`);
  assert.match(indexHtml, /classList\.toggle\("dark", dark\)/, "引导脚本要贴 dark class");
  assert.match(
    indexHtml,
    /dataset\.appearance = prefs\.appearance === "codex" \? "codex" : "default"/,
    "引导脚本要贴 data-appearance",
  );
  // 同一份判断也要在运行期生效，否则 React 挂载后会把首帧的结果覆盖回去。
  assert.match(appTsx, /document\.documentElement\.dataset\.appearance = appearance;/);
  assert.match(appTsx, /classList\.toggle\("dark", theme === "dark"\)/);
  assert.match(appTsx, /saveUiPreferences\(\{\s*theme,\s*appearance,/, "主题要持久化");
});

test("设置页个性化分区提供两个主题选项并立即生效", () => {
  const options = /const appearanceOptions = \[([\s\S]*?)\] as const satisfies/.exec(appTsx)?.[1];
  assert.ok(options, "找不到 appearanceOptions");
  assert.match(options, /value: "default"/);
  assert.match(options, /value: "codex"/);
  assert.match(
    appTsx,
    /onClick=\{\(\) => onAppearanceChange\(option\.value\)\}/,
    "主题必须点一下立刻生效，不能等「保存个性化」",
  );
  assert.match(appTsx, /aria-checked=\{appearance === option\.value\}/, "单选组要有可访问状态");
});
/* ============================================================================
 * codex = 参考项目 PI-Desktop（Codex 视觉系统）的复刻
 *
 * 下面钉的是「复刻得对不对」，取值来源写进注释，方便与
 * ~/Downloads/PI-Desktop 的 apps/desktop/src/styles/tokens.css 逐条对照：
 *   §4.2/§4.3 配色 · §6.2 圆角阶梯 · §6.3 阴影 · §6.4 表层与玻璃
 *   chrome.css:427-445 平台限定的侧栏玻璃 · main/bootstrap/window.ts:188 原生 material
 * ========================================================================== */

const mainJs = readFileSync(new URL("../src-electron/main.js", import.meta.url), "utf8");
const tauriLib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const tauriConf = readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8");

test("codex 的取值逐条等于参考项目 tokens.css", () => {
  const codex = appearanceDeclarations(tailwindCss, "codex");
  const light: Record<string, string> = {
    "--background": "#ffffff",
    "--foreground": "#1a1c1f",
    "--card": "#ffffff",
    "--secondary": "#f9f9f9",
    "--muted": "#f3f3f3",
    "--accent": "#f3f3f3",
    "--primary": "#1a1c1f",
    "--border": "color-mix(in oklab, #1a1c1f 8%, transparent)",
    "--ring": "#1a1c1f",
    "--app-sidebar-surface": "#f3f3f3",
    "--app-content-surface": "#ffffff",
    "--app-surface-inset": "#ededed",
    "--app-success": "#00a240",
    "--app-warning-wash": "color-mix(in oklab, #e25507 8%, #ffffff)",
    "--app-danger": "#e02e2a",
    "--app-info": "#5d5d5d",
    "--radius": "1rem",
    "--app-radius-composer": "20px",
    "--app-radius-panel": "18px",
    "--titlebar-height": "46px",
  };
  for (const [token, value] of Object.entries(light)) {
    assert.equal(codex.light[token], value, `codex 浅色 ${token} 与参考项目不一致`);
  }

  const dark: Record<string, string> = {
    "--background": "#181818",
    "--foreground": "#ffffff",
    "--card": "#212121",
    "--popover": "#282828",
    "--muted": "#282828",
    "--muted-foreground": "color-mix(in oklab, #ffffff 70%, transparent)",
    "--primary": "#ffffff",
    "--border": "color-mix(in oklab, #ffffff 8%, transparent)",
    "--app-sidebar-surface": "#000000",
    "--app-content-surface": "#181818",
    "--app-surface-inset": "#0d0d0d",
    "--app-surface-tile": "color-mix(in oklab, #ffffff 3.5%, transparent)",
    "--app-success": "#40c977",
    "--app-danger": "#ff6764",
    "--app-info": "#afafaf",
    "--app-accent": "#ffffff",
    "--titlebar-height": "46px",
  };
  for (const [token, value] of Object.entries(dark)) {
    assert.equal(codex.dark[token], value, `codex 深色 ${token} 与参考项目不一致`);
  }
});

test("参考项目的浮层语言：深色只留 0.5px 描边，浅色是三级轻阴影", () => {
  const codex = appearanceDeclarations(tailwindCss, "codex");
  assert.match(codex.light["--app-shadow-sm"], /^0 1px 2px rgba\(0, 0, 0, 0\.05\)$/);
  assert.match(codex.light["--app-shadow-dialog"], /^0 16px 48px /);
  assert.match(
    codex.light["--app-elevation-stroke"],
    /^0 0 0 0\.5px color-mix\(in oklab, #1a1c1f 12%, transparent\)$/,
  );
  // 深色下 in-flow 浮层不带灰影：靠描边，菜单/对话框再叠一层纯黑阴影
  assert.equal(codex.dark["--app-shadow-sm"], "var(--app-elevation-stroke)");
  assert.match(codex.dark["--app-elevation-stroke"], /0 0 0 0\.5px/);
  assert.match(codex.dark["--app-shadow-dialog"], /rgba\(0, 0, 0, 0\.55\)/);
});

/* ------------------------------------------------------------------ 侧栏玻璃 */

test("玻璃只在 macOS 成立：其它平台退回不透明侧栏，不叠一层洗白的板子", () => {
  const base = themeTokens(tailwindCss).light;
  assert.equal(base["--app-sidebar-glass-tint"], "var(--app-sidebar-surface)");
  assert.equal(base["--app-sidebar-sheen-top"], "none");
  assert.equal(base["--app-sidebar-sheen-bottom"], "none");
  assert.equal(base["--app-sidebar-blur"], "none");

  const codex = appearanceDeclarations(tailwindCss, "codex");
  for (const mode of ["light", "dark"] as const) {
    const own = codex[mode];
    assert.equal(
      own["--app-sidebar-glass-tint"],
      own["--app-sidebar-surface"],
      `codex ${mode} 在没有原生 material 的平台上必须是实色侧栏`,
    );
    assert.equal(own["--app-sidebar-sheen-top"], "none", `codex ${mode} 不该默认带光泽`);
    assert.equal(own["--app-sidebar-blur"], "none", `codex ${mode} 不该默认带模糊`);
    assert.equal(own["--app-main-surface"], "var(--app-content-surface)");
    assert.equal(own["--app-shell-surface"], "var(--background)");
  }

  const DARWIN_LIGHT = ':root[data-platform="darwin"][data-appearance="codex"]';
  const DARWIN_DARK = `${DARWIN_LIGHT}.dark`;
  const light = blockTokens(tailwindCss, DARWIN_LIGHT);
  const dark = blockTokens(tailwindCss, DARWIN_DARK);
  for (const [mode, block] of [["light", light], ["dark", dark]] as const) {
    const tokens = block.tokens;
    assert.match(
      tokens["--app-sidebar-glass-tint"],
      /^color-mix\(in oklab, #\w+ \d+%, transparent\)$/,
      `darwin ${mode} 的 tint 必须是半透明混色`,
    );
    assert.match(tokens["--app-sidebar-sheen-top"], /^linear-gradient\(/);
    assert.match(tokens["--app-sidebar-sheen-bottom"], /^linear-gradient\(/);
    assert.match(tokens["--app-sidebar-blur"], /^blur\(/);
    // 外壳要让开，否则材质透不出来；但**主格不能**跟着让 —— 参考项目 chrome.css:426-445
    // 写死了 "The main pane and titlebars remain opaque bg-primary"，主格透明会让三列
    // 之间的 3px 抓取条漏出材质（实测过）。
    assert.equal(tokens["--app-main-surface"], "var(--app-content-surface)", `darwin ${mode} 主格要保持不透明`);
    assert.equal(tokens["--app-shell-surface"], "transparent", `darwin ${mode} 外壳没让开`);
  }
  assert.equal(light.tokens["--app-sidebar-glass-tint"], "color-mix(in oklab, #f3f3f3 55%, transparent)");
  assert.equal(dark.tokens["--app-sidebar-glass-tint"], "color-mix(in oklab, #000000 40%, transparent)");

  // 权重都是 (0,3,0)：浅色那条必须排在深色块之前，靠顺序让深色赢回来
  const lightAt = tailwindCss.indexOf(`${DARWIN_LIGHT} {`);
  const darkBlockAt = tailwindCss.indexOf(':root[data-appearance="codex"].dark {');
  const darkAt = tailwindCss.indexOf(`${DARWIN_DARK} {`);
  assert.ok(lightAt < darkBlockAt, "darwin 浅色玻璃块必须排在 codex 深色块之前");
  assert.ok(darkAt > darkBlockAt, "darwin 深色玻璃块必须排在 codex 深色块之后");
});

test("玻璃规则读 token，组件里不出现颜色字面量（参考 style-surface-tokens 的约定）", () => {
  const sidebarRule = /\.project-sidebar-surface \{[\s\S]*?\n\}/.exec(stylesCss)?.[0];
  assert.ok(sidebarRule, "找不到 .project-sidebar-surface");
  for (const token of [
    "--app-sidebar-glass-tint",
    "--app-sidebar-image",
    "--app-sidebar-sheen-top",
    "--app-sidebar-sheen-bottom",
    "--app-sidebar-blur",
  ]) {
    assert.ok(sidebarRule.includes(`var(${token}`), `侧栏材质要读 ${token}`);
  }
  assert.ok(!/#[0-9a-f]{3,8}/i.test(sidebarRule), "侧栏材质规则里不许写死颜色");
  assert.match(sidebarRule, /backdrop-filter: var\(--app-sidebar-blur, none\)/);

  const shellRule = /\.app-shell-surface \{[\s\S]*?\n\}/.exec(stylesCss)?.[0];
  assert.ok(shellRule, "找不到 .app-shell-surface");
  for (const token of ["--app-shell-surface", "--app-shell-border", "--app-shadow-window"]) {
    assert.ok(shellRule.includes(`var(${token}`), `窗口外壳要读 ${token}`);
  }
  // App 根圆不再自己写 bg-muted / 写死阴影，否则玻璃主题的外壳让不开
  assert.match(appTsx, /className="app-shell-surface /);
  assert.ok(!/bg-muted shadow-\[0_18px_56px/.test(appTsx), "App 根圆还留着旧的底与阴影");
});

test("原生 material 接线：Electron vibrancy 与 Tauri windowEffects 都只在 macOS 开", () => {
  assert.match(mainJs, /vibrancy: "sidebar"/);
  assert.match(mainJs, /visualEffectState: "followWindow"/);
  assert.match(
    mainJs,
    /process\.platform === "darwin"[\s\S]{0,200}vibrancy: "sidebar"/,
    "vibrancy 必须挂在 darwin 分支上",
  );
  assert.match(tauriLib, /#\[cfg\(target_os = "macos"\)\]/);
  assert.match(tauriLib, /Effect::Sidebar/);
  // tauri-utils 的 `WindowEffectState` 只有 Active / Inactive / FollowsWindowActiveState；
  // 名字是 `FollowsWindowActiveState`，与 Electron 的 `visualEffectState: "followWindow"` 同义。
  // （写错名字只会 编译不过，不会静默退化 —— 但真的要去 cargo check。）
  assert.match(tauriLib, /EffectState::FollowsWindowActiveState/);
  assert.ok(
    !/EffectState::FollowWindow\b/.test(tauriLib),
    "EffectState 没有 FollowWindow 这个变体，写成它会编译不过",
  );
  // `effects()` 返回 builder 本身（不是 Result），调用必须收在 `.build(),\n);`
  assert.match(
    tauriLib.slice(tauriLib.indexOf("EffectsBuilder")),
    /\.build\(\),\s*\n\s*\);/,
    "effects() 不是 Result，调用不能带问号再解包",
  );
  assert.match(tauriConf, /"macOSPrivateApi": true/);
});

test("引导脚本给 <html> 打上平台标记，与运行期判断同一套规则", () => {
  assert.match(indexHtml, /if \(\/mac\/i\.test\(navigator\.platform\)\) \{/);
  assert.match(indexHtml, /root\.dataset\.platform = "darwin"/);
  assert.match(appTsx, /return \/mac\/i\.test\(navigator\.platform\);/);
});

/* --------------------------------------------------- 圆角 / 阴影 token 化 */

test("styles.css 里的圆角与浮层阴影都走 token，默认档位保持原值", () => {
  const literalRadius = [...stylesCss.matchAll(/border-radius:\s*([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((value) => !value.startsWith("var(--app-radius-") && value !== "0");
  assert.deepEqual(literalRadius, [], `styles.css 还有写死的圆角：${literalRadius.join(", ")}`);

  const literalShadows = [...stylesCss.matchAll(/box-shadow:\s*([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((value) => !value.includes("var(--app-shadow-") && !value.startsWith("inset 0 0 0 1px"));
  // 剩下的只能是 focus ring（用 accent 现算的那种）
  for (const value of literalShadows) {
    assert.ok(value.includes("var(--app-accent)"), `styles.css 还有写死的浮层阴影：${value}`);
  }

  // 用到的每个档位都必须在 :root 里声明，否则会静默解析成空值
  const base = themeTokens(tailwindCss).light;
  const used = new Set(
    [...stylesCss.matchAll(/var\((--app-(?:radius|shadow)-[a-z-]+)/g)].map((m) => m[1]),
  );
  const missing = [...used].filter((token) => !(token in base));
  assert.deepEqual(missing, [], `这些档位没在 :root 声明：${missing.join(", ")}`);

  // 默认主题的档位就是原来的字面量（默认观感不变）
  assert.equal(base["--app-radius-composer"], "8px");
  assert.equal(base["--app-radius-control"], "8px");
  assert.equal(base["--app-radius-panel"], "12px");
  assert.equal(base["--app-shadow-dialog"], "0 18px 48px rgba(18, 22, 20, 0.2)");
  assert.equal(base["--app-shadow-window"], "0 18px 56px rgba(20, 24, 22, 0.18)");
});

test("App.tsx 里除了系统红绿灯不再有写死的颜色", () => {
  const literals = [
    ...new Set([...appTsx.matchAll(/(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/g)].map((m) => m[0])),
  ];
  const allowed = new Set(["#ff5f57", "#ffbd2e", "#28c840"]);
  assert.deepEqual(
    literals.filter((value) => !allowed.has(value)),
    [],
    "App.tsx 又出现写死颜色：请按角色加进 tailwind.css 的 `--app-*`",
  );
});

/* ------------------------------------------------- Tailwind 调色板家族重定向 */

/** Tailwind v4 原始色阶（来自构建产物的 `--color-*`），用来验证只动了色相。 */
const TAILWIND_ORIGINAL: Record<string, { l: number; c: number; h: number }> = {
  "--color-emerald-400": { l: 76.5, c: 0.177, h: 163.223 },
  "--color-emerald-600": { l: 59.6, c: 0.145, h: 163.225 },
  "--color-amber-50": { l: 98.7, c: 0.022, h: 95.277 },
  "--color-amber-950": { l: 27.9, c: 0.077, h: 45.635 },
  "--color-rose-500": { l: 64.5, c: 0.246, h: 16.439 },
  "--color-sky-500": { l: 68.5, c: 0.169, h: 237.323 },
  "--color-fuchsia-600": { l: 59.1, c: 0.293, h: 322.896 },
};

function oklchOf(value: string): { l: number; c: number; h: number } {
  const m = /oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/.exec(value);
  assert.ok(m, `不是 oklch 值：${value}`);
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
}

test("131 处调色板类靠覆盖 --color-* 变量换色，不改组件", () => {
  const own = appearanceDeclarations(tailwindCss, "codex").light;
  // 默认主题不接管 Tailwind 调色板，否则那是改默认观感
  assert.ok(!("--color-emerald-600" in themeTokens(tailwindCss).light));

  for (const [token, original] of Object.entries(TAILWIND_ORIGINAL)) {
    assert.ok(token in own, `codex 没重定向 ${token}，组件里那批调色板类会保持原色`);
    const now = oklchOf(own[token]);
    // 亮度原样保留 ⇒ 任何底色上的对比度都不变（这是不引入可读性回归的关键）
    assert.equal(now.l, original.l, `${token} 的亮度变了，会带来对比度回归`);
    assert.ok(now.c <= original.c + 1e-9, `${token} 的彩度被抬高了：${now.c} > ${original.c}`);
  }

  // 语义映射：成功=参考绿、警告=参考橙、错误=参考红、信息=中性灰、紫=参考紫
  assert.equal(oklchOf(own["--color-emerald-600"]).h, oklchOf("oklch(59.6% 0.145 152.9)").h);
  assert.equal(oklchOf(own["--color-amber-950"]).h, oklchOf("oklch(27.9% 0.077 45.1)").h);
  assert.equal(oklchOf(own["--color-rose-500"]).h, oklchOf("oklch(64.5% 0.1864 24.2)").h);
  // 参考项目的 --ds-info 是灰阶（gray-300/500），所以 blue/sky/cyan 一律去彩度
  for (const token of ["--color-sky-500", "--color-blue-500", "--color-cyan-500"]) {
    assert.equal(oklchOf(own[token]).c, 0, `${token} 应该是中性灰`);
  }
});

/* ------------------------------------------------- codex 的窗口 chrome（结构） */

/**
 * codex 下的窗口 chrome 是**结构**不是配色：参考项目靠 macOS 的
 * `titleBarStyle: "hiddenInset"` + 通高侧栏做到 —— 侧栏从窗口最顶端开始、红绿灯浮在
 * 它上面，主面板自带的那条 band 就是「标题栏」，上沿没有横向分界线（chrome.css:426-445）。
 *
 * 我们的骨架是「全宽标题栏 + 底下三列」，所以把**三列一起抬到窗口顶端**：侧栏、
 * 右侧栏、两条抓取条用等量 padding 把内容压回带子下面，会话列不压 —— 它的
 * `conversation-header` 本来就有 45px 高，抬上去就是窗口最上面那一排。
 *
 * 这些规则写在 tailwind.css 的**无 layer** 区（文件尾部），因为要盖过
 * `h-[calc(100dvh-…)]` / `[-webkit-app-region:drag]` 这类工具类：styles.css 在
 * `legacy` 层，`utilities` 排在它后面，同属性会输。
 */

/**
 * 找一条规则：选择器列表里含 `selector`、声明体里含 `declaration`（返回整段文本）。
 *
 * 不能只按 selector 的第一次出现来切：同一条规则常常是分组选择器（`a,\n b { … }`），
 * 而 `.context-panel-surface` 这种名字会同时出现在「抬起」和「补内边距」两条不同的规则里。
 */
function codexRule(selector: string, declaration: RegExp): string {
  const rule = [...tailwindCss.matchAll(/(?:^|\n)([^{}]*?)\{([^{}]*)\}/g)].find(
    ([, sel, body]) => sel.includes(selector) && declaration.test(body),
  );
  assert.ok(rule, `找不到同时含「${selector}」与「${declaration}」的 codex 规则`);
  return rule[0];
}

test("codex：三列通高（侧栏/右侧栏/抓取条内容位置不变，只有会话列真的往上挪）", () => {
  const lift = codexRule(".project-sidebar-surface", /margin-top:/);
  assert.match(lift, /margin-top:\s*calc\(-1 \* var\(--titlebar-height\)\)/);
  assert.match(lift, /height:\s*calc\(100% \+ var\(--titlebar-height\)\)/);
  // 右侧栏与抓取条必须一起抬：右侧那条 ::before 是整列常显的 1px 分隔线，
  // 不抬的话它在标题栏那一段是空的（用户报的「分隔线没接上去」）。
  assert.match(lift, /context-panel-surface/);
  assert.match(lift, /panel-resize-handle/);

  // 内容仍从带子下面开始，否则第一行会被窗口按钮盖住
  const pad = codexRule(".context-panel-surface", /padding-top:/);
  assert.match(pad, /padding-top:\s*var\(--titlebar-height\)/);

  // 这些是「只在 codex」的：默认主题的侧栏必须还在标题栏下面
  assert.ok(
    !stylesCss.includes("calc(-1 * var(--titlebar-height))"),
    "通高规则要留在 tailwind.css 且限定 codex，别落回 styles.css（legacy 层会被工具类盖掉）",
  );
});

test("codex：会话头就是窗口最上面那一排（下面那一排移上来、可拖、控件免拖）", () => {
  const surface = codexRule(".conversation-surface", /margin-top:/);
  assert.match(surface, /margin-top:\s*calc\(-1 \* var\(--titlebar-height\)\)/);
  assert.match(surface, /height:\s*calc\(100% \+ var\(--titlebar-height\)\)/);

  // 包着它的格子默认 overflow-hidden，不放行的话抬起来那 45px 既画不出来也接不到
  // 指针（rect 还报 y=1，elementFromPoint 却只返回外壳）—— 会话头白抬。
  assert.match(codexRule(".conversation-column", /overflow:/), /overflow:\s*visible/);

  // 抬上去之后它落在 Electron 的拖拽带里：整条可拖，控件必须显式豁免
  assert.match(
    codexRule(".conversation-header ", /-webkit-app-region:\s*drag/),
    /-webkit-app-region:\s*drag/,
  );
  const ctl = codexRule(".conversation-header button", /no-drag/);
  assert.match(ctl, /-webkit-app-region:\s*no-drag/);
  assert.match(ctl, /\[role="button"\]/);
});

test("codex：标题栏退成一条留白（不留可见的「栏」，中格那行重复标题隐藏）", () => {
  const bar = codexRule(".app-titlebar", /grid-template-columns:/);

  // 自己不再画底色（三列都通高，底色已由格子铺满）
  assert.match(bar, /background:\s*transparent/);
  assert.match(bar, /border-bottom-color:\s*transparent/);
  // 左格贴着侧栏宽（红绿灯那段），中格让给会话头，右格留给窗口图标
  assert.match(bar, /grid-template-columns:\s*var\(--left-sidebar-width\) minmax\(0, 1fr\) auto/);
  // 自己不吃事件，否则会吞掉会话头里的按钮
  assert.match(bar, /pointer-events:\s*none/);

  // 中格用 visibility 而不是 display：display 会把右格挤到第二道轨道上
  const middle = codexRule(".app-titlebar > :nth-child(2)", /visibility:/);
  assert.match(middle, /visibility:\s*hidden/);
  assert.ok(!/display:\s*none/.test(middle), "中格只能用 visibility:hidden，不能用 display:none");
});

test("codex 的结构规则全部限定在 codex 档（默认主题的 chrome 不许被碰）", () => {
  // 只挑「布局类」属性，避免把别处的 padding 误判进来
  const layoutRules = [
    ...tailwindCss.matchAll(/(^|[^,{]*)\{([^}]*)\}/gm),
  ].filter(([, selector, body]) =>
    /--titlebar-height|--left-sidebar-width/.test(body) && /(margin-top|height|padding-top|linear-gradient)/.test(body),
  );

  assert.ok(layoutRules.length >= 2, "应该能找到那两条 codex chrome 规则");
  for (const [, selector, body] of layoutRules) {
    if (!/\.app-titlebar|\.project-sidebar-surface/.test(selector)) continue;
    assert.ok(
      selector.includes('[data-appearance="codex"]'),
      `这条改动的布局没限定 codex，会动到默认主题：${selector.trim()} → ${body.trim().slice(0, 60)}`,
    );
  }
});

test("列宽变量挂在 shell 上（标题栏要按侧栏宽度决定哪一段透明）", () => {
  const shell = appTsx.slice(appTsx.indexOf("app-shell-surface flex h-dvh"));
  const block = shell.slice(0, shell.indexOf("<TitleBar"));

  assert.match(block, /"--left-sidebar-width":/, "shell 上要暴露 --left-sidebar-width，否则标题栏的硬切渐变没有依据");
  assert.match(block, /"--right-panel-width":/);

  // 原来挂在 <main> 上；两边都留会让人以为标题栏也能读（它读不到，是兄弟节点）
  const main = appTsx.slice(appTsx.indexOf("<main\n"), appTsx.indexOf("<main\n") + 600);
  assert.ok(!/"--left-sidebar-width":/.test(main), "列宽变量已经从 <main> 移到 shell，别留两份");
});

/**
 * 参考项目原文（chrome.css:426-445）："The main pane and titlebars remain opaque
 * bg-primary" —— 玻璃只有侧栏那一条。主区若跟着透明，三列之间的 3px 抓取条就会把
 * 原生材质漏成三道玻璃竖线（真实 app 里量到过），所以这条要钉死。
 */
test("codex+darwin：只有侧栏是玻璃，主区保持不透明", () => {
  for (const selector of [
    ':root[data-platform="darwin"][data-appearance="codex"]',
    ':root[data-platform="darwin"][data-appearance="codex"].dark',
  ]) {
    const { tokens } = blockTokens(tailwindCss, selector);

    assert.equal(
      tokens["--app-main-surface"],
      "var(--app-content-surface)",
      `${selector} 的主区必须不透明（否则抓取条漏材质）`,
    );
    assert.equal(tokens["--app-shell-surface"], "transparent", `${selector} 的外壳要透明才看得到材质`);
    assert.match(tokens["--app-sidebar-glass-tint"] ?? "", /color-mix\(in oklab, #[0-9a-f]{6} \d+%, transparent\)/);
    assert.match(tokens["--app-sidebar-blur"] ?? "", /blur\(/);
    assert.match(tokens["--app-sidebar-sheen-top"] ?? "", /linear-gradient\(/);
  }
});

test("codex：不透明底色画在格子上，不画在 .app-main 上（否则垫到玻璃底下）", () => {
  const at = tailwindCss.indexOf(':root[data-appearance="codex"] .app-main {');
  assert.ok(at > 0, "找不到 codex 的 .app-main 规则");
  const rule = tailwindCss.slice(at, tailwindCss.indexOf("}", at));

  // 网格容器自己不能有底色：它的背景会铺到侧栏那一列底下，材质就透不上来
  assert.match(rule, /background:\s*transparent/);
  assert.ok(!/background:\s*var\(--app-content-surface\)/.test(rule), ".app-main 上别铺不透明底色");
  // 抬起来的侧栏要允许溢出，否则顶部 46px 被父级裁掉、露出一道硬缝
  assert.match(rule, /overflow:\s*visible/);

  const cells = tailwindCss.slice(tailwindCss.indexOf(".app-main > :not(.project-sidebar-surface)"));
  const cellRule = cells.slice(0, cells.indexOf("}"));
  assert.match(cellRule, /background-color:\s*var\(--app-content-surface\)/, "会话列/右侧栏/3px 抓取条要不透明");
});

/**
 * 会话头右边必须给标题栏那两个图标（语言 / 面板开关）留位。
 *
 * 实测过的 bug：**右侧面板收起时**主区顶到窗口右缘，图标正好压在分支信息上
 * （dev 栈里量到重叠 59px，用户截图里同一处）。面板自己占的宽度要算进可用空间 ——
 * 面板宽了图标就落在面板那一列里，不必再留。
 *
 * 留位必须用 `margin`（缩掉盒子）而不能用 `padding`（只挪内容）：会话头整条是 drag 区，
 * 用 padding 时它的拖拽矩形照样伸到图标底下，而兄弟子树的 `no-drag` 挖不动别人的 drag
 * 区 —— 真机上那两个图标会直接点不动（CDP 注入的鼠标事件绕过拖拽判定，测不出来，所以
 * 这条断言必须盯住实现方式本身）。
 */
test("codex：会话头用 margin 留位（drag 矩形不能伸到标题栏图标底下）", () => {
  const rule = codexRule(".conversation-header", /margin-right:/);

  assert.ok(rule.includes('[data-appearance="codex"]'), "这条必须限定 codex");
  assert.match(
    rule,
    /margin-right:\s*calc\(12px \+ max\(0px, 80px - var\(--right-panel-width/,
    "要用 max() 把右侧面板宽度算进去，不能写死常量",
  );
  assert.doesNotMatch(
    rule,
    /padding-right:\s*calc\(/,
    "不能退回 padding：那不会缩掉 drag 矩形，图标又会被拖拽区吞掉",
  );
});

/**
 * 图标那一格自己声明 no-drag，以及会话头左边界那条挖洞。
 *
 * 依赖“按钮去挖父级的洞”时，跨子树的 drag 区（面板收起时伸到右侧的会话头）会把图标吞掉；
 * 把**整格**摘出拖拽区，就不看具体命中模型了。
 */
test("codex：图标那一格自己摘出拖拽区（不依赖按钮挖洞）", () => {
  const cell = codexRule(".app-titlebar > :last-child", /-webkit-app-region:\s*no-drag/);

  assert.ok(cell.includes('[data-appearance="codex"]'), "这条必须限定 codex");
});

test("codex：会话头左边界用同宗 no-drag 挖洞（侧栏收起时红绿灯不被吞）", () => {
  const rule = codexRule(".conversation-header::before", /no-drag/);
  // 只看规则体：匹配串里带着上面那条注释，注释里提到过属性名会把断言喂成假绿。
  const body = rule.slice(rule.indexOf("{"));

  assert.ok(rule.slice(0, rule.indexOf("{")).includes('[data-appearance="codex"]'), "这条必须限定 codex");
  assert.match(body, /width:\s*max\(0px, 76px - var\(--left-sidebar-width/, "左侧留位同样要按侧栏宽度算");
  assert.match(body, /pointer-events:\s*none/, "挖洞用的伪元素不能在渲染层挡住点击");
});
