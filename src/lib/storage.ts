/**
 * Boundary `storage`, adapter side: the **only** file in `src/` that touches `localStorage`
 * (rule `no-bypass` fails the build otherwise).
 *
 * Everything that persists something goes through `getStoragePort()`. Two reasons it is worth the
 * indirection:
 * - the port can be swapped at startup (`setStoragePort`), and `tests/storagePort.test.ts` runs
 *   the real callers against an in-memory store - no DOM needed;
 * - the schema version is checked once, at startup, so a store written by a newer build is refused
 *   loudly instead of being half-read (see `src/shared/protocol/storage.ts`).
 *
 * Default behaviour with no injection: `window.localStorage` when there is a window, otherwise an
 * in-memory store. That keeps `node --test` and any DOM-less caller working, and means the app does
 * not depend on `installStoragePort()` being called to function.
 */

import {
  STORAGE_SCHEMA_VERSION,
  checkStorageVersion,
  migrateStorage,
  storageMismatchMessage,
  type KeyValueStorePort,
  type StorageVersionStatus,
} from "../shared/protocol/storage.ts";

function memoryStore(): KeyValueStorePort {
  const values = new Map<string, string>();
  return {
    read: (key) => values.get(key) ?? null,
    write: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}

function browserStore(): KeyValueStorePort | null {
  if (typeof window === "undefined") return null;
  const storage = window.localStorage;
  if (!storage) return null;
  return {
    read: (key) => storage.getItem(key),
    write: (key, value) => storage.setItem(key, value),
    remove: (key) => storage.removeItem(key),
  };
}

let port: KeyValueStorePort = browserStore() ?? memoryStore();
let versionStatus: StorageVersionStatus | null = null;

/** The installed store. Never null: falls back to an in-memory store. */
export function getStoragePort(): KeyValueStorePort {
  return port;
}

/**
 * Install a different store (a host's own store plugin, or a test double).
 * `setStoragePort(null)` goes back to the default for the current environment.
 */
export function setStoragePort(next: KeyValueStorePort | null): void {
  port = next ?? browserStore() ?? memoryStore();
  versionStatus = null;
}

/**
 * Check/migrate the store's schema once. Called from the composition root before the first render;
 * safe to call more than once. Returns the status it acted on so startup can log it.
 */
export function installStoragePort(): StorageVersionStatus {
  if (versionStatus) return versionStatus;
  versionStatus = migrateStorage(port);
  return versionStatus;
}

/** Status from the last `installStoragePort()`; `null` until it ran. */
export function getStorageVersionStatus(): StorageVersionStatus | null {
  return versionStatus;
}

/**
 * True when the stored data must not be read: written by a newer build. Callers that load user
 * state check this and fall back to defaults *without writing*, so the data survives an update.
 */
export function isStoreFromNewerBuild(): boolean {
  const status = versionStatus ?? checkStorageVersion(port, STORAGE_SCHEMA_VERSION);
  return status.kind === "ahead";
}

/** Message for the `ahead` case, for a console warning; `null` otherwise. */
export function storageVersionWarning(): string | null {
  const status = versionStatus ?? checkStorageVersion(port, STORAGE_SCHEMA_VERSION);
  return storageMismatchMessage(status);
}