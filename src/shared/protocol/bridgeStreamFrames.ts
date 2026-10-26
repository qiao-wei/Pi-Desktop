/**
 * 边界 `bridge`：NDJSON 流上「帧」的契约，桥与渲染层共用这一份。
 *
 * 为什么需要它：渲染层把流事件的形状声明在适配层（`src/lib/api.ts`），桥那侧写的是裸对象字面量，
 * 于是**帧本身没有契约**——一条坏行会冒充业务错误送到 UI（以前是 `{type:"error", message:<原始行>}`），
 * 和「模型失败」长得一模一样，重试策略与错误统计只能靠猜。这里把两类错误命名清楚：
 *
 * - `transport_error`：分帧之前/之外坏掉的（坏行、截断、单流待发字节超限）。没有 `streamSeq`。
 * - `error`：传输跑通了，是这一次运行自己失败（模型、工具、扩展）。`code` 固定 `domain`。
 *
 * `streamSeq` 是 run 内的帧计数：单调递增、不跳号。传输错误拿不到序号——那一行根本没解析出来，
 * 没有可寻址的位置。
 */

/** 传输侧错误码。 */
export const TRANSPORT_ERROR_CODES = ["malformed_line", "truncated", "overflow"] as const;

export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

/** 业务错误码：只有一种，写出来是为了让「这不是传输错误」在线上也看得见。 */
export const DOMAIN_ERROR_CODE = "domain";

export interface BridgeTransportErrorFrame {
  type: "transport_error";
  code: TransportErrorCode;
  message: string;
  streamSeq?: number;
}

export interface BridgeDomainErrorFrame {
  type: "error";
  code: typeof DOMAIN_ERROR_CODE;
  message: string;
  streamSeq?: number;
}

/** 分帧坏掉时的那一帧。两版 transport（HTTP / loopback）必须调用同一个构造器，否则上层又能分辨它们了。 */
export function transportErrorFrame(code: TransportErrorCode, message: string): BridgeTransportErrorFrame {
  return { type: "transport_error", code, message };
}

/** 运行失败时的那一帧。 */
export function domainErrorFrame(message: string): BridgeDomainErrorFrame {
  return { type: "error", code: DOMAIN_ERROR_CODE, message };
}