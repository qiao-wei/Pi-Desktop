import type { useAppCore } from "./useAppCore";
import type { useAppWiring } from "./useAppWiring";
import type { useAppComposer } from "./useAppComposer";
import type { useAppTurn } from "./useAppTurn";
import type { AppForwarded } from "./appForwarded";
import { capabilityBadgeKey, composerCaretMarker, createCapabilityInstanceId } from "./AppComposerHelpers";
import type {
  CapabilityKind,
} from "../types";
import {
  applyAttachmentBadgeAttributes,
  applyCapabilityBadgeAttributes,
} from "../features/chat/badgeClipboard";
import {
  type SlashMenuItem,
} from "../features/chat/slashMenu";
import { ComposerAttachment } from "./AttachmentHoverCard";
import { formatFileSize } from "./CapabilitiesPage";
import { ComposerCapability, capabilitySelector } from "./AppComposerHelpers";


/**
 * 本段**之后**才声明的名字：只在延迟执行位置（回调/副作用里）用到 —— 类型直接 `Pick`
 * 后段返回类型（精确，不是 any）。它们每次 render 由 `deps` 重新赋值，
 * 所以 `deps.X` 读到的是当前 render 的值（比原来的闭包捕获更难过期）。
 */
type Later =
  Pick<AppForwarded, "hasComposerCapability" | "removableBadgeBeforeCaret" | "removeSlashBeforeRange" | "restoreComposerCaret" | "trackPendingCapabilitySync">;


/**
 * slash 命令、插入与光标写入（composer 编辑面）
 *
 * `useAppModel()` 顺序切出的第 5 段（原 body 语句 139–152，1643–2118 行）。
 *   · 本段**之前**声明的名字：从共享 `deps` 解构（拿到的是真值本身，闭包身份不变）。
 *   · 本段**之后**才声明的名字：就地写成 `deps.X`（只在延迟执行位置出现；读的是当前 render 的值）。
 * 段内语句一字未改 —— 正确性靠这一点，也靠 `tests/appModelSplit.test.ts` 的顺序与字段校验。
 *
 * 由 `.scratch/split-hook-segments.mjs` 机械搬出。
 */
