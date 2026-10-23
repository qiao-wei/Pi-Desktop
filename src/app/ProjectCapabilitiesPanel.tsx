/**
 * 项目能力面板.
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */

import { useT } from "../i18n/react";
import { openTarget } from "../lib/open-target";
import { loadUiPreferences, saveUiPreferences } from "../lib/ui-preferences";
import { canDeleteCapability, matchesCapabilityQuery, scopedCapabilityItems } from "../shared/capabilityScope";
import type { CapabilitiesState, CapabilityKind, CapabilityMcpDetail, CapabilityMcpImportResult, CapabilityMcpInspection } from "../types";
import { CapabilityDetailDialog, CapabilityResourceChips, McpServerDialog, PACKAGE_CATALOG_URL, PackageResourcesDialog, PackageResourcesRequest, chooseSkillFolderPath } from "./CapabilitiesPage";
import { CapabilityCommandMenu, CapabilityDeleteDialog, CapabilityItem, CapabilityPanelSection, PackageInstallDialog, SkillImportDialog } from "./CapabilitySurfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ExternalLink, FolderOpen, Plug, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

/** The project panel's two sections; the id is what UI preferences store as collapsed. */
type CapabilitySectionId = "skills" | "packages" | "mcp";

/**
 * Conversation context panel: only what *this project* brings in. The open/close
 * switch fires the very same `onSetDefault` call the Global skills & packages
 * cards use, so both surfaces always agree on the stored default.
 */
