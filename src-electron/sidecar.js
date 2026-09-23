"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const { bundledNodePaths, bundledPythonPaths, userPiAgentDir } = require("./paths");

/** 精简版找不到 Node 时给用户看的话；lib.rs 的 NODE_MISSING_MESSAGE 是同一句。 */
const NODE_MISSING_MESSAGE =
  "找不到 Node.js。精简版不带内嵌运行时，需要先安装 Node.js 22 或更高版本（https://nodejs.org），" +
  "并确保它在 PATH 里（用 nvm / Homebrew 装的也可以）。装好后重新启动 Pi Desktop。";

// The bridge picks its own port (preferred 6474, otherwise any free one) and announces it on
// stdout; the shell discovers that announcement and hands the address to the renderer through the
// preload. Nothing here may invent a port - that is how a busy 6474 used to produce a silent,
// empty window.
async function bridgeRules(shellPaths) {
  const target = shellPaths.bridgeListen;
  if (!fs.existsSync(target)) {
    throw new Error(`Bridge port rules are missing from the bundle: ${target}`);
  }
  return import(pathToFileURL(target).href);
}

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
// pi-subagents' own override for "which pi-coding-agent copy is the host". Its detached runner is a
// plain Node process under `~/.pi/agent/npm/node_modules`, so ESM lookup only walks parent
// directories and can never reach the copy inside the app bundle; the package expects the host to
// hand the path over. It also refuses to fall back to an extension-owned copy on purpose.
const PI_HOST_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

/** True only for a readable install whose manifest says it is the SDK. */
function isPiCodingAgentPackage(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return manifest?.name === PI_CODING_AGENT_PACKAGE;
  } catch {
    return false;
  }
}

/**
 * Where this shell's own `@earendil-works/pi-coding-agent` lives: `bridge/node_modules` in a
 * package, the repo root's `node_modules` in dev. Verified by manifest, so a bundle whose bridge
 * dependencies were pruned yields `null` and the variable is left unset instead of pointing a
 * package at a path that would fail with a confusing "does not provide" error.
 */
function hostPiPackageRoot(shellPaths) {
  const root = typeof shellPaths?.root === "string" ? shellPaths.root : "";
  if (!root) {
    return null;
  }
  const segments = PI_CODING_AGENT_PACKAGE.split("/");
  const candidates = [
    path.join(root, "bridge", "node_modules", ...segments),
    path.join(root, "node_modules", ...segments),
  ];
  return candidates.find(isPiCodingAgentPackage) ?? null;
}

/**
 * The env pair handing that path over, or `{}` when there is nothing to hand over. An inherited
 * value wins: whoever set it deliberately (launchctl, a wrapper, a custom SDK checkout) knows
 * better than this guess.
 */
function hostPiPackageRootEnv(shellPaths, env = process.env) {
  if (String(env[PI_HOST_PACKAGE_ROOT_ENV] ?? "").trim()) {
    return {};
  }
  const root = hostPiPackageRoot(shellPaths);
  return root ? { [PI_HOST_PACKAGE_ROOT_ENV]: root } : {};
}

