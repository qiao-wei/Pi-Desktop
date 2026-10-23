/**
 * 附件悬停卡.
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import { t } from "../i18n/index.ts";
import type { PromptAttachmentInput } from "../lib/api";
import type { ChatAttachment } from "../types";
import { formatFileSize } from "./CapabilitiesPage";
import { FileText, Folder } from "lucide-react";

function AttachmentHoverCard({ hover }: { hover: AttachmentHoverState }) {
  const { attachment, rect } = hover;
  const isImage = attachment.kind === "image";
  const isDirectory = attachment.kind === "directory";
  const cardWidth = 300;
  const cardHeight = isImage ? 260 : 110;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - cardWidth - 12));
  const canPlaceAbove = rect.top - cardHeight - 18 >= 12;
  const top = canPlaceAbove
    ? rect.top - 10
    : Math.min(window.innerHeight - cardHeight - 12, rect.bottom + 10);

  return (
    <aside
      className={`attachment-hover-card ${isImage ? "is-image" : "is-file"} ${canPlaceAbove ? "place-above" : "place-below"}`}
      style={{ left, top, width: cardWidth }}
      role="tooltip"
    >
      {isImage && attachment.previewUrl ? (
        <img src={attachment.previewUrl} alt={attachment.name} />
      ) : (
        <span className="attachment-hover-file-icon">
          {isDirectory ? <Folder size={18} /> : <FileText size={18} />}
        </span>
      )}
      <div className="attachment-hover-copy">
        <strong>{attachment.name}</strong>
        {/* 目录的"内容"就是它自己那条绝对路径：不复制成字节，回放时读的也是它。 */}
        <span>{attachment.sourcePath || attachment.name}</span>
        <small>
          {isDirectory
            ? t("composer.attachment.folder")
            : `${attachment.mimeType} · ${formatFileSize(attachment.size)}`}
        </small>
      </div>
    </aside>
  );
}

interface AttachmentHoverState {
  attachment: ChatAttachment;
  rect: DOMRect;
}

/**
 * 界面配色主题。与浅色/深色正交：每个主题都有两套完整 token（`src/themes/<id>/theme.css`），
 * 标题栏的太阳/月亮按钮仍然管明暗。
 *
 * 选项**不在这里列举**：主题清单由 `src/themes/` 的目录自动发现（见 `themes/index.ts`），
 * 招牌文案也跟着主题目录走（`themes/<id>/meta.ts`）。新增主题不需要改这个文件。
 */

interface ComposerAttachment extends ChatAttachment {
  /** Absent for badges pasted from a sent message; the server reuses `sourcePath`. */
  file?: File;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolvePromise(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => rejectPromise(reader.error ?? new Error(`Unable to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function readAttachment(attachment: ComposerAttachment): Promise<PromptAttachmentInput> {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    // Pasting a badge from a sent message keeps only its `sourcePath`; the server
    // reuses the bytes already on disk, same as editing a message does.
    data: attachment.file ? await fileToBase64(attachment.file) : "",
    previewUrl: attachment.previewUrl,
    sourcePath: attachment.sourcePath,
  };
}

export { AttachmentHoverCard, fileToBase64, readAttachment };
export type { AttachmentHoverState, ComposerAttachment };
