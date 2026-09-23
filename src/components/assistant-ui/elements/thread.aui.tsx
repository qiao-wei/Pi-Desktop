"use client";

import { useLocale, useT } from "@/i18n/react";
import {
  ComposerAddAttachment,
  ComposerAttachments,
} from "@/components/assistant-ui/elements/attachment.aui";
import { File } from "@/components/assistant-ui/elements/file";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui";
import { Image } from "@/components/assistant-ui/elements/image";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { ToolCall } from "@/components/assistant-ui/elements/tool-call";
import { Reasoning } from "@/components/assistant-ui/elements/reasoning.aui";
import { reasoningGroupFlags } from "@/components/assistant-ui/elements/reasoningState";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { collapsePanel, useScrollPositionLock } from "@/components/assistant-ui/elements/surfaces";
import { useDeferredCollapse } from "@/components/assistant-ui/elements/deferredCollapse";
import { perfCount } from "@/lib/perf";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { canOpenTarget, openTarget } from "@/lib/open-target";
import {
  attachmentBadgeAttributes,
  capabilityBadgeAttributes,
  userMessageClipboardHtml,
  writeClipboardRichText,
} from "@/features/chat/badgeClipboard";
import type { ChatAttachment, ChatMessagePart } from "@/types";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
  useAuiState,
  useMessageTiming,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import {
  createContext,
  Fragment,
  useContext,
  type ComponentType,
  type FC,
  type PropsWithChildren,
  Children,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ASSISTANT_BASE_GROUP_BY = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});
type AssistantGroupKey =
  | "group-process"
  | "group-chainOfThought"
  | "group-reasoning"
  | "group-tool";
type AssistantGroupBy = (
  part: Parameters<typeof ASSISTANT_BASE_GROUP_BY>[0],
  context: Parameters<typeof ASSISTANT_BASE_GROUP_BY>[1],
) => readonly AssistantGroupKey[];

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

export type UserMessageInlineAttachmentHandlers = {
  onAttachmentHoverStart?: (attachment: ChatAttachment, element: HTMLElement) => void;
  onAttachmentHoverEnd?: () => void;
};

/** Message-level actions the thread host can wire up (edit). */
export type UserMessageActions = {
  onEditMessage?: (messageId: string) => void;
};

const UserMessageActionsContext = createContext<UserMessageActions>({});

export function UserMessageActionsProvider({
  onEditMessage,
  children,
}: PropsWithChildren<UserMessageActions>) {
  const value = useMemo(() => ({ onEditMessage }), [onEditMessage]);
  return (
    <UserMessageActionsContext.Provider value={value}>
      {children}
    </UserMessageActionsContext.Provider>
  );
}

/**
 * Entrance animation gate, refreshed by `ChatThread` whenever the session
 * changes.
 *
 * `animate-in fade-in slide-in-from-bottom-1` on a message root is right for a
 * message that just arrived. It is wrong for a thread that was merely re-mounted:
 * switching sessions re-creates every historical row at once (measured: 22 roots
 * sliding up and fading in together for ~150ms), which reads as a flicker and as
 * "loading". Tying this to a CSS class is not enough either - assistant-ui commits
 * those rows a tick after our own render, so any flag we clear with the entry
 * window can already be gone by then. So the rule is per message instead: a row
 * animates only if it was created after the current thread was opened.
 */
export const messageEntranceGate = { after: Date.now() };

/**
 * Call when the reader opens a *different* session, before React renders it.
 *
 * A keyed remount means `ChatThread` cannot detect the switch from its own render
 * (a fresh instance's "previous path" already equals the new one), and a layout
 * effect runs after the rows have already computed their classes - so the stamp is
 * taken at the action that caused the switch.
 */
export function markThreadSwitch() {
  messageEntranceGate.after = Date.now();
}

const ENTRANCE_CLASSES = "fade-in slide-in-from-bottom-1 animate-in duration-150";

/** Entrance classes for the current message - history gets none at all. */
function useMessageEntrance(): string {
  const createdAt = useAuiState((s) => s.message.createdAt);
  return createdAt.getTime() > messageEntranceGate.after ? ENTRANCE_CLASSES : "";
}

const UserMessageInlineAttachmentContext =
  createContext<UserMessageInlineAttachmentHandlers>({});

