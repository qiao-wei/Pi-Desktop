/**
 * Inline editor for a user message (edit + resend).
 *
 * It is deliberately the same surface as the composer: a contentEditable with
 * inline attachment/skill badges, a `/` skill menu, file picking, drag & drop
 * and paste (images + sanitised rich text). Model / thinking controls are
 * intentionally absent - editing may not change the run configuration.
 *
 * The component is self-contained (it owns the contentEditable DOM, the badge
 * maps and the selection range) and reports a ready-to-send payload; the caller
 * owns the server round-trip.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Plus } from "lucide-react";

import { useT } from "../../i18n/react";
import type { CapabilitiesState, ChatAttachment, ChatMessagePart } from "../../types";
import type { PromptAttachmentInput, PromptMessagePartInput } from "../../lib/api";
import { htmlToSanitizedMarkup, escapeHtml } from "./pasteSanitize";
import {
  applyAttachmentBadgeAttributes,
  applyCapabilityBadgeAttributes,
  replacePasteBadgePlaceholders,
  type ClipboardBadge,
} from "./badgeClipboard";
import {
  buildSlashMenuItems,
  findSlashStart,
  matchSlashTrigger,
  moveHighlight,
  readTriggerText,
  type SlashMenuItem,
} from "./slashMenu";
import {
  CARET_MARKER,
  capabilityKey,
  editorAttachments,
  editorText,
  readEditorParts,
  toAttachmentInputs,
  toPromptMessageParts,
  type EditorCapability,
  type EditorPart,
} from "./editorParts";
import { badgeBeforeCaret, isMarkerOnlyTextNode, stepOverCaretMarker } from "./caretMarkerStep";

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_SIZE = 50 * 1024 * 1024;

export interface MessageEditPayload {
  text: string;
  messageParts: PromptMessagePartInput[];
  attachments: PromptAttachmentInput[];
}

export interface MessageEditBoxProps {
  messageId: string;
  parts: ChatMessagePart[];
  attachments: ChatAttachment[];
  fallbackText: string;
  capabilities: Pick<CapabilitiesState, "skills" | "packages">;
  canSubmit: boolean;
  submitting?: boolean;
  /**
   * Seed text for a reopened editor (a send that failed). The attachments and
   * skill badges still come from the message itself.
   */
  draftText?: string;
  onCancel: () => void;
  onSubmit: (messageId: string, payload: MessageEditPayload) => Promise<boolean>;
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function createAttachmentId() {
  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createCapabilityInstanceId() {
  return `capability-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function renamePastedImage(file: File, index: number) {
  const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1] || "png";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File([file], `Screenshot-${timestamp}${index ? `-${index + 1}` : ""}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

function hasDraggedFiles(event: { dataTransfer: DataTransfer }) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function escapeCssIdent(value: string) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function createAttachmentBadgeNode(attachment: ChatAttachment, onRemove: (id: string) => void) {
  const badge = document.createElement("span");
  badge.className = `attachment-badge ${attachment.kind}`;
  badge.dataset.attachmentId = attachment.id;
  applyAttachmentBadgeAttributes(badge, attachment);
  badge.contentEditable = "false";

  if (attachment.kind === "image" && attachment.previewUrl) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = attachment.previewUrl;
    badge.appendChild(image);
  } else {
    const icon = document.createElement("span");
    icon.className = "attachment-badge-icon";
    icon.textContent = "F";
    badge.appendChild(icon);
  }

  const copy = document.createElement("span");
  copy.className = "attachment-badge-copy";
  const title = document.createElement("strong");
  title.title = attachment.name;
  title.textContent = attachment.name;
  const size = document.createElement("small");
  size.textContent = formatFileSize(attachment.size);
  copy.append(title, size);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${attachment.name}`);
  remove.title = `Remove ${attachment.name}`;
  remove.innerHTML = "<span aria-hidden='true'>×</span>";
  remove.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onRemove(attachment.id);
  });

  badge.append(copy, remove);
  return badge;
}

function createCapabilityBadgeNode(capability: EditorCapability, onRemove: (capability: EditorCapability) => void) {
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
    onRemove(capability);
  });

  badge.append(icon, copy, remove);
  return badge;
}

export function MessageEditBox({
  messageId,
  parts,
  attachments,
  fallbackText,
  capabilities,
  canSubmit,
  submitting = false,
  draftText,
  onCancel,
  onSubmit,
}: MessageEditBoxProps) {
  const t = useT();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rangeRef = useRef<Range | null>(null);
  const initializedRef = useRef(false);
  const dragDepthRef = useRef(0);

  const attachmentByIdRef = useRef(new Map<string, ChatAttachment>());
  const fileByIdRef = useRef(new Map<string, File>());
  const capabilityByKeyRef = useRef(new Map<string, EditorCapability>());

  const [text, setText] = useState("");
  const [attachmentCount, setAttachmentCount] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menuQuery, setMenuQuery] = useState<string | null>(null);
  const [menuHighlight, setMenuHighlight] = useState(0);

  const skillItems = useMemo(
    () =>
      menuQuery == null
        ? []
        : buildSlashMenuItems(capabilities, menuQuery).filter(
            (item): item is Extract<SlashMenuItem, { kind: "skill" }> => item.kind === "skill",
          ),
    [capabilities, menuQuery],
  );
  const activeIndex = Math.min(menuHighlight, Math.max(0, skillItems.length - 1));

  const syncState = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const next = readEditorParts(editor, attachmentByIdRef.current, capabilityByKeyRef.current);
    setText(editorText(next));
    setAttachmentCount(editorAttachments(next).length);
  }, []);

  const focusEditor = useCallback(() => {
    editorRef.current?.focus({ preventScroll: true });
  }, []);

  const caretRange = useCallback((): Range => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    const saved = rangeRef.current;
    if (saved && editor && editor.contains(saved.startContainer) && editor.contains(saved.endContainer)) {
      return saved.cloneRange();
    }
    const range = document.createRange();
    if (!editor) {
      return range;
    }
    range.selectNodeContents(editor);
    range.collapse(false);
    return range;
  }, []);

  const insertAtCursor = useCallback((node: Node) => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const range = caretRange();
    editor.focus({ preventScroll: true });
    range.deleteContents();
    const marker = document.createTextNode(CARET_MARKER);
    range.insertNode(node);
    node.parentNode?.insertBefore(marker, node.nextSibling);
    const nextRange = document.createRange();
    nextRange.setStart(marker, marker.textContent?.length ?? 0);
    nextRange.collapse(true);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(nextRange);
    }
    rangeRef.current = nextRange.cloneRange();
    syncState();
  }, [caretRange, syncState]);

  // Seed the DOM from the message once; afterwards the DOM is the source of truth.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    const seededParts: EditorPart[] = parts.length
      ? parts.flatMap((part): EditorPart[] => {
          if (part.kind === "text") {
            return part.text ? [{ kind: "text", text: part.text }] : [];
          }
          if (part.kind === "capability") {
            const capability: EditorCapability = {
              id: part.capability.id,
              kind: "skill",
              name: part.capability.name,
              description: part.capability.description,
              active: part.capability.active,
              instanceId: createCapabilityInstanceId(),
            };
            return [{ kind: "capability", capability }];
          }
          const attachment = attachments.find((candidate) => candidate.id === part.attachmentId);
          return attachment ? [{ kind: "attachment", attachment }] : [];
        })
      : fallbackText
        ? [{ kind: "text", text: fallbackText }]
        : [];

    // A reopened editor after a failed send keeps what the user typed; badges and
    // attachments still come from the message.
    const initialParts: EditorPart[] = draftText == null
      ? seededParts
      : [{ kind: "text", text: draftText }, ...seededParts.filter((part) => part.kind !== "text")];

    const fragment = document.createDocumentFragment();
    for (const part of initialParts) {
      if (part.kind === "text") {
        fragment.appendChild(document.createTextNode(part.text));
        continue;
      }
      if (part.kind === "attachment") {
        attachmentByIdRef.current.set(part.attachment.id, part.attachment);
        fragment.appendChild(createAttachmentBadgeNode(part.attachment, removeAttachment));
        fragment.appendChild(document.createTextNode(CARET_MARKER));
        continue;
      }
      capabilityByKeyRef.current.set(capabilityKey(part.capability.id, part.capability.instanceId), part.capability);
      fragment.appendChild(createCapabilityBadgeNode(part.capability, removeCapability));
      fragment.appendChild(document.createTextNode(CARET_MARKER));
    }
    editor.appendChild(fragment);
    setText(editorText(initialParts));
    setAttachmentCount(editorAttachments(initialParts).length);
    // 进入编辑态就聚焦，光标落在文字末尾，直接可以改。
    const endRange = document.createRange();
    endRange.selectNodeContents(editor);
    endRange.collapse(false);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(endRange);
      rangeRef.current = endRange.cloneRange();
    }
    focusEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments, draftText, fallbackText, parts]);

  // Track the caret while it is inside this editor.
  useEffect(() => {
    function handleSelectionChange() {
      const editor = editorRef.current;
      const selection = window.getSelection();
      if (!editor || !selection || !selection.rangeCount) {
        return;
      }
      const range = selection.getRangeAt(0);
      if (editor.contains(range.startContainer) && editor.contains(range.endContainer)) {
        rangeRef.current = range.cloneRange();
      }
    }
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  function attachmentMap() {
    return attachmentByIdRef.current;
  }

  function removeAttachment(id: string) {
    attachmentByIdRef.current.delete(id);
    fileByIdRef.current.delete(id);
    const node = editorRef.current?.querySelector(`[data-attachment-id="${escapeCssIdent(id)}"]`);
    if (node) {
      const nextSibling = node.nextSibling;
      node.parentNode?.removeChild(node);
      if (nextSibling && isMarkerOnlyTextNode(nextSibling, CARET_MARKER)) {
        nextSibling.parentNode?.removeChild(nextSibling);
      }
    }
    syncState();
  }

  function removeCapability(capability: EditorCapability) {
    capabilityByKeyRef.current.delete(capabilityKey(capability.id, capability.instanceId));
    const selector = `[data-capability-id="${escapeCssIdent(capability.id)}"][data-capability-instance-id="${escapeCssIdent(capability.instanceId ?? "")}"]`;
    const node = editorRef.current?.querySelector(selector);
    if (node) {
      const nextSibling = node.nextSibling;
      node.parentNode?.removeChild(node);
      if (nextSibling && isMarkerOnlyTextNode(nextSibling, CARET_MARKER)) {
        nextSibling.parentNode?.removeChild(nextSibling);
      }
    }
    syncState();
  }

  function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files).filter((file) => file.size > 0);
    if (!incoming.length) {
      return;
    }
    const existing = Array.from(attachmentByIdRef.current.values());
    const availableSlots = Math.max(0, MAX_ATTACHMENT_COUNT - existing.length);
    let totalSize = existing.reduce((total, attachment) => total + attachment.size, 0);
    let errorMessage = "";
    const accepted: Array<{ attachment: ChatAttachment; file: File }> = [];

    for (const file of incoming) {
      if (accepted.length >= availableSlots) {
        errorMessage = t("composer.error.tooManyAttachments", { count: MAX_ATTACHMENT_COUNT });
        break;
      }
      if (file.size > MAX_ATTACHMENT_SIZE) {
        errorMessage = t("composer.error.attachmentTooLarge", {
          name: file.name,
          limit: MAX_ATTACHMENT_SIZE / 1024 / 1024,
        });
        continue;
      }
      if (totalSize + file.size > MAX_ATTACHMENT_TOTAL_SIZE) {
        errorMessage = t("composer.error.attachmentsTooLargeTotal", {
          limit: MAX_ATTACHMENT_TOTAL_SIZE / 1024 / 1024,
        });
        break;
      }
      totalSize += file.size;
      const id = createAttachmentId();
      const isImage = file.type.startsWith("image/");
      accepted.push({
        file,
        attachment: {
          id,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          kind: isImage ? "image" : "file",
          previewUrl: isImage ? URL.createObjectURL(file) : undefined,
        },
      });
    }

    for (const { attachment, file } of accepted) {
      attachmentByIdRef.current.set(attachment.id, attachment);
      fileByIdRef.current.set(attachment.id, file);
      insertAtCursor(createAttachmentBadgeNode(attachment, removeAttachment));
    }
    setError(errorMessage);
  }

  function removeSlashBeforeRange(range: Range) {
    const container = range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE || range.startOffset === 0) {
      return;
    }
    const raw = container.textContent ?? "";
    const slashIndex = findSlashStart(raw.slice(0, range.startOffset));
    if (slashIndex == null) {
      return;
    }
    container.textContent = `${raw.slice(0, slashIndex)}${raw.slice(range.startOffset)}`;
    range.setStart(container, slashIndex);
    range.collapse(true);
  }

  function insertCapability(capability: EditorCapability) {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const range = caretRange();
    editor.focus({ preventScroll: true });
    removeSlashBeforeRange(range);
    capabilityByKeyRef.current.set(capabilityKey(capability.id, capability.instanceId), capability);
    const node = createCapabilityBadgeNode(capability, removeCapability);
    const marker = document.createTextNode(CARET_MARKER);
    range.deleteContents();
    range.insertNode(node);
    node.parentNode?.insertBefore(marker, node.nextSibling);
    const nextRange = document.createRange();
    nextRange.setStart(marker, marker.textContent?.length ?? 0);
    nextRange.collapse(true);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(nextRange);
    }
    rangeRef.current = nextRange.cloneRange();
    setMenuQuery(null);
    syncState();
  }

  function handleInput() {
    syncState();
    const editor = editorRef.current;
    const query = editor ? matchSlashTrigger(readTriggerText(editor)) : null;
    if (query == null) {
      if (menuQuery != null) {
        setMenuQuery(null);
      }
      return;
    }
    setMenuQuery(query);
    setMenuHighlight(0);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (menuQuery != null && skillItems.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMenuHighlight((current) => moveHighlight(current, 1, skillItems.length));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMenuHighlight((current) => moveHighlight(current, -1, skillItems.length));
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const item = skillItems[activeIndex];
        if (item) {
          insertCapability({
            id: item.id,
            kind: "skill",
            name: item.name,
            description: item.description,
            active: true,
            instanceId: createCapabilityInstanceId(),
          });
        }
        return;
      }
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (menuQuery != null) {
        setMenuQuery(null);
      } else {
        onCancel();
      }
      return;
    }

    // 徽标后的零宽标记会让方向键「按一次没反应」：编辑框与 composer 共用同一套
    // 跨标记逻辑，只在光标真的停在标记上时接管（说明见 caretMarkerStep.ts）。
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.nativeEvent.isComposing
    ) {
      const next = stepOverCaretMarker(
        editorRef.current,
        window.getSelection(),
        event.key === "ArrowLeft" ? -1 : 1,
        CARET_MARKER,
      );
      if (next) {
        rangeRef.current = next.cloneRange();
        event.preventDefault();
        return;
      }
    }

    // 和方向键共用同一套「徽标右侧边界」识别：Backspace 一次就删掉整个徽标（含它的
    // 零宽标记），而不是先删掉那个看不见的空白再删徽标。
    if (
      event.key === "Backspace" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.nativeEvent.isComposing
    ) {
      const selection = window.getSelection();
      if (selection?.rangeCount && selection.isCollapsed) {
        const range = selection.getRangeAt(0);
        const badge = badgeBeforeCaret(range.startContainer, range.startOffset, CARET_MARKER);
        const attachmentId = badge?.dataset?.attachmentId;
        const capabilityId = badge?.dataset?.capabilityId;
        if (attachmentId) {
          event.preventDefault();
          removeAttachment(attachmentId);
          return;
        }
        if (capabilityId) {
          const capability = capabilityByKeyRef.current.get(
            capabilityKey(capabilityId, badge.dataset.capabilityInstanceId ?? ""),
          );
          if (capability) {
            event.preventDefault();
            removeCapability(capability);
            return;
          }
        }
      }
    }

    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleSubmit();
    }
  }

  /** 从剪贴板描述还原一个徽标；消息里已有的附件复用它的 File。 */
  function createPastedBadge(badge: ClipboardBadge): Node | null {
    if (badge.kind === "capability") {
      const capability: EditorCapability = {
        id: badge.capability.id,
        kind: "skill",
        name: badge.capability.name,
        description: badge.capability.description,
        active: true,
        instanceId: createCapabilityInstanceId(),
      };
      capabilityByKeyRef.current.set(capabilityKey(capability.id, capability.instanceId), capability);
      return createCapabilityBadgeNode(capability, removeCapability);
    }

    const existing = attachmentByIdRef.current.get(badge.attachment.id);
    if (!existing && attachmentByIdRef.current.size >= MAX_ATTACHMENT_COUNT) {
      setError(t("composer.error.tooManyAttachments", { count: MAX_ATTACHMENT_COUNT }));
      return null;
    }
    const source = existing ?? badge.attachment;
    const attachment: ChatAttachment = { ...source, id: createAttachmentId() };
    attachmentByIdRef.current.set(attachment.id, attachment);
    const file = existing ? fileByIdRef.current.get(existing.id) : undefined;
    if (file) {
      fileByIdRef.current.set(attachment.id, file);
    }
    return createAttachmentBadgeNode(attachment, removeAttachment);
  }

  function insertPastedMarkup(markup: string, badges: ClipboardBadge[] = []) {
    const editor = editorRef.current;
    if (!editor || !markup) {
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = markup;
    const fragment = template.content;
    replacePasteBadgePlaceholders(fragment, badges, createPastedBadge, CARET_MARKER);
    const range = caretRange();
    editor.focus({ preventScroll: true });
    range.deleteContents();
    const lastNode = fragment.lastChild;
    range.insertNode(fragment);
    const nextRange = document.createRange();
    if (lastNode) {
      nextRange.setStartAfter(lastNode);
    } else {
      nextRange.selectNodeContents(editor);
      nextRange.collapse(false);
    }
    nextRange.collapse(true);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(nextRange);
    }
    rangeRef.current = nextRange.cloneRange();
    syncState();
  }

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const clipboard = event.clipboardData;
    const images = Array.from(clipboard.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (images.length) {
      event.preventDefault();
      addFiles(images.map((file, index) => renamePastedImage(file, index)));
      return;
    }

    const html = clipboard.getData("text/html");
    const plain = clipboard.getData("text/plain");
    if (!html && !plain) {
      return;
    }
    event.preventDefault();
    const badges: ClipboardBadge[] = [];
    if (html) {
      const parsed = new DOMParser().parseFromString(html, "text/html").body;
      insertPastedMarkup(htmlToSanitizedMarkup(parsed, { badges }), badges);
    } else {
      insertPastedMarkup(escapeHtml(plain).replaceAll("\n", "<br>"), badges);
    }
  }

  async function handleSubmit() {
    if (busy || submitting) {
      return;
    }
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const partsNow = readEditorParts(editor, attachmentByIdRef.current, capabilityByKeyRef.current);
    const nextText = editorText(partsNow);
    const attachmentList = editorAttachments(partsNow);
    if (!nextText.trim() && !attachmentList.length) {
      return;
    }
    setError("");
    setBusy(true);
    try {
      const attachmentInputs = await toAttachmentInputs(attachmentList, (attachment) => fileByIdRef.current.get(attachment.id));
      const accepted = await onSubmit(messageId, {
        text: nextText,
        messageParts: toPromptMessageParts(partsNow),
        attachments: attachmentInputs,
      });
      if (!accepted) {
        setError(t("composer.error.submitFailed"));
      }
    } finally {
      setBusy(false);
    }
  }

  const submitDisabled =
    busy || submitting || !canSubmit || (!text.trim() && attachmentCount === 0);

  return (
    <div
      className="flex px-2"
      data-role="user"
      data-slot="aui_user-edit-composer"
    >
      <div className="ms-auto w-full max-w-[85%]">
        <div
          className={`message-edit-surface composer-surface ${isDragging ? "is-dragging" : ""}`}
          onDragEnter={(event) => {
            if (!hasDraggedFiles(event)) return;
            event.preventDefault();
            dragDepthRef.current += 1;
            setIsDragging(true);
          }}
          onDragOver={(event) => {
            if (!hasDraggedFiles(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            if (!hasDraggedFiles(event)) return;
            event.preventDefault();
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) {
              setIsDragging(false);
            }
          }}
          onDrop={(event) => {
            if (!hasDraggedFiles(event)) return;
            event.preventDefault();
            dragDepthRef.current = 0;
            setIsDragging(false);
            addFiles(event.dataTransfer.files);
          }}
        >
          <input
            ref={fileInputRef}
            className="composer-file-input"
            type="file"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              if (event.target.files) {
                addFiles(event.target.files);
              }
              event.target.value = "";
            }}
          />
          <div
            ref={editorRef}
            className="composer-editor message-edit-editor"
            contentEditable
            role="textbox"
            aria-multiline="true"
            aria-label={t("message.editAria")}
            data-placeholder={t("message.editPlaceholder")}
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
          <div className="message-edit-footer flex items-center justify-between gap-2">
            <button
              className="composer-tool-button"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label={t("composer.addFiles")}
              title={t("composer.addFiles")}
            >
              <Plus size={19} />
            </button>
            <div className="flex items-center gap-2">
              <button
                className="message-edit-cancel rounded-full border px-3.5 py-1 text-sm"
                type="button"
                onClick={onCancel}
              >
                {t("message.editCancel")}
              </button>
              <button
                className="message-edit-save rounded-full bg-primary px-3.5 py-1 text-sm text-primary-foreground disabled:opacity-50"
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitDisabled}
              >
                {busy || submitting ? t("message.editSending") : t("message.editSend")}
              </button>
            </div>
          </div>

          {menuQuery != null && skillItems.length ? (
            <div className="capability-picker slash-menu" role="listbox" aria-label={t("message.editSkills")}>
              <div className="slash-menu-section">
                <p className="slash-menu-section-label">{t("capability.slashMenu.skills", { count: skillItems.length })}</p>
                {skillItems.map((item, index) => (
                  <button
                    key={`${item.id}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    onClick={() =>
                      insertCapability({
                        id: item.id,
                        kind: "skill",
                        name: item.name,
                        description: item.description,
                        active: true,
                        instanceId: createCapabilityInstanceId(),
                      })
                    }
                    onMouseEnter={() => setMenuHighlight(index)}
                    className={`capability-picker-row ${index === activeIndex ? "is-active" : ""}`}
                  >
                    <span className="capability-dot skill">S</span>
                    <span className="slash-menu-row-text">
                      <strong>{item.name}</strong>
                      {item.description ? <small>{item.description}</small> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        {error ? <p className="message-edit-error mt-1 text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}