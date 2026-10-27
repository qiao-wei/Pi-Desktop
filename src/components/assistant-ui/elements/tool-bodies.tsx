"use client";

/**
 * The bodies behind the tool rows: an inline diff, a terminal, MCP's
 * result-first panel, and ZCode's generic parameters/result pair.
 *
 * Split out of `tool-row.tsx` for size, not for reuse — every one of them is
 * selected by {@link ToolDisplay}, and none of them parses tool output; the
 * projection already did that (`src/shared/toolDisplay.ts`).
 */

import { ChevronRightIcon } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import {
  toolDiffLines,
  type ToolDiffLine,
  type ToolDiffLineKind,
  type ToolFileDiff,
} from "@/shared/toolDisplay";
import { toWorkspaceRelativePath } from "@/shared/turnChangedFiles";

/** ZCode's shell for an expanded tool body (see `ToolLayout`). */
const BODY_SHELL_CLASS = "mb-2 space-y-3";

export function DiffBody({
  files,
  workspaceRoot,
  t,
}: {
  files: ToolFileDiff[];
  workspaceRoot: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className={BODY_SHELL_CLASS}>
      {files.map((file) => (
        <DiffFile
          key={`${file.path}:${file.added}:${file.removed}`}
          file={file}
          workspaceRoot={workspaceRoot}
          t={t}
        />
      ))}
    </div>
  );
}

