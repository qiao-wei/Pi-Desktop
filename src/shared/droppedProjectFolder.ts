/**
 * Dropping a folder onto the sidebar opens the "New project" dialog.
 *
 * A drop only yields two useful facts — the entry's name and, when the host can
 * tell us, its absolute path. Only Electron can do the second one (its preload
 * resolves the path via `webUtils.getPathForFile`, which the sandboxed renderer
 * cannot reach by itself). Every other host — browser, and Tauri, which keeps
 * its native drop interception off so the composer's HTML5 drops work — would
 * only get a name and would need the user to pick the folder again, so the
 * sidebar simply does not register the drop here at all.
 *
 * This module holds the pure half of that: given the facts the host did manage
 * to collect, decide whether the drop is a folder at all and which folder wins.
 * `isDirectory` is `undefined` when the platform did not say (no
 * `webkitGetAsEntry`, or it threw), which is treated as "probably a folder"
 * rather than silently ignoring the user's action.
 *
 * The composer reads the same facts through {@link collectDroppedItems} but
 * decides differently (see `composerDrop.ts`): there a folder is only useful
 * when the host could resolve its absolute path, and files still travel as
 * bytes through the `File` handle carried on the facts.
 */

export interface DroppedItemFacts {
  name: string;
  path?: string;
  /** `undefined` means "the platform did not tell us", not "it is a file". */
  isDirectory?: boolean;
  /** The dropped `File`, for the hosts that hand one over. A folder's is zero-length. */
  file?: File;
}

export interface DroppedProjectFolder {
  name: string;
  path?: string;
}

/**
 * The folder a drop should open the New project dialog with, or `undefined` when
 * the drop was clearly made of files.
 */
export function pickDroppedProjectFolder(
  items: readonly DroppedItemFacts[],
): DroppedProjectFolder | undefined {
  const usable = items.filter((item) => Boolean(item.name?.trim()) || Boolean(item.path?.trim()));
  if (!usable.length) {
    return undefined;
  }

  // A multiple selection can mix files and folders; the folder is what the user means.
  const knownFolder = usable.find((item) => item.isDirectory === true);
  if (knownFolder) {
    return toFolder(knownFolder);
  }

  // Nothing announced its kind (engines without webkitGetAsEntry): trust the drop
  // instead of refusing a folder the user clearly dragged.
  const unknownKind = usable.find((item) => item.isDirectory === undefined);
  if (unknownKind) {
    return toFolder(unknownKind);
  }

  // Every entry was known to be a file: a sidebar drop is not "create a project".
  return undefined;
}

/** Bridge the Electron preload exposes for turning a dropped `File` into a path. */
export interface DesktopFilePathBridge {
  pathForFile?: (file: File) => string;
}

/**
 * Whether this host can turn a dropped folder into an absolute path. Only true
 * where the Electron preload installed `__PI_DESKTOP_FILES__`; false in the
 * browser and in Tauri, which do not register the sidebar drop at all.
 */
export function supportsDroppedFolderPaths(bridge: DesktopFilePathBridge | undefined): boolean {
  return typeof bridge?.pathForFile === "function";
}

/**
 * Absolute path of a dropped `File` when the host can provide one. Guessing is
 * not an option here — a path that looks absolute but points elsewhere is worse
 * than an empty folder field — so every failure (no bridge, non-File input, a
 * JS-constructed File) degrades to `undefined`.
 */
export function droppedFilePath(
  file: File,
  bridge: DesktopFilePathBridge | undefined,
): string | undefined {
  if (typeof bridge?.pathForFile !== "function") {
    return undefined;
  }

  try {
    const value = bridge.pathForFile(file);
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function toFolder(item: DroppedItemFacts): DroppedProjectFolder {
  return {
    name: item.name?.trim() ?? "",
    path: item.path?.trim() || undefined,
  };
}

/** Structural slice of `DataTransfer` that the sidebar drop handler reads. */
export interface DroppedDataTransfer {
  items?: ArrayLike<{
    kind: string;
    getAsFile?: () => File | null;
    webkitGetAsEntry?: () => { isDirectory: boolean; name: string } | null;
  }>;
  files?: ArrayLike<File>;
}

/**
 * Read one drop into the facts {@link pickDroppedProjectFolder} decides on.
 *
 * A dropped folder is a zero-length `File`, and the Entries API is readable only
 * while the drop handler is still running, so both reads happen here. The name
 * falls back entry → `getAsFile()` → `dataTransfer.files`, and Electron's path
 * is tried on both Files: macOS volume security has been known to leave one of
 * the two empty while the other resolves.
 */
export function collectDroppedItems(
  dataTransfer: DroppedDataTransfer,
  bridge: DesktopFilePathBridge | undefined,
): DroppedItemFacts[] {
  const items = dataTransfer.items;
  const files = dataTransfer.files;
  const fileAt = (index: number) => (files && index < files.length ? files[index] : undefined);
  const facts: DroppedItemFacts[] = [];

  if (items) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item || item.kind !== "file") {
        continue;
      }

      const file = item.getAsFile?.() ?? undefined;
      const fallbackFile = fileAt(index);

      let isDirectory: boolean | undefined;
      let entryName = "";
      try {
        const entry = item.webkitGetAsEntry?.() ?? null;
        if (entry) {
          isDirectory = entry.isDirectory;
          entryName = entry.name;
        }
      } catch {
        // Entries API unavailable or refused the item: leave the kind unknown.
        isDirectory = undefined;
      }

      const name = entryName || file?.name || fallbackFile?.name || "";
      const path =
        (file ? droppedFilePath(file, bridge) : undefined) ??
        (fallbackFile ? droppedFilePath(fallbackFile, bridge) : undefined);

      if (!name && !path) {
        continue;
      }
      facts.push({ name, path, isDirectory, file: file ?? fallbackFile });
    }
  }

  if (!facts.length && files) {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (file) {
        facts.push({ name: file.name, path: droppedFilePath(file, bridge), file });
      }
    }
  }

  return facts;
}