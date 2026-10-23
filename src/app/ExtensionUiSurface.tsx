/**
 * 扩展 UI 面板.
 *
 * 扩展请求的对话框、Web UI 面板、挂件栈与通知。
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import { t } from "../i18n/index.ts";
import { useT } from "../i18n/react";
import type { ExtensionUiRequest, ExtensionUiResponse, ExtensionWebUiAction, ExtensionWebUiField } from "../lib/api";
import { stripTerminalSequences } from "../shared/terminalText.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";

function ExtensionNotifications({
  notifications,
}: {
  notifications: Array<{ id: string; message: string; type: "info" | "warning" | "error" }>
}) {
  return (
    <div
      className="pointer-events-none fixed top-[calc(var(--titlebar-height)+14px)] right-[18px] z-80 grid w-[min(360px,calc(100vw-36px))] gap-2"
      aria-live="polite"
    >
      {notifications.map((notification) => (
        <div
          className={cn(
            "rounded-md border border-l-[3px] bg-background/98 px-3 py-2.5 text-sm leading-snug shadow-lg",
            extensionNotificationStyles[notification.type],
          )}
          key={notification.id}
        >
          <span>{notification.message}</span>
        </div>
      ))}
    </div>
  );
}

function ExtensionUiDialog({
  request,
  onRespond,
}: {
  request: Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
  onRespond: (response: ExtensionUiResponse) => void;
}) {
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [selected, setSelected] = useState(request.method === "select" ? request.options[0] ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setSelected(request.method === "select" ? request.options[0] ?? "" : "");
  }, [request.id]);

  function cancel() {
    onRespond({ id: request.id, cancelled: true });
  }

  function submit() {
    if (request.method === "confirm") {
      onRespond({ id: request.id, confirmed: true });
      return;
    }

    onRespond({ id: request.id, value: request.method === "select" ? selected : value });
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          cancel();
        }
      }}
    >
      <DialogContent className="max-h-[min(86svh,720px)] gap-4 overflow-y-auto">
        <DialogHeader>
          <DialogDescription className="text-xs font-medium tracking-wide uppercase">Pi extension</DialogDescription>
          <DialogTitle className="text-[1.08rem]">{request.title}</DialogTitle>
        </DialogHeader>

        {request.method === "confirm" ? (
          <p className="leading-relaxed whitespace-pre-wrap text-muted-foreground">{request.message}</p>
        ) : null}
        {request.method === "select" ? (
          <div className="grid gap-2" role="listbox" aria-label={request.title}>
            {request.options.map((option) => (
              <Button
                type="button"
                variant="outline"
                role="option"
                aria-selected={selected === option}
                className={cn(
                  "h-auto min-h-[42px] w-full justify-start px-3 py-2 text-left font-normal whitespace-normal",
                  selected === option && "border-primary bg-accent",
                )}
                key={option}
                onClick={() => setSelected(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        ) : null}
        {request.method === "input" ? (
          <Input
            autoFocus
            className="h-[42px]"
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
        ) : null}
        {request.method === "editor" ? (
          <Textarea
            autoFocus
            className="min-h-[180px] resize-y leading-normal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={cancel}>Cancel</Button>
          {request.method === "confirm" ? (
            <>
              <Button type="button" variant="outline" onClick={cancel}>No</Button>
              <Button type="button" onClick={submit}>Yes</Button>
            </>
          ) : (
            <Button type="button" onClick={submit} disabled={request.method === "select" && !selected}>
              Submit
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExtensionWebUi({
  request,
  onRespond,
}: {
  request: Extract<ExtensionUiRequest, { method: "web" }>;
  onRespond: (response: ExtensionUiResponse) => void;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const definition = request.definition ?? {};

  useEffect(() => {
    const next: Record<string, string | boolean> = {};
    const collect = (field: ExtensionWebUiField) => {
      next[field.name] = field.value ?? (field.type === "checkbox" ? false : "");
    };
    definition.fields?.forEach(collect);
    definition.sections?.forEach((section) => {
      section.fields?.forEach(collect);
      section.rows?.forEach((row) => row.fields?.forEach(collect));
    });
    setValues((current) => ({ ...next, ...Object.fromEntries(Object.entries(current).filter(([name]) => name in next)) }));
  }, [definition]);

  function updateValue(name: string, value: string | boolean) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function runAction(action: ExtensionWebUiAction) {
    setBusyAction(action.id);
    Promise.resolve(onRespond({
      id: request.id,
      action: action.id,
      values,
      ...(action.data === undefined ? {} : { data: action.data }),
    })).finally(() => setBusyAction(null));
  }

  function renderField(field: ExtensionWebUiField, keyPrefix: string) {
    const value = values[field.name] ?? field.value ?? (field.type === "checkbox" ? false : "");
    const key = `${keyPrefix}-${field.name}`;
    const disabled = field.disabled || Boolean(busyAction);
    if (field.type === "checkbox") {
      return (
        <div className="flex items-start gap-2.5" key={key}>
          <Checkbox
            id={key}
            className="mt-0.5"
            checked={Boolean(value)}
            disabled={disabled}
            onCheckedChange={(next) => updateValue(field.name, next === true)}
          />
          <Label htmlFor={key} className="grid items-start gap-0.5 leading-normal">
            <span className="font-bold">{field.label}</span>
            {field.description ? (
              <span className="text-xs font-medium text-muted-foreground">{field.description}</span>
            ) : null}
          </Label>
        </div>
      );
    }

    return (
      <div className="grid min-w-0 gap-1.5" key={key}>
        <Label htmlFor={key} className="font-bold">{field.label}</Label>
        {field.type === "textarea" ? (
          <Textarea
            id={key}
            className="min-h-[82px] resize-y"
            value={String(value)}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(event) => updateValue(field.name, event.target.value)}
          />
        ) : field.type === "select" ? (
          <Select
            value={String(value)}
            disabled={disabled}
            onValueChange={(next) => updateValue(field.name, next)}
          >
            <SelectTrigger id={key} className="w-full">
              <SelectValue placeholder={field.placeholder} />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={key}
            type={field.type}
            value={String(value)}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(event) => updateValue(field.name, event.target.value)}
          />
        )}
        {field.description ? (
          <small className="text-xs leading-snug text-muted-foreground">{field.description}</small>
        ) : null}
      </div>
    );
  }

  function renderActions(actions: ExtensionWebUiAction[] | undefined, className?: string) {
    if (!actions?.length) return null;
    return (
      <div className={cn("flex flex-wrap justify-end gap-2", className)}>
        {actions.map((action) => (
          <Button
            key={action.id}
            type="button"
            size="sm"
            variant={extensionActionVariants[action.tone ?? "secondary"]}
            className="font-bold disabled:cursor-wait"
            disabled={Boolean(busyAction)}
            onClick={() => runAction(action)}
          >
            {busyAction === action.id ? t("common.busy") : action.label}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onRespond({ id: request.id, cancelled: true });
        }
      }}
    >
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden sm:max-w-[760px] max-h-[min(760px,calc(100vh-48px))]">
        <DialogHeader>
          <DialogDescription className="text-xs font-medium tracking-wide uppercase">
            Package interface
          </DialogDescription>
          <DialogTitle className="text-[1.08rem]">{definition.title ?? request.title}</DialogTitle>
        </DialogHeader>
        <div className="grid min-h-0 gap-4 overflow-y-auto pr-1">
          {definition.description ? (
            <p className="leading-relaxed text-muted-foreground">{definition.description}</p>
          ) : null}
          {definition.notice ? (
            <p className={cn("rounded-md border px-3 py-2.5 leading-snug", extensionNoticeStyles[definition.notice.tone])}>
              {definition.notice.message}
            </p>
          ) : null}
          {definition.fields?.length ? (
            <div className="grid gap-3">{definition.fields.map((field) => renderField(field, "root"))}</div>
          ) : null}
          {definition.sections?.map((section) => (
            <section className="grid gap-3 border-t pt-4" key={section.id}>
              {section.title ? <h3 className="text-base font-semibold">{section.title}</h3> : null}
              {section.description ? <p className="leading-relaxed text-muted-foreground">{section.description}</p> : null}
              {section.fields?.length ? (
                <div className="grid gap-3">{section.fields.map((field) => renderField(field, section.id))}</div>
              ) : null}
              {section.rows?.length ? (
                <div className="grid gap-2">
                  {section.rows.map((row) => (
                    <div
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3.5 gap-y-2.5 rounded-md border bg-muted/40 p-3"
                      key={row.id}
                    >
                      <div className="grid min-w-0 gap-[3px]">
                        <strong className="break-words">{row.title}</strong>
                        {row.description ? <span className="text-sm leading-snug break-words text-muted-foreground">{row.description}</span> : null}
                        {row.detail ? <small className="text-sm leading-snug break-words text-muted-foreground">{row.detail}</small> : null}
                      </div>
                      {row.status ? (
                        <Badge
                          variant="secondary"
                          className={cn("self-start text-[0.72rem] font-extrabold uppercase", extensionStatusStyles[row.status])}
                        >
                          {row.status}
                        </Badge>
                      ) : null}
                      {row.fields?.length ? (
                        <div className="col-span-full grid gap-3">{row.fields.map((field) => renderField(field, row.id))}</div>
                      ) : null}
                      {renderActions(row.actions, "col-span-full")}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
          {renderActions(definition.actions)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ExtensionWidgetStack({
  widgets,
  collapsible = false,
  collapsed = false,
  onToggle,
}: {
  widgets: Array<[string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }]>;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const toggle = collapsible ? (
    <button
      className="extension-widget-toggle"
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={collapsed ? t("extensionWidgets.expand") : t("extensionWidgets.collapse")}
      title={collapsed ? t("extensionWidgets.expand") : t("extensionWidgets.collapse")}
    >
      {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
    </button>
  ) : null;

  if (collapsed) {
    return <div className="extension-widget-stack extension-widget-stack--collapsed">{toggle}</div>;
  }

  return (
    <div className="extension-widget-stack grid gap-1.5 px-0.5 pb-2" aria-label="Extension widgets">
      {toggle}
      {widgets.map(([key, widget]) => (
        <section
          className="border-l-[3px] border-l-primary bg-muted px-2.5 py-2 text-xs leading-snug whitespace-pre-wrap text-muted-foreground"
          key={key}
        >
          {/* 扩展可能把 `ctx.ui.theme` 的颜色写进 widget 行；这里是纯文本展示，把转义序列去掉。 */}
          {widget.lines.map((line, index) => <div key={`${key}-${index}`}>{stripTerminalSequences(line)}</div>)}
        </section>
      ))}
    </div>
  );
}

const extensionActionVariants: Record<"primary" | "secondary" | "danger", "default" | "outline" | "destructive"> = {
  primary: "default",
  secondary: "outline",
  danger: "destructive",
};

const extensionNoticeStyles: Record<"info" | "success" | "warning" | "error", string> = {
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
};

const extensionNotificationStyles: Record<"info" | "warning" | "error", string> = {
  info: "border-l-primary",
  warning: "border-l-amber-500 text-amber-900 dark:text-amber-200",
  error: "border-l-destructive text-destructive",
};

const extensionStatusStyles: Record<"ready" | "warning" | "error" | "muted", string> = {
  ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
  error: "bg-destructive/15 text-destructive",
  muted: "",
};

export { ExtensionNotifications, ExtensionUiDialog, ExtensionWebUi, ExtensionWidgetStack, extensionActionVariants, extensionNoticeStyles, extensionNotificationStyles, extensionStatusStyles };
