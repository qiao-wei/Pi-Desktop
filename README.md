# Pi Desktop

A desktop host for `@earendil-works/pi-coding-agent`.

Two native shells share one React renderer and one local Node "bridge":

- **Tauri** (`src-tauri/`) - uses the system web view, so it never ships a browser engine.
- **Electron** (`src-electron/`) - ships its own Chromium, which dominates the bundle size.

The bridge (`server/index.mjs`) embeds pi - `ModelRuntime`, `SessionManager`, `SettingsManager`,
`DefaultResourceLoader` - and serves the HTTP/WebSocket API the renderer talks to. Pi resources are
loaded through `DefaultResourceLoader`: global from `~/.pi/agent`, project from `<project>/.pi`, plus
the bundled system skills in `skills/`. A session's cwd can be a managed git worktree; that worktree's
`.pi` is a symlink back to the project's, so project skills/extensions/packages resolve to one copy.

[中文说明](README.zh-CN.md)

## Layout

```
server/          the bridge: pi host + HTTP/WS API
src/             React renderer (Vite)
src-electron/    Electron main process + packaging config
src-tauri/       Tauri shell (Rust) + packaging config
scripts/         dev / build / diagnostics tooling
skills/          bundled system skills
tests/           node:test suites
```

## Development

### Prerequisites

