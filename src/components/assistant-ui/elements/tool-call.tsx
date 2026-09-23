"use client";

import { CheckIcon, ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  collapsePanel,
  field,
  mono,
  ShimmerLabel,
  SwapLabel,
  useScrollPositionLock,
} from "./surfaces";
import { useCallback, useRef, type Ref } from "react";
import { useT } from "@/i18n/react";

export interface ToolCallProps {
  label: string;
  activeLabel: string;
  query: string;
  request: string;
  result: string;
  running: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  /**
   * The collapsible root, so the caller can measure the block a deferred
   * auto-collapse is about to shrink (see `useDeferredCollapse`). Composed with
   * the ref the scroll lock already uses.
   */
  ref?: Ref<HTMLDivElement>;
}

/** Official assistant-ui ToolCall element with a compact argument preview. */
export function ToolCall({
  label,
  activeLabel,
  query,
  request,
  result,
  running,
  open,
  onOpenChange,
  className,
  ref,
}: ToolCallProps) {
  const collapsibleRef = useRef<HTMLDivElement | null>(null);
  const lockScroll = useScrollPositionLock(collapsibleRef);
  const t = useT();
  const composedRef = useCallback(
    (node: HTMLDivElement | null) => {
      collapsibleRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        (ref as { current: HTMLDivElement | null }).current = node;
      }
    },
    [ref],
  );

  return (
    <Collapsible
      ref={composedRef}
      data-slot="tool-call"
      open={open}
      onOpenChange={(nextOpen) => {
        lockScroll();
        onOpenChange(nextOpen);
      }}
      className={cn("w-full max-w-[min(42rem,100%)]", className)}
    >
      <CollapsibleTrigger className="group/trigger text-foreground/65 hover:text-foreground/95 flex items-center gap-1.5 rounded-md py-1 text-[14px] leading-6 transition-colors outline-none">
        <ChevronRightIcon className="-ms-1 size-4 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-90 group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none" />
        <SwapLabel active={running ? 0 : 1} className="text-start">
          <ShimmerLabel
            active={running}
            className="relative inline-block leading-tight"
          >
            {activeLabel}
          </ShimmerLabel>
          <>{label}</>
        </SwapLabel>
        <span
          className={cn(
            mono,
            "bg-foreground/[0.06] text-foreground/75 min-w-0 max-w-[min(32rem,55vw)] truncate whitespace-nowrap rounded-md px-2 py-0.5",
          )}
        >
          {query}
        </span>
        <span className="ms-auto flex w-4 items-center justify-end">
          {!running && (
            <CheckIcon className="fade-in zoom-in-90 animate-in size-4 text-emerald-500 duration-200" />
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <div className={cn(field, "mt-1.5 overflow-hidden rounded-2xl text-sm")}>
          <div className="px-4 pt-3 pb-3">
            <p className={cn(mono, "text-foreground/35 mb-1")}>{t("process.request")}</p>
            <p className="text-foreground/60 font-mono text-[13px] leading-relaxed break-words">
              {request}
            </p>
          </div>
          <div className="bg-foreground/[0.06] mx-4 h-px" />
          <div className="px-4 pt-3 pb-3.5">
            <p className={cn(mono, "text-foreground/35 mb-1")}>{t("process.result")}</p>
            <pre className="text-foreground/90 max-h-64 overflow-y-auto text-[13px] leading-5 whitespace-pre-wrap">
              {result}
            </pre>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
