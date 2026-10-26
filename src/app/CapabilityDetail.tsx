/**
 * 能力详情与包资源.
 *
 * 能力详情对话框、市场卡片、包资源列表与资源徽标。
 *
 * 从 `src/app/CapabilitiesPage.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import { t } from "../i18n/index.ts";
import { useT } from "../i18n/react";
import { fetchJson, postJson } from "../lib/api";
import { MarkdownContent } from "../lib/markdown";
import { canDeleteCapability, capabilitySourceLabel } from "../shared/capabilityScope";

import { CAPABILITY_PACKAGE_RESOURCE_TYPES } from "../types";
import type { CapabilityKind, CapabilityMcpDetail, CapabilityMcpInspection, CapabilityPackage, CapabilityPackageFilePreview, CapabilityPackageResourceDetails, CapabilityPackageResourceEntry, CapabilityPackageResourceType } from "../types";
import { McpServerEditor } from "./CapabilitiesMcp";
import { CapabilityActions, CapabilityCommandMenu, CapabilityDot, CapabilityItem } from "./CapabilitySurfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Check, ClipboardCopy, Pin, RefreshCw, Settings, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

const CAPABILITY_RESOURCE_LABEL_KEYS: Record<CapabilityPackageResourceType, string> = {
  extensions: "capability.resource.extensions",
  skills: "capability.resource.skills",
  prompts: "capability.resource.prompts",
  themes: "capability.resource.themes",
};

/**
 * The capability detail sheet — shared by the Global page and the project panel, so a project skill
 * opens the same SKILL.md preview as a Global one and a project package gets the same
 * source/update view.
 *
 * The sheet owns the two operations it performs itself (reading a skill's content, running pi's
 * package update) together with their progress and errors: the host's error strip sits *behind* a
 * modal, so a failure there is invisible. Capability-level actions (default / pin / delete) still go
 * through the host's handlers, which already exist once per surface.
 */