| Requirement | Needed for |
| --- | --- |
| Node.js 22 or newer | dev, tests, and any `slim` build (the bridge declares `engines.node >= 22`) |
| `bun` | only the default dev bridge runtime; `PI_DESKTOP_SERVER_RUNTIME=node` uses Node instead |
| Rust stable + the [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) | the Tauri shell only |
| Python 3.13 source + `uv` | `bundled` packaging only - see [Build machine requirements](#build-machine-requirements) |

### Run it

```bash
npm install
npm run dev              # bridge + Vite UI in one process
npm run tauri:dev        # Tauri window (starts the dev stack itself)
npm run electron:dev     # Electron window (starts, or reuses, the dev stack)
```

`npm run dev` brings up the bridge and the Vite UI at `http://127.0.0.1:5176`. The bridge picks its
own port (preferring 6474) and **announces the real one on stdout**; the renderer gets that address
baked in as `VITE_PI_DESKTOP_API_BASE` (a packaged shell injects `window.__PI_DESKTOP_API_BASE__`
instead). If 6474 was taken, `dev` says so: a window pointed at somebody else's bridge looks like
"sessions are slow to switch", which is exactly what the old pinned-port setup hid.

Run one side at a time while debugging:

```bash
npm run dev:api                                                    # bridge only
VITE_PI_DESKTOP_API_BASE=http://127.0.0.1:6474 npm run dev:web      # UI only
```

- `PI_DESKTOP_REUSE_API=1 npm run dev` attaches to a bridge that is already listening.
- Electron main-process code is not hot-reloaded; restart `electron:dev` after touching
  `src-electron/`. Pass extra shell flags with
  `PI_DESKTOP_ELECTRON_ARGS=--remote-debugging-port=9223`.
- After editing anything under `server/`, run `npm run bridge:sync` before judging packaged
  behaviour. The packaged shell runs the copy under `src-tauri/binaries/bridge/`, not your working
  tree.

### Where state lives

`~/.pi/agent` holds auth (`auth.json`), sessions, skills, projects, capabilities, the `bin/`
launchers, and - in `bundled` mode - the isolated `node/` and `python/` prefixes. `PI_CODING_AGENT_DIR`
points the whole thing somewhere else, which is the cheap way to reproduce a clean install.

### Tests

```bash
npm test                                  # PI_DESKTOP_LOCALE=zh node --test "tests/**/*.test.ts"
node --test tests/runtimeModes.test.ts    # a single file
```

`node:test` on Node's native TypeScript type stripping: no framework, no extra dependencies. Test-side
value imports must carry their `.ts`/`.mjs` extension.

Suites worth knowing about, because they guard what an ordinary run cannot show you:

| Test | Guards |
| --- | --- |
| `electronAppPayload.test.ts` | `app.asar` contains the main process and nothing else |
| `launcherRefresh.test.ts` | boots the real bridge and inspects the `~/.pi/agent/bin` launchers it writes |
| `packagingVariants.test.ts` | the `bundled` / `slim` configs stay in sync resource-for-resource |
| `runtimeModes.test.ts` | bundled-vs-slim runtime resolution, host PATH lookup, stale-launcher cleanup |
| `sidecarGate.test.ts` | the assembled bridge is verified before the packager is allowed to run |
| `bridgeEndpoint.test.ts` | the two shells look for the bridge the same way |

### Diagnostics

The bridge can write an NDJSON probe log; the renderer can sample its own render timings.

```bash
PI_DESKTOP_DIAGNOSTICS_ENABLED=1 VITE_PI_DESKTOP_PERF=1 VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED=1 npm run dev
node scripts/diag-scan.mjs --since=30m     # find the bad windows in that log
```

Context compaction is hard to trigger with a short session, because pi needs both a nearly full
window *and* enough foldable history. `node scripts/compaction-env.mjs change` (64k window, low
`keepRecentTokens`) sets up a session that actually compacts; `reset` restores the defaults. It edits
pi's global config, so restart the app afterwards.

## Packaging

Two independent choices: **host** (Tauri or Electron) and **runtime mode** (`bundled` or `slim`).

### Runtime modes

- **`bundled`** (default) ships its own Node and Python, so end users need neither. It also
  isolates package installs: `pip install` goes to
  `~/.pi/agent/python`, npm to `~/.pi/agent/node` with its own cache, and the host's Python, pip,
  Node, npm and global configuration are never touched. Python ships with its standard library and
  `pip` only - the build strips every other site package and verifies that `python -m pip` resolves
  inside the bundle.
- **`slim`** ships neither runtime and uses the machine's own `node`, `npm`, `python3` and `pip`; it
  requires Node 22+ on the target machine. Nothing is isolated any more: `npm i -g` installs into the
  user's global prefix.

The mode is **inferred, not baked into the artifact**: both shells report `bundled` when *both*
runtime directories are present in the bundle and `system` otherwise, so the packaging config and the
running app read the same fact and cannot disagree. The packaging chain sets
`PI_DESKTOP_RUNTIME_MODE=bundled|system` from the entry you chose - that is the single switch that
reaches `electron-builder`, the bridge pruner and the capability gate; the same variable overrides the
running app for diagnosis.

The naming rule is one line: **`pack:<shell>:<target>[:<arch>][:slim]`** - the target is always
named, `:slim` is always the last segment, and no suffix means `bundled`. Every entry is a one-liner
over `scripts/pack.mjs`, which owns the chain; there is no second place where the steps are written
down.

| Shell / target | bundled | slim |
| --- | --- | --- |
| Electron, macOS arm64 | `npm run pack:electron:mac:arm64` | `npm run pack:electron:mac:arm64:slim` |
| Electron, macOS x64 | `npm run pack:electron:mac:x64` | `npm run pack:electron:mac:x64:slim` |
| Electron, Windows (x64) | `npm run pack:electron:windows` | `npm run pack:electron:windows:slim` |
| Tauri, macOS arm64 | `npm run pack:tauri:mac:arm64` | `npm run pack:tauri:mac:arm64:slim` |
| Tauri, macOS x64 | `npm run pack:tauri:mac:x64` | `npm run pack:tauri:mac:x64:slim` |
| Tauri, Windows (x64) | `npm run pack:tauri:windows` | `npm run pack:tauri:windows:slim` |

Flags for one-off runs: `--arch arm64|x64`, `--mode bundled|slim`, `--cross`, `--dry-run` (print the plan
and exit without building) - and anything after `--` is handed to the final packager
(`npm run pack:electron:mac:arm64 -- --dry-run`). Windows targets are x64 today; add `arm64` to
`PACK_ARCHES` in `scripts/lib/packPlan.mjs` when you want Windows on ARM.

**The old names are gone on purpose** (`electron:build`, `package:mac`, `package:windows:cross`, …):
an entry without a target cannot say what it builds, and the same command has to produce the same
artifact on anyone's machine. The table above is the mapping.

### What the pipeline does

Both shells run the same chain, defined once in `scripts/pack.mjs`:

```
tsc -b → vite build → python:build + node:build (bundled only) → bridge:build → sidecar:verify → packager
```

`sidecar:verify` now guards **both** shells. It is skipped - loudly, with the reason printed - only
for a cross build, where the bridge has already been pruned for the target platform and could not
boot on the build machine anyway. Tauri reaches the same chain through
`beforeBuildCommand: npm run tauri:prepare`, which is a no-op when `pack.mjs` already ran it (its slim
overlay is now only the two resource nulls, no second copy of the step list).

`bridge:sync` left the chain: it re-ran the assembly with `--skip-install`, produced a
byte-identical tree, and skipped the only strong check in the process. It stays as the offline dev
entry (see "Judging packaged behaviour" above).

The bridge is assembled, never compiled into a single file: unpacked `server/` and `src/` sources plus
a real production `node_modules`, executed by the bundled Node through the `pi-desktop-server`
launcher. pi loads runtime extensions through the packages it resolves on disk; a `bun build
--compile` artifact inlines its own copies and renames exports per build, which makes extension
loading depend on build luck. `sidecar:verify` boots the assembled bridge and fails if a selected
capability package did not load, so a broken assembly never reaches the packager.

After that install, `bridge:build` deletes the platform-only packages this bundle can never run
(`scripts/lib/platformPackages.mjs`). npm's usual `os`/`cpu` filtering does not apply to a tree
described by an `npm-shrinkwrap.json`, and pi ships one: esbuild - which pi reaches through
`@earendil-works/chord` - arrives as one package per platform, for every platform, when exactly one
of them can run here. `npm install --os/--cpu` does not change that; removing the others after the
install does, using npm's own rule (a package declaring a matching `os`/`cpu` is kept, `any` and `!`
negations included). The platform comes from `PI_DESKTOP_TARGET_TRIPLE` (set by `scripts/pack.mjs`
from the target/arch you asked for), falling back to `TAURI_ENV_TARGET_TRIPLE` for a direct
`tauri build` and to the build machine otherwise - so a Windows build keeps the `win32` packages
rather than the Mac ones. `node:build` and `python:build` read the same variable, which is why
"pruned for" and "packaged for" cannot drift apart again.

