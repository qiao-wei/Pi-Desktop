/**
 * App 里零散的自包含小件.
 *
 * 提示词部件转换、扩展状态条、能力选择器、粘贴图片改名与几个判定小函数。
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import { t } from "../i18n/index.ts";
import type { ExtensionUiRequest, PromptMessagePartInput } from "../lib/api";
import { stripTerminalSequences } from "../shared/terminalText.ts";
import type { CapabilitySkill } from "../types";
import { ComposerAttachment } from "./AttachmentHoverCard";

type ComposerCapability = Pick<CapabilitySkill, "id" | "kind" | "name" | "description"> & {
  active?: boolean;
  instanceId?: string;
};

type ComposerPart =
  | { kind: "text"; text: string }
  | { kind: "attachment"; attachment: ComposerAttachment }
  | { kind: "capability"; capability: ComposerCapability };

/** 扩展状态列表（`ctx.ui.setStatus`）：渲染在模型选择左边的浮动层里。 */
function ExtensionStatusBar({ status }: { status: Record<string, string> }) {
  return (
    <section className="extension-status-popover" role="dialog" aria-label={t("extensionStatus.title")}>
      <p className="extension-status-title">{t("extensionStatus.title")}</p>
      {Object.entries(status).map(([key, value]) => (
        <div className="extension-status-row" key={key} title={key}>
          {stripTerminalSequences(value)}
        </div>
      ))}
    </section>
  );
}

function capabilitySelector(capability: Pick<ComposerCapability, "kind" | "id" | "instanceId">) {
  const base = `[data-capability-id="${escapeCssIdent(capability.id)}"][data-capability-kind="${capability.kind}"]`;
  return capability.instanceId
    ? `${base}[data-capability-instance-id="${escapeCssIdent(capability.instanceId)}"]`
    : base;
}

function escapeCssIdent(value: string) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function isCustomExtensionUiRequest(
  request: ExtensionUiRequest,
): request is Extract<ExtensionUiRequest, { method: "custom" }> {
  return request.method === "custom";
}

function isDialogExtensionUiRequest(
  request: ExtensionUiRequest,
): request is Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }> {
  return request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor";
}

function isWebExtensionUiRequest(
  request: ExtensionUiRequest,
): request is Extract<ExtensionUiRequest, { method: "web" }> {
  return request.method === "web";
}

function normalizePercent(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return null;
  }

  return Math.max(0, Math.min(100, value));
}

function renamePastedImage(file: File, index: number) {
  const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1] || "png";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File([file], `Screenshot-${timestamp}${index ? `-${index + 1}` : ""}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

function toPromptMessageParts(
  parts: ComposerPart[],
): PromptMessagePartInput[] {
  return parts
    .map((part): PromptMessagePartInput | null => {
      if (part.kind === "text") {
        return part.text ? { kind: "text", text: part.text } : null;
      }
      if (part.kind === "capability") {
        return { kind: "capability", capability: part.capability };
      }
      return { kind: "attachment", attachmentId: part.attachment.id };
    })
    .filter((part): part is PromptMessagePartInput => Boolean(part));
}

export { ExtensionStatusBar, capabilitySelector, escapeCssIdent, isCustomExtensionUiRequest, isDialogExtensionUiRequest, isWebExtensionUiRequest, normalizePercent, renamePastedImage, toPromptMessageParts, maxAttachmentCount, maxAttachmentSize, maxAttachmentTotalSize, composerCaretMarker, capabilityBadgeKey, createCapabilityInstanceId, isComposerEmpty, createAttachmentId, clampPanelWidth };
export type { ComposerCapability, ComposerPart };

const maxAttachmentCount = 10;

const maxAttachmentSize = 25 * 1024 * 1024;

const maxAttachmentTotalSize = 50 * 1024 * 1024;

const composerCaretMarker = "\u200b";

function capabilityBadgeKey(capability: Pick<ComposerCapability, "kind" | "id" | "instanceId">) {
  return `${capability.kind}:${capability.id}:${capability.instanceId ?? ""}`;
}

function createCapabilityInstanceId() {
  return `capability-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isComposerEmpty(editor: HTMLElement) {
  return !editor.querySelector("[data-attachment-id], [data-capability-id]")
    && (editor.textContent ?? "").replaceAll(composerCaretMarker, "").trim().length === 0;
}

function createAttachmentId() {
  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function clampPanelWidth(width: number, side: "left" | "right") {
  const minimum = side === "left" ? 220 : 260;
  const maximum = side === "left" ? 420 : 420;
  return Math.round(Math.max(minimum, Math.min(maximum, width)));
}
