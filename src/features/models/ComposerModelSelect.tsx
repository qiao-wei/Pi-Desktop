import { useMemo } from "react";
import { Cloud, Sparkles } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n/react";
import type { ModelSummary } from "@/types";
import { buildComposerModelOptions, groupComposerOptionsByProvider, modelKey } from "./customModelForm";
import type { CustomModelEntry } from "./customModelsApi";

/**
 * 输入框提交按钮旁的模型切换器。
 *
 * 列表来源就是设置里那份 `models.json`（自定义模型）+ 已经配好鉴权的内置模型，
 * 并按供应商分组展示；切换本身走 `/api/model`，pi 会把它记成全局默认模型。
 */
export function ComposerModelSelect({
  availableModels,
  customModels,
  currentProvider,
  currentModel,
  disabled,
  onChange,
}: {
  availableModels: ModelSummary[];
  customModels: CustomModelEntry[];
  currentProvider: string;
  currentModel: string;
  disabled?: boolean;
  onChange: (provider: string, model: string) => void;
}) {
  const t = useT();
  const options = useMemo(
    () => buildComposerModelOptions({ availableModels, customModels, currentProvider, currentModel }),
    [availableModels, customModels, currentProvider, currentModel],
  );

  const selectedKey = modelKey(currentProvider, currentModel);
  const selected = options.find((option) => option.key === selectedKey);
  const groups = useMemo(() => groupComposerOptionsByProvider(options), [options]);
  const empty = !options.length;

  return (
    <Select
      value={selected?.key ?? ""}
      onValueChange={(value) => {
        const next = options.find((option) => option.key === value);
        if (next) {
          onChange(next.provider, next.model);
        }
      }}
      disabled={disabled || empty}
    >
      <SelectTrigger
        size="sm"
        className={cn(
          "composer-model-trigger h-[30px] min-w-0 max-w-[190px] gap-1.5 border-transparent bg-transparent px-2 text-xs font-medium shadow-none hover:bg-muted/60",
          disabled && "opacity-50",
        )}
        aria-label={t("models.selectModelAria")}
        title={selected ? `${selected.detail} · ${selected.model}` : t("models.noModelsToPick")}
      >
        {selected?.custom ? <Cloud className="size-3.5 shrink-0 text-sky-600" /> : <Sparkles className="size-3.5 shrink-0" />}
        <span className="truncate">{selected?.label ?? (empty ? t("models.noModel") : t("models.notSelected"))}</span>
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="end"
        side="top"
        sideOffset={8}
        className="composer-model-content max-h-[min(60vh,420px)]"
      >
        {groups.map((group, index) => (
          <div key={group.key} className="min-w-0">
            {index > 0 ? <SelectSeparator /> : null}
            <SelectGroup>
              <SelectLabel className="flex min-w-0 items-center gap-1.5">
                {group.custom ? <Cloud className="size-3 shrink-0 text-sky-600" /> : null}
                <span className="truncate">{group.label}</span>
              </SelectLabel>
              {group.options.map((option) => (
                <ComposerModelItem key={option.key} option={option} />
              ))}
            </SelectGroup>
          </div>
        ))}
      </SelectContent>
    </Select>
  );
}

function ComposerModelItem({ option }: { option: ReturnType<typeof buildComposerModelOptions>[number] }) {
  return (
    <SelectItem value={option.key}>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <span className="flex min-w-0 w-full items-center gap-1.5">
          <span className="truncate">{option.label}</span>
          {!option.available ? <span className="shrink-0 text-[0.68rem] text-muted-foreground">no key</span> : null}
        </span>
      </span>
    </SelectItem>
  );
}
