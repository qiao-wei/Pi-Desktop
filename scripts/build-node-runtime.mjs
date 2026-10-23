/**
 * Assemble the bundled Node runtime: a pinned Node distribution, downloaded and unpacked, so
 * `node`, `npm` and `npx` work on a machine that has neither.
 *
 *   npm run node:build
 *
 * Produces `src-tauri/binaries/node-runtime/` (gitignored): the distribution minus headers,
 * docs and corepack, plus `SOURCES.json` (archive URL + sha256) and
 * `pi-desktop-runtime.json` (where the executable and npm CLI ended up).
 *
 * The version is pinned in `scripts/lib/runtimePayloads.mjs`, never taken from the build
 * machine: the interpreter the app ships must not depend on who ran the build. Electron's own
 * Node is not a substitute - it carries no npm (`require.resolve("npm")` fails there).
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  NODE_VERSION,
  downloadArchive,
  ensureExecutable,
  extractArchive,
  isNativeTarget,
  nodeArchiveSpec,
  pruneNodeRuntime,
  runtimeSpec,
  verifyPinnedHash,
  writeProvenance,
} from "./lib/runtimePayloads.mjs";
import {
  platformForTarget,
  relocateRuntime,
  stripBytecodeCache,
  verifyRuntimeRelocatable,
} from "./lib/pythonRuntime.mjs";

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const binariesDir = join(rootDir, "src-tauri", "binaries");
const outputDir = join(binariesDir, "node-runtime");
// 目标三元组的来源顺序：出包脚本（scripts/pack.mjs）→ Tauri 自己导出的（直接跑 tauri build 时）
// → 构建机自己。两条外壳（Electron / Tauri）的交叉打包都走同一条路径。
const targetTriple = process.env.PI_DESKTOP_TARGET_TRIPLE?.trim() || process.env.TAURI_ENV_TARGET_TRIPLE?.trim() || hostTargetTriple();
const spec = runtimeSpec(targetTriple);
const archiveSpec = nodeArchiveSpec(targetTriple);
// 逃生舱：离线或企业内网可以指一个已经解开的 Node 发行版目录，替掉下载。
const sourceOverride = process.env.PI_DESKTOP_NODE_SOURCE_DIR?.trim();

mkdirSync(binariesDir, { recursive: true });
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

let sha256 = "";
if (sourceOverride) {
  if (!existsSync(sourceOverride)) {
    throw new Error(`PI_DESKTOP_NODE_SOURCE_DIR does not exist: ${sourceOverride}`);
  }
  console.log(`node: using ${sourceOverride} (target ${spec.key}, no download)`);
  // 拷贝用户给的目录：保留软链（dereference 会把 `bin/npm` 展平成一份副本），下面的重定位
  // 兜底会负责把指向源目录的链接修好——这是历史路径，下载路径不需要这一步。
  cpSync(sourceOverride, outputDir, { recursive: true });
} else {
  const archivePath = join(binariesDir, ".downloads", archiveSpec.name);
  console.log(`node: downloading ${archiveSpec.url}`);
  sha256 = await downloadArchive(archiveSpec.url, archivePath);
  const { verified } = verifyPinnedHash({ id: "node", target: targetTriple, sha256 });
  console.log(`node: ${NODE_VERSION} sha256 ${sha256}${verified ? " (matches runtimePins.json)" : ""}`);
  extractArchive(archivePath, archiveSpec.type, outputDir);
  rmSync(dirname(archivePath), { recursive: true, force: true });
}

const pruned = pruneNodeRuntime(outputDir);
const layout = bundledNodeLayout(targetTriple, outputDir);
ensureNodeRuntime(layout);
// node.exe / bin/node: tar keeps the mode, the zip does not.
ensureExecutable(layout.bin);

// Official archives are already relocatable (relative symlinks, `#!/usr/bin/env node`
// shebangs), so on the download path this pass reports zero repairs. It stays because it is
// also the override path's repair step, and because the gate below must hold for both.
const hostPaths = [outputDir, ...(sourceOverride ? [sourceOverride] : [])];
const stripped = stripBytecodeCache(outputDir);
const relocated = relocateRuntime(outputDir, {
  platform: platformForTarget(targetTriple),
  forbidden: hostPaths,
});
if (relocated.symlinks.length || relocated.scripts.length || relocated.wrappers.length || stripped.length) {
  console.log(
    `node: relocated ${relocated.symlinks.length} symlink(s), ${relocated.scripts.length} console script(s), ` +
      `${relocated.wrappers.length} windows wrapper(s), stripped ${stripped.length} __pycache__ entr(ies)`,
  );
}

// The payload itself cannot be executed while cross-assembling one (a win32 node.exe does not
// run on macOS). The relocatability gate above is file-level and still runs; the executable
// check is what has to wait for a native build or the target machine.
const native = isNativeTarget(targetTriple);
if (native) {
  verifyStandaloneNode(layout);
} else {
  console.log(`node: skipping the executable check for ${spec.key} (assembled on ${process.platform}/${process.arch})`);
}

verifyRuntimeRelocatable(outputDir, {
  platform: platformForTarget(targetTriple),
  forbidden: hostPaths,
});

writeRuntimeMetadata(layout, targetTriple, { relocated, sha256, url: sourceOverride ? "" : archiveSpec.url });
writeProvenance(outputDir, {
  id: "node",
  version: NODE_VERSION,
  target: spec.key,
  url: sourceOverride ? "" : archiveSpec.url,
  sha256,
  source: sourceOverride || undefined,
  includesNpm: true,
});

console.log(`Built Pi Desktop Node runtime for ${spec.key} (${NODE_VERSION}): ${outputDir}`);

function bundledNodeLayout(target, runtimeDir) {
  if (target.includes("windows")) {
    return {
      root: runtimeDir,
      bin: join(runtimeDir, "node.exe"),
      npmCli: join(runtimeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    };
  }

  return {
    root: runtimeDir,
    bin: join(runtimeDir, "bin", "node"),
    npmCli: join(runtimeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  };
}

function ensureNodeRuntime(layout) {
  if (!existsSync(layout.bin)) {
    throw new Error(`Node runtime is missing its executable: ${layout.bin}`);
  }
  if (!existsSync(layout.npmCli)) {
    throw new Error(`Node runtime is missing npm: ${layout.npmCli}`);
  }
}

/** Run the payload once, on the machine that will run it: `node -v` plus npm's presence. */
function verifyStandaloneNode(layout) {
  const expectedRoot = resolve(layout.root);
  const validation = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const expected = ${JSON.stringify(expectedRoot)};`,
    "if (!process.execPath.startsWith(expected + path.sep)) {",
    "  throw new Error(`Node executable escaped bundled runtime: ${process.execPath}`);",
    "}",
    `if (!fs.existsSync(${JSON.stringify(layout.npmCli)})) {`,
    "  throw new Error('Bundled npm CLI is missing');",
    "}",
    "console.log(process.version);",
  ].join("\n");
  const result = spawnSync(layout.bin, ["-e", validation], {
    encoding: "utf8",
    env: isolatedNodeEnv(),
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `verify standalone Node and npm failed (${result.status ?? "unknown"}): ${result.stderr || result.stdout || "no output"}`,
    );
  }
}

function isolatedNodeEnv() {
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NPM_CONFIG_PREFIX;
  delete env.npm_config_prefix;
  return env;
}

/** 写出 `pi-desktop-runtime.json`：载荷的来源与指纹，供打包侧与 `runtimePins` 对账。
 *
 * `layout` 是解包后的目录布局（`bin` / `npmCli` 的绝对路径）；`relocated` 是搬迁时被改写的
 * 三类文件（符号链接 / 脚本 / 启动器），它们要按 `outputDir` 相对化后才能随包发布。
 *
 * @param {{ bin: string, npmCli: string }} layout
 * @param {string} target
 * @param {{
 *   relocated?: { symlinks?: string[], scripts?: string[], wrappers?: string[] },
 *   sha256?: string,
 *   url?: string,
 * }} [options]
 */
function writeRuntimeMetadata(layout, target, { relocated, sha256, url } = {}) {
  writeFileSync(join(outputDir, "pi-desktop-runtime.json"), `${JSON.stringify({
    kind: "node",
    version: NODE_VERSION,
    target,
    url: url || undefined,
    sha256: sha256 || undefined,
    executable: relativeRuntimePath(layout.bin),
    npmCli: relativeRuntimePath(layout.npmCli),
    relocatable: true,
    relocated: {
      symlinks: (relocated?.symlinks ?? []).map(relativeRuntimePath),
      scripts: (relocated?.scripts ?? []).map(relativeRuntimePath),
      wrappers: (relocated?.wrappers ?? []).map(relativeRuntimePath),
    },
  }, null, 2)}\n`, "utf8");
}

function relativeRuntimePath(value) {
  return value.slice(outputDir.length).replace(/^[/\\]/, "").replace(/\\/g, "/");
}

function hostTargetTriple() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }

  throw new Error(`Set TAURI_ENV_TARGET_TRIPLE when building on ${process.platform}.`);
}