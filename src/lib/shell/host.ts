/**
 * Boundary `shell`, renderer side: the only place the UI asks its host window for something.
 *
 * The renderer runs unchanged on Tauri and Electron because both spell the same call
 * (`invoke(command, args)`) - Electron's preload implements the Tauri shape over
 * `ipcRenderer`. That trick only stays safe if call sites cannot invent a command name, so
 * every call goes through here and this function is typed by `HOST_COMMANDS`
 * (`src/shared/protocol/hostCommands.ts`).
 *
 * Swapping a host, or adding a third one, is a change **here** plus the preload whitelist - never
 * a change in a component:
 *
 *     setHostShell({ invoke: (command, args) => myHost.call(command, args) });
 *
 * `getHostShell()` returns whatever is installed; the default is the Tauri/Electron `invoke`.
 * `tests/hostShell.test.ts` installs a recording fake and drives the real call sites through it,
 * which is the only thing that proves this seam is a seam rather than a comment.
 */

import { invoke } from "@tauri-apps/api/core";
import type { HostCommandArgs, HostCommandId, HostShell } from "../../shared/protocol/hostCommands.ts";

/** The real thing: Tauri's `invoke`, which Electron's preload re-implements. */
function tauriShell(): HostShell {
  return {
    invoke: <T = unknown>(command: HostCommandId, args?: HostCommandArgs) => invoke(command, args) as Promise<T>,
  };
}

/**
 * The default: a Tauri/Electron shell when a host injected `__TAURI_INTERNALS__`, otherwise null.
 *
 * "Is there a host?" is part of this protocol, not a `"__TAURI_INTERNALS__" in window` sniff spread
 * over the callers. Two of them did that sniff themselves (`systemNotification`, `open-target`), which
 * meant a second implementation of the same question - and the question has a right answer the moment
 * a fake shell is installed, which is exactly what the swap test needs.
 */
function defaultShell(): HostShell | null {
  if (typeof window === "undefined") return null;
  return "__TAURI_INTERNALS__" in window ? tauriShell() : null;
}

/**
 * `undefined` = nobody installed anything, so the default is asked for **at call time**.
 *
 * The default must not be snapshotted at module load: a host injects `__TAURI_INTERNALS__` before the
 * bundle runs in production, but a test (or a host that loads its bridge later) installs it after this
 * module is imported - and an eager snapshot then answers "no host" forever. That mistake was caught by
 * `tests/shellAppearance.test.ts`, which stubs `window.__TAURI_INTERNALS__` after import.
 */
let installed: HostShell | null | undefined;

/** The current shell, or null in a plain browser (vite 直接打开 / web 变体). */
export function getHostShell(): HostShell | null {
  return installed === undefined ? defaultShell() : installed;
}

/** Whether a host is available at all. Callers that need one ask this instead of sniffing globals. */
export function hasHostShell(): boolean {
  return getHostShell() !== null;
}

/**
 * Install a different host (a second shell, or a test double).
 * Pass `null` to install *no* host (plain browser), `undefined` to go back to the default.
 */
export function setHostShell(next: HostShell | null | undefined): void {
  installed = next;
}

/**
 * Ask the host to perform a shell-level command. Rejects if the host does not implement it
 * (Electron's preload refuses anything outside the declared protocol).
 */
export async function invokeHost<T = unknown>(command: HostCommandId, args?: HostCommandArgs): Promise<T> {
  const shell = getHostShell();
  if (!shell) {
    throw new Error(`no host shell installed; cannot invoke ${command}`);
  }
  return shell.invoke<T>(command, args);
}

/** Fire-and-forget variant for UI chrome (window drag, minimize, notifications). */
export function invokeHostQuietly(command: HostCommandId, args?: HostCommandArgs): void {
  void invokeHost(command, args).catch(() => undefined);
}
