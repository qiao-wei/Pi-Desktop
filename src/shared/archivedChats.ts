import type { ArchivedSessionSummary } from "../types";

/**
 * 设置 → 归档聊天 的纯逻辑：筛选、排序、按项目分组。
 *
 * 放在 shared 里而不是组件里，是因为这些规则（分组怎么排、搜索命中哪些字段、
 * 老/新排序方向）跟渲染无关，可以用 node --test 直接断言；App.tsx 是 .tsx，
 * 测试进程 import 不了。
 */

export type ArchivedChatSort = "recent" | "oldest";

/** 项目已被移除时归档会话仍会留在索引里，统一归到这一组。 */
export const NO_PROJECT_GROUP_KEY = "no-project";

export interface ArchivedChatGroup {
  /** 稳定的 React key / 分组标识：项目 id，或 {@link NO_PROJECT_GROUP_KEY}。 */
  key: string;
  projectId?: string;
  /** 可能为空（项目已删除）；展示时回退到「无项目」文案。 */
  projectName: string;
  sessions: ArchivedSessionSummary[];
}

export interface ArchivedChatFilters {
  /** 标题或首条用户消息里的大小写不敏感子串。 */
  query?: string;
  /** 限定项目 id；空表示所有项目。 */
  projectId?: string;
  sort?: ArchivedChatSort;
}

export function filterArchivedSessions(
  sessions: ArchivedSessionSummary[],
  { query = "", projectId = "", sort = "recent" }: ArchivedChatFilters = {},
): ArchivedSessionSummary[] {
  const needle = query.trim().toLowerCase();
  const filtered = sessions.filter((session) => {
    if (projectId && session.projectId !== projectId) {
      return false;
    }
    if (!needle) {
      return true;
    }
    return (
      session.title.toLowerCase().includes(needle)
      || (session.firstMessage ?? "").toLowerCase().includes(needle)
    );
  });

  // 复制再排：调用方拿到的数组来自 bootstrap 快照，不能就地改它。
  const direction = sort === "oldest" ? 1 : -1;
  return [...filtered].sort((a, b) => direction * (a.updatedAt - b.updatedAt));
}

/**
 * 按项目分组，组内保持传入顺序。组顺序由每组的第一条决定 —— 所以配合
 * `filterArchivedSessions` 的排序，最近更新过会话的项目排在最前面。
 */
export function groupArchivedSessions(sessions: ArchivedSessionSummary[]): ArchivedChatGroup[] {
  const groups = new Map<string, ArchivedChatGroup>();
  for (const session of sessions) {
    const key = session.projectId || NO_PROJECT_GROUP_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        projectId: session.projectId || undefined,
        projectName: session.projectName ?? "",
        sessions: [],
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  return [...groups.values()];
}

/** 归档页的项目下拉：去重后按名称排序，供 Select 渲染。 */
export function archivedProjectOptions(
  sessions: ArchivedSessionSummary[],
): Array<{ id: string; name: string }> {
  const byId = new Map<string, string>();
  for (const session of sessions) {
    if (!session.projectId) {
      continue;
    }
    if (!byId.has(session.projectId)) {
      byId.set(session.projectId, session.projectName ?? "");
    }
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}