use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use tauri::{path::BaseDirectory, window::Color, AppHandle, Manager, RunEvent, Theme, WebviewUrl, WebviewWindowBuilder, Window};

struct BridgeSidecar(Mutex<Option<Child>>);

#[cfg(target_os = "linux")]
const BUNDLED_PYTHON_BIN: &str = "python-runtime/bin/python3.13";
#[cfg(target_os = "linux")]
const BUNDLED_PYTHON_HOME: &str = "python-runtime";
#[cfg(windows)]
const BUNDLED_PYTHON_BIN: &str = "python-runtime/python.exe";
#[cfg(windows)]
const BUNDLED_PYTHON_HOME: &str = "python-runtime";

#[cfg(not(windows))]
const BUNDLED_NODE_BIN: &str = "node-runtime/bin/node";
#[cfg(not(windows))]
const BUNDLED_NPM_CLI: &str = "node-runtime/lib/node_modules/npm/bin/npm-cli.js";
#[cfg(windows)]
const BUNDLED_NODE_BIN: &str = "node-runtime/node.exe";
#[cfg(windows)]
const BUNDLED_NPM_CLI: &str = "node-runtime/node_modules/npm/bin/npm-cli.js";

#[tauri::command]
fn choose_project_folder(default_path: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new().set_title("Choose project folder");

    if let Some(starting_directory) = dialog_starting_directory(default_path) {
        dialog = dialog.set_directory(starting_directory);
    }

    Ok(dialog
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn choose_skill_folder(default_path: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new().set_title("Choose skill folder");

    if let Some(starting_directory) = dialog_starting_directory(default_path) {
        dialog = dialog.set_directory(starting_directory);
    }

    Ok(dialog
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    let target = target.trim();
    if !is_openable_target(target) {
        return Err("Only local files and http, https, or mailto links can be opened.".to_owned());
    }

    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Unable to open {target}: {error}"))
}

#[tauri::command]
fn start_window_drag(window: Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|error| format!("Unable to start window drag: {error}"))
}

#[tauri::command]
fn toggle_window_maximize(window: Window) -> Result<(), String> {
    let result = if window
        .is_maximized()
        .map_err(|error| format!("Unable to read maximize state: {error}"))?
    {
        window.unmaximize()
    } else {
        window.maximize()
    };

    result.map_err(|error| format!("Unable to toggle maximize: {error}"))
}

#[tauri::command]
fn minimize_window(window: Window) -> Result<(), String> {
    window
        .minimize()
        .map_err(|error| format!("Unable to minimize window: {error}"))
}

#[tauri::command]
fn close_window(window: Window) -> Result<(), String> {
    window
        .close()
        .map_err(|error| format!("Unable to close window: {error}"))
}

/// 把界面主题同步给窗口外观。
///
/// macOS 侧栏材质（`Effect::Sidebar`）的明暗跟随 NSAppearance，而浅色/深色是渲染层
/// 自己的（`<html class="dark">`）；不同步就会出现「系统浅色 + 界面深色」= 一层发白的
/// 玻璃垫在深色侧栏下面。与 Electron 侧 `src-electron/host-commands.js` 同一口径。
#[tauri::command]
fn set_window_appearance(window: Window, appearance: String) -> Result<(), String> {
    let theme = match appearance.as_str() {
        "dark" => Theme::Dark,
        "light" => Theme::Light,
        other => return Err(format!("Unknown appearance: {other}")),
    };

    window
        .set_theme(Some(theme))
        .map_err(|error| format!("Unable to set window appearance: {error}"))
}

#[derive(serde::Serialize)]
struct TurnNotificationOutcome {
    delivered: bool,
    reason: Option<String>,
}

/// 标题/正文的规整，与 Electron 侧 `src-electron/turn-notification.js` 用同一套口径：
/// 标题为空退回落款名，正文允许为空（空正文只是少一行字，不该拦下整个提醒）。
fn turn_notification_text(title: &str, body: &str) -> (String, String) {
    let title = title.trim();
    let title = if title.is_empty() { "Pi Desktop" } else { title };
    (title.to_owned(), body.trim().to_owned())
}

/// 「任务完成后系统提醒」。
///
/// 桌面端 `show()` 是 fire-and-forget（插件内部 spawn 到 async runtime、把错误丢掉），
/// 所以这里只能报「已交给系统」：`Ok` 表示请求已发出。macOS 未签名开发版的失败由插件
/// 自己兜底（`tauri dev` 下它把通知归属到 Terminal），不需要我们判 bundle。
#[tauri::command]
fn notify_turn_complete(app: AppHandle, title: String, body: String) -> TurnNotificationOutcome {
    use tauri_plugin_notification::NotificationExt;

    let (title, body) = turn_notification_text(&title, &body);
    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => TurnNotificationOutcome {
            delivered: true,
            reason: None,
        },
        Err(error) => TurnNotificationOutcome {
            delivered: false,
            reason: Some(error.to_string()),
        },
    }
}

fn is_openable_target(target: &str) -> bool {
    target.starts_with("http://")
        || target.starts_with("https://")
        || target.starts_with("mailto:")
        || PathBuf::from(target).is_absolute()
        || target.starts_with(r"\\")
}

fn dialog_starting_directory(default_path: Option<String>) -> Option<PathBuf> {
    let raw_path = default_path?.trim().to_owned();
    if raw_path.is_empty() {
        return None;
    }

    let path = PathBuf::from(raw_path);
    if path.is_dir() {
        return Some(path);
    }

    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty() && parent.is_dir())
        .map(PathBuf::from)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // 基地址必须在开窗之前定下来：渲染进程把它当常量用（每个请求再解析一次、或轮询等注入，
            // 就是“端口降级后窗口打到别人桥上”的成因）。所以这里先拿到桥公告的地址，
            // 再用 initialization_script 建窗 —— 页面脚本跑起来时它已经在 window 上了。
            let api_base = if cfg!(debug_assertions) {
                // dev: 桥由 scripts/dev.mjs 起，地址经 vite 的 VITE_PI_DESKTOP_API_BASE 烘进包里。
                None
            } else {
                match start_bridge(&handle) {
                    Ok((child, url)) => {
                        app.manage(BridgeSidecar(Mutex::new(Some(child))));
                        Some(url)
                    }
                    Err(error) => {
                        // 没有这一步，setup 里的 `?` 会一路走到 `run()` 的 expect → panic：
                        // 窗口不会建，用户看到的是“点了图标闪一下就没了”，连原因都没有。
                        // 弹框后再退出，和 Electron 的 reportStartupFailure 行为对齐。
                        let message = error.to_string();
                        eprintln!("[pi-desktop] bridge failed to start: {message}");
                        rfd::MessageDialog::new()
                            .set_level(rfd::MessageLevel::Error)
                            .set_title("Pi Desktop 启动失败")
                            .set_description(&message)
                            .show();
                        std::process::exit(1);
                    }
                }
            };

            create_main_window(&handle, api_base.as_deref())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            choose_project_folder,
            choose_skill_folder,
            open_target,
            start_window_drag,
            toggle_window_maximize,
            minimize_window,
            close_window,
            set_window_appearance,
            notify_turn_complete
        ])
        .build(tauri::generate_context!())
        .expect("error while running Pi Desktop")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                stop_bridge(app);
            }
        });
}

