import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
  type ThreadAssistantMessagePart,
  useAuiState,
  useExternalStoreRuntime,
  useThreadViewport,
  useThreadViewportStore,
} from "@assistant-ui/react";
import { ArrowDownIcon } from "lucide-react";
import {
  AssistantMessage,
  UserMessage,
  UserMessageActionsProvider,
  UserMessageInlineAttachmentProvider,
} from "../../components/assistant-ui/elements/thread.aui";
import {
  Profiler,
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { perfCount, perfEnabled, perfMark, perfSpan } from "../../lib/perf";
import { chatScrollToBottomBus } from "../../shared/chatScrollBus";
import { liveTextTailIndex } from "../../shared/liveTextTail";
import {
  anchorScrollCorrection,
  followingFromGeometry,
  isLayoutSettled,
  nextScrollTarget,
  nextStableFrames,
  pickAnchorBlock,
  resolveFollowing,
} from "../../shared/chatScrollPolicy";
import { MessageEditBox, type MessageEditPayload } from "./MessageEditBox";
import type {
  CapabilitiesState,
  ChatAttachment,
  ChatMessage,
  ChatMessagePart,
  MessageLiveBlock,
  MessageProcessBlock,
} from "../../types";

type ChatThreadProps = {
  messages: ChatMessage[];
  isStreaming: boolean;
  sessionPath: string;
  viewportStates: Map<string, ViewportState>;
  onAttachmentHoverStart?: (attachment: ChatAttachment, element: HTMLElement) => void;
  onAttachmentHoverEnd?: () => void;
  editingMessageId?: string | null;
  capabilities?: Pick<CapabilitiesState, "skills" | "packages">;
  /** Set when a send failed, so the reopened editor keeps what was typed. */
  editDraftText?: string | null;
  onStartEditMessage?: (messageId: string) => void;
  onReloadMessage?: (parentMessageId: string) => void | Promise<void>;
  onCancelEditMessage?: () => void;
  onSubmitEditMessage?: (messageId: string, payload: MessageEditPayload) => Promise<boolean>;
};

export type ViewportState = {
  scrollTop: number;
  shouldFollow: boolean;
};

/**
 * Adapts Pi Desktop's server-owned conversation state to assistant-ui. The backend
 * remains the source of truth; assistant-ui owns thread presentation, message
 * parts, streaming updates, and viewport behavior.
 */
/**
 * How many message roots are inside the viewport container right now. Reported
 * with the entry-restoration and end-of-run lock windows so a long frame can be
 * attributed to the browser laying out a suddenly-larger subtree.
 */
function viewportRootCount(viewport: HTMLElement): number {
  return perfEnabled ? viewport.querySelectorAll("[data-message-id]").length : 0;
}

/**
 * Hoisted so its identity never changes.
 *
 * `ThreadPrimitive.Messages` memoizes the whole row list on `[messagesLength,
 * children]`, and each `MessageByIndex` row is memoized on the `components`
 * object. Passing an inline render-prop arrow therefore re-creates every row on
 * every parent render (measured: 9 user-bubble renders per App render, ~22
 * App renders/s while typing in the composer); a stable `components` object lets
 * the library bail out instead.
 */
const MESSAGE_COMPONENTS = { UserMessage: UserMessageSlot, AssistantMessage };

/**
 * User bubble slot: the ordinary bubble, or the inline editor when this message
 * is the one being edited. Kept at module scope so `ThreadPrimitive.Messages`
 * can keep bailing out on a stable `components` object.
 */
type EditController = {
  editingMessageId: string | null;
  capabilities: Pick<CapabilitiesState, "skills" | "packages">;
  canSubmit: boolean;
  /** Text to seed a reopened editor with, after a failed send. */
  draftText?: string;
  onCancel: () => void;
  onSubmit: (messageId: string, payload: MessageEditPayload) => Promise<boolean>;
};

const ChatThreadEditContext = createContext<EditController | null>(null);

function UserMessageSlot() {
  const edit = useContext(ChatThreadEditContext);
  const messageId = useAuiState((s) => s.message.id);
  const custom = useAuiState((s) => s.message.metadata.custom);

  if (!edit || edit.editingMessageId !== messageId) {
    return <UserMessage />;
  }

  const parts = Array.isArray(custom?.piDesktopInlineParts)
    ? (custom.piDesktopInlineParts as ChatMessagePart[])
    : [];
  const attachments = Array.isArray(custom?.piDesktopInlineAttachments)
    ? (custom.piDesktopInlineAttachments as ChatAttachment[])
    : [];
  const fallbackText = typeof custom?.piDesktopInlineText === "string" ? custom.piDesktopInlineText : "";

  return (
    <MessageEditBox
      key={messageId}
      messageId={messageId}
      parts={parts}
      attachments={attachments}
      fallbackText={fallbackText}
      capabilities={edit.capabilities}
      canSubmit={edit.canSubmit}
      draftText={edit.draftText}
      onCancel={edit.onCancel}
      onSubmit={edit.onSubmit}
    />
  );
}

export const ChatThread = memo(function ChatThread({
  messages,
  isStreaming,
  sessionPath,
  viewportStates,
  onAttachmentHoverStart,
  onAttachmentHoverEnd,
  editingMessageId = null,
  capabilities,
  editDraftText = null,
  onStartEditMessage,
  onReloadMessage,
  onCancelEditMessage,
  onSubmitEditMessage,
}: ChatThreadProps) {
  // Idle-window probe: `render.messages` only counts store updates whose
  // `messages` identity changed, so a window with commits but no
  // `render.messages` means something above or below re-rendered for other
  // reasons. This distinguishes "App re-rendered" from "assistant-ui notified".
  perfCount("render.chatThread");
  // assistant-ui throws away its identity-keyed message cache the moment
  // `convertMessage` is a different function (`if (oldStore.convertMessage !==
  // store.convertMessage) this._converter = new ThreadMessageConverter()`), so
  // an inline arrow here re-converts the entire thread on every streamed token.
  // Keep the callback identities stable and let only `messages`/`isRunning`
  // change; combined with the structurally shared snapshot that makes the cache
  // hit for every message except the one that is streaming.
  const convertMessage = useCallback(
    (message: ChatMessage) => {
      // Cache-miss probe: assistant-ui only calls this for messages whose object
      // identity changed, so its rate *is* the number of rebuilt messages.
      perfCount("thread.convertMessage");
      return toAssistantUiMessage(message);
    },
    [],
  );
  const onNew = useCallback(async () => {}, []);
  // assistant-ui's `Reload` action calls `onReload(parentId)` with the id of the
  // message *before* the one being regenerated - for our bubbles that is the
  // `tN#user` id, which is exactly what the rewind needs.
  const onReload = useCallback(
    async (parentId: string | null) => {
      if (!parentId || !onReloadMessage) {
        return;
      }
      await onReloadMessage(parentId);
    },
    [onReloadMessage],
  );
  // assistant-ui invents its own "running" assistant message whenever the store
  // is running and its last entry is a user bubble. Pi Desktop renders loading
  // state from the bubbles themselves, so that invention is a second dot - it
  // appears exactly when a 插话 is queued: its question has no answer of its own
  // yet (deliberately), while the previous turn is still being written.
  const lastBubble = messages[messages.length - 1];
  const isRunning = isStreaming && lastBubble?.role !== "user";
  const store = useMemo<ExternalStoreAdapter<ChatMessage>>(
    () => ({
      messages,
      isRunning,
      onNew,
      convertMessage,
      // Advertise the action only when the host wired it: assistant-ui derives
      // `capabilities.reload` from the presence of this key.
      ...(onReloadMessage ? { onReload } : {}),
    }),
    [convertMessage, isRunning, messages, onNew, onReload, onReloadMessage],
  );
  const runtime = useExternalStoreRuntime(store);
  // The frame a switch *paints* is the problem, not the frame it settles on: the
  // new session's rows arrive one commit after the container, so anything the
  // browser has not laid out yet paints blank (measured: the thread paints at a
  // third of its normal ink and fills in over the next 3-4 frames - the "loading"
  // flicker on a switch). A layout effect cannot prevent that first paint, so the
  // entry flag is decided during render and reaches the DOM in the same commit as
  // the messages themselves.
  const viewportRef = useRef<HTMLDivElement>(null);
  const messageCountRef = useRef(messages.length);
  messageCountRef.current = messages.length;
  useThreadViewportSync(viewportRef, sessionPath, viewportStates, messages, isStreaming);

  const editController = useMemo<EditController | null>(() => {
    if (!capabilities || !onCancelEditMessage || !onSubmitEditMessage) {
      return null;
    }
    return {
      editingMessageId,
      capabilities,
      canSubmit: !isStreaming,
      draftText: editDraftText ?? undefined,
      onCancel: onCancelEditMessage,
      onSubmit: onSubmitEditMessage,
    };
  }, [capabilities, editDraftText, editingMessageId, isStreaming, onCancelEditMessage, onSubmitEditMessage]);

  const tree = (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatThreadEditContext.Provider value={editController}>
        <UserMessageActionsProvider onEditMessage={onStartEditMessage}>
          <UserMessageInlineAttachmentProvider
            onAttachmentHoverStart={onAttachmentHoverStart}
            onAttachmentHoverEnd={onAttachmentHoverEnd}
          >
            <ThreadPrimitive.Root className="aui-thread">
              <ThreadPrimitive.Viewport
                ref={viewportRef}
                autoScroll={false}
                scrollToBottomOnThreadSwitch={false}
                scrollToBottomOnInitialize={false}
                scrollToBottomOnRunStart={false}
                className="aui-thread-viewport"
              >
                <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
              </ThreadPrimitive.Viewport>
              <CustomScrollToBottom />
            </ThreadPrimitive.Root>
          </UserMessageInlineAttachmentProvider>
        </UserMessageActionsProvider>
      </ChatThreadEditContext.Provider>
    </AssistantRuntimeProvider>
  );

  if (!perfEnabled) {
    return tree;
  }

  // Attribute the frames our own counters cannot explain: React reports the
  // actual render+commit duration of the whole thread subtree per commit.
  return (
    <Profiler
      id="thread"
      onRender={(_id, _phase, actualDuration) => {
        perfMark("react.commit.thread", actualDuration, { messages: messageCountRef.current });
      }}
    >
      {tree}
    </Profiler>
  );
});

/**
 * One rAF-coalesced owner for the whole thread viewport: entry restoration,
 * bottom following, reading-position persistence, and the short reflow lock that
 * runs when a streamed run finishes.
 *
 * History: this used to be two hooks whose layout effects depended on
 * `messages`, plus a MutationObserver/ResizeObserver pair that each walked every
 * message root with `querySelectorAll` + `getBoundingClientRect`. Every streamed
 * token therefore cost four or five forced synchronous layouts and several O(n)
 * scans, which is what made long conversations stutter and release the buffered
 * markdown in bursts. Now a frame does at most one height read and one write, and
 * the anchor lookup is O(1) while the cached anchor element is still on screen.
 */
const RESTORE_WINDOW_MS = 750;
/** Floor for the early exit: long threads need a few frames to be laid out. */
const MIN_RESTORE_MS = 150;
/** How long a touch of the thread counts as "the reader is driving". */
const USER_TAKEOVER_GRACE_MS = 400;
/** A resize correction must not fight a scroll the reader is still making. */
const RESIZE_INPUT_GRACE_MS = 150;
/** Distance from the end that still counts as "at the end" (see chatScrollPolicy). */
const BOTTOM_TOLERANCE_PX = 4;
const COMPLETION_LOCK_MS = 280;
const PERSIST_INTERVAL_MS = 200;
/** Disclosure roots inside a bubble - their height is what a run settles by. */
const DISCLOSEURE_SELECTOR =
  '[data-slot="aui_process-group"], [data-slot="reasoning-root"], [data-slot="tool-call"], [data-slot="tool-group-root"]';

type ViewportSnapshot = {
  scrollTop: number;
  wasAtBottom: boolean;
  anchor: Element | null;
  anchorTop: number | null;
  /** The message root the anchor belongs to - the fallback if the block is gone. */
  anchorRoot: Element | null;
  anchorRootTop: number | null;
};

function useThreadViewportSync(
  viewportRef: RefObject<HTMLDivElement | null>,
  sessionPath: string,
  viewportStates: Map<string, ViewportState>,
  messages: ChatMessage[],
  isStreaming: boolean,
) {
  // Snapshot of the viewport taken while the run was still streaming. It is
  // refreshed by the throttled persistence pass, so it costs nothing per token.
  const snapshotRef = useRef<ViewportSnapshot | null>(null);
  const completionCleanupRef = useRef<(() => void) | null>(null);
  const wasStreamingRef = useRef(isStreaming);
  // Mirror of the effect-local follow flag, so the frame pump below can read it
  // without re-subscribing on every change.
  const followRef = useRef(true);

  useLayoutEffect(() => () => completionCleanupRef.current?.(), []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return undefined;
    }

    // Copy this record: restoration must keep using the position that existed
    // when the session was entered, even though the writers below put the
    // current session back into the map.
    const savedState: ViewportState = viewportStates.get(sessionPath) ?? {
      scrollTop: 0,
      shouldFollow: true,
    };
    const previousScrollBehavior = viewport.style.scrollBehavior;
    const previousOverflowAnchor = viewport.style.overflowAnchor;
    viewport.style.scrollBehavior = "auto";
    viewport.style.overflowAnchor = "none";
    // Marks the entry window for the perf reporter. It changes no layout: message
    // roots are laid out for real at all times (see styles.css - the estimates
    // this used to opt out of are what made wheeling up jump).
    viewport.dataset.viewportRestoring = "true";
    // How long the entry window stays open, and how many message roots it spans:
    // the candidate explanation for the multi-hundred-millisecond frames that no
    // JS counter can account for.
    const restoreSpan = perfSpan("viewport.cvRestore");

    let restoring = true;
    let currentShouldFollow = savedState.shouldFollow;
    followRef.current = currentShouldFollow;
    const restoreStartedAt = performance.now();
    const restoreUntil = performance.now() + RESTORE_WINDOW_MS;
    // The forced-visible relayout of a long thread lands a few frames in, so do
    // not let "the height stopped changing" be decided before then.
    let restoreFrame = 0;
    let syncFrame = 0;
    let destroyed = false;
    let lastPersistAt = 0;
    // The scrollable height the last persist pass saw. A follow flag that
    // outranks the geometry is only allowed while the thread actually grew (see
    // `resolveFollowing`).
    let lastMaxAtPersist: number | null = null;
    let persistTailTimer = 0;
    let settleFrame = 0;
    // Bottom pinning keeps running for a few frames after the entry window ends when
    // the thread was left at the bottom: rows mount and markdown settles over
    // several frames, so the scrollable height can keep growing after the layout
    // already looks settled, and a single pin stops short of the real bottom
    // (observed 3173 of a final 3696).
    let tailFrame = 0;
    const TAIL_FRAMES = 30;
    const bottomTail = () => {
      if (destroyed || tailFrame++ > TAIL_FRAMES || !currentShouldFollow) {
        return;
      }
      const max = maxScrollTop();
      const next = nextScrollTarget(viewport.scrollTop, max, max);
      if (next !== null) {
        setTop(next);
      }
      requestAnimationFrame(bottomTail);
    };
    // Set right before we move the viewport ourselves, so the resulting scroll
    // event is not mistaken for the user taking over the position. Only honoured
    // briefly: if no event arrives (writing an unchanged value) it must not
    // swallow a later genuine scroll.
    let programmaticTop: number | null = null;
    // When the reader last touched the thread. Their input outranks our own
    // writes: without this, a wheel scroll that lands within a pixel of the
    // offset we just wrote is mistaken for our write, "they left the bottom" is
    // never recorded, and the session keeps coming back scrolled to the end.
    let userInputAt = 0;
    let programmaticAt = 0;
    let anchorRoot: HTMLElement | null = null;

    const maxScrollTop = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight);

    const setTop = (value: number) => {
      programmaticTop = value;
      programmaticAt = performance.now();
      // The stylesheet asks for `scroll-behavior: smooth`, and a plain
      // `scrollTop =` assignment honours it: every follow-the-bottom write turns
      // into an animation that the next token re-targets, so the viewport lags a
      // second behind the stream and entry corrections fight the same animation
      // (that is the switch-time jitter). `instant` is not overridable by CSS.
      if (viewport.scrollTop === value) {
        return;
      }
      viewport.scrollTo({ top: value, behavior: "instant" as ScrollBehavior });
    };

    const scrollToBottom = () => {
      setTop(maxScrollTop());
    };

    const isInsideViewport = (root: HTMLElement, viewportRect: DOMRect) => {
      const rect = root.getBoundingClientRect();
      return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
    };

    const scanMessageRoot = (messageId?: string) => {
      if (!messageId) {
        return null;
      }
      return Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-id]")).find(
        (root) => root.dataset.messageId === messageId,
      ) ?? null;
    };

    /**
     * Anchor of the reading position. Reuses the element found last time; the
     * O(n) scan only runs when that element is gone or no longer visible.
     */
    const findAnchor = () => {
      const viewportRect = viewport.getBoundingClientRect();
      if (anchorRoot?.isConnected && isInsideViewport(anchorRoot, viewportRect)) {
        return { root: anchorRoot, messageId: anchorRoot.dataset.messageId };
      }
      const roots = Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-id]"));
      const root = roots.find((candidate) => isInsideViewport(candidate, viewportRect)) ?? null;
      anchorRoot = root;
      perfMark("layout.anchorScan", 0, { nodes: roots.length });
      if (!root) {
        return null;
      }
      return { root, messageId: root.dataset.messageId };
    };

    /**
     * The block the completion lock should actually pin (see `pickAnchorBlock`).
     *
     * Costs one `children` walk of a single bubble plus a `querySelector` per
     * top-level block, and only runs on the throttled persist path.
     */
    const findAnchorBlock = (root: HTMLElement): HTMLElement | null => {
      const content =
        root.querySelector<HTMLElement>("[data-slot='aui_assistant-message-content']") ?? root;
      const band = viewport.getBoundingClientRect();
      const candidates = Array.from(content.children as HTMLCollectionOf<HTMLElement>).map(
        (block) => {
          const rect = block.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            hasDisclosure:
              block.matches(DISCLOSEURE_SELECTOR) ||
              block.querySelector(DISCLOSEURE_SELECTOR) !== null,
          };
        },
      );
      const index = pickAnchorBlock(candidates, { top: band.top, bottom: band.bottom });
      return index === null ? null : (content.children[index] as HTMLElement);
    };

    /**
     * Is the scroll geometry worth believing?
     *
     * Right after a switch the viewport can still be empty (the next session's
     * messages are not in the DOM yet), where "at the bottom of an empty list"
     * would be recorded as "this reader follows the stream" - and that is exactly
     * how a saved reading position got thrown away.
     */
    const persist = (shouldFollow?: boolean) => {
      const max = maxScrollTop();
      const derived = resolveFollowing({
        derived: followingFromGeometry({
          scrollTop: viewport.scrollTop,
          maxScrollTop: max,
          hasContent: viewport.querySelector("[data-message-id]") !== null,
        }),
        following: currentShouldFollow,
        grew: lastMaxAtPersist !== null && max > lastMaxAtPersist + 1,
        userInputAgeMs: performance.now() - userInputAt,
        graceMs: USER_TAKEOVER_GRACE_MS,
      });
      lastMaxAtPersist = max;
      // Nothing about this geometry is real - the thread is mid re-estimate, or
      // collapsed, or belongs to a session that is no longer on screen. The
      // browser has already clamped `scrollTop` in that state (observed: a
      // perfectly saved 1016px reading position overwritten with 0 in the frame
      // before a switch), so writing would destroy the record we are keeping.
      if (derived === null) {
        if (shouldFollow === undefined) {
          return;
        }
        // Only the intent is trustworthy in that frame - keep the reading position we
        // have instead of the number the browser clamped mid-collapse.
        currentShouldFollow = shouldFollow;
        followRef.current = shouldFollow;
        viewportStates.set(sessionPath, {
          scrollTop: viewportStates.get(sessionPath)?.scrollTop ?? viewport.scrollTop,
          shouldFollow,
        });
        return;
      }
      currentShouldFollow = shouldFollow ?? derived ?? currentShouldFollow;
      followRef.current = currentShouldFollow;
      const anchor = findAnchor();
      const root = anchor?.root ?? null;
      const block = root ? findAnchorBlock(root) : null;
      viewportStates.set(sessionPath, {
        scrollTop: viewport.scrollTop,
        shouldFollow: currentShouldFollow,
      });
      snapshotRef.current = {
        scrollTop: viewport.scrollTop,
        wasAtBottom: currentShouldFollow,
        anchor: block ?? root,
        anchorTop: (block ?? root)?.getBoundingClientRect().top ?? null,
        anchorRoot: root,
        anchorRootTop: root?.getBoundingClientRect().top ?? null,
      };
      lastPersistAt = performance.now();
    };

    // Scroll position is persisted on a throttle *and* once more after the
    // reader stops, so what a session remembers is where they actually ended up
    // rather than where they were up to 200ms earlier.
    const schedulePersist = () => {
      if (restoring) {
        return;
      }
      if (performance.now() - lastPersistAt >= PERSIST_INTERVAL_MS) {
        persist();
      }
      // Re-arm on every scroll: a wheel flick fires for hundreds of milliseconds
      // and the position that matters is where it *ended*. Firing once after the
      // first skipped event recorded a mid-flick position instead.
      if (persistTailTimer) {
        window.clearTimeout(persistTailTimer);
      }
      persistTailTimer = window.setTimeout(() => {
        persistTailTimer = 0;
        if (!restoring && !destroyed) {
          persist();
        }
      }, PERSIST_INTERVAL_MS);
    };

    /**
     * Re-apply the entry position, but only when it is actually off.
     *
     * The restore window runs this every frame while the thread's height is
     * still settling - rows mount and markdown lays out over several frames, so
     * the bottom moves by a pixel or two per frame. Writing the viewport on each
     * of those is exactly the jitter readers see when they switch sessions, so
     * small drift is absorbed and we only move when the position is genuinely
     * wrong.
     */
    const restorePosition = () => {
      const apply = (target: number) => {
        const next = nextScrollTarget(viewport.scrollTop, target, maxScrollTop());
        if (next !== null) {
          setTop(next);
        }
      };

      if (savedState.shouldFollow) {
        apply(maxScrollTop());
        return;
      }

      // Deliberately no "anchor + offset" restore: the offset is measured in the
      // layout that happened to be current when it was recorded, and a collapsed
      // 过程/思考 panel on the next visit moves the same anchor by hundreds of pixels
      // (observed: 506px off, and once -914px, which scrolled a mid-thread position
      // to the very top). The plain offset is the only number that means the same
      // thing on both sides.
      apply(savedState.scrollTop);
    };

    /**
     * Close the entry window.
     *
     * `settled` means the layout stopped moving and we are handing the viewport
     * back; anything else means the reader touched it first, in which case their
     * position wins and we never write over it.
     *
     * The layout can still move after the window closes (rows mounting, markdown
     * settling), and the browser moves the viewport while it does that.
     * The correction has to happen in the *same* frame - reading the scroll
     * height forces the relayout, writing puts the reader back before paint -
     * with one more pass next frame for anything that settles even later.
     */
    const stopRestoring = (reason: "settled" | "user") => {
      if (!restoring) {
        return;
      }
      restoring = false;
      if (persistTailTimer) {
        window.clearTimeout(persistTailTimer);
        persistTailTimer = 0;
      }
      cancelAnimationFrame(restoreFrame);
      delete viewport.dataset.viewportRestoring;
      if (reason === "settled") {
        restorePosition();
        settleFrame = requestAnimationFrame(() => {
          settleFrame = 0;
          if (!destroyed) {
            restorePosition();
          }
        });
        // Nobody moved the viewport during the window, so the reader's intent is
        // still the one we came in with - the height is also the least reliable
        // right here, which is what used to turn "reading mid-thread" into
        // "follow the bottom".
        restoreSpan({ nodes: viewportRootCount(viewport) });
        persist(savedState.shouldFollow);
        if (currentShouldFollow) {
          tailFrame = 0;
          requestAnimationFrame(bottomTail);
        }
        return;
      }
      restoreSpan({ nodes: viewportRootCount(viewport) });
      persist();
    };

    // Markdown, process groups, and attachments can all resize just after the
    // switch. Keep the entry snapshot authoritative during that brief layout
    // window, but never write it back until the position has settled.
    // Frames during which the scrollable height has not moved. The window ends
    // on the first settled run, so a short thread is not held in forced layout -
    // which is what reads as "loading" - for the whole cap.
    let stableFrames = 0;
    let lastMax: number | null = null;

    const keepRestoring = () => {
      if (!restoring || destroyed) {
        return;
      }
      restorePosition();
      const max = maxScrollTop();
      const now = performance.now();
      const early =
        now - restoreStartedAt >= MIN_RESTORE_MS &&
        followingFromGeometry({
          scrollTop: viewport.scrollTop,
          maxScrollTop: max,
          hasContent: viewport.querySelector("[data-message-id]") !== null,
        }) !== null;
      stableFrames = early ? nextStableFrames(lastMax, max, stableFrames) : 0;
      lastMax = max;
      if (isLayoutSettled(stableFrames) || now >= restoreUntil) {
        stopRestoring("settled");
      } else {
        restoreFrame = requestAnimationFrame(keepRestoring);
      }
    };

    /**
     * The only per-frame work while a run streams: follow the bottom when the
     * reader was following, otherwise touch nothing (growing content above the
     * fold is handled by the completion lock at the end of the run).
     */
    const sync = () => {
      syncFrame = 0;
      if (destroyed) {
        return;
      }
      const stop = perfSpan("layout.sync");
      if (restoring) {
        restorePosition();
        stop();
        return;
      }
      if (currentShouldFollow) {
        // Growing content moves the bottom away from us too, so "not at the
        // bottom" is only evidence of the reader leaving when they actually
        // touched the thread a moment ago - and dragging them back down is the
        // difference between following a run and fighting it. Their own scroll
        // event is throttled, so settle the flag here.
        if (
          performance.now() - userInputAt < USER_TAKEOVER_GRACE_MS &&
          viewport.scrollTop < maxScrollTop() - 1
        ) {
          persist(false);
          stop();
          return;
        }
        scrollToBottom();
        if (viewport.scrollTop < maxScrollTop() - BOTTOM_TOLERANCE_PX) {
          // The thread grew *during* this frame, so the write landed above the
          // new bottom. Persisting that as "the reader left the bottom" would
          // drop them out of follow mode mid-run - retry next frame instead.
          scheduleSync();
          stop();
          return;
        }
        if (performance.now() - lastPersistAt >= PERSIST_INTERVAL_MS) {
          persist(true);
        }
      }
      stop();
    };

    const scheduleSync = () => {
      if (syncFrame) {
        return;
      }
      syncFrame = requestAnimationFrame(sync);
    };

    /**
     * Put the reading line back where it was before a reflow.
     *
     * A window resize is a reflow, not new content: the browser clamps
     * `scrollTop` while the scrollport grows (so a maximise animation drags a
     * mid-thread reader along the thread) and rewrap moves every block, so the
     * raw offset stops meaning "the line I was reading". The anchor the
     * throttled persistence already recorded does mean the same thing on both
     * sides of the reflow, so writing the delta back each frame keeps it still -
     * the same trick the completion lock plays for a turn-end reflow.
     */
    const holdReadingPosition = () => {
      const snapshot = snapshotRef.current;
      if (!snapshot) {
        return;
      }
      const blockAnchor = snapshot.anchor?.isConnected ? snapshot.anchor : null;
      const element = blockAnchor ?? (snapshot.anchorRoot?.isConnected ? snapshot.anchorRoot : null);
      const before = blockAnchor ? snapshot.anchorTop : snapshot.anchorRootTop;
      if (!element || before === null) {
        return;
      }
      const delta = anchorScrollCorrection(element.getBoundingClientRect().top, before);
      if (delta === null) {
        return;
      }
      viewport.scrollTop = Math.max(0, viewport.scrollTop + delta);
    };

    /**
     * The window changed size: a title-bar double click, the maximise animation,
     * a panel opening next to the chat. Readers who are following the end keep
     * following - the new scrollport may have re-opened space below them. Everyone
     * else gets their reading line held still instead of dragged by the browser's
     * clamp and the rewrap.
     */
    const handleViewportResize = () => {
      if (restoring || destroyed || viewport.dataset.viewportLocking === "true") {
        return;
      }
      // While the reader is mid-gesture their own scroll owns the position.
      if (performance.now() - userInputAt < RESIZE_INPUT_GRACE_MS) {
        return;
      }
      if (currentShouldFollow) {
        scheduleSync();
        return;
      }
      holdReadingPosition();
    };

    /**
     * An explicit "take me to the latest" (submitting a message, the scroll button).
     *
     * The live owner has to act on this: the per-session record the requester
     * flipped is the snapshot this effect read on entry, so nothing else would
     * notice until the next session switch.
     */
    const pinToBottom = (reason: string) => {
      // The entry snapshot is what `restorePosition` re-applies every frame, so it
      // moves too - otherwise a restore still in flight pulls the reader back to
      // wherever they were reading.
      savedState.shouldFollow = true;
      currentShouldFollow = true;
      followRef.current = true;
      scrollToBottom();
      // At request time the new bubble is not in the DOM yet, so the bottom keeps
      // running away underneath the write: re-pin over the next frames the way a
      // session entry does.
      tailFrame = 0;
      requestAnimationFrame(bottomTail);
      scheduleSync();
      persist(true);
      // `reason` is a caller-chosen label from a fixed set (never user text), so it
      // is safe to fold into the counter name and see *why* a pin happened.
      perfCount(`viewport.pinToBottom.${reason}`);
    };
    const unsubscribePinToBottom = chatScrollToBottomBus.subscribe(sessionPath, (request) => {
      if (!destroyed) {
        pinToBottom(request.reason);
      }
    });

    const handleScroll = () => {
      if (restoring) {
        return;
      }
      const synthetic =
        programmaticTop !== null &&
        performance.now() - programmaticAt < 100 &&
        performance.now() - userInputAt > 250 &&
        Math.abs(viewport.scrollTop - programmaticTop) <= 1;
      programmaticTop = null;
      if (synthetic) {
        return;
      }
      schedulePersist();
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    /**
     * Would this wheel be absorbed by a scrollable card under the cursor (a
     * 过程/思考 panel with its own `overflow-y`) instead of the thread? If it can
     * still scroll that way, the thread itself is not moving and the reader is
     * still following the run.
     */
    const absorbedByScrollableCard = (target: EventTarget | null, up: boolean) => {
      let node = target instanceof Element ? target : null;
      while (node && node !== viewport) {
        const overflowY = getComputedStyle(node).overflowY;
        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          (up ? node.scrollTop > 0 : node.scrollHeight - node.scrollTop > node.clientHeight + 1)
        ) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };
    // Input outranks our own writes, and it also ends the entry window: the
    // reader is taking over the position. Deliberately *not* recording the
    // position here - a wheel event fires before the browser has scrolled, so
    // the geometry at this instant is where they were, not where they are going.
    // The scroll event that follows derives it.
    const onUserTakeover = (event: Event) => {
      userInputAt = performance.now();
      const leaving =
        event.type === "wheel"
          ? (event as WheelEvent).deltaY < 0 && !absorbedByScrollableCard(event.target, true)
          : event.type === "keydown" &&
            ["PageUp", "Home", "ArrowUp"].includes((event as KeyboardEvent).key);
      stopRestoring("user");
      if (!leaving) {
        return;
      }
      /*
       * An upward wheel *is* the reader leaving the bottom, so revoke the follow
       * here rather than waiting for the geometry to agree.
       *
       * The geometry is not trustworthy for exactly as long as it matters: while
       * a fast flick is still being committed on the compositor, a main-thread
       * read of `scrollTop` can return the pre-flick value. Both revokes we used
       * to have are geometry-gated (`sync()` compares against `maxScrollTop()`,
       * `persist()` runs `followingFromGeometry`), so during those frames they
       * report "still at the bottom", the per-frame pin writes the reader back
       * down, and the belated position lands on top of it - the up/down shiver
       * readers see when they flick up from the bottom. Slow wheel steps are
       * committed before the next frame, which is why they never shivered.
       */
      persist(false);
    };
    for (const type of ["pointerdown", "wheel", "touchstart", "keydown"] as const) {
      viewport.addEventListener(type, onUserTakeover, { passive: true });
    }

    const mutationObserver = new MutationObserver(scheduleSync);
    mutationObserver.observe(viewport, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Watch the content wrapper, not the message roots. The thread grows through
    // bubbles that did not exist when the session was entered, so a per-root
    // subscription left those frames unsampled: the answer kept being written
    // below the fold while the viewport sat still. The wrapper covers every
    // current and future root in one subscription.
    const resizeObserver = new ResizeObserver(scheduleSync);
    const content = viewport.firstElementChild;
    if (content) {
      resizeObserver.observe(content);
    }
    // The viewport's own size changes on a window resize / maximise, which is the
    // one reflow the content observer above does not see when only the height
    // changes. It owns keeping the reading line still (or re-pinning a follower).
    const viewportResizeObserver = new ResizeObserver(handleViewportResize);
    viewportResizeObserver.observe(viewport);

    restorePosition();
    restoreFrame = requestAnimationFrame(keepRestoring);

    return () => {
      destroyed = true;
      delete viewport.dataset.viewportRestoring;
      if (persistTailTimer) {
        window.clearTimeout(persistTailTimer);
        persistTailTimer = 0;
      }
      if (settleFrame) {
        cancelAnimationFrame(settleFrame);
      }
      cancelAnimationFrame(restoreFrame);
      cancelAnimationFrame(syncFrame);
      syncFrame = 0;
      unsubscribePinToBottom();
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      viewportResizeObserver.disconnect();
      viewport.removeEventListener("scroll", handleScroll);
      for (const type of ["pointerdown", "wheel", "touchstart", "keydown"] as const) {
        viewport.removeEventListener(type, onUserTakeover);
      }
      // Deliberately *not* persisting here. This cleanup runs after React has
      // committed the next session into the same viewport element, so measuring
      // the DOM now would file the new session's scroll position under the old
      // session's key - that is what made "back to where I was reading" jump to
      // the bottom. The throttled and trailing persists above already recorded
      // everything the reader did in this session.
      viewport.style.scrollBehavior = previousScrollBehavior;
      viewport.style.overflowAnchor = previousOverflowAnchor;
    };
  }, [sessionPath, viewportRef, viewportStates]);

  /**
   * While a run streams and the reader is following, keeping the bottom pinned
   * is a per-frame *invariant* rather than a reaction to an event.
   *
   * The observer-driven path alone is not enough: a thread can grow without
   * mutating anything under the viewport and without resizing the content
   * wrapper - a collapsed 过程/思考 panel releasing buffered markdown is the
   * common one - and then the answer is written below the fold while the
   * viewport sits still. Measured before this existed: the first ~1s of a run
   * left the reader ~90px short of the bottom, and a growing thinking panel
   * never followed at all.
   */
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
  }, [isStreaming, viewportRef]);

  // A streamed token changes `messages` identity; nothing is measured here. The
  // commit itself is observed by the MutationObserver above, which schedules the
  // single coalesced sync for the frame.
  useLayoutEffect(() => {
    perfCount("render.messages");
  }, [messages]);

  // Completed-process grouping changes the DOM structure at the exact moment a
  // run ends. Hold the reader's place through that reflow using the snapshot the
  // throttled persistence already captured, so this stays off the per-token path.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const previousSnapshot = snapshotRef.current;
    if (!wasStreamingRef.current || isStreaming || !previousSnapshot || previousSnapshot.wasAtBottom) {
      wasStreamingRef.current = isStreaming;
      return;
    }

    completionCleanupRef.current?.();

    const previousScrollBehavior = viewport.style.scrollBehavior;
    const previousOverflowAnchor = viewport.style.overflowAnchor;
    const previousScrollTo = viewport.scrollTo;
    const previousScrollBy = viewport.scrollBy;
    const anchor = previousSnapshot.anchor;
    const anchorTop = previousSnapshot.anchorTop;
    const anchorRoot = previousSnapshot.anchorRoot;
    const anchorRootTop = previousSnapshot.anchorRootTop;
    /**
     * Push the surviving text back under the reader's eyes.
     *
     * The refined anchor is a paragraph of the answer: when the 过程 group above
     * it releases its height, this delta is exactly that removal, so the visible
     * line does not move. A block that the rewrap destroyed falls back to its
     * message root (coarser, but it is what the previous behaviour had), and only
     * if even that is gone do we restore the absolute offset.
     */
    const holdPosition = () => {
      if (anchor?.isConnected && anchorTop !== null) {
        viewport.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
        return;
      }
      if (anchorRoot?.isConnected && anchorRootTop !== null) {
        viewport.scrollTop += anchorRoot.getBoundingClientRect().top - anchorRootTop;
        return;
      }
      viewport.scrollTop = previousSnapshot.scrollTop;
    };
    let active = true;
    let frame = 0;

    viewport.style.scrollBehavior = "auto";
    viewport.dataset.viewportLocking = "true";
    let lockSpan: ReturnType<typeof perfSpan> | null = perfSpan("viewport.cvLock");
    viewport.style.overflowAnchor = "none";
    viewport.scrollTo = (() => undefined) as typeof viewport.scrollTo;
    viewport.scrollBy = (() => undefined) as typeof viewport.scrollBy;

    const restore = () => {
      if (!active) {
        return;
      }
      holdPosition();
      frame = requestAnimationFrame(restore);
    };
    restore();

    const finish = () => {
      active = false;
      cancelAnimationFrame(frame);
      holdPosition();
      viewport.scrollTo = previousScrollTo;
      viewport.scrollBy = previousScrollBy;
      viewport.style.scrollBehavior = previousScrollBehavior;
      viewport.style.overflowAnchor = previousOverflowAnchor;
      delete viewport.dataset.viewportLocking;
      endLockSpan();
      completionCleanupRef.current = null;
    };
    const endLockSpan = () => {
      lockSpan?.({ nodes: viewportRootCount(viewport) });
      lockSpan = null;
    };
    const timeoutId = window.setTimeout(finish, COMPLETION_LOCK_MS);
    completionCleanupRef.current = () => {
      active = false;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeoutId);
      viewport.scrollTo = previousScrollTo;
      viewport.scrollBy = previousScrollBy;
      viewport.style.scrollBehavior = previousScrollBehavior;
      viewport.style.overflowAnchor = previousOverflowAnchor;
      delete viewport.dataset.viewportLocking;
      endLockSpan();
      completionCleanupRef.current = null;
    };
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, viewportRef]);
}

