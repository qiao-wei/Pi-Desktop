// 两种打包方式的「另一半」：代码怎么解析运行时已经由 runtimeModes.test.ts 覆盖，这里锁的是
// 产物清单本身。
//
// 要点：默认（bundled）的清单必须一字不改，精简清单只允许少两个 runtime 目录 —— 否则两种产物
// 会慢慢长成两个不同的东西。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const readJson = (relative) => JSON.parse(readFileSync(resolve(repoRoot, relative), "utf8"));

/** 以指定的模式重新加载 electron-builder 包装配置（它 require 时会读 env，所以要清缓存）。 */
function electronConfig(mode) {
  const path = resolve(repoRoot, "src-electron/electron-builder.config.cjs");
  delete require.cache[path];
  const previous = process.env.PI_DESKTOP_RUNTIME_MODE;
  if (mode === undefined) {
    delete process.env.PI_DESKTOP_RUNTIME_MODE;
  } else {
    process.env.PI_DESKTOP_RUNTIME_MODE = mode;
  }
  try {
    return require(path);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_DESKTOP_RUNTIME_MODE;
    } else {
      process.env.PI_DESKTOP_RUNTIME_MODE = previous;
    }
  }
}

const resourceTargets = (config) =>
  [...config.extraResources, ...(config.mac?.extraResources ?? []), ...(config.win?.extraResources ?? [])].map(
    (entry) => entry.to,
  );

test("默认（bundled）的清单和 electron-builder.json 完全一致", () => {
  const base = readJson("src-electron/electron-builder.json");
  const config = electronConfig(undefined);
  assert.deepEqual(resourceTargets(config), resourceTargets(base));
  assert.ok(config.extraResources.some((entry) => entry.to === "node-runtime"));
  assert.ok(config.extraResources.some((entry) => entry.to === "python-runtime"));
});

test("精简清单只少 node-runtime / python-runtime，其它资源一个不少", () => {
  const base = readJson("src-electron/electron-builder.json");
  const slim = electronConfig("system");
  const dropped = resourceTargets(base).filter((to) => !resourceTargets(slim).includes(to));
  assert.deepEqual(dropped.sort(), ["node-runtime", "python-runtime"]);
  for (const kept of ["renderer", "skills", "capabilities.defaults.json", "bridge/node_modules", "pi-desktop-server"]) {
    assert.ok(resourceTargets(slim).includes(kept), `${kept} 必须还在精简包里`);
  }
  // 桥本身不可能精简：它就是应用的服务端。
  assert.equal(slim.extraResources.length, base.extraResources.length - 2);
  // 其它字段不能因为换模式而漂移。
  assert.equal(slim.mac.icon, base.mac.icon);
  assert.equal(slim.appId, base.appId);
  assert.deepEqual(slim.files, base.files);
});

test("打包配置读的是同一个源文件，不是复制出来的一份", () => {
  const wrapper = readFileSync(resolve(repoRoot, "src-electron/electron-builder.config.cjs"), "utf8");
  assert.match(wrapper, /require\("\.\/electron-builder\.json"\)/, "精简清单必须从基础配置派生");
  // 两处都读得到 bridge:build 的顺序约束由 bridgeRuntime.test.ts 断言，这里只保证入口一致。
  const scripts = readJson("package.json").scripts;
  assert.match(scripts["electron:build"], /--config src-electron\/electron-builder\.config\.cjs/);
  assert.match(scripts["electron:pack:slim"], /PI_DESKTOP_RUNTIME_MODE=system/);
  assert.match(scripts["electron:pack:slim"], /--config src-electron\/electron-builder\.config\.cjs/);
});

test("Tauri：基础配置带两个 runtime，精简 overlay 用 null 摘掉它们", () => {
  const base = readJson("src-tauri/tauri.conf.json");
  assert.equal(base.bundle.resources["binaries/node-runtime"], "node-runtime");
  assert.equal(base.bundle.resources["binaries/python-runtime"], "python-runtime");
  assert.match(base.build.beforeBuildCommand, /npm run node:build/);

  // Tauri 用 JSON Merge Patch (RFC 7396) 合并：值为 null 表示删除该键。
  const slim = readJson("src-tauri/tauri.slim.conf.json");
  assert.equal(slim.bundle.resources["binaries/node-runtime"], null);
  assert.equal(slim.bundle.resources["binaries/python-runtime"], null);
  assert.ok(!("binaries/bridge" in slim.bundle.resources), "只写差异，别把整个 map 抄一遍");
  // 精简包里没有 node:build / python:build 可跑。
  assert.match(slim.build.beforeBuildCommand, /npm run bridge:build/);
  assert.ok(!/node:build|python:build/.test(slim.build.beforeBuildCommand));
});

test("精简的打包入口都指向同一个 overlay", () => {
  const scripts = readJson("package.json").scripts;
  for (const name of ["package:mac:slim", "package:windows:slim", "package:windows:cross:slim"]) {
    assert.match(scripts[name], /--config src-tauri\/tauri\.slim\.conf\.json/, `${name} 必须用精简清单`);
  }
  for (const name of ["package:mac", "package:windows", "package:windows:cross"]) {
    assert.ok(!/slim/.test(scripts[name]), `${name} 必须保持现状`);
  }
  // 精简链里不跑 node:build / python:build，但门禁（capabilities 校验）不能省。
  const chain = scripts["electron:build:slim"].split("&&").map((step) => step.trim());
  assert.ok(chain.some((step) => step.includes("bridge:build")));
  assert.ok(chain.some((step) => step.includes("sidecar:verify:slim")));
  assert.ok(!chain.some((step) => step.includes("node:build") || step.includes("python:build")));
});

test("门禁脚本在 system 模式下换掉 PATH 与 BUNDLED_*，且模式与宿主一致", () => {
  const gate = readFileSync(resolve(repoRoot, "scripts/verify-sidecar-extensions.mjs"), "utf8");
  assert.match(gate, /process\.env\.PI_DESKTOP_RUNTIME_MODE/, "门禁要认同一个开关");
  assert.match(gate, /PI_DESKTOP_RUNTIME_MODE: runtimeMode/, "桥也要知道自己是哪种模式，才能清旧 launcher");
  // 精简模式必须把宿主 PATH 给启动器，否则它找不到 node。
  assert.match(gate, /String\(process\.env\.PATH \?\? ""\)\.split/);
});