function CapabilityDetailDialog({
  item,
  busy,
  onClose,
  onSetDefault,
  onSetPinned,
  onDelete,
  onUpdatePackage,
  onSaveMcpServer,
  onInspectMcpServer,
  onReadMcpServer,
}: {
  item: CapabilityItem;
  /** The host's busy label; this sheet's own operations are tracked locally. */
  busy: string;
  onClose: () => void;
  onSetDefault: (kind: CapabilityKind, id: string, enabled: boolean) => Promise<unknown>;
  onSetPinned: (kind: CapabilityKind, id: string, pinned: boolean) => Promise<unknown>;
  onDelete: (item: CapabilityItem) => void;
  onUpdatePackage: (source?: string, onProgress?: (message: string) => void) => Promise<unknown>;
  onSaveMcpServer: (server: Record<string, unknown>) => Promise<unknown>;
  onInspectMcpServer: (id: string) => Promise<CapabilityMcpInspection>;
  onReadMcpServer: (id: string) => Promise<CapabilityMcpDetail>;
}) {
  const t = useT();
  const [busyAction, setBusyAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [skillContent, setSkillContent] = useState("");
  const [isReadingSkill, setIsReadingSkill] = useState(false);
  const [updateProgress, setUpdateProgress] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);

  const skillPath = item.kind === "skill" ? item.path : "";

  useEffect(() => {
    if (!skillPath) {
      return;
    }
    let cancelled = false;
    setSkillContent("");
    setIsReadingSkill(true);
    setActionError("");
    void fetchJson<{ content: string }>(`/api/skills/content?path=${encodeURIComponent(skillPath)}`)
      .then((result) => {
        if (!cancelled) {
          setSkillContent(result.content);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setActionError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsReadingSkill(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [skillPath]);

  /** Shared by the three capability-level actions so a failure lands next to them, not behind. */
  function runAction(label: string, action: () => Promise<unknown>) {
    setBusyAction(label);
    setActionError("");
    return action()
      .catch((nextError) => {
        setActionError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => setBusyAction(""));
  }

  async function runUpdate() {
    if (item.kind !== "package") {
      return;
    }
    setIsUpdating(true);
    setActionError("");
    setUpdateProgress("");
    try {
      await onUpdatePackage(item.source, setUpdateProgress);
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setIsUpdating(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) { onClose(); } }}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-3xl max-h-[min(86svh,760px)]">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-3">
            <CapabilityDot kind={item.kind}>{capabilityInitial(item)}</CapabilityDot>
            <span className="min-w-0 break-all text-xl">{item.name}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("capability.detail.detailAndSettings", { name: item.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3.5 overflow-y-auto pr-1">
          <CapabilityActions
            item={item}
            busy={busy || busyAction || (isUpdating ? "package-update" : "")}
            onSetDefault={(kind, id, enabled) => runAction("default", () => onSetDefault(kind, id, enabled))}
            onSetPinned={(kind, id, pinned) => runAction("pin", () => onSetPinned(kind, id, pinned))}
            onDelete={() => onDelete(item)}
          />
          {actionError ? <p className="text-sm text-destructive" role="status">{actionError}</p> : null}
          {item.kind === "skill" ? (
            <>
              <p className="text-sm">{item.description || item.path}</p>
              <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">{item.path}</code>
              {item.disableModelInvocation ? (
                <p className="text-sm text-muted-foreground">{t("capability.detail.manualOnlyNote")}</p>
              ) : null}
              {isReadingSkill ? <p className="text-sm text-muted-foreground">{t("capability.detail.readingContent")}</p> : null}
              {skillContent ? <MarkdownContent text={skillContent} /> : null}
            </>
          ) : item.kind === "mcp" ? (
            <McpServerEditor
              server={item}
              onSave={onSaveMcpServer}
              onInspect={onInspectMcpServer}
              onRead={onReadMcpServer}
            />
          ) : item.kind === "package" ? (
            <div className="grid gap-1.5">
              <p className="text-sm">{item.description}</p>
              <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">{item.source}</code>
              {isUpdating && updateProgress ? (
                <p className="text-xs break-all text-muted-foreground" role="status">{updateProgress}</p>
              ) : null}
              <div className="flex justify-end">
                <Button type="button" variant="outline" disabled={Boolean(busy) || isUpdating} onClick={() => void runUpdate()}>
                  <RefreshCw />
                  {t("capability.detail.update")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CapabilityMarketCard({
  item,
  selected,
  busy,
  onOpen,
  onOpenResources,
  onSetDefault,
  onSetPinned,
  onDelete,
  onInsertPackageCommand,
}: {
  item: CapabilityItem;
  selected: boolean;
  busy: string;
  onOpen: (item: CapabilityItem) => void;
  onOpenResources: (item: CapabilityPackage, type: CapabilityPackageResourceType) => void;
  onSetDefault: (kind: CapabilityKind, id: string, enabled: boolean) => Promise<unknown>;
  onSetPinned: (kind: CapabilityKind, id: string, pinned: boolean) => Promise<unknown>;
  onDelete: (item: CapabilityItem) => void;
  onInsertPackageCommand: (packageId: string, command: string) => void;
}) {
  const t = useT();
  return (
    <Card
      className={cn(
        "min-h-[150px] cursor-pointer gap-[18px] rounded-lg border-transparent py-5 shadow-sm hover:border-border",
        selected && "border-border",
      )}
      onClick={() => onOpen(item)}
    >
      <div className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)_auto] items-start gap-x-3.5 gap-y-2 px-5">
        <CapabilityDot kind={item.kind}>{capabilityInitial(item)}</CapabilityDot>
        <div className="grid min-w-0 content-start justify-items-start gap-1">
          <strong className="line-clamp-2 min-w-0 max-w-full break-words text-base leading-tight">{item.name}</strong>
          {item.kind === "extension" ? (
            <Badge variant="secondary">standalone</Badge>
          ) : null}
          {/* manual-only 技能（disable-model-invocation）不会进模型的自动选择清单，徽标必须这么说，
              别写成「工具」——那会让人以为它在模型技能列表里。 */}
          {item.kind === "skill" && item.disableModelInvocation ? (
            <Badge variant="secondary" title={t("capability.detail.manualOnlyNote")}>
              {t("capability.badge.manualOnly")}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
          {item.kind === "package" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              disabled={Boolean(busy)}
              onClick={() => onOpen(item)}
              aria-label={t("capability.card.openSettings")}
              title={t("capability.card.openSettings")}
            >
              <Settings />
            </Button>
          ) : null}
          {canDeleteCapability(item) ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              disabled={Boolean(busy)}
              onClick={() => onDelete(item)}
              aria-label={t("capability.context.delete")}
              title={t("capability.context.delete")}
            >
              <Trash2 />
            </Button>
          ) : null}
          <Button
            type="button"
            variant={item.pinned ? "secondary" : "ghost"}
            size="icon-sm"
            className="size-7"
            disabled={Boolean(busy)}
            onClick={() => void onSetPinned(item.kind, item.id, !item.pinned)}
            aria-label={item.pinned ? t("capability.card.unpin") : t("capability.card.pin")}
            title={item.pinned ? t("capability.card.unpin") : t("capability.card.pin")}
          >
            <Pin />
          </Button>
          <Switch
            checked={item.defaultEnabled}
            disabled={Boolean(busy)}
            onCheckedChange={(next) => void onSetDefault(item.kind, item.id, next)}
            aria-label={item.defaultEnabled ? t("capability.card.disableAutoload") : t("capability.card.enableAutoload")}
            title={item.defaultEnabled ? t("capability.card.disableAutoload") : t("capability.card.enableAutoload")}
          />
        </div>
        {/* 资源 tag 独占一行并横跨整卡：留在中间列时宽度只有 119–205px，四个 tag 需要 ~287px，
            结果就是 tag 换行、而操作列下方那一整片空间空着（操作只有一行高）。 */}
        {item.kind === "package" ? (
          <div className="col-span-3 min-w-0">
            <CapabilityResourceChips item={item} onOpen={onOpenResources} />
          </div>
        ) : null}
      </div>
      <p className="line-clamp-2 min-h-0 px-5 text-sm leading-relaxed break-words text-muted-foreground">
        {item.description || (item.kind === "package" || item.kind === "mcp" ? item.source : item.path)}
      </p>
      <div className="mt-auto grid min-w-0 gap-2.5 px-5">
        {item.kind === "package" && item.loadErrors.length > 0 ? (
          <p className="line-clamp-3 rounded-md bg-secondary/60 px-2.5 py-1.5 font-mono text-xs break-words text-destructive" role="status">
            {item.loadErrors.join(t("capability.card.loadErrorsSeparator"))}
          </p>
        ) : null}
        {/* Status text and the command menu share one row: the menu sits in the card's
            bottom-right, not floating on a row of its own. */}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{item.kind === "package" ? (item.autoload ? t("capability.card.autoloadOn") : t("capability.card.autoloadOff")) : capabilitySourceLabel(item)}</span>
            <span className={capabilityLoadClass(item)} title={item.kind === "package" ? item.loadErrors.join("\n") : undefined}>
              {capabilityLoadLabel(item)}
            </span>
          </div>
          {item.kind === "package" && item.commands.length > 0 ? (
            <CapabilityCommandMenu
              commands={item.commands}
              disabled={Boolean(busy)}
              onRun={(command) => onInsertPackageCommand(item.id, command)}
            />
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * What a package actually ships, straight from pi's own resolution: four chips with counts. A
 * chip with entries opens the detail dialog; an empty one is disabled so a click cannot promise
 * a list that does not exist.
 */
function CapabilityResourceChips({
  item,
  onOpen,
  compact = false,
}: {
  item: CapabilityPackage;
  onOpen: (item: CapabilityPackage, type: CapabilityPackageResourceType) => void;
  /**
   * Panel rows are narrow and read as a list, not as a market grid: drop the empty types and the
   * pill padding so a package shows one short line of what it actually ships.
   */
  compact?: boolean;
}) {
  const t = useT();
  const types = CAPABILITY_PACKAGE_RESOURCE_TYPES.filter(
    (type) => !compact || (item.resources?.[type] ?? 0) > 0,
  );

  if (!types.length) {
    return null;
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {types.map((type) => {
        const count = item.resources?.[type] ?? 0;
        const label = t(CAPABILITY_RESOURCE_LABEL_KEYS[type]);
        const title = t("capability.resource.openAria", { type: label, count });
        return (
          <button
            key={type}
            type="button"
            disabled={count === 0}
            aria-label={title}
            title={title}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border border-transparent bg-secondary px-1.5 text-secondary-foreground",
              compact ? "py-0 text-[10.5px] font-normal" : "py-0.5 text-[11px] font-medium",
              count > 0 ? "cursor-pointer hover:border-border hover:bg-accent" : "opacity-45",
            )}
            onClick={() => onOpen(item, type)}
          >
            {label}
            <span className="tabular-nums opacity-70">{count}</span>
          </button>
        );
      })}
    </span>
  );
}

/**
 * Read-only view of a package's resources: the files pi resolved for one type on the left, the
 * selected file's content on the right.
 *
 * List and first file are both fetched before the dialog renders, so it opens fully populated —
 * opening first and filling in after made the right pane flash through "select a file" → loading
 * → text on every click. A local resolve + read measures 1-4 ms, so the wait is imperceptible.
 */
function PackageResourcesDialog({ request, onClose }: { request: PackageResourcesRequest | null; onClose: () => void }) {
  const t = useT();
  const [loaded, setLoaded] = useState<PackageResourcesLoaded | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (!request) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    setLoaded(null);
    setCopyState("idle");
    void (async () => {
      try {
        const result = await postJson<{ resources: CapabilityPackageResourceDetails }>(
          "/api/capabilities/package/resources",
          { packageId: request.item.id },
        );
        const entries = result.resources?.[request.type] ?? [];
        const file = entries[0] ? await loadPackageResourceFile(request.item, entries[0]) : null;
        if (!cancelled) {
          setLoaded({ entries, listError: "", file });
        }
      } catch (nextError) {
        if (!cancelled) {
          const message = nextError instanceof Error ? nextError.message : String(nextError);
          setLoaded({ entries: [], listError: message, file: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  /** Read first, then swap: the clicked row must not highlight before its content is ready. */
  async function selectFile(entry: CapabilityPackageResourceEntry) {
    if (!request) {
      return;
    }
    setCopyState("idle");
    const file = await loadPackageResourceFile(request.item, entry);
    setLoaded((current) => (current ? { ...current, file } : current));
  }

  async function copyContent() {
    const content = loaded?.file?.preview?.content ?? "";
    if (!content) {
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState((current) => (current === "idle" ? current : "idle")), 1600);
  }

  // Nothing rendered until the content is ready: an open-but-empty dialog is exactly the flash we
  // are avoiding.
  if (!request || !loaded) {
    return null;
  }

  const selectedPath = loaded.file
    ? (loaded.entries.find((entry) => entry.path === loaded.file?.path)?.relativePath ?? loaded.file.path)
    : "";

  return (
    <Dialog open onOpenChange={(next) => { if (!next) { onClose(); } }}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-4xl max-h-[min(86svh,720px)]">
        <DialogHeader>
          <DialogTitle className="min-w-0 break-all text-lg">
            {t("capability.resource.dialogTitle", {
              name: request.item.name,
              type: t(CAPABILITY_RESOURCE_LABEL_KEYS[request.type]),
            })}
          </DialogTitle>
          <DialogDescription>{t("capability.resource.dialogHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
          {/* Left: the files pi resolved for this type. */}
          <div className="grid min-h-0 content-start gap-1 overflow-y-auto rounded-md border p-1.5">
            {loaded.listError ? (
              <p className="px-1.5 py-1 text-sm text-destructive" role="status">
                {t("capability.resource.error", { reason: loaded.listError })}
              </p>
            ) : null}
            {!loaded.listError && loaded.entries.length === 0 ? (
              <p className="px-1.5 py-1 text-sm text-muted-foreground">{t("capability.resource.empty")}</p>
            ) : null}
            {loaded.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                aria-current={loaded.file?.path === entry.path ? "true" : undefined}
                className={cn(
                  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent",
                  loaded.file?.path === entry.path && "bg-accent",
                )}
                onClick={() => void selectFile(entry)}
              >
                <code className="min-w-0 break-all font-mono">{entry.relativePath || entry.path}</code>
                {entry.enabled ? null : <span className="text-[10px] text-muted-foreground">{t("capability.resource.disabled")}</span>}
              </button>
            ))}
          </div>

          {/* Right: read-only content of the selected file, copyable as-is. */}
          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">{selectedPath}</code>
              {loaded.file?.preview && !loaded.file.preview.directory && !loaded.file.preview.binary && loaded.file.preview.content ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="shrink-0"
                  aria-label={t("capability.resource.copy")}
                  title={t("capability.resource.copy")}
                  onClick={() => void copyContent()}
                >
                  {copyState === "copied" ? <Check /> : <ClipboardCopy />}
                  {t(copyState === "copied" ? "capability.resource.copied" : copyState === "failed" ? "capability.resource.copyFailed" : "capability.resource.copy")}
                </Button>
              ) : null}
            </div>
            <div className="min-h-0 overflow-auto rounded-md border bg-muted/40">
              {!loaded.file ? (
                <p className="p-3 text-sm text-muted-foreground">{t("capability.resource.selectFile")}</p>
              ) : loaded.file.error ? (
                <p className="p-3 text-sm text-destructive" role="status">
                  {t("capability.resource.error", { reason: loaded.file.error })}
                </p>
              ) : !loaded.file.preview ? (
                <p className="p-3 text-sm text-muted-foreground">{t("capability.resource.loading")}</p>
              ) : loaded.file.preview.directory ? (
                <p className="p-3 text-sm text-muted-foreground">{t("capability.resource.directory")}</p>
              ) : loaded.file.preview.binary ? (
                <p className="p-3 text-sm text-muted-foreground">
                  {t("capability.resource.binary", { size: formatFileSize(loaded.file.preview.bytes) })}
                </p>
              ) : (
                <pre className="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                  {loaded.file.preview.content}
                  {loaded.file.preview.truncated
                    ? `\n\n${t("capability.resource.truncated", { size: formatFileSize(loaded.file.preview.bytes) })}`
                    : ""}
                </pre>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The committed result of the two reads the dialog needs: the list, plus one file's preview. */
type PackageResourcesLoaded = {
  entries: CapabilityPackageResourceEntry[];
  /** The list request itself failed (nothing was resolved for the type). */
  listError: string;
  /** Selected file with its committed preview; a non-empty `error` means the read failed. */
  file: { path: string; preview: CapabilityPackageFilePreview | null; error: string } | null;
};

/**
 * A request to inspect one resource type of one package. The dialog fetches on demand, so this is
 * just what the click already knew.
 */
type PackageResourcesRequest = { item: CapabilityPackage; type: CapabilityPackageResourceType };

function capabilityInitial(item: CapabilityItem) {
  if (item.kind === "package") return "P";
  if (item.kind === "extension") return "E";
  if (item.kind === "mcp") return "M";
  return item.name.trim().slice(0, 1).toUpperCase() || "S";
}

function capabilityLoadClass(item: CapabilityItem): string {
  if (item.kind !== "package") {
    return item.active ? "text-muted-foreground" : "text-muted-foreground";
  }
  if (item.loadStatus === "failed") {
    return "font-medium text-destructive";
  }
  if (item.loadStatus === "missing" || item.loadStatus === "not-installed") {
    return "font-medium text-amber-900 dark:text-amber-200";
  }
  return "text-muted-foreground";
}

/**
 * `active` only means "this session selected it". Whether pi really put its extensions in the
 * session is a separate fact (`loadStatus`), and conflating the two is what let an installed
 * package sit invisible in the session while the panel still glowed green.
 */
function capabilityLoadLabel(item: CapabilityItem): string {
  if (item.kind === "package") {
    switch (item.loadStatus) {
      case "loaded":
        return item.loadedTools.length > 0
          ? t(item.loadedTools.length === 1 ? "capability.state.loadedWithTools.one" : "capability.state.loadedWithTools.other", { count: item.loadedTools.length })
          : t("capability.state.loaded");
      case "failed":
        return t("capability.state.loadFailed");
      case "missing":
        return t("capability.state.notLoadedAutoload");
      case "disabled":
        return t("capability.state.disabled");
      case "not-installed":
        return t("capability.state.noEntry");
      default:
        return item.active ? t("capability.state.enabled") : t("capability.state.disabled");
    }
  }
  if (item.kind === "extension" && typeof item.loaded === "boolean") {
    return item.loaded ? t("capability.state.loaded") : item.active ? t("capability.state.enabledNotLoaded") : t("capability.state.notLoaded");
  }
  return item.active ? t("capability.state.enabled") : t("capability.state.disabled");
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

/**
 * One file at a time, read-only: the server only serves paths pi resolved for this package.
 * Never throws — a failed read is part of the file slot, so callers commit list + content together.
 */
async function loadPackageResourceFile(item: CapabilityPackage, entry: CapabilityPackageResourceEntry) {
  try {
    const preview = await postJson<CapabilityPackageFilePreview>(
      "/api/capabilities/package/file",
      { packageId: item.id, path: entry.path },
    );
    return { path: entry.path, preview, error: "" };
  } catch (nextError) {
    const message = nextError instanceof Error ? nextError.message : String(nextError);
    return { path: entry.path, preview: null, error: message };
  }
}

export { CAPABILITY_RESOURCE_LABEL_KEYS, CapabilityDetailDialog, CapabilityMarketCard, CapabilityResourceChips, PackageResourcesDialog, capabilityInitial, capabilityLoadClass, capabilityLoadLabel, formatFileSize, loadPackageResourceFile };
export type { PackageResourcesLoaded, PackageResourcesRequest };