export function UserMessageInlineAttachmentProvider({
  onAttachmentHoverStart,
  onAttachmentHoverEnd,
  children,
}: PropsWithChildren<UserMessageInlineAttachmentHandlers>) {
  const handlers = useMemo(
    () => ({ onAttachmentHoverStart, onAttachmentHoverEnd }),
    [onAttachmentHoverEnd, onAttachmentHoverStart],
  );

  return (
    <UserMessageInlineAttachmentContext.Provider value={handlers}>
      {children}
    </UserMessageInlineAttachmentContext.Provider>
  );
}

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms]"
  >
    <span className="sr-only">Loading conversation</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} autoFocus={autoFocus} />
    </ThreadComponentsContext.Provider>
  );
};

// Export the registry message renderers so hosts that own their composer can
// reuse the official assistant-ui message surface without mounting a second
// composer from <Thread />.
export { AssistantMessage, UserMessage };

const ThreadRoot: FC<{ isEmpty: boolean; autoFocus: boolean }> = ({
  isEmpty,
  autoFocus,
}) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-bg" as string]: "var(--color-card)",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <ThreadFollowupSuggestions />
            <Composer autoFocus={autoFocus} />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
        How can I help you today?
      </h1>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <Button
          variant="ghost"
          className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors"
        >
          <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
          <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
        </Button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="Send a message..."
            className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
            rows={1}
            autoFocus={autoFocus}
            enterKeyHint="send"
            aria-label="Message input"
          />
          <ComposerAction />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <ComposerAddAttachment />
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="Stop voice input"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip="Send message"
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              aria-label="Send message"
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-7 rounded-full"
              aria-label="Stop generating"
            >
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

/**
 * The live-turn caret. Split out so the whole `AssistantMessage` subtree does not
 * subscribe to the locale on every streamed token - only this leaf does.
 */
const AssistantWorkingIndicator: FC = () => {
  const t = useT();
  return (
    <span
      data-slot="aui_assistant-message-indicator"
      className="animate-pulse font-sans"
      aria-label={t("message.workingAria")}
    >
      {"●"}
    </span>
  );
};

const AssistantMessage: FC = () => {
  // Per-message render probe: divided into `render.messages` (one per store
  // update) this is the fan-out factor that decides whether a streamed token
  // repaints one bubble or the whole thread.
  perfCount("render.assistantMessage");
  const {
    ToolFallback: ToolFallbackComponent = AssistantToolCallTyped,
    ToolGroup,
    ReasoningGroup,
  } = useContext(ThreadComponentsContext);

  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;
  const entrance = useMessageEntrance();
  const parts = useAuiState((s) => s.message.parts);

  // The process summary spans the parts up to the *last* thinking/tool part,
  // including any narrative text interleaved before that boundary. The wrapper is
  // created as soon as there is a process part at all and stays open for the whole
  // turn: the collapse is then always a state change on an already-mounted, already
  // expanded block, which is the only thing the collapse gate can defer. (It used to
  // be created in the same commit that ended the run, which *replaced* the subtree -
  // nothing can hold a replacement, and readers saw the answer lift.) While the turn
  // runs the summary header is hidden, so the live layout is the one from before.
  const processBoundary = useMemo(() => {
    let boundary = -1;
    parts.forEach((part, index) => {
      if (part.type === "reasoning" || part.type === "tool-call") {
        boundary = index;
      }
    });
    return boundary;
  }, [parts]);

  const groupBy = useMemo<AssistantGroupBy>(() => {
    const partIndices = new WeakMap<object, number>();
    parts.forEach((part, index) => partIndices.set(part, index));

    return (part, context) => {
      const basePath = ASSISTANT_BASE_GROUP_BY(part, context);
      const index = partIndices.get(part) ?? -1;
      if (processBoundary >= 0 && index >= 0 && index <= processBoundary) {
        return ["group-process", ...basePath] as const;
      }
      return basePath;
    };
  }, [parts, processBoundary]);

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className={`relative -mb-7.5 pb-7.5 ${entrance}`}
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 text-[14px] leading-[1.85] wrap-break-word"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupBy}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-process":
                return <PiDesktopProcessGroup group={part}>{children}</PiDesktopProcessGroup>;
              case "group-chainOfThought":
                return (
                  <div
                    data-slot="aui_chain-of-thought"
                    className="flex flex-col gap-1.5"
                  >
                    {children}
                  </div>
                );
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return <AssistantToolGroup group={part}>{children}</AssistantToolGroup>;
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                return <AssistantReasoningGroup group={part}>{children}</AssistantReasoningGroup>;
              }
              case "text":
                // Forward the part props like the sibling cases do: the primitive
                // still reads its text from context, but `memo(MarkdownText)` can now
                // skip parts whose text did not change.
                return <MarkdownText {...part} />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <File {...part} />
                  </div>
                );
              case "image":
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              case "indicator":
                return <AssistantWorkingIndicator />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

