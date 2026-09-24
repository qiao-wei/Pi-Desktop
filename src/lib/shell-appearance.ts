import { invoke } from "@tauri-apps/api/core";

import { hasShellBridge } from "./systemNotification.ts";

export type ShellAppearance = "light" | "dark";

/**
 * 把界面的浅色/深色同步给宿主窗口。
 *
 * 为什么需要：macOS 上原生侧栏材质（Electron 的 `vibrancy: "sidebar"`、Tauri 的
 * `Effect::Sidebar`）的明暗**只跟随窗口/系统的 NSAppearance**，而我们的浅色/深色是
 * 渲染层自己的（`<html class="dark">`，见 App.tsx 的主题 effect）。不同步就会出现
 * 「系统浅色 + 界面深色」——一层发白的玻璃垫在深色侧栏下面（白字落在浅灰板上），
 * 反过来同理。这个偏差不是配色问题，改 token 改不掉。
 *
 * 宿主侧：Electron 见 `src-electron/host-commands.js` 的 `set_window_appearance`
 * （改 `nativeTheme.themeSource`，Electron 会一并改 `NSApp.appearance`）；Tauri 见
 * `src-tauri/src/lib.rs` 的同名命令（`Window::set_theme`）。
 */
export function syncShellAppearance(theme: ShellAppearance): void {
  // 纯浏览器（vite 直开 / web 变体）里没有 `__TAURI_INTERNALS__`，`invoke` 会同步抛。
  if (!hasShellBridge()) {
    return;
  }

  // 同步失败只影响原生材质的明暗，不该把渲染层拖下水（renderer 里的主题已经生效了）。
  void invoke("set_window_appearance", { appearance: theme }).catch(() => undefined);
}