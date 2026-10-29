import { ChevronDownIcon, ChevronRightIcon, ExternalLink, FileText } from "lucide-react";
import { useMemo } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useT } from "@/i18n/react";
import { pathLeaf, toolRowFolder } from "@/shared/toolDisplay";
import {
  collectTurnChangedFilesWithCounts,
  toWorkspaceRelativePath,
  type ToolCallLike,
} from "@/shared/turnChangedFiles";

/**
 * 一轮回答下面的「N 个文件已更改」卡片 —— 逐字对齐 ZCode 的
 * `packages/ui/src/v4/ConversationFileSummaryPanel.tsx`。
 *
 * 抄的是**整段结构**，不是"看起来差不多"：外壳 `overflow-hidden rounded-[12px] border
 * border-border bg-card shadow-none`；表头 `h-10` + `hover:bg-hover`；行是
 * `div[role=button]`（整行可点 = 看改动），右侧两个按钮 `Review`（`bg-input` 实底）与
 * `Open`（**同一个**底色 + 边框的分段控件，右侧带一个 20px 的展开箭头下拉）。
 * 底色用 `bg-card` 而不是参考实现的 `bg-input`：两仓同名不同义 —— ZCode 的
 * `--color-input` 是**面**色（白 / neutral-800），本仓的 `--input` 是**描边**色
 * （0.87 灰），照抄会让按钮变成一块中灰。卡片底色在两套主题下与 ZCode 的按钮底色等价。
 * 之前那版把 `Open` 画成描边白底、行内没有悬停、`bg-hover` 还是个不存在的 token
 *（静默失效）—— 这些都是和参考实现肉眼可见的差距。
 *
 * 位置同样是契约：卡片渲染在**消息正文列里、操作栏之前**（走 `trailing` 槽位）。
 * 挂在操作栏下面会被读成消息的装饰，而不是这一轮回答的一部分。
 *
 * 半径**写死绝对像素**（卡片 12px、按钮 8px），不用 `rounded-xl` / `rounded-lg`：那两个类
 * 在本仓是 `calc(var(--radius) ± n)`，而 `--radius` 是**主题级**的（默认 10px、codex 16px），
 * 于是同一个 `rounded-xl` 在 codex 主题里是 20px —— 40px 高的表头上等于一个胶囊，用户直接
 * 说「这个圆角太大了」。参考实现的 `--radius-xl` 就是 12px（Tailwind 默认档），与主题无关。
 *
 * 与参考实现的**唯一**差别：表头右侧的「撤销」（按轮回滚文件）没有画 —— 本仓只有
 * 会话级回滚（`src/shared/sessionBranch.ts`），不动工作区文件。等接口有了再补。
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
  /** 第二个参数是这一轮的补丁：有它右面板直接渲染，不必（也不该）去问 git。 */
  onOpenDiff: (path: string, patch?: string) => void;
  onOpenContent: (path: string) => void;
  onOpenInIde: (path: string) => void;
}) {
  const t = useT();
  // parts 在流式期间每次 store 更新都是新数组：只在结束后算一次（调用方也只在落定后挂载）。
  const files = useMemo(
    () =>
      collectTurnChangedFilesWithCounts(parts).map((file) => {
        const relative = toWorkspaceRelativePath(file.path, workspaceRoot);
        return {
          ...file,
          relative: relative || file.path,
          // 右面板的接口只认**相对项目根**的路径（`normalizeRelativeDir` 对绝对路径直接返回
          // "outside the project folder"）。工具参数里的路径经常是绝对的，所以这里必须折一次
          // —— 少了这一步，「审查」和「打开」都会在右面板里报路径错误。
          panelPath: relative || file.path,
        };
      }),
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
      className="overflow-hidden rounded-[12px] border border-border bg-card shadow-none"
    >
      <div className="flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-hover">
        <CollapsibleTrigger
          data-slot="aui_turn-changed-files-trigger"
          aria-label={t("chat.changedFiles.expand")}
          className="group/turn-files flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left text-ui-base text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-foreground-subtlest transition-transform group-data-open/turn-files:rotate-90"
          />
          <span className="min-w-0 truncate font-medium">
            {t("chat.changedFiles.title", { count: files.length })}
          </span>
          {anythingCounted ? (
            <span className="shrink-0 tabular-nums">
              <span className="text-diff-added">+{totals.added}</span>{" "}
              <span className="text-diff-removed">-{totals.removed}</span>
            </span>
          ) : null}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="grid w-full border-t border-border">
          {files.map((file) => (
            <div key={file.path} className="w-full overflow-hidden bg-background/50">
              <div
                data-slot="aui_turn-changed-file"
                data-changed-path={file.relative}
                role="button"
                tabIndex={0}
                title={file.relative}
                className="flex w-full cursor-pointer items-center gap-1 px-2 py-2 text-left transition-colors hover:bg-hover/30"
                onClick={() => onOpenDiff(file.panelPath, file.patch)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  onOpenDiff(file.panelPath, file.patch);
                }}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {/* 参考实现用的是 16px 的文件类型图标（`FileDisplayInline`）。本仓没有那套
                        material 图标，用同一个尺寸的 lucide 文件图标兜住版式。 */}
                    <FileText
                      aria-hidden="true"
                      className="size-4 shrink-0 text-foreground-subtlest"
                    />
                    <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                      {pathLeaf(file.relative)}
                    </span>
                    <span className="min-w-0 truncate text-ui-base text-foreground-subtlest">
                      {toolRowFolder(file.relative, workspaceRoot)}
                    </span>
                  </div>
                  {/* 只有**非零**才画：参考实现是 `additions > 0 ? … : null`，所以新增文件
                      只出现 `+20`、不出现 `-0`。表头那条聚合数字是两个都画（参考实现同样如此）。 */}
                  {file.counted ? (
                    <span className="flex shrink-0 items-center gap-2 tabular-nums text-ui-base">
                      {file.added > 0 ? (
                        <span className="text-diff-added">+{file.added}</span>
                      ) : null}
                      {file.removed > 0 ? (
                        <span className="text-diff-removed">-{file.removed}</span>
                      ) : null}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    data-slot="aui_turn-changed-file-review"
                    aria-label={t("chat.changedFiles.review")}
                    title={t("chat.changedFiles.review")}
                    className="inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[8px] border border-border bg-card px-2 text-ui-base text-foreground transition-colors hover:border-border-hover hover:bg-hover/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenDiff(file.panelPath, file.patch);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    {t("chat.changedFiles.review")}
                  </button>
                  {/* 参考实现的 `OpenSplitButton`：一个 `bg-input` 底的分段控件，
                      左边「打开」看正文，右边 20px 的箭头下拉选打开方式。 */}
                  <div
                    className="flex h-7 shrink-0 items-center overflow-hidden rounded-[8px] border border-border bg-card transition-all hover:border-border-hover"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      data-slot="aui_turn-changed-file-open"
                      className="flex h-7 shrink-0 cursor-pointer items-center gap-1 pr-1.5 pl-2 text-ui-base text-foreground transition-colors hover:bg-hover focus-visible:outline-none"
                      onClick={() => onOpenContent(file.panelPath)}
                    >
                      {t("chat.changedFiles.open")}
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          data-slot="aui_turn-changed-file-open-with"
                          aria-label={t("chat.changedFiles.openWith")}
                          title={t("chat.changedFiles.openWith")}
                          className="flex h-7 w-5 shrink-0 cursor-pointer items-center justify-center border-0 text-foreground-subtlest transition-colors hover:bg-hover focus-visible:outline-none"
                        >
                          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" side="bottom" className="w-44">
                        <DropdownMenuItem onSelect={() => onOpenInIde(file.panelPath)}>
                          <ExternalLink className="size-4" />
                          {t("chat.changedFiles.openInIde")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}