function toAssistantUiMessage(message: ChatMessage): ThreadMessageLike {
  if (message.role === "user") {
    return {
      id: message.id,
      role: "user",
      createdAt: new Date(message.createdAt),
      // Keep the original message parts available to the user-message renderer.
      // The visible user bubble renders these inline; assistant-ui still owns
      // the message runtime, editing, actions, and attachment primitives.
      content: [{ type: "text" as const, text: userMessageText(message) }],
      metadata: {
        custom: {
          piDesktopInlineParts: message.contentParts ?? [],
          piDesktopInlineAttachments: message.attachments ?? [],
          piDesktopInlineText: userMessageText(message),
        },
      },
    };
  }

  const liveBlocks = message.liveBlocks ?? [];
  // Process (thinking / tool cards) is always rendered — the header eye toggle was removed.
  const processBlocks = liveBlocks.length ? liveBlocks : message.processBlocks ?? [];
  const isStreaming = message.status === "streaming";
  // Only the last block can still be growing, so only it may claim `running`;
  // see the module docblock for the caret and deferral behaviour that rides on it.
  const liveTailIndex = liveTextTailIndex(processBlocks, isStreaming);
  const content: ThreadAssistantMessagePart[] = processBlocks.flatMap((block, index) =>
    toAssistantUiParts(block, isStreaming, index, index === liveTailIndex),
  );
  const includesLiveText = liveBlocks.some((block) => block.kind === "text");

  // TEMP PROBE（渲染形状）：把这条气泡正在渲染的块顺序压成签名上报。
  //   R=推理块（已写完） R*=推理块（还在输出） T=工具卡 X=正文 N=notice，前缀 L=流式现场 / P=历史块。
  // 目的：把“工具卡都出来了，上面的 thinking 还在输出”切成两个可分开的问题——
  //   · `render.shape.*` 里出现 `R*` 后面还跟着 `T`（同时计 alarm 计数器）
  //     ⇒ 数据层真的把还在输出的推理块排在了已出现的工具卡前面；
  //   · alarm 从不触发而用户仍然看到 ⇒ 顺序是对的，是布局/滚动把它画到了上面。
  // 诊断完成后删掉这一段（它只在 perf 探针开启时执行）。
  if (perfEnabled && message.status === "streaming") {
    let shape = liveBlocks.length ? "L:" : "P:";
    for (const block of processBlocks) {
      if (block.kind === "thinking") {
        shape += block.open === true ? "R*" : "R";
      } else if (block.kind === "tool") {
        shape += "T";
      } else if (block.kind === "notice") {
        shape += "N";
      } else {
        shape += "X";
      }
    }
    perfCount(`render.shape.${shape}`);
    const openThinking = shape.indexOf("R*");
    const lastTool = shape.lastIndexOf("T");
    if (openThinking >= 0 && lastTool > openThinking) {
      perfCount("render.shape.ALARM.openThinkingAboveTool");
    }
  }

  if (message.content && !includesLiveText) {
    // Text the live block list does not carry (a snapshot that only kept
    // `content`). It cannot be the caret's block: `liveTextTailIndex` never saw
    // it, so it stays settled rather than parking a dot at the very end.
    content.push({ type: "text", text: message.content, status: { type: "complete" } });
  }

  return {
    id: message.id,
    role: "assistant",
    createdAt: new Date(message.createdAt),
    status: message.status === "streaming" ? { type: "running" } : { type: "complete", reason: "stop" },
    content,
  };
}

