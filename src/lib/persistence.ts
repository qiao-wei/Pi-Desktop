import type { AppSnapshot } from "../types";

const SNAPSHOT_KEY = "pi-desktop.snapshot.v1";

export interface PersistenceLayer {
  load(): AppSnapshot | null;
  save(snapshot: AppSnapshot): void;
  clear(): void;
}

export const localPersistence: PersistenceLayer = {
  load() {
    if (typeof window === "undefined") {
      return null;
    }

    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as AppSnapshot;
    } catch {
      return null;
    }
  },
  save(snapshot) {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  },
  clear() {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.removeItem(SNAPSHOT_KEY);
  },
};
