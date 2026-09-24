"use strict";

const path = require("node:path");

const { app, BrowserWindow, Menu, dialog, protocol, shell } = require("electron");

const { registerHostCommands } = require("./host-commands");
const { dockIconPath, resolveShellPaths } = require("./paths");
const { RENDERER_URL, registerRendererProtocol, registerRendererProtocolScheme } = require("./static-server");
const { startBridge, stopBridge, waitForBridge } = require("./sidecar");

// Window geometry / chrome matches `app.windows` in src-tauri/tauri.conf.json:
// borderless, transparent, 1180x780 with a 360x640 floor.
const WINDOW_OPTIONS = {
  width: 1180,
  height: 780,
  minWidth: 360,
  minHeight: 640,
  resizable: true,
  title: "Pi Desktop",
  frame: false,
  transparent: true,
  backgroundColor: "#00000000",
  // Codex-style sidebar material. On macOS the native vibrancy supplies the blur;
  // the renderer only adds a thin tint + sheen on the sidebar surface
  // (src/app/styles.css `.project-sidebar-surface`). The main pane and titlebars
  // stay opaque, which is what makes the sidebar read as glass rather than paint.
  // Other platforms have no equivalent material here, so they keep the opaque
  // shell and the `backdrop-filter` fallback.
  ...(process.platform === "darwin"
    ? { vibrancy: "sidebar", visualEffectState: "followWindow" }
    : {}),
  hasShadow: true,
  show: false,
  autoHideMenuBar: true,
  webPreferences: {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  },
};

const shellPaths = resolveShellPaths(app);

// Dev and the packaged app must not share one Chromium profile. The first process to
// open `<userData>/Local Storage/leveldb` holds its LOCK; every localStorage write made
// by the *second* process then stays in memory and is dropped on exit — which looked
// exactly like "theme / language / collapsed panels reset after every restart" while
// the packaged Pi Desktop.app was also open. Dev keeps its own stable directory, so both
// shells persist and `npm run electron:dev` can never scribble on real user state.
if (!app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "Pi Desktop Dev"));
}

let mainWindow = null;
let bridgeChild = null;
let rendererRegistered = false;
let startupReported = false;
// Discovered from the bridge's own announcement; the renderer is told about it through the
// preload, because a port baked into the bundle is how a busy 6474 became an empty window.
let bridgeApiBase = "";

// Dev mirrors Tauri's `beforeDevCommand` + `devUrl` contract: `npm run dev`
// already owns the API bridge and vite on 5176, so the shell only attaches.
const devServerUrl = process.env.PI_DESKTOP_DEV_URL?.trim() || "http://127.0.0.1:5176";

function linuxTransparentVisuals() {
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("enable-transparent-visuals");
  }
}

function buildMenu() {
  // The window is borderless, so the menu is the only home for Cmd+Q /
  // copy-paste roles; the app UI itself never renders it.
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function resolveRendererUrl() {
  if (!app.isPackaged) {
    return devServerUrl;
  }

  if (!rendererRegistered) {
    registerRendererProtocol(protocol, shellPaths.renderer);
    rendererRegistered = true;
  }

  return RENDERER_URL;
}

function windowOptions() {
  if (!bridgeApiBase) {
    return WINDOW_OPTIONS;
  }

  return {
    ...WINDOW_OPTIONS,
    webPreferences: {
      ...WINDOW_OPTIONS.webPreferences,
      additionalArguments: [...(WINDOW_OPTIONS.webPreferences.additionalArguments ?? []), `--pi-desktop-api-base=${bridgeApiBase}`],
    },
  };
}

function createWindow() {
  mainWindow = new BrowserWindow(windowOptions());

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    // -3 = ERR_ABORTED, which vite's HMR full reload emits on every edit.
    if (!isMainFrame || errorCode === -3 || startupReported) {
      return;
    }

    startupReported = true;
    const hint = app.isPackaged
      ? ""
      : "\n\n开发模式下外壳只连接 dev 服务，需要先起 vite + bridge：\n  npm run electron:dev   （自动起）\n  或先 npm run dev，再 npm run electron:dev";
    reportStartupFailure(`${errorDescription} (${errorCode}) loading '${validatedUrl}'${hint}`);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Nothing in the UI opens new windows today; anything that tries becomes an
  // external link instead of an unmanaged Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  void resolveRendererUrl()
    .then((url) => mainWindow?.loadURL(url))
    .then(() => {
      if (!app.isPackaged) {
        mainWindow?.webContents.openDevTools({ mode: "detach" });
      }
    })
    .catch((error) => {
      if (!startupReported) {
        startupReported = true;
        reportStartupFailure(error);
      }
    });
}

function setDockIcon() {
  // Cosmetic only: a missing icon must never take the window down with it.
  const icon = dockIconPath(app);
  if (!icon) {
    return;
  }

  try {
    app.dock?.setIcon(icon);
  } catch (error) {
    console.warn("[pi-desktop] dock icon not set:", error?.message ?? error);
  }
}

function reportStartupFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[pi-desktop] renderer failed to load:", message);
  dialog.showErrorBox("Pi Desktop failed to start", message);
  app.quit();
}

linuxTransparentVisuals();

// Scheme privileges must be declared before the app is ready, otherwise the renderer
// loses its stable origin (and with it localStorage persistence across restarts).
if (app.isPackaged) {
  registerRendererProtocolScheme(protocol);
}

void app.whenReady().then(async () => {
  try {
    setDockIcon();
    buildMenu();
    registerHostCommands(() => mainWindow);

    // Same rule as lib.rs (`if !cfg!(debug_assertions)`): in dev the bridge is
    // owned by `npm run dev`, in the packaged app the shell owns its lifecycle.
    if (app.isPackaged) {
      try {
        const bridge = await startBridge(shellPaths);
        bridgeChild = bridge.child;
        bridgeApiBase = await bridge.url;
      } catch (error) {
        startupReported = true;
        reportStartupFailure(error);
        return;
      }

      if (!(await waitForBridge(bridgeApiBase))) {
        console.warn("[pi-desktop] bridge is not answering /api/bootstrap yet");
      }
    }

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (error) {
    // Anything that throws before createWindow() used to leave a windowless
    // process that looked like "the app closed itself".
    if (!startupReported) {
      startupReported = true;
      reportStartupFailure(error);
    }
  }
});

app.on("window-all-closed", () => {
  // Pi Desktop has no tray and no background mode, so the app exits with its last
  // window (this is what triggers RunEvent::Exit → stop_bridge in Tauri).
  app.quit();
});

app.on("before-quit", () => {
  stopBridge(bridgeChild);
  bridgeChild = null;
});
