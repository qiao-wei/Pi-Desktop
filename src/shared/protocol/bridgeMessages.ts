/**
 * Boundary `bridge`: the **field sets** of the two snapshot messages, as one shared source.
 *
 * The problem this solves: `BootstrapResponse` was a TypeScript interface in `src/lib/api.ts`, and the
 * object the bridge actually builds lives in `server/index.mjs`. Nothing compared them. TypeScript only
 * ever sees one side (`api.ts` reading a JSON blob it types as `BootstrapResponse`), so deleting a field
 * on the server produced `undefined` in the UI - a silent downgrade, not an error. That is the same
 * class of bug the protocol version exists for, one level down: the version catches "wrong revision",
 * this catches "field the version did not bump for".
 *
 * How it is closed, in both directions:
 * - the bridge calls `assertBridgePayload(payload, "bootstrap" | "ambient")` when it answers, so a
 *   missing required field is named in the log at the moment it happens;
 * - `tests/bridgeMessages.test.ts` compares these lists with the fields declared on `BootstrapResponse`
 *   / `AmbientBootstrap` in `src/lib/api.ts`, so adding a field to the interface without adding it here
 *   fails, and vice versa.
 *
 * This module is in `src/shared` (the kernel shared by both runtimes), which is what lets the bridge
 * import it: `scripts/build-bridge-runtime.mjs` ships `src/shared` into the sidecar, and rule
 * `bridge-closure` keeps it browser-free.
 */

/**
 * Fields the renderer requires on every full snapshot. A missing one is a bug on the bridge side, not a
 * degraded-but-fine state: the UI reads `projects`, `activeProjectId`, `canPrompt` and `projectTrusted`
 * unconditionally, so their absence means wrong screens, not fewer features.
 */
export const BOOTSTRAP_REQUIRED_FIELDS = [
  "snapshot",
  "projects",
  "activeProjectId",
  "availableModels",
  "skills",
  "capabilities",
  "server",
  "projectTrusted",
  "canPrompt",
  "personalization",
  "protocolVersion",
] as const;

/** Optional by design: absent means "not set", and each has a documented default on the client. */
export const BOOTSTRAP_OPTIONAL_FIELDS = [
  "archivedSessions",
  "activeSessionPath",
  "toolSettings",
  "streamingSessionPaths",
  "compactingSessionPaths",
  "sessionFile",
  "pendingExtensionUiRequests",
  "pendingQueues",
  "existingProject",
  "error",
] as const;

export const BOOTSTRAP_FIELDS = [...BOOTSTRAP_REQUIRED_FIELDS, ...BOOTSTRAP_OPTIONAL_FIELDS] as const;

/** `GET /api/bootstrap?view=ambient` answers a different, much smaller shape. */
export const AMBIENT_REQUIRED_FIELDS = ["ambient", "canPrompt", "projectTrusted", "protocolVersion"] as const;

export const AMBIENT_OPTIONAL_FIELDS = [
  "activeSessionPath",
  "sessionFile",
  "streamingSessionPaths",
  "compactingSessionPaths",
  "pendingExtensionUiRequests",
  "pendingQueues",
] as const;

export const AMBIENT_FIELDS = [...AMBIENT_REQUIRED_FIELDS, ...AMBIENT_OPTIONAL_FIELDS] as const;

export type BridgePayloadKind = "bootstrap" | "ambient";

const REQUIRED_BY_KIND: Record<BridgePayloadKind, readonly string[]> = {
  bootstrap: BOOTSTRAP_REQUIRED_FIELDS,
  ambient: AMBIENT_REQUIRED_FIELDS,
};

/** Required fields absent from `payload` (in declaration order, duplicates removed). */
export function missingBridgeFields(
  payload: Record<string, unknown> | null | undefined,
  kind: BridgePayloadKind,
): string[] {
  if (!payload || typeof payload !== "object") return [...REQUIRED_BY_KIND[kind]];
  return REQUIRED_BY_KIND[kind].filter((field) => !(field in payload));
}

/**
 * Log `payload`'s missing required fields, then return the payload unchanged.
 *
 * Returning the payload is deliberate: the call sites read
 * `sendJson(res, 200, assertBridgePayload(buildAmbientSnapshot(runtime), "ambient"))`, so the check
 * cannot be dropped without deleting the response itself. `diagnosticLog` is imported lazily through the
 * global hook below so this module stays dependency-free (the renderer bundles it too).
 */
export function assertBridgePayload<T extends Record<string, unknown>>(payload: T, kind: BridgePayloadKind): T {
  const missing = missingBridgeFields(payload, kind);
  if (missing.length) {
    console.warn(`[bridge] ${kind} payload is missing required field(s): ${missing.join(", ")}`);
  }
  return payload;
}