The manifest records the versions **installed in the repo's `node_modules`**, not the ranges
`package.json` declares. A commit that bumps a dependency does not touch `node_modules` until someone
runs `npm install`, and a bridge assembled from that stale tree would ship the old package without
saying so - so the build compares the two and warns (it does not fail: `--skip-install` builds and a
locally-ahead tree are both legitimate).

Windows has no launcher script: both hosts spawn `node-runtime\node.exe` with
`bridge\server\index.mjs` (Electron in `src-electron/paths.js`, Tauri in `src-tauri/src/lib.rs`), and
no `pi-desktop-server.exe` exists in any bundle.

### Build machine requirements

- **`bundled`** needs network access and target-native runtime sources. `python:build` and
  `node:build` execute the interpreter they just copied to prove it is self-contained, so they
  **cannot cross-build** - assemble the Windows runtimes on Windows.
  - Python: on macOS the build uses a managed CPython 3.13 installed by `uv`
    (`uv python install 3.13`); set `PI_DESKTOP_PYTHON_SOURCE_DIR` to override. It must not be
    Homebrew Python, whose extension modules link to Homebrew libraries. Windows needs a full Python
    installation directory rather than the embeddable ZIP; Linux needs a relocatable CPython prefix.
  - Node: set `PI_DESKTOP_NODE_SOURCE_DIR` to an official Node distribution root when the build
    cannot infer one - Linux always requires it.
- **`slim`** needs neither: no runtime sources, no network beyond `npm install`, just Node 22+ on the
  build machine.

### Cross-builds