fn create_main_window(app: &AppHandle, api_base: Option<&str>) -> tauri::Result<()> {
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Pi Desktop")
        .decorations(false)
        .transparent(true)
        .inner_size(1180.0, 780.0)
        .min_inner_size(360.0, 640.0)
        .resizable(true)
        // 关闭 Tauri 原生文件拖放拦截（默认开启）：否则 OS 拖拽被 webview 截走、
        // 转成 Tauri 事件，composer 里的 HTML5 dragenter/drop 永远不会触发。
        .disable_drag_drop_handler();

    // macOS 侧栏材质。原生 material 负责模糊，渲染层只叠一层薄 tint + sheen
    // （见 src/app/styles.css 的 `.project-sidebar-surface`）。与 Electron 侧
    // src-electron/main.js 的 `vibrancy: "sidebar"` 对齐：两个壳同一种观感。
    #[cfg(target_os = "macos")]
    {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        // `FollowsWindowActiveState` = Electron 侧的 `visualEffectState: "followWindow"`。
        // `effects()` 返回 builder 本身（不是 Result），所以不能加 `?`。
        builder = builder.effects(
            EffectsBuilder::new()
                .effect(Effect::Sidebar)
                .state(EffectState::FollowsWindowActiveState)
                .build(),
        );
    }

    if let Some(url) = api_base {
        // 与 Electron preload 用同一个全局名，两边渲染层只有一套取地址逻辑。
        builder = builder.initialization_script(&format!(
            "window.__PI_DESKTOP_API_BASE__={}",
            serde_json::to_string(url).unwrap_or_else(|_| "\"\"".to_owned())
        ));
    }

    let window = builder.build()?;
    let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
    let _ = window.set_shadow(true);

    #[cfg(debug_assertions)]
    window.open_devtools();

    Ok(())
}

