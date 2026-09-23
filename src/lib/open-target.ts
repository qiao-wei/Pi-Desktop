import { invoke } from "@tauri-apps/api/core";

const supportedLinkProtocol = /^(https?:|mailto:)/i;
const absoluteFilePath = /^(?:\/|[a-z]:[\\/]|\\\\)/i;

export function canOpenTarget(target: string | undefined): target is string {
  if (!target) {
    return false;
  }

  return supportedLinkProtocol.test(target) || absoluteFilePath.test(target);
}

export async function openTarget(target: string) {
  if (!canOpenTarget(target)) {
    throw new Error("Only local files and http, https, or mailto links can be opened.");
  }

  if ("__TAURI_INTERNALS__" in window) {
    await invoke("open_target", { target });
    return;
  }

  window.open(target, "_blank", "noopener,noreferrer");
}
