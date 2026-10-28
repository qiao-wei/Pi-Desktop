import { ChevronRightIcon, FileText } from "lucide-react";
import { useMemo } from "react";

import { FileRowMenu } from "@/components/FileRowMenu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useT } from "@/i18n/react";
import {
  collectTurnChangedFilesWithCounts,
  toWorkspaceRelativePath,
  type ToolCallLike,
} from "@/shared/turnChangedFiles";
import { pathLeaf, toolRowFolder } from "@/shared/toolDisplay";

/**
 * 一轮回答下面的「N 个文件已更改」卡片（对齐 ZCode 的 `ConversationFileSummaryPanel`）。
 *
 * 形状是 ZCode 的：**一张卡片**，表头一行（chevron + 「N 个文件已更改」+ 聚合 `+X −Y`），
 * 展开后是每个文件一行（类型图标 + 文件名 + 目录 + 自己的 `+N −M` + 右侧「审查 / 打开」）。
 * 之前这里是一行淡灰小字 + 缩进的等宽路径列表，既没有汇总数字，也没有打开/审查的入口 ——
 * 读者无法回答"这轮动了多少"，也看不出该点哪里。
 *
 * 位置也重要：它必须在**正文之后、消息操作栏之前**。挂在操作栏下面会被读成消息的装饰，
 * 而不是这一轮回答的一部分（ZCode 同样把它放在 turn 内容里）。
 *
 * 已知缺口：ZCode 表头右侧有「撤销」（按轮回滚文件），本仓没有 rewind 能力 —— 不画一个
 * 点了只会弹「暂不支持」的按钮。等有按轮回滚的接口再补（见 ADR-006）。
 */
export function TurnChangedFiles({
  parts,
  workspaceRoot,
  onOpenDiff,
  onOpenContent,
  onOpenInIde,
}: {
  /** 这条气泡的 parts（tool-call 里带着改动的路径与派生出的 diff）。 */
  parts: readonly ToolCallLike[] | null | undefined;
  /** 项目根：工具参数里的绝对路径要折成相对路径显示 / 请求（和「改动」面板同一套路径）。 */
  workspaceRoot: string;
  onOpenDiff: (path: string) => void;
  onOpenContent: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  const t = useT();
  // parts 在流式期间每次 store 更新都是新数组：只在结束后算一次（调用方也只在落定后挂载）。
  const files = useMemo(
    () =>
      collectTurnChangedFilesWithCounts(parts).map((file) => ({
        ...file,
        relative: toWorkspaceRelativePath(file.path, workspaceRoot),
      })),
    [parts, workspaceRoot],
  );

  if (files.length === 0) {
    return null;
  }

  const totals = files.reduce(
    (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
    { added: 0, removed: 0 },
  );
  const anythingCounted = files.some((file) => file.counted);

  return (
    <Collapsible
      data-slot="aui_turn-changed-files"
      className="w-full overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-hover/60">
        <CollapsibleTrigger
          data-slot="aui_turn-changed-files-trigger"
          className="group/turn-files flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left text-ui-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-foreground-subtlest transition-transform duration-200 group-data-open/turn-files:rotate-90"
          />
          <span className="min-w-0 truncate font-medium">
            {t("chat.changedFiles.title", { count: files.length })}
          </span>
          {anythingCounted ? (
            <span className="shrink-0 tabular-nums">
              <span className="text-diff-added">+{totals.added}</span>{" "}
              <span className="text-diff-removed">−{totals.removed}</span>
            </span>
          ) : null}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="overflow-hidden outline-none">
        <div className="grid w-full border-t border-border">
          {files.map((file) => (
            <FileRowMenu
              key={file.path}
              path={file.path}
              hasChanges
              hasContent
              onOpenContent={onOpenContent}
              onOpenDiff={onOpenDiff}
              onOpenInIde={onOpenInIde}
            >
              <div
                data-slot="aui_turn-changed-file"
                data-changed-path={file.relative}
                className="flex w-full items-center gap-1 px-2 py-2 transition-colors hover:bg-hover/30"
              >
                <button
                  type="button"
                  title={file.relative}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left focus-visible:outline-none"
                  onClick={() => onOpenDiff(file.path)}
                >
                  <FileText aria-hidden="true" className="size-3.5 shrink-0 text-foreground-subtlest" />
                  <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                    {pathLeaf(file.relative)}
                  </span>
                  <span className="min-w-0 truncate text-ui-base text-foreground-subtlest">
                    {toolRowFolder(file.relative, workspaceRoot)}
                  </span>
                  {/* 两个数字**都**画：新增文件就是 `+20 −0`（ZCode 同款）。"数不出来"
                      与"确实是 0"在数据里靠 `counted` 区分，不靠隐藏数字 —— 隐藏会让
                      `+20` 看起来像"只加了、没删"，读者无法判断是不是漏统计。 */}
                  {file.counted ? (
                    <span className="flex shrink-0 items-center gap-2 tabular-nums text-ui-base">
                      <span className="text-diff-added">+{file.added}</span>
                      <span className="text-diff-removed">−{file.removed}</span>
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  data-slot="aui_turn-changed-file-review"
                  className="h-7 shrink-0 cursor-pointer rounded-lg bg-input px-2 text-ui-base text-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onOpenDiff(file.path)}
                >
                  {t("chat.changedFiles.review")}
                </button>
                <button
                  type="button"
                  data-slot="aui_turn-changed-file-open"
                  title={t("chat.changedFiles.openInIde")}
                  className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-2 text-ui-base text-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onOpenContent(file.path)}
                >
                  {t("chat.changedFiles.open")}
                </button>
              </div>
            </FileRowMenu>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
