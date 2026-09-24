"use strict";

const { BrowserWindow, Notification, dialog, nativeTheme, shell, systemPreferences } = require("electron");

const { dialogStartingDirectory, isOpenableTarget } = require("./host-policy");
const { deliverNotification, notificationPayload } = require("./turn-notification");

// One ipc handler per #[tauri::command] in src-tauri/src/lib.rs, with the same
// command names and argument shapes, so the renderer keeps calling
// `invoke("close_window")` etc. unchanged (see preload.js for the shim).
function registerHostCommands(getWindow) {
  const { ipcMain } = require("electron");

  const folderPicker = (title) => async (_event, args) => {
    const parent = getWindow();
    const options = {
      title,
      buttonLabel: "Choose",
      properties: ["openDirectory"],
      defaultPath: dialogStartingDirectory(args?.defaultPath ?? args?.default_path),
    };

    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  };

  ipcMain.handle("choose_project_folder", folderPicker("Choose project folder"));
  ipcMain.handle("choose_skill_folder", folderPicker("Choose skill folder"));

  ipcMain.handle("open_target", async (_event, args) => {
    const target = String(args?.target ?? "").trim();
    if (!isOpenableTarget(target)) {
      throw new Error("Only local files and http, https, or mailto links can be opened.");
    }

    if (/^(https?:|mailto:)/i.test(target)) {
      await shell.openExternal(target);
      return;
    }

    const failure = await shell.openPath(target);
    if (failure) {
      throw new Error(`Unable to open ${target}: ${failure}`);
    }
  });

  // Electron has no programmatic window drag. The titlebar already carries
  // `-webkit-app-region: drag` (src/app/App.tsx), which Chromium implements
  // natively, so this command only needs to exist for parity.
  ipcMain.handle("start_window_drag", () => undefined);

  ipcMain.handle("toggle_window_maximize", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return;
    }

    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });

  ipcMain.handle("minimize_window", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle("close_window", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // 原生侧栏材质（macOS 的 `vibrancy: "sidebar"`）明暗跟随 NSAppearance/系统外观，
  // 而界面的浅色/深色是渲染层自己的（`<html class="dark">`）。不同步的话：系统浅色 +
  // 界面深色 = 一层发白的玻璃垫在深色侧栏下（白字落在浅灰板上），反过来同理。
  // 改 themeSource 会让 Electron 一并改 `NSApp.appearance`，材质就跟着主题走。
  ipcMain.handle("set_window_appearance", (_event, args) => {
    const source = themeSourceFor(args?.appearance);
    if (!source) {
      throw new Error(`Unknown appearance: ${String(args?.appearance)}`);
    }

    nativeTheme.themeSource = source;

    // macOS 的侧栏材质看的是窗口的 effective appearance，不是 themeSource 本身。
    // 把真值回给渲染层：换壳/升级 Electron 时这个值不变就说明材质明暗没跟着翻
    // （只有 macOS 有 getEffectiveAppearance，其它平台回 undefined）。
    const effectiveAppearance =
      typeof systemPreferences?.getEffectiveAppearance === "function"
        ? systemPreferences.getEffectiveAppearance()
        : undefined;

    return { applied: true, source, effectiveAppearance };
  });

  // 「任务完成后系统提醒」。返回 `{ delivered, reason }` 而不是 undefined：macOS 上
  // 未签名的开发版 show() 不报错也不显示，只有 'failed' 事件能说明真相（见 turn-notification.js）。
  ipcMain.handle("notify_turn_complete", (event, args) => {
    if (typeof Notification?.isSupported === "function" && !Notification.isSupported()) {
      return { delivered: false, reason: "unsupported" };
    }

    const { title, body } = notificationPayload(args);
    const notification = new Notification({ title, body });
    notification.on("click", () => {
      const window = BrowserWindow.fromWebContents(event.sender) ?? getWindow();
      if (!window) {
        return;
      }
      if (window.isMinimized()) {
        window.restore();
      }
      window.show();
      window.focus();
    });

    return deliverNotification(notification);
  });
}

/** 界面主题 → `nativeTheme.themeSource`；未知值返回 null（与 Tauri 侧同一口径）。 */
function themeSourceFor(appearance) {
  if (appearance === "dark") {
    return "dark";
  }

  return appearance === "light" ? "light" : null;
}

module.exports = { registerHostCommands, themeSourceFor };
