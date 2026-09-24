/**
 * The bridge ships unpacked and runs on the bundled node. These cover the assembly rules:
 * which packages the tree must declare, how the launcher finds its neighbours, and that every
 * host that starts the bridge passes the entry the same way.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);

const {
  bridgePackageManifest,
  collectBareImports,
  compareVersions,
  defaultTargetTriple,
  packageNameOf,
  renderPosixBridgeLauncher,
  staleInstalledPackages,
  versionFloor,
} = await import(pathToFileURL(resolve(import.meta.dirname, "../scripts/lib/bridgeRuntime.mjs")).href);
const { buildPackPlan, parsePackArgs } = await import(pathToFileURL(resolve(import.meta.dirname, "../scripts/lib/packPlan.mjs")).href);

const repoRoot = resolve(import.meta.dirname, "..");
const readJson = (relative) => JSON.parse(readFileSync(resolve(repoRoot, relative), "utf8"));

test("bare imports are collected without builtins or relative files", () => {
  const imports = collectBareImports([
    [
      'import { a } from "./local.mjs";',
      'import { b } from "node:fs";',
      'import { d } from "@earendil-works/pi-coding-agent";',
      'import { e } from "@modelcontextprotocol/client/stdio";',
      'const { f } = require("typebox");',
      'import type { G } from "../src/shared/chatBubbles.ts";',
    ].join("\n"),
    "",
    null,
  ]);

  assert.deepEqual(imports, [
    "@earendil-works/pi-coding-agent",
    "@modelcontextprotocol/client/stdio",
    "typebox",
  ]);
});

test("subpath imports declare their package, not the subpath", () => {
  assert.equal(packageNameOf("@scope/pkg/dist/x.mjs"), "@scope/pkg");
  assert.equal(packageNameOf("chalk"), "chalk");
  assert.equal(packageNameOf(""), "");
});

test("the manifest pins what the bridge imports and reports what it cannot", () => {
  const { manifest, missing } = bridgePackageManifest({
    imports: ["@earendil-works/pi-ai", "typebox", "not-installed"],
    versions: { "@earendil-works/pi-ai": "0.84.2", typebox: "1.0.0" },
  });

  // Exact versions: the shipped tree must match what the build tested, not a fresh range.
  assert.deepEqual(manifest.dependencies, { "@earendil-works/pi-ai": "0.84.2", typebox: "1.0.0" });
  assert.equal(manifest.private, true);
  assert.deepEqual(missing, ["not-installed"]);
});

test("the bridge really only imports packages we declare", () => {
  const sources = ["server/index.mjs", "server/projectFolders.mjs", "server/agentShims.mjs", "server/sqlite.mjs"].map(
    (file) => readFileSync(resolve(repoRoot, file), "utf8"),
  );
  const declared = readJson("package.json").dependencies;
  const undeclared = [...new Set(collectBareImports(sources).map(packageNameOf))]
    .filter((pkg) => pkg && declared[pkg] === undefined)
    .sort();

  assert.deepEqual(
    undeclared,
    [],
    "server imports a package the app does not depend on - the shipped tree would not contain it",
  );
});

test("the launcher locates node and the bridge next to itself but honours overrides", () => {
  const script = renderPosixBridgeLauncher({
    entry: "server/index.mjs",
    nodeBinRel: "node-runtime/bin/node",
    bridgeDirRel: "bridge",
    cacheDir: '"${TMPDIR:-/tmp}/pi-desktop-node-compile-cache"',
  });

  assert.match(script, /^#!\/bin\/sh$/m);
  assert.match(script, /BRIDGE_DIR="\$\{PI_DESKTOP_BRIDGE_DIR:-\$here\/bridge\}"/);
  assert.match(script, /NODE_BIN="\$\{PI_DESKTOP_BRIDGE_NODE:-\$here\/node-runtime\/bin\/node\}"/);
  // 精简版不带 node-runtime：自己找 PATH 里的 node（用户已装 node 的那种机器）。
  assert.match(script, /NODE_BIN="\$\(command -v node 2>\/dev\/null \|\| true\)"/);
  // A launcher whose neighbour vanished and which cannot find a node must say so instead of exec'ing nothing.
  assert.match(script, /no usable node \(bundled node-runtime is absent and none is on PATH\)/);
  assert.match(script, /NODE_BIN=\$\{NODE_BIN:-<none>\}/, "缺 node 时说清楚是哪一个（含没有）");
  assert.match(script, /exit 127/);
  assert.match(script, /export NODE_COMPILE_CACHE=/);
  assert.match(script, /^exec "\$NODE_BIN" "\$BRIDGE_DIR\/server\/index\.mjs" "\$@"$/m);
});

test("only posix hosts get a launcher name", () => {
  assert.equal(defaultTargetTriple("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(defaultTargetTriple("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(defaultTargetTriple("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(defaultTargetTriple("win32", "x64"), "");
});

test("the packaged build assembles the bridge and self-tests it before the installer", () => {
  // 链的顺序由 scripts/lib/packPlan.mjs 的单一计划决定（package.json 里只剩同样形状的一行入口）。
  const plan = buildPackPlan(parsePackArgs(["--host", "electron", "--target", "mac", "--arch", "arm64"]), {
    platform: "darwin",
    arch: "arm64",
  });
  const labels = plan.steps.map((step) => step.label);
  const at = (needle) => labels.findIndex((label) => label.includes(needle));

  assert.ok(at("bridge:build") >= 0, `打包链必须组装未编译的 bridge：${labels.join(" → ")}`);
  assert.ok(
    !labels.some((label) => label.includes("sidecar:build")),
    "不能再回到编译成单文件的桥",
  );
  assert.ok(
    at("bridge:build") < at("sidecar:verify") && at("sidecar:verify") < at("electron-builder"),
    `能力包门禁必须在组装之后、打包器之前：${labels.join(" → ")}`,
  );

  const electron = readJson("src-electron/electron-builder.json");
  const shipped = [...electron.extraResources, ...electron.mac.extraResources, ...electron.win.extraResources];
  const roots = shipped.map((entry) => entry.to);
  for (const needed of [
    "renderer",
    "skills",
    "capabilities.defaults.json",
    "python-runtime",
    "node-runtime",
    "bridge/node_modules",
    "bridge/server",
    "bridge/src",
    "bridge/package.json",
    "pi-desktop-server",
  ]) {
    assert.ok(roots.includes(needed), `${needed} must reach the app bundle`);
  }
  // The packager prunes a node_modules that is nested inside a copied directory, so the whole
  // bridge cannot be copied as one entry: each subtree needs to be its own copy root.
  assert.ok(
    shipped.some((entry) => entry.from.endsWith("bridge/node_modules") && entry.to === "bridge/node_modules"),
    "node_modules must be copied as its own root",
  );
  assert.ok(
    !roots.includes("bridge"),
    "a single 'bridge' directory copy silently loses node_modules - split the entries instead",
  );
  assert.ok(
    !electron.win.extraResources.some((entry) => String(entry.to).endsWith("pi-desktop-server.exe")),
    "win32 runs the bundled node instead of a compiled sidecar",
  );

  const tauri = readJson("src-tauri/tauri.conf.json");
  assert.equal(tauri.bundle.resources["binaries/bridge"], "bridge");
  const tauriPlan = buildPackPlan(parsePackArgs(["--host", "tauri", "--target", "mac", "--arch", "arm64"]), {
    platform: "darwin",
    arch: "arm64",
  });
  assert.ok(
    tauriPlan.steps.some((step) => step.label.includes("bridge:build")),
    `两条外壳都走同一个准备链：${tauriPlan.steps.map((step) => step.label).join(" → ")}`,
  );
});

test("Windows 包不要求也不产出 pi-desktop-server.exe", () => {
  const base = readJson("src-tauri/tauri.conf.json").bundle.resources;
  // Tauri 用 JSON Merge Patch (RFC 7396) 把 tauri.<platform>.conf.json 合进基础配置，所以有效的
  // Windows 资源清单是两者的并集；平台文件不存在时就是基础配置本身。
  const windowsConf = resolve(repoRoot, "src-tauri/tauri.windows.conf.json");
  const platform = existsSync(windowsConf)
    ? readJson("src-tauri/tauri.windows.conf.json").bundle.resources
    : {};
  const effective = { ...base, ...platform };

  for (const needed of ["node-runtime", "python-runtime", "bridge"]) {
    assert.ok(Object.values(effective).includes(needed), `Windows 包必须带上 ${needed}`);
  }
  // Windows 宿主 spawn 的是 node.exe + bridge entry。任何 `.exe` 资源都只能是把 shell 脚本
  // 改名的假二进制，构建期就会在缺失的资源路径上炸掉。
  for (const [from, to] of Object.entries(effective)) {
    assert.ok(
      !from.endsWith(".exe") && !String(to).endsWith(".exe"),
      `Windows 不该有 .exe 资源：${from} -> ${to}`,
    );
  }
  assert.ok(
    Object.values(base).includes("pi-desktop-server"),
    "POSIX 宿主仍然靠 pi-desktop-server 启动器找运行时",
  );

  const rust = readFileSync(resolve(repoRoot, "src-tauri/src/lib.rs"), "utf8");
  // 只看字符串字面量：注释里说明“这里不要求 .exe”是应该的，代码里真去 resolve 它才是 bug。
  assert.ok(
    !/"pi-desktop-server\.exe"/.test(rust),
    "lib.rs 不能要求一个没有任何构建步骤会产出的 Windows 启动器",
  );
  assert.ok(rust.includes("PI_DESKTOP_PI_CLI_RUNTIME"), "Windows 的 pi 走 runtime + entry 这一对");
});

test("every host resolves the same launcher contract", () => {
  const gate = readFileSync(resolve(repoRoot, "scripts/verify-sidecar-extensions.mjs"), "utf8");
  const paths = readFileSync(resolve(repoRoot, "src-electron/paths.js"), "utf8");
  const tauri = readFileSync(resolve(repoRoot, "src-tauri/src/lib.rs"), "utf8");

  assert.match(gate, /process\.env\.PI_DESKTOP_SIDECAR_BIN[\s\S]{0,80}"src-tauri", "binaries", "pi-desktop-server"/);
  assert.match(paths, /sidecar: path\.join\(root, sidecarName\)/);
  assert.match(tauri, /"pi-desktop-server"/);
});

test("win32 spawns the bundled node with the bridge entry", () => {
  const { resolveShellPaths } = require("../src-electron/paths.js");
  const original = process.platform;
  const originalResources = process.resourcesPath;
  const originalMode = process.env.PI_DESKTOP_RUNTIME_MODE;
  process.resourcesPath = "/Applications/Pi Desktop.app/Contents/Resources";
  // 这个用例断言的是 bundled 的启动形状；不指名模式时 infer 会因为两个 runtime 目录不存在
  // 而判成 system（那是另一个用例的事）。
  process.env.PI_DESKTOP_RUNTIME_MODE = "bundled";
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const packaged = resolveShellPaths({ isPackaged: true });
    assert.match(packaged.sidecar, /node-runtime[/\\]node\.exe$/);
    assert.deepEqual(packaged.sidecarArgs, [
      resolve(packaged.root, "bridge", "server", "index.mjs"),
    ]);
    assert.equal(packaged.piCli.runtime, packaged.sidecar);
    assert.equal(packaged.piCli.entry, packaged.sidecarArgs[0]);
    assert.equal(packaged.piCli.binary, undefined);

    // posix hosts keep the script launcher and pass no arguments
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const mac = resolveShellPaths({ isPackaged: true });
    assert.equal(mac.sidecarArgs.length, 0);
    assert.match(mac.sidecar, /pi-desktop-server$/);
    assert.equal(mac.piCli.binary, mac.sidecar);
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
    process.resourcesPath = originalResources;
    if (originalMode === undefined) {
      delete process.env.PI_DESKTOP_RUNTIME_MODE;
    } else {
      process.env.PI_DESKTOP_RUNTIME_MODE = originalMode;
    }
  }
});

test("versionFloor reads the lowest version a range allows", () => {
  assert.equal(versionFloor("^0.87.0"), "0.87.0");
  assert.equal(versionFloor("~1.2.3"), "1.2.3");
  assert.equal(versionFloor(">=2.0.0 <3"), "2.0.0");
  assert.equal(versionFloor("1.3.27"), "1.3.27");
  assert.equal(versionFloor("1.x"), "1.0.0");
  assert.equal(versionFloor("^2.0.0-rc.1"), "2.0.0");
  // Ranges with no version in them carry no floor, so the check is skipped rather than guessed.
  for (const range of ["*", "", undefined, null, "latest", "workspace:*", "file:../pi", "npm:pi@^1"]) {
    assert.equal(versionFloor(range as string), "", `expected no floor for ${String(range)}`);
  }
});

test("compareVersions orders dotted versions and their prereleases", () => {
  assert.equal(compareVersions("0.84.2", "0.87.0"), -1);
  assert.equal(compareVersions("0.87.0", "0.87.0"), 0);
  assert.equal(compareVersions("0.88.0", "0.87.0"), 1);
  assert.equal(compareVersions("0.87.10", "0.87.9"), 1, "numeric, not lexicographic");
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1", "1.0.0"), 0, "missing parts count as zero");
});

test("staleInstalledPackages flags only versions below what the repo declares", () => {
  const declared = {
    "@earendil-works/pi-coding-agent": "^0.87.0",
    typebox: "1.3.27",
    typebox2: "*",
  };
  // The shape that bit us: a commit bumped pi to ^0.87.0 while node_modules still held 0.84.2.
  assert.deepEqual(staleInstalledPackages({ declared, installed: { "@earendil-works/pi-coding-agent": "0.84.2" } }), [
    { name: "@earendil-works/pi-coding-agent", installed: "0.84.2", declared: "^0.87.0", floor: "0.87.0" },
  ]);
  // Satisfied, ahead of the floor, unversioned range, and not installed at all: all quiet.
  assert.deepEqual(staleInstalledPackages({ declared, installed: { typebox: "1.3.27", typebox2: "0.0.1" } }), []);
  assert.deepEqual(staleInstalledPackages({ declared, installed: { "@earendil-works/pi-coding-agent": "0.90.0" } }), []);
  assert.deepEqual(staleInstalledPackages({ declared, installed: {} }), []);
  assert.deepEqual(staleInstalledPackages({}), []);
});

test("the bridge build warns when the installed pi lags package.json", () => {
  // The wiring, not just the helper: the build reads the repo's declared ranges and compares them to
  // what it is about to put in the manifest. Verified by running the real build with a doctored
  // package.json, so a regression in that call site cannot pass unnoticed.
  const source = readFileSync(resolve(repoRoot, "scripts/build-bridge-runtime.mjs"), "utf8");
  assert.match(source, /staleInstalledPackages\(\{ declared: declaredVersions\(\), installed: versions \}\)/);
  const declared = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).dependencies;
  const installed = JSON.parse(
    readFileSync(resolve(repoRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"),
  ).version;
  assert.deepEqual(
    staleInstalledPackages({ declared, installed: { "@earendil-works/pi-coding-agent": installed } }),
    [],
    "the checked-out repo must not build the bridge from a stale tree",
  );
});
