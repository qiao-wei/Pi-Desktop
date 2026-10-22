/**
 * The bridge ships unpacked and runs on the bundled node. These cover the assembly rules:
 * which packages the tree must declare, how the launcher finds its neighbours, and that every
 * host that starts the bridge passes the entry the same way.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  escapedSpecsFromProbe,
  isInsideTree,
  renderPosixBridgeLauncher,
  resolveNpmInvocation,
  siblingNpmCliCandidates,
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

test("transitive pins become npm overrides, direct deps stay plain dependencies", () => {
  const { manifest } = bridgePackageManifest({
    imports: ["@earendil-works/pi-coding-agent"],
    versions: { "@earendil-works/pi-coding-agent": "1.1.0" },
    overrides: {
      // A dependency of a dependency: this is the one npm would otherwise float to a newer minor.
      "@earendil-works/pi-codemode": "1.1.0",
      // Also reachable transitively, but it is a direct dependency here - npm rejects an override
      // that contradicts the declared spec, so it must not be duplicated.
      "@earendil-works/pi-coding-agent": "1.1.0",
    },
  });

  assert.deepEqual(manifest.dependencies, { "@earendil-works/pi-coding-agent": "1.1.0" });
  assert.deepEqual(manifest.overrides, { "@earendil-works/pi-codemode": "1.1.0" });
});

test("no transitive pins means no overrides block at all", () => {
  const { manifest } = bridgePackageManifest({ imports: ["typebox"], versions: { typebox: "1.0.0" }, overrides: {} });
  assert.equal("overrides" in manifest, false, "an empty overrides block is still an npm override surface");
});

test("every pi-family package in the repo tree is pinned to a version npm will accept", () => {
  const { bridgePackageManifest: build } = require("../scripts/lib/bridgeRuntime.mjs");
  const declared = readJson("package.json").dependencies;
  const scopeDir = resolve(repoRoot, "node_modules", "@earendil-works");
  const pinned = Object.fromEntries(
    readdirSync(scopeDir)
      .filter((name) => existsSync(resolve(scopeDir, name, "package.json")))
      .map((name) => [`@earendil-works/${name}`, readJson(`node_modules/@earendil-works/${name}/package.json`).version]),
  );

  const { manifest } = build({ imports: Object.keys(declared).filter((name) => name.startsWith("@earendil-works/")), versions: declared, overrides: pinned });
  for (const [name, version] of Object.entries(manifest.overrides ?? {})) {
    assert.equal(version, pinned[name], `${name} must be pinned to the version the repo tree resolved`);
    assert.equal(/^\d+\.\d+\.\d+/.test(version), true, "an override has to be an exact version, not a range");
  }
  assert.equal(pinned["@earendil-works/pi-codemode"] !== undefined, true, "pi-codemode is the one that floated");
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

// `npm install` 那句到底拿什么去起。Windows 上没有 npm_execpath 时旧代码会退化成裸 `npm`，
// 而 `npm` 在 Windows 上是个 `.cmd` —— spawnSync(shell:false) 根本执行不了它，报出来还只有一句
// 空消息（2026-10-22 CI 的 Windows slim 包）。所以这几条锁住"会去找真的 npm-cli.js"。
test("npm_execpath 指向 cli.js 时用当前 node 跑它", () => {
  const invocation = resolveNpmInvocation({
    env: { npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js" },
    execPath: "/usr/local/bin/node",
  });
  assert.deepEqual(invocation, {
    command: "/usr/local/bin/node",
    baseArgs: ["/usr/local/lib/node_modules/npm/bin/npm-cli.js"],
    source: "npm_execpath",
  });
});

test("npm_execpath 不是 .js（自带的 shell 包装）时直接执行它", () => {
  const invocation = resolveNpmInvocation({ env: { npm_execpath: "/usr/local/bin/npm" }, execPath: "/usr/local/bin/node" });
  assert.deepEqual(invocation, { command: "/usr/local/bin/npm", baseArgs: [], source: "npm_execpath" });
});

test("没有 npm_execpath 时找 node 旁边那份 npm-cli.js，且按平台用不同目录形状", () => {
  const probed = [];
  const exists = (path) => {
    probed.push(path);
    return true;
  };

  const win = resolveNpmInvocation({ env: {}, platform: "win32", execPath: "C:\\hostedtoolcache\\node\\bin\\node.exe", exists });
  assert.equal(win.source, "npm-cli");
  assert.equal(win.command, "C:\\hostedtoolcache\\node\\bin\\node.exe");
  assert.deepEqual(probed, ["C:\\hostedtoolcache\\node\\bin\\node_modules\\npm\\bin\\npm-cli.js"]);

  // POSIX：npm 在 <node>/../lib/node_modules/npm 里，而且 `..` 要被规范化掉。
  assert.deepEqual(siblingNpmCliCandidates("/opt/hostedtoolcache/node/bin/node", "darwin"), [
    "/opt/hostedtoolcache/node/lib/node_modules/npm/bin/npm-cli.js",
  ]);
  assert.deepEqual(siblingNpmCliCandidates("C:\\n\\node.exe", "win32"), ["C:\\n\\node_modules\\npm\\bin\\npm-cli.js"]);
});

test("调用方给的候选（内置运行时那份 npm）优先于 node 旁边那份", () => {
  const chosen = [];
  const invocation = resolveNpmInvocation({
    env: {},
    execPath: "/repo/node",
    candidates: ["/repo/src-tauri/binaries/node-runtime/lib/node_modules/npm/bin/npm-cli.js"],
    exists: (path) => {
      chosen.push(path);
      return true;
    },
  });
  assert.equal(chosen[0], "/repo/src-tauri/binaries/node-runtime/lib/node_modules/npm/bin/npm-cli.js");
  assert.equal(invocation.source, "npm-cli");
});

test("哪都找不到 npm 时退回 PATH，但调用方能看见这个事实（不能只剩一句空报错）", () => {
  const invocation = resolveNpmInvocation({ env: {}, execPath: "/nowhere/node", exists: () => false });
  assert.deepEqual(invocation, { command: "npm", baseArgs: [], source: "path" });
});

// 自解析探针的判定。旧代码拿 URL 的 pathname（`/D:/a/…`，前导斜杠 + 正斜杠）去跟树根
// （`D:\a\…`）比字符串前缀，Windows 上 27 个依赖全被判成"跑出树外/缺失"，bridge:build 直接失败
// （mac 上是好的，所以本地一直看不见）。这条用真实的 Windows 形状锁住它。
test("探针输出里的 Windows 路径算在树里（不能拿 URL pathname 比字符串前缀）", () => {
  const dir = "D:\\a\\Pi-Desktop\\Pi-Desktop\\src-tauri\\binaries\\bridge";
  const output = [
    "@earendil-works/pi-ai\tok\tD:\\a\\Pi-Desktop\\Pi-Desktop\\src-tauri\\binaries\\bridge\\node_modules\\@earendil-works\\pi-ai\\dist\\index.js",
    "@earendil-works/pi-coding-agent\tok\tD:\\a\\Pi-Desktop\\Pi-Desktop\\src-tauri\\binaries\\bridge\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\index.js",
  ].join("\r\n");
  assert.deepEqual(escapedSpecsFromProbe(output, dir, "win32"), []);
});

test("探针里真跑出树外 / 没解析出来的要报出来", () => {
  const dir = "/repo/src-tauri/binaries/bridge";
  assert.deepEqual(
    escapedSpecsFromProbe(
      [
        "left-pad\tok\t/repo/node_modules/left-pad/index.js",
        "esbuild\tunresolved\tERR_MODULE_NOT_FOUND",
        "jiti\tok\t/repo/src-tauri/binaries/bridge/node_modules/jiti/lib/jiti.cjs",
      ].join("\n"),
      dir,
    ),
    [
      "left-pad -> outside /repo/node_modules/left-pad/index.js",
      "esbuild -> unresolved ERR_MODULE_NOT_FOUND",
    ],
  );

  // 同一条路径在 win32 flavor 下也要判得对（分隔符不一样）。
  assert.equal(isInsideTree("D:\\b", "D:\\b\\node_modules\\x", "win32"), true);
  assert.equal(isInsideTree("D:\\b", "D:\\bextra\\x", "win32"), false, "前缀相同但不是子目录");
  assert.equal(isInsideTree("D:\\b", "C:\\b\\x", "win32"), false);
});
