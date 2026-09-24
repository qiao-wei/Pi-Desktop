/**
 * 主题注册表的结构守卫 —— 「新增主题 = 新建一个目录」的保证。
 *
 * 这些是**结构性**事实，改错了不会报错、只会悄悄退化（样式漏一层、主题之间互相
 * 污染、或者新主题必须回来改一堆共享文件），所以逐条钉住：
 *
 * 1. 目录自洽：`meta.ts` + `theme.css` 齐全，`meta.id` 等于目录名；
 * 2. 自动发现：`themes/index.ts` 用 `import.meta.glob` 扫目录，自己不列主题 id；
 * 3. 门控：非默认主题的**每条规则**都带 `[data-appearance="<id>"]`；
 *    默认主题反过来，必须是裸 `:root`/`.dark`（它是基础层 + 未知主题名的回落目标）；
 * 4. 覆盖完整：每个主题在两种明暗下都给了全套 token；
 * 5. 主题 id 只出现在 `src/themes/` 里（`App.tsx` / `index.html` / i18n 里出现即回归）。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { appearanceDeclarations, SHADCN_TOKENS, themeTokens } from "./lib/cssTokens.ts";
import {
  defaultThemeCss,
  listThemeIds,
  orderedThemeIds,
  readThemeFile,
  themeSourcesCss,
} from "./lib/themeSources.ts";

const themesDirUrl = new URL("../src/themes/", import.meta.url);
const themesIndexSource = readFileSync(new URL("../src/themes/index.ts", import.meta.url), "utf8");

/** 注释里的主题名不算数：这些守卫盯的是**代码**。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** 扫出所有规则的选择器（跳过 `@media` / `@layer` 这类容器头；先去掉注释）。 */
function collectSelectors(css: string): string[] {
  const source = stripComments(css);
  const selectors: string[] = [];
  let depth = 0;
  let segmentStart = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      const selector = source.slice(segmentStart, i).trim();
      if (!selector.startsWith("@")) selectors.push(selector);
      depth += 1;
      segmentStart = i + 1;
    } else if (char === "}" || char === ";") {
      if (char === "}") depth -= 1;
      segmentStart = i + 1;
    }
  }
  return selectors;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "themes") continue; // 主题 id 的合法住所
      walkFiles(full, out);
    } else if (/\.(ts|tsx|css|mjs|js|html)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test("每个主题目录都自洽：meta.ts + theme.css、id 等于目录名、双语文案齐全", async () => {
  const ids = listThemeIds();
  assert.ok(ids.includes("default"), "至少要有一个 default 主题（它是基础层与回落目标）");

  for (const id of ids) {
    const metaSource = readThemeFile(id, "meta.ts");
    // meta.ts 刻意不 import 任何东西：测试要用 `node --test` 直接加载它。
    assert.ok(
      !/^\s*import\s/m.test(stripComments(metaSource)),
      `${id}/meta.ts 不该有 import —— 它要能被 node 直接加载，保持零依赖`,
    );

    const module = (await import(`${new URL(`./${id}/meta.ts`, themesDirUrl).href}`)) as {
      meta?: { id?: unknown; label?: Record<string, unknown>; desc?: Record<string, unknown> };
    };
    const meta = module.meta;
    assert.ok(meta, `${id}/meta.ts 必须导出 \`meta\``);
    assert.equal(meta.id, id, `${id}/meta.ts 的 id 必须等于目录名（注册表按目录发现主题）`);
    for (const locale of ["zh", "en"] as const) {
      for (const field of ["label", "desc"] as const) {
        assert.equal(
          typeof meta[field]?.[locale],
          "string",
          `${id}/meta.ts 缺 ${field}.${locale}（设置页要双语）`,
        );
      }
    }

    // theme.css 至少得是个 CSS 文件，别是空壳：门控 / 基础层由下面的用例逐个盯。
    assert.ok(readThemeFile(id, "theme.css").length > 200, `${id}/theme.css 太短了，是不是漏搬了？`);
  }
});

test("主题清单按目录自动发现：注册表里没有任何主题 id 字面量", () => {
  assert.match(
    themesIndexSource,
    /import\.meta\.glob<\{ meta: ThemeMeta \}>\("\.\/\*\/meta\.ts", \{ eager: true \}\)/,
    "名片要按目录发现（import.meta.glob），否则新主题要回来登记",
  );
  assert.match(
    themesIndexSource,
    /import\.meta\.glob\("\.\/\*\/theme\.css", \{ eager: true \}\)/,
    "样式要按目录自动注入",
  );
  const indexCode = stripComments(themesIndexSource);
  for (const id of listThemeIds()) {
    if (id === "default") continue; // default 是通用回落值，允许出现在代码里
    assert.ok(
      !indexCode.includes(`"${id}"`) && !indexCode.includes(`'${id}'`),
      `注册表里出现了 "${id}" 字面量：它就失去了「按目录发现」的意义`,
    );
  }
  assert.match(
    indexCode,
    /isKnownTheme\(value\) \? value : "default"/,
    "未知 id 要落回默认主题（这是不需要白名单的前提）",
  );
  assert.deepEqual(orderedThemeIds()[0], "default", "默认主题必须排在设置页第一个");
});

test("非默认主题的每条规则都带自己的 [data-appearance] 门控", () => {
  for (const id of listThemeIds()) {
    if (id === "default") continue;
    const selectors = collectSelectors(readThemeFile(id, "theme.css"));
    assert.ok(selectors.length >= 5, `${id}/theme.css 里规则太少（${selectors.length}），解析是不是坏了？`);
    for (const selector of selectors) {
      assert.ok(
        selector.includes(`[data-appearance="${id}"]`),
        `${id} 的规则没门控到自己的主题，会污染其它主题：${selector.replace(/\s+/g, " ")}`,
      );
    }
  }
});

test("默认主题反过来：必须是裸 :root/.dark，不带任何主题门控", () => {
  const code = stripComments(defaultThemeCss);
  assert.match(code, /(?:^|\n):root\s*\{/, "默认主题必须写裸 `:root`");
  assert.match(code, /(?:^|\n)\.dark\s*\{/, "默认主题必须写裸 `.dark`");
  assert.ok(
    !code.includes("[data-appearance"),
    "默认主题不许带主题门控：任何未识别的主题名都要能落到这套 token 上",
  );
});

test("每个主题在浅色与深色下都定义了全套 token（漏一个只会悄悄掉回原配色）", () => {
  const baseLight = themeTokens(defaultThemeCss).light;
  const roleTokens = Object.keys(baseLight).filter((name) => name.startsWith("--app-"));
  assert.ok(roleTokens.length >= 20, `角色 token 太少（${roleTokens.length}）`);

  // 默认主题就是基础层本身：浅色块给全即可（`.dark` 有意只重写一小批遗留规则）。
  for (const token of SHADCN_TOKENS) {
    assert.ok(token in baseLight, `默认主题缺 ${token}`);
  }

  for (const id of listThemeIds()) {
    if (id === "default") continue;
    const own = appearanceDeclarations(themeSourcesCss(), id);
    for (const mode of ["light", "dark"] as const) {
      const missing = [...SHADCN_TOKENS, ...roleTokens].filter((name) => !(name in own[mode]));
      assert.deepEqual(missing, [], `${id} 的 ${mode} 档缺 ${missing.join(", ")}`);
    }
  }
});

test("主题 id 只出现在 src/themes/ 里（注释除外）", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = [...walkFiles(path.join(root, "src")), path.join(root, "index.html")];
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const id of listThemeIds()) {
      if (id === "default") continue;
      if (!code.includes(`"${id}"`) && !code.includes(`'${id}'`)) continue;
      assert.fail(
        `${path.relative(root, file)} 里写死了主题 id "${id}"：` +
          "新增主题不该需要改共享文件（清单见 src/themes/README.md）",
      );
    }
  }
});