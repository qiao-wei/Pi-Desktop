/**
 * What the composer strip says about a built-in command (`/reload`, ...).
 *
 * Built-in commands are host-side operations: they reload or reconfigure the
 * session and emit **nothing** into the transcript. Silence there reads as a
 * dead command, so the strip is a class-level rule rather than a `/reload`
 * special case - every built-in command gets a two-phase notice:
 *
 *   running -> while the request is in flight (no auto-dismiss)
 *   done    -> for a moment after it lands, then it leaves by itself
 *
 * A failure never reaches the "done" text: the composer error strip says
 * something more specific ("stop the running response...", "does not take
 * arguments...") and the notice gets out of its way.
 *
 * Wording is addressed by command name, so a command can opt into its own
 * phrasing (`composer.builtinCommand.<name>.done`) and anything that does not
 * falls back to the generic `/{name}` pair. Adding a command to the server
 * registry is therefore enough to get a notice - no new plumbing per command.
 */

import { hasTranslation, t } from "../i18n/index.ts";

export type BuiltinCommandPhase = "running" | "done";

const NOTICE_KEY_PREFIX = "composer.builtinCommand";

/** How long the "done" strip stays before it removes itself. */
export const BUILTIN_COMMAND_DONE_DISMISS_MS = 3200;

export function builtinCommandNoticeText(name: string, phase: BuiltinCommandPhase): string {
  const specific = `${NOTICE_KEY_PREFIX}.${name}.${phase}`;
  if (hasTranslation(specific)) {
    return t(specific);
  }
  return t(`${NOTICE_KEY_PREFIX}.${phase}`, { name });
}