fn start_bridge(app: &AppHandle) -> Result<(Child, String), Box<dyn std::error::Error>> {
    // POSIX runs the launcher script, which finds its node next to itself and - in the slim
    // packaging mode, where no runtime is shipped - on PATH. Windows has no launcher at all (a
    // shell script renamed `.exe` would be a fake binary), so there the host spawns node with the
    // bridge entry instead. No build step produces a `pi-desktop-server.exe`, and requiring one
    // here is what made a Windows bundle unbuildable.
    #[cfg(not(windows))]
    let sidecar_path = app.path().resolve("pi-desktop-server", BaseDirectory::Resource)?;
    #[cfg(windows)]
    let bridge_entry = app.path().resolve("bridge/server/index.mjs", BaseDirectory::Resource)?;
    let skills_path = app.path().resolve("skills", BaseDirectory::Resource)?;
    let capabilities_defaults_path =
        app.path().resolve("capabilities.defaults.json", BaseDirectory::Resource)?;

    let mode = runtime_mode(app);
    // The login-shell readback is what makes anything the user installed outside the bundle visible
    // here at all: a GUI-launched app does not inherit a shell's PATH (`launchctl getenv PATH` is
    // empty), so the process PATH alone finds nothing. Both modes read it; only `system` also needs
    // the interactive rc files - see `system_host_path`.
    let host_path = system_host_path(mode);

    // Shipped runtimes are both optional and mode-dependent: assembled here so the "is it there"
    // question is asked exactly once.
    let bundled = if mode == RuntimeMode::Bundled {
        let (python_bin, python_home) = bundled_python_paths(app)?;
        let node_bin = app.path().resolve(BUNDLED_NODE_BIN, BaseDirectory::Resource)?;
        let node_home = app.path().resolve("node-runtime", BaseDirectory::Resource)?;
        let npm_cli = app.path().resolve(BUNDLED_NPM_CLI, BaseDirectory::Resource)?;
        for required in [&python_bin, &node_bin, &npm_cli] {
            if !required.is_file() {
                return Err(format!(
                    "Bundled runtime file is missing: {}",
                    required.display()
                )
                .into());
            }
        }
        Some(BundledRuntimes {
            python_bin,
            python_home,
            node_bin,
            node_home,
            npm_cli,
        })
    } else {
        None
    };

    // The machine's own Node: what Windows spawns, and what the POSIX launcher will exec. Checked
    // on both platforms because on POSIX this is the only place the failure can be reported
    // clearly - the launcher would otherwise just `exit 127` into a pipe nobody reads.
    let system_node = if mode == RuntimeMode::System {
        resolve_node_on_path(&host_path)
    } else {
        None
    };
    if mode == RuntimeMode::System && system_node.is_none() {
        return Err(NODE_MISSING_MESSAGE.into());
    }

    #[cfg(windows)]
    let program = {
        if !bridge_entry.is_file() {
            return Err(format!("Bundled bridge entry is missing: {}", bridge_entry.display()).into());
        }
        match (&bundled, &system_node) {
            (Some(runtimes), _) => runtimes.node_bin.clone(),
            (None, Some(node)) => node.clone(),
            (None, None) => unreachable!("system mode without node is rejected above"),
        }
    };
    #[cfg(not(windows))]
    let program = {
        if !sidecar_path.is_file() {
            return Err(format!(
                "Bundled bridge launcher is missing: {}",
                sidecar_path.display()
            )
            .into());
        }
        sidecar_path.clone()
    };
    #[cfg(windows)]
    let bridge_args = vec![bridge_entry.clone()];
    #[cfg(not(windows))]
    let bridge_args: Vec<std::path::PathBuf> = Vec::new();

    let mut command = Command::new(&program);
    command
        .args(&bridge_args)
        .current_dir(&skills_path)
        .env("PI_CODING_AGENT_DIR", &user_pi_agent_dir())
        .env("PI_DESKTOP_APP_SKILLS_DIR", skills_path)
        .env("PI_DESKTOP_CAPABILITIES_DEFAULTS_FILE", capabilities_defaults_path)
        .env("PI_DESKTOP_RUNTIME_MODE", mode.as_str())
        .env("PI_DESKTOP_HOST", "127.0.0.1")
        .env(
            "PATH",
            bridge_path(
                &user_pi_agent_dir(),
                bundled.as_ref().map(|runtimes| runtimes.node_bin.as_path()),
                &host_path,
            )?,
        );
    if let Some(runtimes) = &bundled {
        // Only ever set in `bundled` mode: their absence is what makes the bridge leave the
        // `~/.pi/agent/bin` launchers alone and let every skill use the host's own interpreters.
        command
            .env("PI_DESKTOP_BUNDLED_PYTHON_BIN", &runtimes.python_bin)
            .env("PI_DESKTOP_BUNDLED_PYTHON_HOME", &runtimes.python_home)
            .env("PI_DESKTOP_BUNDLED_NODE_BIN", &runtimes.node_bin)
            .env("PI_DESKTOP_BUNDLED_NODE_HOME", &runtimes.node_home)
            .env("PI_DESKTOP_BUNDLED_NPM_CLI", &runtimes.npm_cli);
    }

    // Packages that spawn their own Node child (pi-subagents' detached runner is one) cannot
    // resolve the SDK from where they are installed; hand them the copy this bridge runs on. An
    // inherited value wins, so a deliberate override (launchctl, a wrapper, a custom SDK checkout)
    // is never clobbered. Mirrors `hostPiPackageRootEnv` in src-electron/sidecar.js.
    if std::env::var(PI_HOST_PACKAGE_ROOT_ENV)
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        if let Some(root) = host_pi_package_root(app) {
            command.env(PI_HOST_PACKAGE_ROOT_ENV, root);
        }
    }

    // The bridge owns its port (preferred 6474, otherwise any free one) and announces the result
    // on stdout; pinning a number here is what made a busy port an empty window. The webview is
    // told through the same global the Electron preload sets.
    command.stdout(Stdio::piped());
    #[cfg(windows)]
    command
        .env("PI_DESKTOP_PI_CLI_RUNTIME", &program)
        .env("PI_DESKTOP_PI_CLI_ENTRY", &bridge_entry);
    #[cfg(not(windows))]
    command.env("PI_DESKTOP_PI_CLI_BINARY", &sidecar_path);

    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Bundled bridge has no stdout, so it cannot announce its port")?;
    let url = await_bridge_url(stdout)?;

    Ok((child, url))
}

