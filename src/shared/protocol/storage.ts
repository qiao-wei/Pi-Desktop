/**
 * Boundary `storage`: the renderer's key-value store, as a replaceable protocol.
 *
 * Why this exists: `localStorage` was used in five places (`ui-preferences`, `persistence`,
 * `perf`, `api`, `main.tsx`) with keys like `pi-desktop.ui.v1` and no schema story at all. Two
 * concrete problems came from that:
 *
 * 1. **No forward-compat guard.** An older build reading a store written by a newer build just
 *    spread unknown fields into its defaults, silently dropping the user's settings. The version
 *    in the key name was decoration, not a check.
 * 2. **No seam.** Anything that wants to persist something had to touch `window.localStorage`
 *    itself, so nothing could be tested without a DOM, and swapping the store (Tauri's store
 *    plugin, a server-side sync, an in-memory test double) meant touching every call site.
 *
 * What the protocol guarantees:
 * - one place touches `localStorage` (`src/lib/storage.ts`), enforced by rule `no-bypass`;
 * - the store announces a schema version, and a store written by a *newer* app is refused rather
 *   than half-read (see `checkStorageVersion`);
 * - migrations are declared in one table (`STORAGE_MIGRATIONS`) and run in order, so a breaking
 *   change is a new entry plus a test, not a hunt through call sites.
 *
 * The migration table is intentionally empty today: there has been no breaking change yet. The
 * runner is covered by tests with synthetic migrations, so the first real one is a one-entry diff.
 */

/** The shape every store implementation must provide. `read` returns null for "not set". */
export interface KeyValueStorePort {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** Where the store's own schema version lives (not a preference; internal bookkeeping). */
export const STORAGE_VERSION_KEY = "pi-desktop.schema";

/**
 * Current schema version of the persisted state. Bump it whenever an existing key changes shape
 * in a way old data cannot satisfy, and add the matching `STORAGE_MIGRATIONS` entry.
 */
export const STORAGE_SCHEMA_VERSION = 1;

export interface StorageMigration {
  /** `from` → `to`; versions are consecutive integers. */
  from: number;
  to: number;
  /** What it changes, for the reader of the table (and for the failure message). */
  why: string;
  run(store: KeyValueStorePort): void;
}

/**
 * Ordered migration table. Empty on purpose - see the module comment. Each entry must be
 * idempotent-safe in the sense that it only runs when the stored version says so.
 */
export const STORAGE_MIGRATIONS: StorageMigration[] = [];

export type StorageVersionStatus =
  | { kind: "ok"; version: number }
  | { kind: "fresh"; version: number }
  | { kind: "behind"; from: number; to: number }
  | { kind: "ahead"; stored: number; supported: number };

/**
 * Compare the stored schema version with the one this build understands.
 *
 * `ahead` is the interesting case: the store was written by a newer app (user downgraded, or an
 * older packaged build ran against the same profile). Reading it would silently drop the fields
 * this build does not know about, so the caller is expected to refuse and keep the data intact.
 */
export function checkStorageVersion(store: KeyValueStorePort, supported = STORAGE_SCHEMA_VERSION): StorageVersionStatus {
  const raw = store.read(STORAGE_VERSION_KEY);
  if (raw === null || raw === "") return { kind: "fresh", version: supported };
  const stored = Number(raw);
  if (!Number.isFinite(stored) || stored < 1) return { kind: "fresh", version: supported };
  if (stored > supported) return { kind: "ahead", stored, supported };
  if (stored < supported) return { kind: "behind", from: stored, to: supported };
  return { kind: "ok", version: stored };
}

/**
 * Bring a store up to `supported`, or explain why not. Returns the status that was acted on, so
 * the caller can log it. `fresh` stores are stamped with the current version.
 */
export function migrateStorage(
  store: KeyValueStorePort,
  migrations: StorageMigration[] = STORAGE_MIGRATIONS,
  supported = STORAGE_SCHEMA_VERSION,
): StorageVersionStatus {
  const status = checkStorageVersion(store, supported);
  if (status.kind === "fresh") {
    store.write(STORAGE_VERSION_KEY, String(supported));
    return status;
  }
  if (status.kind !== "behind") return status;

  let version = status.from;
  for (let next = version + 1; next <= supported; next += 1) {
    const migration = migrations.find((entry) => entry.from === version && entry.to === next);
    if (!migration) {
      throw new Error(
        `no storage migration from v${version} to v${next}; add one to STORAGE_MIGRATIONS (found ${version} -> ${next})`,
      );
    }
    migration.run(store);
    version = next;
  }
  store.write(STORAGE_VERSION_KEY, String(version));
  return status;
}

/** Human-readable message for a refused store; `null` when nothing needs saying. */
export function storageMismatchMessage(status: StorageVersionStatus): string | null {
  if (status.kind !== "ahead") return null;
  return `This profile was written by a newer version of Pi Desktop (storage schema v${status.stored}, this build understands v${status.supported}). Update the app before opening it, or your settings would be silently reset.`;
}