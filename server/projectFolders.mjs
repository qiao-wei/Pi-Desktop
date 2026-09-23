/**
 * Folder identity for projects, bridge side.
 *
 * `src/shared/projectPaths.ts` holds the rules the browser dialog uses too; this
 * adds the one thing only Node can answer: two spellings of a path can be the
 * same directory through a symlink (`/tmp` vs `/private/tmp` on macOS), and a
 * project is keyed by the directory, not by the string the user typed.
 */
import { realpathSync } from "node:fs";

import { isSameProjectCwd } from "../src/shared/projectPaths.ts";

/** Do these two folder strings point at the same directory? */
export function isSameDirectory(a, b) {
  if (isSameProjectCwd(a, b)) {
    return true;
  }

  const realA = realPathOrEmpty(a);
  const realB = realPathOrEmpty(b);
  return Boolean(realA) && Boolean(realB) && isSameProjectCwd(realA, realB);
}

/** The project that already owns `cwd`, or `undefined` when the folder is free. */
export function findProjectByFolder(projects, cwd) {
  return projects.find((project) => isSameDirectory(project.cwd, cwd));
}

function realPathOrEmpty(path) {
  const candidate = String(path ?? "").trim();
  if (!candidate) {
    return "";
  }

  try {
    return realpathSync(candidate);
  } catch {
    // A folder that does not exist yet (or is unreadable) has nothing to resolve;
    // the textual comparison in `isSameProjectCwd` is the best answer we have.
    return "";
  }
}
