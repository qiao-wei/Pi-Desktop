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

/** Used when a host does not name itself; only ever surfaces in diagnostics. */
export const DEFAULT_HOST_ID = "host";

/**
 * Features a host can have that are **not** a single command.
 *
 * Commands are verbs ("open a folder", "notify"); capabilities are the ground a whole feature
 * needs in order to exist at all. "Can this shell render a native guest view?" is not a verb a
 * caller invokes - it is the precondition for drawing a browser pane in the first place.
 *
 * Kept deliberately tiny: anything that is one call should be a command, and anything that is
 * per-URL policy should be ordinary code, not a capability bit.
 */
export const HOST_CAPABILITIES = ["embedded_browser"] as const;

export type HostCapability = (typeof HOST_CAPABILITIES)[number];

export function isHostCapability(value: unknown): value is HostCapability {
  return typeof value === "string" && (HOST_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Resolve a host's declared capabilities.
 *
 * Unlike {@link normalizeHostCommands}, **absence means none**: a command list can default to
 * "the whole surface" because the built-in shim really does implement it, but a capability
 * unlocks an entire feature surface. Defaulting that to on would make the declaration
 * meaningless and turn "should this UI exist?" back into a guess.
 *
 * Unknown values are dropped for the same forward-compatibility reason as commands.
 */
export function normalizeHostCapabilities(declared?: readonly string[]): readonly HostCapability[] {
  if (!declared) {
    return [];
  }
  return [...new Set(declared.filter(isHostCapability))];
}

/**
 * An **端 profile**: which host this is, and which commands it actually implements.
 *
 * Why a profile instead of `hasHostShell(): boolean`: "does a host exist" and "can this host do
 * X" are different questions, and only the second one may decide UI. A browser host that can
 * open links but has no folder picker must not make the UI render a picker it cannot honour, and
 * a fully capable host must not be asked to `try/catch` its way to an answer.
 *
 * The declaration is the single source of truth for that question: `invokeHost()` refuses an
 * undeclared command **before** the transport sees it, so a partial host fails at the seam with a
 * named command instead of deep inside a native call.
 */
export interface HostProfile {
  /** Label for diagnostics (`"tauri"`, `"electron"`, `"web"`, `"test"`…). Never used for branching. */
  readonly id: string;
  /** Commands this host implements. `HOST_COMMAND_IDS` = the whole declared surface. */
  readonly commands: readonly HostCommandId[];
  /** Feature-level ground this host provides (see {@link HOST_CAPABILITIES}). */
  readonly capabilities: readonly HostCapability[];
}

/**
 * Resolve a host's declared command list.
 *
 * - absent declaration = **the whole surface** (the built-in Tauri/Electron shim implements every
 *   command, and so does anything written before this field existed);
 * - unknown ids are dropped rather than thrown: a renderer newer than its host must degrade to
 *   "that command is unsupported", not crash at startup.
 */
export function normalizeHostCommands(declared?: readonly string[]): readonly HostCommandId[] {
  if (!declared) {
    return HOST_COMMAND_IDS;
  }
  return [...new Set(declared.filter(isHostCommandId))];
}

/** The capability question, as a pure function so it is testable without any host at all. */
export function hostProfileSupports(profile: HostProfile | null | undefined, command: HostCommandId): boolean {
  return profile !== null && profile !== undefined && profile.commands.includes(command);
}

/** The feature-level question. False for a missing profile, like {@link hostProfileSupports}. */
export function hostProfileSupportsCapability(
  profile: HostProfile | null | undefined,
  capability: HostCapability,
): boolean {
  return profile !== null && profile !== undefined && profile.capabilities.includes(capability);
}

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
  /** Optional label for diagnostics; see {@link HostProfile.id}. */
  readonly id?: string;
  /**
   * Commands this host implements. Absent = all of them.
   *
   * Electron's preload is the runtime authority for the commands it will serve (it refuses
   * anything outside `HOST_COMMAND_IDS`); this field is how a *different* host - a browser, a
   * headless runner, a test double - states its subset up front so the UI never offers what it
   * cannot do.
   */
  readonly commands?: readonly HostCommandId[];
  /**
   * Feature-level ground this host provides; absent = none. See {@link HOST_CAPABILITIES}.
   *
   * This is where a shell says "I can host a guest view" instead of the renderer probing for a
   * DOM element that may never upgrade.
   */
  readonly capabilities?: readonly HostCapability[];
  invoke<T = unknown>(command: HostCommandId, args?: HostCommandArgs): Promise<T>;
}