function bridgeEnv(shellPaths) {
  // `undefined` means an older/absent caller: keep the historical strict bundled behaviour.
  const runtimeMode = shellPaths.runtimeMode ?? "bundled";
  const node = bundledNodePaths(shellPaths);
  const python = runtimeMode === "bundled" ? bundledPythonPaths(shellPaths) : null;
  const hostPath = shellPaths.hostPath ?? process.env.PATH ?? "";
  const agentDir = userPiAgentDir();

  // The slim build ships no runtimes, so this is the one thing the machine must provide. Checked
  // before anything else: on Windows `shellPaths.sidecar` *is* the resolved node, so a missing one
  // would otherwise be reported as "launcher is missing: null". The message reaches the user
  // through reportStartupFailure(), so it has to be actionable.
  if (runtimeMode === "system" && !shellPaths.systemNode) {
    throw new Error(NODE_MISSING_MESSAGE);
  }

  if (!fs.existsSync(shellPaths.sidecar) || !fs.statSync(shellPaths.sidecar).isFile()) {
    throw new Error(`Bundled bridge launcher is missing: ${shellPaths.sidecar}`);
  }
  for (const entry of shellPaths.sidecarArgs ?? []) {
    if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
      throw new Error(`Bundled bridge source is missing: ${entry}`);
    }
  }

  if (runtimeMode === "bundled") {
    if (!python) {
      throw new Error("Bundled Python runtime is missing its executable");
    }
    for (const required of [node.bin, node.npmCli]) {
      if (!fs.existsSync(required) || !fs.statSync(required).isFile()) {
        throw new Error(`Bundled runtime file is missing: ${required}`);
      }
    }
  }

  const pathEntries = [
    path.join(agentDir, "bin"),
    ...(runtimeMode === "bundled" ? [path.dirname(node.bin)] : []),
    ...(hostPath ? String(hostPath).split(path.delimiter) : []),
  ].filter(Boolean);

  return {
    env: {
      ...process.env,
      PATH: pathEntries.join(path.delimiter),
      PI_CODING_AGENT_DIR: agentDir,
      PI_DESKTOP_APP_SKILLS_DIR: shellPaths.skills,
      PI_DESKTOP_CAPABILITIES_DEFAULTS_FILE: shellPaths.capabilitiesDefaults,
      PI_DESKTOP_RUNTIME_MODE: runtimeMode,
      // Only ever set in `bundled` mode: their absence is what makes the bridge leave the
      // `~/.pi/agent/bin` launchers alone and let every skill use the host's own interpreters.
      ...(runtimeMode === "bundled"
        ? {
            PI_DESKTOP_BUNDLED_PYTHON_BIN: python.bin,
            PI_DESKTOP_BUNDLED_PYTHON_HOME: python.home,
            PI_DESKTOP_BUNDLED_NODE_BIN: node.bin,
            PI_DESKTOP_BUNDLED_NODE_HOME: shellPaths.nodeRuntime,
            PI_DESKTOP_BUNDLED_NPM_CLI: node.npmCli,
          }
        : {}),
      // POSIX: the launcher doubles as the pi CLI (`--pi-cli`). win32 has no launcher script,
      // so the pi shim gets the interpreter + entry pair instead.
      ...(shellPaths.piCli.binary
        ? { PI_DESKTOP_PI_CLI_BINARY: shellPaths.piCli.binary }
        : {
            PI_DESKTOP_PI_CLI_RUNTIME: shellPaths.piCli.runtime,
            PI_DESKTOP_PI_CLI_ENTRY: shellPaths.piCli.entry,
          }),
      // Packages that spawn their own Node child cannot resolve the SDK from where they are
      // installed; hand them the copy the bridge itself runs on (see hostPiPackageRootEnv).
      ...hostPiPackageRootEnv(shellPaths),
      PI_DESKTOP_HOST: "127.0.0.1",
    },
    cwd: shellPaths.skills,
  };
}

// Same contract as start_bridge(): the unpacked bridge, run through the bundled node
// with cwd = bundled skills dir so relative skill paths resolve. Returns the child plus the
// announced API address, because only the bridge knows which port it ended up with.
async function startBridge(shellPaths, log = console) {
  const { env, cwd } = bridgeEnv(shellPaths);
  const { createBridgeUrlWatcher } = await bridgeRules(shellPaths);
  const watcher = createBridgeUrlWatcher({ timeoutMs: 20000 });
  const child = spawn(shellPaths.sidecar, shellPaths.sidecarArgs ?? [], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    watcher.feed(chunk);
    log.info(`[bridge] ${String(chunk).trimEnd()}`);
  });
  child.stderr?.on("data", (chunk) => log.warn(`[bridge] ${String(chunk).trimEnd()}`));
  child.on("exit", (code, signal) => {
    if (code !== 0) {
      log.warn(`[bridge] exited (code=${code} signal=${signal ?? "none"})`);
      watcher.closed(`exit code ${code}`);
    }
  });
  // A rejected url must never become an unhandled rejection in the shell.
  watcher.promise.catch(() => {});

  return { child, url: watcher.promise };
}

async function waitForBridge(apiBase, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      const response = await fetch(`${apiBase}/api/bootstrap`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.ok) {
        return true;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return false;
}

function stopBridge(child) {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }

  try {
    child.kill();
  } catch {
    // the process is already gone
  }
}

module.exports = {
  bridgeEnv,
  hostPiPackageRoot,
  hostPiPackageRootEnv,
  startBridge,
  stopBridge,
  waitForBridge,
};
