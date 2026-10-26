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
/**
 * 桥这一侧声明的**投递档位**（`src/shared/protocol/version.ts` 的 `DELIVERY_PROFILE`）。
 *
 * 与版本号同样是两份字面量（桥是 `.mjs`，渲染层是 `.ts`），由 `tests/bridgeProtocol.test.ts` 钉住相等。
 * 今天只有 `local-live`：这一轮只发给当下连着的那条流，断开即中止，不保留、不重放。
 * 加值时必须**两侧同批**——客户端认不出未实现的档位就会拒绝继续（不是静默降级）。
 */
export const DELIVERY_PROFILE = "local-live";

/**
 * 本桥声明的档位**行为**（`src/shared/protocol/version.ts` 的 `DELIVERY_POLICY` 的镜像）。
 *
 * `promptStream` 的 `onClientClose` 由这个值驱动，所以"客户端断开即中止该轮"是一条可声明的策略，
 * 而不是处理器里临时判的条件。两侧相等由 `tests/bridgeProtocol.test.ts` 钉住；
 * 行为（真的中止、订阅者断开不中止）由 `tests/bridgeDisconnectPolicy.test.ts` 用真桥测。
 */
export const DELIVERY_POLICY = {
  onOwnerDisconnect: "abort-run",
  retainsFramesAfterOwnerLeaves: false,
};
