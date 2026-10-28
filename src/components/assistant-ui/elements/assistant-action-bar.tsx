"use client";

/**
 * The assistant message's action bar (copy / regenerate / export).
 *
 * Split out of `thread.aui.tsx`, which is frozen by the `max-lines` ratchet: this
 * block is self-contained (its own subtree + two hooks) and moving it is what buys
 * the thread room for the changed-files slot that has to sit *before* it in flow.
 */

import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  useAuiState,
} from "@assistant-ui/react";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { FC } from "react";

import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useT } from "@/i18n/react";

/**
 * While a turn is streaming every message action is inert: copying a half-written
 * answer, regenerating mid-run or editing a question that is still being answered
 * all corrupt the transcript. The bars stay in place but grey out (native
 * `disabled` → `disabled:opacity-50` on the buttons) instead of the old
 * `hideWhenRunning` disappearing act, which re-flowed the footer.
 */
export const useActionsDisabled = () => useAuiState((s) => s.thread.isRunning);

export const AssistantActionBar: FC = () => {
  const t = useT();
  const actionsDisabled = useActionsDisabled();
  return (
    <ActionBarPrimitive.Root
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip={t("message.copy")} disabled={actionsDisabled}>
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip={t("message.refresh")} className="aui-assistant-action-refresh" disabled={actionsDisabled}>
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip={t("message.more")}
            className="data-[state=open]:bg-accent"
            disabled={actionsDisabled}
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              {t("message.exportMarkdown")}
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};
