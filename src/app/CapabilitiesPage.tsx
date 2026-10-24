/**
 * 能力页.
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */

import { useT } from "../i18n/react";


import { openTarget } from "../lib/open-target";
import { invokeHost } from "../lib/shell/host.ts";
import { loadUiPreferences, saveUiPreferences } from "../lib/ui-preferences";
import { CAPABILITY_TABS, SKILL_SOURCE_CATEGORIES, SKILL_SOURCE_CATEGORY_LABEL_KEYS, matchesCapabilityQuery, matchesSkillCategory, scopedCapabilityItems } from "../shared/capabilityScope";
import type { CapabilityScopeTab, SkillSourceCategory } from "../shared/capabilityScope";




import type { CapabilitiesState, CapabilityKind, CapabilityMcpDetail, CapabilityMcpImportResult, CapabilityMcpInspection, CapabilityMcpServer, CapabilityPackage, CapabilityPackageResourceType } from "../types";
import { CapabilityDeleteDialog, CapabilityDot, CapabilityItem, PackageInstallDialog, SkillImportDialog } from "./CapabilitySurfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import { Input } from "@/components/ui/input";


import { Switch } from "@/components/ui/switch";

import { cn } from "@/lib/utils";
import { AlertTriangle, BookOpen, ChevronDown, ChevronUp, ExternalLink, Folder, FolderOpen, Pencil, Pin, Plug, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MCP_EXPOSURE_HINT_KEYS, MCP_EXPOSURE_LABEL_KEYS, MCP_IMPORT_FORMAT_KEYS, McpServerDialog, McpServerEditor, mcpImportFormatKey } from "./CapabilitiesMcp";
import { CAPABILITY_RESOURCE_LABEL_KEYS, CapabilityDetailDialog, CapabilityMarketCard, CapabilityResourceChips, PackageResourcesDialog, PackageResourcesLoaded, PackageResourcesRequest, capabilityInitial, capabilityLoadClass, capabilityLoadLabel, formatFileSize, loadPackageResourceFile } from "./CapabilityDetail";
/* moved to src/app/CapabilityDetail.tsx */


/** 告警折叠把手的 `aria-controls` 目标：收起时它指向的块带 `hidden`，仍在 DOM 里。 */
const SKILL_DIAGNOSTICS_ID = "capability-skill-diagnostics";

const CAPABILITY_TAB_META: Record<CapabilityScopeTab, { label: string; Icon: typeof BookOpen }> = {
  skill: { label: "Skills", Icon: BookOpen },
  package: { label: "Packages", Icon: Folder },
  // pi 0.99 的内置 MCP：服务器定义住在 mcp.json，不再走 pi-mcp-adapter。
  mcp: { label: "MCP", Icon: Plug },
};

