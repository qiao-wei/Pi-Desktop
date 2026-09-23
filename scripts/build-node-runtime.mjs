import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
const sourceDir = resolveNodeSourceDir(targetTriple);

mkdirSync(binariesDir, { recursive: true });
rmSync(outputDir, { recursive: true, force: true });

const sourceLayout = bundledNodeLayout(targetTriple, sourceDir);
ensureNodeRuntime(sourceLayout);
const layout = bundledNodeLayout(targetTriple, outputDir);
copyMinimalNodeRuntime(sourceLayout, layout);

// Same cpSync trap as the Python runtime: npm ships `.bin` entries as symlinks,
// and the recursive copy recreates them pointing into `sourceDir` (the Node
// install on this machine). Repair, then refuse to ship anything else that
// resolves outside the bundle.
const hostPaths = [sourceDir, outputDir];
// npm vendors node-gyp's Python, and its `__pycache__` records the path of the
// Node install this runtime was copied from.
const stripped = stripBytecodeCache(outputDir);
const relocated = relocateRuntime(outputDir, {
  platform: platformForTarget(targetTriple),
  forbidden: hostPaths,
});
verifyRuntimeRelocatable(outputDir, {
  platform: platformForTarget(targetTriple),
  forbidden: hostPaths,
});
if (relocated.symlinks.length || relocated.scripts.length || relocated.wrappers.length || stripped.length) {
  console.log(
    `Relocated bundled Node: ${relocated.symlinks.length} symlink(s), ` +
      `${relocated.scripts.length} console script(s), ${relocated.wrappers.length} windows wrapper(s), ` +
      `${stripped.length} __pycache__ entr(ies) stripped`,
  );
}

ensureNodeRuntime(layout);
verifyStandaloneNode(layout);
writeRuntimeMetadata(layout, targetTriple, { relocated });

console.log(`Built Pi Desktop Node runtime for ${targetTriple}: ${outputDir}`);

function resolveNodeSourceDir(target) {
  const override = process.env.PI_DESKTOP_NODE_SOURCE_DIR?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`PI_DESKTOP_NODE_SOURCE_DIR does not exist: ${override}`);
    }
    return override;
  }

  if (target.includes("linux")) {
    throw new Error(
      "Set PI_DESKTOP_NODE_SOURCE_DIR to a target-native Node distribution root when building for Linux.",
    );
  }

  const runtimeRoot = dirname(dirname(process.execPath));
  if (validNodeDistribution(runtimeRoot, target)) {
    return runtimeRoot;
  }

  throw new Error(
    "Unable to find a self-contained Node distribution. Set PI_DESKTOP_NODE_SOURCE_DIR to a Node distribution root.",
  );
}

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

function validNodeDistribution(root, target) {
  const layout = bundledNodeLayout(target, root);
  return existsSync(layout.bin) && existsSync(layout.npmCli);
}

function ensureNodeRuntime(layout) {
  if (!existsSync(layout.bin)) {
    throw new Error(`Node runtime is missing its executable: ${layout.bin}`);
  }
  if (!existsSync(layout.npmCli)) {
    throw new Error(`Node runtime is missing npm: ${layout.npmCli}`);
  }
}

function copyMinimalNodeRuntime(source, destination) {
  mkdirSync(dirname(destination.bin), { recursive: true });
  const sourceNpmRoot = dirname(dirname(source.npmCli));
  const destinationNpmRoot = dirname(dirname(destination.npmCli));
  mkdirSync(dirname(destinationNpmRoot), { recursive: true });
  copyFileSync(source.bin, destination.bin);
  chmodSync(destination.bin, statSync(source.bin).mode);
  cpSync(sourceNpmRoot, destinationNpmRoot, {
    recursive: true,
    dereference: true,
  });
}

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

function writeRuntimeMetadata(layout, target, relocation = {}) {
  writeFileSync(join(outputDir, "pi-desktop-runtime.json"), `${JSON.stringify({
    kind: "node",
    target,
    executable: relativeRuntimePath(layout.bin),
    npmCli: relativeRuntimePath(layout.npmCli),
    relocatable: true,
    relocated: {
      symlinks: (relocation.relocated?.symlinks ?? []).map(relativeRuntimePath),
      scripts: (relocation.relocated?.scripts ?? []).map(relativeRuntimePath),
      wrappers: (relocation.relocated?.wrappers ?? []).map(relativeRuntimePath),
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
