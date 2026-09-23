/**
 * 会话头部右侧 git 徽标的纯视图模型。
 *
 * 数据来自本地服务端（`GET /api/projects/git`，见 `server/gitInfo.mjs`），这里只回答
 * "这枚徽标该不该出现、显示成什么"。放在 shared 是因为它是纯函数：`node --test` 直接
 * 覆盖"没装 git / 不是仓库 / 空仓库 / 游离 HEAD / 脏工作区"这些分支，不用渲染 React。
 *
 * 显示规则（用户拍板）：
 * - 宿主机没装 git → 什么都不显示；
 * - 装了 git、项目不是仓库 → 显示"初始化 Git 仓库"按钮；
 * - 是仓库 → 显示分支 + 领先/落后 + 改动统计。
 */

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitFileChange {
  path: string;
  /** 重命名前的路径，非重命名为空串。 */
  origPath: string;
  status: GitFileStatus;
  staged: boolean;
  untracked: boolean;
  conflicted: boolean;
  added: number;
  removed: number;
}

export interface GitBranchSummary {
  name: string;
  current: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface GitInfo {
  gitInstalled: boolean;
  gitVersion: string;
  isRepo: boolean;
  /** 游离 HEAD 时为空串（用 `oid` 显示）。 */
  branch: string;
  oid: string;
  detached: boolean;
  unborn: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  added: number;
  removed: number;
  branches: GitBranchSummary[];
}

export type GitBadgeKind = "hidden" | "init" | "status";

/**
 * 徽标形态。`null` / 未加载 = hidden，避免首帧闪一个"初始化"按钮再变成分支名。
 */
export function gitBadgeKind(info: GitInfo | null | undefined): GitBadgeKind {
  if (!info || !info.gitInstalled) {
    return "hidden";
  }

  return info.isRepo ? "status" : "init";
}

/** 分支名；游离 HEAD 退回短 oid。还没有第一个 commit 的空仓库也已经有分支名（如 main）。 */
export function gitHeadLabel(info: GitInfo): string {
  if (!info.detached) {
    return info.branch || "HEAD";
  }

  return info.oid ? info.oid.slice(0, 7) : "HEAD";
}

/** 徽标上的改动统计（文件数 + 总增删行）。 */
export function gitChangeTotals(info: GitInfo): { files: number; added: number; removed: number } {
  return { files: info.files.length, added: info.added, removed: info.removed };
}

/** 工作区是否干净（没有未提交改动）。 */
export function isGitClean(info: GitInfo): boolean {
  return info.files.length === 0;
}

/** 文件状态 → 单字母标记（列表左侧那一列）。 */
export function gitStatusLetter(status: GitFileStatus): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "?";
    case "conflicted":
      return "U";
    default:
      return "M";
  }
}

/** 文件状态 → i18n key 后缀（`git.file.<status>`）。 */
export function gitStatusLabelKey(status: GitFileStatus): string {
  return `git.file.${status}`;
}

export interface GroupedGitFiles {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
}
/**
 * 分支列表里一行可不可以点。
 *
 * `reason` 决定点击要弹什么/要不要拦下：`current` 已是当前分支；`streaming` 回答生成中
 * （agent 正在改文件，这时候换分支最危险）；`busy` 已有一个切换在飞；`ok` 可以切。
 */
export interface GitBranchSwitchState {
  isCurrent: boolean;
  isSwitching: boolean;
  disabled: boolean;
  reason: "current" | "streaming" | "busy" | "ok";
}

export function gitBranchSwitchState(
  branch: Pick<GitBranchSummary, "name" | "current">,
  { isStreaming, switchingTo, isCreating = false }: { isStreaming: boolean; switchingTo: string; isCreating?: boolean },
): GitBranchSwitchState {
  if (branch.current) {
    return { isCurrent: true, isSwitching: false, disabled: true, reason: "current" };
  }

  if (isStreaming) {
    return { isCurrent: false, isSwitching: false, disabled: true, reason: "streaming" };
  }

  if (switchingTo || isCreating) {
    return { isCurrent: false, isSwitching: switchingTo === branch.name, disabled: true, reason: "busy" };
  }

  return { isCurrent: false, isSwitching: false, disabled: false, reason: "ok" };
}

/**
 * 分支列表要不要显示：仓库里有本地分支就显示（只有一个分支时也能看到并确认它是当前分支）。
 */
export function gitBranchListVisible(info: GitInfo): boolean {
  return info.branches.length > 0;
}

/**
 * 「从当前分支新建分支」的表单状态。
 *
 * 名字**合法不合法**不在这里判：git 的 ref 规则（空、`-` 开头、控制字符、`..``~^:?*[`、
 * 结尾 `.lock` …）由服务端的 `isSafeBranchName` + git 自己回答，客户端只回答两件它有数据的事：
 * 名字是否为空、是否和已知本地分支重名。这样规则只有一份（服务端），UI 不会自以为比 git 懂。
 */