function CapabilitiesPage({
  capabilities,
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
  customUiCancelVersion,
}: {
  capabilities: CapabilitiesState;
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
  /** 从 JSON 配置解析出一个可填进新增表单的服务器（不落盘）。 */
  onParseMcpImport: (text: string, defaultName?: string) => Promise<CapabilityMcpImportResult>;
  customUiCancelVersion: number;
}) {
  const t = useT();
  const [tab, setTab] = useState<CapabilityScopeTab>(() => loadUiPreferences().capabilityScopeTab ?? "skill");
  const [selectedKey, setSelectedKey] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CapabilityItem | null>(null);
  const [skillCategory, setSkillCategory] = useState<SkillSourceCategory>("all");
  /** 加载器诊断默认收起：它可能列好几条重名路径，展开会把技能列表挤下去。 */
  const [skillDiagnosticsOpen, setSkillDiagnosticsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [skillImportPath, setSkillImportPath] = useState("");
  const [isChoosingSkillFolder, setIsChoosingSkillFolder] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  /** 新增/编辑 MCP 服务器；`server` 为空是新增，scope 由 tab 上下文决定。 */
  const [mcpDialog, setMcpDialog] = useState<{ server?: CapabilityMcpServer; defaultScope?: "user" | "project" } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [resourceRequest, setResourceRequest] = useState<PackageResourcesRequest | null>(null);

  /** 标签页跟着页面实例一起被卸载，所以把选择写进 ui-preferences；下次进来还停在 Packages。 */
  function selectTab(next: CapabilityScopeTab) {
    setTab(next);
    saveUiPreferences({ capabilityScopeTab: next });
  }

  // This page is the *global* surface: builtin + agent-level skills and
  // user-scope packages. Project-scoped ones belong to the conversation panel.
  const rawItems: CapabilityItem[] = tab === "skill"
    ? capabilities.skills
    : tab === "package"
      ? capabilities.packages
      : (capabilities.mcpServers ?? []);
  const globalItems = useMemo(() => scopedCapabilityItems(rawItems, "global"), [rawItems]);
  const searchedItems = useMemo(() => {
    return globalItems.filter((item) => matchesCapabilityQuery(item, query));
  }, [query, globalItems]);
  const pinnedItems = searchedItems.filter((item) => item.pinned);
  const installedItems = searchedItems.filter((item) => (
    !item.pinned
    && (tab !== "skill" || matchesSkillCategory(item, skillCategory))
  ));
  const selected = globalItems.find((item) => `${item.kind}:${item.id}` === selectedKey);
  // 只看关键：诊断源是**整个**技能清单（含项目级），所以它只管当前这个 tab 上的那条告警。
  const skillDiagnostics = capabilities.skillDiagnostics ?? [];

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  /**
   * Removing a capability deletes files on disk, so the card and the detail
   * sheet only *request* it; the actual call runs from the confirmation dialog.
   */
  function requestDelete(item: CapabilityItem) {
    setPendingDelete(item);
  }

  async function confirmDelete() {
    const item = pendingDelete;
    if (!item) {
      return;
    }
    // The prompt stays up while the bridge works — a package delete shells out to
    // `npm uninstall`, which can take tens of seconds, and a prompt that vanishes on
    // click reads as "already done". It closes once the call settles, either way, so a
    // failure still lands in the page's own error strip instead of behind the dialog.
    await run("delete", async () => {
      await onDelete(item);
      setDetailOpen(false);
    });
    setPendingDelete(null);
  }

  /** Only records what was clicked: CapabilityDetailDialog reads the content for both surfaces. */
  function openItem(item: CapabilityItem) {
    setSelectedKey(`${item.kind}:${item.id}`);
    setInstallOpen(false);
    setDetailOpen(true);
  }

  function openNewPackage() {
    setSelectedKey("");
    // Installing lives in its own dialog now; make sure a package detail sheet opened earlier is not
    // left sitting behind it.
    setDetailOpen(false);
    setInstallOpen(true);
  }

  /** The chips only carry counts from the snapshot; entries are resolved when the dialog opens. */
  function openPackageResources(item: CapabilityPackage, type: CapabilityPackageResourceType) {
    setResourceRequest({ item, type });
  }

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

  function closeSkillImport() {
    setSkillImportPath("");
    setError("");
  }

  useEffect(() => {
    if (customUiCancelVersion > 0) {
      setBusy("");
      setError("");
    }
  }, [customUiCancelVersion]);

  const addLabel = tab === "skill"
    ? (isChoosingSkillFolder ? t("capability.market.choosingFolder") : t("capability.market.importSkill"))
    : tab === "package"
      ? t("capability.market.installPackage")
      : t("capability.mcp.addServer");
  const searchPlaceholder = tab === "skill"
    ? t("capability.market.searchSkills")
    : tab === "package"
      ? t("capability.market.searchPackages")
      : t("capability.mcp.searchServers");
  function handleAdd() {
    if (tab === "skill") {
      void chooseSkillFolder();
    } else if (tab === "package") {
      openNewPackage();
    } else {
      setMcpDialog({ defaultScope: "user" });
    }
  }

  /** MCP 卡片自成一系（连接状态/工具数/transport），其余三类共用市场卡片。 */
  function renderCard(item: CapabilityItem) {
    if (item.kind === "mcp") {
      return (
        <CapabilityMcpCard
          key={`mcp:${item.id}`}
          server={item}
          selected={selected?.id === item.id}
          busy={busy}
          onOpen={openItem}
          onEdit={() => setMcpDialog({ server: item, defaultScope: item.scope })}
          onSetDefault={onSetDefault}
          onSetPinned={onSetPinned}
          onDelete={requestDelete}
        />
      );
    }

    return (
      <CapabilityMarketCard
        key={`${item.kind}:${item.id}`}
        item={item}
        selected={selected?.id === item.id}
        busy={busy}
        onOpen={openItem}
        onOpenResources={openPackageResources}
        onSetDefault={onSetDefault}
        onSetPinned={onSetPinned}
        onDelete={requestDelete}
        onInsertPackageCommand={onInsertPackageCommand}
      />
    );
  }

  const installedTitle = tab === "mcp" ? t("capability.mcp.installedTitle") : t("capability.market.installedTitle");
  const installedEmpty = tab === "mcp" ? t("capability.mcp.noServers") : t("capability.market.noInstalledProjects");

  return (
    <section className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-muted" aria-labelledby="capabilities-page-title">
      <header className="flex min-w-0 items-center justify-between gap-[18px] px-6 pt-5 pb-3.5 max-[920px]:flex-col max-[920px]:items-stretch">
        <h1 id="capabilities-page-title" className="sr-only">Global skills &amp; packages</h1>
        <nav className="flex min-w-0 items-center gap-2.5" aria-label={t("capability.market.typeAria")}>
          {CAPABILITY_TABS.map((value) => {
            const { label, Icon } = CAPABILITY_TAB_META[value];

            return (
              <Button
                key={value}
                type="button"
                variant={tab === value ? "default" : "ghost"}
                className="h-10 px-4 font-semibold"
                aria-current={tab === value ? "page" : undefined}
                onClick={() => selectTab(value)}
              >
                <Icon className="size-[18px]" />
                <span>{label}</span>
              </Button>
            );
          })}
        </nav>
        <div className="flex min-w-[280px] items-center justify-end gap-2.5 max-[920px]:min-w-0 max-[920px]:flex-col max-[920px]:items-stretch">
          <Input
            className="h-10 w-[min(100%,280px)] bg-background max-[920px]:w-full"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
          {/* 目录入口只在 Packages 标签下出现：它通向 pi.dev 的 Package 目录，和 Skills 无关。 */}
          {tab === "package" ? (
            <Button
              type="button"
              variant="outline"
              className="h-10 font-semibold"
              onClick={() => void openTarget(PACKAGE_CATALOG_URL)}
              aria-label={t("capability.market.packageCatalog")}
              title={t("capability.market.packageCatalogHint")}
            >
              <ExternalLink />
              {t("capability.market.packageCatalog")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="h-10 font-semibold"
            disabled={tab === "skill" && isChoosingSkillFolder}
            onClick={handleAdd}
          >
            {tab === "skill" ? <FolderOpen /> : tab === "package" ? <Plus /> : <Plug />}
            {addLabel}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] px-6 pb-6 max-[920px]:overflow-y-auto">
        <div className="min-h-0 min-w-0 overflow-y-auto pr-1 max-[920px]:overflow-visible">
          {error ? <p className="mb-3 text-sm text-destructive" role="status">{error}</p> : null}

          {pinnedItems.length ? (
          <section className="mb-[30px] grid gap-3.5">
            <div className="flex min-w-0 items-baseline gap-[18px]">
              <h2 className="text-2xl leading-tight font-semibold">{t("capability.market.pinnedTitle")}</h2>
              <Badge variant="secondary" className="min-w-[26px] text-sm">{pinnedItems.length}</Badge>
            </div>
            <div className="grid min-w-0 grid-cols-3 gap-3.5 max-[1350px]:grid-cols-2 max-[920px]:grid-cols-1">
              {pinnedItems.length ? pinnedItems.map((item) => renderCard(item)) : null}
            </div>
          </section>
          ) : null}

          <section className="mb-[30px] grid gap-3.5">
            <div className="flex min-w-0 items-baseline gap-[18px]">
              <h2 className="text-2xl leading-tight font-semibold">{installedTitle}</h2>
              <Badge variant="secondary" className="min-w-[26px] text-sm">{installedItems.length}</Badge>
            </div>
            {tab === "skill" ? (
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-0.5" aria-label={t("capability.market.sourceCategoryAria")}>
                  {SKILL_SOURCE_CATEGORIES.map((category) => (
                    <Button
                      key={category}
                      type="button"
                      size="sm"
                      variant={skillCategory === category ? "secondary" : "ghost"}
                      className="font-semibold"
                      aria-pressed={skillCategory === category}
                      onClick={() => setSkillCategory(category)}
                    >
                      {t(SKILL_SOURCE_CATEGORY_LABEL_KEYS[category])}
                    </Button>
                  ))}
                </div>
                {/* 折叠把手常驻在筛选行右端：收起时它只占一个按钮的宽度（不新增一行、不用警示色），
                    因此「有告警」这件事仍然看得见，只是不再把技能列表往下挤。 */}
                {skillDiagnostics.length ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 gap-1.5 px-2 text-[11.5px] font-medium text-muted-foreground hover:text-foreground"
                    aria-expanded={skillDiagnosticsOpen}
                    aria-controls={SKILL_DIAGNOSTICS_ID}
                    title={skillDiagnosticsOpen
                      ? t("capability.skillDiagnostics.collapse")
                      : t("capability.skillDiagnostics.expand")}
                    onClick={() => setSkillDiagnosticsOpen((open) => !open)}
                  >
                    <AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                    {t("capability.skillDiagnostics.title")}
                    <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px] tabular-nums">
                      {skillDiagnostics.length}
                    </Badge>
                    {skillDiagnosticsOpen
                      ? <ChevronUp className="size-3.5" aria-hidden="true" />
                      : <ChevronDown className="size-3.5" aria-hidden="true" />}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {tab === "skill" && skillDiagnostics.length ? (
              // 重名冲突时 pi 保留先发现的那份、丢掉后来的：只看到一个技能不见了而没有任何
              // 解释，是用户最不能自解的一类问题，所以把加载器的诊断原样贴出来。
              <div
                id={SKILL_DIAGNOSTICS_ID}
                hidden={!skillDiagnosticsOpen}
                className="grid gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5"
                role="status"
                aria-label={t("capability.skillDiagnostics.title")}
              >
                <p className="text-[12.5px] font-medium text-foreground">
                  {t("capability.skillDiagnostics.title")}
                </p>
                <p className="text-[11.5px] text-muted-foreground">{t("capability.skillDiagnostics.hint")}</p>
                <ul className="grid gap-1">
                  {skillDiagnostics.map((diagnostic, index) => (
                    <li key={`${diagnostic.type}:${diagnostic.path}:${index}`} className="grid gap-0.5">
                      <span className="text-[11.5px] text-foreground">{diagnostic.message}</span>
                      {diagnostic.path ? (
                        <code className="truncate text-[11px] text-muted-foreground" title={diagnostic.path}>
                          {diagnostic.path}
                        </code>
                      ) : null}
                      {diagnostic.collision?.winnerPath ? (
                        <code
                          className="truncate text-[11px] text-muted-foreground"
                          title={diagnostic.collision.winnerPath}
                        >
                          {t("capability.skillDiagnostics.kept", { path: diagnostic.collision.winnerPath })}
                        </code>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="grid min-w-0 grid-cols-3 gap-3.5 max-[1350px]:grid-cols-2 max-[920px]:grid-cols-1">
              {installedItems.length ? installedItems.map((item) => renderCard(item)) : <p className="text-sm text-muted-foreground">{installedEmpty}</p>}
            </div>
          </section>

        </div>
      </div>

      {skillImportPath ? (
        <SkillImportDialog path={skillImportPath} onClose={closeSkillImport} onImport={onImportSkill} />
      ) : null}

      {installOpen ? (
        <PackageInstallDialog
          defaultScope="user"
          onClose={() => setInstallOpen(false)}
          onInstall={onInstallPackage}
        />
      ) : null}

      {mcpDialog ? (
        <McpServerDialog
          server={mcpDialog.server}
          defaultScope={mcpDialog.defaultScope ?? "user"}
          onClose={() => setMcpDialog(null)}
          onSave={onSaveMcpServer}
          onReadMcpServer={onReadMcpServer}
          onParseImport={onParseMcpImport}
        />
      ) : null}

      {detailOpen && selected ? (
        <CapabilityDetailDialog
          item={selected}
          busy={busy}
          onClose={() => setDetailOpen(false)}
          onSetDefault={onSetDefault}
          onSetPinned={onSetPinned}
          onDelete={requestDelete}
          onUpdatePackage={onUpdatePackage}
          onSaveMcpServer={onSaveMcpServer}
          onInspectMcpServer={onInspectMcpServer}
          onReadMcpServer={onReadMcpServer}
        />
      ) : null}

      <PackageResourcesDialog request={resourceRequest} onClose={() => setResourceRequest(null)} />

      <CapabilityDeleteDialog
        item={pendingDelete}
        busy={busy === "delete"}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
/* moved to src/app/CapabilityDetail.tsx */

/* moved to src/app/CapabilityDetail.tsx */


/** MCP 服务器卡片：连接状态用「工具数」表达，transport / exposure / 覆盖关系都是徽章。 */
function CapabilityMcpCard({
  server,
  selected,
  busy,
  onOpen,
  onEdit,
  onSetDefault,
  onSetPinned,
  onDelete,
}: {
  server: CapabilityMcpServer;
  selected: boolean;
  busy: string;
  onOpen: (item: CapabilityItem) => void;
  onEdit: () => void;
  onSetDefault: (kind: CapabilityKind, id: string, enabled: boolean) => Promise<unknown>;
  onSetPinned: (kind: CapabilityKind, id: string, pinned: boolean) => Promise<unknown>;
  onDelete: (item: CapabilityItem) => void;
}) {
  const t = useT();
  const status = !server.enabled
    ? t("capability.state.disabled")
    : server.active
      ? t("capability.mcp.connected", { count: server.toolCount })
      : t("capability.mcp.notConnected");

  return (
    <Card
      className={cn(
        "min-h-[150px] cursor-pointer gap-3 rounded-lg border-transparent py-5 shadow-sm hover:border-border",
        selected && "border-border",
      )}
      onClick={() => onOpen(server)}
    >
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-5">
        <CapabilityDot kind="mcp">M</CapabilityDot>
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{server.name}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {server.scope === "project" ? t("capability.source.project") : t("capability.source.agent")}
            {" · "}
            {server.transport === "http" ? t("capability.mcp.transport.http") : t("capability.mcp.transport.stdio")}
          </p>
        </div>
        <div className="flex items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            disabled={Boolean(busy)}
            onClick={onEdit}
            aria-label={t("capability.mcp.edit")}
            title={t("capability.mcp.edit")}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            disabled={Boolean(busy)}
            onClick={() => onDelete(server)}
            aria-label={t("capability.context.delete")}
            title={t("capability.context.delete")}
          >
            <Trash2 />
          </Button>
          <Button
            type="button"
            variant={server.pinned ? "secondary" : "ghost"}
            size="icon-sm"
            className="size-7"
            disabled={Boolean(busy)}
            onClick={() => void onSetPinned("mcp", server.id, !server.pinned)}
            aria-label={server.pinned ? t("capability.card.unpin") : t("capability.card.pin")}
            title={server.pinned ? t("capability.card.unpin") : t("capability.card.pin")}
          >
            <Pin />
          </Button>
          <Switch
            checked={server.enabled}
            disabled={Boolean(busy)}
            onCheckedChange={(next) => void onSetDefault("mcp", server.id, next)}
            aria-label={t("capability.mcp.toggleEnabled", { name: server.name })}
            title={t("capability.mcp.toggleEnabled", { name: server.name })}
          />
        </div>
        <div className="col-span-3 flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{t(MCP_EXPOSURE_LABEL_KEYS[server.exposure])}</Badge>
          {server.overridesGlobal ? <Badge variant="outline">{t("capability.mcp.overridesGlobal")}</Badge> : null}
        </div>
      </div>
      <p className="line-clamp-2 min-h-0 px-5 text-sm leading-relaxed break-words text-muted-foreground">
        {server.description || server.source}
      </p>
      <div className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 text-xs text-muted-foreground">
        <span>{status}</span>
        <span className="min-w-0 truncate font-mono" title={server.source}>{server.source}</span>
      </div>
    </Card>
  );
}
/* moved to src/app/CapabilityDetail.tsx */

/* moved to src/app/CapabilitiesMcp.tsx */

/* moved to src/app/CapabilitiesMcp.tsx */

/* moved to src/app/CapabilitiesMcp.tsx */

/* moved to src/app/CapabilitiesMcp.tsx */

/* moved to src/app/CapabilitiesMcp.tsx */


/**
 * pi 官方的 Package 目录。全局页与项目面板各有一个入口，共用这一个常量，避免两处各自
 * 硬编码 URL 后漂移。
 */
const PACKAGE_CATALOG_URL = "https://pi.dev/packages";
/* moved to src/app/CapabilityDetail.tsx */

/* moved to src/app/CapabilityDetail.tsx */

/* moved to src/app/CapabilityDetail.tsx */

/* moved to src/app/CapabilityDetail.tsx */

/* moved to src/app/CapabilityDetail.tsx */

/* moved to src/app/CapabilityDetail.tsx */


/** The skill folder picker: Tauri in the desktop shell, IPC-hosted in Electron. */
async function chooseSkillFolderPath() {
  return invokeHost<string | null>("choose_skill_folder", { defaultPath: undefined });
}
/* moved to src/app/CapabilityDetail.tsx */

/* moved to src/app/CapabilityDetail.tsx */

/* moved to src/app/CapabilitiesMcp.tsx */


export { CAPABILITY_RESOURCE_LABEL_KEYS, CAPABILITY_TAB_META, CapabilitiesPage, CapabilityDetailDialog, CapabilityMarketCard, CapabilityMcpCard, CapabilityResourceChips, MCP_EXPOSURE_HINT_KEYS, MCP_EXPOSURE_LABEL_KEYS, MCP_IMPORT_FORMAT_KEYS, McpServerDialog, McpServerEditor, PACKAGE_CATALOG_URL, PackageResourcesDialog, capabilityInitial, capabilityLoadClass, capabilityLoadLabel, chooseSkillFolderPath, formatFileSize, loadPackageResourceFile, mcpImportFormatKey };
export type { PackageResourcesLoaded, PackageResourcesRequest };
