import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "../i18n/react";
import {
  commandLine,
  formatEnvText,
  parseEnvText,
  type ProjectCommandEnvVar,
} from "../shared/projectCommands";

/** 弹窗里能编辑的内容；`add` 模式下 `initial` 为空。 */
export interface ProjectCommandDraft {
  label: string;
  command: string;
  args: string;
  env: ProjectCommandEnvVar[];
  cwd: string;
}

export interface ProjectCommandDialogProps {
  open: boolean;
  /** `edit` 改一条已保存的；`add` 手动新建一条。 */
  mode: "edit" | "add";
  /** 打开时的初始值。 */
  initial?: Partial<ProjectCommandDraft>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: ProjectCommandDraft) => void;
}

/**
 * 「编辑 / 新增一条命令」弹窗。
 *
 * 有些命令不带上参数或环境变量根本跑不起来（`npm run dev -- --port 3000`、`DATABASE_URL=…`），
 * 探测只能给出最朴素的那一行，所以这里让人把它们补上：
 * - 参数：自由文本，直接拼在命令尾部（`-- --port 3000`）。
 * - 环境变量：一行一个 `KEY=value`，运行前注入（跨平台，Windows 也生效）。
 *
 * 命令 / 参数变了 id 会跟着变（id 是内容的哈希），保存后由 `updateProjectCommand` 把选中项
 * 指到新 id 上，不需要调用方操心。
 */
export function ProjectCommandDialog({ open, mode, initial, onOpenChange, onSubmit }: ProjectCommandDialogProps) {
  const t = useT();
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [cwd, setCwd] = useState("");
  const commandRef = useRef<HTMLInputElement>(null);

  // 每次打开都按 initial 重置：上次填了一半的内容不该粘到下一次。
  useEffect(() => {
    if (!open) {
      return;
    }
    setLabel(initial?.label ?? "");
    setCommand(initial?.command ?? "");
    setArgs(initial?.args ?? "");
    setEnvText(formatEnvText(initial?.env ?? []));
    setCwd(initial?.cwd ?? "");
    // 打开的下一帧再聚焦，避免 Dialog 的入场动画把焦点抢走。
    const timer = window.setTimeout(() => commandRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, initial]);

  const trimmedCommand = command.trim();
  const env = parseEnvText(envText);

  const submit = () => {
    if (!trimmedCommand) {
      return;
    }
    onSubmit({
      label: label.trim() || trimmedCommand,
      command: trimmedCommand,
      args,
      env,
      cwd: cwd.trim(),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid gap-5 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{mode === "edit" ? t("projectCommand.editTitle") : t("projectCommand.addTitle")}</DialogTitle>
          <DialogDescription>{t("projectCommand.editDesc")}</DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[62vh] gap-4 overflow-y-auto pr-1">
          <div className="grid gap-2">
            <Label htmlFor="pc-command">{t("projectCommand.fieldCommand")}</Label>
            <Input
              id="pc-command"
              ref={commandRef}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npm run dev"
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="pc-args">{t("projectCommand.fieldArgs")}</Label>
            <Input
              id="pc-args"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder="-- --port 3000"
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-[0.7rem] text-muted-foreground">{t("projectCommand.fieldArgsHint")}</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="pc-env">{t("projectCommand.fieldEnv")}</Label>
            <Textarea
              id="pc-env"
              value={envText}
              onChange={(event) => setEnvText(event.target.value)}
              rows={4}
              placeholder={"PORT=3000\nNODE_ENV=development"}
              className="font-mono text-xs"
              spellCheck={false}
            />
            <p className="text-[0.7rem] text-muted-foreground">{t("projectCommand.fieldEnvHint")}</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="pc-cwd">{t("projectCommand.fieldCwd")}</Label>
            <Input
              id="pc-cwd"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder={t("projectCommand.fieldCwdPlaceholder")}
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="pc-label">{t("projectCommand.fieldLabel")}</Label>
            <Input
              id="pc-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t("projectCommand.fieldLabelPlaceholder")}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          {trimmedCommand ? (
            <p
              className="truncate rounded-md bg-muted px-2 py-1 font-mono text-[0.7rem] text-muted-foreground"
              title={commandLine(trimmedCommand, args)}
            >
              {commandLine(trimmedCommand, args)}
              {env.length ? `  ·  ${t("projectCommand.envCount", { count: env.length })}` : ""}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={!trimmedCommand}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}