function DiffFile({
  file,
  workspaceRoot,
  t,
}: {
  file: ToolFileDiff;
  workspaceRoot: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const { head, tail, omitted } = useMemo(() => toolDiffLines(file.patch), [file.patch]);
  const relative = toWorkspaceRelativePath(file.path, workspaceRoot);
  // Line numbers count rendered rows from 1, the way ZCode's preview numbers them
  // (`index + 1`) -- not the file's own line numbers, which the patch only knows
  // per hunk and which would restart at every hunk boundary anyway.
  const numbered = [...head, ...tail];

  return (
    <div
      data-inline-diff-preview={relative}
      // ZCode: `mb-2 max-h-60 overflow-auto rounded-xl border border-border bg-card`.
      className="max-h-60 overflow-auto rounded-xl border border-border bg-card"
      title={relative}
    >
      <div className="min-w-full font-mono text-xs leading-relaxed">
        {numbered.map((line, index) => (
          <DiffRow key={index} line={line} number={index + 1} />
        ))}
        {omitted > 0 ? (
          <div className="px-3 py-1 text-foreground-subtle">
            {t("process.diff.omittedLines", { count: omitted })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One diff line: a line-number gutter, then the content.
 *
 * ZCode signals added/removed with a tinted row, an inset status bar and a colored
 * line number -- never with the unified diff's own `+`/`-` character, which is
 * protocol the reader did not ask for. The gutter is sticky so it stays put when a
 * long line is scrolled sideways.
 */
function DiffRow({ line, number }: { line: ToolDiffLine; number: number }) {
  const styles = diffLineStyles(line.kind);

  return (
    <div className="flex min-w-full w-full" style={styles.rowStyle} data-diff-line={line.kind}>
      <span
        aria-hidden="true"
        className={cn(
          "sticky left-0 z-[1] w-12 shrink-0 select-none border-border border-r px-2 text-right tabular-nums",
          styles.lineNumberClassName,
        )}
        style={styles.gutterStyle}
      >
        {number}
      </span>
      <code className="block flex-1 px-3 whitespace-pre">{line.text || " "}</code>
    </div>
  );
}

/**
 * Row and gutter colors per line kind. Copied from ZCode's
 * `getLightweightDiffLineStyles`: the gutter is a darker mix of the row tint so the
 * number stays readable on top of it.
 */
function diffLineStyles(kind: ToolDiffLineKind): {
  rowStyle?: CSSProperties;
  gutterStyle?: CSSProperties;
  lineNumberClassName: string;
} {
  // One branch per kind, with the utility class spelled out: Tailwind reads class
  // names out of source text, so a template string like `text-${color}` would never
  // be generated.
  if (kind === "added") {
    return {
      lineNumberClassName: "text-diff-added",
      rowStyle: {
        backgroundColor: "color-mix(in srgb, var(--color-diff-added) 14%, transparent)",
        boxShadow: "inset 3px 0 0 var(--color-diff-added)",
      },
      gutterStyle: {
        backgroundColor: "color-mix(in srgb, var(--color-diff-added) 18%, var(--color-background))",
        boxShadow: "inset 3px 0 0 var(--color-diff-added)",
        color: "var(--color-diff-added)",
      },
    };
  }
  if (kind === "removed") {
    return {
      lineNumberClassName: "text-diff-removed",
      rowStyle: {
        backgroundColor: "color-mix(in srgb, var(--color-diff-removed) 14%, transparent)",
        boxShadow: "inset 3px 0 0 var(--color-diff-removed)",
      },
      gutterStyle: {
        backgroundColor: "color-mix(in srgb, var(--color-diff-removed) 18%, var(--color-background))",
        boxShadow: "inset 3px 0 0 var(--color-diff-removed)",
        color: "var(--color-diff-removed)",
      },
    };
  }
  return {
    lineNumberClassName: "text-foreground-subtlest",
    gutterStyle: { backgroundColor: "var(--color-background)" },
  };
}

export function TerminalBody({
  command,
  output,
  exitCode,
  omittedPath,
  running,
  hasResult,
  t,
}: {
  command: string;
  output: string;
  exitCode?: number;
  omittedPath?: string;
  running: boolean;
  hasResult: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [expandedCommand, setExpandedCommand] = useState(false);
  const commandRef = useRef<HTMLDivElement | null>(null);
  const [commandOverflows, setCommandOverflows] = useState(false);

  useEffect(() => {
    const element = commandRef.current;
    if (!element || expandedCommand) {
      return undefined;
    }
    const measure = () => setCommandOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
    // 展开时不量（按钮就不该出现）；命令文本变化后要重新量 —— 依赖是有意的，
    // 量的是 DOM 而不是这两个值本身。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, expandedCommand]);

  return (
    <div className={cn(BODY_SHELL_CLASS, "rounded-xl border border-border bg-panel px-4 py-3")}>
      {command ? (
        <div className="min-w-0">
          <div
            ref={commandRef}
            className={cn(
              "min-w-0 leading-5",
              expandedCommand ? "max-h-[10lh] overflow-y-auto" : "max-h-[3lh] overflow-hidden",
            )}
          >
            <div className="flex items-start gap-2 font-mono">
              <span className="shrink-0 text-foreground-subtle select-none">$</span>
              <pre className="min-w-0 flex-1 break-words whitespace-pre-wrap">{command}</pre>
            </div>
          </div>
          {commandOverflows || expandedCommand ? (
            <button
              type="button"
              className="mt-1 font-sans text-ui-sm text-foreground-subtle hover:text-foreground"
              aria-expanded={expandedCommand}
              onClick={() => setExpandedCommand((current) => !current)}
            >
              {t(expandedCommand ? "process.tool.collapseCommand" : "process.tool.expandCommand")}
            </button>
          ) : null}
        </div>
      ) : null}
      {output ? (
        <div className="max-h-[5lh] min-w-0 max-w-full overflow-auto leading-5">
          <pre className="font-mono text-ui-base leading-5 break-words whitespace-pre-wrap text-foreground-subtle">
            {output}
          </pre>
        </div>
      ) : !running && hasResult ? (
        <p className="font-mono text-ui-base text-foreground-subtle">
          {t("process.tool.noOutput")}
        </p>
      ) : null}
      {exitCode !== undefined && exitCode !== 0 ? (
        <p className="font-mono text-ui-sm text-diff-removed">exit {exitCode}</p>
      ) : null}
      {omittedPath ? (
        <p className="font-mono text-ui-sm text-foreground-subtle">{omittedPath}</p>
      ) : null}
    </div>
  );
}

/** MCP: result first (it is why you expanded the row), call metadata under it. */
export function McpBody({
  argsText,
  resultText,
  isError,
  t,
}: {
  argsText?: string;
  resultText: string;
  isError: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const compact =
    resultText.trim().length > 0 && resultText.trim().length <= 160 && !resultText.includes("\n");
  return (
    <div className={BODY_SHELL_CLASS}>
      {isError ? (
        <div>
          <h4 className="text-ui-base font-medium text-destructive">{t("process.result")}</h4>
          <p className="mt-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-ui-base break-words whitespace-pre-wrap text-destructive">
            {resultText}
          </p>
        </div>
      ) : resultText ? (
        compact ? (
          <p className="rounded-xl border border-border bg-card px-3 py-2 text-ui-base break-words text-foreground-subtle">
            {resultText.trim()}
          </p>
        ) : (
          <div className="max-h-72 overflow-auto rounded-xl border border-border bg-card">
            <pre className="px-3 py-2 font-mono text-ui-sm break-words whitespace-pre-wrap">
              {resultText}
            </pre>
          </div>
        )
      ) : null}
      {argsText ? (
        <div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-ui-sm text-foreground-subtlest hover:text-foreground"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((current) => !current)}
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", detailsOpen && "rotate-90")}
            />
            {t("process.tool.callDetails")}
          </button>
          {detailsOpen ? (
            <div className="mt-2">
              <h4 className="text-ui-sm font-medium text-foreground-subtlest">
                {t("process.tool.parameters")}
              </h4>
              <div className="mt-1.5 max-h-72 overflow-auto rounded-xl border border-border bg-card">
                <pre className="px-3 py-2 font-mono text-ui-sm whitespace-pre-wrap">{argsText}</pre>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** ZCode's `ToolCallBody`: parameters, then result. */
export function PartsBody({
  argsText,
  resultText,
  isError,
  t,
}: {
  argsText?: string;
  resultText: string;
  isError: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className={BODY_SHELL_CLASS}>
      {argsText ? (
        <section className="space-y-2 overflow-hidden">
          <h4 className="text-ui-base font-medium tracking-wide text-muted-foreground uppercase">
            {t("process.tool.parameters")}
          </h4>
          <div className="max-h-60 overflow-auto rounded-md bg-muted/50">
            <pre className="px-3 py-2 font-mono text-ui-sm whitespace-pre-wrap">{argsText}</pre>
          </div>
        </section>
      ) : null}
      {resultText ? (
        <section className="space-y-2">
          <h4 className="text-ui-base font-medium tracking-wide text-muted-foreground uppercase">
            {t(isError ? "process.tool.error" : "process.result")}
          </h4>
          <div
            className={cn(
              "max-h-60 overflow-auto rounded-md text-ui-base",
              isError ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
            )}
          >
            <div className="p-3 break-words whitespace-pre-wrap">{resultText}</div>
          </div>
        </section>
      ) : null}
    </div>
  );
}