Only each target's own machine can build a **`bundled`** package: `python:build` and `node:build`
execute the interpreter they just copied, and a Windows `python.exe` does not run on macOS. `--cross`
refuses that combination up front, with the three ways out, instead of failing halfway through.
**`slim` cross-builds fine**: it ships no runtimes.

| Build machine | macOS target | Windows target |
| --- | --- | --- |
| macOS | bundled + slim | **slim only** |
| Windows | not possible | bundled + slim |
| Linux | not possible | **slim only** |

macOS is never a cross target: dmg, signing and notarisation are all bound to a Mac.

Cross-building the Windows installer from an Apple Silicon Mac (slim only):

```bash
brew install nsis llvm
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
npm run pack:tauri:windows:slim -- --cross      # Tauri: cargo-xwin
npm run pack:electron:windows:slim -- --cross   # Electron: needs wine (the plan warns when it is missing)
```

### What ends up in the bundle

Resources (both hosts): `bridge/`, `renderer/`, `skills/`, `capabilities.defaults.json`, the
`pi-desktop-server` launcher on POSIX, and `node-runtime` / `python-runtime` in bundled mode.

Electron additionally has `app.asar`, which holds **only the main process**. Its
`files` list excludes `node_modules` on purpose: `directories.app` is `src-electron`, which has no
`dependencies` and no `node_modules`, so electron-builder used to fall back to the repository root
and pack the renderer's entire dependency tree into the asar - a second unminified copy of libraries
Vite had already bundled into `<resources>/renderer`.
`tests/electronAppPayload.test.ts` keeps that exclusion safe by failing if anything under
`src-electron/` ever requires a third-party module; dev reads the repository's `node_modules`, so
that mistake would only show up in the packaged app.

### Upgrading a bundled install to slim

A launcher written by a previous bundled installation points at a `node-runtime` the slim bundle no
longer ships, and `~/.pi/agent/bin` is first on PATH - leaving it behind shadows the user's own `node`
with `exit 127`. The bridge therefore deletes only the launchers it can prove are its own (a
`PI_DESKTOP_BUNDLED_*` marker in the content, or a symlink into a `-runtime` directory) and leaves
user files alone; see `server/agentShimFiles.mjs`.

A missing Node is reported instead of survived silently: Electron shows it through
`reportStartupFailure`, Tauri shows a `MessageDialog` before exiting rather than panicking into a
silent flash.

On macOS and Linux the host PATH is read back from the login shell, because a GUI-launched app does
not inherit one (`launchctl getenv PATH` is empty, and `/etc/paths` has no `/opt/homebrew/bin`), so a
tool the user installed outside the bundle - `/opt/homebrew/bin`, `~/.local/bin` - is only findable
that way. How much of the shell gets asked depends on the mode: `system` needs the machine's own
Node, which for nvm / pyenv / asdf users only exists in the interactive rc files, while `bundled`
ships its own runtimes and therefore reads the non-interactive login shell only - the interactive
files are the expensive ones (a version manager re-picking a Node on every shell start) and would
add nothing the bundle does not already carry. `PI_DESKTOP_HOST_PATH` overrides the result in both
modes.

### Outputs

- Electron: `dist-electron/mac-arm64/Pi Desktop.app` + `dist-electron/Pi Desktop-<version>-arm64.dmg`
  (x64 lands in `dist-electron/mac/`, Windows in `dist-electron/win-unpacked/` plus the NSIS
  installer). macOS signing is handled by `scripts/electron-sign-adhoc.mjs` (the `afterPack` hook).
- Tauri: `src-tauri/target/<target-triple>/release/bundle/{macos,dmg,nsis}/` - the pack entries always
  pass an explicit `--target`, so artifacts are separated per triple (a bare `npm run tauri:build`
  without one writes to `src-tauri/target/release/`).

## Environment variables