/**
 * While a turn is streaming every message action is inert: copying a half-written
 * answer, regenerating mid-run or editing a question that is still being answered
 * all corrupt the transcript. The bars stay in place but grey out (native
 * `disabled` → `disabled:opacity-50` on the buttons) instead of the old
 * `hideWhenRunning` disappearing act, which re-flowed the footer.
 */
const useActionsDisabled = () => useAuiState((s) => s.thread.isRunning);

const AssistantActionBar: FC = () => {
  const t = useT();
  const actionsDisabled = useActionsDisabled();
  return (
    <ActionBarPrimitive.Root
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip={t("message.copy")} disabled={actionsDisabled}>
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip={t("message.refresh")} className="aui-assistant-action-refresh" disabled={actionsDisabled}>
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip={t("message.more")}
            className="data-[state=open]:bg-accent"
            disabled={actionsDisabled}
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              {t("message.exportMarkdown")}
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const AssistantToolGroup: FC<
  PropsWithChildren<{ group: ThreadGroupPart }>
> = ({ group, children }) => {
  const running = group.status.type === "running";
  const toolCount = group.indices.length;
  const [userOpen, setUserOpen] = useState(true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The group closes by itself when the last call in it settles (or when the
  // reader had already closed it while it was running) - deferred while that
  // would be visible.
  const [open, releaseCollapseGate] = useDeferredCollapse(
    rootRef,
    running || userOpen,
  );

  // A single call already has its own assistant-ui disclosure row. Avoid
  // adding a second nested "1 tool call" disclosure around it.
  if (toolCount === 1) return <>{children}</>;

  return (
    <ToolGroupRoot
      ref={rootRef}
      variant="ghost"
      open={open}
      onOpenChange={(nextOpen) => {
        releaseCollapseGate();
        setUserOpen(nextOpen);
      }}
    >
      <ToolGroupTrigger count={toolCount} active={running} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

/**
 * `partialResult` is Pi Desktop's own field (see ChatThread#toAssistantUiParts): the
 * output streamed while the tool is still executing. It cannot live in `result`
 * because assistant-ui treats a present `result` as "tool finished".
 */
type PiDesktopToolCallProps = ToolCallMessagePartProps & {
  partialResult?: string | undefined;
};

const AssistantToolCall = ({
  args,
  argsText,
  result,
  artifact,
  partialResult,
  status,
  toolName,
  isError,
}: PiDesktopToolCallProps) => {
  const running = status.type === "running";
  const t = useT();
  // Same rule as the reasoning group below: while a tool is running, its output has
  // to be on screen. The card used to start collapsed and nothing ever opened it, so
  // a 10s run showed nothing at all and then dumped the whole result at the end.
  // It auto-opens on start, auto-collapses on finish; an explicit click wins.
  const [intentOpen, setIntentOpen] = useState(running);
  const previousRunning = useRef(running);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // `open` is what the card *renders*: the auto-collapse waits until releasing
  // the height is invisible, so a reader parked mid-thread does not have their
  // text yanked up when a call settles inside their viewport.
  const [open, releaseCollapseGate] = useDeferredCollapse(rootRef, intentOpen);

  useEffect(() => {
    if (running !== previousRunning.current) {
      setIntentOpen(running);
      previousRunning.current = running;
    }
  }, [running]);

  return (
    <ToolCall
      ref={rootRef}
      label={
        isError
          ? t("process.toolFailed", { name: toolName })
          : t("process.toolUsed", { name: toolName })
      }
      activeLabel={t("process.toolRunning", { name: toolName })}
      query={toolQuery(args, toolName)}
      request={argsText}
      result={toolResult(result ?? artifact ?? partialResult, isError)}
      running={running}
      open={open}
      onOpenChange={(nextOpen) => {
        releaseCollapseGate();
        setIntentOpen(nextOpen);
      }}
    />
  );
};

const AssistantToolCallTyped = AssistantToolCall as unknown as ToolCallMessagePartComponent;

function toolQuery(args: unknown, toolName: string) {
  if (args && typeof args === "object") {
    const value = Object.values(args as Record<string, unknown>).find(
      (item) => typeof item === "string" && item.trim().length > 0,
    );
    if (typeof value === "string") {
      const preview = value.replace(/\s+/g, " ").trim();
      return preview.length > 64 ? `${preview.slice(0, 61)}...` : preview;
    }
  }
  return toolName;
}

function toolResult(result: unknown, isError?: boolean) {
  if (result === undefined || result === null) return "";
  const text =
    typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2) ?? String(result);
  return isError ? `Error: ${text}` : text;
}

const PiDesktopProcessGroup: FC<
  PropsWithChildren<{ group: ThreadGroupPart }>
> = ({ group, children }) => {
  const t = useT();
  const timing = useMessageTiming();
  const parts = useAuiState((state) => state.message.parts);
  const messageRunning = useAuiState(
    (state) => state.message.status?.type === "running",
  );
  const processRef = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollPositionLock(processRef);
  const { processCount, toolCount } = group.indices.reduce(
    (counts, index) => {
      const part = parts[index];
      if (part?.type === "tool-call") {
        counts.toolCount += 1;
        counts.processCount += 1;
      } else if (part?.type === "reasoning") {
        counts.processCount += 1;
      }
      return counts;
    },
    { processCount: 0, toolCount: 0 },
  );
  // The summary owns every process part for the whole turn, not just from the
  // moment the run ends, and it is open while the turn runs. That makes settling
  // one `open: true -> false` transition on a mounted, expanded block instead of a
  // subtree replacement, which is the only shape the collapse gate can defer: a
  // reader looking at the process area keeps it on screen and gets the summary when
  // they have scrolled away (or are pinned to the new line at the bottom).
  //
  // Tied to the message, never to `group.status`: an intermediate group can look
  // complete while a parallel tool or reasoning stream is still live, and closing
  // then would lift the answer that is still streaming underneath it.
  const [userOpen, setUserOpen] = useState(false);
  // An explicit click is the only thing that may show the summary header while the
  // group is open: unhidden, the header is a row in flow, so revealing it at settle
  // time would move the reader's line by itself.
  const [userTouched, setUserTouched] = useState(false);
  const [open, releaseCollapseGate] = useDeferredCollapse(
    processRef,
    messageRunning || userOpen,
  );
  const showSummaryHeader = !open || userTouched;
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setUserTouched(true);
      releaseCollapseGate();
      lockScroll();
      setUserOpen(open);
    },
    [lockScroll, releaseCollapseGate],
  );
  const elapsed = timing?.totalStreamTime
    ? ` ${Math.max(1, Math.round(timing.totalStreamTime / 1000))}s`
    : "";
  const toolPart = toolCount
    ? ` · ${t(toolCount === 1 ? "process.toolCount.one" : "process.toolCount.other", { count: toolCount })}`
    : processCount > 1
      ? ` · ${t("process.steps", { count: processCount })}`
      : "";
  const label = `${t("process.completed")}${elapsed}${toolPart}`;

  return (
    <Collapsible
      ref={processRef}
      data-slot="aui_process-group"
      data-live={messageRunning ? "true" : undefined}
      open={open}
      onOpenChange={handleOpenChange}
      className={showSummaryHeader ? "mb-3 w-full" : "w-full"}
    >
      <CollapsibleTrigger
        hidden={!showSummaryHeader}
        className="group/process-trigger text-muted-foreground hover:text-foreground flex items-center gap-1.5 py-1 text-[14px] transition-colors outline-none"
      >
        <ChevronRightIcon className="-ms-1 size-4 shrink-0 opacity-70 transition-transform duration-200 group-data-open/process-trigger:rotate-90" />
        <span className="leading-none tabular-nums">{label}</span>
      </CollapsibleTrigger>
      {/* Layout-neutral while the summary header is hidden: the process content has
          to sit exactly where it sat before this group existed. No `collapsePanel`
          either - it pins the height to Radix's measured value and animates a
          freshly-mounted panel from `h-0`, so the group would slide the already read
          text open the moment the first process part arrives. The animation belongs
          to the summary form, where a click is what opens it. */}
      <CollapsibleContent
        className={
          showSummaryHeader
            ? cn(collapsePanel, "overflow-hidden outline-none")
            : "overflow-hidden outline-none"
        }
      >
        <div
          className={
            showSummaryHeader ? "flex flex-col gap-2 ps-1 pt-2" : "contents"
          }
        >
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const AssistantReasoningGroup: FC<
  PropsWithChildren<{ group: ThreadGroupPart }>
> = ({ group, children }) => {
  const t = useT();
  const parts = useAuiState((s) => s.message.parts);
  const timing = useMessageTiming();
  // Keep the disclosure held for the entire message run, not just while its own
  // parts are streaming. Otherwise thinking collapses as soon as its
  // text finishes — even though the message is still producing tool calls or
  // further thinking steps — which is jarring during a live run. (Holding it open
  // must not be confused with claiming it is still thinking - see below.)
  const messageRunning = useAuiState(
    (s) => s.message.status?.type === "running",
  );
  const ownStreaming = useAuiState((s) => {
    if (s.message.status?.type !== "running") return false;
    return group.indices.some(
      (index) => s.message.parts[index]?.status.type === "running",
    );
  });
  // What the reader sees as “still thinking” (`streaming`: shimmer + the
  // bottom-pinned live preview) and what merely keeps the layout still
  // (`holdOpen`) are different questions. They used to be one value, which made
  // every reasoning panel look like it was still outputting for the whole turn -
  // see `reasoningGroupFlags`.
  const { streaming, holdOpen } = reasoningGroupFlags({ messageRunning, ownStreaming });
  const [intentOpen, setIntentOpen] = useState(holdOpen);
  const previousHoldOpen = useRef(holdOpen);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Thinking ends in the middle of a run, usually inside the reader's viewport:
  // closing it there would lift everything below it, so the gate holds the panel
  // open until the collapse happens out of sight.
  const [open, releaseCollapseGate] = useDeferredCollapse(rootRef, intentOpen);

  useEffect(() => {
    if (holdOpen !== previousHoldOpen.current) {
      setIntentOpen(holdOpen);
      previousHoldOpen.current = holdOpen;
    }
  }, [holdOpen]);

  const reasoningParts = useMemo(() => {
    return group.indices.flatMap((index) => {
      const part = parts[index];
      if (!part || part.type !== "reasoning") return [];
      return [part];
    });
  }, [group.indices, parts]);

  const renderedParts = Children.toArray(children);
  const duration = timing?.totalStreamTime
    ? Math.max(1, Math.round(timing.totalStreamTime / 1000))
    : undefined;

  return (
    <Reasoning.Root
      ref={rootRef}
      open={open}
      onOpenChange={(nextOpen) => {
        releaseCollapseGate();
        setIntentOpen(nextOpen);
      }}
      streaming={streaming}
      variant="ghost"
    >
      <Reasoning.Trigger active={streaming} duration={duration} />
      <Reasoning.Content aria-busy={streaming}>
        {/* No height cap: the block has to follow the output like the answer
            text does. The old `max-h-[7.5rem]` (5 lines at `leading-6`) turned
            the panel into an inner scroll box that pinned its own bottom, so
            the reader watched a moving five-line window instead of the
            thinking itself. The arbitrary value (`max-h-[none]`, not
            `max-h-none`) is deliberate: tailwind-merge 3.6 does not classify
            `max-h-none` as a `max-h` utility, so it would leave
            `ReasoningText`'s own `max-h-64` default in the class list and the
            cap would silently survive. Unbounded, the inner scroll/pin
            machinery is a no-op and the thread viewport keeps the newest line
            in view. */}
        <Reasoning.Text className="max-h-[none]">
          <div className="space-y-4">
            {renderedParts.map((part, index) => {
              const source = reasoningParts[index];
              const title =
                reasoningParts.length > 1
                  ? source?.unstable_summary?.trim() ||
                    t("process.stepTitle", { index: index + 1 })
                  : undefined;
              return (
                <div key={index} className="space-y-1">
                  {title ? (
                    <p className="text-foreground/90 text-[14px] leading-6 font-medium">
                      {title}
                    </p>
                  ) : null}
                  {part}
                </div>
              );
            })}
          </div>
        </Reasoning.Text>
      </Reasoning.Content>
    </Reasoning.Root>
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

const UserMessage: FC = () => {
  perfCount("render.userMessage");
  const entrance = useMessageEntrance();
  const custom = useAuiState((s) => s.message.metadata.custom);
  const inlineAttachmentHandlers = useContext(UserMessageInlineAttachmentContext);
  const fallbackText = useAuiState((s) => {
    const first = s.message.content[0];
    return first?.type === "text" ? first.text : "";
  });
  const inlineParts = Array.isArray(custom?.piDesktopInlineParts)
    ? (custom.piDesktopInlineParts as ChatMessagePart[])
    : [];
  const inlineAttachments = Array.isArray(custom?.piDesktopInlineAttachments)
    ? (custom.piDesktopInlineAttachments as ChatAttachment[])
    : [];
  const inlineText = typeof custom?.piDesktopInlineText === "string"
    ? custom.piDesktopInlineText
    : fallbackText;
  const hasPiDesktopInlineData =
    Array.isArray(custom?.piDesktopInlineParts) ||
    Array.isArray(custom?.piDesktopInlineAttachments) ||
    typeof custom?.piDesktopInlineText === "string";

  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className={`group grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 [&:where(>*)]:col-start-2 ${entrance}`}
      data-role="user"
    >
      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-xl px-4 py-2 text-[14px] leading-[1.6] wrap-break-word empty:hidden">
          {inlineParts.length > 0 ? (
            <InlineMessageParts
              parts={inlineParts}
              attachments={inlineAttachments}
              {...inlineAttachmentHandlers}
            />
          ) : hasPiDesktopInlineData ? (
            <>
              {inlineAttachments.map((attachment) => (
                <InlineAttachmentBadge
                  key={attachment.id}
                  attachment={attachment}
                  {...inlineAttachmentHandlers}
                />
              ))}
              <InlineMessageText text={inlineText} />
            </>
          ) : (
            <MessagePrimitive.Parts
              components={{ File: UserFilePart, Image: UserImagePart }}
            />
          )}
        </div>
        <UserMessageFooter />
      </div>
    </MessagePrimitive.Root>
  );
};

function InlineMessageParts({
  parts,
  attachments,
  onAttachmentHoverStart,
  onAttachmentHoverEnd,
}: {
  parts: ChatMessagePart[];
  attachments: ChatAttachment[];
} & UserMessageInlineAttachmentHandlers) {
  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  return (
    <>
      {parts.map((part, index) => {
        if (part.kind === "text") {
          return <InlineMessageText key={`text-${index}`} text={part.text} />;
        }
        if (part.kind === "capability") {
          return <InlineCapabilityBadge key={`capability-${part.capability.id}-${index}`} capability={part.capability} />;
        }
        const attachment = attachmentById.get(part.attachmentId);
        return attachment ? (
          <InlineAttachmentBadge
            key={`attachment-${part.attachmentId}-${index}`}
            attachment={attachment}
            onAttachmentHoverStart={onAttachmentHoverStart}
            onAttachmentHoverEnd={onAttachmentHoverEnd}
          />
        ) : null;
      })}
    </>
  );
}

function InlineMessageText({ text }: { text: string }) {
  return (
    <span className="inline-message-text">
      {text.split("\n").map((line, index) => (
        <Fragment key={`${index}-${line}`}>
          {index > 0 ? <br /> : null}
          <InlineLinkedText text={line} />
        </Fragment>
      ))}
    </span>
  );
}

function InlineLinkedText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/[^\s<]+)/gi).map((part, index) => {
        const match = part.match(/^(https?:\/\/[^\s<]*?)([),.;:!?]*)$/i);
        const url = match?.[1] ?? part;
        if (!canOpenTarget(url)) return <Fragment key={`${index}-${part}`}>{part}</Fragment>;
        return (
          <Fragment key={`${index}-${part}`}>
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(event) => {
                event.preventDefault();
                void openTarget(url);
              }}
            >
              {url}
            </a>
            {match?.[2]}
          </Fragment>
        );
      })}
    </>
  );
}