/// 读桥的 stdout 直到它公告地址。拿到之后线程继续抽干：不抽干会把桥堵死（管道背压），
/// 直接把日志吞掉则会让人以为桥卡住了，所以逐行转到 stderr。
fn await_bridge_url(stdout: std::process::ChildStdout) -> Result<String, Box<dyn std::error::Error>> {
    use std::io::BufRead;

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut announced = false;
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            eprintln!("[bridge] {line}");
            if announced {
                continue;
            }
            let Some(rest) = line.split("PI_DESKTOP_BRIDGE_URL=").nth(1) else {
                continue;
            };
            let url = rest.split_whitespace().next().unwrap_or("");
            if !url.is_empty() {
                announced = true;
                let _ = tx.send(url.to_owned());
            }
        }
    });

    rx.recv_timeout(std::time::Duration::from_secs(60)).map_err(|error| {
        format!("Bundled bridge never announced its address on stdout (60s timeout, {error}); it probably failed to start").into()
    })
}

fn bundled_python_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    let candidates = [
        (
            "python-runtime/Versions/3.13/bin/python3.13",
            "python-runtime/Versions/3.13",
        ),
        ("python-runtime/bin/python3.13", "python-runtime"),
    ];
    #[cfg(not(target_os = "macos"))]
    let candidates = [(BUNDLED_PYTHON_BIN, BUNDLED_PYTHON_HOME)];

    for (bin, home) in candidates {
        let bin_path = app.path().resolve(bin, BaseDirectory::Resource)?;
        if bin_path.is_file() {
            return Ok((bin_path, app.path().resolve(home, BaseDirectory::Resource)?));
        }
    }

    Err("Bundled Python runtime is missing its executable".into())
}

/// pi-subagents' own override for "which pi-coding-agent copy is the host". Its detached runner is
/// a plain Node process under `~/.pi/agent/npm/node_modules`, so ESM lookup only walks parent
/// directories and can never reach the copy inside the app bundle; the package expects the host to
/// hand the path over, and refuses to fall back to an extension-owned copy on purpose.
const PI_HOST_PACKAGE_ROOT_ENV: &str = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
const PI_CODING_AGENT_PACKAGE: &str = "@earendil-works/pi-coding-agent";

