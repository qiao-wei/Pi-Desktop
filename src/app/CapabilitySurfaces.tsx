/**
 * 能力面板与斜杠菜单.
 *
 * 能力卡片的动作/删除确认/命令菜单/分区，技能与包的导入导出框，斜杠菜单。
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import { AutoHideScroll } from "../components/AutoHideScroll";
import type { SlashMenuItem } from "../features/chat/slashMenu";
import { t } from "../i18n/index.ts";
import { useT } from "../i18n/react";
import { fetchJson } from "../lib/api";
import { MarkdownContent } from "../lib/markdown";
import { filterPackageCommands } from "../shared/capabilityCommands";
import { canDeleteCapability } from "../shared/capabilityScope";
import type { McpKeyValueRow } from "../shared/mcpForm";
import type { CapabilityCommand, CapabilityExtension, CapabilityKind, CapabilityMcpServer, CapabilityPackage, CapabilitySkill, SkillSummary } from "../types";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { BookOpen, ChevronRight, Loader2, Pin, Plus, Save, Search, Terminal, Trash2 } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { SlashMenu, slashMenuItemKey } from "./SlashMenu";
import { KeyValueEditor, PackageInstallDialog, SkillImportDialog } from "./SkillImportSurfaces";

/**
 * 应用的标题条（AppTitleBar，`z-[100]`，`--titlebar-height` 40px）是浮在内容之上的带子，
 * 而 Radix 只知道视口边界。按钮贴到页面顶部时它会把面板放到标题条底下 —— 2026-09-22 实测：
 * 整条搜索框被盖住，只看得到第一行命令。让 Radix 把顶部当成已有 40px + 8px 间距。
 */
const CAPABILITY_COMMAND_MENU_TOP_INSET = 48;

/** 超过这个数量才给搜索框：更短的列表一整屏就看得见，搜索只是噪音。 */
const CAPABILITY_COMMAND_SEARCH_THRESHOLD = 6;

