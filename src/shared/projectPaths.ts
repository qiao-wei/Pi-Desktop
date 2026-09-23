/**
 * Folder identity for projects — the single rule both ends share.
 *
 * A project is keyed by its folder, so "did the user just pick a folder that is
 * already a project?" has to answer the same way in the New project dialog
 * (browser, `resolve()` unavailable) and in `createProject` on the bridge
 * (which additionally compares `realpath`s, because `/tmp` and `/private/tmp`
 * are the same directory there). See `isSameDirectory` in `server/index.mjs`.
 *
 * Deliberately free of Node APIs: `src/app/App.tsx` imports this module.
 */

export interface ProjectWithFolder {
  cwd: string;
}

/**
 * Canonical form used to decide "is this the same folder?".
 *
 * Only the noise that makes one folder look like two gets removed: surrounding
 * whitespace, repeated separators, a trailing separator, `\` vs `/` and letter
 * case on Windows-style paths. Everything else (including POSIX case, which is
 * genuinely significant on case-sensitive volumes) is left alone.
 */
export function normalizeProjectCwd(cwd: string): string {
  const raw = String(cwd ?? "").trim();
  if (!raw) {
    return "";
  }

  const windowsStyle = /^[a-zA-Z]:([\\/]|$)/.test(raw);
  const unified = windowsStyle ? raw.replace(/\\/g, "/") : raw;
  const collapsed = unified.replace(/\/{2,}/g, "/");
  const withoutTrailingSlash = collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
  const normalized = withoutTrailingSlash || "/";

  return windowsStyle ? normalized.toLowerCase() : normalized;
}

/** Two folder strings that point at the same place. Empty input never matches. */
export function isSameProjectCwd(a: string, b: string): boolean {
  const left = normalizeProjectCwd(a);
  const right = normalizeProjectCwd(b);
  return Boolean(left) && Boolean(right) && left === right;
}

/** The project that already owns `cwd`, if any. */
export function findProjectByCwd<T extends ProjectWithFolder>(
  projects: readonly T[],
  cwd: string,
): T | undefined {
  if (!normalizeProjectCwd(cwd)) {
    return undefined;
  }
  return projects.find((project) => isSameProjectCwd(project.cwd, cwd));
}