/// Where this bundle's own SDK lives, verified by manifest so a bundle whose bridge dependencies
/// were pruned yields `None` and the variable is left unset instead of sending a package to a path
/// that fails with a confusing "does not provide" error.
/// Mirrors `hostPiPackageRoot` in src-electron/sidecar.js.
fn host_pi_package_root(app: &AppHandle) -> Option<PathBuf> {
    let dir = app
        .path()
        .resolve(
            "bridge/node_modules/@earendil-works/pi-coding-agent",
            BaseDirectory::Resource,
        )
        .ok()?;
    let manifest = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&manifest).ok()?;
    if parsed.get("name").and_then(|name| name.as_str()) == Some(PI_CODING_AGENT_PACKAGE) {
        Some(dir)
    } else {
        None
    }
}

/// Shown to the user when a slim install cannot find Node. The Electron shell reports the same
/// situation through `reportStartupFailure`, so both hosts say the same thing.
const NODE_MISSING_MESSAGE: &str = "找不到 Node.js。精简版不带内嵌运行时，需要先安装 Node.js 22 或更高版本（https://nodejs.org），\
并确保它在 PATH 里（用 nvm / Homebrew 装的也可以）。装好后重新启动 Pi Desktop。";

/// Which runtime source the host must use. Mirrors `resolveRuntimeMode` in src-electron/paths.js:
/// the env var wins when set, otherwise the presence of the shipped runtimes decides. Inferring
/// rather than baking the mode into the artifact means the packaging config and the running app
/// read the same fact and cannot disagree.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RuntimeMode {
    Bundled,
    System,
}

impl RuntimeMode {
    fn as_str(self) -> &'static str {
        match self {
            RuntimeMode::Bundled => "bundled",
            RuntimeMode::System => "system",
        }
    }
}

/// The runtimes a bundled build ships. Absent in the slim mode, where they come from the machine.
struct BundledRuntimes {
    python_bin: PathBuf,
    python_home: PathBuf,
    node_bin: PathBuf,
    node_home: PathBuf,
    npm_cli: PathBuf,
}

fn runtime_mode(app: &AppHandle) -> RuntimeMode {
    match std::env::var("PI_DESKTOP_RUNTIME_MODE") {
        Ok(value) if value.trim().eq_ignore_ascii_case("system") => return RuntimeMode::System,
        Ok(value) if value.trim().eq_ignore_ascii_case("bundled") => return RuntimeMode::Bundled,
        _ => {}
    }

    let node_shipped = app
        .path()
        .resolve(BUNDLED_NODE_BIN, BaseDirectory::Resource)
        .map(|path| path.is_file())
        .unwrap_or(false);
    if node_shipped && bundled_python_paths(app).is_ok() {
        RuntimeMode::Bundled
    } else {
        RuntimeMode::System
    }
}

/// PATH handed to the bridge, and through it to every skill.
///
/// A GUI app does not inherit a login shell's PATH, so anything installed outside the bundle -
/// `/opt/homebrew/bin`, `~/.local/bin`, or a Node from nvm / pyenv - is invisible to it. Reading
/// the login shell's PATH back is the only way to find those, and how much of the shell to ask for
/// depends on the mode:
///
/// - `system` mode needs the machine's own Node, which for nvm / pyenv / asdf users only exists in
///   the interactive rc files - but those files are also what makes the read cost real time
///   (`nvm use` in `.zshrc` alone can dominate startup), so it is skipped as soon as the current
///   PATH resolves a Node.
/// - `bundled` mode ships its own Node and Python, so the interactive files would add nothing the
///   app needs while still costing their full price. A non-interactive login shell is enough for
///   the profile-level installs the user's own CLIs come from.
///
/// `PI_DESKTOP_HOST_PATH` overrides the result in both modes.
fn system_host_path(mode: RuntimeMode) -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    if let Ok(explicit) = std::env::var("PI_DESKTOP_HOST_PATH") {
        let explicit = explicit.trim().to_owned();
        if !explicit.is_empty() {
            return explicit;
        }
    }
    let interactive = mode == RuntimeMode::System;
    if interactive && resolve_node_on_path(&current).is_some() {
        return current;
    }
    match login_shell_path(interactive) {
        Some(from_shell) => prepend_missing_paths(&from_shell, &current),
        None => current,
    }
}

