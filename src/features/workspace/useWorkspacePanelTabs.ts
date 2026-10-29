import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchJson } from "../../lib/api";
import { t } from "../../i18n";
import {
  buildWorkspaceDiffQuery,
  diffStatsFromPatch,
  normalizeWorkspaceDiffResponse,
  type WorkspaceDiff,
  type WorkspaceDiffSource,
} from "../../shared/workspaceDiff";
import {
  buildWorkspaceFileQuery,
  normalizeFileContent,
  type WorkspaceFileContent,
} from "../../shared/workspaceFiles";
import {
  closeOtherPanelTabs,
  closePanelTab,
  fileTabId,
  forgetRecentClosedPanelTab,
  movePanelTab,
  normalizeActivePanelTab,
  openPanelTab,
  rememberClosedPanelTabs,
  toolTab,
  type RecentClosedPanelTab,
  type RightPanelFileTab,
  type RightPanelTab,
  type RightPanelToolTabId,
} from "./rightPanelTabs";

/** 「要看哪个文件的什么来源的改动」。`base` 只有 branch 来源需要。 */
export interface WorkspacePreviewRequest {
  path: string;
  source: WorkspaceDiffSource;
  base?: string;
  /**
   * 直接渲染的补丁（本轮工具产出的那份）。给了它就不查 git —— 见 `RightPanelFileTab.patch`。
   */
  patch?: string;
}

export interface WorkspaceFileTabData {
  /** 看改动时的结果（内容 tab 下是 null）。 */
  diff: WorkspaceDiff | null;
  /** 看正文时的结果（改动 tab 下是 null）。 */
  content: WorkspaceFileContent | null;
  isLoading: boolean;
  /** 读取失败的原因（已是可直接显示的文案）。 */
  error: string;
}

export interface WorkspacePanelTabsController {
  tabs: RightPanelTab[];
  activeTabId: string;
  activeTab: RightPanelTab | null;
  /** 每个文件 tab 的内容/状态；按 tab id 取。 */
  dataByTabId: Record<string, WorkspaceFileTabData>;
  /**
   * 文件树 / 改动列表要选中哪一行。
   *
   * 不能直接用 `activeTab.path`：树只在「文件」tab 激活时才挂着，那一刻 activeTab 是工具 tab，
   * 于是树里永远没有高亮。这里记「**上一个被打开/激活的文件 tab 的路径**」，切回工具 tab 时
   * 高亮还留在原处（关掉那张文件 tab 才清掉）。
   */
  activeFilePath: string;
  activateTab: (tabId: string) => void;
  /** 打开面板自带的工具视图（技能 / 文件 / 改动）。 */
  openToolTab: (toolId: RightPanelToolTabId, options?: { openPanel?: boolean }) => void;
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  closeAllTabs: () => void;
  /** 最近关闭的 tab（新的在前，最多 8 条）——strip 左侧「标签页总览」里可以重开。 */
  recentClosedTabs: RecentClosedPanelTab[];
  /** 重开一条最近关闭的 tab（文件 tab 会重新读一次内容：文件可能已经变了）。 */
  reopenClosedTab: (tabId: string) => void;
  /** 拖拽换位：把 `fromId` 拖到 `toId` 的位置上。 */
  moveTab: (fromId: string, toId: string) => void;
  /** 打开（或重复点击）某个文件的改动；重复点击只刷新那张 tab。 */
  openDiff: (request: WorkspacePreviewRequest) => void;
  /** 打开某个文件的正文。 */
  openContent: (path: string) => void;
  /** 强制重新读某张 tab（「重试」用）。 */
  reloadTab: (tabId: string) => void;
  /** 把当前打开的所有文件 tab 重新读一遍（回答结束后用：agent 可能又改过这些文件）。 */
  reloadAllFileTabs: () => void;
}

const EMPTY_DATA: WorkspaceFileTabData = { diff: null, content: null, isLoading: false, error: "" };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileTab(tab: RightPanelTab): tab is RightPanelFileTab {
  return tab.kind === "file";
}

/**
 * 右侧面板的 tab 表 + 每张文件 tab 的数据源。
 *
 * 取舍（和改造之前一致，只是从「单张预览」升级成「多张 tab」）：
 * - **不缓存结果**：agent 每轮都可能再改同一个文件，缓存下来的 diff 就成了旧改动。
 *   重新读的时候旧内容留在屏上（同一张 tab 的 key 没变，状态里那份不清）以避免闪白，
 *   但数据一定重新要；回答结束后主动把打开的文件 tab 全部刷新一遍。
 * - **换会话 / 换项目就关掉文件 tab**：路径是相对项目根的，换到另一个工作区后旧数据会指向
 *   完全不同的文件；工具 tab（技能/文件/改动）留着，它们本身不指向具体文件。
 * - **请求按 tab 带序号**：在同一个文件上连点两次、或边读边关掉它，迟到的响应不许写回来。
 */
