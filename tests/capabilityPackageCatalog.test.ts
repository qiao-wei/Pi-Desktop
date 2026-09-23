/**
 * 「Package Catalog」入口：点击去 pi.dev 的 Package 目录。
 *
 * 需求（用户）：全局的 Packages 页和右侧项目面板的 Packages 区块都要有这个入口，
 * 指向同一个 https://pi.dev/packages。
 *
 * 这里钉住三件事：
 * - URL 只有一份常量，两个入口都引用它（不要在两处各写一遍字符串后漂移）；
 * - 两个 surface 都真的调用了 openTarget / 也就是都有入口；
 * - 全局页的入口只在 Packages 标签下出现（它和 Skills 无关）。
 *
 * App.tsx 是 .tsx，node --test 只能按源码断言，沿用仓库既有做法。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/** Source of a top-level `function name(...) { ... }`, delimited at the next flush-left brace. */
function topLevelFunctionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from App.tsx`);
  const end = appSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body could not be delimited`);
  return appSource.slice(start, end);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("目录 URL 只有一份常量，两个入口共用", () => {
  assert.match(
    appSource,
    /const PACKAGE_CATALOG_URL = "https:\/\/pi\.dev\/packages";/,
    "https://pi.dev/packages 必须以常量形式定义一次",
  );
  assert.equal(
    countOccurrences(appSource, "https://pi.dev/packages"),
    1,
    "不要再在别的入口里手写一遍 URL —— 改了常量却漏改字符串就会指错地方",
  );
});

test("全局页的 Packages 标签下有目录入口，且只在 Packages 标签下出现", () => {
  const page = topLevelFunctionSource("CapabilitiesPage");
  assert.match(page, /openTarget\(PACKAGE_CATALOG_URL\)/, "全局页要有 Package Catalog 入口");
  assert.match(
    page,
    /tab === "package"[\s\S]{0,200}openTarget\(PACKAGE_CATALOG_URL\)/,
    "这个入口属于 Packages 标签，Skills 标签下不该出现",
  );
});

test("右侧项目面板的 Packages 区块也有目录入口", () => {
  const panel = topLevelFunctionSource("ProjectCapabilitiesPanel");
  const packagesSectionStart = panel.indexOf('renderSection("packages"');
  assert.notEqual(packagesSectionStart, -1, "面板的 packages 区块不见了");
  const packagesSection = panel.slice(packagesSectionStart);
  const nextSectionStart = packagesSection.indexOf("renderSection(", 1);
  const section = nextSectionStart === -1 ? packagesSection : packagesSection.slice(0, nextSectionStart);
  assert.match(section, /openTarget\(PACKAGE_CATALOG_URL\)/, "面板 Packages 区块要有 Package Catalog 入口");
});

test("两个入口都有可读的 aria/tooltip 文案（图标按钮不能只有图标）", () => {
  for (const name of ["CapabilitiesPage", "ProjectCapabilitiesPanel"]) {
    const source = topLevelFunctionSource(name);
    assert.match(
      source,
      /t\("capability\.market\.packageCatalogHint"\)/,
      `${name} 的目录入口缺 tooltip 文案`,
    );
  }
});