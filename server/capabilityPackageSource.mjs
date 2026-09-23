import { join, isAbsolute, resolve } from "node:path";

/**
 * pi persists a local install path *relative to the scope's base directory* — for user-scope
 * entries that base is `~/.pi/agent`, so the string it writes (`../../../../tmp/x`) only means
 * anything while that directory stays where it is. Pi Desktop keys capability ids (`user:<source>`),
 * per-session selections, defaults and pins off that string.
 *
 * Project-scope entries keep the relative form on purpose (a repo should stay portable);
 * user-scope ones get rewritten to an absolute path right after install.
 */

export function packageSourceOf(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  return String(entry?.source ?? "");
}

export function isRegistryPackageSource(source) {
  const value = String(source ?? "");
  return value.includes(":") && !value.startsWith(".") && !isAbsolute(value);
}

/**
 * The source string pi wants for `remove`/`update`, given the one we persisted.
 *
 * pi resolves a local source argument against the *project cwd*, but a persisted
 * project-scope entry is written relative to `<cwd>/.pi` (pi's
 * `getBaseDirForScope("project")`; user-scope entries use the agent dir). Handing
 * the stored string back verbatim therefore matches no configured entry: removal
 * silently no-ops and update reports "no matching package".
 */
export function packageSourceForPi({ source, scope, projectCwd, agentDir }) {
  const value = String(source ?? "").trim();
  if (!value || isRegistryPackageSource(value)) {
    return value;
  }
  if (isAbsolute(value)) {
    return value;
  }
  const base = scope === "project" ? join(projectCwd ?? process.cwd(), ".pi") : (agentDir ?? process.cwd());
  return resolve(base, value);
}

/** Absolute path the install actually landed at, given how pi resolves what the UI sent. */
export function installTargetPath(source, cwd) {
  const value = String(source ?? "").trim();
  if (!value || isRegistryPackageSource(value)) {
    return "";
  }
  return isAbsolute(value) ? value : resolve(cwd ?? process.cwd(), value);
}

/** Every absolute path a persisted entry could mean, tried against the plausible bases. */
export function resolveEntryCandidates(rawSource, bases) {
  const value = String(rawSource ?? "");
  if (!value || isRegistryPackageSource(value)) {
    return [];
  }
  const candidates = [];
  const seen = new Set();
  if (isAbsolute(value)) {
    candidates.push(value);
    seen.add(value);
    return candidates;
  }
  for (const base of bases ?? []) {
    if (!base) {
      continue;
    }
    const candidate = resolve(base, value);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * @returns every index whose entry is a relative path pointing at `installTarget`. All of them
 * get rewritten: a leftover relative twin for the same directory would keep the id ambiguous.
 */
export function selectEntriesToAbsolutize({ packages = [], installTarget = "", bases = [] } = {}) {
  if (!installTarget) {
    return [];
  }
  const indexes = [];
  packages.forEach((entry, index) => {
    const raw = packageSourceOf(entry);
    if (!raw || isAbsolute(raw) || isRegistryPackageSource(raw)) {
      return;
    }
    if (resolveEntryCandidates(raw, bases).includes(installTarget)) {
      indexes.push(index);
    }
  });
  return indexes;
}

/** Entry with its source swapped for the absolute path, preserving `autoload` and friends. */
export function absolutizedPackageEntry(entry, absolutePath) {
  if (typeof entry === "string") {
    return absolutePath;
  }
  return { ...entry, source: absolutePath };
}

/**
 * Straighten the user-scope entries pi just wrote for `installSource` into absolute paths, and
 * persist them. `settingsManager` is injected so the write is testable without an app.
 *
 * @returns {{ changed: boolean, indexes: number[] }}
 */
export function absolutizeInstalledUserPackage({ settingsManager, installSource, projectCwd, agentDir }) {
  const installTarget = installTargetPath(installSource, projectCwd);
  const packages = [...(settingsManager.getGlobalSettings().packages ?? [])];
  const indexes = selectEntriesToAbsolutize({
    packages,
    installTarget,
    bases: [agentDir, projectCwd],
  });
  if (indexes.length === 0) {
    return { changed: false, indexes: [] };
  }
  for (const index of indexes) {
    packages[index] = absolutizedPackageEntry(packages[index], installTarget);
  }
  settingsManager.setPackages(packages);
  return { changed: true, indexes };
}
