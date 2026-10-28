"use client";

/**
 * The *content* of a tool row: what verb, what icon, what target text and which
 * body each tool family gets.
 *
 * Split out of `tool-row.tsx` for size (the layout kept growing past its 700-line
 * ceiling); the boundary is deliberate — this file answers "what does this call
 * say", `tool-row.tsx` answers "how is a row drawn and expanded". Nothing here
 * touches disclosure state or DOM measurement, so it stays cheap to reason about
 * and to test.
 */

import {
  PencilIcon,
  PlugIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  editOperationOfTool,
  pathLeaf,
  parseMcpToolName,
  toolRowFamily,
  toolRowFolder,
  type ToolDisplay,
} from "@/shared/toolDisplay";
import { toWorkspaceRelativePath } from "@/shared/turnChangedFiles";

import { DiffBody, McpBody, PartsBody, TerminalBody } from "./tool-bodies";

export const KIND_LABEL_CLASS = "shrink-0 font-medium whitespace-nowrap";
const PATH_TEXT_CLASS = "min-w-0 truncate text-foreground-subtlest";

/**
 * Whether the row's path can be opened by the host at all: the right panel reads
 * files relative to the project root and refuses anything outside it, so an
 * absolute path from another checkout must not pretend to be clickable.
 */
export function isPanelPath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path);
}

export interface Presentation {
  icon: ReactNode;
  kindLabel: ReactNode;
  kindDetail?: ReactNode;
  primaryText?: ReactNode;
  /** Workspace-relative path of the single file this row points at, when there is one. */
  filePath?: string;
  secondaryText?: ReactNode;
  separator?: ReactNode;
  diff?: { added: number; removed: number };
  statusLabel?: string;
  title?: string;
  canToggle: boolean;
  body?: (input: BodyInput) => ReactNode;
}

export interface BodyInput {
  display?: ToolDisplay;
  argsText?: string;
  resultText: string;
  resultTruncated?: { bytes: number; lines: number };
  isError: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const ROW_ICON_CLASS = "size-4 shrink-0 text-foreground-subtle";

export function resolvePresentation({
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
        filePath: isPanelPath(relative) ? relative : undefined,
        secondaryText: toolRowFolder(relative, workspaceRoot) ? (
          <span data-slot="tool-row-path" className={PATH_TEXT_CLASS} title={relative}>
            {toolRowFolder(relative, workspaceRoot)}
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
        return fallbackPresentation({ t, family, toolName, running });
      }
      const operation = editOperationOfTool(toolName);
      const key =
        operation === "write"
          ? running
            ? "process.tool.write.running"
            : "process.tool.write.done"
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
        filePath: !multiple && isPanelPath(first) ? first : undefined,
        secondaryText:
          !multiple && toolRowFolder(first, workspaceRoot) ? (
            <span data-slot="tool-row-path" className={PATH_TEXT_CLASS} title={first}>
              {toolRowFolder(first, workspaceRoot)}
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
            truncated={input.resultTruncated}
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
          <McpBody
            argsText={input.argsText}
            resultText={input.resultText}
            truncated={input.resultTruncated}
            isError={input.isError}
            t={t}
          />
        ),
      };
    }
    default:
      return fallbackPresentation({ t, family, toolName, running });
  }
}

/**
 * ZCode's fallback renderer: the tool's own name capitalized as the kind, a
 * generic title, and the lifecycle word as the secondary text (its only visible
 * status, since it has no dedicated renderer to shimmer a verb for it).
 */
/**
 * The row for a tool we have no dedicated renderer for — and, just as importantly,
 * for a tool whose body model isn't derivable yet (an `edit`/`write` while its
 * arguments are still streaming has no files to show).
 *
 * Two rules:
 * - the kind word stays **localized**: it comes from the family, never from the
 *   raw tool name (`Write` / `todo_write` are English identifiers, not UI copy).
 *   Only when the family is unknown does the tool's own name become the label —
 *   an unknown tool has no translation to offer, and inventing a generic verb in
 *   its place would hide which tool ran;
 * - a successful run says nothing extra. The verb already carries the state, so
 *   the old「执行中 / 已执行」secondary word is gone (ZCode's rows are equally quiet).
 */
function fallbackPresentation({
  t,
  family,
  toolName,
  running,
}: {
  t: (key: string, params?: Record<string, string | number>) => string;
  family: ReturnType<typeof toolRowFamily>;
  toolName: string;
  running: boolean;
}): Presentation {
  const name = humanizeIdentifier(toolName);
  const familyLabel = fallbackKindLabel(t, family, running);
  const label = familyLabel ?? name.charAt(0).toUpperCase() + name.slice(1);
  return {
    icon: <WrenchIcon className={ROW_ICON_CLASS} />,
    kindLabel: familyLabel ? t(familyLabel) : label,
    primaryText:
      familyLabel && name ? (
        <span className="min-w-0 truncate text-foreground-subtle" title={toolName}>
          {name}
        </span>
      ) : null,
    title: toolName,
    canToggle: true,
    body: (input) => (
      <PartsBody
        argsText={input.argsText}
        resultText={input.resultText}
        truncated={input.resultTruncated}
        isError={input.isError}
        t={t}
      />
    ),
  };
}

/** The localized verb for a family, or `undefined` when the family is unknown. */
function fallbackKindLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  family: ReturnType<typeof toolRowFamily>,
  running: boolean,
): string | undefined {
  switch (family) {
    case "read":
      return t(running ? "process.tool.read.running" : "process.tool.read.done");
    case "write":
      return t(running ? "process.tool.write.running" : "process.tool.write.done");
    case "edit":
      return t(running ? "process.tool.edit.running" : "process.tool.edit.done");
    case "execute":
      return t(running ? "process.tool.execute.running" : "process.tool.execute.done");
    case "search":
      return t(running ? "process.tool.search.running" : "process.tool.search.done");
    case "mcp":
      return t("process.tool.mcp");
    default:
      return undefined;
  }
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
