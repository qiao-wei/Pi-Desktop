/**
 * `<webview>` 的生命周期收敛（移植自 ZCode 的同名模块，按本仓的命名与注释习惯重写）。
 *
 * 为什么必须有这一层：Electron 的 `<webview>` 有一批**同步方法在错误的时刻调用会抛异常** ——
 * guest 还没 attach（`dom-ready` 之前）、或者 guest frame 已经被销毁、正在重附。这些是生命周期
 * 竞态，不是业务错误。如果放任它们冒到 `window.onerror`，一次面板挂载/卸载就能刷满异常上报，
 * 真正的 bug 会被埋掉。
 *
 * 所以规则是：**预期内的竞态 → 收敛成 fallback；其余错误 → 照常向上抛**。吞掉一切比不吞更糟，
 * 那会把「页面真的崩了」也变成静默失败。
 */

/** guest 未挂载 / frame 已销毁时，Electron 抛出的两类错误片段。 */
const WEBVIEW_DETACHED_ERROR_FRAGMENTS = [
  "must be attached to the DOM",
  "Render frame was disposed",
] as const;

/** 这是不是「时机的错」而不是「事情的错」。 */
export function isWebviewDetachedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) {
    return false;
  }
  return WEBVIEW_DETACHED_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment));
}

/**
 * 调一次 webview 的同步 API。
 *
 * - 正常返回结果；
 * - 命中生命周期竞态时返回 `fallback`，并通过 `onDetached` 留下证据（调用方接到 debug 日志，
 *   不静默）；
 * - 其他错误继续抛。
 */
export function safeWebviewCall<T>(
  call: () => T,
  fallback: T,
  onDetached?: (error: unknown) => void,
): T {
  try {
    return call();
  } catch (error) {
    if (!isWebviewDetachedError(error)) {
      throw error;
    }
    onDetached?.(error);
    return fallback;
  }
}

/**
 * 哪些 renderer 退出原因属于「页面被系统回收」，可以原位重建。
 *
 * `launch-failed` / `integrity-failure` 不在此列：那不是「原页面没了」，重建只会形成无限循环。
 */
const RECOVERABLE_GUEST_EXIT_REASONS = new Set([
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "memory-eviction",
]);

export function isRecoverableGuestExitReason(reason: string): boolean {
  return RECOVERABLE_GUEST_EXIT_REASONS.has(reason);
}
