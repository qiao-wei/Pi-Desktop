/**
 * How one drop onto a composer lands.
 *
 * Files keep the byte channel: the `File` goes into an attachment and the client
 * base64s it on submit. Folders never do — reading a folder as bytes is what
 * produced the raw `FileReader` failure ("A requested file or directory could
 * not be found at the time an operation was processed"), and copying a folder
 * into the session's attachment directory would be both pointless and huge.
 *
 * So a folder is only actionable where the host can hand over its absolute path
 * (the Electron preload's `webUtils.getPathForFile`); it becomes a *reference*
 * attachment the model receives as a live path. Everywhere else — Tauri and the
 * browser see folder entries but cannot resolve a path — the right answer is to
 * refuse it loudly, because silently dropping the user's drag looks like a
 * broken composer.
 *
 * Pure on purpose: the drop facts are read synchronously by the caller (the
 * Entries API only lives for the duration of the drop event) and decided here.
 */
import type { DroppedItemFacts, DroppedProjectFolder } from "./droppedProjectFolder.ts";

export interface ComposerDropPlan {
  /** Folders with a usable absolute path: attach as directory references. */
  folders: DroppedProjectFolder[];
  /** Folders the host could not locate: refused, and named back to the user. */
  refusedFolders: string[];
  /** Non-folder entries, in drop order. */
  files: File[];
}

export function planComposerDrop(items: readonly DroppedItemFacts[]): ComposerDropPlan {
  const plan: ComposerDropPlan = { folders: [], refusedFolders: [], files: [] };

  for (const item of items) {
    const name = item.name?.trim() ?? "";
    const path = item.path?.trim() ?? "";

    if (item.isDirectory === true) {
      if (path) {
        plan.folders.push({ name: name || lastPathSegment(path), path });
      } else {
        plan.refusedFolders.push(name || lastPathSegment(path) || "folder");
      }
      continue;
    }

    // `isDirectory === undefined` means the platform did not say. Treating it as a
    // file keeps the pre-existing behaviour; if it really was a folder the submit
    // path now reports an unreadable attachment instead of a raw DOMException.
    if (item.file) {
      plan.files.push(item.file);
    }
  }

  return plan;
}

/**
 * Which folders still deserve a badge: the same folder dragged twice is one
 * reference, and the attachment cap still applies. `existingPaths` is every
 * directory already in the composer.
 */
export function pickNewFolderDrops(
  folders: readonly DroppedProjectFolder[],
  existingPaths: Iterable<string>,
  availableSlots: number,
): { folders: DroppedProjectFolder[]; overflow: boolean } {
  const seen = new Set(existingPaths);
  const picked: DroppedProjectFolder[] = [];

  for (const folder of folders) {
    if (!folder.path || seen.has(folder.path)) {
      continue;
    }
    if (picked.length >= availableSlots) {
      return { folders: picked, overflow: true };
    }
    seen.add(folder.path);
    picked.push(folder);
  }

  return { folders: picked, overflow: false };
}

function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}