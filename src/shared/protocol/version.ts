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
/**
 * 投递档位：桥**怎么把帧交给客户端**（沿用 Ada 的 `deliveryProfile` 这个轴）。
 *
 * 为什么它和版本号同住在这里：两者都是"对面声明了什么、我认识不认识"，失败路径也一样——
 * 认不出就得说人话，不能照着旧假设继续跑。今天只有一种实现：
 *
 * - `local-live`：这一轮只发给**当下连着**的那条流；客户端断开即中止，没有保留、没有重放。
 *   将来 `replayable`（保留事件、允许后来者从某个序号接上）会加在这里。
 *
 * 规则（与 `checkProtocolCompatibility` 把 `newer` 也算不兼容同一条）：**未实现的档位不许静默降级**，
 * 缺声明也算不认识——"它大概还是老行为"正是那种会变成静默错帧的假设。
 */
export const DELIVERY_PROFILE = "local-live";

export type DeliveryProfile = typeof DELIVERY_PROFILE;

export type DeliveryProfileCompatibility = "ok" | "missing" | "unsupported";

/** 分类对面声明的档位。纯函数，所以这几种失败形态不用起桥就能测。 */
export function checkDeliveryProfile(
  announced: unknown,
  supported: DeliveryProfile = DELIVERY_PROFILE,
): DeliveryProfileCompatibility {
  if (announced === undefined || announced === null || announced === "") {
    return "missing";
  }
  return announced === supported ? "ok" : "unsupported";
}

/** 非 `ok` 时的可操作文案。 */
export function deliveryProfileMessage(
  compatibility: Exclude<DeliveryProfileCompatibility, "ok">,
  announced: unknown,
  supported: DeliveryProfile = DELIVERY_PROFILE,
): string {
  const got = typeof announced === "string" && announced ? announced : "none";
  if (compatibility === "missing") {
    return `Delivery profile mismatch: the bridge did not declare how it delivers stream frames (this UI only speaks "${supported}"). It is older than this UI - restart the app, or run \`npm run bridge:sync\` if you are in dev.`;
  }
  return `Delivery profile mismatch: the bridge delivers frames as "${got}" but this UI only speaks "${supported}". Rebuilding one side alone cannot fix this - both come from the same build.`;
}

export interface DeliveryProfileMismatch {
  compatibility: Exclude<DeliveryProfileCompatibility, "ok">;
  announced: unknown;
  supported: DeliveryProfile;
  message: string;
}

/** `null` when compatible - 和 `protocolMismatch` 一样，调用方只判一个真值。 */
export function deliveryProfileMismatch(
  announced: unknown,
  supported: DeliveryProfile = DELIVERY_PROFILE,
): DeliveryProfileMismatch | null {
  const compatibility = checkDeliveryProfile(announced, supported);
  if (compatibility === "ok") {
    return null;
  }
  return {
    compatibility,
    announced,
    supported,
    message: deliveryProfileMessage(compatibility, announced, supported),
  };
}

/**
 * 档位**行为**的声明：断开策略是这里的一个值，不是处理器里的一个条件分支。
 *
 * 为什么值得单独声明：`onClientClose` 里那句"客户端断开就中止这一轮"是一条**策略**，但它以前
 * 只以 `if` 的形态存在于某一段代码里——没有名字，也就没法被检验、没法被换掉。声明成值之后：
 * 客户端能知道"我关掉窗口这一轮会怎样"，桥那一侧的分支由声明的值驱动，将来加 `replayable`
 * （保持运行、为后来者保留事件）就是加一行，而不是在处理器里再塞一个条件。
 *
 * 注意：`!wasStreaming` 那道门**不是**这条策略的一部分，它是"谁有权中止这一轮"的界定
 * （只有*启动*这轮的请求断开才中止，后到的订阅者断开不动别人的 run）——见 promptStream 的
 * `onClientClose`。
 */
export interface DeliveryPolicy {
  /** 启动这一轮的那个请求断开时，这一轮怎么办。 */
  onOwnerDisconnect: "abort-run" | "keep-running";
  /** owner 离开之后，后来者还能不能从某个序号接上（今天：不能，run 随 owner 一起结束）。 */
  retainsFramesAfterOwnerLeaves: boolean;
}

export const DELIVERY_POLICIES: Record<DeliveryProfile, DeliveryPolicy> = {
  // 今天唯一实现的档位。
  "local-live": { onOwnerDisconnect: "abort-run", retainsFramesAfterOwnerLeaves: false },
};

/** 本 UI 声明的那个档位的行为。桥那侧有一份镜像，由 `tests/bridgeProtocol.test.ts` 钉住相等。 */
export const DELIVERY_POLICY: DeliveryPolicy = DELIVERY_POLICIES[DELIVERY_PROFILE];
