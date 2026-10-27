"use client";

/**
 * One reasoning ("thinking") block, rendered the way ZCode renders one
 * (`packages/ui/src/components/ai-elements/reasoning.tsx` +
 * `ReasoningRowView`).
 *
 * The shape is:
 *
 *   [brain] Thinking · <tail of the newest line>           ← while streaming
 *   [brain] Thought · 12 seconds                      [v]  ← once settled
 *
 * and the body is plain text on a left rail, not markdown and not a panel: a
 * thought stream is raw text, and re-parsing it per chunk was the reason the old
 * live preview stuttered.
 *
 * Both states are collapsed by default. ZCode keeps `defaultOpen={false}` and
 * only *auto*-collapses on an output boundary (and never after the reader has
 * touched it), which for a default-closed row is a no-op — so this component has
 * no auto behaviour at all: it is a disclosure, and the reader owns it.
 */

import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useT } from "@/i18n/react";
import { cn } from "@/lib/utils";
import { lastReasoningLine, reasoningSeconds } from "@/shared/reasoningText";

import { ShimmerLabel } from "./surfaces";

const CONTENT_UNMOUNT_DELAY_MS = 300;

const REASONING_SUMMARY_MASK =
  "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)";

export interface ThinkingRowProps {
  text: string;
  status?: { type: string };
}

export function ThinkingRow({ text, status }: ThinkingRowProps) {
  const t = useT();
  const streaming = status?.type === "running";
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const startedAt = useRef<number | null>(null);

  // ZCode times a thought client-side: start at the first streaming render, stop
  // when it settles. A row rebuilt from a transcript never streamed here, so it
  // has no duration and says "a few seconds" instead of inventing one.
  useEffect(() => {
    if (streaming) {
      if (startedAt.current === null) {
        startedAt.current = Date.now();
      }
      return;
    }
    if (startedAt.current !== null) {
      const seconds = reasoningSeconds(startedAt.current);
      startedAt.current = null;
      setDuration(seconds);
    }
  }, [streaming]);

  const [shouldRenderContent, setShouldRenderContent] = useState(false);
  const unmountTimer = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      if (unmountTimer.current !== null) {
        window.clearTimeout(unmountTimer.current);
        unmountTimer.current = null;
      }
      setShouldRenderContent(true);
      return;
    }
    if (!shouldRenderContent) {
      return;
    }
    unmountTimer.current = window.setTimeout(() => {
      setShouldRenderContent(false);
      unmountTimer.current = null;
    }, CONTENT_UNMOUNT_DELAY_MS);
    return () => {
      if (unmountTimer.current !== null) {
        window.clearTimeout(unmountTimer.current);
        unmountTimer.current = null;
      }
    };
  }, [open, shouldRenderContent]);

  // An empty streaming thought has nothing to say yet; ZCode renders nothing at
  // all rather than an empty row that would push the answer down.
  if (streaming && text.length === 0) {
    return null;
  }

  const summary = streaming && !open ? lastReasoningLine(text) : null;
  const label = streaming
    ? null
    : duration === undefined
      ? t("process.reasoning.durationFewSeconds")
      : t("process.reasoning.durationSeconds", { seconds: duration });

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex w-full flex-col">
      <CollapsibleTrigger
        data-slot="thinking-trigger"
        className="group/reasoning inline-flex max-w-full min-w-0 items-center gap-2 self-start text-ui-base transition-colors"
      >
        <BrainIcon className="size-4 shrink-0 text-foreground-subtlest" />
        <span className="shrink-0 whitespace-nowrap" data-reasoning-label="true">
          {streaming ? (
            <ShimmerLabel className="font-medium text-foreground-subtlest">
              {t("process.reasoning.thinking")}
            </ShimmerLabel>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span className="font-medium text-foreground-subtlest">
                {t("process.reasoning.thought")}
              </span>
              <span className="font-normal text-foreground-subtlest">·</span>
              <span className="font-normal text-foreground-subtlest">{label}</span>
            </span>
          )}
        </span>
        {summary !== null ? (
          <>
            <span className="shrink-0 text-foreground-subtlest">·</span>
            <StreamingSummary key={summary.key} text={summary.text} />
          </>
        ) : null}
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-foreground-subtlest transition-opacity transition-transform",
            open ? "rotate-90 opacity-100" : "rotate-0 opacity-0 group-hover/reasoning:opacity-100",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        data-slot="thinking-content"
        className={cn(
          "overflow-hidden outline-none",
          "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
          "data-closed:fill-mode-forwards",
        )}
      >
        {shouldRenderContent ? (
          <div className="pt-3">
            <div
              data-slot="thinking-text"
              className="ml-2 max-h-60 space-y-2 overflow-auto border-border border-l pl-3.5 text-ui-base text-foreground-subtlest"
            >
              <div className="min-w-0 break-words whitespace-pre-wrap text-foreground-subtlest">
                {text}
              </div>
            </div>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function StreamingSummary({ text }: { text: string }) {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  // A masked single-line viewport scrolled to the end: the newest tokens stay
  // visible and the older ones slide out to the left, instead of the line just
  // being cut off at the right edge.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return undefined;
    }
    const sync = () => {
      setOverflowing(viewport.scrollWidth > viewport.clientWidth + 1);
      viewport.scrollLeft = viewport.scrollWidth;
    };
    sync();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    return () => observer.disconnect();
    // 每次追加的文本都可能改变这一行的宽度，所以 `text` 是重新测量的触发条件；
    // effect 体内不需要读它（量的是 DOM）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <span
      ref={viewportRef}
      data-reasoning-streaming-line="true"
      className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-foreground-subtle"
      style={maskStyle(overflowing)}
    >
      <span className="inline-block min-w-max">{text}</span>
    </span>
  );
}

function maskStyle(isOverflowing: boolean): CSSProperties | undefined {
  if (!isOverflowing) {
    return undefined;
  }
  return {
    WebkitMaskImage: REASONING_SUMMARY_MASK,
    maskImage: REASONING_SUMMARY_MASK,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
  };
}