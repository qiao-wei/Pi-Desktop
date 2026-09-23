/**
 * What the composer strip says about context compaction.
 *
 * Compaction is invisible apart from this strip: no divider bubble, no summary
 * card, no marker left behind (the usage popover already reports how many times
 * a session has been compacted). So there are only two states to phrase -
 * "it is happening" and "it failed" - plus the state where there is nothing to
 * say, which includes a cancelled compaction: the user pressed stop, they know.
 */

import { t } from "../i18n/index.ts";

export type CompactionNotice =
  | { tone: "running"; text: string }
  | { tone: "failed"; text: string }
  | null;

export const COMPACTION_RUNNING_TEXT_KEY = "compaction.running";

/** What a `compaction_end` actually reports. Getting these three apart is the whole rule. */
export type CompactionOutcome = "succeeded" | "cancelled" | "failed";

/**
 * pi signals a stop/extension refusal with `aborted` and a real fault with
 * `errorMessage`. A cancellation must never be phrased as a failure - the user
 * pressed stop and nothing is wrong with their context - and a failure must
 * never be swallowed by the generic "done" path.
 */
export function compactionOutcome(event: { aborted?: boolean; errorMessage?: string }): CompactionOutcome {
  if (event.errorMessage) {
    return "failed";
  }
  return event.aborted ? "cancelled" : "succeeded";
}

/** pi prefixes its own failure text; the useful part is behind the colon. */
const PI_FAILURE_PREFIX = /^(?:compaction|auto-compaction|context overflow recovery)\s+failed:\s*/iu;

export function compactionFailureReason(errorMessage: string | null | undefined): string {
  const raw = (errorMessage ?? "").trim();
  if (!raw) {
    return t("compaction.unknownError");
  }
  return raw.replace(PI_FAILURE_PREFIX, "").trim() || raw;
}

export function compactionFailureText(errorMessage: string | null | undefined): string {
  return t("compaction.failed", { reason: compactionFailureReason(errorMessage) });
}

/* -------------------------------------------------------------------------- */
/* The manual "compact now" button                                            */
/* -------------------------------------------------------------------------- */

export const COMPACT_LABEL_IDLE_KEY = "compaction.label.idle";
export const COMPACT_LABEL_COMPACTING_KEY = "compaction.label.compacting";
export const COMPACT_LABEL_WAIT_STREAM_KEY = "compaction.label.waitStream";

export type CompactActionReason = "compacting" | "streaming" | null;

/**
 * State of the manual compaction button in the usage popover.
 *
 * A manual compaction must never start while an answer is streaming: it folds
 * the very transcript the running turn is still appending to, and pi has no
 * re-entrancy guard here (`AgentSession.compact()` only refuses when already
 * compacting). So the button waits, `compactContext` refuses, and the bridge
 * rejects the request as well - whichever layer is reached first says no.
 *
 * The reason is carried in the label on purpose: the disabled state swallows
 * hover tooltips (`disabled:pointer-events-none` in the button base class).
 */
export function compactActionState(state: {
  isStreaming: boolean;
  isCompacting: boolean;
}): { disabled: boolean; label: string; reason: CompactActionReason } {
  if (state.isCompacting) {
    return { disabled: true, label: t(COMPACT_LABEL_COMPACTING_KEY), reason: "compacting" };
  }
  if (state.isStreaming) {
    return { disabled: true, label: t(COMPACT_LABEL_WAIT_STREAM_KEY), reason: "streaming" };
  }
  return { disabled: false, label: t(COMPACT_LABEL_IDLE_KEY), reason: null };
}

/**
 * The strip to render. A failure outranks "running", because the failure of the
 * previous attempt is still true information while a retry is in flight.
 */
export function compactionNotice(
  state: { isCompacting: boolean; compactionError: string | null },
): CompactionNotice {
  if (state.compactionError) {
    return { tone: "failed", text: compactionFailureText(state.compactionError) };
  }
  if (state.isCompacting) {
    return { tone: "running", text: t(COMPACTION_RUNNING_TEXT_KEY) };
  }
  return null;
}
