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
import type {
  HostCapability,
  HostCommandArgs,
  HostCommandId,
  HostProfile,
  HostShell,
} from "../../shared/protocol/hostCommands.ts";
import {
  DEFAULT_HOST_ID,
  hostProfileSupports,
  hostProfileSupportsCapability,
  normalizeHostCapabilities,
  normalizeHostCommands,
} from "../../shared/protocol/hostCommands.ts";

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
 *
 * The shell may also **declare its end profile** (`__PI_HOST_PROFILE__`, written by
 * `src-electron/preload.js`): which host it is and which feature-level ground it provides. The
 * renderer reads that declaration instead of sniffing for Electron - Electron's preload deliberately
 * imitates Tauri, so sniffing could not tell them apart anyway.
 */
const HOST_PROFILE_KEY = "__PI_HOST_PROFILE__";

interface DeclaredHostProfile {
  readonly id?: unknown;
  readonly capabilities?: readonly unknown[];
}

function declaredProfile(): DeclaredHostProfile {
  const declared = (window as unknown as Record<string, unknown>)[HOST_PROFILE_KEY];
  return declared !== null && typeof declared === "object" ? (declared as DeclaredHostProfile) : {};
}

function defaultShell(): HostShell | null {
  if (typeof window === "undefined") return null;
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const declared = declaredProfile();
  return {
    ...tauriShell(),
    ...(typeof declared.id === "string" ? { id: declared.id } : {}),
    ...(declared.capabilities ? { capabilities: normalizeHostCapabilities(declared.capabilities as string[]) } : {}),
  };
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

function profileOf(shell: HostShell): HostProfile {
  return {
    id: shell.id?.trim() || DEFAULT_HOST_ID,
    commands: normalizeHostCommands(shell.commands),
    capabilities: normalizeHostCapabilities(shell.capabilities),
  };
}

/**
 * The current host's profile, or null when there is no host.
 *
 * This is the **capability** answer, and the one UI should branch on: `hasHostShell()` says a host
 * exists, `supportsHostCommand(id)` says this host can actually do the thing. A browser host that
 * can open links but has no native folder picker is the case that makes the difference visible.
 */
export function getHostProfile(): HostProfile | null {
  const shell = getHostShell();
  return shell ? profileOf(shell) : null;
}

/** Can the current host perform `command`? False when there is no host at all. */
export function supportsHostCommand(command: HostCommandId): boolean {
  const shell = getHostShell();
  return shell ? hostProfileSupports(profileOf(shell), command) : false;
}

/**
 * Does the current host provide `capability`?
 *
 * Ask this **before rendering** a feature that needs host ground (an embedded browser view, a
 * tray…) - a host that did not declare it has no way to honour it.
 */
export function supportsHostCapability(capability: HostCapability): boolean {
  const shell = getHostShell();
  return shell ? hostProfileSupportsCapability(profileOf(shell), capability) : false;
}

/**
 * Install a different host (a second shell, or a test double).
 * Pass `null` to install *no* host (plain browser), `undefined` to go back to the default.
 */
export function setHostShell(next: HostShell | null | undefined): void {
  installed = next;
}

/**
 * Ask the host to perform a shell-level command. Rejects if the host does not implement it.
 *
 * Two distinct refusals, deliberately worded differently because they mean different things:
 *
 * - `no host shell installed` - there is no host at all (plain browser);
 * - `host "x" does not implement "y"` - there **is** a host, and it declared a narrower surface.
 *   This fires before `invoke()` is reached, so the failure is a named capability gap rather than
 *   whatever the native side happens to do with an unknown command.
 *
 * Electron's preload refuses anything outside the declared protocol as a second line of defence.
 */
export async function invokeHost<T = unknown>(command: HostCommandId, args?: HostCommandArgs): Promise<T> {
  const shell = getHostShell();
  if (!shell) {
    throw new Error(`no host shell installed; cannot invoke ${command}`);
  }
  const profile = profileOf(shell);
  if (!hostProfileSupports(profile, command)) {
    throw new Error(`host "${profile.id}" does not implement "${command}"`);
  }
  return shell.invoke<T>(command, args);
}

/** Fire-and-forget variant for UI chrome (window drag, minimize, notifications). */
export function invokeHostQuietly(command: HostCommandId, args?: HostCommandArgs): void {
  void invokeHost(command, args).catch(() => undefined);
}
