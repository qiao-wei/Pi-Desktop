/**
 * Guard for "the packaged app opens nothing at all".
 *
 * The shell used to call `app.dock.setIcon()` with a repo-relative png at the top
 * of the `whenReady()` callback. A packaged build cannot see that file (the asar
 * ships only `*.js` + `package.json`), Electron throws
 * `Failed to load image from path '...'`, the callback had no catch, and the
 * unhandled rejection took `buildMenu()` / `registerHostCommands()` /
 * `startBridge()` / `createWindow()` down with it — a windowless process that
 * looked like the app closed itself.
 *
 * Two contracts, both behavioural (electron / sidecar / static server are stubbed
 * through Module._load while the *real* src-electron/main.js is executed):
 *   1. decorative code must never sit on the road to createWindow();
 *   2. whatever does throw before the window exists must be reported (dialog +
 *      quit) instead of leaving a zombie.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { dockIconPath } from "../src-electron/paths.js";

const require = createRequire(import.meta.url);

const MAIN_MODULE = require.resolve("../src-electron/main.js");
const SIDECAR_MODULE = require.resolve("../src-electron/sidecar.js");
const STATIC_SERVER_MODULE = require.resolve("../src-electron/static-server.js");
const SHELL_MODULES = [
  MAIN_MODULE,
  SIDECAR_MODULE,
  STATIC_SERVER_MODULE,
  require.resolve("../src-electron/paths.js"),
  require.resolve("../src-electron/host-commands.js"),
  require.resolve("../src-electron/host-policy.js"),
];

const BUNDLE_ROOT = join(dirname(MAIN_MODULE), "..", "fake-app", "Contents", "Resources");

type Scenario = {
  isPackaged: boolean;
  // Which icon paths the fake native layer refuses to load.
  rejectIcon?: (iconPath: string) => boolean;
  throwOnIpcHandle?: boolean;
};

type Startup = {
  windows: number;
  errorBoxes: string[];
  warnings: string[];
  quit: number;
  bridgeStarted: number;
  iconCalls: string[];
  loadedUrls: string[];
  setPaths: Array<[string, string]>;
};

async function runStartup(scenario: Scenario): Promise<Startup> {
  const result: Startup = {
    windows: 0,
    errorBoxes: [],
    warnings: [],
    quit: 0,
    bridgeStarted: 0,
    iconCalls: [],
    loadedUrls: [],
    setPaths: [],
  };

  // Mirrors how a packaged bundle looks to the shell: nothing outside
  // `<resources>` / the asar exists, so any repo path fails to load.
  const rejectsIcon =
    scenario.rejectIcon ??
    ((iconPath: string) => (scenario.isPackaged ? !iconPath.startsWith(BUNDLE_ROOT) : false));

  class FakeBrowserWindow {
    static windows: FakeBrowserWindow[] = [];
    static getAllWindows() {
      return FakeBrowserWindow.windows;
    }
    static fromWebContents() {
      return FakeBrowserWindow.windows[0];
    }
    webContents = {
      on: () => {},
      once: () => {},
      setWindowOpenHandler: () => {},
      loadURL: () => Promise.resolve(),
      openDevTools: () => {},
    };
    constructor(_options: unknown) {
      result.windows += 1;
      FakeBrowserWindow.windows.push(this);
    }
    on() {}
    once() {}
    show() {}
    loadURL = (url: string) => {
      result.loadedUrls.push(url);
      return Promise.resolve();
    };
  }

  const app = {
    isPackaged: scenario.isPackaged,
    name: "Pi Desktop",
    whenReady: () => Promise.resolve(),
    quit: () => {
      result.quit += 1;
    },
    on: () => {},
    commandLine: { appendSwitch: () => {} },
    getPath: (name: string) => `/fake/${name}`,
    setPath: (name: string, value: string) => {
      result.setPaths.push([name, value]);
    },
    dock: {
      setIcon: (iconPath: string) => {
        result.iconCalls.push(iconPath);
        if (rejectsIcon(iconPath)) {
          throw new Error(`Failed to load image from path '${iconPath}'`);
        }
      },
    },
  };

  const electronFake = {
    app,
    BrowserWindow: FakeBrowserWindow,
    Menu: {
      buildFromTemplate: (template: unknown) => ({ template }),
      setApplicationMenu: () => {},
    },
    dialog: {
      showErrorBox: (_title: string, message: string) => {
        result.errorBoxes.push(message);
      },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    shell: {
      openExternal: async () => {},
      openPath: async () => "",
    },
    ipcMain: {
      handle: () => {
        if (scenario.throwOnIpcHandle) {
          throw new Error("ipc handler already registered");
        }
      },
    },
    protocol: {
      registerSchemesAsPrivileged: () => {},
      handle: () => {},
    },
  };

  const sidecarFake = {
    BRIDGE_HOST: "127.0.0.1",
    BRIDGE_PORT: 6474,
    bridgeEnv: () => ({ env: {}, cwd: "" }),
    startBridge: () => {
      result.bridgeStarted += 1;
      return { stdout: null, stderr: null, on: () => {}, kill: () => {}, killed: false, exitCode: null };
    },
    stopBridge: () => {},
    waitForBridge: async () => true,
  };

  const staticServerFake = {
    RENDERER_URL: "app://pi-desktop/index.html",
    registerRendererProtocol: () => {},
    registerRendererProtocolScheme: () => {},
  };

  const loadHooks = new Map<string, unknown>([
    ["electron", electronFake],
    [SIDECAR_MODULE, sidecarFake],
    [STATIC_SERVER_MODULE, staticServerFake],
  ]);
  const originalLoad = Module._load;
  const originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  const originalWarn = console.warn;

  (process as { resourcesPath?: string }).resourcesPath = BUNDLE_ROOT;
  console.warn = (...args: unknown[]) => {
    result.warnings.push(args.map(String).join(" "));
  };

  for (const id of SHELL_MODULES) {
    delete require.cache[id];
  }

  try {
    Module._load = function patchedLoad(this: typeof Module, request: string, parent: unknown, isMain: boolean) {
      if (request === "electron") {
        return electronFake;
      }
      if (parent && typeof (parent as Module).filename === "string") {
        try {
          const resolved = require.resolve(request, { paths: [dirname((parent as Module).filename)] });
          const stub = loadHooks.get(resolved);
          if (stub) {
            return stub;
          }
        } catch {
          // not resolvable from here — fall through to the real loader
        }
      }
      return originalLoad.call(this, request, parent, isMain);
    } as typeof Module._load;

    require(MAIN_MODULE);

    // The startup body is async (`whenReady().then(...)`), and registerHostCommands
    // requires `electron` lazily from inside it, so the hook has to stay installed
    // until the promise chain settles.
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    Module._load = originalLoad;
    console.warn = originalWarn;
    (process as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
    for (const id of SHELL_MODULES) {
      delete require.cache[id];
    }
  }

  return result;
}

test("packaged startup still creates a window when the dock icon cannot load", async () => {
  const startup = await runStartup({ isPackaged: true });

  // The whole point: the asar has no repo png, so the shell must not ask for one.
  assert.equal(startup.iconCalls.length, 0, "a packaged shell must not hand Electron a repo icon");
  assert.equal(startup.windows, 1, "createWindow() must still run");
  assert.equal(startup.bridgeStarted, 1, "startBridge() must still run");
  assert.deepEqual(startup.errorBoxes, [], "a cosmetic failure must not be a startup failure");
});

test("a packaged shell loads the renderer from the stable app:// origin", async () => {
  const startup = await runStartup({ isPackaged: true });

  // Panels/theme/locale live in localStorage, which is origin-scoped: a random
  // loopback port per launch silently reset every preference on restart.
  assert.equal(startup.loadedUrls.length, 1);
  assert.equal(startup.loadedUrls[0], "app://pi-desktop/index.html");
});

test("dev uses a private userData profile instead of the packaged app's", async () => {
  const startup = await runStartup({ isPackaged: false });

  // Two Chromium processes on one userData directory fight over
  // `Local Storage/leveldb`'s LOCK: the second process's writes stay in memory and
  // vanish on quit, so prefs reset every restart while the packaged Pi Desktop is open.
  assert.deepEqual(startup.setPaths, [["userData", "/fake/appData/Pi Desktop Dev"]]);
});

test("a packaged shell keeps the real userData directory", async () => {
  const startup = await runStartup({ isPackaged: true });

  assert.deepEqual(startup.setPaths, []);
});

test("a dock icon that Electron rejects degrades to a warning instead of a dead startup", async () => {
  // Dev layout, but the native layer rejects the file (missing/corrupt icon,
  // headless CI, ...). Startup must survive it.
  const startup = await runStartup({
    isPackaged: false,
    rejectIcon: () => true,
  });

  assert.equal(startup.windows, 1, "createWindow() must run even if setIcon throws");
  assert.deepEqual(startup.errorBoxes, []);
  assert.equal(startup.quit, 0);
  assert.match(
    startup.warnings.join("\n"),
    /dock icon not set[\s\S]*Failed to load image from path/,
    "the swallowed failure has to stay visible in the log",
  );
});

test("a startup failure before the window exists is reported, not swallowed", async () => {
  const startup = await runStartup({
    isPackaged: false,
    throwOnIpcHandle: true,
  });

  assert.equal(startup.windows, 0);
  assert.equal(startup.errorBoxes.length, 1, "reportStartupFailure() must surface the error");
  assert.match(startup.errorBoxes[0] ?? "", /ipc handler already registered/);
  assert.equal(startup.quit, 1, "and the process must not linger as a windowless zombie");
});

test("dockIconPath is packaged-safe and existence-checked", () => {
  assert.equal(dockIconPath({ isPackaged: true }), null, "packaged: never resolve a repo path");
  assert.equal(dockIconPath(undefined), null, "a missing app object must not throw");

  const dev = dockIconPath({ isPackaged: false });
  if (dev) {
    assert.match(dev, /src-tauri[\\/]icons[\\/]icon\.png$/);
  } else {
    assert.fail("the dev icon exists in this repo");
  }
});
