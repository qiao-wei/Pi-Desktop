/**
 * 编辑器徽标节点.
 *
 * 把附件/能力徽标构造成 DOM 节点的两个构造器（编辑框与 composer 共用同一套样式）。
 *
 * 从 `src/features/chat/MessageEditBox.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import type { ChatAttachment } from "../../types";
import { applyAttachmentBadgeAttributes, applyCapabilityBadgeAttributes } from "./badgeClipboard";
import type { EditorCapability } from "./editorParts";

function createAttachmentBadgeNode(
  attachment: ChatAttachment,
  onRemove: (id: string) => void,
  /** 目录徽标的副标题。模块级函数拿不到 `t`，所以由组件侧传进来。 */
  folderLabel: string,
) {
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
    // 这个编辑框的徽标是字母凸排（文件是 "F"），目录用路径分隔符；真正的文件夹图标
    // 在主编输入框和气泡里。
    icon.textContent = attachment.kind === "directory" ? "/" : "F";
    badge.appendChild(icon);
  }

  const copy = document.createElement("span");
  copy.className = "attachment-badge-copy";
  const title = document.createElement("strong");
  title.title = attachment.name;
  title.textContent = attachment.name;
  const size = document.createElement("small");
  size.textContent = attachment.kind === "directory" ? folderLabel : formatFileSize(attachment.size);
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

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export { createAttachmentBadgeNode, createCapabilityBadgeNode, formatFileSize };
