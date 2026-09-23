// The `~/.pi/agent/bin` launchers, split out of server/index.mjs so the write path and the cleanup
// path can be tested without booting the bridge.
//
// Why cleanup exists at all: a bundled install writes `node`, `npm`, `python3`, `pip`, ... into
// `~/.pi/agent/bin` pointing at the app's own runtimes, and that directory is first on PATH. A slim
// install (one that ships no runtimes and relies on the machine's own) must therefore delete them -
// leaving them behind shadows the user's real interpreters with `exit 127` launchers, which looks
// exactly like "the tool is not installed".

/** Every launcher this app owns, in one place: the writer and the cleaner must agree. */
export function runtimeShimSpecs(platform = process.platform) {
  const node = [
    { name: "node", kind: "node", family: "node" },
    { name: "nodejs", kind: "node", family: "node" },
    { name: "npm", kind: "npm", family: "node" },
    { name: "npx", kind: "npx", family: "node" },
  ];
  const python = [
    { name: "python", kind: "python", family: "python" },
    { name: "python3", kind: "python", family: "python" },
    { name: "python3.13", kind: "python", family: "python" },
    { name: "pip", kind: "pip", family: "python" },
    { name: "pip3", kind: "pip", family: "python" },
    { name: "pip3.13", kind: "pip", family: "python" },
  ];
  const suffix = platform === "win32" ? ".cmd" : "";
  return [...node, ...python].map((spec) => ({ ...spec, name: `${spec.name}${suffix}` }));
}

/** A launcher we wrote: every one of them bakes in one of these variables. */
export function isBundledShimContent(content) {
  return String(content ?? "").includes("PI_DESKTOP_BUNDLED_");
}

/** A symlink into a `*-runtime` directory - the other shape a launcher can take after an upgrade. */
export function isBundledShimLink(target) {
  return /-runtime[/\\]/.test(String(target ?? ""));
}

/**
 * Delete the launchers a bundled installation wrote. Only files that are recognisably ours are
 * touched: a user who parked their own `node` in that directory keeps it.
 *
 * The filesystem is injected so this can be tested against a real temp directory without patching
 * globals, and so a failure to read one file can never take the bridge down.
 */
export function removeBundledShims({
  dir,
  platform = process.platform,
  readFileSync,
  readlinkSync,
  rmSync,
  warn = () => {},
  join,
}) {
  const removed = [];
  for (const spec of runtimeShimSpecs(platform)) {
    const shimPath = join(dir, spec.name);
    if (!isOurs(shimPath, { readFileSync, readlinkSync })) {
      continue;
    }
    try {
      rmSync(shimPath, { force: true });
      removed.push(shimPath);
    } catch (error) {
      warn(`could not remove the stale launcher ${shimPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return removed;
}

function isOurs(shimPath, { readFileSync, readlinkSync }) {
  try {
    return isBundledShimContent(readFileSync(shimPath, "utf-8"));
  } catch {
    // Unreadable - typically a symlink into a `*-runtime` directory that no longer exists, which
    // is exactly the shape an upgrade leaves behind.
    try {
      return isBundledShimLink(readlinkSync(shimPath));
    } catch {
      return false;
    }
  }
}