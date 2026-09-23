// Electron 的 app.asar 只应该装主进程自己的代码。
//
// 背景（2026-09-21 实测）：`directories.app` 是 src-electron，而那里既没有 dependencies 也没有
// node_modules，electron-builder 于是**回退到仓库根**去收集生产依赖，把整份渲染层的依赖
// （recheck 54M、lucide-react 23M、@google/genai 11.8M、react-dom 7M…）打进了 asar：
// 20,146 个文件 / 205M，而 src-electron 自己的代码只有 40KB。渲染层早就被 Vite 打进
// `<resources>/renderer`，主进程又只 require `electron` 和 `node:*`，所以那是同一批库的第二份拷贝。
//
// 排除 node_modules 之后 asar 只剩 9 个文件 / 44K。**这条测试就是那次排除的安全带**：只要有人
// 在 src-electron 里引入第三方依赖，这里会红，而不是等到打包版白屏（dev 读仓库 node_modules，
// 所以不会暴露这个问题）。

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const shellDir = join(repoRoot, "src-electron");
const readJson = (relative) => JSON.parse(readFileSync(resolve(repoRoot, relative), "utf8"));

const BUILTIN = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
/** Electron 自己提供的模块，永远不该出现在 asar 的 node_modules 里。 */
const ELECTRON_BUILTIN = /^electron(\/.*)?$/;

/** 源码里所有的 require/import 说明符（含动态 import()），不含注释。 */
function moduleSpecifiers(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = new Set();
  for (const pattern of [
    /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /from\s+["'`]([^"'`]+)["'`]/g,
    /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ]) {
    for (const match of withoutComments.matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return [...found];
}

test("主进程源码不依赖任何第三方包（asar 排除 node_modules 的前提）", () => {
  const files = readdirSync(shellDir).filter((name) => name.endsWith(".js"));
  assert.ok(files.includes("main.js"), "src-electron 里应该有 main.js");

  const offenders = [];
  for (const file of files) {
    for (const spec of moduleSpecifiers(readFileSync(join(shellDir, file), "utf8"))) {
      if (spec.startsWith(".") || BUILTIN.has(spec) || ELECTRON_BUILTIN.test(spec)) {
        continue;
      }
      offenders.push(`src-electron/${file} → ${spec}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "主进程里出现了第三方依赖。要么把它从 app.asar 的排除里放回来（electron-builder.json 的 files），" +
      "要么改成不依赖它——否则打包版会缺包，而 dev 下看不出来。",
  );
});

test("打包配置排除了 app.asar 里的 node_modules", () => {
  const files = readJson("src-electron/electron-builder.json").files;
  assert.ok(
    files.some((pattern) => /^!.*node_modules/.test(pattern)),
    `files 必须排除 node_modules，否则渲染层的依赖会以未压缩形态再打一份：${JSON.stringify(files)}`,
  );
  // src-electron 自己的代码还得在。
  assert.ok(files.includes("*.js") && files.includes("package.json"));
});

test("主进程的相对依赖都在 asar 里解析得到", () => {
  // 静态地跟着 require 走一遍：这正好是"产物里少了包"会炸的地方。
  const entry = readFileSync(join(shellDir, "main.js"), "utf8");
  const visited = new Set();
  const missing = [];

  const visit = (file) => {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    const source = readFileSync(join(shellDir, file.replace(/^\.\//, "")), "utf8");
    for (const spec of moduleSpecifiers(source)) {
      if (!spec.startsWith(".")) {
        continue;
      }
      const target = resolve(join(shellDir, file.replace(/^\.\//, "")), "..", spec);
      const candidates = [target, `${target}.js`, `${target}.json`, join(target, "index.js")];
      const hit = candidates.find((candidate) => existsSync(candidate));
      if (!hit) {
        missing.push(`${file} → ${spec}`);
        continue;
      }
      if (hit.endsWith(".js") && resolve(hit).startsWith(`${shellDir}/`) === false) {
        // 走到 src-electron 之外（比如 ../dist）时不继续遍历，只要文件存在就算解析成功。
        continue;
      }
      if (hit.endsWith(".js")) {
        visit(hit.slice(shellDir.length + 1));
      }
    }
  };
  visit("main.js");

  assert.deepEqual(missing, []);
  assert.deepEqual(
    [...visited].sort(),
    ["host-commands.js", "host-policy.js", "main.js", "paths.js", "sidecar.js", "static-server.js", "turn-notification.js"],
    "main.js 的 require 图应该是这七个",
  );
  // preload 不挂在 require 图上（由 Electron 按路径加载），单独确认它的依赖也是干净的。
  const preload = moduleSpecifiers(readFileSync(join(shellDir, "preload.js"), "utf8"));
  assert.deepEqual(
    preload.filter((spec) => !spec.startsWith(".") && !BUILTIN.has(spec) && !ELECTRON_BUILTIN.test(spec)),
    [],
    "preload 不应引入第三方模块",
  );
});

test("已构建的 asar 里确实只剩主进程代码（没有产物时跳过）", (t) => {
  const archive = resolve(repoRoot, "dist-electron/mac-arm64/Pi Desktop.app/Contents/Resources/app.asar");
  if (!existsSync(archive)) {
    t.skip("还没打过 --dir，无法核对产物");
    return;
  }
  const asar = require("@electron/asar");
  const entries = asar.listPackage(archive);
  assert.ok(entries.length > 0);
  assert.deepEqual(
    entries.map((entry) => entry.replace(/^\//, "")).sort(),
    [
      "host-commands.js",
      "host-policy.js",
      "main.js",
      "package.json",
      "paths.js",
      "preload.js",
      "sidecar.js",
      "static-server.js",
      "turn-notification.js",
    ],
    "asar 里只应该剩主进程代码",
  );
  assert.ok(!existsSync(join(repoRoot, "dist-electron/mac-arm64/Pi Desktop.app/Contents/Resources/app.asar.unpacked")), "不该再产出 unpacked 目录");
  // package.json 必须在：Electron 靠它找 main。见上面的完整清单。
});