function toAssistantUiParts(
  block: MessageLiveBlock | MessageProcessBlock,
  isStreaming: boolean,
  partIndex: number,
  isLiveTail: boolean,
): ThreadAssistantMessagePart[] {
  if (block.kind === "text") {
    return [
      {
        type: "text",
        text: block.text,
        // The markdown renderer reads this two ways: `running` opts out of
        // `defer` (a live block must land with the rest of the turn), and it is
        // also what draws the streaming caret via
        // `@assistant-ui/react-markdown/styles/dot.css`. Only the tail block may
        // claim it — anything a tool/thinking part follows is settled, and
        // marking it `running` for the whole turn left its caret on screen.
        status: isLiveTail ? { type: "running" } : { type: "complete" },
      },
    ];
  }

  if (block.kind === "thinking") {
    return [
      {
        type: "reasoning",
        text: block.text,
        status:
          // Explicitly flagged while streaming: `open` is set by the thinking
          // deltas and cleared by `thinking_end`, the synthetic settle, a new
          // streamKey, a text delta, or any tool-block activity. Only the
          // explicit flag may claim "still outputting": blocks without one
          // (persisted transcripts, snapshot rebuilds, unkeyed merges) are by
          // definition settled history. The old last-part heuristic marked
          // exactly those as running - a false「工具卡都出来了，上面的 thinking
          // 还在输出」whenever the last block happened to be a settled panel.
          isStreaming && block.open === true ? { type: "running" } : { type: "complete" },
      },
    ];
  }

  // Notices are narrative text emitted between process parts. Keep them as
  // ordinary assistant text so a collapsed process group still retains and
  // displays the interleaved explanation instead of hiding it in reasoning.
  if (block.kind === "notice") {
    return [{ type: "text", text: block.text }];
  }

  // assistant-ui infers a tool's status from result presence
  // (auto-status: `result === undefined` => still running). Feeding the
  // in-flight partial output into `result` therefore made every tool look
  // finished the moment its first output chunk arrived: the loading shimmer
  // disappeared and the card collapsed early, so a long run showed nothing and
  // then dumped the whole output at the end. Partial output travels in its own
  // field instead, and `result` only appears once the tool truly settled.
  const toolSettled = block.status === "done" || !isStreaming;
  return [
    {
      type: "tool-call",
      toolCallId: block.toolCallId || block.toolStreamId || `tool-${block.toolName}-${partIndex}`,
      toolName: block.toolName || "tool",
      args: parseToolArgs(block.callText),
      argsText: block.callText,
      // Preserve completion even when the tool returned no output. Some tools
      // never send a final result after streaming their output, so the bubble
      // finishing also settles the card.
      result: toolSettled ? block.resultText : undefined,
      partialResult: block.resultText,
      isError: block.isError,
    } as unknown as ThreadAssistantMessagePart,
  ];
}

function userMessageText(message: ChatMessage) {
  if (!message.contentParts?.length) {
    return message.content;
  }

  const attachments = new Map((message.attachments ?? []).map((attachment) => [attachment.id, attachment]));
  return message.contentParts
    .map((part) => {
      if (part.kind === "text") return part.text;
      if (part.kind === "capability") return `[${part.capability.name}]`;
      return attachments.get(part.attachmentId)?.name ?? "[Attachment]";
    })
    .join("");
}

function parseToolArgs(argsText: string) {
  try {
    const value = JSON.parse(argsText);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function CustomScrollToBottom() {
  const isAtBottom = useThreadViewport((state) => state.isAtBottom);
  const store = useThreadViewportStore();
  
  return (
    <button
      className="aui-scroll-to-bottom"
      data-visible={!isAtBottom}
      onClick={() => store.getState().scrollToBottom()}
      aria-label="Scroll to latest message"
    >
      <ArrowDownIcon size={18} strokeWidth={2.5} />
    </button>
  );
}