export function useAppComposerEditing(deps: ReturnType<typeof useAppCore> & ReturnType<typeof useAppWiring> & ReturnType<typeof useAppComposer> & ReturnType<typeof useAppTurn> & Later) {
  // 前面几段已经写进 deps 的值。
  const {
    attachmentHoverGateRef, attachmentPreviewUrlsRef, capabilities, composerAttachmentMapRef, composerCapabilityMapRef, composerEditorRef,
    composerSelectionRef, hideAttachmentHover, removeAttachment, removeBadgeNode, setActiveMainView, setComposerError,
    setSessionSkill, setShowCapabilityPicker, setSlashArgumentArmed, setSlashArgumentItems, setSlashCommandContext, setSlashHighlight,
    setSlashQuery, showAttachmentHover, slashCommandContext, syncComposerState, t,
  } = deps;

  function insertAttachmentsAtCursor(nextAttachments: ComposerAttachment[]) {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    if (nextAttachments.length) {
      // 插入点常常就在指针下面（粘贴截图 / 拖放文件），浏览器会给刚出现的新徽章补发
      // mouseenter。先收掉旧预览并上闸，等指针真动过再按指针位置重新判断。
      hideAttachmentHover();
      attachmentHoverGateRef.current.suppress();
    }

    const selection = window.getSelection();
    rememberComposerSelection();
    let range = composerSelectionRef.current?.cloneRange();
    if (!range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    editor.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    range.deleteContents();

    for (const attachment of nextAttachments) {
      composerAttachmentMapRef.current.set(attachment.id, attachment);
      if (attachment.previewUrl) {
        attachmentPreviewUrlsRef.current.set(attachment.id, attachment.previewUrl);
      }

      const badge = createAttachmentBadgeNode(attachment);
      const caretNode = document.createTextNode(composerCaretMarker);
      range.insertNode(badge);
      badge.after(caretNode);
      range.setStart(caretNode, caretNode.textContent?.length ?? 0);
      range.collapse(true);
    }

    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    composerSelectionRef.current = range.cloneRange();
    syncComposerState();
  }

  /**
   * TUI 的补全：把选中的 /命令 落成普通文本（`/name `），不执行，
   * 光标停在后面等用户填参数；命令注册了参数补全时顺手把参数/实例菜单切上来。
   */
  function insertCommandAtCursor(item: Extract<SlashMenuItem, { kind: "command" }>, options?: { atEnd?: boolean; trailingSpace?: boolean }) {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    // 能力卡点进来的先只放 `/name`（trailingSpace=false）：空格让用户自己敲，
    // 敲下去的那一刻 handleComposerInput 才把参数/实例列表拉出来。
    const trailingSpace = options?.trailingSpace ?? true;

    const selection = window.getSelection();
    if (!options?.atEnd) {
      rememberComposerSelection();
    }
    // 从能力卡点 action 时焦点在按钮上，composer 里记的选区可能已经过时：一律追加到末尾。
    let range = options?.atEnd ? null : composerSelectionRef.current?.cloneRange();
    if (!range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    editor.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    deps.removeSlashBeforeRange(range);

    // composer 里已有其它文本时，避免接成 `note/mcp`：前面不是空白就补一个空格。
    const beforeText = range.startContainer.nodeType === Node.TEXT_NODE
      ? (range.startContainer.textContent ?? "").slice(0, range.startOffset)
      : (range.startContainer.textContent ?? "");
    const separator = beforeText.length > 0 && !/\s$/u.test(beforeText) ? " " : "";
    const commandNode = document.createTextNode(`${separator}/${item.name}${trailingSpace ? " " : ""}`);
    range.insertNode(commandNode);
    range.setStart(commandNode, commandNode.textContent?.length ?? 0);
    range.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    composerSelectionRef.current = range.cloneRange();
    syncComposerState();

    if (trailingSpace && item.hasArgumentCompletions) {
      setSlashQuery("");
      setSlashHighlight(0);
      setSlashArgumentArmed(false);
      setSlashCommandContext({ packageId: item.packageId, name: item.name, prefix: "" });
    } else if (!trailingSpace) {
      setSlashCommandContext(null);
      setSlashArgumentArmed(false);
      setShowCapabilityPicker(false);
    }
  }

  /**
   * 应用一条参数候选：用候选值替换命令后已输入的整段参数（同 pi TUI 的
   * applyCompletion 参数分支），末尾补一个空格，并自动拉下一级候选
   * （如 `/mcp disable ` → server 实例列表）；没有下一级就收菜单，等回车提交。
   */
  function applyArgumentCompletion(item: Extract<SlashMenuItem, { kind: "argument" }>) {
    const editor = composerEditorRef.current;
    const context = slashCommandContext;
    if (!editor || !context) {
      return;
    }

    const selection = window.getSelection();
    rememberComposerSelection();
    let range = composerSelectionRef.current?.cloneRange();
    if (!range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    const container = range.startContainer;
    if (container.nodeType === Node.TEXT_NODE) {
      const text = container.textContent ?? "";
      const before = text.slice(0, range.startOffset);
      const commandStart = before.lastIndexOf(`/${context.name}`);
      if (commandStart !== -1) {
        // 末尾留一个空格：pi 的参数补全靠这个空格区分下一级 token（`/mcp disable `
        // 才能拿到 server 实例列表），同时交给下面的 effect 自动拉下一级候选。
        const trailing = /\s$/u.test(item.value) ? "" : " ";
        const replacement = `/${context.name} ${item.value}${trailing}`;
        container.textContent = `${text.slice(0, commandStart)}${replacement}${text.slice(range.startOffset)}`;
        range.setStart(container, commandStart + replacement.length);
        range.collapse(true);
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        composerSelectionRef.current = range.cloneRange();
      }
    }

    // 先把菜单收起来（旧候选会闪），再把 context 设成刚填入的值 + 空格：
    // 若该命令还有下一级（如实例列表），effect 会拉到候选后自动重新展开；没有就保持收起。
    setShowCapabilityPicker(false);
    setSlashArgumentItems([]);
    setSlashQuery("");
    setComposerError("");
    setSlashArgumentArmed(false);
    setSlashCommandContext({ packageId: context.packageId, name: context.name, prefix: `${item.value} ` });
    syncComposerState();
  }

  /**
   * 菜单项的落点（Tab / Enter / 鼠标点选都一样）：
   * - skill → 插能力徽章
   * - command → 只把 `/name ` 写进 composer（**不执行**）
   * - argument → 应用参数候选
   * 执行只发生在表单提交（handleSubmit）——命令文本写完后回车才跑。
   */
  function selectSlashItem(item: SlashMenuItem) {
    setShowCapabilityPicker(false);
    setSlashQuery("");
    setSlashArgumentArmed(false);
    if (item.kind === "skill") {
      setSlashCommandContext(null);
      insertCapabilityAtCursor({ kind: "skill", id: item.id, name: item.name, description: item.description, active: true });
      return;
    }
    if (item.kind === "argument") {
      applyArgumentCompletion(item);
      return;
    }
    if (item.kind === "builtin") {
      insertBuiltinCommandAtCursor(item);
      return;
    }
    insertCommandAtCursor(item);
  }

  /**
   * 内置命令（目前 `/reload`）复用包命令的插入落点，但没有包、也没有参数补全：
   * 只填 `/name`，不弹参数菜单；回车提交时由 `handleSubmit` 派发给 /api/builtin-command。
   */
  function insertBuiltinCommandAtCursor(item: Extract<SlashMenuItem, { kind: "builtin" }>) {
    insertCommandAtCursor(
      {
        kind: "command",
        packageId: "",
        packageName: "",
        name: item.name,
        description: item.description,
        hasArgumentCompletions: false,
      },
      { trailingSpace: false },
    );
  }

  /**
   * Packages 页 / 项目能力面板里点 action（不直接执行）：
   * 把 `/command ` 填进当前对话的 composer，有参数补全的会自动弹参数/实例列表，
   * 和斜杠菜单选中是同一条落点；执行仍然只在回车提交时发生。
   */
  function insertPackageCommandIntoComposer(packageId: string, commandName: string) {
    const pkg = capabilities.packages.find((candidate) => candidate.id === packageId);
    const command = pkg?.commands.find((candidate) => candidate.name === commandName);
    if (!pkg || !command) {
      return;
    }
    setActiveMainView("chat");
    insertCommandAtCursor(
      {
        kind: "command",
        packageId: pkg.id,
        packageName: pkg.name,
        name: command.name,
        description: command.description ?? pkg.description,
        hasArgumentCompletions: Boolean(command.hasArgumentCompletions),
      },
      { atEnd: true, trailingSpace: false },
    );
    // 关面板 / 切视图都可能顺手改焦点（Radix 会把焦点还给按钮）：下一帧确认光标回 composer。
    requestAnimationFrame(() => {
      const editor = composerEditorRef.current;
      if (editor && !editor.contains(document.activeElement)) {
        editor.focus({ preventScroll: true });
      }
    });
  }

  function insertCapabilityAtCursor(capability: ComposerCapability) {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    setShowCapabilityPicker(false);
    const selection = window.getSelection();
    rememberComposerSelection();
    let range = composerSelectionRef.current?.cloneRange();
    if (!range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    editor.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    deps.removeSlashBeforeRange(range);

    const selectedCapability = { ...capability, active: true, instanceId: createCapabilityInstanceId() };
    composerCapabilityMapRef.current.set(capabilityBadgeKey(selectedCapability), selectedCapability);
    const badge = createCapabilityBadgeNode(selectedCapability);
    const caretNode = document.createTextNode(composerCaretMarker);
    range.insertNode(badge);
    badge.after(caretNode);
    range.setStart(caretNode, caretNode.textContent?.length ?? 0);
    range.collapse(true);

    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    composerSelectionRef.current = range.cloneRange();
    syncComposerState();
    if (selectedCapability.kind === "skill") {
      const capabilityUpdate = setSessionSkill(selectedCapability.id, true);
      deps.trackPendingCapabilitySync(capabilityUpdate);
      void capabilityUpdate.catch((error) => {
        setComposerError(error instanceof Error ? error.message : String(error));
      });
    }
  }

  function rememberComposerSelection() {
    const editor = composerEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || !selection.rangeCount) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (editor.contains(range.startContainer) && editor.contains(range.endContainer)) {
      composerSelectionRef.current = range.cloneRange();
    }
  }

  function rememberComposerSelectionFromPoint(clientX: number, clientY: number) {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    const documentWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let range = documentWithCaret.caretRangeFromPoint?.(clientX, clientY) ?? null;
    const caretPosition = !range ? documentWithCaret.caretPositionFromPoint?.(clientX, clientY) : null;
    if (!range && caretPosition) {
      range = document.createRange();
      range.setStart(caretPosition.offsetNode, caretPosition.offset);
      range.collapse(true);
    }

    if (range && editor.contains(range.startContainer)) {
      composerSelectionRef.current = range.cloneRange();
    }
  }

  function createAttachmentBadgeNode(attachment: ComposerAttachment) {
    const badge = document.createElement("span");
    badge.className = `attachment-badge ${attachment.kind}`;
    badge.dataset.attachmentId = attachment.id;
    applyAttachmentBadgeAttributes(badge, attachment);
    badge.contentEditable = "false";
    badge.addEventListener("mouseenter", () => {
      if (attachmentHoverGateRef.current.isSuppressed()) {
        return;
      }
      showAttachmentHover(attachment, badge);
    });
    badge.addEventListener("mouseleave", hideAttachmentHover);

    if (attachment.kind === "image" && attachment.previewUrl) {
      const image = document.createElement("img");
      image.alt = "";
      image.src = attachment.previewUrl;
      badge.appendChild(image);
    } else {
      const icon = document.createElement("span");
      icon.className = "attachment-badge-icon";
      icon.innerHTML = attachment.kind === "directory"
        ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`
        : `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg>`;
      badge.appendChild(icon);
    }

    const copy = document.createElement("span");
    copy.className = "attachment-badge-copy";
    const title = document.createElement("strong");
    title.title = attachment.name;
    title.textContent = attachment.name;
    const size = document.createElement("small");
    size.textContent = attachment.kind === "directory"
      ? t("composer.attachment.folder")
      : formatFileSize(attachment.size);
    copy.append(title, size);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${attachment.name}`);
    remove.title = `Remove ${attachment.name}`;
    remove.innerHTML = "<span aria-hidden='true'>×</span>";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeAttachment(attachment.id);
    });

    badge.append(copy, remove);
    return badge;
  }

  function createCapabilityBadgeNode(capability: ComposerCapability) {
    const badge = document.createElement("span");
    badge.className = `attachment-badge capability-badge ${capability.kind}`;
    badge.dataset.capabilityId = capability.id;
    badge.dataset.capabilityKind = capability.kind;
    badge.dataset.capabilityInstanceId = capability.instanceId ?? "";
    applyCapabilityBadgeAttributes(badge, capability);
    badge.contentEditable = "false";

    const icon = document.createElement("span");
    icon.className = "attachment-badge-icon";
    icon.textContent = "S";

    const copy = document.createElement("span");
    copy.className = "attachment-badge-copy";
    const title = document.createElement("strong");
    title.title = capability.name;
    title.textContent = capability.name;
    const subtitle = document.createElement("small");
    subtitle.textContent = "Skill";
    copy.append(title, subtitle);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${capability.name}`);
    remove.title = `Remove ${capability.name}`;
    remove.innerHTML = "<span aria-hidden='true'>×</span>";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeCapability(capability);
    });

    badge.append(icon, copy, remove);
    return badge;
  }

  function removeAttachmentBeforeCaret() {
    const node = deps.removableBadgeBeforeCaret("attachmentId");
    const attachmentId = node?.dataset.attachmentId;
    if (!attachmentId) {
      return false;
    }

    const parent = node.parentNode;
    const offset = parent ? Array.prototype.indexOf.call(parent.childNodes, node) : 0;
    removeAttachment(attachmentId);
    deps.restoreComposerCaret(parent, offset);
    return true;
  }

  function removeCapabilityBeforeCaret() {
    const node = deps.removableBadgeBeforeCaret("capabilityId");
    const capabilityId = node?.dataset?.capabilityId;
    const capabilityKind = node?.dataset?.capabilityKind as CapabilityKind | undefined;
    if (!capabilityId || capabilityKind !== "skill") {
      return false;
    }

    const capabilityKey = capabilityBadgeKey({
      id: capabilityId,
      kind: capabilityKind,
      instanceId: node.dataset.capabilityInstanceId,
    });
    const capability = composerCapabilityMapRef.current.get(capabilityKey);
    const parent = node.parentNode;
    const offset = parent ? Array.prototype.indexOf.call(parent.childNodes, node) : 0;
    removeBadgeNode(node);
    composerCapabilityMapRef.current.delete(capabilityKey);
    deps.restoreComposerCaret(parent, offset);
    syncComposerState();
    if (capability?.kind === "skill" && !deps.hasComposerCapability(capability)) {
      const capabilityUpdate = setSessionSkill(capability.id, false);
      deps.trackPendingCapabilitySync(capabilityUpdate);
      void capabilityUpdate.catch((error) => {
        setComposerError(error instanceof Error ? error.message : String(error));
      });
    }
    return true;
  }

  function removeCapability(capability: ComposerCapability) {
    const badgeId = capabilityBadgeKey(capability);
    const node = composerEditorRef.current?.querySelector(capabilitySelector(capability));
    removeBadgeNode(node ?? null);
    composerCapabilityMapRef.current.delete(badgeId);
    syncComposerState();
    if (deps.hasComposerCapability(capability)) {
      return;
    }
    if (capability.kind === "skill") {
      const capabilityUpdate = setSessionSkill(capability.id, false);
      deps.trackPendingCapabilitySync(capabilityUpdate);
      void capabilityUpdate.catch((error) => {
        setComposerError(error instanceof Error ? error.message : String(error));
      });
    }
  }

  return { applyArgumentCompletion, createAttachmentBadgeNode, createCapabilityBadgeNode, insertAttachmentsAtCursor, insertBuiltinCommandAtCursor, insertCapabilityAtCursor, insertCommandAtCursor, insertPackageCommandIntoComposer, rememberComposerSelection, rememberComposerSelectionFromPoint, removeAttachmentBeforeCaret, removeCapability, removeCapabilityBeforeCaret, selectSlashItem };
}
