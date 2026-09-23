/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PI_DESKTOP_API_BASE?: string;
  readonly VITE_ENGBUDDY_API_BASE?: string;
  readonly VITE_PI_DESKTOP_PERF?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Dev-only perf probe handle installed by `src/lib/perf.ts`.
 *
 * `src/lib/api.ts` reaches the probe through this global instead of importing
 * `perf.ts`, because `perf.ts` already imports `api.ts` for `reportDiagnostic`
 * and a real import would create a module cycle.
 */
declare var __piDesktopPerf:
  | {
      enabled: boolean;
      mark: (name: string, ms: number, fields?: Record<string, number>) => void;
    }
  | undefined;

/**
 * Electron preload bridge: absolute path of a dropped `File` / folder. Absent in
 * the browser and in Tauri, where the sidebar drop can only offer the entry name.
 */
interface Window {
  __PI_DESKTOP_FILES__?: { pathForFile?: (file: File) => string };
}
