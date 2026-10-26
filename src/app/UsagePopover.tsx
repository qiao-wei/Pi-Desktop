/**
 * 用量浮层.
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */

import { useT } from "../i18n/react";
import { compactActionState } from "../shared/compactionNotice";
import type { CapabilitiesState, ConversationStats, ThinkingLevel } from "../types";
import { cachePercent, formatCacheDetail, formatTokens, percentOf } from "./usageFormat";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DatabaseZap, X } from "lucide-react";

function UsagePopover({
  stats,
  contextPercent,
  capabilities,
  thinkingLevel,
  hasThinking,
  isCompacting,
  isStreaming,
  canCompact,
  onCompact,
  onClose,
}: {
  stats: ConversationStats;
  contextPercent: number | null;
  capabilities: CapabilitiesState;
  thinkingLevel: ThinkingLevel;
  hasThinking: boolean;
  isCompacting: boolean;
  isStreaming: boolean;
  canCompact: boolean;
  onCompact: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const tokenUsage = stats.tokenUsage;
  const inputTokens = tokenUsage?.input ?? 0;
  const outputTokens = tokenUsage?.output ?? 0;
  const cacheReadTokens = tokenUsage?.cacheRead ?? 0;
  const cacheWriteTokens = tokenUsage?.cacheWrite ?? 0;
  const cacheTokens = cacheReadTokens + cacheWriteTokens;
  const displayInputTokens = inputTokens + cacheReadTokens;
  const displayOutputTokens = outputTokens + cacheWriteTokens;
  const displayTotalTokens = displayInputTokens + displayOutputTokens;
  const reasoningTokens = tokenUsage?.reasoning ?? 0;
  const estimatedCostUsd = tokenUsage?.estimatedCostUsd;
  const activeSkills = capabilities.skills.filter((item) => item.active);
  const activeToolSkills = activeSkills.filter((item) => item.disableModelInvocation);
  const activeModelSkills = activeSkills.filter((item) => !item.disableModelInvocation);
  const activeMcpServers = (capabilities.mcpServers ?? []).filter((item) => item.active);
  const compactAction = compactActionState({ isStreaming, isCompacting });
  const detailRows = [
    displayInputTokens > 0
      ? {
          label: t("usage.label.input"),
          value: formatTokens(displayInputTokens),
          percent: percentOf(displayInputTokens, displayTotalTokens),
          color: "bg-primary",
        }
      : null,
    displayOutputTokens > 0
      ? {
          label: t("usage.label.output"),
          value: formatTokens(displayOutputTokens),
          percent: percentOf(displayOutputTokens, displayTotalTokens),
          color: "bg-sky-500",
        }
      : null,
    cacheTokens > 0
      ? {
          label: t("usage.label.cache"),
          value: formatCacheDetail(cacheReadTokens, cacheWriteTokens),
          percent: cachePercent(cacheReadTokens, cacheWriteTokens, displayInputTokens),
          color: "bg-amber-500",
        }
      : null,
    hasThinking
      ? {
          label: t("usage.label.thinking", { level: thinkingLevel }),
          value: reasoningTokens > 0 ? formatTokens(reasoningTokens) : t("usage.thinkingEnabled"),
          percent: reasoningTokens > 0 ? percentOf(reasoningTokens, tokenUsage?.output) : null,
          color: "bg-violet-500",
        }
      : null,
    activeToolSkills.length > 0
      ? {
          label: t("usage.label.toolSkills"),
          value: t("usage.itemsCount", { count: activeToolSkills.length }),
          percent: null,
          color: "bg-cyan-500",
        }
      : null,
    (stats.toolCallCount ?? 0) > 0
      ? {
          label: t("usage.label.toolCalls"),
          value: `${t("usage.toolCallsCount", { count: stats.toolCallCount ?? 0 })}${activeMcpServers.length ? t("usage.mcpSuffix", { count: activeMcpServers.length }) : ""}`,
          percent: null,
          color: "bg-orange-500",
        }
      : null,
    activeModelSkills.length > 0
      ? {
          label: t("usage.label.skills"),
          value: t("usage.itemsCount", { count: activeModelSkills.length }),
          percent: null,
          color: "bg-blue-500",
        }
      : null,
  ].filter((row): row is NonNullable<typeof row> => Boolean(row));

  return (
    <section
      className="absolute bottom-[calc(100%+12px)] left-0 z-40 grid w-[min(380px,calc(100vw-28px))] gap-3.5 rounded-xl border bg-popover px-[18px] pt-[17px] pb-4 text-popover-foreground shadow-lg after:absolute after:-bottom-1.5 after:left-3.5 after:size-2.5 after:rotate-45 after:border-r after:border-b after:bg-popover after:content-[''] max-[560px]:fixed max-[560px]:right-3 max-[560px]:bottom-[calc(84px+env(safe-area-inset-bottom))] max-[560px]:left-auto max-[560px]:w-[min(356px,calc(100vw-24px))] max-[560px]:after:hidden"
      role="dialog"
      aria-label={t("usage.title")}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="mb-[3px] text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("usage.badge")}</p>
          <h2 className="text-[1.08rem] font-semibold">{t("usage.title")}</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t("usage.close")}
          title={t("usage.close")}
        >
          <X />
        </Button>
      </header>

      <div className="flex min-w-0 items-baseline gap-2.5">
        <strong className="text-[1.82rem] leading-none">
          {contextPercent == null ? "--" : `${contextPercent.toFixed(1)}%`}
        </strong>
        {/* 单行硬约束：整块 nowrap，token/费用数值再大也不折行；弹层已加宽到 380px 兑付。 */}
        <span className="min-w-0 whitespace-nowrap text-xs leading-snug text-muted-foreground">
          {t("usage.usedOfWindow", { used: formatTokens(stats.contextTokens), total: formatTokens(stats.contextWindow) })}
          {estimatedCostUsd != null ? (
            <>
              {" · "}
              {t("usage.estimatedCost", { cost: formatCny(estimatedCostUsd) })}
            </>
          ) : null}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
        <span className="block h-full rounded-[inherit] bg-primary" style={{ width: `${contextPercent ?? 0}%` }} />
      </div>

      <dl className="grid grid-cols-3 gap-2.5">
        {([
          [t("usage.turns"), stats.turnCount],
          [t("usage.messages"), stats.messageCount],
          [t("usage.compactions"), stats.compactionCount],
        ] as const).map(([label, value]) => (
          <div className="min-w-0" key={label}>
            <dt className="text-[0.72rem] text-muted-foreground">{label}</dt>
            <dd className="mt-[3px] text-sm font-bold">{value}</dd>
          </div>
        ))}
      </dl>

      {detailRows.length ? (
        <div className="grid gap-[11px] border-t pt-0.5">
          <p className="text-[0.72rem] text-muted-foreground">{t("usage.cumulativeHint")}</p>
          {detailRows.map((row) => (
            <div className="grid min-w-0 grid-cols-[9px_minmax(0,1fr)_auto_auto] items-center gap-2" key={row.label}>
              <span className={cn("size-[9px] rounded-full", row.color)} />
              <span className="min-w-0 truncate text-[0.82rem]">{row.label}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{row.value}</span>
              {row.percent != null ? (
                <span className="min-w-[42px] truncate text-right text-xs text-muted-foreground">
                  {row.percent.toFixed(1)}%
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("usage.noBreakdown")}</p>
      )}

      {canCompact ? (
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-[34px] w-full gap-[7px] border-amber-300 bg-amber-50 text-xs font-bold text-amber-900 hover:bg-amber-100 hover:text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60"
          onClick={onCompact}
          disabled={compactAction.disabled}
          aria-label={compactAction.reason === "streaming" ? t("usage.compactDisabledStreamingAria") : undefined}
        >
          <DatabaseZap />
          {compactAction.label}
        </Button>
      ) : null}
    </section>
  );
}

function formatCny(value: number) {
  if (!Number.isFinite(value)) {
    return "--";
  }

  if (value < 0.01) {
    return `¥${value.toFixed(4)}`;
  }

  return `¥${value.toFixed(2)}`;
}

export { UsagePopover, formatCny };