| Variable | Effect |
| --- | --- |
| `PI_DESKTOP_HOST`, `PI_DESKTOP_PORT` | bridge bind address / port. An explicit port is a contract; otherwise the bridge falls back to a free one and announces it. |
| `PI_DESKTOP_REUSE_API=1` | dev: attach to a bridge that is already listening |
| `PI_DESKTOP_SERVER_RUNTIME` | dev: runtime used to start the bridge (default `bun`) |
| `PI_DESKTOP_DEV_URL`, `PI_DESKTOP_ELECTRON_ARGS` | `electron:dev`: dev server to attach to / extra Electron flags |
| `PI_CODING_AGENT_DIR` | pi's state directory (default `~/.pi/agent`) |
| `PI_DESKTOP_LOCALE=zh\|en` | pin the UI language instead of detecting it |
| `VITE_PI_DESKTOP_API_BASE` | renderer: bridge base URL, for `dev:web` without `dev` |
| `PI_DESKTOP_RUNTIME_MODE` | force `bundled` or `system` instead of inferring it |
| `PI_DESKTOP_HOST_PATH` | override the PATH used to find the host's `node` in `system` mode |
| `PI_DESKTOP_DIFF_IDE`, `PI_DESKTOP_DIFF_IDE_KIND` | which IDE opens a changed file's diff when it is double-clicked in the git popover. Detection covers VS Code, CodeBuddy, Cursor, Windsurf, VSCodium, Zed, Sublime Text and the JetBrains IDEs; set these only for something else (`KIND` is `vscode`\|`zed`\|`sublime`\|`jetbrains`, default `vscode`) |
| `PI_DESKTOP_DIAGNOSTICS_ENABLED=1` | write the bridge's NDJSON probe log |
| `PI_DESKTOP_DIAGNOSTIC_LOG` | where that log goes (default `~/.pi/agent/pi-desktop-runtime.ndjson`) |
| `PI_DESKTOP_DIAGNOSTICS_STDERR=1` | also echo probe lines on stderr |
| `VITE_PI_DESKTOP_PERF=1`, `VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED=1` | renderer-side perf probes, for `scripts/diag-scan.mjs` |
| `PI_DESKTOP_COMPACTION_RESERVE_TOKENS`, `PI_DESKTOP_COMPACTION_KEEP_RECENT_TOKENS` | compaction thresholds (defaults 2200 / 1400) |
| `PI_DESKTOP_PYTHON_SOURCE_DIR`, `PI_DESKTOP_NODE_SOURCE_DIR` | runtime sources for `bundled` builds |
| `PI_DESKTOP_TARGET_TRIPLE` | target triple the packing chain hands to `node:build` / `python:build` / `bridge:build` (outranks Tauri's own `TAURI_ENV_TARGET_TRIPLE`) |
| `PI_DESKTOP_PACK_PREPARED=1` | set by `scripts/pack.mjs`; makes `tauri:prepare` a no-op so the prep steps run once per package |
| `UV_PYTHON_INSTALL_DIR` | where `uv` keeps the managed CPython used for `bundled` builds |
| `PI_DESKTOP_SIDECAR_BIN`, `PI_DESKTOP_GATE_NODE_RUNTIME`, `PI_DESKTOP_GATE_PYTHON_RUNTIME`, `PI_DESKTOP_GATE_CWD`, `PI_DESKTOP_GATE_TIMEOUT_MS` | what `sidecar:verify` boots and where |

Set by the shell or the launcher, not by hand: `PI_DESKTOP_BUNDLED_NODE_BIN`,
`PI_DESKTOP_BUNDLED_NPM_CLI`, `PI_DESKTOP_BUNDLED_PYTHON_BIN`, `PI_DESKTOP_BUNDLED_PYTHON_HOME`
(their absence is what makes skills reach the machine's own interpreters), `PI_DESKTOP_APP_SKILLS_DIR`,
`PI_DESKTOP_APP_PACKAGES_DIR`, `PI_DESKTOP_CAPABILITIES_DEFAULTS_FILE`. The generated POSIX launcher
accepts `PI_DESKTOP_BRIDGE_DIR` and `PI_DESKTOP_BRIDGE_NODE` as relocation overrides.

## See also

- [README.zh-CN.md](README.zh-CN.md) - the same document in Chinese
- [docs/plan.md](docs/plan.md) - early product notes, written when this was an English-tutor
  prototype; it is not a description of the current app