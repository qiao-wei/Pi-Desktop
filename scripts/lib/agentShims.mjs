// The `~/.pi/agent/bin` launchers.
//
// They are written on every start with the *current* location of the app bundle,
// which is the only way a machine without Node or Python gets a runtime at all.
// That also means a launcher is a snapshot: move the app, eject the DMG it was
// launched from, or reinstall over a different path, and the baked value points at
// nothing. Before this module that was a silent failure — `python3` exited with
// "No such file or directory" from the shell, tests went green without running,
// and the only symptom was "the feature does nothing".
//
// Two rules, for every launcher:
//   1. an incoming `PI_DESKTOP_BUNDLED_*` value from the running app wins over the
//      baked one, so a launcher written by an earlier launch still works;
//   2. if neither candidate exists, fail loudly (message on stderr, exit 127)
//      instead of exec-ing a path that cannot be found.

function shellQuote(value) {
  return JSON.stringify(String(value));
}

function shellQuoteWindows(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function escapeWindowsSet(value) {
  return String(value).replace(/"/g, '""');
}

/**
 * @param {{
 *  agentPythonBaseDir: string, agentPythonCacheDir: string,
 *  agentNodeBaseDir: string, agentNodeCacheDir: string, agentNodeConfigFile: string,
 * }} dirs
 */
export function createAgentShims(dirs) {
  const pythonUserBase = shellQuote(dirs.agentPythonBaseDir);
  const pythonCache = shellQuote(dirs.agentPythonCacheDir);
  const nodeBase = shellQuote(dirs.agentNodeBaseDir);
  const nodeCache = shellQuote(dirs.agentNodeCacheDir);
  const nodeConfig = shellQuote(dirs.agentNodeConfigFile);
  const wPythonUserBase = escapeWindowsSet(dirs.agentPythonBaseDir);
  const wPythonCache = escapeWindowsSet(dirs.agentPythonCacheDir);
  const wNodeBase = escapeWindowsSet(dirs.agentNodeBaseDir);
  const wNodeCache = escapeWindowsSet(dirs.agentNodeCacheDir);
  const wNodeConfig = escapeWindowsSet(dirs.agentNodeConfigFile);

  function renderPiShim() {
    return [
      "#!/bin/sh",
      "set -eu",
      'if [ -n "${PI_DESKTOP_PI_CLI_BINARY:-}" ] && [ -x "$PI_DESKTOP_PI_CLI_BINARY" ]; then',
      '  exec "$PI_DESKTOP_PI_CLI_BINARY" --pi-cli "$@"',
      "fi",
      'if [ -n "${PI_DESKTOP_PI_CLI_RUNTIME:-}" ] && [ -n "${PI_DESKTOP_PI_CLI_ENTRY:-}" ]; then',
      '  exec "$PI_DESKTOP_PI_CLI_RUNTIME" "$PI_DESKTOP_PI_CLI_ENTRY" --pi-cli "$@"',
      "fi",
      'echo "pi launcher is unavailable: set PI_DESKTOP_PI_CLI_BINARY or PI_DESKTOP_PI_CLI_RUNTIME/PI_DESKTOP_PI_CLI_ENTRY" >&2',
      "exit 127",
      "",
    ].join("\n");
  }

  function renderWindowsPiShim() {
    return [
      "@echo off",
      'if defined PI_DESKTOP_PI_CLI_BINARY if exist "%PI_DESKTOP_PI_CLI_BINARY%" goto bundled',
      'if defined PI_DESKTOP_PI_CLI_RUNTIME if defined PI_DESKTOP_PI_CLI_ENTRY goto dev',
      'echo pi launcher is unavailable: set PI_DESKTOP_PI_CLI_BINARY or PI_DESKTOP_PI_CLI_RUNTIME/PI_DESKTOP_PI_CLI_ENTRY 1>&2',
      "exit /b 127",
      ":bundled",
      '"%PI_DESKTOP_PI_CLI_BINARY%" --pi-cli %*',
      "exit /b %ERRORLEVEL%",
      ":dev",
      '"%PI_DESKTOP_PI_CLI_RUNTIME%" "%PI_DESKTOP_PI_CLI_ENTRY%" --pi-cli %*',
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
  }

  /** kind: "python" | "pip" */
  function renderPosixShim(pythonBin, kind, pythonHome = "") {
    const resolve = [
      "if [ -z \"${PI_DESKTOP_BUNDLED_PYTHON_BIN:-}\" ] || [ ! -x \"${PI_DESKTOP_BUNDLED_PYTHON_BIN:-/nonexistent}\" ]; then",
      `  if [ -x ${shellQuote(pythonBin)} ]; then`,
      `    PI_DESKTOP_BUNDLED_PYTHON_BIN=${shellQuote(pythonBin)}`,
      pythonHome ? `    PI_DESKTOP_BUNDLED_PYTHON_HOME=${shellQuote(pythonHome)}` : null,
      "  else",
      '    echo "Pi Desktop python: bundled runtime is unavailable (this launcher was written by an older Pi Desktop at a path that no longer exists). Reopen the app." >&2',
      "    exit 127",
      "  fi",
      "fi",
      'export PI_DESKTOP_BUNDLED_PYTHON_BIN',
      'if [ -n "${PI_DESKTOP_BUNDLED_PYTHON_HOME:-}" ]; then export PYTHONHOME="$PI_DESKTOP_BUNDLED_PYTHON_HOME"; fi',
    ].filter((line) => line !== null);

    return [
      "#!/bin/sh",
      "set -eu",
      "unset PYTHONPATH PYTHONSTARTUP VIRTUAL_ENV",
      ...resolve,
      `export PYTHONUSERBASE=${pythonUserBase}`,
      `export PIP_CACHE_DIR=${pythonCache}`,
      "export PIP_CONFIG_FILE=/dev/null",
      "export PIP_USER=${PIP_USER:-1}",
      kind === "pip"
        ? '"$PI_DESKTOP_BUNDLED_PYTHON_BIN" -m pip "$@"'
        : '"$PI_DESKTOP_BUNDLED_PYTHON_BIN" "$@"',
      "",
    ].join("\n");
  }

  function renderWindowsShim(pythonBin, kind, pythonHome = "") {
    const resolve = [
      'if defined PI_DESKTOP_BUNDLED_PYTHON_BIN if exist "%PI_DESKTOP_BUNDLED_PYTHON_BIN%" goto pyok',
      pythonBin ? `if exist ${shellQuoteWindows(pythonBin)} goto pybaked` : "goto pymissing",
      ":pymissing",
      'echo Pi Desktop python: bundled runtime is unavailable (this launcher was written by an older Pi Desktop at a path that no longer exists). Reopen the app. 1>&2',
      "exit /b 127",
      ":pybaked",
      `set "PI_DESKTOP_BUNDLED_PYTHON_BIN=${escapeWindowsSet(pythonBin)}"`,
      pythonHome ? `set "PI_DESKTOP_BUNDLED_PYTHON_HOME=${escapeWindowsSet(pythonHome)}"` : null,
      ":pyok",
      'if defined PI_DESKTOP_BUNDLED_PYTHON_HOME set "PYTHONHOME=%PI_DESKTOP_BUNDLED_PYTHON_HOME%"',
    ].filter((line) => line !== null);

    const command =
      kind === "pip" ? '"%PI_DESKTOP_BUNDLED_PYTHON_BIN%" -m pip %*' : '"%PI_DESKTOP_BUNDLED_PYTHON_BIN%" %*';

    return [
      "@echo off",
      'set "PYTHONPATH="',
      'set "PYTHONSTARTUP="',
      'set "VIRTUAL_ENV="',
      ...resolve,
      `set "PYTHONUSERBASE=${wPythonUserBase}"`,
      `set "PIP_CACHE_DIR=${wPythonCache}"`,
      'set "PIP_CONFIG_FILE=NUL"',
      'if not defined PIP_USER set "PIP_USER=1"',
      command,
      "",
    ].join("\r\n");
  }

  /** kind: "node" | "npm" | "npx" */
  function renderPosixNodeShim(nodeBin, npmCli, kind) {
    const command =
      kind === "node"
        ? '"$PI_DESKTOP_BUNDLED_NODE_BIN" "$@"'
        : kind === "npx"
          ? '"$PI_DESKTOP_BUNDLED_NODE_BIN" "$PI_DESKTOP_BUNDLED_NPM_CLI" exec -- "$@"'
          : '"$PI_DESKTOP_BUNDLED_NODE_BIN" "$PI_DESKTOP_BUNDLED_NPM_CLI" "$@"';

    return [
      "#!/bin/sh",
      "set -eu",
      "unset NODE_PATH NODE_OPTIONS NPM_CONFIG_PREFIX NPM_CONFIG_CACHE NPM_CONFIG_USERCONFIG npm_config_prefix npm_config_cache npm_config_userconfig",
      'if [ -z "${PI_DESKTOP_BUNDLED_NODE_BIN:-}" ] || [ ! -x "${PI_DESKTOP_BUNDLED_NODE_BIN:-/nonexistent}" ]; then',
      `  if [ -x ${shellQuote(nodeBin)} ]; then`,
      `    PI_DESKTOP_BUNDLED_NODE_BIN=${shellQuote(nodeBin)}`,
      `    PI_DESKTOP_BUNDLED_NPM_CLI=${shellQuote(npmCli)}`,
      "  else",
      '    echo "Pi Desktop node: bundled runtime is unavailable (this launcher was written by an older Pi Desktop at a path that no longer exists). Reopen the app." >&2',
      "    exit 127",
      "  fi",
      "fi",
      'if [ -z "${PI_DESKTOP_BUNDLED_NPM_CLI:-}" ] || [ ! -f "${PI_DESKTOP_BUNDLED_NPM_CLI:-/nonexistent}" ]; then',
      `  PI_DESKTOP_BUNDLED_NPM_CLI=${shellQuote(npmCli)}`,
      "fi",
      "export PI_DESKTOP_BUNDLED_NODE_BIN PI_DESKTOP_BUNDLED_NPM_CLI",
      `export npm_config_prefix=${nodeBase}`,
      `export npm_config_cache=${nodeCache}`,
      `export npm_config_userconfig=${nodeConfig}`,
      command,
      "",
    ].join("\n");
  }

  function renderWindowsNodeShim(nodeBin, npmCli, kind) {
    const command =
      kind === "node"
        ? '"%PI_DESKTOP_BUNDLED_NODE_BIN%" %*'
        : kind === "npx"
          ? '"%PI_DESKTOP_BUNDLED_NODE_BIN%" "%PI_DESKTOP_BUNDLED_NPM_CLI%" exec -- %*'
          : '"%PI_DESKTOP_BUNDLED_NODE_BIN%" "%PI_DESKTOP_BUNDLED_NPM_CLI%" %*';

    return [
      "@echo off",
      'set "NODE_PATH="',
      'set "NODE_OPTIONS="',
      'set "NPM_CONFIG_PREFIX="',
      'set "NPM_CONFIG_CACHE="',
      'set "NPM_CONFIG_USERCONFIG="',
      'if defined PI_DESKTOP_BUNDLED_NODE_BIN if exist "%PI_DESKTOP_BUNDLED_NODE_BIN%" goto nodeok',
      `if exist ${shellQuoteWindows(nodeBin)} goto nodebaked`,
      'echo Pi Desktop node: bundled runtime is unavailable (this launcher was written by an older Pi Desktop at a path that no longer exists). Reopen the app. 1>&2',
      "exit /b 127",
      ":nodebaked",
      `set "PI_DESKTOP_BUNDLED_NODE_BIN=${escapeWindowsSet(nodeBin)}"`,
      `set "PI_DESKTOP_BUNDLED_NPM_CLI=${escapeWindowsSet(npmCli)}"`,
      ":nodeok",
      'if not defined PI_DESKTOP_BUNDLED_NPM_CLI set "PI_DESKTOP_BUNDLED_NPM_CLI=' + escapeWindowsSet(npmCli) + '"',
      `set "npm_config_prefix=${wNodeBase}"`,
      `set "npm_config_cache=${wNodeCache}"`,
      `set "npm_config_userconfig=${wNodeConfig}"`,
      command,
      "",
    ].join("\r\n");
  }

  return {
    renderPiShim,
    renderWindowsPiShim,
    renderPosixShim,
    renderWindowsShim,
    renderPosixNodeShim,
    renderWindowsNodeShim,
  };
}
