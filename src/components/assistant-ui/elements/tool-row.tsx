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

import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  PencilIcon,
  PlugIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useT } from "@/i18n/react";
import { cn } from "@/lib/utils";
import {
  editOperationOfDisplay,
  parseMcpToolName,
  pathDirectory,
  pathLeaf,
  toolRowFamily,
  type ToolDisplay,
} from "@/shared/toolDisplay";
import { toWorkspaceRelativePath } from "@/shared/turnChangedFiles";

import { DiffBody, McpBody, PartsBody, TerminalBody } from "./tool-bodies";

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

const CONTENT_UNMOUNT_DELAY_MS = 300;

/** The summary row, verbatim from ZCode's `ToolSummaryRow`. */
const SUMMARY_ROW_CLASS =
  "group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SUMMARY_CONTENT_CLASS =
  "min-w-0 flex max-w-full items-center gap-2 text-foreground-subtlest";

const KIND_LABEL_CLASS = "shrink-0 font-medium whitespace-nowrap";

const PATH_TEXT_CLASS = "min-w-0 truncate text-foreground-subtlest";

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
  running?: boolean;
  display?: ToolDisplay;
}

export function ToolRow({
  toolCallId,
  toolName,
  args,
  argsText,
  result,
  partialResult,
  isError,
  running = false,
  display,
}: ToolRowProps) {
  const t = useT();
  const workspaceRoot = useContext(WorkspaceRootContext);
  const family = toolRowFamily(toolName);
  const resultText = result ?? partialResult ?? "";
  const presentation = useMemo(
    () =>
      resolvePresentation({ t, family, toolName, args, display, running, workspaceRoot }),
    [args, display, family, running, t, toolName, workspaceRoot],
  );

  const body = presentation.body;
  const renderBody = useCallback(() => {
    if (!body) {
      return null;
    }
    return body({ display, argsText, resultText, isError: Boolean(isError), t });
  }, [argsText, body, display, isError, resultText, t]);

  return (
    <ToolRowLayout
      toolCallId={toolCallId}
      icon={presentation.icon}
      kindLabel={presentation.kindLabel}
      kindDetail={presentation.kindDetail}
      primaryText={presentation.primaryText}
      secondaryText={presentation.secondaryText}
      separator={presentation.separator}
      diff={presentation.diff}
      statusLabel={isError ? t("process.status.failed") : presentation.statusLabel}
      statusTooltip={isError ? resultText : undefined}
      running={running}
      title={presentation.title}
      canToggle={presentation.canToggle && body !== undefined}
      renderBody={renderBody}
    />
  );
}

interface Presentation {
  icon: ReactNode;
  kindLabel: ReactNode;
  kindDetail?: ReactNode;
  primaryText?: ReactNode;
  secondaryText?: ReactNode;
  separator?: ReactNode;
  diff?: { added: number; removed: number };
  statusLabel?: string;
  title?: string;
  canToggle: boolean;
  body?: (input: BodyInput) => ReactNode;
}

