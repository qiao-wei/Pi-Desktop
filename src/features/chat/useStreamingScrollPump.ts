import { useLayoutEffect, type RefObject } from "react";

import { perfCount } from "../../lib/perf";
import { nextScrollTarget } from "../../shared/chatScrollPolicy";

/**
 * While a run streams and the reader is following, keeping the bottom pinned is
 * a per-frame *invariant* rather than a reaction to an event.
 *
 * The observer-driven path alone is not enough: a thread can grow without
 * mutating anything under the viewport and without resizing the content
 * wrapper - a collapsed 过程/思考 panel releasing buffered markdown is the
 * common one - and then the answer is written below the fold while the
 * viewport sits still. Measured before this existed: the first ~1s of a run
 * left the reader ~90px short of the bottom, and a growing thinking panel
 * never followed at all.
 *
 * 从 `ChatThread.tsx` 搬出来（`max-lines` 棘轮）；`followRef` 仍归视口 owner
 * (`useThreadViewportSync`) 所有，这里只读。
 */
export function useStreamingScrollPump({
  viewportRef,
  isStreaming,
  followRef,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  isStreaming: boolean;
  followRef: RefObject<boolean>;
}) {
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !isStreaming) {
      return undefined;
    }
    let frame = 0;
    let stopped = false;
    const pump = () => {
      if (stopped) {
        return;
      }
      if (followRef.current) {
        const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        const next = nextScrollTarget(viewport.scrollTop, max, max);
        if (next !== null) {
          perfCount("viewport.pumpFollow");
          viewport.scrollTo({ top: next, behavior: "instant" as ScrollBehavior });
        }
      }
      frame = requestAnimationFrame(pump);
    };
    frame = requestAnimationFrame(pump);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [followRef, isStreaming, viewportRef]);
}
