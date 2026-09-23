/**
 * Build gate for the compiled bridge.
 *
 * `bun build --compile` is not reproducible on this project: consecutive builds of the *same*
 * `server/index.mjs` produce different binaries, and a runtime-loaded pi extension that
 * imports from `@earendil-works/pi-ai` can come out as `Failed to load extension: Type3 is not
 * defined`. Before this gate that only showed up on the user's machine, as "I installed the
 * package and it still doesn't work".
 *
 * So: boot the artifact we just built, ask it what it really loaded, and refuse to ship it if a
 * selected package did not reach the session.
 */

// Anything that is not "loaded" or an explicit "this session did not select it" is a blocker,
// including a missing status: that means we are talking to a bridge whose load outlet is not
// working, and a gate that passes on "cannot tell" is no gate.
export const SKIPPABLE_LOAD_STATUSES = ["disabled"];

/**
 * @param {{ packages?: Array<{id?:string,source?:string,loadStatus?:string,loadedTools?:string[],loadErrors?:string[]}> }} snapshot
 */
export function classifyCapabilityLoad(snapshot) {
  const packages = Array.isArray(snapshot?.packages) ? snapshot.packages : [];
  const failures = [];
  const loaded = [];
  const skipped = [];

  for (const rawPkg of packages) {
    // A malformed entry must not crash the gate: a half-read snapshot should still report.
    const pkg = rawPkg ?? {};
    const status = String(pkg.loadStatus ?? "unknown");
    const entry = {
      id: pkg.id ?? pkg.source ?? "?",
      source: pkg.source ?? "?",
      status,
      tools: Array.isArray(pkg.loadedTools) ? pkg.loadedTools.length : 0,
      errors: Array.isArray(pkg.loadErrors) ? pkg.loadErrors : [],
    };
    if (status === "loaded") {
      loaded.push(entry);
    } else if (SKIPPABLE_LOAD_STATUSES.includes(status)) {
      skipped.push(entry);
    } else {
      failures.push(entry);
    }
  }

  return {
    ok: failures.length === 0,
    checked: packages.length,
    loaded,
    skipped,
    failures,
    // A snapshot with no packages means the bridge never resolved the user's settings — that is
    // a broken artifact too, just a quieter one.
    sawAnything: packages.length > 0,
  };
}

export function formatGateReport(result) {
  const lines = [];
  for (const item of result.loaded) {
    lines.push(`  ok      ${item.source} (${item.tools} 个工具)`);
  }
  for (const item of result.skipped) {
    lines.push(`  skipped ${item.source} (${item.status})`);
  }
  for (const item of result.failures) {
    lines.push(`  FAILED  ${item.source} → ${item.errors.join("；") || item.status}`);
  }
  if (result.ok) {
    lines.push(`sidecar 扩展自检通过：${result.loaded.length} 个已加载，${result.skipped.length} 个未启用被跳过`);
  }
  return lines.join("\n");
}

/**
 * Poll the bridge until `/api/capabilities` answers with a snapshot.
 * `fetchImpl` and `sleep` are injected so this is testable without a process.
 */
export async function waitForCapabilities({
  url,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  attempts = 30,
  intervalMs = 2000,
  now = () => Date.now(),
}) {
  let lastError = new Error(`no response from ${url}`);
  const startedAt = now();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url);
      if (response.ok) {
        const payload = await response.json();
        if (payload && Array.isArray(payload.packages)) {
          return { payload, attempts: attempt + 1, elapsedMs: now() - startedAt };
        }
        lastError = new Error(`${url} returned no package list`);
      } else {
        lastError = new Error(`${url} responded ${response.status}`);
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await sleep(intervalMs);
  }
  throw lastError;
}
