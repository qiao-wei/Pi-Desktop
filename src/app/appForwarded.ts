import type { ComposerAttachment } from "./AttachmentHoverCard";
import type { ComposerCapability, ComposerPart } from "./AppComposerHelpers";
import type { SlashMenuItem } from "../features/chat/slashMenu";

/**
 * 顺序拆分后被「前一段调用、后一段声明」的那些函数的**签名快照**。
 *
 * 为什么单独放一份：段与段之间是顺序切分的（React 的 hook 调用顺序不能动），早的段会调用
 * 晚的段才声明的函数。若把这些前向引用写成 `Pick<ReturnType<typeof 后段>>`，类型会绕回
 * 自身（TS2502）；写成 `any`，回调参数会退化成 implicit any。于是签名单独取一份快照。
 *
 * 它**不**依赖任何段的返回类型 —— 没有环。真值装配时（`useAppModel.ts` 把各段返回类型
 * 交叉后传给每段的 `deps`），快照与真实签名的一致性由调用处的赋值检查兜住：
 * 签名写错了，`useAppModel()` 里会红。
 *
 * 由 `.scratch/emit-forward-types.mjs` 从拆分前的 `useAppModel()` 生成。
 */
export type AppForwarded = {
  // ── 由 useAppCaretSync 声明
  clearEmptyComposerMarkers: (editor: HTMLDivElement, nextAttachments: ComposerAttachment[], nextText: string) => void;
  hasComposerCapability: (capability: Pick<ComposerCapability, "kind" | "id">) => boolean;
  readComposerParts: (editor: HTMLDivElement | null) => ComposerPart[];
  removableBadgeBeforeCaret: (dataKey: "attachmentId" | "capabilityId") => HTMLSpanElement | null;
  removeLeadingCaretMarker: (node: Node | null) => void;
  removeSlashBeforeRange: (range: Range) => void;
  restoreComposerCaret: (container: Node | null, offset: number) => void;
  stepOverCaretMarker: (direction: -1 | 1) => boolean;
  trackPendingCapabilitySync: (promise: Promise<unknown>) => void;
  waitForPendingCapabilitySync: () => Promise<boolean>;
  // ── 由 useAppComposerEditing 声明
  createAttachmentBadgeNode: (attachment: ComposerAttachment) => HTMLSpanElement;
  createCapabilityBadgeNode: (capability: ComposerCapability) => HTMLSpanElement;
  insertAttachmentsAtCursor: (nextAttachments: ComposerAttachment[]) => void;
  rememberComposerSelection: () => void;
  rememberComposerSelectionFromPoint: (clientX: number, clientY: number) => void;
  removeAttachmentBeforeCaret: () => boolean;
  removeCapabilityBeforeCaret: () => boolean;
  selectSlashItem: (item: SlashMenuItem) => void;
  // ── 由 useAppTurn 声明
  hideAttachmentHover: () => void;
  syncComposerState: () => void;
};
