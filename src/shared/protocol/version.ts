/**
 * Wire-protocol version for the renderer ↔ bridge boundary (boundary `bridge` in
 * `docs/architecture/protocols.md`).
 *
 * Two runtimes speak this protocol and they are versioned **together**: the bridge ships
 * inside the packaged app (`src-tauri/binaries/bridge/`), but a dev renderer can also be
 * pointed at somebody else's bridge - a stale one left over from an earlier build, or one
 * started before the last `npm run bridge:sync`. Nothing in the HTTP surface used to say
 * which revision answered, so a removed or renamed field simply arrived as `undefined` and
 * the UI degraded silently.
 *
 * The rule this file exists for: **the boundary declares its revision, both sides compare
 * it, and a mismatch is loud.** Bump `PROTOCOL_VERSION` in the same change that makes an
 * incompatible change to a request or response shape. Additive changes do not need a bump.
 *
 * The bridge's own literal is `server/protocolVersion.mjs`; the bridge cannot import this
 * file at runtime (it is a `.ts` in the renderer tree - the two numbers are pinned to be
 * equal by `tests/bridgeProtocol.test.ts`).
 */
export const PROTOCOL_VERSION = 1;

/**
 * The version the *bridge* announced, seen from the renderer. `undefined` means the answer
 * predates the field, which is the "older bridge" case rather than "unknown".
 */
export type AnnouncedProtocolVersion = number | undefined | null;

export type ProtocolCompatibility = "ok" | "missing" | "older" | "newer";

/**
 * Classify a version the bridge announced. Pure, so the failure modes are testable without
 * a bridge: `missing` (no field at all), `older`, `newer`, or `ok`.
 *
 * A newer bridge is *not* treated as compatible: a renderer only knows how to read the
 * shapes it was built against, and "it probably still works" is exactly the assumption that
 * turns a protocol change into a silent mis-render instead of an error.
 */
export function checkProtocolCompatibility(
  announced: AnnouncedProtocolVersion,
  expected: number = PROTOCOL_VERSION,
): ProtocolCompatibility {
  if (announced === undefined || announced === null) {
    return "missing";
  }
  if (!Number.isFinite(announced)) {
    return "missing";
  }
  if (announced === expected) {
    return "ok";
  }
  return announced < expected ? "older" : "newer";
}

/** Human-readable, actionable text for a non-`ok` classification. */
export function protocolMismatchMessage(
  compatibility: Exclude<ProtocolCompatibility, "ok">,
  announced: AnnouncedProtocolVersion,
  expected: number = PROTOCOL_VERSION,
): string {
  const got = announced === undefined || announced === null ? "none" : String(announced);
  switch (compatibility) {
    case "missing":
      return `Protocol mismatch: the bridge did not announce a protocol version (expected ${expected}). It is older than this UI - restart the app, or run \`npm run bridge:sync\` if you are in dev.`;
    case "older":
      return `Protocol mismatch: the bridge speaks v${got} but this UI speaks v${expected}. Restart the app so both sides come from the same build.`;
    case "newer":
      return `Protocol mismatch: the bridge speaks v${got} but this UI speaks v${expected}. The bridge is newer than this UI - rebuild or reload the UI.`;
  }
}

export interface ProtocolMismatch {
  compatibility: Exclude<ProtocolCompatibility, "ok">;
  announced: AnnouncedProtocolVersion;
  expected: number;
  message: string;
}

/** `null` when compatible - so callers can branch on a single truthy value. */
export function protocolMismatch(
  announced: AnnouncedProtocolVersion,
  expected: number = PROTOCOL_VERSION,
): ProtocolMismatch | null {
  const compatibility = checkProtocolCompatibility(announced, expected);
  if (compatibility === "ok") {
    return null;
  }
  return {
    compatibility,
    announced,
    expected,
    message: protocolMismatchMessage(compatibility, announced, expected),
  };
}