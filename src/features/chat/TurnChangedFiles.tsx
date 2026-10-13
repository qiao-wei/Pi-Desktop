import { ChevronRightIcon, FileText } from "lucide-react";
import { useMemo } from "react";

import { FileRowMenu } from "@/components/FileRowMenu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useT } from "@/i18n/react";
import { collectTurnChangedFiles, toWorkspaceRelativePath, type ToolCallLike } from "@/shared/turnChangedFiles";

/**
 * 一轮回答下面的「N 个文件已更改」（对齐 ZCode 的 ConversationFileSummaryPanel）。
 *
 * 两条刻意的取舍：
 * - **只在回答结束后出现**：流式途中工具还在跑，列表会一行行往外蹦，滚动位置跟着跳；
 *   而且中途的 diff 也不完整。用户真正想问的是「这轮到底动了什么」，那是结束之后的事。
 * - **默认收起**：它是一个索引，不是正文。展开后每一行点开就是右面板的预览。
 */
export function TurnChangedFiles({
  parts,
  workspaceRoot,
  onOpenDiff,
  onOpenContent,
  onOpenInIde,
}: {
  /** 这条气泡的 parts（tool-call 里带着改动的路径）。 */
  parts: readonly ToolCallLike[] | null | undefined;
  /** 项目根：工具参数里的绝对路径要折成相对路径显示 / 请求（和「改动」面板同一套路径）。 */
  workspaceRoot: string;
  onOpenDiff: (path: string) => void;
  onOpenContent: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  const t = useT();
  // parts 在流式期间每次 store 更新都是新数组：只在结束后算一次（见上面的取舍）。
  const paths = useMemo(
    () => collectTurnChangedFiles(parts).map((path) => toWorkspaceRelativePath(path, workspaceRoot)),
    [parts, workspaceRoot],
  );

  if (paths.length === 0) {
    return null;
  }

  return (
    <Collapsible data-slot="aui_turn-changed-files" className="mt-1 mb-2 w-full">
      <CollapsibleTrigger
        data-slot="aui_turn-changed-files-trigger"
        className="group/turn-files flex items-center gap-1.5 py-1 text-[13px] text-muted-foreground transition-colors outline-none hover:text-foreground"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className="-ms-1 size-3.5 shrink-0 opacity-70 transition-transform duration-200 group-data-open/turn-files:rotate-90"
        />
        <FileText aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="tabular-nums">{t("chat.changedFiles.title", { count: paths.length })}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden outline-none">
        <div className="ms-4 flex flex-col border-s border-border/60 ps-2">
          {paths.map((path) => (
            <FileRowMenu
              key={path}
              path={path}
              hasChanges
              hasContent
              onOpenContent={onOpenContent}
              onOpenDiff={onOpenDiff}
              onOpenInIde={onOpenInIde}
            >
              <button
                type="button"
                onClick={() => onOpenDiff(path)}
                title={path}
                data-changed-path={path}
                className="truncate rounded-[var(--app-radius-chip)] px-1 py-[2px] text-left font-mono text-[12px] text-foreground/90 hover:bg-accent/60"
              >
                {path}
              </button>
            </FileRowMenu>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}