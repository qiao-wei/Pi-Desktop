/**
 * 侧栏的项目对话框.
 *
 * 项目的新建/编辑/移除/归档确认框与 cwd 辅助。
 *
 * 从 `src/app/Sidebar.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */

import { useT } from "../i18n/react";
import { hasHostShell, invokeHost } from "../lib/shell/host.ts";
import { findProjectByCwd } from "../shared/projectPaths";
import type { ProjectSummary, ToolToggleState } from "../types";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { AlertTriangle, FolderOpen } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

type SidebarDialog =
  | { kind: "create-project"; name: string; cwd: string }
  | { kind: "edit-project"; project: ProjectSummary; name: string; cwd: string; codemode: ToolToggleState }
  | { kind: "remove-project"; project: ProjectSummary }
  | { kind: "archive-session"; projectId: string; sessionPath: string; title: string; inWorktree?: boolean };

function SidebarDialogView({
  dialog,
  projects,
  submitError,
  onChange,
  onCancel,
  onSubmit,
  onConfirm,
  onDeleteForever,
}: {
  dialog: SidebarDialog;
  projects: ProjectSummary[];
  submitError?: string | null;
  onChange: (dialog: SidebarDialog | null) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onConfirm: () => void;
  /** 归档/删除弹窗里的「直接删除」。其他 dialog 用不到。 */
  onDeleteForever: () => void;
}) {
  const t = useT();
  const [isChoosingFolder, setIsChoosingFolder] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  async function chooseFolder() {
    if (dialog.kind !== "create-project" && dialog.kind !== "edit-project") {
      return;
    }

    setPickerError(null);
    setIsChoosingFolder(true);
    try {
      const folder = await invokeHost<string | null>("choose_project_folder", {
        defaultPath: dialog.cwd || undefined,
      });
      if (folder) {
        onChange(projectDialogWithCwd(dialog, folder));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPickerError(message || t("dialog.couldNotChooseFolder"));
    } finally {
      setIsChoosingFolder(false);
    }
  }

  if (dialog.kind === "remove-project" || dialog.kind === "archive-session") {
    return (
      <AlertDialog
        open
        onOpenChange={(next) => {
          if (!next) {
            onCancel();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog.kind === "remove-project" ? t("dialog.removeProjectTitle") : t("dialog.archiveSessionTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog.kind === "remove-project"
                ? t("dialog.removeProjectDesc", { name: dialog.project.name })
                : t(dialog.inWorktree ? "dialog.archiveSessionDescWorktree" : "dialog.archiveSessionDesc", { title: dialog.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            {dialog.kind === "archive-session" ? (
              // 两个出口并存：默认归档（可恢复），红色按钮直接删文件（不可恢复）。
              <AlertDialogAction variant="destructive" onClick={onDeleteForever}>
                {t("dialog.deleteSessionForever")}
              </AlertDialogAction>
            ) : null}
            <AlertDialogAction onClick={onConfirm}>
              {dialog.kind === "remove-project" ? t("dialog.removeAction") : t("dialog.archiveAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  const canChooseFolder = hasHostShell();
  // Projects are keyed by folder, so an existing folder is not a new project:
  // say which project already owns it and let the user confirm the switch.
  const existingProject =
    dialog.kind === "create-project" ? findProjectByCwd(projects, dialog.cwd) : undefined;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{dialog.kind === "create-project" ? t("dialog.newProjectTitle") : t("dialog.editProjectTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="sidebar-project-name">{t("dialog.nameLabel")}</Label>
            <Input
              id="sidebar-project-name"
              value={dialog.name}
              autoFocus
              onChange={(event) => onChange({ ...dialog, name: event.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sidebar-project-cwd">{t("dialog.folderLabel")}</Label>
            <div className="flex gap-2">
              <Input
                id="sidebar-project-cwd"
                className="min-w-0 flex-1"
                value={dialog.cwd}
                placeholder="/Users/name/Project"
                onChange={(event) => onChange(projectDialogWithCwd(dialog, event.target.value))}
              />
              {canChooseFolder ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void chooseFolder()}
                  disabled={isChoosingFolder}
                  aria-label={t("sidebar.chooseFolder")}
                  title={t("sidebar.chooseFolder")}
                >
                  <FolderOpen />
                  <span>{isChoosingFolder ? t("sidebar.choosing") : t("sidebar.choose")}</span>
                </Button>
              ) : null}
            </div>
          </div>
          {existingProject ? (
            <div
              className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", statusBannerStyles)}
              role="status"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">
                {t("trust.existingProject", { name: existingProject.name, cwd: existingProject.cwd })}
              </span>
            </div>
          ) : null}
          {dialog.kind === "edit-project" ? (
            <div className="grid gap-2 rounded-md border border-border p-3.5">
              <div className="grid gap-1">
                <Label htmlFor="sidebar-project-codemode">{t("dialog.codemode.label")}</Label>
                <p className="text-sm text-muted-foreground">{t("dialog.codemode.desc")}</p>
              </div>
              <Select
                value={dialog.codemode}
                onValueChange={(value) =>
                  onChange({ ...dialog, codemode: value as ToolToggleState })
                }
              >
                <SelectTrigger id="sidebar-project-codemode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {toolToggleOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("dialog.codemode.hint", { cwd: dialog.cwd })}
              </p>
            </div>
          ) : null}
          {pickerError ? (
            <p className="text-sm text-destructive" role="status">
              {pickerError}
            </p>
          ) : null}
          {submitError ? (
            <p className="text-sm text-destructive" role="status">
              {submitError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("sidebar.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit">
              {dialog.kind === "edit-project"
                ? t("sidebar.save")
                : existingProject
                  ? t("trust.switchToProject", { name: existingProject.name })
                  : t("sidebar.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function lastPathPart(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "Project";
}

function projectDialogWithCwd(dialog: SidebarDialog, cwd: string): SidebarDialog {
  if (dialog.kind === "create-project") {
    const nextName = dialog.name.trim() ? dialog.name : lastPathPart(cwd);
    return { ...dialog, cwd, name: nextName };
  }

  if (dialog.kind === "edit-project") {
    return { ...dialog, cwd };
  }

  return dialog;
}

const statusBannerStyles =
  "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200";

/**
 * 项目层的 codemode 三态。写进 `defaultTools` 时：继承 = 不写这一层，
 * 开启 = `+codemode`，关闭 = `-codemode`（必须是显式减号，否则会继承全局的「开」）。
 */
const toolToggleOptions: ReadonlyArray<{ value: ToolToggleState; labelKey: string }> = [
  { value: "inherit", labelKey: "dialog.codemode.inherit" },
  { value: "on", labelKey: "dialog.codemode.on" },
  { value: "off", labelKey: "dialog.codemode.off" },
];

export { SidebarDialogView, lastPathPart, projectDialogWithCwd, statusBannerStyles, toolToggleOptions };
export type { SidebarDialog };
