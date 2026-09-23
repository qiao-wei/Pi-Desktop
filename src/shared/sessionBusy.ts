/**
 * 「这条会话现在能不能改 pi 运行态（思考等级 / 模型）」的客户端口径。
 *
 * 服务端的 `isSessionBusy()`（server/index.mjs）把三种情况都算忙：
 *
 *   session.isStreaming || session.isCompacting || session.pendingMessageCount > 0
 *
 * 客户端过去只看前两条，于是两种状态上会误判成空闲、把下拉框留成可点的：
 *
 *   1. `isStopping`：点了停止后 `isStreaming` 已经被本地置 false，但服务端还在
 *      abort，`isSessionBusy()` 仍为真；
 *   2. pi 队列里还压着插话 / 跟进（`pendingMessageCount > 0`）：会话已经不流式了，
 *      但服务端仍然拒绝改思考等级。
 *
 * 点下去必然吃 `Stop the running response before switching thinking.` /
 * `The current reply is still running — stop it before switching models.`。
 * 这里把口径对齐，控件与服务端用同一个「忙」的定义。
 */
export interface SessionBusyInput {
  isStreaming?: boolean;
  isCompacting?: boolean;
  isStopping?: boolean;
  /** pi 的 steering / follow-up 队列快照（bootstrap.pendingQueues，属于当前可见会话）。 */
  pendingQueues?: { steering?: readonly unknown[]; followUp?: readonly unknown[] } | null;
}

/** pi 队列里压着的消息数（steering + follow-up）。 */
export function pendingQueuedCount(pendingQueues: SessionBusyInput["pendingQueues"]): number {
  if (!pendingQueues) {
    return 0;
  }
  return (pendingQueues.steering?.length ?? 0) + (pendingQueues.followUp?.length ?? 0);
}

/**
 * 服务端 `isSessionBusy()` 的客户端等价物。
 *
 * 注意：这是「当前可见会话」的状态，不是全局的 —— 另一条会话在流式不该锁住这条会话的
 * 选择器（服务端按 `sessionPath` 各查各的）。
 */
export function isSessionBusy(input: SessionBusyInput): boolean {
  return Boolean(
    input.isStreaming || input.isCompacting || input.isStopping || pendingQueuedCount(input.pendingQueues) > 0,
  );
}

/** 输入框旁那些「改动会打到 pi 运行态」的控件是否该禁用（忙 or 正在换会话）。 */
export function sessionControlsDisabled(input: SessionBusyInput & { isBootstrapping?: boolean }): boolean {
  return Boolean(input.isBootstrapping) || isSessionBusy(input);
}