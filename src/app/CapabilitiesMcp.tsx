/**
 * MCP 服务器编辑.
 *
 * MCP 卡片/编辑器/新建编辑对话框（从能力页拆出）。
 *
 * 从 `src/app/CapabilitiesPage.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import { t } from "../i18n/index.ts";
import { useT } from "../i18n/react";
import { buildMcpServerPayload, recordToRows } from "../shared/mcpForm";
import type { McpKeyValueRow } from "../shared/mcpForm";
import { CAPABILITY_MCP_EXPOSURES } from "../types";
import type { CapabilityMcpDetail, CapabilityMcpExposure, CapabilityMcpImportResult, CapabilityMcpImportServer, CapabilityMcpInspection, CapabilityMcpServer } from "../types";
import { KeyValueEditor } from "./CapabilitySurfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronUp, FileUp, Loader2, Plug, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const MCP_EXPOSURE_HINT_KEYS: Record<CapabilityMcpExposure, string> = {
  codemode: "capability.mcp.exposureHint.codemode",
  "codemode-deferred": "capability.mcp.exposureHint.codemodeDeferred",
  deferred: "capability.mcp.exposureHint.deferred",
  direct: "capability.mcp.exposureHint.direct",
  hidden: "capability.mcp.exposureHint.hidden",
};

/** MCP 的 env / headers 共用一种两列行编辑器；行 ↔ 对象的转换在 shared/mcpForm.ts。 */
const MCP_EXPOSURE_LABEL_KEYS: Record<CapabilityMcpExposure, string> = {
  codemode: "capability.mcp.exposure.codemode",
  "codemode-deferred": "capability.mcp.exposure.codemodeDeferred",
  deferred: "capability.mcp.exposure.deferred",
  direct: "capability.mcp.exposure.direct",
  hidden: "capability.mcp.exposure.hidden",
};

/** 导入识别出的格式代号 → 文案 key。代号由 `server/mcpImport.mjs` 给出。 */
const MCP_IMPORT_FORMAT_KEYS: Record<string, string> = {
  "mcp-servers": "capability.mcp.importFormat.mcp-servers",
  vscode: "capability.mcp.importFormat.vscode",
  zed: "capability.mcp.importFormat.zed",
  mcp: "capability.mcp.importFormat.mcp",
  list: "capability.mcp.importFormat.list",
  single: "capability.mcp.importFormat.single",
  map: "capability.mcp.importFormat.map",
};

