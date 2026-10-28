"use client";

/**
 * One tool call, rendered the way ZCode renders one.
 *
 * The grammar is ZCode's (`packages/ui/src/ToolCallBlocks/ToolLayout.tsx` +
 * `ToolSummaryRow.tsx`), and it is deliberately small:
 *
 *   [icon] [kind verb] [detail] · [target] [path] (+12 −3) [status] [chevron]
 *
 * - the row is the whole affordance; the chevron only exists on hover (or while
 *   open), so a settled run of tools reads as a list of actions, not as a stack
 *   of boxes;
 * - the kind verb shimmers while the call runs and becomes the settled noun
 *   after (`Reading` → `Read`, `Running` → `Terminal`), which is how ZCode says
 *   "still going" without a spinner per row;
 * - a status *word* only appears when there is something to say — a failure
 *   (`Failed`, dotted-underlined, with the error in a tooltip you can copy from)
 *   or an unknown tool's lifecycle word;
 * - nothing auto-opens and nothing auto-collapses (ZCode's `autoOpen` defaults
 *   to false and only its Agent renderer passes `autoCollapseOnComplete`), so a
 *   long run shows the rows moving and one click shows the body.
 *
 * The body is chosen from {@link ToolDisplay}, which the projection derived from
 * pi's result envelope, so this file never parses tool output: `edit`/`write`
 * render an inline diff, `bash`/`powershell` a terminal, MCP a result-first
 * panel, and everything else parameters + result.
 */

import { ChevronRightIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useT } from "@/i18n/react";
import { cn } from "@/lib/utils";
import { toolRowFamily, type ToolDisplay } from "@/shared/toolDisplay";

import { KIND_LABEL_CLASS, resolvePresentation } from "./tool-row-presentation";
import { DiffCount, StatusWord } from "./tool-row-readouts";

/* -------------------------------------------------------------------------- */
/* Workspace-relative paths                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Tool arguments carry absolute paths, and a row that shows
 * `/Users/x/proj/src/components/a.ts` buries the only part that identifies the
 * file. ZCode relativizes against the workspace for the same reason; the root is
 * provided by the chat host because this element has no idea which project it is
 * rendering.
 */
const WorkspaceRootContext = createContext("");

export function ToolRowWorkspaceProvider({
  root,
  children,
}: {
  root: string;
  children: ReactNode;
}) {
  return <WorkspaceRootContext.Provider value={root}>{children}</WorkspaceRootContext.Provider>;
}

/**
 * How a row opens the file it points at in the host's right panel.
 *
 * Provided by the chat host (`ChatThread`) like the workspace root, because a row has
 * no idea whether a panel exists (a read-only replay has none) — with no provider the
 * name simply stays plain text instead of becoming a button that does nothing.
 */
const FileOpenContext = createContext<((path: string) => void) | undefined>(undefined);

export function ToolRowFileOpenProvider({
  onOpenFile,
  children,
}: {
  onOpenFile?: ((path: string) => void) | undefined;
  children: ReactNode;
}) {
  return <FileOpenContext.Provider value={onOpenFile}>{children}</FileOpenContext.Provider>;
}

const CONTENT_UNMOUNT_DELAY_MS = 300;

/** The summary row, verbatim from ZCode's `ToolSummaryRow`. */
const SUMMARY_ROW_CLASS =
  "group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SUMMARY_CONTENT_CLASS =
  "min-w-0 flex max-w-full items-center gap-2 text-foreground-subtlest";


/* -------------------------------------------------------------------------- */
/* Row                                                                        */
/* -------------------------------------------------------------------------- */

export interface ToolRowProps {
  toolCallId?: string;
  toolName: string;
  args?: unknown;
  argsText?: string;
  /** Settled result text (assistant-ui only sets it once the call finished). */
  result?: string;
  /** Pi Desktop's in-flight output: a present `result` would mean "finished". */
  partialResult?: string;
  isError?: boolean;
  /**
   * assistant-ui's part status (`{ type: "running" | "complete" | ... }`). The slot
   * component is rendered as `<ToolFallbackComponent {...part} />`, so this is the
   * field that actually says whether the call is in flight — before this was read,
   * `running` fell back to `false` and every verb sat in its settled form, which is
   * the same as showing nothing at all.
   */
  status?: { type: string };
  /** Explicit override, for tests and for callers that already know. */
  running?: boolean;
  display?: ToolDisplay;
  /** `resultText` 是被预算裁过的（原文更大）。 */
  resultTruncated?: { bytes: number; lines: number };
}

export function ToolRow({
  toolCallId,
  toolName,
  args,
  argsText,
  result,
  partialResult,
  isError,
  status,
  running,
  display,
  resultTruncated,
}: ToolRowProps) {
  const t = useT();
  const workspaceRoot = useContext(WorkspaceRootContext);
  const family = toolRowFamily(toolName);
  // `status` is the real source; `running` stays for direct callers. A settled
  // transcript has no `status`, and must never render as running.
  const isRunning = running ?? status?.type === "running";
  const resultText = result ?? partialResult ?? "";
  const presentation = useMemo(
    () =>
      resolvePresentation({ t, family, toolName, args, display, running: isRunning, workspaceRoot }),
    [args, display, family, isRunning, t, toolName, workspaceRoot],
  );

  const body = presentation.body;
  const renderBody = useCallback(() => {
    if (!body) {
      return null;
    }
    return body({ display, argsText, resultText, resultTruncated, isError: Boolean(isError), t });
  }, [argsText, body, display, isError, resultText, resultTruncated, t]);

  return (
    <ToolRowLayout
      toolCallId={toolCallId}
      icon={presentation.icon}
      kindLabel={presentation.kindLabel}
      kindDetail={presentation.kindDetail}
      primaryText={presentation.primaryText}
      filePath={presentation.filePath}
      secondaryText={presentation.secondaryText}
      separator={presentation.separator}
      diff={presentation.diff}
      statusLabel={isError ? t("process.status.failed") : presentation.statusLabel}
      statusTooltip={isError ? resultText : undefined}
      running={isRunning}
      title={presentation.title}
      canToggle={presentation.canToggle && body !== undefined}
      renderBody={renderBody}
    />
  );
}