function InlineCapabilityBadge({
  capability,
}: {
  capability: Extract<ChatMessagePart, { kind: "capability" }>["capability"];
}) {
  const t = useT();
  return (
    <span
      className={`attachment-badge capability-badge ${capability.kind}`}
      {...capabilityBadgeAttributes(capability)}
    >
      <span className="attachment-badge-icon">S</span>
      <span className="attachment-badge-copy">
        <strong title={capability.name}>{capability.name}</strong>
        <small>{t("capability.kind.skill")}</small>
      </span>
    </span>
  );
}

function InlineAttachmentBadge({
  attachment,
  onAttachmentHoverStart,
  onAttachmentHoverEnd,
}: { attachment: ChatAttachment } & UserMessageInlineAttachmentHandlers) {
  const content = (
    <>
      {attachment.kind === "image" && attachment.previewUrl ? (
        <img src={attachment.previewUrl} alt="" />
      ) : (
        <span className="attachment-badge-icon"><FileTextIcon size={12} /></span>
      )}
      <span className="attachment-badge-copy">
        <strong title={attachment.name}>{attachment.name}</strong>
        <small>{formatInlineFileSize(attachment.size)}</small>
      </span>
    </>
  );
  if (canOpenTarget(attachment.sourcePath)) {
    return (
      <button
        type="button"
        className="attachment-badge is-openable"
        {...attachmentBadgeAttributes(attachment)}
        onClick={() => void openTarget(attachment.sourcePath!)}
        onMouseEnter={(event) => onAttachmentHoverStart?.(attachment, event.currentTarget)}
        onMouseLeave={() => onAttachmentHoverEnd?.()}
        aria-label={`Open ${attachment.name}`}
        title={`Open ${attachment.name}`}
      >
        {content}
      </button>
    );
  }
  return (
    <span
      className="attachment-badge"
      {...attachmentBadgeAttributes(attachment)}
      onMouseEnter={(event) => onAttachmentHoverStart?.(attachment, event.currentTarget)}
      onMouseLeave={() => onAttachmentHoverEnd?.()}
    >
      {content}
    </span>
  );
}

function formatInlineFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

const UserMessageFooter: FC = () => {
  const t = useT();
  const locale = useLocale();
  const actionsDisabled = useActionsDisabled();
  const createdAt = useAuiState((s) => s.message.createdAt);
  const messageId = useAuiState((s) => s.message.id);
  const custom = useAuiState((s) => s.message.metadata.custom);
  const plainText = useAuiState((s) => {
    const first = s.message.content[0];
    return first?.type === "text" ? first.text : "";
  });
  const { onEditMessage } = useContext(UserMessageActionsContext);
  const [copied, setCopied] = useState(false);
  const timestamp = useMemo(() => formatMessageTime(createdAt, locale), [createdAt, locale]);

  // 普通文本还是带 badge 的富文本，取决于这条消息有没有 pi 自带的 parts；
  // 复制出来的 HTML 让粘贴回 composer 时能还原 inline badge。
  const copyMessage = useCallback(() => {
    const parts = Array.isArray(custom?.piDesktopInlineParts)
      ? (custom.piDesktopInlineParts as ChatMessagePart[])
      : [];
    const attachments = Array.isArray(custom?.piDesktopInlineAttachments)
      ? (custom.piDesktopInlineAttachments as ChatAttachment[])
      : [];
    const html = parts.length ? userMessageClipboardHtml(parts, attachments) : "";
    void writeClipboardRichText(plainText, html).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [custom, plainText]);

  return (
    <div className="aui-user-message-footer pointer-events-none mt-1 flex items-center justify-end gap-1.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
      <time dateTime={createdAt.toISOString()}>{timestamp}</time>
      <ActionBarPrimitive.Root className="aui-user-message-actions flex items-center gap-0.5">
        <TooltipIconButton
          tooltip={t("message.copy")}
          side="top"
          className="aui-user-action-copy"
          disabled={actionsDisabled}
          onClick={copyMessage}
        >
          {copied ? <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" /> : <CopyIcon />}
        </TooltipIconButton>
        {onEditMessage ? (
          <TooltipIconButton
            tooltip={t("message.edit")}
            side="top"
            className="aui-user-action-edit"
            disabled={actionsDisabled}
            onClick={() => onEditMessage(messageId)}
          >
            <PencilIcon />
          </TooltipIconButton>
        ) : null}
      </ActionBarPrimitive.Root>
    </div>
  );
};

function formatMessageTime(date: Date, locale: string) {
  const tag = locale.startsWith("zh") ? "zh-CN" : "en-US";
  try {
    return new Intl.DateTimeFormat(tag, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg)">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-3.5"
            >
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 rounded-full px-3.5">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};
