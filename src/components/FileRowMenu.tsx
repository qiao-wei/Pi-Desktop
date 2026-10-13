import { FileText, ExternalLink, GitCompare } from "lucide-react";
import type { ReactNode } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useT } from "../i18n/react";

/**
 * 文件行共用的右键菜单：看内容 / 看改动 / 用 IDE 打开。
 *
 * 树和「改动」列表的行都套这一层，省得两处各写一份、还各错一处。
 * `hasChanges` 决定要不要给「看改动」那一项 —— 没有改动的文件点它只会得到
 * 一句 mode-split 的「这个来源下没有改动」，不如不出现。
 */
export function FileRowMenu({
  path,
  hasChanges,
  hasContent,
  onOpenContent,
  onOpenDiff,
  onOpenInIde,
  children,
}: {
  path: string;
  hasChanges: boolean;
  /** 有内容可看的（目录就没有）。 */
  hasContent: boolean;
  onOpenContent: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onOpenInIde: (path: string) => void;
  children: ReactNode;
}) {
  const t = useT();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {hasContent ? (
          <ContextMenuItem onSelect={() => onOpenContent(path)}>
            <FileText />
            {t("rightPanel.rowMenu.viewContent")}
          </ContextMenuItem>
        ) : null}
        {hasChanges ? (
          <ContextMenuItem onSelect={() => onOpenDiff(path)}>
            <GitCompare />
            {t("rightPanel.rowMenu.viewDiff")}
          </ContextMenuItem>
        ) : null}
        {hasContent || hasChanges ? <ContextMenuSeparator /> : null}
        <ContextMenuItem onSelect={() => onOpenInIde(path)}>
          <ExternalLink />
          {t("rightPanel.rowMenu.openInIde")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}