export function useWorkspacePanelTabs({
  projectId,
  sessionPath,
  isStreaming,
  initialToolTabId,
}: {
  projectId: string;
  sessionPath: string;
  /** 回答是否在流式中：false 的落沿用来刷新打开的文件 tab。 */
  isStreaming: boolean;
  initialToolTabId: RightPanelToolTabId;
}): WorkspacePanelTabsController {
  const [tabs, setTabs] = useState<RightPanelTab[]>(() => [toolTab(initialToolTabId)]);
  const [activeTabId, setActiveTabId] = useState<string>(() => initialToolTabId);
  const [dataByTabId, setDataByTabId] = useState<Record<string, WorkspaceFileTabData>>({});
  const [recentClosedTabs, setRecentClosedTabs] = useState<RecentClosedPanelTab[]>([]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const sequencesRef = useRef(new Map<string, number>());

  /** 事件回调里只改这两件状态：用 ref 里的当前值算好结果，再整体写回（不在 setState 里做副作用）。 */
  const replaceTabs = useCallback((next: { tabs: RightPanelTab[]; activeTabId: string }) => {
    setTabs(next.tabs);
    setActiveTabId(next.activeTabId);
  }, []);

  const patchData = useCallback((tabId: string, patch: Partial<WorkspaceFileTabData>) => {
    setDataByTabId((previous) => ({ ...previous, [tabId]: { ...(previous[tabId] ?? EMPTY_DATA), ...patch } }));
  }, []);

  const loadTab = useCallback(
    async (tab: RightPanelFileTab) => {
      const sequence = (sequencesRef.current.get(tab.id) ?? 0) + 1;
      sequencesRef.current.set(tab.id, sequence);

      patchData(tab.id, { isLoading: true, error: "" });

      try {
        if (tab.mode === "diff" && typeof tab.patch === "string") {
          // 这一轮的补丁就是答案：不再问 git（新建文件在 git 里还是 untracked）。
          const stats = diffStatsFromPatch(tab.patch);
          patchData(tab.id, {
            diff: {
              path: tab.path,
              source: tab.source ?? "unstaged",
              availability: "patch",
              patch: tab.patch,
              beforeContent: null,
              afterContent: null,
              added: stats.added,
              removed: stats.removed,
              summary: null,
            },
            content: null,
            isLoading: false,
            error: "",
          });
          return;
        }

        if (tab.mode === "diff") {
          const raw = await fetchJson<unknown>(
            buildWorkspaceDiffQuery({
              projectId,
              sessionPath,
              path: tab.path,
              source: tab.source ?? "unstaged",
              base: tab.base,
            }),
          );
          if (sequencesRef.current.get(tab.id) !== sequence) {
            return;
          }

          const parsed = normalizeWorkspaceDiffResponse(raw);
          if (!parsed) {
            patchData(tab.id, { isLoading: false, error: t("git.diff.loadFailed", { reason: String(raw) }) });
            return;
          }

          patchData(tab.id, { diff: parsed, content: null, isLoading: false, error: "" });
          return;
        }

        const raw = await fetchJson<unknown>(buildWorkspaceFileQuery({ projectId, sessionPath, path: tab.path }));
        if (sequencesRef.current.get(tab.id) !== sequence) {
          return;
        }

        const parsed = normalizeFileContent(raw);
        if (!parsed) {
          patchData(tab.id, { isLoading: false, error: t("git.diff.loadFailed", { reason: String(raw) }) });
          return;
        }

        patchData(tab.id, { content: parsed, diff: null, isLoading: false, error: "" });
      } catch (loadError) {
        if (sequencesRef.current.get(tab.id) !== sequence) {
          return;
        }
        patchData(tab.id, { isLoading: false, error: t("git.diff.loadFailed", { reason: messageOf(loadError) }) });
      }
    },
    [patchData, projectId, sessionPath],
  );

  /** 打开一个文件 tab：已有的原地复用（身份 = 模式 + 路径 + 来源），否则追加到末尾。 */
  const openFileTab = useCallback(
    (tab: RightPanelFileTab) => {
      replaceTabs(openPanelTab(tabsRef.current, activeTabIdRef.current, tab));
      void loadTab(tab);
    },
    [loadTab, replaceTabs],
  );

  const openDiff = useCallback(
    (request: WorkspacePreviewRequest) => {
      const path = String(request.path ?? "").trim();
      if (!path) {
        return;
      }
      openFileTab({
        kind: "file",
        id: fileTabId(path),
        path,
        mode: "diff",
        source: request.source,
        base: request.base,
        patch: request.patch,
        openedAt: Date.now(),
      });
    },
    [openFileTab],
  );

  const openContent = useCallback(
    (path: string) => {
      const trimmed = String(path ?? "").trim();
      if (!trimmed) {
        return;
      }
      openFileTab({ kind: "file", id: fileTabId(trimmed), path: trimmed, mode: "content", openedAt: Date.now() });
    },
    [openFileTab],
  );

  const activateTab = useCallback((tabId: string) => {
    setActiveTabId(normalizeActivePanelTab(tabsRef.current, tabId));
  }, []);

  const openToolTab = useCallback(
    (toolId: RightPanelToolTabId) => {
      replaceTabs(openPanelTab(tabsRef.current, activeTabIdRef.current, { ...toolTab(toolId), openedAt: Date.now() }));
    },
    [replaceTabs],
  );

  /** 关掉 tab 时顺手把它的数据丢掉（否则一屏 tab 关光了，内存里还挂着一堆旧 diff）。 */
  const dropData = useCallback((tabIds: readonly string[]) => {
    if (tabIds.length === 0) {
      return;
    }
    for (const tabId of tabIds) {
      sequencesRef.current.delete(tabId);
    }
    setDataByTabId((previous) => {
      const next = { ...previous };
      for (const tabId of tabIds) {
        delete next[tabId];
      }
      return next;
    });
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      const current = tabsRef.current;
      replaceTabs(closePanelTab(current, normalizeActivePanelTab(current, activeTabIdRef.current), tabId));
      // 关掉的那张记进「最近关闭」：总览里还能重开（ZCode 同）。
      setRecentClosedTabs((recent) =>
        rememberClosedPanelTabs(
          recent,
          current.filter((tab) => tab.id === tabId),
          Date.now(),
        ),
      );
      dropData([tabId]);
    },
    [dropData, replaceTabs],
  );

  const closeOtherTabs = useCallback(
    (tabId: string) => {
      const current = tabsRef.current;
      const next = closeOtherPanelTabs(current, tabId);
      const keptIds = new Set(next.tabs.map((tab) => tab.id));
      replaceTabs(next);
      const closed = current.filter((tab) => !keptIds.has(tab.id));
      setRecentClosedTabs((recent) => rememberClosedPanelTabs(recent, closed, Date.now()));
      dropData(closed.map((tab) => tab.id));
    },
    [dropData, replaceTabs],
  );

  const closeAllTabs = useCallback(() => {
    const current = tabsRef.current;
    replaceTabs({ tabs: [], activeTabId: "" });
    setRecentClosedTabs((recent) => rememberClosedPanelTabs(recent, current, Date.now()));
    dropData(current.map((tab) => tab.id));
  }, [dropData, replaceTabs]);

  const moveTab = useCallback(
    (fromId: string, toId: string) => {
      replaceTabs({ tabs: movePanelTab(tabsRef.current, fromId, toId), activeTabId: activeTabIdRef.current });
    },
    [replaceTabs],
  );

  const reopenClosedTab = useCallback(
    (tabId: string) => {
      const entry = recentClosedTabs.find((candidate) => candidate.tab.id === tabId);
      if (!entry) {
        return;
      }

      replaceTabs(openPanelTab(tabsRef.current, activeTabIdRef.current, entry.tab));
      setRecentClosedTabs((recent) => forgetRecentClosedPanelTab(recent, tabId));
      // 重开的文件 tab 要重新读：关掉这段时间里 agent 可能已经改过它（「不缓存结果」同一条）。
      if (entry.tab.kind === "file") {
        void loadTab(entry.tab);
      }
    },
    [loadTab, recentClosedTabs, replaceTabs],
  );

  const reloadTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
      if (tab && isFileTab(tab)) {
        void loadTab(tab);
      }
    },
    [loadTab],
  );

  const reloadAllFileTabs = useCallback(() => {
    for (const tab of tabsRef.current) {
      if (isFileTab(tab)) {
        void loadTab(tab);
      }
    }
  }, [loadTab]);

  // 换会话 / 换项目：文件 tab 指向的是另一个工作区的路径，直接关掉。
  useEffect(() => {
    const previous = tabsRef.current;
    const kept = previous.filter((tab) => !isFileTab(tab));
    replaceTabs({ tabs: kept, activeTabId: normalizeActivePanelTab(kept, activeTabIdRef.current) });
    dropData(previous.filter(isFileTab).map((tab) => tab.id));
    // 最近关闭的清单跟着工作区走：里面可能全是另一个项目的文件路径。
    setRecentClosedTabs([]);
  }, [dropData, projectId, replaceTabs, sessionPath]);

  // 回答结束后把打开的文件 tab 重新读一遍：agent 这一轮可能又改过其中的文件，
  // 留在屏上的 diff 会变成上一轮的（和文件树在同一个落沿 reload 是一个道理）。
  const wasStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      reloadAllFileTabs();
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, reloadAllFileTabs]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );

  const [activeFilePath, setActiveFilePath] = useState("");
  useEffect(() => {
    if (activeTab && activeTab.kind === "file") {
      setActiveFilePath(activeTab.path);
      return;
    }
    // 停在工具 tab 上：保留上一个文件的高亮，直到那张文件 tab 被关掉。
    setActiveFilePath((current) =>
      current && tabs.some((tab) => tab.kind === "file" && tab.path === current) ? current : "",
    );
  }, [activeTab, tabs]);

  return {
    tabs,
    activeTabId,
    activeTab,
    dataByTabId,
    activeFilePath,
    activateTab,
    openToolTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    recentClosedTabs,
    reopenClosedTab,
    moveTab,
    openDiff,
    openContent,
    reloadTab,
    reloadAllFileTabs,
  };
}