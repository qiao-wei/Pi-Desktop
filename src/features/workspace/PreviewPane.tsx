import { ExternalLink, FileDiff, FileText, Loader2, TriangleAlert, X } from "lucide-react";

import { CodeViewer } from "./CodeViewer";

import { useT } from "@/i18n/react";
import { canRenderWorkspaceDiffPatch, workspaceDiffSourceLabelKey, type WorkspaceDiff } from "@/shared/workspaceDiff";
import {
  canRenderFileText,
  fileNameOf,
  formatFileSize,
  parentDirectory,
  type WorkspaceFileContent,
} from "@/shared/workspaceFiles";
import type { WorkspacePreviewSubject } from "@/shared/workspacePreview";

import { DiffViewer } from "./DiffViewer";

/**
 * 右面板的预览视图：一个文件的**改动**或**正文**。
 *
 * 结构上分两段：头部（文件名 / 相对目录 / 来源或大小 / 增删统计 / 关闭）钉住不动，正文自己滚 ——
 * 长补丁滚起来时还得看得见"我在看哪个文件"，这是 ZCode 预览标签页的做法。
 * 正文不带水平内边距：diff 要贴着面板两边铺开，否则 340px 里再吃掉 36px 就没地方放代码了。
 */
export function PreviewPane({
  subject,
  diff,
  content,
  isLoading,
  error,
  themeMode,
  onClose,
  onRetry,
  onOpenInIde,
}: {
  subject: WorkspacePreviewSubject | null;
  diff: WorkspaceDiff | null;
  content: WorkspaceFileContent | null;
  /** 代码高亮的明暗档跟着应用主题（@pierre/diffs 的 token 是 light-dark()，必须显式告诉它）。 */
  themeMode: "light" | "dark";
  isLoading: boolean;
  error: string;
  onClose: () => void;
  /** 读取失败时的重试（git 可能刚好被别的进程占着锁）。 */
  onRetry: () => void;
  /** 交给宿主机 IDE —— 三方合并、跨文件跳转这些还是 IDE 强，内置预览只负责「看一眼」。 */
  onOpenInIde: () => void;
}) {
  const t = useT();

  if (!subject) {
    return null;
  }

  const name = fileNameOf(subject.path);
  const dir = parentDirectory(subject.path);
  const isDiff = subject.kind === "diff";
  const showPatch = isDiff && canRenderWorkspaceDiffPatch(diff);
  const showText = !isDiff && canRenderFileText(content);
  // 超过 256KB：服务端不读、也不回半截文本（UTF-8 从中间截断就是乱码），ZCode 同样只提示。
  const tooLarge = !isDiff && content?.availability === "too-large";
  // 服务端已经给过一句原因（二进制 / 太大 / 没改动 / 文件不在），优先用它，别盖成"未知错误"。
  const fallbackMessage = (isDiff ? diff?.summary : content?.summary) ?? t("git.diff.unavailable");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start gap-2 px-[18px] pt-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium" title={subject.path}>
            {name}
          </div>
          {dir ? (
            <div className="truncate text-[11px] text-muted-foreground" title={subject.path}>
              {dir}
            </div>
          ) : null}
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            {subject.kind === "diff" ? (
              <>
                <span>{t(workspaceDiffSourceLabelKey(subject.source))}</span>
                {diff && (diff.added > 0 || diff.removed > 0) ? (
                  <span className="font-mono tabular-nums">
                    {diff.added > 0 ? (
                      <span className="text-emerald-600 dark:text-emerald-400">+{diff.added}</span>
                    ) : null}
                    {diff.removed > 0 ? (
                      <span className="text-rose-600 dark:text-rose-400">
                        {diff.added > 0 ? " " : ""}−{diff.removed}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <FileText aria-hidden="true" className="size-3.5" />
                <span className="tabular-nums">{formatFileSize(content?.size ?? 0)}</span>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenInIde}
          aria-label={t("git.diff.openInIde")}
          title={t("git.diff.openInIde")}
          className="-mt-0.5 rounded-[var(--app-radius-chip)] p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("git.diff.close")}
          title={t("git.diff.close")}
          className="-mt-0.5 rounded-[var(--app-radius-chip)] p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <div className="mt-2 shrink-0 border-t border-border" />

      {isLoading && !diff && !content ? (
        <div className="flex items-center gap-2 px-[18px] py-4 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t(isDiff ? "git.diff.loading" : "rightPanel.contentLoading")}
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 px-[18px] py-4 text-[12px] text-[var(--app-danger-ink)]">
          <TriangleAlert className="mt-[2px] size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-[var(--app-radius-chip)] border px-1.5 py-0.5 hover:bg-accent/60"
          >
            {t("git.diff.retry")}
          </button>
        </div>
      ) : null}

      {!isLoading && !error && !showPatch && !showText ? (
        <div className="flex items-start gap-2 px-[18px] py-4 text-[12px] text-muted-foreground">
          <FileDiff className="mt-[2px] size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {tooLarge
              ? t("rightPanel.contentTooLarge", { size: formatFileSize(content?.size ?? 0) })
              : fallbackMessage}
          </span>
        </div>
      ) : null}

      {/* 两种正文都在这一层滚：它高度确定，所以横向滚动条贴在可见区底边（和 ZCode 的
          `overflow: scroll` 一致），而不是跑去找不到。
          `mr-[18px]` 是右边缘那条沟（和头部同一个 18px，2026-10-12 用户反馈贴边太挤）：
          这里**不能**用 `pr-*` —— overflow 裁到的是 **padding box**，溢出的长行照样画进
          padding 区（实测离边 9px 处命中的仍是代码容器）；`mr-*` 是把滚动视口本身缩窄，
          裁边跟着往里挪，静止时也就真的能看到沟。 */}
      {!error && showPatch && diff?.patch ? (
        <div className="mr-[18px] min-h-0 flex-1 overflow-auto pt-1 pb-3">
          {/* 两侧全文一起给：服务端读得到时 diff 会画成带「N 行未改动」上下文的富渲染，
              读不到（超大文件）就退回落差补丁，见 DiffViewer 的两条路。 */}
          <DiffViewer
            patch={diff.patch}
            beforeContent={diff.beforeContent}
            afterContent={diff.afterContent}
            path={subject.path}
            themeMode={themeMode}
          />
        </div>
      ) : null}

      {!error && showText && content ? (
        <div className="mr-[18px] min-h-0 flex-1 overflow-auto pt-1 pb-3">
          <CodeViewer code={content.text ?? ""} path={subject.path} themeMode={themeMode} />
        </div>
      ) : null}
    </div>
  );
}