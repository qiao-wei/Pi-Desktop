/**
 * 技能/包导入与键值编辑器.
 *
 * 从 `src/app/CapabilitySurfaces.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */

import { useT } from "../i18n/react";
import type { McpKeyValueRow } from "../shared/mcpForm";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Plus, Save, Trash2 } from "lucide-react";
import { useId, useState } from "react";

function KeyValueEditor({
  label,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  rows: McpKeyValueRow[];
  onChange: (rows: McpKeyValueRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const t = useT();
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            className="h-9 flex-1 font-mono text-xs"
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(event) => onChange(rows.map((entry, position) => (
              position === index ? { ...entry, key: event.target.value } : entry
            )))}
          />
          <Input
            className="h-9 flex-1 font-mono text-xs"
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(event) => onChange(rows.map((entry, position) => (
              position === index ? { ...entry, value: event.target.value } : entry
            )))}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("capability.context.delete")}
            title={t("capability.context.delete")}
            onClick={() => onChange(rows.filter((_, position) => position !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="font-semibold"
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          <Plus />
          {t("capability.mcp.addRow")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Install a pi package: source, scope, autoload — the same three choices pi's own CLI asks for.
 * Shared by the Global page and the project panel (which defaults to the project scope) so both
 * surfaces behave identically; pi's install progress is shown here instead of on the host page.
 */
function PackageInstallDialog({
  defaultScope = "user",
  onClose,
  onInstall,
}: {
  defaultScope?: "user" | "project";
  onClose: () => void;
  onInstall: (
    source: string,
    scope: "user" | "project",
    autoload: boolean,
    onProgress: (message: string) => void,
  ) => Promise<unknown>;
}) {
  const t = useT();
  const id = useId();
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"user" | "project">(defaultScope);
  const [autoload, setAutoload] = useState(true);
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    setProgress("");
    try {
      await onInstall(source.trim(), scope, autoload, setProgress);
      onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) { onClose(); } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("capability.detail.installPackage")}</DialogTitle>
          <DialogDescription>{t("capability.detail.fillSourceHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3.5">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-source`}>{t("capability.detail.packageSource")}</Label>
            <Input
              id={`${id}-source`}
              value={source}
              autoFocus
              onChange={(event) => setSource(event.target.value)}
              placeholder={t("capability.detail.packageSourcePlaceholder")}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-scope`}>{t("capability.detail.installScope")}</Label>
            <Select value={scope} onValueChange={(value) => setScope(value as "user" | "project")}>
              <SelectTrigger id={`${id}-scope`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t("capability.detail.scopeUser")}</SelectItem>
                <SelectItem value="project">{t("capability.detail.scopeProject")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-autoload`}
              checked={autoload}
              onCheckedChange={(value) => setAutoload(value === true)}
            />
            <Label htmlFor={`${id}-autoload`}>{t("capability.detail.autoload")}</Label>
          </div>
          {busy && progress ? <p className="text-xs break-all text-muted-foreground" role="status">{progress}</p> : null}
          {error ? <p className="text-sm text-destructive" role="status">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="button" disabled={!source.trim() || busy} onClick={() => void submit()}>
            <Save />
            {t("capability.detail.install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Import a skill folder: pick the scope, then let the server copy it in. Shared by the Global
 * skills & packages page and the project panel, so both offer the same rules — the folder picker is
 * the only part each host runs itself.
 */
function SkillImportDialog({
  path,
  onClose,
  onImport,
}: {
  path: string;
  onClose: () => void;
  onImport: (sourcePath: string, scope: "user" | "project") => Promise<unknown>;
}) {
  const t = useT();
  const [scope, setScope] = useState<"user" | "project">("project");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await onImport(path, scope);
      onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) { onClose(); } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("capability.importScope.title")}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{path}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label={t("capability.importScope.groupAria")}>
          {([
            ["user", t("capability.importScope.user"), t("capability.importScope.userHint")],
            ["project", t("capability.importScope.project"), t("capability.importScope.projectHint")],
          ] as const).map(([value, title, hint]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              className={cn(
                "grid min-w-0 gap-1.5 rounded-md border p-3.5 text-left hover:bg-accent",
                scope === value && "border-primary bg-accent",
              )}
              onClick={() => setScope(value)}
            >
              <strong className="text-sm">{title}</strong>
              <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>
            </button>
          ))}
        </div>
        {error ? <p className="text-sm text-destructive" role="status">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            <Plus />
            {busy ? t("capability.importScope.importing") : t("capability.importScope.import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { KeyValueEditor, PackageInstallDialog, SkillImportDialog };