export type GitCreateBranchBlockReason = "ok" | "streaming" | "busy" | "empty" | "exists";

export function gitCreateBranchBlockReason({
  isStreaming,
  isCreating,
  name,
  branches,
}: {
  isStreaming: boolean;
  isCreating: boolean;
  name: string;
  branches: readonly Pick<GitBranchSummary, "name">[];
}): GitCreateBranchBlockReason {
  if (isStreaming) {
    return "streaming";
  }
  if (isCreating) {
    return "busy";
  }

  const target = String(name ?? "").trim();
  if (!target) {
    return "empty";
  }
  if (branches.some((branch) => branch.name === target)) {
    return "exists";
  }

  return "ok";
}

/**
 * 「给当前分支改名」的表单状态。
 *
 * 和新建分支同一套哲学：名字**合法不合法**由服务端的 `isSafeBranchName` + git 自己回答，
 * 客户端只回答它有数据的事：名字是否为空、是否一个字没改（`unchanged`，确认按钮禁用，
 * 免得白跑一次写操作）、是否和已知本地分支重名。
 */
export type GitRenameBranchBlockReason = "ok" | "streaming" | "busy" | "empty" | "unchanged" | "exists";

export function gitRenameBranchBlockReason({
  isStreaming,
  isRenaming,
  name,
  current,
  branches,
}: {
  isStreaming: boolean;
  isRenaming: boolean;
  name: string;
  /** 当前分支名（`gitHeadLabel` 的结果），用来判"一个字没改"。 */
  current: string;
  branches: readonly Pick<GitBranchSummary, "name">[];
}): GitRenameBranchBlockReason {
  if (isStreaming) {
    return "streaming";
  }
  if (isRenaming) {
    return "busy";
  }

  const target = String(name ?? "").trim();
  if (!target) {
    return "empty";
  }
  if (target === current) {
    return "unchanged";
  }
  if (branches.some((branch) => branch.name === target)) {
    return "exists";
  }

  return "ok";
}

/**
 * 提交面板的勾选计划。
 *
 * `unselected` 存的是用户**取消勾选**的路径（默认全选）：每次 `status` 刷新后新出现的文件
 * 自动进入勾选，不会因为 Set 抓手上的旧路径而"新文件没勾上"或"已提交的路径还在勾"。
 *
 * 返回的 `paths` 会带上重命名的旧路径（只提交新路径会留下半个重命名），并排除冲突文件。
 */
export interface GitCommitPlan {
  /** 发给服务端的 paths（新路径 + 重命名的旧路径）。 */
  paths: string[];
  /** 勾选了几个文件（用于"提交 N 个文件"）。 */
  fileCount: number;
  /** 冲突文件：不能提交，要在 UI 里说明原因。 */
  conflicted: GitFileChange[];
}

export function gitCommitPlan(info: GitInfo, unselected: ReadonlySet<string> = new Set()): GitCommitPlan {
  const paths: string[] = [];
  const conflicted: GitFileChange[] = [];
  let fileCount = 0;

  for (const file of info.files) {
    if (file.conflicted) {
      conflicted.push(file);
      continue;
    }
    if (unselected.has(file.path)) {
      continue;
    }
    fileCount += 1;
    paths.push(file.path);
    if (file.origPath) {
      paths.push(file.origPath);
    }
  }

  return { paths, fileCount, conflicted };
}

/** 提交按钮为什么不能点（`ok` = 能点）。 */
export type GitCommitBlockReason = "ok" | "streaming" | "busy" | "emptyMessage" | "noFiles";

export function gitCommitBlockReason({
  isStreaming,
  isCommitting,
  message,
  fileCount,
}: {
  isStreaming: boolean;
  isCommitting: boolean;
  message: string;
  fileCount: number;
}): GitCommitBlockReason {
  if (isStreaming) {
    return "streaming";
  }
  if (isCommitting) {
    return "busy";
  }
  if (!String(message ?? "").trim()) {
    return "emptyMessage";
  }
  if (fileCount <= 0) {
    return "noFiles";
  }
  return "ok";
}

/**
 * 弹层里按"已暂存 / 未暂存 / 未跟踪"分组。冲突单独归到未暂存组（git 语义上它也不在
 * index 的正常状态里），未跟踪永远单独一组。
 */
export function groupGitFiles(files: readonly GitFileChange[]): GroupedGitFiles {
  const grouped: GroupedGitFiles = { staged: [], unstaged: [], untracked: [] };

  for (const file of files) {
    if (file.untracked) {
      grouped.untracked.push(file);
    } else if (file.staged) {
      grouped.staged.push(file);
    } else {
      grouped.unstaged.push(file);
    }
  }

  return grouped;
}