function ProjectCapabilitiesPanel({
  capabilities,
  projectName,
  onSetDefault,
  onSetPinned,
  onDelete,
  onImportSkill,
  onInstallPackage,
  onUpdatePackage,
  onInsertPackageCommand,
  onSaveMcpServer,
  onInspectMcpServer,
  onReadMcpServer,
  onParseMcpImport,
}: {
  capabilities: CapabilitiesState;
  /** 面板只列项目级能力，标题里却全是 Skills / Packages —— 用项目名把归属说清楚。 */
  projectName: string;
  onSetDefault: (kind: CapabilityKind, id: string, enabled: boolean) => Promise<unknown>;
  onSetPinned: (kind: CapabilityKind, id: string, pinned: boolean) => Promise<unknown>;
  onDelete: (item: CapabilityItem) => Promise<unknown>;
  onImportSkill: (sourcePath: string, scope?: "user" | "project") => Promise<unknown>;
  onInstallPackage: (source: string, scope?: "user" | "project", autoload?: boolean, onProgress?: (message: string) => void) => Promise<unknown>;
  onUpdatePackage: (source?: string, onProgress?: (message: string) => void) => Promise<unknown>;
  /** 点 action 只把命令填进 composer（不执行）。 */
  onInsertPackageCommand: (packageId: string, command: string) => void;
  onSaveMcpServer: (server: Record<string, unknown>) => Promise<unknown>;
  onInspectMcpServer: (id: string) => Promise<CapabilityMcpInspection>;
  onReadMcpServer: (id: string) => Promise<CapabilityMcpDetail>;
  onParseMcpImport: (text: string, defaultName?: string) => Promise<CapabilityMcpImportResult>;
}) {
  const t = useT();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<CapabilityItem | null>(null);
  const [query, setQuery] = useState("");
  const [skillImportPath, setSkillImportPath] = useState("");
  const [isChoosingSkillFolder, setIsChoosingSkillFolder] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [resourceRequest, setResourceRequest] = useState<PackageResourcesRequest | null>(null);
  /** The row the detail sheet is open for; both kinds click through to the same sheet as the page. */
  const [selected, setSelected] = useState<CapabilityItem | null>(null);
  // Folded sections are remembered across restarts, same as the settings page's provider groups.
  const [collapsedSections, setCollapsedSections] = useState<CapabilitySectionId[]>(
    () => (loadUiPreferences().capabilityPanelCollapsedSections ?? []) as CapabilitySectionId[],
  );
  const projectSkills = useMemo(() => scopedCapabilityItems(capabilities.skills, "project"), [capabilities.skills]);
  const projectPackages = useMemo(() => scopedCapabilityItems(capabilities.packages, "project"), [capabilities.packages]);
  // MCP 也是项目级能力的一种：面板只列 scope=project 的服务器，agent 级的在全局页。
  const projectMcp = useMemo(
    () => (capabilities.mcpServers ?? []).filter((server) => server.scope === "project"),
    [capabilities.mcpServers],
  );
  const searchedSkills = useMemo(
    () => projectSkills.filter((item) => matchesCapabilityQuery(item, query)),
    [projectSkills, query],
  );
  const searchedPackages = useMemo(
    () => projectPackages.filter((item) => matchesCapabilityQuery(item, query)),
    [projectPackages, query],
  );
  const searchedMcp = useMemo(
    () => projectMcp.filter((item) => matchesCapabilityQuery(item, query)),
    [projectMcp, query],
  );

  async function toggle(item: CapabilityItem, enabled: boolean) {
    setBusy(`${item.kind}:${item.id}`);
    setError("");
    try {
      await onSetDefault(item.kind, item.id, enabled);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  /** Same two-step contract as the page: request here, delete only on confirm. */
  async function confirmDelete() {
    const item = pendingDelete;
    if (!item) {
      return;
    }
    // Same as the page: hold the prompt (with its "deleting" state) until the bridge answers.
    setSelected(null);
    setBusy("delete");
    setError("");
    try {
      await onDelete(item);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
      setPendingDelete(null);
    }
  }

  /** Same flow as the Global page: choose a folder first, then pick the scope in the dialog. */
  async function chooseSkillFolder() {
    setError("");
    setIsChoosingSkillFolder(true);
    try {
      const folder = await chooseSkillFolderPath();
      if (folder) {
        setSkillImportPath(folder);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setIsChoosingSkillFolder(false);
    }
  }

  /**
   * Both sections fold independently, and the fold is remembered in UI preferences (same idea as
   * the settings page's provider groups) so reopening the panel keeps the shape the user left it in.
   */
  function toggleSection(section: CapabilitySectionId) {
    setCollapsedSections((current) => {
      const next = current.includes(section)
        ? current.filter((id) => id !== section)
        : [...current, section];
      saveUiPreferences({ capabilityPanelCollapsedSections: next });
      return next;
    });
  }

  function renderSection(
    section: CapabilitySectionId,
    title: string,
    items: CapabilityItem[],
    emptyText: string,
    action: ReactNode,
  ) {
    return (
      <CapabilityPanelSection
        key={section}
        title={title}
        count={items.length}
        collapsed={collapsedSections.includes(section)}
        onToggleCollapsed={() => toggleSection(section)}
        action={action}
      >
        {items.length ? items.map((item) => {
          const key = `${item.kind}:${item.id}`;
          const label = item.defaultEnabled ? t("capability.state.turnOff") : t("capability.state.turnOn");

          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              className="flex cursor-pointer items-start justify-between gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              onClick={() => setSelected(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelected(item);
                }
              }}
            >
              <div className="grid min-w-0 gap-1">
                <strong className="truncate text-[13px] font-medium">{item.name}</strong>
                <span className="truncate text-[12px] text-muted-foreground">
                  {item.kind === "package" || item.kind === "mcp"
                    ? item.description || item.source
                    : item.description || item.path}
                </span>
                {/* Same four resource types as the Global page's package cards, minus the empty
                    ones + the pill padding — a narrow panel row is a list, not a market grid. */}
                {item.kind === "package" && item.resources ? (
                  <CapabilityResourceChips
                    compact
                    item={item}
                    onOpen={(pkg, type) => setResourceRequest({ item: pkg, type })}
                  />
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 pt-0.5" onClick={(event) => event.stopPropagation()}>
                {item.kind === "package" && item.commands.length > 0 ? (
                  <CapabilityCommandMenu
                    commands={item.commands}
                    disabled={Boolean(busy)}
                    onRun={(command) => onInsertPackageCommand(item.id, command)}
                  />
                ) : null}
                {canDeleteCapability(item) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 text-muted-foreground"
                    disabled={Boolean(busy)}
                    onClick={() => setPendingDelete(item)}
                    aria-label={t("capability.context.delete")}
                    title={t("capability.context.delete")}
                  >
                    <Trash2 className="size-[15px]" />
                  </Button>
                ) : null}
                <Switch
                  checked={item.defaultEnabled}
                  disabled={Boolean(busy)}
                  onCheckedChange={(next) => void toggle(item, next)}
                  aria-label={`${label} ${item.name}`}
                  title={t("capability.state.effectiveAfterToggle", { action: label })}
                />
              </div>
            </div>
          );
        }) : <p className="px-1 py-1 text-[12.5px] text-muted-foreground">{query.trim() ? t("capability.state.noMatch") : emptyText}</p>}
      </CapabilityPanelSection>
    );
  }

  return (
    <>
      {error ? <p className="mb-3 text-sm text-destructive" role="status">{error}</p> : null}
      {/* 面板和全局页的 section 名完全一样（Skills / Packages），光看标题分不出范围。
          所以在搜索框上方常驻一行「项目级 · <项目名>」+ 一句来源提示。 */}
      <div className="mb-2.5 grid min-w-0 gap-0.5" title={t("capability.context.scopeHintTitle")}>
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant="secondary" className="h-[18px] shrink-0 rounded px-1.5 text-[10.5px] font-medium">
            {t("capability.context.scopeBadge")}
          </Badge>
          <span className="min-w-0 truncate text-[12px] font-medium text-foreground">{projectName}</span>
        </div>
        <p className="min-w-0 text-[11px] text-muted-foreground">{t("capability.context.scopeHint")}</p>
      </div>
      <Input
        className="mb-3 h-8 bg-background text-[13px]"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("capability.context.searchPlaceholder")}
        aria-label={t("capability.context.searchAria")}
      />
      {renderSection("skills", t("capability.section.skills"), searchedSkills, t("capability.context.noSkills"), (
        // Icon-only + tooltip, like the left sidebar's “new project”: a labelled outline button
        // dominates a panel this narrow.
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-mr-1 size-7 shrink-0 text-muted-foreground"
          disabled={isChoosingSkillFolder}
          onClick={() => void chooseSkillFolder()}
          aria-label={t("capability.market.importSkill")}
          title={isChoosingSkillFolder ? t("capability.market.choosingFolder") : t("capability.market.importSkill")}
        >
          <FolderOpen className="size-[17px]" />
        </Button>
      ))}
      {renderSection("mcp", t("capability.section.mcp"), searchedMcp, t("capability.context.noMcp"), (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-mr-1 size-7 shrink-0 text-muted-foreground"
          onClick={() => setMcpDialogOpen(true)}
          aria-label={t("capability.mcp.addServer")}
          title={t("capability.mcp.addServer")}
        >
          <Plug className="size-[17px]" />
        </Button>
      ))}
      {renderSection("packages", t("capability.section.packages"), searchedPackages, t("capability.context.noPackages"), (
        <div className="flex shrink-0 items-center gap-0.5">
          {/* 面板这里和全局页的 Packages 一样，给一个通向 pi.dev 目录的入口。 */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0 text-muted-foreground"
            onClick={() => void openTarget(PACKAGE_CATALOG_URL)}
            aria-label={t("capability.market.packageCatalog")}
            title={t("capability.market.packageCatalogHint")}
          >
            <ExternalLink className="size-[17px]" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-1 size-7 shrink-0 text-muted-foreground"
            onClick={() => setInstallOpen(true)}
            aria-label={t("capability.market.installPackage")}
            title={t("capability.market.installPackage")}
          >
            <Plus className="size-[17px]" />
          </Button>
        </div>
      ))}
      <CapabilityDeleteDialog
        item={pendingDelete}
        busy={busy === "delete"}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
      {skillImportPath ? (
        <SkillImportDialog path={skillImportPath} onClose={() => setSkillImportPath("")} onImport={onImportSkill} />
      ) : null}
      {installOpen ? (
        <PackageInstallDialog
          defaultScope="project"
          onClose={() => setInstallOpen(false)}
          onInstall={onInstallPackage}
        />
      ) : null}
      {mcpDialogOpen ? (
        <McpServerDialog
          defaultScope="project"
          onClose={() => setMcpDialogOpen(false)}
          onSave={onSaveMcpServer}
          onReadMcpServer={onReadMcpServer}
          onParseImport={onParseMcpImport}
        />
      ) : null}
      <PackageResourcesDialog request={resourceRequest} onClose={() => setResourceRequest(null)} />
      {selected ? (
        <CapabilityDetailDialog
          item={selected}
          busy={busy}
          onClose={() => setSelected(null)}
          onSetDefault={onSetDefault}
          onSetPinned={onSetPinned}
          onDelete={setPendingDelete}
          onUpdatePackage={onUpdatePackage}
          onSaveMcpServer={onSaveMcpServer}
          onInspectMcpServer={onInspectMcpServer}
          onReadMcpServer={onReadMcpServer}
        />
      ) : null}
    </>
  );
}

export { ProjectCapabilitiesPanel };
export type { CapabilitySectionId };
