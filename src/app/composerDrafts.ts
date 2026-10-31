import type { ComposerPart } from "./AppComposerHelpers";

/**
 * 每个会话自己的 composer 草稿。
 *
 * composer 的正文存在 contentEditable 的 DOM 里，而那块 DOM 是全应用唯一的一份 ——
 * 切会话时它不会被卸载。于是「在 A 里打了一半、切到 B」会把 A 的字带过去。这里按
 * `sessionPath` 存一份「完整草稿」（正文 + 附件徽标 + 技能徽标，不是只有文本），切走时
 * 存、切回时取。
 *
 * 纯数据，不碰 DOM、不碰 blob URL：徽标的 `previewUrl` 只是被原样保存，什么时候 revoke
 * 由调用方（`useAppWiring` 的引用计数 / 清理）决定。
 */

export interface ComposerDraftStore {
  /** 存下离开会话时的内容；空草稿等于删除（切回来时是干净的输入框）。 */
  save: (sessionPath: string, parts: ComposerPart[]) => void;
  /** 取走并删除：草稿只属于一个「画面」，恢复后由 DOM/编辑器持有，避免同一份被两处引用。 */
  take: (sessionPath: string) => ComposerPart[] | undefined;
  /** 丢弃某个会话的草稿（发送、删除会话等）。 */
  delete: (sessionPath: string) => void;
  /**
   * 只保留已知会话的草稿，返回被丢掉的 parts（调用方据此回收附件 blob URL）。
   * 用于会话被删除 / 归档后不留下孤立的草稿与内存。
   */
  prune: (knownSessionPaths: Iterable<string>) => ComposerPart[];
  /** 所有停放草稿里附件的预览地址（切走后这些 URL 不能被 revoke）。 */
  previewUrls: () => string[];
  has: (sessionPath: string) => boolean;
  size: () => number;
}

/** 只有空白文本（没有徽标）的草稿不算草稿。 */
export function isComposerDraftEmpty(parts: ComposerPart[]) {
  return parts.every((part) => part.kind === "text" && part.text.trim() === "");
}

export function createComposerDraftStore(): ComposerDraftStore {
  const drafts = new Map<string, ComposerPart[]>();

  return {
    save(sessionPath, parts) {
      if (!sessionPath) {
        return;
      }
      if (!parts.length || isComposerDraftEmpty(parts)) {
        drafts.delete(sessionPath);
        return;
      }
      drafts.set(sessionPath, parts);
    },
    take(sessionPath) {
      const parts = drafts.get(sessionPath);
      drafts.delete(sessionPath);
      return parts;
    },
    delete(sessionPath) {
      drafts.delete(sessionPath);
    },
    prune(knownSessionPaths) {
      const known = new Set(knownSessionPaths);
      const dropped: ComposerPart[] = [];
      for (const [sessionPath, parts] of drafts) {
        if (known.has(sessionPath)) {
          continue;
        }
        dropped.push(...parts);
        drafts.delete(sessionPath);
      }
      return dropped;
    },
    previewUrls() {
      const urls: string[] = [];
      for (const parts of drafts.values()) {
        for (const part of parts) {
          if (part.kind === "attachment" && part.attachment.previewUrl) {
            urls.push(part.attachment.previewUrl);
          }
        }
      }
      return urls;
    },
    has(sessionPath) {
      return drafts.has(sessionPath);
    },
    size() {
      return drafts.size;
    },
  };
}