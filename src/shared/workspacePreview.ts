/**
 * 右面板预览的「在看什么」这个联合类型（改动 / 文件内容），以及两件事之间的比对。
 *
 * 单独放一个纯模块，是因为它是「内容该不该留在屏上」的唯一判据：判断写错的表现是
 * **看 A 文件时屏上留着 B 的正文**，这种错必须能被测试直接钉住，不能藏在 hook 里。
 * 这里不允许出现任何 fetch / React —— 只有类型和比较。
 */
import { sameWorkspaceDiffSubject, type WorkspaceDiffSource } from "./workspaceDiff.ts";

/** 看改动。`base` 只有 branch 来源用得上（服务端会用 merge-base 解出一个基准）。 */
export interface WorkspaceDiffSubject {
  kind: "diff";
  path: string;
  source: WorkspaceDiffSource;
  base?: string;
  /**
   * 补丁从哪来：`git`（默认，按来源现读工作区）还是 `turn`（**这一轮工具自己的补丁**）。
   *
   * 有区别是因为「本轮改动」在 git 里可能根本查不到：agent 新建的文件还没被跟踪，
   * 或者它已经 commit 过了 —— 那时 unstaged diff 是空的，而用户点的明明是「审查这一轮」。
   * 参考实现（ZCode `ConversationFileSummaryPanel`）走的就是补丁本身。
   */
  origin?: "git" | "turn";
}

/** 看文件正文（没有改动、或者用户就是想看整个文件时走这条）。 */
export interface WorkspaceContentSubject {
  kind: "content";
  path: string;
}

export type WorkspacePreviewSubject = WorkspaceDiffSubject | WorkspaceContentSubject;

export function diffSubject(input: {
  path: string;
  source: WorkspaceDiffSource;
  base?: string;
  origin?: "git" | "turn";
}): WorkspaceDiffSubject {
  return {
    kind: "diff",
    path: input.path,
    source: input.source,
    base: input.base,
    origin: input.origin,
  };
}

export function contentSubject(path: string): WorkspaceContentSubject {
  return { kind: "content", path };
}

export function previewSubjectPath(subject: WorkspacePreviewSubject | null): string {
  return subject?.path ?? "";
}

/**
 * 两次预览是不是「同一件事」—— 同一个文件、同一个来源（内容视图没有来源）。
 *
 * 用来决定「换了目标就把旧内容清掉」。注意比的是**请求**而不是屏上的数据：屏上的 diff 里
 * 没有 base 字段，拿它比的话「同一个文件换个 base」会骗过去，于是显示着上一份基准的差异。
 */
export function sameWorkspacePreviewSubject(
  previous: WorkspacePreviewSubject | null,
  next: WorkspacePreviewSubject | null,
): boolean {
  if (!previous || !next) {
    return previous === next;
  }

  if (previous.path !== next.path) {
    return false;
  }

  if (previous.kind === "content" && next.kind === "content") {
    return true;
  }

  if (previous.kind === "diff" && next.kind === "diff") {
    return sameWorkspaceDiffSubject(previous, next);
  }

  // 同一个文件但从「看改动」切到「看正文」：不是同一件事，旧的补丁必须清掉。
  return false;
}