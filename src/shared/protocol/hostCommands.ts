/**
 * Shell protocol: the commands the renderer may ask its host window to perform
 * (boundary `shell` in `docs/architecture/protocols.md`).
 *
 * Pi Desktop deliberately runs one renderer bundle on two shells - Tauri (Rust) and Electron -
 * and keeps `dist/` identical between them by making the renderer speak exactly one entry
 * point: `invoke(command, args)`, the Tauri shape, which `src-electron/preload.js` implements
 * on top of `ipcRenderer`. That is the whole trick, and this file is the **list** that makes
 * it safe: the Electron preload refuses anything not in it, so a renderer built against the
 * Tauri shell cannot ask Electron for an operation it never implemented.
 *
 * Why this file exists rather than a `Set` inside the preload:
 *
 * - the ids were duplicated in three places (preload whitelist, `host-commands.js` handlers,
 *   renderer call sites) with nothing comparing them, so a rename or an addition could land
 *   on one side only;
 * - swapping a shell, or adding a third host, is supposed to be a **transport** change, not a
 *   call-site change: renderers go through `src/lib/shell/host.ts`, which is typed by this
 *   contract.
 *
 * The preload is CommonJS and ships as plain `.js` (it is injected, not bundled), so it cannot
 * import this module. The two are pinned to agree by `tests/architecture.test.ts`, which
 * parses the preload whitelist and every `invoke(...)` call site against `HOST_COMMAND_IDS`.
 */
export interface HostCommandSpec {
  /** What the args object may carry, in the shell's own words. */
  readonly args: string;
  /** What the renderer gets back. `void` = fire and forget. */
  readonly returns: string;
  /** One line: when the renderer asks for this. */
  readonly summary: string;
}

export const HOST_COMMANDS = {
  choose_project_folder: {
    args: "{ defaultPath?: string }",
    returns: "string | null",
    summary: "Native folder picker for adding a project.",
  },
  choose_skill_folder: {
    args: "{ defaultPath?: string }",
    returns: "string | null",
    summary: "Native folder picker when importing a skill from disk.",
  },
  open_target: {
    args: "{ target: string }",
    returns: "void",
    summary: "Open a path or URL with the OS default handler.",
  },
  start_window_drag: {
    args: "{}",
    returns: "void",
    summary: "Begin a frameless-window drag from a custom title bar.",
  },
  toggle_window_maximize: {
    args: "{}",
    returns: "void",
    summary: "Maximize / restore the window.",
  },
  minimize_window: {
    args: "{}",
    returns: "void",
    summary: "Minimize the window.",
  },
  close_window: {
    args: "{}",
    returns: "void",
    summary: "Close the window.",
  },
  set_window_appearance: {
    args: "{ appearance: string }",
    returns: "void",
    summary: "Tell the shell which colour scheme to paint window chrome with.",
  },
  notify_turn_complete: {
    args: "{ title: string; body?: string }",
    returns: "void",
    summary: "Raise a system notification when a turn finished while unfocused.",
  },
} as const satisfies Record<string, HostCommandSpec>;

export type HostCommandId = keyof typeof HOST_COMMANDS;

/** Runtime list, in the same order as the preload whitelist, for triangulation checks. */
export const HOST_COMMAND_IDS = Object.keys(HOST_COMMANDS) as readonly HostCommandId[];

export function isHostCommandId(value: unknown): value is HostCommandId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(HOST_COMMANDS, value);
}
/** Arguments a host command may carry. Opaque on purpose: each command documents its own shape. */
export type HostCommandArgs = Record<string, unknown>;

/**
 * The shell as the renderer sees it: one method, `invoke`, exactly the shape Tauri exposes and
 * `src-electron/preload.js` implements over `ipcRenderer`.
 *
 * This interface is what makes the shell **replaceable**: `src/lib/shell/host.ts` holds the
 * current implementation and `setHostShell()` swaps it, so a second host (or a fake in a test)
 * is installed in one place while the 12 call sites in `App.tsx` and friends never change. Before
 * this existed, `invokeHost()` called `@tauri-apps/api/core` directly at module scope and there was
 * no way to install anything else.
 */
export interface HostShell {
  invoke<T = unknown>(command: HostCommandId, args?: HostCommandArgs): Promise<T>;
}