/// The shell flag the readback uses. Mirrors the argument in `paths.js`.
#[cfg(not(windows))]
fn login_shell_flag(interactive: bool) -> &'static str {
    if interactive {
        "-lic"
    } else {
        "-lc"
    }
}

/// The PATH a login shell reports, or `None` when it cannot be read. Windows has no equivalent.
#[cfg(not(windows))]
fn login_shell_path(interactive: bool) -> Option<String> {
    const MARKER: &str = "__PI_DESKTOP_LOGIN_PATH__";

    let shell = std::env::var("SHELL")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_owned());
    if !Path::new(&shell).is_file() {
        return None;
    }

    // `-i` is the caller's choice, not a default: see `system_host_path`. Those rc files may
    // print banners, so the value is fished out by marker instead of trusting stdout. No timeout
    // is available on a blocking `Command`; a shell that hangs on `-i` would already break every
    // terminal the user opens.
    let output = Command::new(&shell)
        .arg(login_shell_flag(interactive))
        .arg(format!("printf '%s%s' '{MARKER}' \"$PATH\""))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let index = stdout.rfind(MARKER)?;
    let value = stdout[index + MARKER.len()..]
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// First `node` on a PATH value, or `None`. Existence only - the version is the bridge's problem.
fn resolve_node_on_path(path: &str) -> Option<PathBuf> {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    for dir in std::env::split_paths(&OsString::from(path)) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(executable);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// `first`'s entries followed by whatever `second` adds, without duplicates.
fn prepend_missing_paths(first: &str, second: &str) -> String {
    let mut seen: std::collections::HashSet<OsString> = std::collections::HashSet::new();
    let mut paths: Vec<PathBuf> = Vec::new();
    for value in std::env::split_paths(&OsString::from(first))
        .chain(std::env::split_paths(&OsString::from(second)))
    {
        if value.as_os_str().is_empty() || !seen.insert(value.as_os_str().to_owned()) {
            continue;
        }
        paths.push(value);
    }
    std::env::join_paths(paths)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| second.to_owned())
}

fn bridge_path(
    agent_dir: &Path,
    node_bin: Option<&Path>,
    host_path: &str,
) -> Result<OsString, Box<dyn std::error::Error>> {
    let mut paths = vec![agent_dir.join("bin")];
    if let Some(node_bin) = node_bin {
        paths.push(
            node_bin
                .parent()
                .ok_or("Bundled Node executable has no parent directory")?
                .to_path_buf(),
        );
    }
    paths.extend(std::env::split_paths(&OsString::from(host_path)));
    Ok(std::env::join_paths(paths)?)
}

fn user_pi_agent_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join(".pi").join("agent"))
        .unwrap_or_else(|| PathBuf::from(".pi").join("agent"))
}

fn stop_bridge(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }

    let bridge = app.state::<BridgeSidecar>();
    if let Ok(mut child) = bridge.0.lock() {
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
        }
    };
}

#[cfg(test)]
mod tests {
    use super::{is_openable_target, turn_notification_text};

    #[test]
    fn accepts_local_paths_and_supported_links() {
        assert!(is_openable_target("/tmp/file.pdf"));
        assert!(is_openable_target(r"\\server\share\file.pdf"));
        assert!(is_openable_target("https://example.com/document"));
        assert!(is_openable_target("mailto:hello@example.com"));
    }

    #[cfg(not(windows))]
    #[test]
    fn bundled_mode_asks_a_non_interactive_login_shell() {
        use super::login_shell_flag;

        assert_eq!(
            login_shell_flag(true),
            "-lic",
            "system mode needs a Node that only the interactive rc files export"
        );
        assert_eq!(
            login_shell_flag(false),
            "-lc",
            "bundled mode ships its runtimes and must not pay for `.zshrc`"
        );
    }

    #[test]
    fn notification_text_defaults_the_title_and_trims_both() {
        assert_eq!(
            turn_notification_text("", "  body  "),
            ("Pi Desktop".to_owned(), "body".to_owned())
        );
        assert_eq!(
            turn_notification_text("  Done  ", ""),
            ("Done".to_owned(), String::new())
        );
    }

    #[test]
    fn rejects_unsafe_or_relative_targets() {
        assert!(!is_openable_target("../file.pdf"));
        assert!(!is_openable_target("javascript:alert(1)"));
        assert!(!is_openable_target("file:///tmp/file.pdf"));
    }
}
