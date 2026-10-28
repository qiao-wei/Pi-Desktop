"use client";

/**
 * The two small readouts a tool row can carry: the `+N −M` change count and the
 * failure word.
 *
 * Split out of `tool-row.tsx` to stay under the file-size ratchet, and because both
 * are self-contained: ZCode's `renderDiffCount` animates the count in on mount, and its
 * status word only exists when it carries information (a failure), never on a
 * successful row.
 */

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useT } from "@/i18n/react";

/** ZCode's animated `+N −M` (see `renderDiffCount`). */
export function DiffCount({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono leading-none whitespace-nowrap tabular-nums">
      {added > 0 ? (
        <span aria-label={`+${added}`} className="inline-flex items-center text-diff-added" role="text">
          +{added}
        </span>
      ) : null}
      {removed > 0 ? (
        <span
          aria-label={`-${removed}`}
          className="inline-flex items-center text-diff-removed"
          role="text"
        >
          −{removed}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The failure word: dotted underline, error in a tooltip, and a copy button.
 * ZCode only shows a status word when it carries information (failure / stopped),
 * which is why a successful run has no "Completed" on every row.
 */
export function StatusWord({ label, tooltip }: { label: string; tooltip?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  if (!tooltip) {
    return <span className="shrink-0 whitespace-nowrap">{label}</span>;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help shrink-0 whitespace-nowrap underline decoration-dotted underline-offset-2">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-96">
          <div className="flex max-w-96 items-center gap-2">
            <span className="line-clamp-3 min-w-0 flex-1 break-words whitespace-pre-wrap">
              {tooltip}
            </span>
            <button
              type="button"
              className="shrink-0 text-background/70 hover:text-background"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void navigator.clipboard.writeText(tooltip).then(() => {
                  setCopied(true);
                  if (resetTimer.current !== null) {
                    window.clearTimeout(resetTimer.current);
                  }
                  resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
                });
              }}
              title={t(copied ? "process.tool.copyError.copied" : "process.tool.copyError")}
              aria-label={t(copied ? "process.tool.copyError.copied" : "process.tool.copyError")}
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </button>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}