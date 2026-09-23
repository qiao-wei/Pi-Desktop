/**
 * Gate that keeps freshly inserted composer attachment badges from popping their
 * preview under a stationary pointer.
 *
 * Chrome re-dispatches `mouseover`/`mouseenter` when an element appears under the
 * cursor, so pasting a screenshot with the pointer already over the composer made the
 * brand-new badge (inserted at the caret, i.e. often right under the pointer) show its
 * hover preview without the user moving the mouse at all. The same happens when a
 * dropped file's badge lands where the drop happened.
 *
 * The rule the user asked for: after an insert, ignore hover until the pointer really
 * moves; only then, if it is still over the badge, open the preview. The bookkeeping for
 * that lives here so it can be unit tested without a DOM.
 */
export interface AttachmentHoverGate {
  /** Call right after attachment badges were inserted. */
  suppress(): void;
  /** True while hover events must be ignored. */
  isSuppressed(): boolean;
  /**
   * Call on every pointermove. Returns true only for the first move after `suppress()`,
   * which is the moment the caller should re-check what sits under the pointer.
   */
  releaseOnPointerMove(): boolean;
}

export function createAttachmentHoverGate(): AttachmentHoverGate {
  let suppressed = false;

  return {
    suppress() {
      suppressed = true;
    },
    isSuppressed() {
      return suppressed;
    },
    releaseOnPointerMove() {
      if (!suppressed) {
        return false;
      }
      suppressed = false;
      return true;
    },
  };
}