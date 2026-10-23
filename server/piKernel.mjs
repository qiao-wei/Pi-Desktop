/**
 * Boundary `kernel-adapter`: the bridge's only door to the pi kernel.
 *
 * Every `@earendil-works/*` import the bridge needs is re-exported here, and nowhere else in
 * `server/` may name that package (rule `kernel-boundary` in `scripts/architecture/check.mjs`
 * fails the build otherwise). Two reasons, both learned the hard way:
 *
 * 1. **Two of these are not public API.** `resolveProjectTrusted` (core/project-trust.js) and
 *    `hasTrustRequiringProjectResources` (core/trust-manager.js) are not in the package's
 *    `exports` map and are not reachable from any public entry point, so the bridge reaches
 *    them by relative path into `dist/`. That is exactly the kind of coupling that breaks
 *    silently on a version bump - which is why it is confined to one file with a name that
 *    says so.
 * 2. **Bumps become a one-file change.** `npm run bridge:sync` ships this facade into the
 *    sidecar; if a kernel release moves, renames or drops something, the failure is here,
 *    at boot, with the export list as the diff - not spread across the bridge's 8k lines.
 *
 * The imports are bound to local names before being re-exported (`import { x } ...; export { x };`)
 * rather than using `export { x } from "..."`: the adapter below needs the bindings in scope, and an
 * `export ... from` statement creates no local binding. `node-typecheck` catches that class of mistake
 * (TS18004) - it did, the first time this file was written the other way.
 *
 * `tests/kernelAdapter.test.ts` imports this module and asserts every export below actually
 * resolves, so a rename in the kernel turns into a named failing test instead of a runtime
 * `undefined` deep inside a request handler.
 */

// --- public entries ---------------------------------------------------------------------
import { StringEnum, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  DefaultPackageManager,
  ProjectTrustStore,
  ModelRuntime,
  SettingsManager,
  SessionManager,
  withFileMutationQueue,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export {
  StringEnum,
  getSupportedThinkingLevels,
  builtinProviders,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  DefaultPackageManager,
  ProjectTrustStore,
  ModelRuntime,
  SettingsManager,
  SessionManager,
  withFileMutationQueue,
  initTheme,
  matchesKey,
};

// --- non-public entries -----------------------------------------------------------------
// Not reachable through the package's `exports` map; mirrored here on purpose. If the kernel
// ever publishes them, this block becomes the public import and the deep paths go away.
import { resolveProjectTrusted } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/project-trust.js";
import { hasTrustRequiringProjectResources } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js";

export { resolveProjectTrusted, hasTrustRequiringProjectResources };

/** `main` under a local name: the bridge runs the pi CLI in-process for a few one-shot paths. */
import { main as runPiCli } from "@earendil-works/pi-coding-agent";

export { runPiCli };

// --- the swappable surface ---------------------------------------------------------------
// The named exports above stay (the bridge imports them by name, and a rename in the kernel should
// fail in one file). The adapter below is the part that is **replaceable**: the behavioural surface
// the bridge has tests for, so a test can install a fake kernel and drive the bridge's own code
// instead of asserting on the real package's return values.
//
// Rule `protocol-seam` requires `createKernelAdapter` to exist here and to be used by the swap test.

/** Behaviour of the kernel the bridge actually depends on. Keep this list small and real. */
export function createKernelAdapter(overrides = {}) {
  return {
    getSupportedThinkingLevels,
    initTheme,
    resolveProjectTrusted,
    hasTrustRequiringProjectResources,
    ...overrides,
  };
}

let currentKernelAdapter = createKernelAdapter();

/** Install a different kernel surface (a fake in tests, or a future pi version shim). */
export function setKernelAdapter(overrides = null) {
  currentKernelAdapter = createKernelAdapter(overrides ?? {});
  return currentKernelAdapter;
}

export function getKernelAdapter() {
  return currentKernelAdapter;
}

/**
 * Thinking levels the composer menu may offer for `model` - the one kernel answer the bridge's
 * `describeModel` embeds, routed through the adapter so it can be driven by a fake kernel.
 *
 * It lives here rather than in `server/index.mjs` because that file is at its line ratchet, and
 * rather than in its own module because it needs the adapter's local state; it is two lines and it
 * belongs to the same boundary as the adapter itself.
 */
export function supportedThinkingLevelsFor(model, adapter = getKernelAdapter()) {
  return adapter.getSupportedThinkingLevels(model);
}