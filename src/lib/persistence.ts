import type { AppSnapshot } from "../types";
import { getStoragePort } from "./storage.ts";

const SNAPSHOT_KEY = "pi-desktop.snapshot.v1";

export interface PersistenceLayer {
  load(): AppSnapshot | null;
  save(snapshot: AppSnapshot): void;
  clear(): void;
}

export const localPersistence: PersistenceLayer = {
  load() {
    const raw = getStoragePort().read(SNAPSHOT_KEY);
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
    getStoragePort().write(SNAPSHOT_KEY, JSON.stringify(snapshot));
  },
  clear() {
    getStoragePort().remove(SNAPSHOT_KEY);
  },
};
