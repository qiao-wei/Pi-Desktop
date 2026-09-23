"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Renderer-side contract: src/app/App.tsx and src/lib/open-target.ts talk to the
// shell through `@tauri-apps/api/core`'s `invoke()`, which is a one-liner over
// `window.__TAURI_INTERNALS__.invoke(cmd, args, options)`. Implementing that
// single entry point keeps `dist/` identical between the two shells.
const HOST_COMMANDS = new Set([
  "choose_project_folder",
  "choose_skill_folder",
  "open_target",
  "start_window_drag",
  "toggle_window_maximize",
  "minimize_window",
  "close_window",
  "notify_turn_complete",
]);

// `invoke("choose_project_folder", { defaultPath: undefined })` is valid Tauri
// usage; Electron's structured clone handles undefined but the argument is
// dropped to match the "no hint" path in the handler.
function sanitizeArgs(args) {
  if (!args || typeof args !== "object") {
    return {};
  }

  const result = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

// Dropped-folder support: the renderer is sandboxed, so the only place `webUtils`
// is reachable is this preload. `getPathForFile` throws on anything that is not a
// real on-disk File; both that and an empty result mean "no path" to the renderer,
// which then falls back to the entry name only.
contextBridge.exposeInMainWorld("__PI_DESKTOP_FILES__", {
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
});

// The main process passes the bridge address the moment it learns it; the renderer reads it
// instead of assuming a port.
const API_BASE_FLAG = "--pi-desktop-api-base=";
const apiBaseArg = process.argv.find((arg) => arg.startsWith(API_BASE_FLAG));
if (apiBaseArg) {
  contextBridge.exposeInMainWorld("__PI_DESKTOP_API_BASE__", apiBaseArg.slice(API_BASE_FLAG.length));
}

contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", {
  invoke(command, args) {
    if (typeof command !== "string" || !HOST_COMMANDS.has(command)) {
      return Promise.reject(new Error(`Unsupported host command: ${String(command)}`));
    }

    return ipcRenderer.invoke(command, sanitizeArgs(args)).catch((error) => {
      // Electron prefixes handler rejections with the ipc channel name; Tauri
      // hands the renderer the raw error string, and the UI shows it verbatim
      // (project/skill picker errors, open-target errors).
      const message = String(error?.message ?? error).replace(
        /^Error invoking remote method '[^']+':\s*(Error:\s*)?/,
        "",
      );
      throw new Error(message);
    });
  },
  // Tauri uses these for streaming channels (Callback ID round-trips). Pi Desktop
  // only calls plain request/response commands through the shell, so anything
  // that needs them has to grow a real bridge first.
  transformCallback() {
    throw new Error("Streaming channels are not wired up in the Electron host yet.");
  },
  unregisterCallback() {
    return undefined;
  },
  convertFileSrc() {
    throw new Error("convertFileSrc is not available in the Electron host.");
  },
});
