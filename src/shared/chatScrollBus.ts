/**
 * A one-shot "put this thread at its bottom *now*" signal.
 *
 * Why it exists: the thread's viewport owner decides whether to follow the stream
 * from a snapshot of the per-session record it took when the session was entered,
 * and that decision only re-runs on a session switch. So a writer that merely
 * flips `shouldFollow` in the shared record changes what the *next* visit does -
 * not what is on screen. Submitting a message while scrolled up appended the new
 * bubble below the fold and left the reader staring at mid-thread history.
 *
 * The bus hands the intent to the live owner instead. It is kept free of React and
 * the DOM so the routing rules (per session, delivered once, survives a remount)
 * are testable.
 */

export type ScrollToBottomRequest = {
  sessionPath: string;
  /** What asked for it - carried through to the perf trace. */
  reason: string;
};

export type ScrollToBottomListener = (request: ScrollToBottomRequest) => void;

export type ScrollToBottomBus = {
  /** Register the live owner of `sessionPath`. Any request parked for it is delivered immediately. */
  subscribe(sessionPath: string, listener: ScrollToBottomListener): () => void;
  /** Deliver to the owners of `sessionPath`, or park the request until one appears. Returns how many were served. */
  request(sessionPath: string, reason: string): number;
  /** Test/diagnostic helper. */
  hasSubscriber(sessionPath: string): boolean;
};

export function createScrollToBottomBus(): ScrollToBottomBus {
  const listeners = new Map<string, Set<ScrollToBottomListener>>();
  // Only the latest request per session can matter: pinning to the bottom twice
  // is the same operation. Keys drain on subscribe, so this stays bounded by the
  // number of sessions that were submitted to while their thread was unmounted.
  const parked = new Map<string, ScrollToBottomRequest>();

  const deliver = (sessionPath: string, request: ScrollToBottomRequest) => {
    const owners = listeners.get(sessionPath);
    if (!owners || owners.size === 0) {
      return 0;
    }
    for (const listener of Array.from(owners)) {
      listener(request);
    }
    return owners.size;
  };

  return {
    subscribe(sessionPath, listener) {
      let owners = listeners.get(sessionPath);
      if (!owners) {
        owners = new Set();
        listeners.set(sessionPath, owners);
      }
      owners.add(listener);

      const pending = parked.get(sessionPath);
      if (pending) {
        parked.delete(sessionPath);
        listener(pending);
      }

      return () => {
        owners.delete(listener);
        if (owners.size === 0) {
          listeners.delete(sessionPath);
        }
      };
    },
    request(sessionPath, reason) {
      const request: ScrollToBottomRequest = { sessionPath, reason };
      const served = deliver(sessionPath, request);
      if (served === 0) {
        parked.set(sessionPath, request);
      }
      return served;
    },
    hasSubscriber(sessionPath) {
      return (listeners.get(sessionPath)?.size ?? 0) > 0;
    },
  };
}

/** The one bus the app uses: `ChatThread`'s viewport owner subscribes, the composer requests. */
export const chatScrollToBottomBus = createScrollToBottomBus();