interface BodyInput {
  display?: ToolDisplay;
  argsText?: string;
  resultText: string;
  isError: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const ROW_ICON_CLASS = "size-4 shrink-0 text-foreground-subtle";

function resolvePresentation({
  t,
  family,
  toolName,
  args,
  display,
  running,
  workspaceRoot,
}: {
  t: (key: string, params?: Record<string, string | number>) => string;
  family: ReturnType<typeof toolRowFamily>;
  toolName: string;
  args: unknown;
  display?: ToolDisplay;
  running: boolean;
  workspaceRoot: string;
}): Presentation {
  switch (family) {
    case "read": {
      const path = display?.kind === "read" ? (display.path ?? "") : "";
      const relative = toWorkspaceRelativePath(path, workspaceRoot);
      return {
        icon: <SearchIcon className={ROW_ICON_CLASS} />,
        kindLabel: t(running ? "process.tool.read.running" : "process.tool.read.done"),
        primaryText: relative ? (
          <span className={cn("min-w-0 truncate text-foreground-subtle")} title={relative}>
            {pathLeaf(relative)}
          </span>
        ) : null,
        secondaryText: pathDirectory(relative) ? (
          <span className={PATH_TEXT_CLASS} title={relative}>
            {pathDirectory(relative)}
          </span>
        ) : null,
        title: relative || toolName,
        // ZCode's read renderer is summary-only: the file is the answer, and its
        // content already exists in the transcript as the tool's result text.
        canToggle: false,
      };
    }
    case "write":
    case "edit": {
      const files = display?.kind === "fileDiff" ? display.files : [];
      if (files.length === 0) {
        return fallbackPresentation({ t, toolName, running });
      }
      const operation = editOperationOfDisplay(display);
      const key =
        operation === "write"
          ? running
            ? "process.tool.write.running"
            : "process.tool.write.done"
          : operation === "delete"
            ? running
              ? "process.tool.delete.running"
              : "process.tool.delete.done"
            : running
              ? "process.tool.edit.running"
              : "process.tool.edit.done";
      const relativePaths = files.map((file) => toWorkspaceRelativePath(file.path, workspaceRoot));
      const totals = files.reduce(
        (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
        { added: 0, removed: 0 },
      );
      const first = relativePaths[0] ?? "";
      const multiple = files.length > 1;
      return {
        icon: <PencilIcon className={ROW_ICON_CLASS} />,
        kindLabel: t(key),
        // ZCode joins the file chips under one verb and lists them; the second
        // text carries the directory of the first file.
        primaryText: multiple ? (
          <span className="min-w-0 truncate text-foreground-subtle" title={relativePaths.join(", ")}>
            {t(files.length === 1 ? "process.tool.fileCount.one" : "process.tool.fileCount.other", {
              count: files.length,
            })}
          </span>
        ) : (
          <span className="min-w-0 truncate text-foreground-subtle" title={first}>
            {pathLeaf(first)}
          </span>
        ),
        secondaryText:
          !multiple && pathDirectory(first) ? (
            <span className={PATH_TEXT_CLASS} title={first}>
              {pathDirectory(first)}
            </span>
          ) : null,
        diff: totals.added > 0 || totals.removed > 0 ? totals : undefined,
        title: relativePaths.join(", ") || toolName,
        canToggle: true,
        body: (input) => (
          <DiffBody
            files={input.display?.kind === "fileDiff" ? input.display.files : files}
            workspaceRoot={workspaceRoot}
            t={t}
          />
        ),
      };
    }
    case "execute": {
      const command = stringArg(args, ["command", "cmd", "script"]) ?? "";
      const terminal = display?.kind === "terminal" ? display : undefined;
      return {
        icon: <SquareTerminalIcon className={ROW_ICON_CLASS} />,
        kindLabel: t(running ? "process.tool.execute.running" : "process.tool.execute.done"),
        primaryText: null,
        // Collapsed, the command is body text on the row (ZCode keeps sans here
        // and switches to mono only for the expanded copy).
        secondaryText: command ? (
          <code className="min-w-0 truncate font-sans" title={command}>
            {command}
          </code>
        ) : null,
        title: command || toolName,
        canToggle: true,
        body: (input) => (
          <TerminalBody
            command={command}
            output={terminal?.output ?? input.resultText}
            exitCode={terminal?.exitCode}
            omittedPath={terminal?.fullOutputPath}
            running={running}
            hasResult={input.resultText.length > 0 || terminal !== undefined}
            t={t}
          />
        ),
      };
    }
    case "search": {
      const pattern = stringArg(args, ["pattern", "query", "glob"]) ?? "";
      const path = stringArg(args, ["path", "cwd"]) ?? "";
      const label =
        toolName === "ls"
          ? path
            ? t("process.tool.search.listIn", { cwd: toWorkspaceRelativePath(path, workspaceRoot) })
            : t("process.tool.search.list")
          : pattern
            ? t("process.tool.search.findWithQuery", { query: pattern })
            : t("process.tool.search.find");
      return {
        icon: <SearchIcon className={ROW_ICON_CLASS} />,
        kindLabel: t(running ? "process.tool.search.running" : "process.tool.search.done"),
        primaryText: <span className="min-w-0 truncate">{label}</span>,
        title: label,
        canToggle: false,
      };
    }
    case "mcp": {
      const parsed = parseMcpToolName(toolName);
      const server = parsed ? humanizeIdentifier(parsed.server) : undefined;
      const tool = parsed ? stripRepeatedPrefix(humanizeIdentifier(parsed.tool), server ?? "") : "";
      const label = tool || humanizeIdentifier(toolName);
      return {
        icon: <PlugIcon className={ROW_ICON_CLASS} />,
        kindLabel: t("process.tool.mcp"),
        kindDetail: server ? <span className="text-foreground-subtle">{server}</span> : undefined,
        primaryText: <span className="min-w-0 truncate text-foreground-subtle" title={label}>{label}</span>,
        separator: "·",
        title: toolName,
        canToggle: true,
        body: (input) => (
          <McpBody argsText={input.argsText} resultText={input.resultText} isError={input.isError} t={t} />
        ),
      };
    }
    default:
      return fallbackPresentation({ t, toolName, running });
  }
}

/**
 * ZCode's fallback renderer: the tool's own name capitalized as the kind, a
 * generic title, and the lifecycle word as the secondary text (its only visible
 * status, since it has no dedicated renderer to shimmer a verb for it).
 */
function fallbackPresentation({
  t,
  toolName,
  running,
}: {
  t: (key: string, params?: Record<string, string | number>) => string;
  toolName: string;
  running: boolean;
}): Presentation {
  const kind = humanizeIdentifier(toolName);
  return {
    icon: <WrenchIcon className={ROW_ICON_CLASS} />,
    kindLabel: kind.charAt(0).toUpperCase() + kind.slice(1),
    primaryText: <span className="min-w-0 truncate text-foreground-subtle">{t("process.tool.call")}</span>,
    secondaryText: running ? (
      <span className="shrink-0 whitespace-nowrap">{t("process.status.running")}</span>
    ) : undefined,
    statusLabel: running ? undefined : t("process.status.completed"),
    title: toolName,
    canToggle: true,
    body: (input) => (
      <PartsBody argsText={input.argsText} resultText={input.resultText} isError={input.isError} t={t} />
    ),
  };
}

function stringArg(args: unknown, keys: readonly string[]): string | undefined {
  if (typeof args === "string") {
    return args.trim() || undefined;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/** `my_server` / `my-server` → `my server`. */
function humanizeIdentifier(value: string): string {
  return value.replace(/[_-]+/g, " ").trim();
}

/** MCP tools often repeat their server name; the row already shows it. */
function stripRepeatedPrefix(label: string, server: string): string {
  const prefix = `${server} `;
  if (server && label.toLowerCase().startsWith(prefix.toLowerCase())) {
    return label.slice(prefix.length);
  }
  return label;
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

function ToolRowLayout({
  toolCallId,
  icon,
  kindLabel,
  kindDetail,
  primaryText,
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
        className={cn(
          KIND_LABEL_CLASS,
          running ? "shimmer motion-reduce:animate-none" : "text-foreground-subtlest",
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
          {primaryText}
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

  const t = useT();

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

/** ZCode's animated `+N −M` (see `renderDiffCount`). */
function DiffCount({ added, removed }: { added: number; removed: number }) {
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
function StatusWord({ label, tooltip }: { label: string; tooltip?: string }) {
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
