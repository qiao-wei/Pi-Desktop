import { ArchiveRestore, FolderClosed, Loader2, MoreHorizontal, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useLocale, useT } from "../../i18n/react";
import {
  archivedProjectOptions,
  filterArchivedSessions,
  groupArchivedSessions,
  type ArchivedChatSort,
} from "../../shared/archivedChats";
import type { ArchivedSessionSummary } from "../../types";

/**
 * 设置 → 归档聊天。
 *
 * 侧栏的「归档」只把会话从项目列表里摘掉（文件还在），这一页是它们唯一的出口：
 * 取消归档放回侧栏，或者永久删除（走 `/api/sessions/delete*`，删文件）。
 *
 * 数据全部来自 bootstrap 快照，动作后由服务端返回新快照刷新；本组件不持有副本。
 * 失败信息画在自己身上：这是模态里的页面，宿主（App）的错误条被模态挡着看不见。
 */
export function ArchivedChatsSettings({
  sessions,
  onUnarchive,
  onDelete,
  onDeleteMany,
}: {
  sessions: ArchivedSessionSummary[];
  /** 取消归档，会话回到侧栏。 */
  onUnarchive: (projectId: string, sessionPath: string) => Promise<void>;
  /** 永久删除一条（不可恢复）。 */
  onDelete: (projectId: string, sessionPath: string) => Promise<void>;
  /** 永久删除归档会话；带 projectId 表示只删该项目下的。 */
  onDeleteMany: (projectId?: string) => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [sort, setSort] = useState<ArchivedChatSort>("recent");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: "one"; session: ArchivedSessionSummary }
    | { kind: "project"; projectId: string; projectName: string; count: number }
    | { kind: "all"; count: number }
    | null
  >(null);

  const projectOptions = useMemo(() => archivedProjectOptions(sessions), [sessions]);
  const groups = useMemo(
    () =>
      groupArchivedSessions(
        filterArchivedSessions(sessions, {
          query,
          projectId: projectFilter === "all" ? "" : projectFilter,
          sort,
        }),
      ),
    [projectFilter, query, sessions, sort],
  );
  const visibleCount = groups.reduce((total, group) => total + group.sessions.length, 0);

  async function unarchive(session: ArchivedSessionSummary) {
    setError(null);
    setBusyKey(session.path);
    try {
      await onUnarchive(session.projectId, session.path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyKey(null);
    }
  }

  async function confirmDelete() {
    const pending = pendingDelete;
    if (!pending) {
      return;
    }
    setPendingDelete(null);
    setError(null);
    setIsDeleting(true);
    try {
      if (pending.kind === "one") {
        await onDelete(pending.session.projectId, pending.session.path);
      } else if (pending.kind === "project") {
        await onDeleteMany(pending.projectId);
      } else {
        await onDeleteMany();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="grid gap-5">
      <div className="flex items-start justify-between gap-4">
        {/* 不再重复标题：设置弹窗的头部已经写着当前 tab 的名字。 */}
        <p className="min-w-0 text-sm text-muted-foreground">{t("archived.subtitle")}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
          disabled={!sessions.length || isDeleting}
          onClick={() => setPendingDelete({ kind: "all", count: sessions.length })}
        >
          <Trash2 />
          {t("archived.deleteAll")}
        </Button>
      </div>

      {error ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("archived.searchPlaceholder")}
            aria-label={t("archived.searchAria")}
          />
        </div>
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="w-[180px]" aria-label={t("archived.projectFilterAria")}>
            <FolderClosed className="size-4" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("archived.allProjects")}</SelectItem>
            {projectOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name || t("archived.noProject")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => setSort(value as ArchivedChatSort)}>
          <SelectTrigger className="w-[180px]" aria-label={t("archived.sortAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">{t("archived.sort.recent")}</SelectItem>
            <SelectItem value="oldest">{t("archived.sort.oldest")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {visibleCount === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {sessions.length ? t("archived.emptyFiltered") : t("archived.empty")}
        </p>
      ) : (
        <div className="grid gap-6">
          {groups.map((group) => {
            const groupName = group.projectName || t("archived.noProject");
            return (
              <section key={group.key} className="grid gap-2" aria-label={groupName}>
                <div className="flex items-center justify-between gap-2 px-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <FolderClosed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate text-sm font-medium text-foreground">{groupName}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t(
                        group.sessions.length === 1 ? "archived.chatCount.one" : "archived.chatCount.other",
                        { count: group.sessions.length },
                      )}
                    </span>
                  </div>
                  {group.projectId ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground"
                          aria-label={t("archived.projectMenu", { name: groupName })}
                          title={t("archived.projectMenu", { name: groupName })}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() =>
                            setPendingDelete({
                              kind: "project",
                              projectId: group.projectId as string,
                              projectName: groupName,
                              count: group.sessions.length,
                            })
                          }
                        >
                          <Trash2 />
                          {t("archived.deleteProjectAll")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>

                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  {group.sessions.map((session, index) => (
                    <div
                      key={session.path}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2.5",
                        index > 0 && "border-t border-border",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-foreground" title={session.title}>
                          {session.title}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatArchivedDate(session.updatedAt, locale)}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={isDeleting || busyKey === session.path}
                        onClick={() => setPendingDelete({ kind: "one", session })}
                        aria-label={t("archived.deleteForever")}
                        title={t("archived.deleteForever")}
                      >
                        <Trash2 />
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={isDeleting || busyKey === session.path}
                        onClick={() => void unarchive(session)}
                      >
                        {busyKey === session.path ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <ArchiveRestore />
                        )}
                        {t("archived.unarchive")}
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(next) => {
          if (!next && !isDeleting) {
            setPendingDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.kind === "one"
                ? t("archived.deleteOneTitle")
                : pendingDelete?.kind === "project"
                  ? t("archived.deleteProjectAllTitle")
                  : t("archived.deleteAllTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.kind === "one"
                ? t("archived.deleteOneDesc", { title: pendingDelete.session.title })
                : pendingDelete?.kind === "project"
                  ? t("archived.deleteProjectAllDesc", {
                      name: pendingDelete.projectName,
                      count: pendingDelete.count,
                    })
                  : t("archived.deleteAllDesc", { count: pendingDelete?.count ?? sessions.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              {t("archived.deleteForeverAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 归档行的日期（截图里的 `Sep 18, 2026, 10:36 AM` 形态），无效时间戳返回空串。 */
function formatArchivedDate(timestamp: number, locale: string): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  const intlLocale = locale === "zh" ? "zh-CN" : "en-US";
  try {
    return new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}