function McpServerDialog({
  server,
  defaultScope,
  onClose,
  onSave,
  onReadMcpServer,
  onParseImport,
}: {
  server?: CapabilityMcpServer;
  defaultScope: "user" | "project";
  onClose: () => void;
  onSave: (server: Record<string, unknown>) => Promise<unknown>;
  onReadMcpServer: (id: string) => Promise<CapabilityMcpDetail>;
  onParseImport?: (text: string, defaultName?: string) => Promise<CapabilityMcpImportResult>;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(next) => { if (!next) { onClose(); } }}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-2xl max-h-[min(86svh,760px)]">
        <DialogHeader>
          <DialogTitle>{server ? t("capability.mcp.editTitle") : t("capability.mcp.newTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("capability.mcp.dialogHint")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto pr-1">
          <McpServerEditor
            server={server}
            defaultScope={defaultScope}
            onSave={onSave}
            onRead={onReadMcpServer}
            onParseImport={onParseImport}
            onSaved={onClose}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * MCP 服务器表单。新增和编辑共用：编辑时先 `onRead` 拉回原始字段（env / headers
 * 可能带密钥，能力清单里不带），`server.tools` 来自会话，用来配单工具 exposure。
 */
function McpServerEditor({
  server,
  defaultScope = "user",
  onSave,
  onInspect,
  onRead,
  onParseImport,
  onSaved,
}: {
  server?: CapabilityMcpServer;
  defaultScope?: "user" | "project";
  onSave: (server: Record<string, unknown>) => Promise<unknown>;
  onInspect?: (id: string) => Promise<CapabilityMcpInspection>;
  onRead?: (id: string) => Promise<CapabilityMcpDetail>;
  /** 新增时可用：解析一份别家客户端 JSON 并回填表单；编辑时不显示。 */
  onParseImport?: (text: string, defaultName?: string) => Promise<CapabilityMcpImportResult>;
  onSaved?: () => void;
}) {
  const t = useT();
  const editing = Boolean(server);
  const [loading, setLoading] = useState(editing && Boolean(onRead));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(server?.name ?? "");
  const [scope, setScope] = useState<"user" | "project">(server?.scope ?? defaultScope);
  const [transport, setTransport] = useState<"stdio" | "http">(server?.transport ?? "stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [url, setUrl] = useState("");
  const [envRows, setEnvRows] = useState<McpKeyValueRow[]>([]);
  const [headerRows, setHeaderRows] = useState<McpKeyValueRow[]>([]);
  const [exposure, setExposure] = useState<CapabilityMcpExposure>(server?.exposure ?? "codemode");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [description, setDescription] = useState(server?.description ?? "");
  const [toolExposure, setToolExposure] = useState<Record<string, string>>({});
  const [hasOAuth, setHasOAuth] = useState(false);
  /** 导入带进来的 pi 认识字段（`oauth` ...）：表单不展示，保存时原样写回。 */
  const [extras, setExtras] = useState<Record<string, unknown>>({});
  const [inspection, setInspection] = useState<CapabilityMcpInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  // 「从 JSON 导入」区：新增时的可选快捷入口。
  const importFileRef = useRef<HTMLInputElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importDefaultName, setImportDefaultName] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const [importPreview, setImportPreview] = useState<CapabilityMcpImportResult | null>(null);
  const [importParsing, setImportParsing] = useState(false);
  const [importError, setImportError] = useState("");
  const [importApplied, setImportApplied] = useState("");
  const [showImportWarnings, setShowImportWarnings] = useState(false);

  useEffect(() => {
    if (!server || !onRead) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    onRead(server.id)
      .then((detail) => {
        if (cancelled) return;
        setName(detail.name);
        setScope(detail.scope);
        setTransport(detail.transport);
        setCommand(detail.command);
        setArgs(detail.args.join(" "));
        setCwd(detail.cwd);
        setUrl(detail.url);
        setEnvRows(recordToRows(detail.env));
        setHeaderRows(recordToRows(detail.headers));
        setExposure(detail.exposure);
        setEnabled(detail.enabled);
        setDescription(detail.description);
        setToolExposure(detail.toolExposure ?? {});
        setHasOAuth(Boolean(detail.hasOAuth));
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [server?.id, onRead]);

  const canSave = Boolean(name.trim()) && (transport === "http" ? Boolean(url.trim()) : Boolean(command.trim()));

  // 导入文本（文件或粘贴）变化时防抖解析；只回填表单，不碰磁盘。
  useEffect(() => {
    if (!importOpen || !onParseImport) {
      return;
    }
    if (!importText.trim()) {
      setImportPreview(null);
      setImportParsing(false);
      return;
    }
    let cancelled = false;
    setImportParsing(true);
    const timer = setTimeout(() => {
      onParseImport(importText, importDefaultName || undefined)
        .then((result) => {
          if (cancelled) return;
          setImportPreview(result);
          setImportError("");
        })
        .catch((nextError) => {
          if (cancelled) return;
          setImportPreview(null);
          setImportError(nextError instanceof Error ? nextError.message : String(nextError));
        })
        .finally(() => {
          if (!cancelled) setImportParsing(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [importOpen, importText, importDefaultName, onParseImport]);

  async function handleImportFile(file: File | undefined) {
    if (!file) return;
    setImportError("");
    setImportApplied("");
    try {
      const content = await file.text();
      setImportFileName(file.name);
      setImportDefaultName(file.name.replace(/\.json$/i, ""));
      setImportText(content);
    } catch (nextError) {
      setImportError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  /** 把解析出的一个服务器回填到表单；用户确认后再走 Save。 */
  function applyImported(imported: CapabilityMcpImportServer) {
    setError("");
    setName(imported.name);
    setTransport(imported.transport);
    if (imported.transport === "http") {
      setUrl(imported.url);
      setHeaderRows(recordToRows(imported.headers));
      setCommand("");
      setArgs("");
      setCwd("");
      setEnvRows([]);
    } else {
      setCommand(imported.command);
      setArgs(imported.args.join(" "));
      setCwd(imported.cwd);
      setEnvRows(recordToRows(imported.env));
      setUrl("");
      setHeaderRows([]);
    }
    setExposure(imported.exposure);
    setEnabled(imported.enabled);
    setDescription(imported.description);
    setToolExposure(imported.toolExposure ?? {});
    setHasOAuth(Boolean(imported.hasOAuth));
    setExtras(imported.extras ?? {});
    setImportApplied(imported.args.some((arg) => /\s/.test(arg))
      ? `${t("capability.mcp.importApplied")} ${t("capability.mcp.importArgSpaces")}`
      : t("capability.mcp.importApplied"));
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      await onSave(buildMcpServerPayload({
        originalId: server?.id,
        name,
        scope,
        transport,
        enabled,
        exposure,
        description,
        command,
        args,
        cwd,
        url,
        env: envRows,
        headers: headerRows,
        toolExposure,
        extras,
      }));
      onSaved?.();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  }

  async function handleInspect() {
    if (!server || !onInspect) {
      return;
    }
    setInspecting(true);
    setError("");
    setInspection(null);
    try {
      setInspection(await onInspect(server.id));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setInspecting(false);
    }
  }

  return (
    <div className="grid gap-4">
      {loading ? <p className="text-sm text-muted-foreground">{t("capability.mcp.loading")}</p> : null}
      {error ? <p className="text-sm text-destructive" role="status">{error}</p> : null}

      {/* 新增时的可选快捷入口：从别家客户端的 JSON 解析出一个服务器并回填表单，保存仍走 Save。 */}
      {!editing && onParseImport ? (
        <div className="grid gap-2 rounded-md border border-border p-3">
          <button
            type="button"
            className="flex items-center justify-between gap-2 text-left text-sm font-medium"
            onClick={() => setImportOpen((current) => !current)}
          >
            <span className="flex items-center gap-2">
              <FileUp className="size-4" />
              {t("capability.mcp.importSection")}
            </span>
            {importOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
          {importOpen ? (
            <div className="grid gap-2">
              <p className="text-[11px] text-muted-foreground">{t("capability.mcp.importHint")}</p>
              <input
                ref={importFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(event) => {
                  void handleImportFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => importFileRef.current?.click()}>
                  <FileUp />
                  {t("capability.mcp.importChooseFile")}
                </Button>
                {importFileName ? <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{importFileName}</span> : null}
              </div>
              <Textarea
                className="min-h-[96px] font-mono text-xs"
                value={importText}
                placeholder={t("capability.mcp.importPlaceholder")}
                aria-label={t("capability.mcp.importPasteLabel")}
                onChange={(event) => {
                  setImportText(event.target.value);
                  setImportFileName("");
                  setImportApplied("");
                }}
              />
              {importParsing ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("capability.mcp.loading")}
                </p>
              ) : null}
              {importError ? <p className="text-xs text-destructive" role="status">{importError}</p> : null}
              {importPreview ? (
                <div className="grid gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant="secondary">{t("capability.mcp.importFormat", { format: t(mcpImportFormatKey(importPreview.format)) })}</Badge>
                    <span className="text-[11px] text-muted-foreground">{t("capability.mcp.importFound", { count: importPreview.servers.length })}</span>
                  </div>
                  {importPreview.errors.length ? (
                    <div className="grid gap-1 rounded-md bg-destructive/10 px-2.5 py-1.5">
                      <span className="text-[11px] font-semibold text-destructive">{t("capability.mcp.importErrorsTitle")}</span>
                      {importPreview.errors.map((entry, index) => (
                        <span key={index} className="font-mono text-[11px] break-words text-destructive">{entry}</span>
                      ))}
                    </div>
                  ) : null}
                  {importPreview.warnings.length ? (
                    <div className="grid gap-1 rounded-md bg-muted px-2.5 py-1.5">
                      <button
                        type="button"
                        className="flex items-center justify-between gap-2 text-left text-[11px] font-semibold"
                        onClick={() => setShowImportWarnings((current) => !current)}
                      >
                        {t("capability.mcp.importWarningsTitle")} · {importPreview.warnings.length}
                        {showImportWarnings ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                      </button>
                      {showImportWarnings ? importPreview.warnings.map((entry, index) => (
                        <span key={index} className="font-mono text-[11px] break-words text-muted-foreground">{entry}</span>
                      )) : null}
                    </div>
                  ) : null}
                  {importPreview.servers.length ? (
                    <div className="grid gap-1.5">
                      <span className="text-[11px] text-muted-foreground">{t("capability.mcp.importPick")}</span>
                      {importPreview.servers.map((imported) => {
                        const summary = imported.transport === "stdio"
                          ? [imported.command, ...imported.args].join(" ")
                          : imported.url;
                        return (
                          <button
                            key={imported.name}
                            type="button"
                            className="grid min-w-0 cursor-pointer gap-1 rounded-md bg-muted px-2.5 py-1.5 text-left hover:bg-accent"
                            onClick={() => applyImported(imported)}
                          >
                            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <span className="truncate font-mono text-xs font-semibold">{imported.name}</span>
                              <Badge variant="outline">
                                {imported.transport === "http" ? t("capability.mcp.transport.http") : t("capability.mcp.transport.stdio")}
                              </Badge>
                              {imported.hasOAuth ? <Badge variant="outline">{t("capability.mcp.importOauth")}</Badge> : null}
                            </span>
                            <span className="truncate font-mono text-[11px] text-muted-foreground" title={summary}>{summary}</span>
                            {imported.warnings.length ? (
                              <span className="text-[11px] break-words text-muted-foreground">{imported.warnings.join(" · ")}</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {importApplied ? <p className="text-xs text-muted-foreground" role="status">{importApplied}</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="mcp-name">{t("capability.mcp.name")}</Label>
          <Input
            id="mcp-name"
            className="h-9 font-mono text-sm"
            value={name}
            placeholder="teambition-mcp"
            onChange={(event) => setName(event.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">{t("capability.mcp.nameHint")}</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="mcp-scope">{t("capability.mcp.scope")}</Label>
          <Select value={scope} onValueChange={(value) => setScope(value as "user" | "project")}>
            <SelectTrigger id="mcp-scope" className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="user">{t("capability.mcp.scopeUser")}</SelectItem>
              <SelectItem value="project">{t("capability.mcp.scopeProject")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="mcp-transport">{t("capability.mcp.transport")}</Label>
        <Select value={transport} onValueChange={(value) => setTransport(value as "stdio" | "http")}>
          <SelectTrigger id="mcp-transport" className="h-9 w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio">{t("capability.mcp.transport.stdio")}</SelectItem>
            <SelectItem value="http">{t("capability.mcp.transport.http")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {transport === "stdio" ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-command">{t("capability.mcp.command")}</Label>
            <Input
              id="mcp-command"
              className="h-9 font-mono text-sm"
              value={command}
              placeholder="npx"
              onChange={(event) => setCommand(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-args">{t("capability.mcp.args")}</Label>
            <Input
              id="mcp-args"
              className="h-9 font-mono text-sm"
              value={args}
              placeholder="-y @scope/server --flag"
              onChange={(event) => setArgs(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">{t("capability.mcp.argsHint")}</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-cwd">{t("capability.mcp.cwd")}</Label>
            <Input
              id="mcp-cwd"
              className="h-9 font-mono text-sm"
              value={cwd}
              placeholder={t("capability.mcp.cwdPlaceholder")}
              onChange={(event) => setCwd(event.target.value)}
            />
          </div>
          <KeyValueEditor
            label={t("capability.mcp.env")}
            rows={envRows}
            onChange={setEnvRows}
            keyPlaceholder={t("capability.mcp.keyPlaceholder")}
            valuePlaceholder={t("capability.mcp.valuePlaceholder")}
          />
        </>
      ) : (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-url">{t("capability.mcp.url")}</Label>
            <Input
              id="mcp-url"
              className="h-9 font-mono text-sm"
              value={url}
              placeholder="https://mcp.example.com/mcp"
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <KeyValueEditor
            label={t("capability.mcp.headers")}
            rows={headerRows}
            onChange={setHeaderRows}
            keyPlaceholder={t("capability.mcp.keyPlaceholder")}
            valuePlaceholder={t("capability.mcp.valuePlaceholder")}
          />
          {hasOAuth ? <p className="text-xs text-muted-foreground">{t("capability.mcp.oauthNotice")}</p> : null}
        </>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="mcp-exposure">{t("capability.mcp.exposureLabel")}</Label>
        <Select value={exposure} onValueChange={(value) => setExposure(value as CapabilityMcpExposure)}>
          <SelectTrigger id="mcp-exposure" className="h-9 w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CAPABILITY_MCP_EXPOSURES.map((value) => (
              <SelectItem key={value} value={value}>{t(MCP_EXPOSURE_LABEL_KEYS[value])}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t(MCP_EXPOSURE_HINT_KEYS[exposure])}</p>
      </div>

      {editing && server && server.tools.length ? (
        <div className="grid gap-2">
          <Label>{t("capability.mcp.toolsTitle", { count: server.tools.length })}</Label>
          <div className="grid gap-1.5">
            {server.tools.map((tool) => (
              <div key={tool.name} className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-muted px-2.5 py-1.5">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{tool.name}</p>
                  {tool.description ? <p className="truncate text-[11px] text-muted-foreground">{tool.description}</p> : null}
                </div>
                <Select
                  value={toolExposure[tool.name] ?? "__server"}
                  onValueChange={(value) => setToolExposure((current) => {
                    const next = { ...current };
                    if (value === "__server") {
                      delete next[tool.name];
                    } else {
                      next[tool.name] = value;
                    }
                    return next;
                  })}
                >
                  <SelectTrigger className="h-8 w-[200px] shrink-0" aria-label={t("capability.mcp.toolExposureAria", { name: tool.name })}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__server">{t("capability.mcp.followServer", { exposure: t(MCP_EXPOSURE_LABEL_KEYS[exposure]) })}</SelectItem>
                    {CAPABILITY_MCP_EXPOSURES.map((value) => (
                      <SelectItem key={value} value={value}>{t(MCP_EXPOSURE_LABEL_KEYS[value])}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor="mcp-description">{t("capability.mcp.description")}</Label>
        <Input
          id="mcp-description"
          className="h-9 text-sm"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="flex items-center gap-3">
        <Switch id="mcp-enabled" checked={enabled} onCheckedChange={setEnabled} />
        <Label htmlFor="mcp-enabled" className="font-normal">{t("capability.mcp.enabled")}</Label>
      </div>

      {editing ? <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">{server?.source}</code> : null}
      {inspection ? (
        inspection.status === "ready"
          ? <p className="text-xs text-muted-foreground" role="status">{t("capability.mcp.testOk", { count: inspection.tools.length })}</p>
          : <p className="text-xs text-destructive" role="status">{inspection.error}</p>
      ) : null}

      <div className="flex justify-end gap-2">
        {editing && onInspect ? (
          <Button type="button" variant="outline" disabled={saving || inspecting} onClick={() => void handleInspect()}>
            {inspecting ? <Loader2 className="animate-spin" /> : <Plug />}
            {inspecting ? t("capability.mcp.testing") : t("capability.mcp.test")}
          </Button>
        ) : null}
        <Button type="button" disabled={!canSave || saving || loading} onClick={() => void handleSave()}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          {saving ? t("capability.mcp.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}

function mcpImportFormatKey(format: string | null): string {
  return format && MCP_IMPORT_FORMAT_KEYS[format]
    ? MCP_IMPORT_FORMAT_KEYS[format]
    : "capability.mcp.importFormat.none";
}

export { MCP_EXPOSURE_HINT_KEYS, MCP_EXPOSURE_LABEL_KEYS, MCP_IMPORT_FORMAT_KEYS, McpServerDialog, McpServerEditor, mcpImportFormatKey };
