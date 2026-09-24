import { X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  createWheelStepReader,
  parseTerminalLines,
  readRowTargets,
  stripTerminalSequences,
  TERMINAL_KEYS,
  type TerminalLine,
  type TerminalRowTarget,
  type TerminalSegment,
  type TerminalStyle,
} from "@/shared/terminalText.ts";
import type { ExtensionUiRequest, ExtensionUiResponse } from "../lib/api";
import { useT } from "../i18n/react";
import type { ExtensionUiMode } from "../types";

/**
 * An extension panel (`ctx.ui.custom()`) shown inside the window.
 *
 * Extensions only ever hand us terminal lines, so there are two ways to present them:
 *
 * - `tui` (default) - the historical view: escapes stripped, plain monospace text, keyboard
 *   buttons underneath. Nothing is inferred, so it always matches what a terminal shows.
 * - `webui` - the same lines, but parsed: colours/weights/links become DOM styles and rows the
 *   extension's cursor can reach become clickable. A click is not a new API: it is translated
 *   into the keystrokes a keyboard user would send (`readRowTargets`), which keeps the panel's
 *   own state machine in charge. The setting lives in 设置 → 个性化.
 */
export function ExtensionCustomUiPanel({
  request,
  onRespond,
  onCancelled,
}: {
  request: Extract<ExtensionUiRequest, { method: "custom" }>;
  onRespond: (response: ExtensionUiResponse) => void;
  onCancelled?: () => void;
}) {
  const t = useT();
  const panelRef = useRef<HTMLElement | null>(null);
  const renderMode: ExtensionUiMode = request.renderMode === "webui" ? "webui" : "tui";

  const parsedLines = useMemo(
    () => (renderMode === "webui" ? parseTerminalLines(request.lines ?? []) : []),
    [renderMode, request.lines],
  );
  const rowTargets = useMemo(
    () => (renderMode === "webui" ? readRowTargets(parsedLines) : new Map<number, TerminalRowTarget>()),
    [renderMode, parsedLines],
  );

  useEffect(() => {
    panelRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      const input = event.ctrlKey && event.key.length === 1
        ? String.fromCharCode(event.key.toLowerCase().charCodeAt(0) - 96)
        : event.key === "ArrowUp"
          ? TERMINAL_KEYS.up
          : event.key === "ArrowDown"
            ? TERMINAL_KEYS.down
            : event.key === "Enter"
              ? TERMINAL_KEYS.enter
              : event.key === " "
                ? TERMINAL_KEYS.space
                : event.key === "Escape"
                  ? "\u001b"
                  : event.key === "Backspace"
                    ? "\u007f"
                    : event.key === "Tab"
                      ? "\t"
                      : event.key.length === 1 && !event.metaKey && !event.altKey
                        ? event.key
                        : "";
      if (!input) return;
      event.preventDefault();
      event.stopPropagation();
      if (input === "\u001b") {
        onCancelled?.();
        onRespond({ id: request.id, cancelled: true });
      } else {
        onRespond({ id: request.id, input });
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onRespond, request.id]);

  function send(input: string) {
    onRespond({ id: request.id, input });
  }

  function cancel() {
    onCancelled?.();
    onRespond({ id: request.id, cancelled: true });
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/25 p-5 backdrop-blur-sm"
      role="presentation"
    >
      <section
        ref={panelRef}
        className="grid max-h-[min(760px,calc(100vh-48px))] w-[min(920px,calc(100vw-48px))] gap-4 overflow-hidden rounded-lg border bg-background p-[22px] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-custom-ui-title"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Pi extension</p>
            <h2 id="extension-custom-ui-title" className="text-[1.08rem] font-semibold">{request.title}</h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={cancel}
            aria-label="Close extension panel"
            title="Close"
          >
            <X />
          </Button>
        </div>

        {renderMode === "webui" ? (
          <ExtensionPanelRows
            lines={parsedLines}
            targets={rowTargets}
            rowHint={t("terminal.rowHint")}
            scrollHint={t("terminal.scrollHint")}
            onRowActivate={(target) => onRespond({ id: request.id, inputs: target.keys })}
            onStep={(steps) =>
              onRespond({
                id: request.id,
                // Navigation only: a wheel never confirms, so a stray flick cannot activate anything.
                inputs: Array.from({ length: Math.abs(steps) }, () =>
                  steps < 0 ? TERMINAL_KEYS.up : TERMINAL_KEYS.down,
                ),
              })
            }
          />
        ) : (
          <pre className="max-h-[min(560px,calc(100vh-210px))] min-h-[240px] overflow-auto rounded-md border bg-muted p-4 font-mono text-xs leading-normal whitespace-pre">
            {(request.lines ?? []).map((line) => stripTerminalSequences(line)).join("\n")}
          </pre>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {([
            [t("terminal.key.up"), () => send(TERMINAL_KEYS.up)],
            [t("terminal.key.down"), () => send(TERMINAL_KEYS.down)],
            [t("terminal.key.space"), () => send(TERMINAL_KEYS.space)],
            [t("terminal.key.enter"), () => send(TERMINAL_KEYS.enter)],
            [t("terminal.key.save"), () => send("\u0013")],
            [t("terminal.key.close"), cancel],
          ] as const).map(([label, onClick]) => (
            <Button key={label} type="button" variant="outline" size="sm" className="min-w-[52px]" onClick={onClick}>
              {label}
            </Button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ExtensionPanelRows({
  lines,
  targets,
  rowHint,
  scrollHint,
  onRowActivate,
  onStep,
}: {
  lines: TerminalLine[];
  targets: Map<number, TerminalRowTarget>;
  rowHint: string;
  scrollHint: string;
  onRowActivate: (target: TerminalRowTarget) => void;
  /** Signed arrow-key steps from a wheel gesture (negative = up). */
  onStep: (steps: number) => void;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cursorRowRef = useRef<HTMLDivElement | null>(null);
  const wheelSteps = useRef(createWheelStepReader());
  const stepHandler = useRef<(event: WheelEvent) => void>(() => {});

  const navigable = targets.size > 0;

  useEffect(() => {
    // Keep the native listener reading the *current* props (the panel re-renders on every frame).
    stepHandler.current = (event) => {
      // Shift (or ⌘/ctrl) keeps the native scroll, so a panel taller than the viewport stays pan-able.
      if (!navigable || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      const steps = wheelSteps.current.push(event, performance.now());
      // Claim the gesture even while it is only accumulating, otherwise the list scrolls and the
      // cursor moves at the same time.
      event.preventDefault();
      if (steps !== 0) onStep(steps);
    };
  });

  useEffect(() => {
    // React registers `onWheel` passively, so the listener has to be attached by hand to be able
    // to preventDefault and keep the container from scrolling under the cursor.
    const node = gridRef.current;
    if (!node) return;
    const listener = (event: WheelEvent): void => stepHandler.current(event);
    node.addEventListener("wheel", listener, { passive: false });
    return () => node.removeEventListener("wheel", listener);
  }, []);

  useEffect(() => {
    // The panel re-renders its own window around the cursor; keep that row on screen after a
    // wheel step or a click (and reset the scroll offset when the window shifts).
    cursorRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [lines]);

  return (
    <div className="grid gap-1.5">
      <div
        ref={gridRef}
        className="max-h-[min(560px,calc(100vh-240px))] min-h-[240px] overflow-auto rounded-md border bg-muted p-3"
      >
        <div className="grid font-mono text-xs leading-normal whitespace-pre" role="presentation">
          {lines.map((line, index) => {
            const target = targets.get(index);
            return (
              <div
                key={index}
                ref={target?.cursor ? cursorRowRef : undefined}
                role={target ? "button" : undefined}
                aria-label={target ? line.text.trim() : undefined}
                title={target ? rowHint : undefined}
                className={cn(
                  "min-h-[1.25em] rounded-[3px] px-0.5",
                  target?.cursor && "bg-accent",
                  target && !target.cursor && "hover:bg-accent/50",
                  target && "cursor-pointer",
                )}
                onClick={target ? () => onRowActivate(target) : undefined}
              >
                {line.segments.length === 0
                  ? "\u00a0"
                  : line.segments.map((segment, segmentIndex) => (
                      <TerminalSegmentView key={segmentIndex} segment={segment} />
                    ))}
              </div>
            );
          })}
        </div>
      </div>
      {navigable ? <p className="px-0.5 text-[0.7rem] text-muted-foreground">{scrollHint}</p> : null}
    </div>
  );
}

/** ANSI foreground tokens → app palette. Bright/dim pairs share a class: they read the same here. */
const FOREGROUND_CLASSES: Record<string, string> = {
  "ansi-black": "text-muted-foreground",
  "ansi-bright-black": "text-muted-foreground",
  "ansi-red": "text-rose-600 dark:text-rose-400",
  "ansi-bright-red": "text-rose-600 dark:text-rose-400",
  "ansi-green": "text-emerald-600 dark:text-emerald-400",
  "ansi-bright-green": "text-emerald-600 dark:text-emerald-400",
  "ansi-yellow": "text-amber-600 dark:text-amber-400",
  "ansi-bright-yellow": "text-amber-600 dark:text-amber-400",
  "ansi-blue": "text-sky-600 dark:text-sky-400",
  "ansi-bright-blue": "text-sky-600 dark:text-sky-400",
  "ansi-magenta": "text-fuchsia-600 dark:text-fuchsia-400",
  "ansi-bright-magenta": "text-fuchsia-600 dark:text-fuchsia-400",
  "ansi-cyan": "text-sky-600 dark:text-sky-400",
  "ansi-bright-cyan": "text-sky-600 dark:text-sky-400",
  "ansi-white": "text-foreground",
  "ansi-bright-white": "text-foreground",
};

/** Backgrounds are painted as tints: extension panels only use them behind short labels. */
const BACKGROUND_CLASSES: Record<string, string> = {
  "ansi-black": "bg-muted",
  "ansi-bright-black": "bg-muted",
  "ansi-red": "bg-rose-500/15",
  "ansi-bright-red": "bg-rose-500/15",
  "ansi-green": "bg-emerald-500/15",
  "ansi-bright-green": "bg-emerald-500/15",
  "ansi-yellow": "bg-amber-500/15",
  "ansi-bright-yellow": "bg-amber-500/15",
  "ansi-blue": "bg-sky-500/15",
  "ansi-bright-blue": "bg-sky-500/15",
  "ansi-magenta": "bg-fuchsia-500/15",
  "ansi-bright-magenta": "bg-fuchsia-500/15",
  "ansi-cyan": "bg-sky-500/15",
  "ansi-bright-cyan": "bg-sky-500/15",
  "ansi-white": "bg-accent",
  "ansi-bright-white": "bg-accent",
};

function TerminalSegmentView({ segment }: { segment: TerminalSegment }) {
  const className = styleClass(segment.style);
  const style = styleObject(segment.style);

  if (segment.style.link) {
    return (
      <a className={cn(className, "underline")} href={segment.style.link} style={style} rel="noreferrer" target="_blank">
        {segment.text}
      </a>
    );
  }
  if (className === undefined && style === undefined) return segment.text;
  return (
    <span className={className} style={style}>
      {segment.text}
    </span>
  );
}

function styleClass(style: TerminalStyle): string | undefined {
  return (
    cn(
      style.color ? FOREGROUND_CLASSES[style.color] : undefined,
      style.background ? BACKGROUND_CLASSES[style.background] : undefined,
      style.bold && "font-semibold",
      style.dim && "opacity-65",
      style.italic && "italic",
      style.underline && "underline",
      style.strike && "line-through",
      style.inverse && "bg-primary text-primary-foreground",
    ) || undefined
  );
}

/** Truecolor arrives as a ready CSS colour, so it is applied inline instead of by class. */
function styleObject(style: TerminalStyle): { color?: string; backgroundColor?: string } | undefined {
  const color = !style.color?.startsWith("ansi-") ? style.color : undefined;
  const backgroundColor = !style.background?.startsWith("ansi-") ? style.background : undefined;
  if (color === undefined && backgroundColor === undefined) return undefined;
  return { ...(color ? { color } : {}), ...(backgroundColor ? { backgroundColor } : {}) };
}