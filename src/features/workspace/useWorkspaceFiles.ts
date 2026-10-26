import { useCallback, useEffect, useRef, useState } from "react";

import { fetchJson } from "../../lib/api";
import {
  buildWorkspaceDirQuery,
  normalizeDirectoryListing,
  type WorkspaceFileEntry,
} from "../../shared/workspaceFiles";

export interface WorkspaceFilesController {
  /** 已经拉过的目录 → 条目（根目录的 key 是空串）。树是懒加载的，没展开过的目录不在里面。 */
  entriesByDir: ReadonlyMap<string, WorkspaceFileEntry[]>;
  /** 正在拉的目录；根目录第一次拉之前 `entriesByDir` 里没有 ""。 */
  loadingDirs: ReadonlySet<string>;
  /** 拉失败的目录 → 原因（只影响这一层，别的层照常显示）。 */
  errorsByDir: ReadonlyMap<string, string>;
  /** 条目被服务端上限截断过的目录。 */
  truncatedDirs: ReadonlySet<string>;
  /** 展开着的目录。 */
  expanded: ReadonlySet<string>;
  /** 根目录还没拉到任何东西（第一次进来时的骨架用）。 */
  isRootLoading: boolean;
  toggleDir: (path: string) => void;
  /** 展开某个目录（不切换：已经展开过就什么都不做）。自动定位要用。 */
  expandDir: (path: string) => void;
  /** 重新拉所有已加载过的目录（回答结束后 agent 可能新建了文件）。 */
  reload: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 右面板 Files 视图的数据源。
 *
 * 三个取舍：
 * - **一层一层拉**（懒加载）：递归读整棵树在 `node_modules` 面前就是自杀，而且会跟着软链跑出
 *   项目根。展开哪个目录才读哪个。
 * - **展开状态与已加载内容分开**：折叠再展开不重新请求，但 `reload()`（回答结束）会把已加载的
 *   每一层都刷一遍，这样 agent 新建的文件会出现，而用户展开的结构不会塌掉。
 * - **错误只挂那一层**：某个目录被删了，不该让整棵树变成错误页。
 * - **自动定位**（`expandDir` + 组件里的滚动）：打开的文件可能藏在没展开的目录里，
 *   Files 视图要能把它找出来（Codex 里打开的文件在树上总是可见的）。
 */
export function useWorkspaceFiles({
  projectId,
  sessionPath,
  isStreaming,
}: {
  projectId: string;
  sessionPath: string;
  /** 回答结束（流式转 false）时刷一遍已加载的目录。 */
  isStreaming: boolean;
}): WorkspaceFilesController {
  const [entriesByDir, setEntriesByDir] = useState<ReadonlyMap<string, WorkspaceFileEntry[]>>(new Map());
  const [loadingDirs, setLoadingDirs] = useState<ReadonlySet<string>>(new Set());
  const [errorsByDir, setErrorsByDir] = useState<ReadonlyMap<string, string>>(new Map());
  const [truncatedDirs, setTruncatedDirs] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const sequenceRef = useRef(0);
  /** 正在飞的请求按目录记一份，避免连点两次发两次。 */
  const inFlightRef = useRef(new Set<string>());

  const load = useCallback(
    async (dir: string) => {
      if (!projectId || inFlightRef.current.has(dir)) {
        return;
      }

      const sequence = sequenceRef.current;
      inFlightRef.current.add(dir);
      setLoadingDirs((current) => new Set(current).add(dir));

      try {
        const raw = await fetchJson<unknown>(buildWorkspaceDirQuery({ projectId, sessionPath, dir }));
        if (sequence !== sequenceRef.current) {
          return;
        }

        const listing = normalizeDirectoryListing(raw);
        if (!listing) {
          setErrorsByDir((current) => new Map(current).set(dir, String(raw)));
          return;
        }

        setEntriesByDir((current) => new Map(current).set(listing.dir, listing.entries));
        setErrorsByDir((current) => {
          if (!current.has(dir)) {
            return current;
          }
          const next = new Map(current);
          next.delete(dir);
          return next;
        });
        setTruncatedDirs((current) => {
          const next = new Set(current);
          if (listing.truncated) {
            next.add(dir);
          } else {
            next.delete(dir);
          }
          return next;
        });
      } catch (loadError) {
        if (sequence === sequenceRef.current) {
          setErrorsByDir((current) => new Map(current).set(dir, messageOf(loadError)));
        }
      } finally {
        inFlightRef.current.delete(dir);
        if (sequence === sequenceRef.current) {
          setLoadingDirs((current) => {
            const next = new Set(current);
            next.delete(dir);
            return next;
          });
        }
      }
    },
    [projectId, sessionPath],
  );

  // 换项目 / 换会话：整棵树都作废，回到只展开根目录的状态。
  useEffect(() => {
    sequenceRef.current += 1;
    inFlightRef.current.clear();
    setEntriesByDir(new Map());
    setErrorsByDir(new Map());
    setTruncatedDirs(new Set());
    setLoadingDirs(new Set());
    setExpanded(new Set());
    if (projectId) {
      void load("");
    }
  }, [projectId, sessionPath, load]);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      // 展开时按需拉：折叠再展开不用重拉（内容还在 entriesByDir 里）。
      if (!entriesByDir.has(path)) {
        void load(path);
      }
    },
    [entriesByDir, load],
  );

  const expandDir = useCallback(
    (path: string) => {
      setExpanded((current) => (current.has(path) ? current : new Set(current).add(path)));
      // 和 toggleDir 同一条按需加载规则（已拉过就不重复请求）。
      if (!entriesByDir.has(path)) {
        void load(path);
      }
    },
    [entriesByDir, load],
  );

  const reload = useCallback(() => {
    for (const dir of entriesByDir.keys()) {
      void load(dir);
    }
  }, [entriesByDir, load]);

  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) {
      reload();
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming, reload]);

  return {
    entriesByDir,
    loadingDirs,
    errorsByDir,
    truncatedDirs,
    expanded,
    isRootLoading: !entriesByDir.has("") && loadingDirs.has(""),
    toggleDir,
    expandDir,
    reload,
  };
}
