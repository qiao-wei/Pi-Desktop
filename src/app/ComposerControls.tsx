/**
 * 输入框的溢出菜单与思考档选择.
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */

import { useT } from "../i18n/react";
import type { ThinkingLevel } from "../types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Check, Mic, MoreHorizontal } from "lucide-react";

function ComposerOverflowMenu({
  thinkingLevel,
  disabled,
  onThinkingLevelChange,
  supportedThinkingLevels,
}: {
  thinkingLevel: ThinkingLevel;
  disabled?: boolean;
  onThinkingLevelChange: (thinkingLevel: ThinkingLevel) => void;
  supportedThinkingLevels?: ThinkingLevel[];
}) {
  const t = useT();
  // 只在桥根本没下发档位表时才兜底回固定列表；空数组是「这个模型一档都没有」（映射全清空），
  // 必须照实渲染成空菜单，不能兜回七档。
  const levels = supportedThinkingLevels ?? thinkingLevels;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="composer-tool-button composer-tool-overflow"
          type="button"
          disabled={disabled}
          aria-label={t("composer.moreTools")}
          title={t("composer.moreTools")}
        >
          <MoreHorizontal size={19} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[230px]">
        <DropdownMenuLabel>{t("thinking.label")}</DropdownMenuLabel>
        {levels.map((level) => (
          <DropdownMenuItem
            key={level}
            className="items-start gap-2"
            onSelect={() => onThinkingLevelChange(level)}
          >
            <Check
              className={cn("mt-0.5 size-4 shrink-0", level === thinkingLevel ? "opacity-100" : "opacity-0")}
            />
            <span className="flex min-w-0 flex-col items-start gap-0.5">
              <strong className="font-medium">{thinkingLevelLabel(level)}</strong>
              <small className="text-xs text-muted-foreground">{thinkingLevelDescription(level)}</small>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* 与工具行里被收起的语音按钮保持同一入口（暂未开放）。 */}
        <DropdownMenuItem disabled>
          <Mic className="size-4 shrink-0" />
          <span>{t("composer.voiceInput")}</span>
          <span className="ml-auto text-xs text-muted-foreground">{t("common.comingSoon")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThinkingLevelSelect({
  value,
  disabled,
  onChange,
  supportedThinkingLevels,
}: {
  value: ThinkingLevel;
  disabled?: boolean;
  onChange: (thinkingLevel: ThinkingLevel) => void;
  supportedThinkingLevels?: ThinkingLevel[];
}) {
  const t = useT();
  // 同上：空数组不兜底，缺字段（旧桥）才用固定列表。
  const levels = supportedThinkingLevels ?? thinkingLevels;
  return (
    <div className="thinking-level-select inline-flex min-w-0 items-center gap-2 pr-0.5 pl-1" title={t("thinking.sessionTitle")}>
      <span
        className={cn(
          "thinking-level-label text-xs font-bold whitespace-nowrap text-muted-foreground",
          disabled && "opacity-50",
        )}
      >
        {t("thinking.label")}
      </span>
      <Select value={value} onValueChange={(next) => onChange(next as ThinkingLevel)} disabled={disabled}>
        {/* The trigger renders the label itself rather than using SelectValue:
            Radix mirrors the whole selected item into the trigger, which would
            drag each level's description in with it. */}
        <SelectTrigger size="sm" className="h-[30px] w-26" aria-label={t("thinking.sessionTitle")}>
          <span className="truncate">{thinkingLevelLabel(value)}</span>
        </SelectTrigger>
        <SelectContent position="popper" align="start" sideOffset={4}>
          {levels.map((level) => (
            <SelectItem key={level} value={level}>
              <span className="flex flex-col items-start gap-0.5">
                <strong className="font-medium">{thinkingLevelLabel(level)}</strong>
                <small className="text-xs text-muted-foreground">{thinkingLevelDescription(level)}</small>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function thinkingLevelDescription(level: ThinkingLevel) {
  if (level === "off") {
    return "Fastest responses";
  }
  if (level === "minimal") {
    return "Light reasoning";
  }
  if (level === "low") {
    return "Quick reasoning";
  }
  if (level === "medium") {
    return "Balanced reasoning";
  }
  if (level === "high") {
    return "Deep reasoning";
  }
  if (level === "xhigh") {
    return "Extra deep reasoning";
  }
  return "Maximum reasoning";
}

function thinkingLevelLabel(level: ThinkingLevel) {
  if (level === "xhigh") {
    return "X High";
  }

  return level.charAt(0).toUpperCase() + level.slice(1);
}

const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export { ComposerOverflowMenu, ThinkingLevelSelect, thinkingLevelDescription, thinkingLevelLabel, thinkingLevels };