function CapabilityActions({
  item,
  busy,
  onSetDefault,
  onSetPinned,
  onDelete,
}: {
  item: CapabilityItem;
  busy: string;
  onSetDefault: (kind: CapabilityKind, id: string, enabled: boolean) => Promise<unknown>;
  onSetPinned: (kind: CapabilityKind, id: string, pinned: boolean) => Promise<unknown>;
  onDelete: (item: CapabilityItem) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap justify-start gap-2" onClick={(event) => event.stopPropagation()}>
      <Button
        type="button"
        variant={item.defaultEnabled ? "default" : "secondary"}
        size="sm"
        disabled={Boolean(busy)}
        aria-pressed={item.defaultEnabled}
        onClick={() => void onSetDefault(item.kind, item.id, !item.defaultEnabled)}
      >
        {t("capability.context.defaultBadge")}
      </Button>
      <Button
        type="button"
        variant={item.pinned ? "default" : "secondary"}
        size="icon-sm"
        disabled={Boolean(busy)}
        aria-pressed={item.pinned}
        onClick={() => void onSetPinned(item.kind, item.id, !item.pinned)}
        aria-label={item.pinned ? t("capability.card.unpin") : t("capability.card.pin")}
        title={item.pinned ? t("capability.card.unpin") : t("capability.card.pin")}
      >
        <Pin />
      </Button>
      {canDeleteCapability(item) ? (
        <Button
          type="button"
          variant="destructive"
          size="icon-sm"
          disabled={Boolean(busy)}
          onClick={() => onDelete(item)}
          aria-label={t("capability.context.delete")}
          title={t("capability.context.delete")}
        >
          <Trash2 />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A package's `/` commands collapse into one trigger instead of one button each, so a package
 * with many commands still fits on its card. Shared by the Packages tab cards and the
 * context-panel package rows; both lay it out themselves (the card puts it at the end of the
 * status row, which is the card's bottom-right), so this wrapper adds no alignment of its own.
 *
 * 2026-09-22 用户实测「action 较多的时候显示不全」：19 条命令要 ~530px 的行高，而按钮上方
 * 往往只留得下 ~450px（窗口不高、卡片又在列表底部时更少）。所以这里不指望「一屏放下」——
 * 列表按 Radix 给的真实可用高度滚动（和模型供应商选择器同一套做法），命令多时顶上钉一个
 * 搜索框，滚动条由 AutoHideScroll 自己画（`thumbAlwaysVisible`：macOS 的原生 overlay 滚动条
 * 不滚动就看不见，而这里的截断恰好落在行边界上，看起来就像列表只有这么多）。
 * 不能用 DropdownMenu：它里面放输入框会被菜单的 typeahead / 方向键抢走按键。
 */
function CapabilityCommandMenu({
  commands,
  disabled,
  onRun,
}: {
  commands: CapabilityCommand[];
  disabled?: boolean;
  onRun: (command: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 选中命令后 Radix 默认把焦点还给触发按钮；命令已填进 composer，不能让它抢回去。 */
  const keepComposerFocus = useRef(false);
  const searchable = commands.length > CAPABILITY_COMMAND_SEARCH_THRESHOLD;
  const matches = filterPackageCommands(commands, query);

  // 展开就把光标放到能继续操作的地方：有搜索框就进搜索框（展开即打字），短列表落在第一行。
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (searchable) {
        searchRef.current?.focus();
      } else {
        listRef.current?.querySelector<HTMLButtonElement>("[data-command-row]")?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, searchable]);

  function run(name: string) {
    keepComposerFocus.current = true;
    setOpen(false);
    onRun(name);
  }

  /** 上下键在行间走位；搜索框里也走这套，否则光标进了输入框就只能用鼠标。 */
  function moveRow(step: number) {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-command-row]") ?? []);
    if (!rows.length) return;
    const current = rows.findIndex((row) => row === document.activeElement);
    const index = current < 0 ? (step > 0 ? 0 : rows.length - 1) : (current + step + rows.length) % rows.length;
    rows[index]?.focus();
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveRow(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    // 回车 = 执行第一条匹配：搜到就直接回车，不用再点一下。
    if (event.key === "Enter") {
      const first = matches[0];
      if (first) {
        event.preventDefault();
        run(first.name);
      }
    }
  }

  function onRowKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveRow(event.key === "ArrowDown" ? 1 : -1);
  }

  return (
    <div className="flex shrink-0" aria-label="Package commands" onClick={(event) => event.stopPropagation()}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={disabled}
            title={t("capability.card.commandsTitle")}
            aria-label={t("capability.card.commandsAria", { count: commands.length })}
          >
            <Terminal />
            {t("capability.card.actions")}
            <Badge variant="secondary" className="min-w-[18px] px-1 text-[10px]">{commands.length}</Badge>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          collisionPadding={{ top: CAPABILITY_COMMAND_MENU_TOP_INSET, right: 8, bottom: 8, left: 8 }}
          // 命令是「填进 composer」而不是执行：面板关掉时不要把焦点送回触发按钮。
          onCloseAutoFocus={(event) => {
            if (keepComposerFocus.current) {
              keepComposerFocus.current = false;
              event.preventDefault();
            }
          }}
          className="flex max-h-[var(--radix-popover-content-available-height,calc(100dvh-6rem))] w-[320px] max-w-(--radix-popover-content-available-width) flex-col overflow-hidden p-1"
        >
          {searchable ? (
            <div className="relative shrink-0 px-1 pt-1 pb-0.5">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                className="h-8 pl-7 text-xs"
                value={query}
                placeholder={t("capability.card.commandsSearch", { count: commands.length })}
                aria-label={t("capability.card.commandsSearchAria")}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
              />
            </div>
          ) : null}
          <AutoHideScroll className="min-h-0 flex-1" thumbAlwaysVisible>
            <div
              ref={listRef}
              aria-label={t("capability.card.commandsAria", { count: commands.length })}
              className="grid content-start gap-0.5 p-1"
            >
              {matches.length ? matches.map((command) => (
                <button
                  key={command.name}
                  type="button"
                  data-command-row
                  className="flex w-full min-w-0 cursor-default items-baseline gap-2 rounded-sm px-2 py-1.5 text-left outline-hidden select-none hover:bg-accent focus-visible:bg-accent"
                  onClick={() => run(command.name)}
                  onKeyDown={onRowKeyDown}
                >
                  <span className="min-w-0 shrink-0 font-mono text-xs">/{command.name}</span>
                  {command.description ? (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{command.description}</span>
                  ) : null}
                </button>
              )) : (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("capability.card.commandsEmpty")}</p>
              )}
            </div>
          </AutoHideScroll>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Every destructive capability removal (page cards, detail sheet, context
 * panel) passes through this prompt before anything is deleted from disk.
 */
function CapabilityDeleteDialog({
  item,
  busy = false,
  onCancel,
  onConfirm,
}: {
  item: CapabilityItem | null;
  /** True while the bridge is deleting: a package delete runs `npm uninstall` first. */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <AlertDialog
      open={Boolean(item)}
      onOpenChange={(next) => {
        // Radix asks to close on Action / Cancel / ESC. Once the delete is in flight the prompt
        // has to stay put until it settles, so those close requests are ignored while busy.
        if (!next && !busy) {
          onCancel();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {item?.kind === "package"
              ? t("capability.delete.packageTitle")
              : item?.kind === "mcp"
                ? t("capability.delete.mcpTitle")
                : t("capability.delete.skillTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("capability.delete.description", { name: item?.name ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {busy ? (
            <p className="mr-auto flex items-center gap-2 self-center text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("capability.delete.deleting")}
            </p>
          ) : null}
          <AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
            {t("capability.delete.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CapabilityDot({ kind, children }: { kind: CapabilityKind; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex size-10 min-w-10 items-center justify-center rounded-full text-sm font-bold",
        kind === "extension" ? "bg-secondary text-secondary-foreground" : "bg-primary text-primary-foreground",
      )}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

type CapabilityItem = CapabilitySkill | CapabilityPackage | CapabilityExtension | CapabilityMcpServer;

/**
 * One collapsible section of the project capabilities panel (Skills / Packages).
 *
 * The header copies the left sidebar's section pattern — a small muted label you can click to fold
 * the section away, and one compact ghost icon button — because the first version put a full-width
 * outline button in a ~330px panel: it read as a page toolbar and wrapped the package chips onto a
 * second line. The count rides on the label so a folded section still says how much is inside.
 */
function CapabilityPanelSection({
  title,
  count,
  collapsed,
  onToggleCollapsed,
  action,
  children,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-2.5">
      <div className="mb-1 flex min-w-0 items-center justify-between gap-1">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-1.5 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")} />
          <span className="truncate">{title}</span>
          <span className="shrink-0 tabular-nums opacity-60">{count}</span>
        </button>
        {action}
      </div>
      {collapsed ? null : <div className="grid gap-0.5 pt-0.5">{children}</div>}
    </section>
  );
}
/* moved to src/app/SkillImportSurfaces.tsx */

/* moved to src/app/SkillImportSurfaces.tsx */

/* moved to src/app/SkillImportSurfaces.tsx */


function SkillList({ skills }: { skills: SkillSummary[] }) {
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(() => new Set());
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [skillContent, setSkillContent] = useState<Record<string, string>>({});
  const [contentError, setContentError] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  function toggleSkill(path: string) {
    setExpandedSkills((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function openSkill(skill: SkillSummary) {
    setSelectedSkill(skill);
    setContentError(null);
    if (skillContent[skill.path]) {
      return;
    }

    setLoadingPath(skill.path);
    try {
      const result = await fetchJson<{ content: string }>(`/api/skills/content?path=${encodeURIComponent(skill.path)}`);
      setSkillContent((current) => ({ ...current, [skill.path]: result.content }));
    } catch (error) {
      setContentError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingPath(null);
    }
  }

  if (!skills.length) {
    return <p className="text-sm text-muted-foreground">No skills loaded</p>;
  }

  return (
    <>
      <div className="grid">
        {skills.map((skill) => {
          const isExpanded = expandedSkills.has(skill.path);
          const needsToggle = skill.description.length > skillDescriptionPreviewLength;
          const description = isExpanded || !needsToggle
            ? skill.description
            : `${skill.description.slice(0, skillDescriptionPreviewLength).trimEnd()}...`;
          return (
            <article
              key={skill.path}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2.5 border-b py-2.5 last:border-b-0"
            >
              <div className="min-w-0">
                <strong className="mb-1 block text-sm">{skill.name}</strong>
                <p className="text-sm leading-snug break-words text-muted-foreground">
                  <span>{description}</span>
                  {needsToggle ? (
                    <Button
                      type="button"
                      variant="link"
                      className="ml-1.5 h-auto p-0 align-baseline text-sm underline underline-offset-2"
                      onClick={() => toggleSkill(skill.path)}
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? "Collapse" : "Expand"}
                    </Button>
                  ) : null}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="mt-0.5"
                onClick={() => void openSkill(skill)}
                aria-label={`Open ${skill.name}`}
                title="Open full skill"
              >
                <BookOpen />
              </Button>
            </article>
          );
        })}
      </div>

      <Dialog
        open={Boolean(selectedSkill)}
        onOpenChange={(next) => {
          if (!next) {
            setSelectedSkill(null);
          }
        }}
      >
        <DialogContent className="h-[min(86svh,760px)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogDescription className="text-xs font-medium tracking-wide uppercase">Skill</DialogDescription>
            <DialogTitle className="text-xl">{selectedSkill?.name}</DialogTitle>
          </DialogHeader>
          <div className="grid min-h-0 gap-3.5 overflow-y-auto pr-1">
            {selectedSkill && loadingPath === selectedSkill.path ? <p className="text-sm text-muted-foreground">Loading skill...</p> : null}
            {contentError ? <p className="text-sm text-destructive" role="status">{contentError}</p> : null}
            {selectedSkill && skillContent[selectedSkill.path] ? <MarkdownContent text={skillContent[selectedSkill.path]} /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
/* moved to src/app/SlashMenu.tsx */


const skillDescriptionPreviewLength = 120;
/* moved to src/app/SlashMenu.tsx */


export { CAPABILITY_COMMAND_MENU_TOP_INSET, CAPABILITY_COMMAND_SEARCH_THRESHOLD, CapabilityActions, CapabilityCommandMenu, CapabilityDeleteDialog, CapabilityDot, CapabilityPanelSection, KeyValueEditor, PackageInstallDialog, SkillImportDialog, SkillList, SlashMenu, skillDescriptionPreviewLength, slashMenuItemKey };
export type { CapabilityItem };
