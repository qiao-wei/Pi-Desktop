/**
 * 在项目行上点「新建会话」后，这个项目必须自动展开。
 *
 * 新会话由服务端创建并立刻选中（`/api/sessions` 返回的 `activeSessionPath` 就是它），
 * 但侧栏把会话画在项目下面：项目还收着时，用户点完只看到主区换了内容，侧栏里
 * 找不到那条被选中的新行——「点中了」这件事没有任何可见的落点。展开是点击的
 * 一部分，不该等用户再点一次项目名。
 *
 * 已经展开时原样返回同一个 Set 引用，让 React 跳过这次更新（整列重渲染不便宜）。
 */

export function expandProjectForNewSession(expandedProjectIds: Set<string>, projectId: string): Set<string> {
  if (expandedProjectIds.has(projectId)) {
    return expandedProjectIds;
  }
  return new Set([...expandedProjectIds, projectId]);
}
