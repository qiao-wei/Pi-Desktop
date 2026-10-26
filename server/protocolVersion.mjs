/**
 * The bridge's half of the wire-protocol version (boundary `bridge`).
 *
 * The bridge cannot import `src/shared/protocol/version.ts` at runtime - that is a `.ts` in
 * the renderer tree and the bridge is plain `.mjs` - so the number lives twice, once per side,
 * and `scripts/architecture/check.mjs` (rule `protocol-version`) plus
 * `tests/bridgeProtocol.test.ts` pin the two literals to be equal. Bumping one side alone
 * fails `npm test`.
 *
 * Bump it in the same change that makes an **incompatible** change to a request or response
 * shape. Additive fields do not need a bump; removing or repurposing one does.
 */
export const PROTOCOL_VERSION = 1;