function ToolRowLayout({
  toolCallId,
  icon,
  kindLabel,
  kindDetail,
  primaryText,
  filePath,
  secondaryText,
  separator,
  diff,
  statusLabel,
  statusTooltip,
  running,
  title,
  canToggle,
  renderBody,
}: {
  toolCallId?: string;
  icon: ReactNode;
  kindLabel: ReactNode;
  kindDetail?: ReactNode;
  primaryText?: ReactNode;
  filePath?: string;
  secondaryText?: ReactNode;
  separator?: ReactNode;
  diff?: { added: number; removed: number };
  statusLabel?: string;
  statusTooltip?: string;
  running: boolean;
  title?: string;
  canToggle: boolean;
  renderBody: () => ReactNode;
}) {
  const t = useT();
  const openFile = useContext(FileOpenContext);
  const [open, setOpen] = useState(false);
  const expanded = canToggle && open;
  // Radix reads `--radix-collapsible-content-height` during the close animation;
  // unmounting the body first makes that variable vanish and the panel collapse
  // against the *previous* message height. ZCode holds the children for 300ms for
  // exactly this reason; so do we.
  const [shouldRenderContent, setShouldRenderContent] = useState(false);
  const unmountTimer = useRef<number | null>(null);

  useEffect(() => {
    if (expanded) {
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
  }, [expanded, shouldRenderContent]);

  const hasContent = [primaryText, secondaryText, diff, statusLabel].some(
    (node) => node !== undefined,
  );

  const summaryContent = (
    <>
      <span className="shrink-0 text-foreground-subtlest [&_svg]:text-foreground-subtlest">
        {icon}
      </span>
      <span
        data-slot="tool-row-kind"
        data-running={running ? "" : undefined}
        className={cn(
          KIND_LABEL_CLASS,
          // `shimmer-spread` / `shimmer-angle` are load-bearing for short labels: the
          // plugin's defaults (4ch + 80px spread, 200px track, 15°) put a *four-character*
          // verb (「正在写入」) permanently inside the soft band, so it reads as dim grey
          // instead of "solid text with a highlight passing over it". A narrow, unangled
          // band keeps the text at full strength and only sweeps a stripe across it.
          running ? "shimmer shimmer-spread-30 shimmer-angle-0 motion-reduce:animate-none" : "text-foreground-subtlest",
        )}
      >
        {kindLabel}
      </span>
      {kindDetail ? <span className="min-w-0 shrink-0">{kindDetail}</span> : null}
      {hasContent ? (
        <div className={SUMMARY_CONTENT_CLASS}>
          {separator !== undefined ? (
            <span className="shrink-0 text-foreground-subtlest">{separator}</span>
          ) : null}
          {primaryText && filePath && openFile ? (
            // ZCode's `renderFileChip`: the *name* opens the file viewer, while the
            // rest of the row (path, diff count, chevron) toggles the inline body.
            // Both `stopPropagation` calls are load-bearing: the row is a Radix
            // collapsible trigger, and a click that reached it would also expand.
            <button
              type="button"
              data-slot="tool-row-file-link"
              className="inline-flex min-w-0 max-w-full cursor-pointer items-center text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={filePath}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                openFile(filePath);
              }}
            >
              {primaryText}
            </button>
          ) : (
            primaryText
          )}
          {secondaryText}
          {diff ? <DiffCount added={diff.added} removed={diff.removed} /> : null}
          {statusLabel ? <StatusWord label={statusLabel} tooltip={statusTooltip} /> : null}
        </div>
      ) : null}
    </>
  );

  const chevron = canToggle ? (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0 text-foreground-subtlest transition-opacity transition-transform duration-200 ease-out group-hover/tool-summary:opacity-100",
        expanded ? "rotate-90 opacity-100" : "rotate-0 opacity-0",
      )}
    />
  ) : null;

  return (
    <Collapsible
      data-slot="tool-row"
      data-tool-id={toolCallId}
      open={expanded}
      onOpenChange={(next) => {
        if (!canToggle) {
          return;
        }
        setOpen(next);
      }}
      className="flex w-full flex-col"
    >
      <CollapsibleTrigger asChild disabled={!canToggle}>
        <div
          role="button"
          tabIndex={canToggle ? 0 : undefined}
          aria-expanded={canToggle ? expanded : undefined}
          aria-label={
            canToggle
              ? t(expanded ? "process.tool.collapseDetails" : "process.tool.expandDetails")
              : undefined
          }
          className={cn(SUMMARY_ROW_CLASS, !canToggle && "cursor-default")}
          title={title}
          onKeyDown={(event) => {
            // The row may contain its own interactive bits, so it stays a `div`
            // trigger and Enter/Space are wired up by hand (ZCode does the same).
            if (event.key !== "Enter" && event.key !== " ") {
              return;
            }
            event.preventDefault();
            event.currentTarget.click();
          }}
        >
          {summaryContent}
          {chevron}
        </div>
      </CollapsibleTrigger>
      {canToggle ? (
        <CollapsibleContent
          className={cn(
            "overflow-hidden text-popover-foreground outline-none",
            "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
            "data-closed:fill-mode-forwards",
          )}
        >
          <div className="pt-2">{shouldRenderContent ? renderBody() : null}</div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
