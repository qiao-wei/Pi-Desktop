/**
 * The React binding for {@link createFileBaselineReader}: one reader per mounted app,
 * whose project/session are read at call time (so a project switch does not need a new
 * reader, and a stale cache cannot leak across projects — the reader resets itself when
 * the source key changes).
 */
import { useRef } from "react";

import { fetchJson } from "../../lib/api";
import { buildWorkspaceFileQuery } from "../../shared/workspaceFiles";
import { createFileBaselineReader, type FileBaselineSource } from "./fileBaseline";

/**
 * The reader the app hands to the stream projection. `fetchFile` is wired here (and only
 * here) so `fileBaseline.ts` stays free of the bridge transport and can be unit-tested.
 */
export function useFileBaselineReader(source: () => Omit<FileBaselineSource, "fetchFile">): (path: string) => string | undefined {
  // The reader is created once (its cache must survive re-renders), but the *source* has
  // to be the current one: closing over the first render's `source` would pin the reader
  // to the bootstrap that existed before any project was open — and then every request
  // would ask for the wrong project.
  const latest = useRef(source);
  latest.current = source;
  const ref = useRef<((path: string) => string | undefined) | null>(null);
  if (!ref.current) {
    ref.current = createFileBaselineReader(() => {
      const { projectId, sessionPath } = latest.current();
      return {
        projectId,
        sessionPath,
        fetchFile: (path) =>
          fetchJson<unknown>(buildWorkspaceFileQuery({ projectId, sessionPath, path })),
      };
    });
  }
  return ref.current;
}