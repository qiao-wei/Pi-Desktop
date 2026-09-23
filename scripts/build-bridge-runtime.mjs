#!/usr/bin/env node
/**
 * Assemble the shippable bridge: unpacked sources + a real npm `node_modules`, executed by the
 * bundled Node through a small launcher instead of a bun-compiled single file.
 *
 * The compiled form inlined pi's modules, and pi loads runtime extensions against those inlined
 * copies; the bundler's export renaming (Type -> Type3) shifted between builds, so some artefacts
 * failed to load user extensions. On disk there is nothing to rename.
 *
 *   npm run bridge:build
 *
 * Produces:
 *   src-tauri/binaries/bridge/package.json      exact production deps of the bridge
 *   src-tauri/binaries/bridge/node_modules/     installed by npm (real directories, no pnpm links)
 *   src-tauri/binaries/bridge/server/           the bridge sources
 *   src-tauri/binaries/pi-desktop-server            POSIX launcher (win32 spawns node.exe + entry)
 *
 * Building needs Node/npm and network; end users still need neither.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

import {
  bridgePackageManifest,
  collectBareImports,
  defaultTargetTriple,
  packageNameOf,
  renderPosixBridgeLauncher,
  staleInstalledPackages,
} from "./lib/bridgeRuntime.mjs";
import { findUnrelocatable } from "./lib/pythonRuntime.mjs";
import { formatBytes, prunePlatformPackages, resolveTargetPlatform } from "./lib/platformPackages.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binariesDir = join(repoRoot, "src-tauri", "binaries");
const bridgeDir = join(binariesDir, "bridge");
// Windows never gets a launcher at all: a shell script renamed `.exe` would be a fake binary, and
// the win32 hosts spawn `node.exe bridge\server\index.mjs` themselves. The POSIX file stays in
// the resource map on every platform because Tauri fails a build on a missing resource path.
const launcherPath = join(binariesDir, "pi-desktop-server");
const nodeRuntimeDir = join(binariesDir, "node-runtime");
const bundledNode = join(nodeRuntimeDir, process.platform === "win32" ? "node.exe" : "bin/node");
// The slim packaging mode ships no node-runtime, so the build-time verification of the bridge tree
// runs on the build machine's own Node instead. Either way the tree is checked with a real Node;
// which Node only matters for what PATH those checks are allowed to reach.
const verificationNode = existsSync(bundledNode) ? bundledNode : process.execPath;

function listServerSources(dir, found = []) {
  if (!existsSync(dir)) {
    return found;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        listServerSources(path, found);
      }
    } else if (entry.name.endsWith(".mjs")) {
      found.push(path);
    }
  }
  return found;
}

function installedVersion(pkg) {
  const manifest = join(repoRoot, "node_modules", pkg, "package.json");
  if (!existsSync(manifest)) {
    return "";
  }
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).version ?? "";
  } catch {
    return "";
  }
}

function declaredVersions() {
  try {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    return { ...manifest.dependencies, ...manifest.devDependencies };
  } catch {
    return {};
  }
}

function runNpm(cwd) {
  const npmCli = process.env.npm_execpath?.trim() || "npm";
  const command = npmCli.endsWith(".js") ? process.execPath : npmCli;
  const args = npmCli.endsWith(".js") ? [npmCli, "install", "--omit=dev", "--no-audit", "--no-fund"] : ["install", "--omit=dev", "--no-audit", "--no-fund"];
  // An inherited global prefix (nvm, corepack, a previous app runtime) would redirect the install.
  const env = { ...process.env };
  delete env.npm_config_prefix;
  delete env.PREFIX;
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`npm install failed for the bridge runtime:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

export function buildBridgeRuntime({ skipInstall = false, target = "", targetPlatform = null } = {}) {
  const sources = listServerSources(join(repoRoot, "server")).map((path) => readFileSync(path, "utf8"));
  const imports = collectBareImports(sources);
  const packages = [...new Set(imports.map(packageNameOf))].filter(Boolean);
  const versions = {};
  for (const pkg of packages) {
    const version = installedVersion(pkg);
    if (!version) {
      throw new Error(`cannot resolve installed version for "${pkg}" (imported by server/); run npm install first`);
    }
    versions[pkg] = version;
  }

  // Those versions come from the installed tree, which can lag package.json: a commit that bumps a
  // dependency (pi 0.87.0 arrived that way) does not touch `node_modules` until someone runs
  // `npm install`, and the bridge would then ship the old package without a word - which is how a
  // stale tree once got measured and reported as this bundle. Say it out loud, but do not fail:
  // `--skip-install` builds, and a tree locally ahead of the declared floor, are both legitimate.
  for (const stale of staleInstalledPackages({ declared: declaredVersions(), installed: versions })) {
    console.warn(
      `bridge: WARNING node_modules/${stale.name} is ${stale.installed} but the repo declares "${stale.declared}" - this bridge would ship ${stale.installed}; run \`npm install\` in the repo root first.`,
    );
  }

  const { manifest, missing } = bridgePackageManifest({ versions, imports });
  if (missing.length) {
    throw new Error(`bridge imports packages with no installed version: ${missing.join(", ")}`);
  }

  // --skip-install reuses the installed tree (offline iteration); a real build starts clean.
  if (skipInstall) {
    rmSync(join(bridgeDir, "server"), { recursive: true, force: true });
  } else {
    rmSync(bridgeDir, { recursive: true, force: true });
  }
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join(repoRoot, "server"), join(bridgeDir, "server"), {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  // The bridge imports shared pure contracts from src/shared (types are erased; the bundled
  // node runs .ts with type stripping enabled). They must travel with the tree.
  cpSync(join(repoRoot, "src", "shared"), join(bridgeDir, "src", "shared"), {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });

  if (skipInstall) {
    console.log(`bridge: skipped install (${Object.keys(manifest.dependencies).length} deps declared)`);
  } else {
    runNpm(bridgeDir);
  }

  // npm installs every platform variant of esbuild and friends when pi's shipped
  // npm-shrinkwrap.json is in play (the os/cpu filter does not apply to a shrinkwrap tree). They are
  // 284M of binaries for machines this bundle will never run on, so drop the ones the target cannot
  // use. Pruning after the install is the only thing that works: `npm install --os/--cpu` still
  // follows the shrinkwrap. See scripts/lib/platformPackages.mjs.
  const platform = targetPlatform ?? resolveTargetPlatform();
  const pruned = prunePlatformPackages({ root: bridgeDir, target: platform });
  if (pruned.removed.length > 0) {
    console.log(
      `bridge: pruned ${pruned.removed.length} platform-only packages (${formatBytes(pruned.bytes)}) that cannot run on ${platform.os}/${platform.cpu}`,
    );
  }
  for (const failure of pruned.failed) {
    console.warn(`bridge: could not prune ${failure.name}: ${failure.error}`);
  }

  const modulesDir = join(bridgeDir, "node_modules");
  if (!existsSync(join(modulesDir, "@earendil-works", "pi-coding-agent", "package.json"))) {
    throw new Error(`bridge runtime is incomplete: ${modulesDir} has no @earendil-works/pi-coding-agent`);
  }

  const problems = findUnrelocatable(modulesDir, {
    platform: process.platform,
    forbidden: [repoRoot, homedir(), tmpdir()],
    // `#!/usr/bin/env node` console scripts in a JS tree are portable as long as the same
    // bundle ships node and puts it first on PATH - declare that here instead of loosening the rule.
    // In the slim mode the equivalent guarantee is the host's own Node, which is what runs the tree.
    interpreterDirs: existsSync(join(nodeRuntimeDir, "bin"))
      ? [nodeRuntimeDir]
      : [dirname(verificationNode)],
  }).filter((problem) => problem.severity !== "provenance");
  if (problems.length) {
    throw new Error(
      `bridge node_modules is not relocatable (${problems.length} problems), first: ${problems[0].path} (${problems[0].kind})`,
    );
  }

  writeFileSync(
    launcherPath,
    renderPosixBridgeLauncher({
      entry: "server/index.mjs",
      nodeBinRel: "node-runtime/bin/node",
      bridgeDirRel: "bridge",
      cacheDir: '"${TMPDIR:-/tmp}/pi-desktop-node-compile-cache"',
    }),
    { mode: 0o755 },
  );
  chmodSync(launcherPath, 0o755);
  rmSync(join(binariesDir, "pi-desktop-server.exe"), { force: true });
  // Tauri names its sidecar per target triple; keep both spellings so either shell finds it.
  if (target) {
    const trialed = join(binariesDir, `pi-desktop-server-${target}`);
    if (trialed !== launcherPath) {
      cpSync(launcherPath, trialed);
      chmodSync(trialed, 0o755);
    }
  }

  return { bridgeDir, launcherPath, manifest, problems: [] };
}

// Gate 2: everything the shipped tree imports must resolve inside that tree. The probe has to be
// a real file inside each importing directory - `import.meta.resolve(spec, parent)` ignores the
// parent unless Node runs with --experimental-import-meta-resolve, which would let the check pass
// (or fail) against whatever the build machine happens to have above the bundle.
export function verifyBridgeSelfResolve({ node = verificationNode, dir = bridgeDir } = {}) {
  if (!existsSync(node)) {
    throw new Error(`node for verification is missing: ${node} (run npm run node:build, or install Node on this machine)`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const piDir = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
  const piDeps = Object.keys(JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")).dependencies ?? {});
  const targets = [
    // The bridge entry itself.
    { from: join(dir, "server"), specs: Object.keys(manifest.dependencies ?? {}) },
    // pi loads extensions through jiti and friends from its own directory.
    { from: join(piDir, "dist"), specs: piDeps },
  ];

  const escaped = [];
  for (const { from, specs } of targets) {
    mkdirSync(from, { recursive: true });
    const probe = join(from, ".pi-desktop-resolve-probe.mjs");
    const body = [
      "import { pathToFileURL } from 'node:url';",
      "import { existsSync } from 'node:fs';",
      `const specs = ${JSON.stringify(specs)};`,
      "for (const spec of specs) {",
      "  try {",
      "    const url = import.meta.resolve(spec);",
      "    const target = url.startsWith('file:') ? new URL(url) : null;",
      "    const file = target ? decodeURIComponent(target.pathname) : url;",
      "    console.log(`${spec}\\t${existsSync(file) ? 'ok' : 'missing'}\\t${file}`);",
      "  } catch (error) {",
      "    console.log(`${spec}\\tunresolved\\t${error.code ?? error.message}`);",
      "  }",
      "}",
      "",
    ].join("\n");
    writeFileSync(probe, body);
    let output = "";
    try {
      const result = spawnSync(node, [probe], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: homedir() },
      });
      if (result.status !== 0) {
        throw new Error(`resolve probe crashed in ${from}:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
      }
      output = result.stdout ?? "";
    } finally {
      rmSync(probe, { force: true });
    }
    for (const line of output.trim().split("\n")) {
      const [spec, state, target] = line.split("\t");
      if (state !== "ok" || !target.startsWith(`${dir}/`)) {
        escaped.push(`${spec} -> ${state} ${target}`);
      }
    }
  }
  if (escaped.length) {
    throw new Error(
      `bridge tree does not resolve its own dependencies (${escaped.length}), first: ${escaped[0]}`,
    );
  }
  return targets.reduce((total, { specs }) => total + specs.length, 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const skipInstall = process.argv.includes("--skip-install");
  const targetIndex = process.argv.indexOf("--target");
  const cliTarget = targetIndex >= 0 ? process.argv[targetIndex + 1] ?? "" : "";
  // 目标三元组的来源：命令行 --target > 出包脚本导出的 PI_DESKTOP_TARGET_TRIPLE > Tauri 自己导出的
  // TAURI_ENV_TARGET_TRIPLE > 构建机自己。两种外壳都从这里拿同一个值，于是“按哪个平台剪包”和
  // “最终打包给哪个平台”不可能不一致（从前 Electron 在 mac 上打 --win 就会剪成 mac，那个坑就是这么来的）。
  const envTriple = process.env.PI_DESKTOP_TARGET_TRIPLE?.trim() || process.env.TAURI_ENV_TARGET_TRIPLE?.trim() || "";
  const target = cliTarget || envTriple || defaultTargetTriple();
  const targetPlatform = resolveTargetPlatform({ triple: cliTarget || envTriple });
  const { manifest } = buildBridgeRuntime({ skipInstall, target, targetPlatform });
  const checked = skipInstall ? 0 : verifyBridgeSelfResolve();
  console.log(`bridge: ${Object.keys(manifest.dependencies).length} deps -> ${bridgeDir}`);
  console.log(`launcher: ${launcherPath}`);
  if (checked) {
    console.log(`self-resolve: ${checked} imports resolve inside the tree with ${verificationNode === bundledNode ? "the bundled node" : "the host node"}`);
  }
}
